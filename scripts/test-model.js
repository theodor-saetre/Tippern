// scripts/test-model.js
// Rask røyktest av modellen med eksempeldata — INGEN API-nøkkel nødvendig.
// Kjør:  node scripts/test-model.js
// Bekrefter at ratings + Poisson + kupong henger sammen og gir fornuftige tall.

const { expectedGoals } = require('../lib/ratings');
const { modelMarkets, fairOdds } = require('../lib/poisson');
const { buildCoupon } = require('../lib/coupon');

// Eksempel-form (eldst → nyest): { gf, ga, venue }
const LIV = [
  {gf:3,ga:1,venue:'A'},{gf:2,ga:0,venue:'H'},{gf:1,ga:1,venue:'A'},{gf:4,ga:1,venue:'H'},{gf:0,ga:1,venue:'A'},
  {gf:2,ga:0,venue:'H'},{gf:3,ga:1,venue:'A'},{gf:2,ga:2,venue:'H'},{gf:2,ga:0,venue:'A'},{gf:3,ga:0,venue:'H'},
];
const MCI = [
  {gf:2,ga:0,venue:'H'},{gf:3,ga:1,venue:'A'},{gf:2,ga:0,venue:'H'},{gf:1,ga:1,venue:'A'},{gf:4,ga:0,venue:'H'},
  {gf:2,ga:1,venue:'A'},{gf:1,ga:2,venue:'A'},{gf:3,ga:0,venue:'H'},{gf:2,ga:0,venue:'H'},{gf:2,ga:2,venue:'A'},
];
const HUL = [
  {gf:0,ga:2,venue:'A'},{gf:1,ga:3,venue:'H'},{gf:1,ga:1,venue:'A'},{gf:0,ga:2,venue:'H'},{gf:2,ga:1,venue:'H'},
  {gf:1,ga:2,venue:'A'},{gf:0,ga:0,venue:'H'},{gf:1,ga:4,venue:'A'},{gf:0,ga:2,venue:'A'},{gf:2,ga:0,venue:'H'},
];

function run(homeName, homeForm, awayName, awayForm) {
  const eg = expectedGoals(homeForm, awayForm);
  const m = modelMarkets(eg.lambdaH, eg.lambdaA);
  console.log(`\n${homeName} (H) vs ${awayName} (A)`);
  console.log(`  forventet mål: ${eg.lambdaH.toFixed(2)} – ${eg.lambdaA.toFixed(2)}`);
  console.log(`  DC ${homeName}/uavgjort: ${(m.dcHD*100).toFixed(0)}%  (fair ${fairOdds(m.dcHD).toFixed(2)})`);
  console.log(`  Over 2,5: ${(m.o25*100).toFixed(0)}%  |  BTTS: ${(m.btts*100).toFixed(0)}%`);
  return { eg, m };
}

console.log('=== MODELL-RØYKTEST ===');
const a = run('Liverpool', LIV, 'Man City', MCI);
const b = run('Liverpool', LIV, 'Hull', HUL);

// Sjekk 1: Liverpool skal ha høyere forventet mål mot Hull enn mot City
console.log('\n--- Sjekker ---');
console.log(`Liverpool xG mot City: ${a.eg.lambdaH.toFixed(2)}, mot Hull: ${b.eg.lambdaH.toFixed(2)}`);
if (b.eg.lambdaH > a.eg.lambdaH) console.log('✓ Motstandsjustering funker (mer mål forventet mot svakere lag)');
else { console.error('✗ FEIL: forventet mål burde vært høyere mot Hull'); process.exit(1); }

// Sjekk 2: kupong bygges og Dagens spill lander i vinduet
const fixtures = [
  { label:'LIV–MCI', homeName:'Liverpool', awayName:'Man City', markets:a.m },
  { label:'LIV–HUL', homeName:'Liverpool', awayName:'Hull', markets:b.m },
];
const c = buildCoupon(fixtures);
if (c.dagensSpill) {
  const o = c.dagensSpill.odds;
  console.log(`Dagens spill: ${c.dagensSpill.pick} (${c.dagensSpill.match}) @ fair ${o.toFixed(2)}`);
  if (o >= 1.70 && o <= 2.50) console.log('✓ Dagens spill er i odds-vinduet 1,70–2,50');
  else { console.error('✗ FEIL: utenfor vinduet'); process.exit(1); }
} else {
  console.log('(Ingen kamp i vinduet i denne lille testen — det er greit med bare 2 kamper)');
}

console.log(`The Gambler: ${c.gambler.legs.length} bein, samlet odds ${c.gambler.combinedOdds.toFixed(1)}, ekte sjanse ${(c.gambler.combinedProb*100).toFixed(0)}% (1 av ${c.gambler.hitRate})`);
console.log('\n✓ Alle kjernedeler kjører.');
