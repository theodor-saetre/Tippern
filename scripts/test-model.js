// scripts/test-model.js
// Rask røyktest av kjernen med eksempeldata — INGEN API-nøkkel nødvendig.
// Kjør:  node scripts/test-model.js
// Bekrefter at Poisson-tilpasningen mot markedspriser, kombiene og kupongene henger sammen.

const { modelMarkets, jointProb, fitLambdasToMarket } = require('../lib/poisson');
const { buildCombos, comboHit } = require('../lib/combos');
const { buildCoupons } = require('../lib/coupons');

const fail = (msg) => { console.error('✗ FEIL: ' + msg); process.exit(1); };
const ok = (msg) => console.log('✓ ' + msg);

console.log('=== RØYKTEST ===');

// 1) Tilpasning mot markedet: kjente lambda inn -> priser -> tilbake til samme lambda
const m = modelMarkets(1.8, 1.0);
const fit = fitLambdasToMarket(m.pHome, m.pDraw, m.pAway, 2.5, m.o25);
if (!fit || Math.abs(fit.lambdaH - 1.8) > 0.05 || Math.abs(fit.lambdaA - 1.0) > 0.05) fail(`tilpasning ga ${fit && fit.lambdaH.toFixed(2)}–${fit && fit.lambdaA.toFixed(2)}, ventet 1,80–1,00`);
ok(`markedstilpasning gjenfinner forventede mål (${fit.lambdaH.toFixed(2)}–${fit.lambdaA.toFixed(2)})`);

// 2) Felles sannsynlighet: 1X + over 1,5 kan ikke være større enn hver del alene
const j = jointProb(1.8, 1.0, '1X', 1.5, true);
if (!(j > 0 && j <= m.dcHD && j <= m.o15)) fail('felles sannsynlighet er ikke konsistent med delene');
ok(`1X + over 1,5 = ${(j * 100).toFixed(0)}% (≤ 1X ${(m.dcHD * 100).toFixed(0)}%, ≤ over 1,5 ${(m.o15 * 100).toFixed(0)}%)`);

// 3) Kombier fra markedspriser (Unibet-format som fetch-odds.js leverer)
const fx = (label, h, a, ko, pH, pD, pA, over, under) => ({
  label, competition: 'PL', homeName: h, awayName: a, kickoff: ko,
  oddsUnibet: { bookmaker: 'test', odds: { pHome: pH, pDraw: pD, pAway: pA }, totals: { line: 2.5, over, under } },
});
const fixtures = [
  fx('A–B', 'A', 'B', '2026-11-21T15:00:00Z', 1.40, 5.2, 8.0, 1.62, 2.25),
  fx('C–D', 'C', 'D', '2026-11-21T15:00:00Z', 1.75, 4.0, 4.6, 1.95, 1.85),
  fx('E–F', 'E', 'F', '2026-11-21T15:00:00Z', 2.10, 3.5, 3.6, 2.10, 1.75),
  fx('G–H', 'G', 'H', '2026-11-21T17:30:00Z', 6.0, 4.4, 1.56, 1.68, 2.20),
];
let n = 0;
for (const f of fixtures) {
  const b = buildCombos(f, { leagueBias: { PL: -0.3 } });
  if (!b) fail(`ingen kombier for ${f.label}`);
  f.combos = b.combos; f.comboPick = b.combos[0] || null; f.comboOver = b.over; f.comboUnder = b.under; f.comboAlts = b.alts;
  if (f.comboPick) {
    n++;
    const c = f.comboPick;
    if (!(c.p > 0 && c.p < 1 && c.estBB > 1 && c.pMarket > 0)) fail(`urimelige tall for ${f.label}`);
    console.log(`  ${f.label}: ${c.bb}  ${(c.p * 100).toFixed(0)}%  BB ca. ${c.estBB.toFixed(2)}  (må ha ≥ ${(1.03 / c.pMarket).toFixed(2)})`);
  }
}
if (n === 0) fail('ingen kamp fikk et hovedspill');
ok(`${n} av ${fixtures.length} kamper fikk et hovedspill`);

// 4) Treffsjekk
const pick = fixtures[0].comboPick;
const hitScore = pick.over ? [2, 1] : [1, 0], missScore = [0, 3];
comboHit(pick, ...hitScore); comboHit(pick, ...missScore);
if (comboHit({ result: '1X', line: 1.5, over: true }, 2, 0) !== true || comboHit({ result: '1X', line: 1.5, over: true }, 1, 0) !== false || comboHit({ result: '1X', line: 4.5, over: false }, 0, 1) !== false) fail('comboHit gir feil svar');
ok('comboHit avgjør treff/bom riktig');

// 5) Kuponger
const cp = buildCoupons(fixtures);
if (!cp.kombikuponger.length) fail('ingen kuponger pr avspark-tid');
const dk = cp.dagensKombi;
if (dk) {
  if (dk.legs.length < 3 || dk.legs.length > 4) fail('Dagens kupong skal ha 3-4 ben');
  if (new Set(dk.legs.map((l) => l.match)).size !== dk.legs.length) fail('Dagens kupong har to ben fra samme kamp');
  console.log(`  Dagens kupong: ${dk.legs.length} ben, ${(dk.p * 100).toFixed(0)}%, est. ${dk.estOdds.toFixed(2)}`);
  ok('Dagens kupong har 3-4 ben, ett pr kamp');
} else {
  console.log('  (ingen Dagens kupong i denne lille testen - trenger minst 3 kamper med 65 %+)');
}
ok(`${cp.kombikuponger.length} kuponger pr avspark-tid`);

console.log('\n✓ Alle kjernedeler kjører.');
