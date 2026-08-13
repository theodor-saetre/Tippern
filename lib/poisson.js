// lib/poisson.js
// Poisson-motoren. Tar to forventede mål-tall (lambda) og regner
// ut markedssannsynligheter. Uendret fra prototypen — den er ferdig.

function factorial(n) {
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

function poisson(k, lambda) {
  return (Math.pow(lambda, k) * Math.exp(-lambda)) / factorial(k);
}

/**
 * Bygger full resultatmatrise opp til MAX-MAX mål og summerer markeder.
 * @param {number} lambdaH forventet mål hjemmelag
 * @param {number} lambdaA forventet mål bortelag
 * @returns {object} sannsynligheter for hvert marked (0..1)
 */
function modelMarkets(lambdaH, lambdaA) {
  const MAX = 10;
  let pHome = 0, pDraw = 0, pAway = 0;
  let o15 = 0, o25 = 0, o35 = 0, o45 = 0, btts = 0;

  for (let h = 0; h <= MAX; h++) {
    for (let a = 0; a <= MAX; a++) {
      const p = poisson(h, lambdaH) * poisson(a, lambdaA);
      if (h > a) pHome += p;
      else if (h === a) pDraw += p;
      else pAway += p;

      const total = h + a;
      if (total >= 2) o15 += p;
      if (total >= 3) o25 += p;
      if (total >= 4) o35 += p;
      if (total >= 5) o45 += p;
      if (h >= 1 && a >= 1) btts += p;
    }
  }

  return {
    pHome, pDraw, pAway,
    dcHD: pHome + pDraw,   // double chance: hjemme eller uavgjort
    dcAD: pAway + pDraw,   // double chance: borte eller uavgjort
    dcHA: pHome + pAway,   // double chance: hjemme eller borte
    o15, o25, o35, o45,
    u15: 1 - o15, u25: 1 - o25, u35: 1 - o35, u45: 1 - o45,
    btts, noBtts: 1 - btts,
  };
}

// Hjelpere
const fairOdds = (p) => (p > 0 ? 1 / p : null);
const impliedProb = (odds) => (odds > 0 ? 1 / odds : null);

module.exports = { poisson, modelMarkets, fairOdds, impliedProb };
