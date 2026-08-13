// scripts/fetch-odds.js
// Henter ferske odds ~1 time før avspark for kamper i data/today.json.
// Kun for kamper som nærmer seg → sparer API-kvote. Kjør ofte (se workflow),
// scriptet hopper selv over kamper som ikke er innenfor vinduet ennå.
//
// SKJELETT — fyll inn mapping fra The Odds API-respons til markedene dine.
// Kjør lokalt med:  ODDS_API_KEY=xxx node scripts/fetch-odds.js

const fs = require('fs');
const path = require('path');

const KEY = process.env.ODDS_API_KEY;
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

  // Hvilke kamper er innenfor vinduet akkurat nå?
  const due = db.fixtures.filter((f) => {
    const mins = (new Date(f.kickoff).getTime() - now) / 60000;
    return mins <= LEAD_MINUTES && mins >= MIN_MINUTES && !f.oddsLocked;
  });

  if (due.length === 0) {
    console.log('Ingen kamper i odds-vinduet akkurat nå.');
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
      f.oddsLocked = true; // hentet én gang i vinduet → ikke brenn kvote igjen
    }
  }

  db.oddsUpdatedAt = new Date().toISOString();
  fs.writeFileSync(dataPath, JSON.stringify(db, null, 2));

  // Oppdater samme dags arkivfil, så de ferskeste odds-tallene også blir bevart permanent.
  const archivePath = path.join(__dirname, '..', 'data', 'archive', `${db.date}.json`);
  if (fs.existsSync(archivePath)) {
    fs.writeFileSync(archivePath, JSON.stringify(db, null, 2));
  }

  console.log(`Oppdaterte odds for ${due.length} kamp(er).`);
}

// --- hjelpere ---

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
