// lib/coupon.js
// Bygger "Dagens spill" og "The Gambler" fra modellens markeder på tvers av kamper.
// Ærlige tall: Dagens spill i odds-vindu 1,70–2,50, Gambler viser ekte samlet sjanse.

const { fairOdds } = require('./poisson');

/**
 * @param {Array} fixtures  liste av { label, markets } der markets er output fra modelMarkets
 * @returns {object} { dagensSpill, gambler }
 */
function buildCoupon(fixtures) {
  const candidates = [];
  const spicy = [];

  fixtures.forEach((f) => {
    const m = f.markets;
    const L = f.label;
    // trygge markeder (typen brukeren spiller)
    candidates.push({ match: L, pick: `${f.homeName} eller uavgjort`, market: 'Double chance', p: m.dcHD });
    candidates.push({ match: L, pick: `${f.awayName} eller uavgjort`, market: 'Double chance', p: m.dcAD });
    candidates.push({ match: L, pick: 'Over 1,5 mål', market: 'Totalt', p: m.o15 });
    candidates.push({ match: L, pick: 'Over 2,5 mål', market: 'Totalt', p: m.o25 });
    candidates.push({ match: L, pick: 'Under 3,5 mål', market: 'Totalt', p: m.u35 });
    candidates.push({ match: L, pick: 'Under 4,5 mål', market: 'Totalt', p: m.u45 });
    candidates.push({ match: L, pick: 'Begge lag scorer', market: 'BTTS', p: m.btts });
    candidates.push({ match: L, pick: `${f.homeName} vinner`, market: 'Full tid', p: m.pHome });
    candidates.push({ match: L, pick: `${f.awayName} vinner`, market: 'Full tid', p: m.pAway });
    // krydder for The Gambler
    spicy.push({ match: L, pick: `${f.homeName} vinner`, market: 'Full tid', p: m.pHome });
    spicy.push({ match: L, pick: 'Over 3,5 mål', market: 'Totalt', p: m.o35 });
    spicy.push({ match: L, pick: 'Begge lag scorer', market: 'BTTS', p: m.btts });
  });

  // ---- DAGENS SPILL: beste spill med rimelig odds i 1,70–2,50 ----
  const windowPicks = candidates
    .map((c) => ({ ...c, odds: fairOdds(c.p) }))
    .filter((c) => c.odds >= 1.70 && c.odds <= 2.50)
    .sort((a, b) => b.p - a.p);
  const dagensSpill = windowPicks[0] || null;

  // ---- THE GAMBLER: gøy 10+ combo, ærlig samlet sjanse ----
  const pool = spicy.filter((x) => x.p > 0.20 && x.p < 0.62).sort((a, b) => b.p - a.p);
  let legs = [], combP = 1, combO = 1;
  for (const leg of pool) {
    legs.push(leg); combP *= leg.p; combO /= leg.p;
    if (combO >= 10) break;
  }
  if (combO < 10) {
    for (const leg of [...spicy].sort((a, b) => a.p - b.p)) {
      if (legs.includes(leg)) continue;
      legs.push(leg); combP *= leg.p; combO /= leg.p;
      if (combO >= 10) break;
    }
  }
  const gambler = {
    legs: legs.map((l) => ({ ...l, odds: fairOdds(l.p) })),
    combinedOdds: combO,
    combinedProb: combP,
    hitRate: combP > 0 ? Math.round(1 / combP) : null,
  };

  return { dagensSpill, gambler };
}

module.exports = { buildCoupon };
