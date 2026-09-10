// scripts/build-model.js
// Daglig jobb: henter dagens kamper + lagform fra football-data.org,
// regner modell + kupong, skriver data/today.json.
//
// SKJELETT — fyll inn API-hentingen der det står TODO. Modell-logikken er ferdig.
// Kjør lokalt med:  FOOTBALL_DATA_KEY=xxx node scripts/build-model.js

const fs = require('fs');
const path = require('path');
const { expectedGoals } = require('../lib/ratings');
const { modelMarkets, mostLikelyScore, fairOdds } = require('../lib/poisson');
const { buildCoupon } = require('../lib/coupon');

const API = 'https://api.football-data.org/v4';
const KEY = process.env.FOOTBALL_DATA_KEY;

// Ligaene du følger (football-data competition codes). Begrenset til 2 ligaer
// slik at vi har råd til å hente BTTS-odds pr kamp også (se fetch-odds.js) uten
// å sprenge gratiskvoten på The Odds API.
const COMPETITIONS = ['PL', 'PD', 'CL']; // Premier League, La Liga, Champions League

// Gratisplanen tillater ca. 10 kall/minutt — vent litt mellom hvert kall
// så vi ikke får 429 (rate limit) midt i en kjøring med mange kamper.
const RATE_LIMIT_MS = 6500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fdFetch(endpoint) {
  const res = await fetch(`${API}${endpoint}`, { headers: { 'X-Auth-Token': KEY } });
  if (res.status === 429) {
    console.warn(`Rate limited, venter 60s: ${endpoint}`);
    await sleep(60000);
    return fdFetch(endpoint);
  }
  if (!res.ok) throw new Error(`football-data ${res.status}: ${endpoint}`);
  const json = await res.json();
  await sleep(RATE_LIMIT_MS);
  return json;
}

function mapForm(matches, teamId) {
  return matches
    .map((mt) => {
      const isHome = mt.homeTeam.id === teamId;
      return {
        gf: isHome ? mt.score.fullTime.home : mt.score.fullTime.away,
        ga: isHome ? mt.score.fullTime.away : mt.score.fullTime.home,
        venue: isHome ? 'H' : 'A',
        date: mt.utcDate,
      };
    })
    .sort((a, b) => new Date(a.date) - new Date(b.date)); // eldst → nyest
}

// Hent siste ~10 ferdigspilte kamper for et lag i EN GITT liga → format ratings.js forventer.
// Kun samme liga som kampen som analyseres — ellers blandes f.eks. Champions League-motstand
// (mye tøffere enn ligahverdagen) inn i formen, og skjevfordreier ratingen.
// Returnerer også `fallback: true` hvis vi måtte hente fra en annen liga (se main()).
async function getTeamForm(teamId, competition) {
  // Uten dateFrom/dateTo ser endpointet ut til å ikke nå tilbake til forrige sesong
  // i sommerpausen (får 0 kamper for et lag som ikke har spilt i ny sesong ennå).
  // Går derfor ~9 måneder tilbake — mer enn nok til å dekke en hel sesong.
  const dateTo = new Date().toISOString().slice(0, 10);
  const dateFrom = new Date(Date.now() - 270 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const data = await fdFetch(`/teams/${teamId}/matches?status=FINISHED&competitions=${competition}&dateFrom=${dateFrom}&dateTo=${dateTo}&limit=10`);

  // Nyopprykkede lag har ofte ingen (eller svært få) kamper i den nye ligaen ennå.
  // Fall da tilbake til laget sine siste kamper uansett liga (typisk fra nivået under),
  // heller enn å krasje på tom form.
  if (data.matches.length < 5) {
    const fallback = await fdFetch(`/teams/${teamId}/matches?status=FINISHED&dateFrom=${dateFrom}&dateTo=${dateTo}&limit=10`);
    if (fallback.matches.length > data.matches.length) return { form: mapForm(fallback.matches, teamId), fallback: true };
  }

  return { form: mapForm(data.matches, teamId), fallback: false };
}

// Siste 5 kamper som W/D/L-kuler for frontend (gjenbruker allerede hentet form)
function recentForm(form) {
  return form.slice(-5).map((m) => ({
    r: m.gf > m.ga ? 'W' : m.gf < m.ga ? 'L' : 'D',
    gf: m.gf, ga: m.ga, venue: m.venue,
  }));
}

// Ett anbefalt spill pr kamp — "modellens beste spill". Vurderer HELE bredden av
// vanlige enkeltmarkeder (seier, dobbel sjanse, over/under mål, begge lag scorer)
// og velger det med høyest modell-sannsynlighet BLANT dem som har en rimelig odds
// (fair ≥ 1,40). Terskelen hindrer at near-locks som "under 4,5 mål" (~95%, som
// bookmakere knapt priser) vinner hver gang. Faller tilbake til høyeste
// sannsynlighet uansett hvis ingen når terskelen. `odds` fylles av fetch-odds.js.
const PICK_MARKETS = {
  pHome: (f) => ({ pick: `${f.homeName} vinner`, market: 'Full tid' }),
  pAway: (f) => ({ pick: `${f.awayName} vinner`, market: 'Full tid' }),
  dcHD:  (f) => ({ pick: `${f.homeName} eller uavgjort`, market: 'Double chance' }),
  dcAD:  (f) => ({ pick: `${f.awayName} eller uavgjort`, market: 'Double chance' }),
  o15:   () => ({ pick: 'Over 1,5 mål', market: 'Totalt' }),
  o25:   () => ({ pick: 'Over 2,5 mål', market: 'Totalt' }),
  o35:   () => ({ pick: 'Over 3,5 mål', market: 'Totalt' }),
  u35:   () => ({ pick: 'Under 3,5 mål', market: 'Totalt' }),
  u45:   () => ({ pick: 'Under 4,5 mål', market: 'Totalt' }),
  btts:  () => ({ pick: 'Begge lag scorer', market: 'BTTS' }),
};
function pickMatchPick(fixture) {
  const cands = Object.keys(PICK_MARKETS)
    .map((key) => ({ key, p: fixture.markets[key], ...PICK_MARKETS[key](fixture) }))
    .filter((c) => c.p != null);
  const inBand = cands.filter((c) => 1 / c.p >= 1.40);
  const pool = (inBand.length ? inBand : cands).sort((a, b) => b.p - a.p);
  return { ...pool[0], odds: null };
}

// "Dagens spill" = de 3-4 sterkeste "beste spill" på tvers av alle dagens kamper
// (maks ett pr kamp). fetch-odds.js regner denne om fra EKTE bookmakerodds i
// vinduet så snart de er hentet - dette er modellens forhåndsforslag.
const DAGENS_SPILL_COUNT = 4;
function buildDagensSpill(modelledFixtures) {
  return modelledFixtures
    .map((f) => ({ match: f.label, ...f.matchPick }))
    .sort((a, b) => b.p - a.p)
    .slice(0, DAGENS_SPILL_COUNT);
}

async function main() {
  if (!KEY) throw new Error('Mangler FOOTBALL_DATA_KEY');

  const today = new Date().toISOString().slice(0, 10);
  const fixtures = [];
  const formCache = new Map(); // "teamId:liga" -> form, i tilfelle et lag opptrer flere ganger samme dag

  async function cachedTeamForm(teamId, competition) {
    const key = `${teamId}:${competition}`;
    if (!formCache.has(key)) formCache.set(key, await getTeamForm(teamId, competition));
    return formCache.get(key);
  }

  // Hent kamper i dag → 21 dager frem for hver liga (ETT kall pr liga uansett vindu-
  // størrelse, så det koster ikke noe ekstra). Er det ingen kamper i dag (typisk i
  // sommerpausen/landslagspause), viser vi heller NESTE dato med kamper, så appen
  // aldri bare står tom — den "ligger der" helt til sesongen faktisk starter.
  const lookaheadTo = new Date(Date.now() + 21 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const byComp = new Map(); // comp -> alle kamper i vinduet
  const allDates = [];
  for (const comp of COMPETITIONS) {
    const data = await fdFetch(`/competitions/${comp}/matches?dateFrom=${today}&dateTo=${lookaheadTo}`);
    byComp.set(comp, data.matches);
    data.matches.forEach((mt) => allDates.push(mt.utcDate.slice(0, 10)));
  }

  // Nærmeste dato med kamper i minst én liga — er det kamper i dag, blir det i dag.
  const matchDate = allDates.length ? allDates.sort()[0] : today;

  for (const comp of COMPETITIONS) {
    const data = byComp.get(comp).filter((mt) => mt.utcDate.slice(0, 10) === matchDate);
    for (const mt of data) {
      const home = await cachedTeamForm(mt.homeTeam.id, comp);
      const away = await cachedTeamForm(mt.awayTeam.id, comp);

      // Uten noen kamphistorikk i det hele tatt (verken i denne ligaen eller
      // fallback) kan ikke ratingen regnes - blir NaN/null og krasjer siden.
      // Typisk et nyopprykket lag fra en divisjon football-data.org ikke dekker
      // på gratisplanen. Vis likevel KAMPEN (uten modell/tips) - heller enn å
      // gjøre den usynlig, som er verre enn en ufullstendig prediksjon.
      if (home.form.length === 0 || away.form.length === 0) {
        const missing = home.form.length === 0 ? mt.homeTeam.name : mt.awayTeam.name;
        console.warn(`Ingen modell for ${mt.homeTeam.tla}-${mt.awayTeam.tla}: mangler kamphistorikk for ${missing}`);
        fixtures.push({
          id: mt.id,
          label: `${mt.homeTeam.tla}–${mt.awayTeam.tla}`,
          homeName: mt.homeTeam.name || mt.homeTeam.shortName || mt.homeTeam.tla,
          awayName: mt.awayTeam.name || mt.awayTeam.shortName || mt.awayTeam.tla,
          kickoff: mt.utcDate,
          competition: comp,
          noModel: true,
          noModelReason: `Mangler kamphistorikk for ${missing} (sannsynligvis nettopp opprykket fra en divisjon som ikke dekkes av gratis-APIet)`,
          odds: null,
        });
        continue;
      }

      const eg = expectedGoals(home.form, away.form);

      // Usikkerhetsrabatt: hvis formen kom fra en annen liga (nyopprykket lag uten
      // historikk i denne ligaen ennå), trekk ratingen halvveis mot liga-snittet (1,00×)
      // i stedet for å stole fullt ut på tall fra et annet nivå. Regner derfor om
      // forventet mål selv her — samme formel som lib/ratings.js sin expectedGoals().
      const CONFIDENCE = 0.5; // 1 = full tillit til formen, 0 = ignorer den helt
      const discount = (blend, usedFallback) => usedFallback
        ? { atk: 1 + (blend.atk - 1) * CONFIDENCE, def: 1 + (blend.def - 1) * CONFIDENCE }
        : blend;
      const blendH = discount(eg.blendH, home.fallback);
      const blendA = discount(eg.blendA, away.fallback);
      const LEAGUE_HOME_AVG = 1.55, LEAGUE_AWAY_AVG = 1.20; // speiler lib/ratings.js LEAGUE
      const lambdaH = home.fallback || away.fallback ? blendH.atk * blendA.def * LEAGUE_HOME_AVG : eg.lambdaH;
      const lambdaA = home.fallback || away.fallback ? blendA.atk * blendH.def * LEAGUE_AWAY_AVG : eg.lambdaA;

      const markets = modelMarkets(lambdaH, lambdaA);
      // Fullt lagnavn (ikke kortform) - siden det bare er ett spill pr kamp nå
      // skal det være umulig å ta feil av hvilket lag/kamp spillet gjelder.
      const homeName = mt.homeTeam.name || mt.homeTeam.shortName || mt.homeTeam.tla;
      const awayName = mt.awayTeam.name || mt.awayTeam.shortName || mt.awayTeam.tla;

      const fx = {
        id: mt.id,
        label: `${mt.homeTeam.tla}–${mt.awayTeam.tla}`,
        homeName,
        awayName,
        kickoff: mt.utcDate,
        competition: comp,
        lambdaH,
        lambdaA,
        blendH,
        blendA,
        formSource: { home: home.fallback ? 'annen liga' : comp, away: away.fallback ? 'annen liga' : comp },
        formH: recentForm(home.form),
        formA: recentForm(away.form),
        markets,
        predictedScore: mostLikelyScore(lambdaH, lambdaA), // "forventet resultat" - kun for gøy
        fairOdds: {
          pHome: fairOdds(markets.pHome), pDraw: fairOdds(markets.pDraw), pAway: fairOdds(markets.pAway),
          dcHD: fairOdds(markets.dcHD), dcAD: fairOdds(markets.dcAD),
          o15: fairOdds(markets.o15), o25: fairOdds(markets.o25),
          o35: fairOdds(markets.o35),
          u35: fairOdds(markets.u35), u45: fairOdds(markets.u45),
          btts: fairOdds(markets.btts),
        },
        odds: null, // fylles av fetch-odds.js ~1t før avspark
      };
      fx.matchPick = pickMatchPick(fx); // modellens beste enkeltspill for kampen
      fixtures.push(fx);
    }
  }

  // buildCoupon() (testet, urørt) bygger fortsatt "The Gambler". "Dagens spill"
  // overstyrer vi med de sterkeste "beste spill" pr kamp. Begge trenger markets,
  // så kamper uten modell (noModel) holdes utenfor - de blir værende i
  // fixtures-lista slik at de fortsatt vises i appen.
  const modelled = fixtures.filter((f) => !f.noModel);
  const coupon = buildCoupon(modelled);
  // dagensSpill er alltid en LISTE - fetch-odds.js regner den om fra EKTE
  // bookmakerodds i vinduet så snart de er hentet.
  coupon.dagensSpill = buildDagensSpill(modelled);
  // `date` er datoen kampene faktisk spilles (kan være frem i tid) — check-results.js
  // bruker denne til å vite når den skal sjekke resultatet, så den må stemme med ekte kampdato.
  const out = { generatedAt: new Date().toISOString(), date: matchDate, fixtures, coupon };

  const outPath = path.join(__dirname, '..', 'data', 'today.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

  // Permanent arkiv (aldri overskrevet av morgendagens kjøring, men OPPDATERES fram til
  // kampdagen selv om vi allerede har forhåndsvist runden — ratingene blir mer presise
  // jo nærmere avspark vi kommer). Datagrunnlag for senere analyse av modellen.
  const archiveDir = path.join(__dirname, '..', 'data', 'archive');
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.writeFileSync(path.join(archiveDir, `${matchDate}.json`), JSON.stringify(out, null, 2));

  console.log(`Skrev ${fixtures.length} kamper for ${matchDate} til data/today.json (+ arkiv)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
