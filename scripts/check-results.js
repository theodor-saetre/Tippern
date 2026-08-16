// scripts/check-results.js
// Sjekker faktiske resultater for tidligere arkiverte kamper og regner ut
// hvilke markeder/spill som traff. Kjøres normalt hver morgen FØR build-model.js,
// slik at gårsdagens kamper garantert er ferdigspilt.
//
// Skriver resultatet tilbake i data/archive/{dato}.json — det er dette som
// bygger opp datagrunnlaget for å se om modellen faktisk slår bookmakeren over tid.
// Kjør lokalt med:  FOOTBALL_DATA_KEY=xxx node scripts/check-results.js

const fs = require('fs');
const path = require('path');

const API = 'https://api.football-data.org/v4';
const KEY = process.env.FOOTBALL_DATA_KEY;
const TODAY_DIR = path.join(__dirname, '..', 'data');
const ARCHIVE_DIR = path.join(TODAY_DIR, 'archive');

// Samme grense som football-data.org sin gratisplan — se scripts/build-model.js
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

// Samme markedsdefinisjoner som lib/poisson.js sin modelMarkets — men regnet
// fra fasitresultatet i stedet for fra sannsynlighet.
function actualOutcomes(hg, ag) {
  const total = hg + ag;
  const winner = hg > ag ? 'H' : hg < ag ? 'A' : 'D';
  return {
    pHome: winner === 'H', pDraw: winner === 'D', pAway: winner === 'A',
    dcHD: winner !== 'A', dcAD: winner !== 'H',
    o15: total >= 2, o25: total >= 3, o35: total >= 4, o45: total >= 5,
    u35: total < 4, u45: total < 5,
    btts: hg >= 1 && ag >= 1,
  };
}

// lib/coupon.js (testet, rørt ikke) gir oss bare lesbar tekst tilbake — ikke
// hvilken markedsnøkkel spillet kom fra. Tolker det heller her, ut fra de
// faste tekstmalene buildCoupon() alltid bruker.
function inferKey(pick, market, homeName) {
  if (market === 'Double chance') return pick.startsWith(homeName) ? 'dcHD' : 'dcAD';
  if (market === 'BTTS') return 'btts';
  if (market === 'Full tid') return pick.startsWith(homeName) ? 'pHome' : 'pAway';
  if (market === 'Totalt') {
    if (pick.includes('1,5')) return 'o15';
    if (pick.includes('2,5')) return 'o25';
    if (pick.includes('3,5')) return pick.startsWith('Over') ? 'o35' : 'u35';
    if (pick.includes('4,5')) return 'u45';
  }
  return null;
}

// Hvor lenge etter avspark vi tidligst forsøker å sjekke resultatet - en kamp
// varer ~105 min (2×45 + pause), pluss overtid og litt tid før tellende
// datakilder har oppdatert seg. 140 min = 2t20min gir god margin.
const MINUTES_AFTER_KICKOFF = 140;

// Behandler én arkivert dag. Returnerer true hvis noe ble endret.
async function processDay(file, now) {
  const filePath = path.join(ARCHIVE_DIR, file);
  const day = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (day.resultsChecked) return false;

  if (!day.fixtures || day.fixtures.length === 0) {
    day.resultsChecked = true;
    fs.writeFileSync(filePath, JSON.stringify(day, null, 2));
    return false;
  }

  // For DAGENS egen fil: ikke sløs et API-kall på kamper som umulig kan være
  // ferdige ennå. Tidligere dager sjekkes alltid (de er garantert overstått).
  const today = new Date(now).toISOString().slice(0, 10);
  if (day.date === today) {
    const anyCheckable = day.fixtures.some((f) =>
      !f.result && (now - new Date(f.kickoff).getTime()) / 60000 >= MINUTES_AFTER_KICKOFF);
    if (!anyCheckable) return false;
  }

  const comps = [...new Set(day.fixtures.map((f) => f.competition))];
  const finishedById = new Map();
  for (const comp of comps) {
    const data = await fdFetch(`/competitions/${comp}/matches?dateFrom=${day.date}&dateTo=${day.date}&status=FINISHED`);
    for (const mt of data.matches) finishedById.set(mt.id, mt);
  }

  let resolvedCount = 0;
  for (const f of day.fixtures) {
    const mt = finishedById.get(f.id);
    if (!mt) continue;
    const hg = mt.score.fullTime.home, ag = mt.score.fullTime.away;
    f.result = { home: hg, away: ag };
    f.outcomes = actualOutcomes(hg, ag);
    if (f.matchPick) f.matchPick.hit = f.outcomes[f.matchPick.key];
    resolvedCount++;
  }

  // Merk av treff i "Dagens spill" og "The Gambler". `.odds` på gambler-bein er
  // ALLTID modellens egen fair-odds (lib/coupon.js, urørt) - aldri overskrevet
  // med ekte pris. Slår derfor opp ekte odds separat (realOdds) via samme
  // fixture.odds som frontend allerede bruker til "bookmaker akkurat nå" -
  // slik at historikken kun bruker ekte, faktiske priser, aldri modelltall.
  const byLabel = new Map(day.fixtures.map((f) => [f.label, f]));
  function realOddsFor(pick, market, f) {
    if (!f || !f.odds) return null;
    const key = inferKey(pick, market, f.homeName);
    return key ? (f.odds[key] ?? null) : null;
  }
  // dagensSpill er en LISTE (3-4 spill) - se scripts/fetch-odds.js.
  if (day.coupon && Array.isArray(day.coupon.dagensSpill)) {
    for (const ds of day.coupon.dagensSpill) {
      const f = byLabel.get(ds.match);
      const key = f && inferKey(ds.pick, ds.market, f.homeName);
      ds.hit = (f && f.outcomes && key) ? f.outcomes[key] : null;
      // Var ds.odds allerede ekte pris (liveOdds:true, se fetch-odds.js)? Behold
      // den. Ellers, forsøk å slå opp ekte odds nå (kan ha kommet inn senere).
      ds.realOdds = ds.liveOdds ? ds.odds : realOddsFor(ds.pick, ds.market, f);
    }
  }
  if (day.coupon && day.coupon.gambler && day.coupon.gambler.legs) {
    for (const leg of day.coupon.gambler.legs) {
      const f = byLabel.get(leg.match);
      const key = f && inferKey(leg.pick, leg.market, f.homeName);
      leg.hit = (f && f.outcomes && key) ? f.outcomes[key] : null;
      leg.realOdds = realOddsFor(leg.pick, leg.market, f);
    }
    if (day.coupon.gambler.legs.length) {
      day.coupon.gambler.comboHit = day.coupon.gambler.legs.every((l) => l.hit === true);
    }
  }

  const allResolved = resolvedCount === day.fixtures.length;
  day.resultsChecked = allResolved;
  day.resultsCheckedAt = new Date().toISOString();
  fs.writeFileSync(filePath, JSON.stringify(day, null, 2));

  // Sjekker vi DAGENS egen fil (samme-dag-resultat, se MINUTES_AFTER_KICKOFF),
  // må data/today.json - som selve siden faktisk leser - også få resultatet.
  // Arkivfila alene holder ikke, den er bare det permanente datagrunnlaget.
  const todayPath = path.join(TODAY_DIR, 'today.json');
  if (fs.existsSync(todayPath)) {
    const liveDb = JSON.parse(fs.readFileSync(todayPath, 'utf8'));
    if (liveDb.date === day.date) fs.writeFileSync(todayPath, JSON.stringify(day, null, 2));
  }

  // Dagen er ferdig sjekket → legg "ett spill pr kamp"-tipsene inn i den
  // varige historikk-loggen (kun de som faktisk hadde ekte odds - se
  // scripts/build-model.js sin pickMatchPick og scripts/fetch-odds.js).
  if (allResolved) appendToHistory(day);

  console.log(`${day.date}: ${resolvedCount}/${day.fixtures.length} kamper avklart` +
    (allResolved ? ' — dagen er ferdig sjekket' : ' — noen gjenstår, prøver igjen neste kjøring'));
  return true;
}

const HISTORY_PATH = path.join(__dirname, '..', 'data', 'history.json');

// Varig, alltid-voksende logg over ekte, avklarte tips — datagrunnlaget for
// statistikk.html (treffprosent) og avkastning.html (100 kr pr spill).
// Kun tips som faktisk hadde en ekte hentet odds telles med. Tagget med
// `source` slik at man ser om det var "ett spill pr kamp"-tipset (matchPick),
// "Dagens spill"-utvalget, eller et Gambler-bein.
function appendToHistory(day) {
  const history = fs.existsSync(HISTORY_PATH) ? JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8')) : [];
  const push = (source, match, pick, p, odds, hit) => {
    if (odds == null || hit == null) return; // ingen ekte odds → ikke en reell "innsats"
    history.push({ date: day.date, match, pick, p, odds, hit, source });
  };

  for (const f of day.fixtures) {
    if (f.matchPick) push('matchPick', f.label, f.matchPick.pick, f.matchPick.p, f.matchPick.odds, f.matchPick.hit);
  }
  if (day.coupon && Array.isArray(day.coupon.dagensSpill)) {
    for (const ds of day.coupon.dagensSpill) push('dagensSpill', ds.match, ds.pick, ds.p, ds.realOdds, ds.hit);
  }
  if (day.coupon && day.coupon.gambler && day.coupon.gambler.legs) {
    for (const leg of day.coupon.gambler.legs) push('gambler', leg.match, leg.pick, leg.p, leg.realOdds, leg.hit);
  }

  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
}

async function main() {
  if (!KEY) throw new Error('Mangler FOOTBALL_DATA_KEY');
  if (!fs.existsSync(ARCHIVE_DIR)) { console.log('Ingen arkiverte dager ennå.'); return; }

  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const files = fs.readdirSync(ARCHIVE_DIR)
    .filter((f) => f.endsWith('.json') && f.slice(0, 10) <= today) // tidligere dager + dagens (processDay avgjør selv om dagens er verdt et forsøk)
    .sort();

  let updated = 0;
  for (const file of files) {
    if (await processDay(file, now)) updated++;
  }
  console.log(`Ferdig. ${updated} dag(er) oppdatert med resultater.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
