// lib/poisson.js
// Poisson-motoren. Tar to forventede mål-tall (lambda) og regner
// ut markedssannsynligheter, med en Dixon-Coles-korreksjon på lave resultater.

function factorial(n) {
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

function poisson(k, lambda) {
  return (Math.pow(lambda, k) * Math.exp(-lambda)) / factorial(k);
}

// Dixon-Coles-korreksjon (Dixon & Coles, 1997): ren Poisson antar at hjemme- og
// bortemål er helt uavhengige, som undervurderer 0-0/1-1 og overvurderer 1-0/0-1.
// τ justerer kun disse fire resultatene - alt annet i matrisen er urørt.
// ρ = -0,13 er standardverdien fra originalpapiret.
const RHO = -0.13;
function tau(x, y, lambda, mu, rho) {
  if (x === 0 && y === 0) return 1 - lambda * mu * rho;
  if (x === 0 && y === 1) return 1 + lambda * rho;
  if (x === 1 && y === 0) return 1 + mu * rho;
  if (x === 1 && y === 1) return 1 - rho;
  return 1;
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
  let totalP = 0;

  for (let h = 0; h <= MAX; h++) {
    for (let a = 0; a <= MAX; a++) {
      const p = poisson(h, lambdaH) * poisson(a, lambdaA) * tau(h, a, lambdaH, lambdaA, RHO);
      totalP += p;
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

  // τ flytter litt sannsynlighetsmasse rundt - renormaliser så alt fortsatt
  // summerer riktig (samme praksis som i Dixon-Coles-originalpapiret).
  pHome /= totalP; pDraw /= totalP; pAway /= totalP;
  o15 /= totalP; o25 /= totalP; o35 /= totalP; o45 /= totalP; btts /= totalP;

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

// Betingelser for de vanligste "samme kamp"-kombinasjonene (dobbel sjanse
// kombinert med totalt/BTTS). h = hjemme mål, a = borte mål.
const COMBO_CONDITIONS = {
  dcHD_o15: (h, a) => h >= a && h + a >= 2,
  dcHD_o25: (h, a) => h >= a && h + a >= 3,
  dcHD_btts: (h, a) => h >= a && h >= 1 && a >= 1,
  dcAD_o15: (h, a) => h <= a && h + a >= 2,
  dcAD_o25: (h, a) => h <= a && h + a >= 3,
  dcAD_btts: (h, a) => h <= a && h >= 1 && a >= 1,
};

/**
 * Sannsynligheten for at TO markeder inntreffer SAMTIDIG i samme kamp, regnet
 * riktig ved å summere cellene i den Dixon-Coles-korrigerte resultatmatrisen
 * der begge betingelser er sanne - IKKE ved å multiplisere de to enkelt-
 * sannsynlighetene (som ville anta at markedene er uavhengige, noe de ikke er:
 * f.eks. henger "hjemme vinner" og "over 1,5 mål" tydelig sammen).
 * @returns {object} sannsynlighet (0..1) for hver kombinasjon i COMBO_CONDITIONS
 */
function comboMarkets(lambdaH, lambdaA) {
  const MAX = 10;
  const sums = {}, totalP = { v: 0 };
  for (const key of Object.keys(COMBO_CONDITIONS)) sums[key] = 0;

  for (let h = 0; h <= MAX; h++) {
    for (let a = 0; a <= MAX; a++) {
      const p = poisson(h, lambdaH) * poisson(a, lambdaA) * tau(h, a, lambdaH, lambdaA, RHO);
      totalP.v += p;
      for (const [key, cond] of Object.entries(COMBO_CONDITIONS)) {
        if (cond(h, a)) sums[key] += p;
      }
    }
  }

  const out = {};
  for (const key of Object.keys(COMBO_CONDITIONS)) out[key] = sums[key] / totalP.v;
  return out;
}

// Hjelpere
const fairOdds = (p) => (p > 0 ? 1 / p : null);
const impliedProb = (odds) => (odds > 0 ? 1 / odds : null);

module.exports = { poisson, modelMarkets, comboMarkets, fairOdds, impliedProb };
