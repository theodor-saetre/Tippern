// scripts/build-model.js
// Daglig jobb: henter dagens kamper + lagform fra football-data.org,
// regner modell + kupong, skriver data/today.json.
//
// SKJELETT — fyll inn API-hentingen der det står TODO. Modell-logikken er ferdig.
// Kjør lokalt med:  FOOTBALL_DATA_KEY=xxx node scripts/build-model.js

const fs = require('fs');
const path = require('path');
const { expectedGoals } = require('../lib/ratings');
const { modelMarkets, mostLikelyScore, SCORE_CONDITIONS, fairOdds } = require('../lib/poisson');
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
        oppId: isHome ? mt.awayTeam.id : mt.homeTeam.id, // motstander (for styrkevekting)
        comp: mt.competition && mt.competition.code,     // hvilken turnering kampen var i (for nivåvekting)
      };
    })
    .sort((a, b) => new Date(a.date) - new Date(b.date)); // eldst → nyest
}

// --- Motstands- og nivåvekting av form -------------------------------------
// Modellen brukte tidligere rå mål scoret/sluppet inn, uten å bry seg om HVEM
// de var mot. Her henter vi ligatabellene og lager en styrkeindeks pr lag, og
// en grov nivåfaktor pr turnering, så "4 mål hjemme mot et topplag" veier mer
// enn "4 mål mot et bunnlag i en svakere liga".

// Grov relativ styrke pr turnering (1,00 ≈ snittet av topp-5-ligaene).
const LEAGUE_TIER = { CL: 1.15, PL: 1.06, PD: 1.03, SA: 1.00, BL1: 1.00, FL1: 0.96 };
const TIER_DEFAULT = 0.80; // ukjent / lavere divisjon

// Tabeller vi henter for å kunne slå opp motstanderstyrke (ett kall hver, kun
// rate-limitert – ikke kvote). Dekker der CL-lagenes hjemmeform kommer fra.
const STANDINGS_COMPS = ['PL', 'PD', 'SA', 'BL1', 'FL1', 'CL'];
const STRENGTH = new Map(); // teamId -> { atk, def } relativt til turneringssnitt (1,00 = snitt)

async function fetchStrengthIndex() {
  for (const comp of STANDINGS_COMPS) {
    let table;
    try {
      const data = await fdFetch(`/competitions/${comp}/standings`);
      const total = (data.standings || []).find((s) => s.type === 'TOTAL') || (data.standings || [])[0];
      table = total && total.table;
    } catch (e) {
      console.warn(`Tabell mangler for ${comp} (${e.message}) – hopper over motstandsvekting der`);
      continue;
    }
    if (!table || !table.length) continue;

    const played = table.reduce((s, t) => s + (t.playedGames || 0), 0);
    const goals = table.reduce((s, t) => s + (t.goalsFor || 0), 0);
    const avgGpg = played > 0 ? goals / played : 1.35; // mål scoret pr lag pr kamp
    for (const t of table) {
      if (!t.playedGames) continue;
      const rawAtk = t.goalsFor / t.playedGames / avgGpg;
      const rawDef = t.goalsAgainst / t.playedGames / avgGpg;
      // tidlig i sesongen er tabellen støyete – trekk mot 1,00 til det er spilt ~8 kamper
      const reg = Math.min(t.playedGames, 8) / 8;
      const clamp = (x) => Math.max(0.6, Math.min(1.55, 1 + (x - 1) * reg));
      STRENGTH.set(t.team.id, { atk: clamp(rawAtk), def: clamp(rawDef) });
    }
  }
  console.log(`Styrkeindeks bygget for ${STRENGTH.size} lag`);
}

// Justerer én formliste for motstanderstyrke + liganivå, mot turneringen
// `targetComp` som kampen faktisk spilles i. Rå form beholdes til visning.
function adjustForm(form, targetComp) {
  const toTier = LEAGUE_TIER[targetComp] || 1.00;
  return form.map((m) => {
    const opp = STRENGTH.get(m.oppId) || { atk: 1, def: 1 };
    const fromTier = LEAGUE_TIER[m.comp] || TIER_DEFAULT;
    const tierRatio = fromTier / toTier; // < 1 ⇒ kampen var på et lavere nivå enn den vi spår

    // Mål scoret mot en lekk defensiv (opp.def > 1) er "billigere"; i en svakere
    // liga (tierRatio < 1) teller de mindre mot topp-motstand. Halv effekt hver,
    // så en helt gjennomsnittlig motstander/liga lar tallet stå urørt.
    const gfAdj = m.gf * (0.5 + 0.5 / opp.def) * (0.5 + 0.5 * tierRatio);
    // Mål sluppet inn mot et svakt angrep (opp.atk < 1) er verre enn det ser ut;
    // i en svakere liga ville man sluppet inn flere mot topp-motstand.
    const gaAdj = m.ga * (0.5 + 0.5 / opp.atk) * (0.5 + 0.5 / tierRatio);

    return { ...m, gf: Math.max(0, Math.min(6, gfAdj)), ga: Math.max(0, Math.min(6, gaAdj)) };
  });
}

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

// Hent siste ~10 ferdigspilte kamper for et lag, PÅ TVERS AV ALLE turneringer
// (liga, cup, Champions League osv). Tidligere ble dette filtrert til bare
// samme turnering som kampen som analyseres, for å unngå å blande inn tøffere/
// svakere motstand urettferdig - men nå som adjustForm() vekter hvert enkelt
// formresultat for motstanderstyrke OG liganivå, trenger vi ikke lenger kaste
// bort ekte, fersk form (f.eks. en god CL-kamp) bare fordi den var i en annen
// turnering. Ett kall pr lag (var før to ved "fallback").
async function getTeamForm(teamId) {
  // Uten dateFrom/dateTo ser endpointet ut til å ikke nå tilbake til forrige sesong
  // i sommerpausen (får 0 kamper for et lag som ikke har spilt i ny sesong ennå).
  // Går derfor ~9 måneder tilbake — mer enn nok til å dekke en hel sesong.
  const dateTo = new Date().toISOString().slice(0, 10);
  const dateFrom = new Date(Date.now() - 270 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const data = await fdFetch(`/teams/${teamId}/matches?status=FINISHED&dateFrom=${dateFrom}&dateTo=${dateTo}&limit=10`);
  return { form: mapForm(data.matches, teamId) };
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
// og velger det med høyest modell-sannsynlighet BLANT dem som (a) har en rimelig
// odds (fair ≥ 1,40 - hindrer at near-locks som "under 4,5 mål" vinner hver gang,
// noe bookmakere knapt priser) OG (b) IKKE motsier modellens egen mest sannsynlige
// scorelinje (`storyScore`, se mostLikelyScore i lib/poisson.js) - f.eks. skal
// "over 1,5" aldri anbefales hvis modellen egentlig lener mot en 1-0-kamp.
// Faller tilbake gradvis (dropper først story-kravet, så odds-kravet) hvis
// ingen kandidat overlever, så vi aldri står helt uten et spill.
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
function pickMatchPick(fixture, storyScore) {
  const cands = Object.keys(PICK_MARKETS)
    .map((key) => ({ key, p: fixture.markets[key], ...PICK_MARKETS[key](fixture) }))
    .filter((c) => c.p != null);
  const coherent = storyScore
    ? cands.filter((c) => !SCORE_CONDITIONS[c.key] || SCORE_CONDITIONS[c.key](storyScore.home, storyScore.away))
    : cands;
  const storyPool = coherent.length ? coherent : cands;
  const inBand = storyPool.filter((c) => 1 / c.p >= 1.40);
  const pool = (inBand.length ? inBand : storyPool).sort((a, b) => b.p - a.p);
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

  await fetchStrengthIndex(); // ligatabeller → motstanderstyrke-oppslag

  const today = new Date().toISOString().slice(0, 10);
  const fixtures = [];
  const formCache = new Map(); // teamId -> form, i tilfelle et lag opptrer flere ganger samme dag

  async function cachedTeamForm(teamId) {
    if (!formCache.has(teamId)) formCache.set(teamId, await getTeamForm(teamId));
    return formCache.get(teamId);
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
      const home = await cachedTeamForm(mt.homeTeam.id);
      const away = await cachedTeamForm(mt.awayTeam.id);

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

      // Vekt formen for motstanderstyrke + liganivå FØR modellen regner på den
      // (lib/ratings.js er urørt - den får bare justerte mål inn). Dette er nå
      // den ENESTE justeringen for "kampen var på et annet nivå" - den gamle,
      // grove 50%-rabatten for nyopprykkede/andre-liga-lag er overflødig, siden
      // adjustForm() allerede vekter hvert enkelt formresultat presist.
      const homeFormAdj = adjustForm(home.form, comp);
      const awayFormAdj = adjustForm(away.form, comp);
      const eg = expectedGoals(homeFormAdj, awayFormAdj);
      const { lambdaH, lambdaA, blendH, blendA } = eg;

      const markets = modelMarkets(lambdaH, lambdaA);
      // Fullt lagnavn (ikke kortform) - siden det bare er ett spill pr kamp nå
      // skal det være umulig å ta feil av hvilket lag/kamp spillet gjelder.
      const homeName = mt.homeTeam.name || mt.homeTeam.shortName || mt.homeTeam.tla;
      const awayName = mt.awayTeam.name || mt.awayTeam.shortName || mt.awayTeam.tla;
      // Regnes ut FØR fixture-objektet: storyScore er modellens ubegrensede beste
      // gjetning på scorelinjen ("hvilken vei lener kampen"), og styrer hvilke
      // spill som i det hele tatt er kandidater (se pickMatchPick). Det viste
      // "forventet resultat" låses etterpå til akkurat DETTE spillet.
      const storyScore = mostLikelyScore(lambdaH, lambdaA);
      const matchPick = pickMatchPick({ homeName, awayName, markets }, storyScore);

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
        // Hvilke turneringer formen faktisk kommer fra (kan være flere nå, f.eks. "PL/CL").
        formSource: {
          home: [...new Set(home.form.map((m) => m.comp).filter(Boolean))].join('/') || comp,
          away: [...new Set(away.form.map((m) => m.comp).filter(Boolean))].join('/') || comp,
        },
        formH: recentForm(home.form),
        formA: recentForm(away.form),
        // Snitt mål siste 5 - rå vs. motstands-/nivåjustert, så det går an å se hva vektingen gjorde.
        formAdj: {
          home: { rawGF: avg(home.form.slice(-5).map((m) => m.gf)), rawGA: avg(home.form.slice(-5).map((m) => m.ga)),
                  adjGF: avg(homeFormAdj.slice(-5).map((m) => m.gf)), adjGA: avg(homeFormAdj.slice(-5).map((m) => m.ga)) },
          away: { rawGF: avg(away.form.slice(-5).map((m) => m.gf)), rawGA: avg(away.form.slice(-5).map((m) => m.ga)),
                  adjGF: avg(awayFormAdj.slice(-5).map((m) => m.gf)), adjGA: avg(awayFormAdj.slice(-5).map((m) => m.ga)) },
        },
        markets,
        matchPick, // modellens beste enkeltspill for kampen
        // "Forventet resultat" - mest sannsynlige scorelinje SOM STEMMER MED spillet
        // over (kun for gøy, men skal aldri se ut som en selvmotsigelse).
        predictedScore: mostLikelyScore(lambdaH, lambdaA, matchPick.key),
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
