// lib/poisson.js
// Poisson-motoren. Tar to forventede mål-tall (lambda) og regner
// ut markedssannsynligheter, med en Dixon-Coles-korreksjon på lave resultater.
// Brukes av lib/combos.js til å tilpasse forventede mål til markedets priser (fitLambdasToMarket)
// og regne felles sannsynlighet for resultat OG mål (jointProb).

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

// --- Kombispill: resultat/dobbel sjanse + mål i SAMME kamp -------------------
// Resultatsiden bruker bookmakernes egen notasjon (1, 2, 1X, X2, 12).
const RESULT_CONDITIONS = {
  '1': (h, a) => h > a,
  '2': (h, a) => h < a,
  '1X': (h, a) => h >= a,
  'X2': (h, a) => h <= a,
  '12': (h, a) => h !== a,
};

/**
 * Felles sannsynlighet for at resultatet (`result`) OG målsummen (over/under `line`)
 * inntreffer samtidig - summert over den Dixon-Coles-korrigerte matrisen, ikke to
 * sannsynligheter ganget sammen (de henger sammen).
 * @param {string} result  '1' | '2' | '1X' | 'X2' | '12'
 * @param {number} line    f.eks. 1.5 / 2.5 / 3.5 / 4.5
 * @param {boolean} over   true = over linja, false = under
 */
function jointProb(lambdaH, lambdaA, result, line, over) {
  const MAX = 12; // 4,5-linja trenger litt mer enn 10 for å bli presis
  const cond = RESULT_CONDITIONS[result];
  let total = 0, hit = 0;
  for (let h = 0; h <= MAX; h++) {
    for (let a = 0; a <= MAX; a++) {
      const p = poisson(h, lambdaH) * poisson(a, lambdaA) * tau(h, a, lambdaH, lambdaA, RHO);
      total += p;
      const g = h + a;
      if (cond(h, a) && (over ? g > line : g < line)) hit += p;
    }
  }
  return hit / total;
}

/**
 * Finner forventet mål (lambda) som best forklarer et MARKEDS priser: 1X2 (marginfri
 * sannsynlighet) + én over/under-linje. Brukes til å få et markedsbasert estimat av
 * kombipriser (bookmakere som BB Gold prissetter kombiene tett på dette).
 * Grovsøk + finsøk, kun ren matematikk. Returnerer null hvis linja ikke støttes.
 * @param {number} line    1.5 | 2.5 | 3.5 | 4.5
 * @param {number} pOver   marginfri sannsynlighet for over linja
 * @returns {object|null} { lambdaH, lambdaA, err }  (err = RMS-avvik mot markedet)
 */
function fitLambdasToMarket(pH, pD, pA, line, pOver) {
  const key = { 1.5: 'o15', 2.5: 'o25', 3.5: 'o35', 4.5: 'o45' }[line];
  if (!key) return null;
  const err = (lh, la) => {
    const m = modelMarkets(lh, la);
    return (m.pHome - pH) ** 2 + (m.pDraw - pD) ** 2 + (m.pAway - pA) ** 2 + (m[key] - pOver) ** 2;
  };
  let best = { e: Infinity, lh: 1.4, la: 1.1 };
  const scan = (h0, h1, a0, a1, step) => {
    for (let lh = h0; lh <= h1; lh += step) {
      for (let la = a0; la <= a1; la += step) {
        if (lh < 0.1 || la < 0.1) continue;
        const e = err(lh, la);
        if (e < best.e) best = { e, lh, la };
      }
    }
  };
  scan(0.2, 4.5, 0.2, 3.5, 0.1);
  scan(best.lh - 0.1, best.lh + 0.1, best.la - 0.1, best.la + 0.1, 0.01);
  return { lambdaH: best.lh, lambdaA: best.la, err: Math.sqrt(best.e / 4) };
}

module.exports = { poisson, modelMarkets, RESULT_CONDITIONS, jointProb, fitLambdasToMarket };
