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

const KEY = process.env.ODDS_API_KEY;
const MODE = process.env.ODDS_MODE === 'morning' ? 'morning' : 'prekickoff';
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
    if (MODE === 'morning') return !f.odds;
    const mins = (new Date(f.kickoff).getTime() - now) / 60000;
    return mins <= LEAD_MINUTES && mins >= MIN_MINUTES && !f.oddsLocked;
  });

  if (due.length === 0) {
    console.log(MODE === 'morning' ? 'Alle kamper har allerede odds.' : 'Ingen kamper i odds-vinduet akkurat nå.');
    return;
  }

  // Hent odds pr liga som har kamper i vinduet (samler kall → færre requests)
  const compsNeeded = [...new Set(due.map((f) => f.competition))];
  for (const comp of compsNeeded) {
    const sport = SPORT_KEYS[comp];
    const url = `https://api.the-odds-api.com/v4/sports/${sport}/odds/?regions=eu&markets=h2h,totals&oddsFormat=decimal&apiKey=${KEY}`;
    const res = await fetch(url);
    if (!res.ok) { console.error(`Odds ${res.status} for ${comp}`); continue; }
    const events = await res.json();

    // TODO: match hvert 'event' mot riktig fixture (på lagnavn/tid) og plukk
    // beste odds for markedene dine (double chance kan avledes, totals gir over/under).
    // Behold forrige odds i f.oddsHistory for å vise bevegelse.
    for (const f of due) {
      const ev = matchEvent(events, f);
      if (!ev) continue;
      const fresh = extractOdds(ev); // { dcHD, o25, u35, ... }
      f.oddsHistory = f.oddsHistory || [];
      if (f.odds) f.oddsHistory.push({ at: db.oddsUpdatedAt, odds: f.odds });
      f.odds = fresh;
      // Bare den siste, ferske hentingen rett før avspark låser kampen — morgen-
      // hentingen skal ikke hindre prekickoff-jobben i å oppdatere den senere.
      if (MODE !== 'morning') f.oddsLocked = true;
    }
  }

  // "Dagens spill" fra build-model.js er valgt ut fra modellens EGEN rimelige odds
  // (sirkulært — forteller ingenting om ekte verdi). Nå som vi har ferske bookmaker-
  // odds, plukker vi heller det beste spillet basert på EKTE priser i vinduet.
  recomputeDagensSpillFromLiveOdds(db);

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

// Markedsnøkkel → hvordan lage samme lesbare tekst som lib/coupon.js bruker,
// og hvilket felt i f.markets som har modellens sannsynlighet for det spillet.
const DAGENS_SPILL_MARKETS = {
  dcHD: (f) => ({ pick: `${f.homeName} eller uavgjort`, market: 'Double chance' }),
  dcAD: (f) => ({ pick: `${f.awayName} eller uavgjort`, market: 'Double chance' }),
  o15:  () => ({ pick: 'Over 1,5 mål', market: 'Totalt' }),
  o25:  () => ({ pick: 'Over 2,5 mål', market: 'Totalt' }),
  u35:  () => ({ pick: 'Under 3,5 mål', market: 'Totalt' }),
  u45:  () => ({ pick: 'Under 4,5 mål', market: 'Totalt' }),
};

// Plukker beste spill i odds-vinduet 1,70-2,50 basert på EKTE, hentede bookmakerodds
// (ikke modellens egne). Lar forrige (modell-baserte) forslag stå urørt hvis ingen
// kamper med ferske odds havner i vinduet ennå.
function recomputeDagensSpillFromLiveOdds(db) {
  const candidates = [];
  for (const f of db.fixtures) {
    if (!f.odds) continue;
    for (const key of Object.keys(DAGENS_SPILL_MARKETS)) {
      const odds = f.odds[key];
      if (odds == null || odds < 1.70 || odds > 2.50) continue;
      const p = f.markets[key];
      candidates.push({ match: f.label, ...DAGENS_SPILL_MARKETS[key](f), p, odds, liveOdds: true });
    }
  }
  if (candidates.length === 0) return;
  candidates.sort((a, b) => b.p - a.p);
  db.coupon = db.coupon || {};
  db.coupon.dagensSpill = candidates[0];
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

function extractOdds(ev) {
  let bestHome = null, bestDraw = null, bestAway = null;
  const totals = {}; // point (f.eks. 2.5) -> { over, under }

  for (const bk of ev.bookmakers || []) {
    for (const mkt of bk.markets || []) {
      if (mkt.key === 'h2h') {
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
      }
    }
  }

  // Double chance finnes ikke som eget marked hos The Odds API — avled fra h2h
  // ved å summere implisitt sannsynlighet for de to utfallene.
  const dc = (a, b) => (a && b ? +(1 / (1 / a + 1 / b)).toFixed(2) : null);
  const line = (point) => totals[point] || {};

  return {
    dcHD: dc(bestHome, bestDraw),
    dcAD: dc(bestAway, bestDraw),
    o15: line(1.5).over ?? null,
    o25: line(2.5).over ?? null,
    u35: line(3.5).under ?? null,
    u45: line(4.5).under ?? null,
  };
}

main().catch((e) => { console.error(e); process.exit(1); });
