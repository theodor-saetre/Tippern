// scripts/build-model.js
// Daglig jobb: henter dagens kamper (football-data.org) + lagenes siste 5 kamper (form),
// og skriver data/today.json. INGEN egen modell: sannsynligheter og spill bygges av markedspriser i
// scripts/fetch-odds.js (lib/combos.js). Formen brukes bare som informasjon (og "få uavgjort"-merket).
//
// Kjør lokalt med:  FOOTBALL_DATA_KEY=xxx node scripts/build-model.js

const fs = require('fs');
const path = require('path');

const API = 'https://api.football-data.org/v4';
const KEY = process.env.FOOTBALL_DATA_KEY;

// Ligaene vi følger (football-data competition codes): Premier League, La Liga, Champions League
const COMPETITIONS = ['PL', 'PD', 'CL'];

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

// Siste ~10 ferdigspilte kamper for et lag, på tvers av alle turneringer (eldst → nyest).
async function getTeamForm(teamId) {
  // Uten dateFrom/dateTo når endpointet ikke tilbake til forrige sesong i sommerpausen,
  // så vi går ~9 måneder tilbake.
  const dateTo = new Date().toISOString().slice(0, 10);
  const dateFrom = new Date(Date.now() - 270 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const data = await fdFetch(`/teams/${teamId}/matches?status=FINISHED&dateFrom=${dateFrom}&dateTo=${dateTo}&limit=10`);
  return data.matches
    .map((mt) => {
      const isHome = mt.homeTeam.id === teamId;
      return {
        gf: isHome ? mt.score.fullTime.home : mt.score.fullTime.away,
        ga: isHome ? mt.score.fullTime.away : mt.score.fullTime.home,
        venue: isHome ? 'H' : 'A',
        date: mt.utcDate,
      };
    })
    .sort((a, b) => new Date(a.date) - new Date(b.date));
}

// Siste 5 kamper som W/D/L-kuler (informasjon på kortene, og "få uavgjort"-merket)
function recentForm(form) {
  return form.slice(-5).map((m) => ({
    r: m.gf > m.ga ? 'W' : m.gf < m.ga ? 'L' : 'D',
    gf: m.gf, ga: m.ga, venue: m.venue,
  }));
}

async function main() {
  if (!KEY) throw new Error('Mangler FOOTBALL_DATA_KEY');

  const today = new Date().toISOString().slice(0, 10);
  const fixtures = [];
  const formCache = new Map(); // teamId -> form (et lag kan opptre flere ganger i vinduet)
  async function cachedTeamForm(teamId) {
    if (!formCache.has(teamId)) {
      try { formCache.set(teamId, await getTeamForm(teamId)); }
      catch (e) { console.warn(`Form mangler for lag ${teamId} (${e.message})`); formCache.set(teamId, []); }
    }
    return formCache.get(teamId);
  }

  // Kamper i dag → 21 dager frem for hver liga (ETT kall pr liga). Er det ingen kamper i dag,
  // vises neste dato med kamper, så siden aldri står tom.
  const lookaheadTo = new Date(Date.now() + 21 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const byComp = new Map();
  const allDates = [];
  for (const comp of COMPETITIONS) {
    const data = await fdFetch(`/competitions/${comp}/matches?dateFrom=${today}&dateTo=${lookaheadTo}`);
    byComp.set(comp, data.matches);
    data.matches.forEach((mt) => allDates.push(mt.utcDate.slice(0, 10)));
  }
  const matchDate = allDates.length ? allDates.sort()[0] : today; // nærmeste dato med kamper

  for (const comp of COMPETITIONS) {
    for (const mt of byComp.get(comp).filter((m) => m.utcDate.slice(0, 10) === matchDate)) {
      const home = await cachedTeamForm(mt.homeTeam.id);
      const away = await cachedTeamForm(mt.awayTeam.id);
      fixtures.push({
        id: mt.id,
        label: `${mt.homeTeam.tla}–${mt.awayTeam.tla}`,
        // Fullt lagnavn, så det er umulig å ta feil av hvilken kamp spillet gjelder
        homeName: mt.homeTeam.name || mt.homeTeam.shortName || mt.homeTeam.tla,
        awayName: mt.awayTeam.name || mt.awayTeam.shortName || mt.awayTeam.tla,
        kickoff: mt.utcDate,
        competition: comp,
        formH: recentForm(home),
        formA: recentForm(away),
        odds: null, // fylles av fetch-odds.js
      });
    }
  }

  // `date` er datoen kampene faktisk spilles (kan være frem i tid) — check-results.js bruker den.
  // coupon fylles av fetch-odds.js (kombikuponger + Dagens kupong).
  const out = { generatedAt: new Date().toISOString(), date: matchDate, fixtures, coupon: {} };

  fs.writeFileSync(path.join(__dirname, '..', 'data', 'today.json'), JSON.stringify(out, null, 2));

  // Permanent arkiv: oppdateres fram til kampdagen, aldri overskrevet av en annen dags kjøring.
  const archiveDir = path.join(__dirname, '..', 'data', 'archive');
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.writeFileSync(path.join(archiveDir, `${matchDate}.json`), JSON.stringify(out, null, 2));

  console.log(`Skrev ${fixtures.length} kamper for ${matchDate} til data/today.json (+ arkiv)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
