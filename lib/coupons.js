// lib/coupons.js
// Kombikuponger (akkumulator over flere kamper) bygget av kampenes beste kombispill (lib/combos.js).
//
//  - kombikuponger: kamper som starter nær hverandre samles til én kupong pr avspark-tid
//    (f.eks. 13:30 / 16:00 / 18:30), maks 4 ben. Færre enn 2 kamper i en tid = ingen kupong.
//  - dagensKombi: de 3-4 kampene på tvers av dagen der treffsjanse og pris samlet er best
//    Hvert ben må ha minst 65 % treffsjanse; blant dem rangeres kampene etter forventet verdi
//    (treffsjanse x estimert BB-pris - 1), slik at både sannsynlighet og pris teller.
//
// ÆRLIG OM MATTE: sannsynligheten for en kupong er produktet av benas sannsynlighet (ulike
// kamper er omtrent uavhengige), og prisen er produktet av prisene - men dermed også av
// marginene. Fire ben á 70 % gir ~24 % treff, og marginen på 2-3 % pr ben blir ~10 % samlet.
// Kuponger gir høyere gevinst, ikke bedre forventet avkastning enn enkeltkombiene.

const SLOT_GAP_MIN = 100; // kamper med mer enn 100 min mellom avspark havner i hver sin kupong
const MAX_LEGS = 4;
const MIN_LEGS = 2;
const MIN_DAGENS_LEGS = 3;
const DAGENS_ODDS = [3.0, 4.0]; // Dagens kupong: ønsket samlet (estimert) pris
const DAGENS_MIN_P = 0.65; // Dagens kupong: hvert ben skal ha minst 65 % treffsjanse (høy treffprosent)

const osloTime = (iso) => new Date(iso).toLocaleTimeString('nb-NO', { timeZone: 'Europe/Oslo', hour: '2-digit', minute: '2-digit' });
const ev = (c) => c.p * c.estBB - 1;

function toLeg(f, c) {
  return {
    match: f.label, home: f.homeName, away: f.awayName, kickoff: f.kickoff,
    key: c.key, result: c.result, line: c.line, over: c.over,
    label: c.label, bb: c.bb, p: c.p, estBB: c.estBB, fair: c.fairMarket,
  };
}

function toCoupon(legs, extra = {}) {
  const p = legs.reduce((x, l) => x * l.p, 1);
  const estOdds = legs.reduce((x, l) => x * l.estBB, 1);
  return { ...extra, legs, p, estOdds, ev: p * estOdds - 1 };
}

/**
 * @param {Array} fixtures  fixtures med comboPick/combos (fra fetch-odds.js) og kickoff
 * @returns {object} { kombikuponger: [...], dagensKombi: {...}|null }
 */
function buildCoupons(fixtures) {
  const withCombo = fixtures
    .filter((f) => f.comboPick && !f.comboPick.reserve && f.combos && f.combos.length) // reservespill er ikke med i kuponger
    .sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff));

  // --- Kombikuponger pr avspark-tid ---
  const clusters = [];
  for (const f of withCombo) {
    const last = clusters[clusters.length - 1];
    const gap = last ? (new Date(f.kickoff) - new Date(last[last.length - 1].kickoff)) / 60000 : Infinity;
    if (last && gap <= SLOT_GAP_MIN) last.push(f); else clusters.push([f]);
  }
  const kombikuponger = clusters.map((cl) => {
    const slot = osloTime(cl[0].kickoff);
    if (cl.length < MIN_LEGS) {
      return { slot, single: true, legs: [toLeg(cl[0], cl[0].comboPick)] }; // bare én kamp: spill singelen
    }
    // Høyest treffsjanse først (kuponger skal treffe), maks MAX_LEGS ben
    const best = [...cl].sort((a, b) => b.comboPick.p - a.comboPick.p).slice(0, MAX_LEGS)
      .sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff));
    return toCoupon(best.map((f) => toLeg(f, f.comboPick)), { slot, skipped: cl.length - best.length });
  });

  // --- Dagens kupong: best forventet verdi (treffsjanse x pris) på tvers av dagen ---
  // Benet er ALLTID kampens hovedspill (samme som på kortet) - aldri et annet alternativ i kampen.
  // Rangert etter treffsjanse: kupongen skal treffe, og prisen følger av valgene.
  // Valgt kombinasjon: 3-4 ben (en pr kamp) med samlet estimert pris i vinduet DAGENS_ODDS (ca. 3-4),
  // og blant dem den med HØYEST samlet treffsjanse. Finnes ingen i vinduet, tas den nærmeste.
  const cands = withCombo
    .filter((f) => f.comboPick.p >= DAGENS_MIN_P)
    .map((f) => ({ f, c: f.comboPick }));
  const combosOf = (arr, k, start = 0, cur = []) => {
    if (cur.length === k) return [cur];
    const out = [];
    for (let i = start; i < arr.length; i++) out.push(...combosOf(arr, k, i + 1, [...cur, arr[i]]));
    return out;
  };
  const all = [];
  for (let k = MIN_DAGENS_LEGS; k <= MAX_LEGS; k++) {
    for (const set of combosOf(cands, k)) {
      const p = set.reduce((x, s) => x * s.c.p, 1), odds = set.reduce((x, s) => x * s.c.estBB, 1);
      const dist = odds < DAGENS_ODDS[0] ? DAGENS_ODDS[0] - odds : odds > DAGENS_ODDS[1] ? odds - DAGENS_ODDS[1] : 0;
      all.push({ set, p, odds, dist });
    }
  }
  all.sort((a, b) => a.dist - b.dist || b.p - a.p);
  const best = all[0];
  const dagensKombi = best
    ? toCoupon(best.set.map(({ f, c }) => toLeg(f, c)).sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff)))
    : null;

  return { kombikuponger, dagensKombi };
}

module.exports = { buildCoupons };
