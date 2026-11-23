// scripts/fetch-odds.js
// To modus:
//  - "morgen" (ODDS_MODE=morning, kjøres én gang i daily-model.yml): henter odds for
//    ALLE dagens kamper med én gang, så du får en oversikt tidlig på dagen.
//  - "prekickoff" (standard, kjøres jevnlig i match-odds.yml): oppdaterer med de
//    ferskeste tallene ~1t før avspark og låser kampen (ikke brenn kvote igjen).
// Uansett modus lagres forrige verdi i f.oddsHistory, så du får ekte oddsbevegelse
// mellom morgen-hentingen og den siste, ferske hentingen før avspark.
//
// Kjør lokalt med:  ODDS_API_KEY=xxx node scripts/fetch-odds.js
//              eller ODDS_API_KEY=xxx ODDS_MODE=morning node scripts/fetch-odds.js

const fs = require('fs');
const path = require('path');
const { buildCombos } = require('../lib/combos');
const { buildCoupons } = require('../lib/coupons');

const KEY = process.env.ODDS_API_KEY;
const MODE = process.env.ODDS_MODE === 'morning' ? 'morning' : 'prekickoff';
// --- Unibet-test (sammenligning mot BB Gold) --------------------------------
// BB Gold finnes ikke i noen odds-API, så vi tester om Unibet ligger nær. Unibets
// EGNE priser plukkes ut av det samme API-svaret vi allerede henter (regions=eu
// inneholder alle disse) - null ekstra kostnad. Første treff i lista brukes.
const COMPARE_BOOKMAKERS = ['unibet_se', 'unibet_nl', 'unibet_fr'];
// Referansebøker til konsensuspris: snitt av marginfrie sannsynligheter. Skarpe bøker ligger
// innen 1-2 prosentpoeng fra hverandre; snittet av flere gir mindre støy enn én bok.
const REF_BOOKMAKERS = ['pinnacle', 'unibet_se', 'unibet_nl', 'unibet_fr', 'marathonbet', 'betsson', 'nordicbet'];
// Ekte double_chance-marked (+1 kreditt pr kamp) hentes bare for disse ligaene under testen.
const DC_TEST_COMPS = ['PL'];

// --- Ligaavvik (se lib/combos.js regel 7) ----------------------------------------------
// Gjennomsnittlig (faktiske mål - markedets forventede mål) pr liga. Seed fra arkivanalysen
// 20. nov 2026 (223 kamper); oppdateres deretter automatisk fra arkivet etter hvert som kamper
// med comboFit.marketTotal og resultat samles inn (vektet mot seed etter antall kamper).
const LEAGUE_BIAS_SEED = { PL: { bias: -0.32, n: 84 }, PD: { bias: 0.03, n: 97 }, CL: { bias: 0.54, n: 42 } };
function leagueBias() {
  const sums = {};
  for (const [comp, s] of Object.entries(LEAGUE_BIAS_SEED)) sums[comp] = { total: s.bias * s.n, n: s.n };
  const dir = path.join(__dirname, '..', 'data', 'archive');
  if (fs.existsSync(dir)) {
    for (const file of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      let day;
      try { day = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch (e) { continue; }
      for (const f of day.fixtures || []) {
        if (!f.result || !f.comboFit || f.comboFit.marketTotal == null) continue;
        const a = (sums[f.competition] = sums[f.competition] || { total: 0, n: 0 });
        a.total += (f.result.home + f.result.away) - f.comboFit.marketTotal;
        a.n += 1;
      }
    }
  }
  // Avvik under 0,15 mål er støy (La Liga ble litt dårligere med justering i walk-forward-testen)
  return Object.fromEntries(Object.entries(sums).map(([k, v]) => [k, Math.abs(v.total / v.n) < 0.15 ? 0 : v.total / v.n]));
}

const LEAD_MINUTES = 90;   // hent når kamp er ≤ 90 min unna
const MIN_MINUTES = 20;    // ...men ikke helt inn til avspark

// The Odds API sport-keys for ligaene dine
const SPORT_KEYS = {
  PL: 'soccer_epl',
  SA: 'soccer_italy_serie_a',
  PD: 'soccer_spain_la_liga',
  BL1: 'soccer_germany_bundesliga',
  FL1: 'soccer_france_ligue_one',
  CL: 'soccer_uefa_champs_league',
};

async function main() {
  if (!KEY) throw new Error('Mangler ODDS_API_KEY');

  const dataPath = path.join(__dirname, '..', 'data', 'today.json');
  const db = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const now = Date.now();

  // Morgen-modus: alle dagens kamper som ikke har odds ennå, uansett hvor lenge til avspark.
  // Prekickoff-modus (standard): bare kamper ~1t unna avspark, og ikke allerede låst.
  const due = db.fixtures.filter((f) => {
    // Også kamper som har odds men mangler referansepriser (oddsRef/oddsUnibet) hentes på nytt - ellers
    // får de aldri kombier hvis de ble hentet av en eldre versjon av scriptet.
    if (MODE === 'morning') return !f.odds || (!f.oddsRef && !f.oddsUnibet);
    const mins = (new Date(f.kickoff).getTime() - now) / 60000;
    return mins <= LEAD_MINUTES && mins >= MIN_MINUTES && !f.oddsLocked;
  });

  if (due.length === 0) {
    console.log(MODE === 'morning' ? 'Alle kamper har allerede odds.' : 'Ingen kamper i odds-vinduet akkurat nå.');
    return;
  }

  if (MODE === 'morning') {
    // Billig oversikt: ett kall pr liga (h2h+totals), uansett hvor mange kamper.
    // Ikke BTTS her - det krever ett kall PR KAMP (se prekickoff under), og vi vil
    // ikke brenne kvote på det tidlig på dagen når tallene uansett blir oppdatert igjen.
    const compsNeeded = [...new Set(due.map((f) => f.competition))];
    for (const comp of compsNeeded) {
      const sport = SPORT_KEYS[comp];
      const url = `https://api.the-odds-api.com/v4/sports/${sport}/odds/?regions=eu&markets=h2h,totals&oddsFormat=decimal&apiKey=${KEY}`;
      const res = await fetch(url);
      if (!res.ok) { console.error(`Odds ${res.status} for ${comp}`); continue; }
      const events = await res.json();
      for (const f of due) {
        const ev = matchEvent(events, f);
        if (!ev) continue;
        applyFreshOdds(db, f, extractOdds(ev));
        f.oddsUnibet = extractCompareOdds(ev);
        f.oddsRef = extractConsensus(ev);
      }
    }
  } else {
    // Prekickoff: ett kall PR KAMP (events-lista er gratis, selve odds-kallet
    // koster ~3 kreditter for h2h+totals+btts kombinert). Trygt fordi vi bare
    // følger 2 ligaer, og dette skjer kun én gang pr kamp (låses etterpå).
    const eventsCache = new Map(); // sport -> events-liste (gratis å hente, men ingen vits å hente flere ganger)
    for (const f of due) {
      const sport = SPORT_KEYS[f.competition];
      if (!eventsCache.has(sport)) {
        const res = await fetch(`https://api.the-odds-api.com/v4/sports/${sport}/events?apiKey=${KEY}`);
        eventsCache.set(sport, res.ok ? await res.json() : []);
      }
      const ev = matchEvent(eventsCache.get(sport), f);
      if (!ev) continue;
      // Under Unibet-testen hentes også det ekte double_chance-markedet (+1 kreditt
      // pr kamp) - men bare for ligaene i DC_TEST_COMPS, så kvoten holder.
      const markets = DC_TEST_COMPS.includes(f.competition) ? 'h2h,totals,btts,double_chance' : 'h2h,totals,btts';
      const res = await fetch(`https://api.the-odds-api.com/v4/sports/${sport}/events/${ev.id}/odds?regions=eu&markets=${markets}&oddsFormat=decimal&apiKey=${KEY}`);
      if (!res.ok) { console.error(`Odds ${res.status} for ${f.label}`); continue; }
      const fullEvent = await res.json();
      applyFreshOdds(db, f, extractOdds(fullEvent));
      f.oddsUnibet = extractCompareOdds(fullEvent);
      f.oddsRef = extractConsensus(fullEvent);
      f.oddsLocked = true; // hentet ferskt rett før avspark → ikke brenn kvote igjen
    }
  }

  // Kombispill (resultat/dobbel sjanse + mål) for alle kamper vi har Unibet-priser på.
  // Pris-estimatene er markedsbaserte (se lib/combos.js) - aldri ekte kombi-odds.
  const LB = leagueBias();
  for (const f of db.fixtures) {
    if (!f.oddsUnibet && !f.oddsRef) continue;
    const built = buildCombos(f, { leagueBias: LB });
    if (built) { f.combos = built.combos; f.comboFit = { ...built.fit, refBooks: built.refBooks, refSpread: built.refSpread }; f.comboPick = built.combos[0] || null; f.comboOver = built.over; f.comboUnder = built.under; f.comboAlts = built.alts; }
  }
  // Kombikuponger pr avspark-tid + Dagens kupong (lib/coupons.js)
  const cps = buildCoupons(db.fixtures);
  db.coupon = db.coupon || {};
  db.coupon.kombikuponger = cps.kombikuponger;
  db.coupon.dagensKombi = cps.dagensKombi;

  db.oddsUpdatedAt = new Date().toISOString();
  fs.writeFileSync(dataPath, JSON.stringify(db, null, 2));

  // Oppdater samme dags arkivfil, så de ferskeste odds-tallene også blir bevart permanent.
  const archivePath = path.join(__dirname, '..', 'data', 'archive', `${db.date}.json`);
  if (fs.existsSync(archivePath)) {
    fs.writeFileSync(archivePath, JSON.stringify(db, null, 2));
  }

  console.log(`[${MODE}] Oppdaterte odds for ${due.length} kamp(er).`);
}

// --- hjelpere ---

// Legger fersk odds inn på fixture, og flytter forrige verdi til oddsHistory
// (ekte oddsbevegelse mellom morgen-henting og prekickoff-henting).
function applyFreshOdds(db, f, fresh) {
  f.oddsHistory = f.oddsHistory || [];
  if (f.odds) f.oddsHistory.push({ at: db.oddsUpdatedAt, odds: f.odds });
  f.odds = fresh;
}

// Gjør lagnavn sammenlignbare: små bokstaver, uten aksenter/klubbtillegg/tegnsetting.
function normalizeName(name) {
  return name
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\b(fc|cf|afc|sc|ac|cd|calcio|club)\b/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

function matchEvent(events, fixture) {
  const homeN = normalizeName(fixture.homeName);
  const awayN = normalizeName(fixture.awayName);
  const kickoffMs = new Date(fixture.kickoff).getTime();

  return events.find((ev) => {
    const evHome = normalizeName(ev.home_team);
    const evAway = normalizeName(ev.away_team);
    const sameTeams =
      (evHome.includes(homeN) || homeN.includes(evHome)) &&
      (evAway.includes(awayN) || awayN.includes(evAway));
    if (!sameTeams) return false;
    // Tåler litt avvik i kickoff-tid (utsettelser o.l.), men skal være samme kamp
    const diffMins = Math.abs(new Date(ev.commence_time).getTime() - kickoffMs) / 60000;
    return diffMins <= 180;
  }) || null;
}

// Klassifiserer et double_chance-utfall ("Liverpool or Draw", "Draw or Fulham", "1X", "X2" ...)
// som hjemme-eller-uavgjort ('HD') / borte-eller-uavgjort ('AD'). Alt annet (f.eks. "hjemme
// eller borte") gir null. Navnene er ikke dokumentert hos The Odds API, så vi er tolerante.
const unknownDcNames = new Set();
function classifyDc(name, ev) {
  const raw = String(name).toLowerCase().replace(/\s+/g, '');
  if (raw === '1x') return 'HD';
  if (raw === 'x2') return 'AD';
  if (raw === '12') return null;
  const n = normalizeName(name);
  const hasDraw = /draw|tie|uavgjort|^x|x$/.test(raw);
  const hasHome = n.includes(normalizeName(ev.home_team)) || /home|hjemme/.test(raw);
  const hasAway = n.includes(normalizeName(ev.away_team)) || /away|borte/.test(raw);
  if (hasDraw && hasHome && !hasAway) return 'HD';
  if (hasDraw && hasAway && !hasHome) return 'AD';
  if (!(hasHome && hasAway)) unknownDcNames.add(name);
  return null;
}

// onlyBookmaker: hvis oppgitt brukes KUN den bookmakerens priser (til Unibet-testen);
// ellers "beste pris" på tvers av alle bookmakere i svaret (som før).
function extractOdds(ev, onlyBookmaker) {
  let bestHome = null, bestDraw = null, bestAway = null;
  let bestBttsYes = null;
  let bestDcHD = null, bestDcAD = null; // ekte double_chance-marked, hvis hentet
  const totals = {}; // point (f.eks. 2.5) -> { over, under }
  const max = (cur, v) => (cur === null ? v : Math.max(cur, v));

  for (const bk of ev.bookmakers || []) {
    if (onlyBookmaker && bk.key !== onlyBookmaker) continue;
    for (const mkt of bk.markets || []) {
      if (mkt.key === 'double_chance') {
        for (const o of mkt.outcomes) {
          const side = classifyDc(o.name, ev);
          if (side === 'HD') bestDcHD = max(bestDcHD, o.price);
          else if (side === 'AD') bestDcAD = max(bestDcAD, o.price);
        }
      } else if (mkt.key === 'h2h') {
        for (const o of mkt.outcomes) {
          if (o.name === ev.home_team) bestHome = bestHome === null ? o.price : Math.max(bestHome, o.price);
          else if (o.name === ev.away_team) bestAway = bestAway === null ? o.price : Math.max(bestAway, o.price);
          else if (o.name === 'Draw') bestDraw = bestDraw === null ? o.price : Math.max(bestDraw, o.price);
        }
      } else if (mkt.key === 'totals') {
        for (const o of mkt.outcomes) {
          const t = (totals[o.point] = totals[o.point] || {});
          if (o.name === 'Over') t.over = t.over ? Math.max(t.over, o.price) : o.price;
          if (o.name === 'Under') t.under = t.under ? Math.max(t.under, o.price) : o.price;
        }
      } else if (mkt.key === 'btts') {
        for (const o of mkt.outcomes) {
          if (o.name === 'Yes') bestBttsYes = bestBttsYes === null ? o.price : Math.max(bestBttsYes, o.price);
        }
      }
    }
  }

  // Ekte bookmakerodds skal ALLTID summere til over 100% implisitt sannsynlighet
  // samlet (det er bookmakerens margin). Plukker vi "beste pris pr utfall" på
  // tvers av ULIKE bookmakere (typisk for tynne markeder, f.eks. en nyopprykket
  // klubb), kan én avvikende/feilpriset bookmaker gi en matematisk umulig
  // kombinasjon (samlet sannsynlighet under 100%). Forkast heller enn å vise
  // et tall som ser ekte ut, men er misvisende.
  function plausible(...odds) {
    if (odds.some((o) => o == null)) return true; // ufullstendig sett - ikke denne sjekkens jobb
    const sum = odds.reduce((s, o) => s + 1 / o, 0);
    return sum >= 0.97;
  }
  if (!plausible(bestHome, bestDraw, bestAway)) {
    console.warn(`Kastet h2h-odds for ${ev.home_team}-${ev.away_team}: matematisk umulig kombinasjon (sannsynligvis feilpris hos én bookmaker)`);
    bestHome = bestDraw = bestAway = null;
  }
  for (const point of Object.keys(totals)) {
    const t = totals[point];
    if (!plausible(t.over, t.under)) {
      console.warn(`Kastet totals ${point} for ${ev.home_team}-${ev.away_team}: matematisk umulig kombinasjon`);
      t.over = t.under = null;
    }
  }

  // Double chance: bruk det EKTE markedet når det er hentet (bare for ligaene i
  // DC_TEST_COMPS). Ellers avledes det fra h2h ved å summere implisitt
  // sannsynlighet for de to utfallene - en grov tilnærming som typisk blir litt for høy.
  const dc = (a, b) => (a && b ? +(1 / (1 / a + 1 / b)).toFixed(2) : null);
  const line = (point) => totals[point] || {};

  return {
    dcHD: bestDcHD ?? dc(bestHome, bestDraw),
    dcAD: bestDcAD ?? dc(bestAway, bestDraw),
    pHome: bestHome,
    pDraw: bestDraw,
    pAway: bestAway,
    o15: line(1.5).over ?? null,
    o25: line(2.5).over ?? null,
    o35: line(3.5).over ?? null,
    u35: line(3.5).under ?? null,
    u45: line(4.5).under ?? null,
    btts: bestBttsYes,
  };
}

// Unibets EGNE priser for kampen (første tilgjengelige i COMPARE_BOOKMAKERS), til
// sammenligning med BB Gold. Returnerer null hvis ingen av dem har odds for kampen.
// dcReal = true hvis dobbel sjanse er Unibets ekte marked, false hvis den er avledet fra h2h.
function extractCompareOdds(ev) {
  const bk = COMPARE_BOOKMAKERS
    .map((key) => (ev.bookmakers || []).find((b) => b.key === key))
    .find(Boolean);
  if (!bk) return null;
  return {
    bookmaker: bk.key,
    dcReal: (bk.markets || []).some((m) => m.key === 'double_chance'),
    odds: extractOdds(ev, bk.key),
    totals: mainTotalsLine(bk), // begge sider av Unibets hovedlinje - brukes til kombi-estimatene (lib/combos.js)
  };
}

// Konsensus: snitt av marginfrie (proporsjonalt) 1X2- og totals-sannsynligheter på tvers av REF_BOOKMAKERS.
// Returnerer "syntetiske" marginfrie odds (1/p) i samme form som lib/combos.js forventer.
function extractConsensus(ev) {
  const books = (ev.bookmakers || []).filter((b) => REF_BOOKMAKERS.includes(b.key));
  const h2h = [];
  const totals = {}; // linje -> liste av P(over) (marginfri)
  for (const b of books) {
    const m = (b.markets || []).find((x) => x.key === 'h2h');
    if (m) {
      const price = (name) => (m.outcomes.find((o) => o.name === name) || {}).price;
      const h = price(ev.home_team), d = price('Draw'), a = price(ev.away_team);
      if (h && d && a) { const s = 1 / h + 1 / d + 1 / a; h2h.push([1 / h / s, 1 / d / s, 1 / a / s]); }
    }
    const t = (b.markets || []).find((x) => x.key === 'totals');
    if (t) {
      const lines = {};
      for (const o of t.outcomes || []) { const l = (lines[o.point] = lines[o.point] || {}); l[o.name] = o.price; }
      for (const [pt, l] of Object.entries(lines)) {
        if (![1.5, 2.5, 3.5, 4.5].includes(Number(pt)) || !l.Over || !l.Under) continue;
        (totals[pt] = totals[pt] || []).push((1 / l.Over) / (1 / l.Over + 1 / l.Under));
      }
    }
  }
  if (h2h.length < 2) return null;
  const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const p = [0, 1, 2].map((i) => avg(h2h.map((x) => x[i])));
  const spread = Math.max(...h2h.map((x) => x[0])) - Math.min(...h2h.map((x) => x[0])); // uenighet om hjemmesjanse
  // linja flest bøker priser; ved uavgjort den nærmest 50/50
  const best = Object.entries(totals).map(([pt, ps]) => ({ line: Number(pt), n: ps.length, p: avg(ps) }))
    .sort((a, b) => b.n - a.n || Math.abs(a.p - 0.5) - Math.abs(b.p - 0.5))[0];
  if (!best) return null;
  return {
    bookmaker: 'konsensus', n: h2h.length, spread,
    odds: { pHome: 1 / p[0], pDraw: 1 / p[1], pAway: 1 / p[2] },
    totals: { line: best.line, over: 1 / best.p, under: 1 / (1 - best.p) },
  };
}

// Bookmakerens over/under-linje med begge sider som ligger nærmest 50/50 (= "hovedlinja"),
// begrenset til linjene lib/poisson.js kan tilpasse mot (1,5-4,5). null hvis ingen.
function mainTotalsLine(bk) {
  const mkt = (bk.markets || []).find((m) => m.key === 'totals');
  if (!mkt) return null;
  const lines = {};
  for (const o of mkt.outcomes || []) {
    const l = (lines[o.point] = lines[o.point] || {});
    if (o.name === 'Over') l.over = o.price;
    if (o.name === 'Under') l.under = o.price;
  }
  let best = null;
  for (const [pt, l] of Object.entries(lines)) {
    const line = Number(pt);
    if (![1.5, 2.5, 3.5, 4.5].includes(line) || !l.over || !l.under) continue;
    const skew = Math.abs(1 / l.over - 1 / l.under);
    if (!best || skew < best.skew) best = { line, over: l.over, under: l.under, skew };
  }
  return best && { line: best.line, over: best.over, under: best.under };
}

main()
  .then(() => {
    if (unknownDcNames.size) console.warn('Ukjente double_chance-utfallsnavn (sjekk classifyDc):', [...unknownDcNames].join(' | '));
  })
  .catch((e) => { console.error(e); process.exit(1); });
