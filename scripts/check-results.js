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
const { comboHit } = require('../lib/combos');

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
    if (f.combos) for (const c of f.combos) c.hit = comboHit(c, hg, ag);
    if (f.comboPick) f.comboPick.hit = comboHit(f.comboPick, hg, ag);
    if (f.comboAlts) for (const c of f.comboAlts) c.hit = comboHit(c, hg, ag);
    resolvedCount++;
  }

  // Kombikuponger: marker hvert ben, og kupongen treffer bare hvis ALLE ben treffer.
  const fxByLabel = new Map(day.fixtures.map((x) => [x.label, x]));
  const markCoupon = (cp) => {
    if (!cp || !cp.legs) return;
    for (const l of cp.legs) {
      const fx = fxByLabel.get(l.match);
      if (fx && fx.result) l.hit = comboHit(l, fx.result.home, fx.result.away);
    }
    cp.hit = cp.legs.some((l) => l.hit === false) ? false : (cp.legs.every((l) => l.hit === true) ? true : null);
  };
  if (day.coupon) {
    (day.coupon.kombikuponger || []).forEach(markCoupon);
    markCoupon(day.coupon.dagensKombi);
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

  // Dagen er ferdig sjekket → legg kombispill og kuponger inn i de varige loggene (combo-history.json, coupon-history.json).

  console.log(`${day.date}: ${resolvedCount}/${day.fixtures.length} kamper avklart` +
    (allResolved ? ' — dagen er ferdig sjekket' : ' — noen gjenstår, prøver igjen neste kjøring'));
  return true;
}

// Egen logg for kombispillene (resultat/dobbel sjanse + mål). Kombipriser finnes ikke i odds-feeden, så `estOdds` er et markedsestimat
// (estimert BB Gold-pris: marginfri Unibet-pris minus ~2-3 %) - ikke en ekte odds. Her måler vi derfor
// treffprosent og estimert avkastning, aldri ekte avkastning.
const COMBO_HISTORY_PATH = path.join(__dirname, '..', 'data', 'combo-history.json');
// Antall uavgjorte i begge lags siste (opptil) 5 kamper; null hvis formdata mangler.
function drawsInForm(f) {
  if (!Array.isArray(f.formH) || !Array.isArray(f.formA) || f.formH.length < 4 || f.formA.length < 4) return null;
  return [...f.formH, ...f.formA].filter((m) => m.r === 'D').length;
}

function appendComboHistory(day) {
  const log = fs.existsSync(COMBO_HISTORY_PATH) ? JSON.parse(fs.readFileSync(COMBO_HISTORY_PATH, 'utf8')) : [];
  for (const f of day.fixtures) {
    const c = f.comboPick;
    if (!c || c.hit == null) continue;
    log.push({
      date: day.date, match: f.label, pick: c.label, bb: c.bb,
      p: c.p, estOdds: +c.estBB.toFixed(2), fair: +c.fairMarket.toFixed(2), edge: +(c.edge ?? 0).toFixed(3), hit: c.hit,
      reserve: c.reserve || undefined, // reservespill (ingen kombi passerte de vanlige kravene)
      // Til fremtidig test (ikke brukt i valget): lite-uavgjort-hypotesen (<=1 uavgjort i lagenes siste 5+5)
      // og treff for alle linjer/12-spill, så de kan evalueres på nye kamper.
      score: f.result ? `${f.result.home}-${f.result.away}` : null,
      draws10: drawsInForm(f),
      alts: (f.comboAlts || []).filter((a) => a.hit != null).map((a) => ({ key: a.key, p: +a.p.toFixed(3), fair: +a.fairMarket.toFixed(2), hit: a.hit })),
    });
  }
  fs.writeFileSync(COMBO_HISTORY_PATH, JSON.stringify(log, null, 2));
}

// Logg over kombikuponger (alle ben må treffe). estOdds er estimert BB-pris, ikke ekte odds.
const COUPON_HISTORY_PATH = path.join(__dirname, '..', 'data', 'coupon-history.json');
function appendCouponHistory(day) {
  const log = fs.existsSync(COUPON_HISTORY_PATH) ? JSON.parse(fs.readFileSync(COUPON_HISTORY_PATH, 'utf8')) : [];
  const push = (kind, slot, cp) => {
    if (!cp || cp.single || cp.hit == null) return;
    log.push({
      date: day.date, kind, slot, legs: cp.legs.length, p: cp.p, estOdds: +cp.estOdds.toFixed(2), hit: cp.hit,
      picks: cp.legs.map((l) => `${l.match}: ${l.bb}`),
    });
  };
  if (day.coupon) {
    (day.coupon.kombikuponger || []).forEach((cp) => push('slot', cp.slot, cp));
    push('dagens', 'dagens', day.coupon.dagensKombi);
  }
  fs.writeFileSync(COUPON_HISTORY_PATH, JSON.stringify(log, null, 2));
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
