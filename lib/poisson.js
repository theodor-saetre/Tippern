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
  dcHD_u35: (h, a) => h >= a && h + a < 4,
  dcHD_u45: (h, a) => h >= a && h + a < 5,
  dcHD_btts: (h, a) => h >= a && h >= 1 && a >= 1,
  dcAD_o15: (h, a) => h <= a && h + a >= 2,
  dcAD_o25: (h, a) => h <= a && h + a >= 3,
  dcAD_u35: (h, a) => h <= a && h + a < 4,
  dcAD_u45: (h, a) => h <= a && h + a < 5,
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

// Samme betingelser som markedene selv (modelMarkets/actualOutcomes) - brukes
// til å låse "forventet resultat" til en scorelinje som FAKTISK stemmer med
// spillet som ble anbefalt. Uten dette kan argmax over HELE matrisen plukke
// f.eks. 0-0 (ofte den enkeltcellen med høyest sannsynlighet i en jevn kamp)
// samtidig som "hjemme vinner" er det anbefalte spillet - matematisk mulig,
// men ser ut som en selvmotsigelse for den som leser det.
const SCORE_CONDITIONS = {
  pHome: (h, a) => h > a,
  pAway: (h, a) => h < a,
  pDraw: (h, a) => h === a,
  dcHD: (h, a) => h >= a,
  dcAD: (h, a) => h <= a,
  o15: (h, a) => h + a >= 2,
  o25: (h, a) => h + a >= 3,
  o35: (h, a) => h + a >= 4,
  u35: (h, a) => h + a < 4,
  u45: (h, a) => h + a < 5,
  btts: (h, a) => h >= 1 && a >= 1,
};

/**
 * Mest sannsynlige eksakte sluttresultat ("forventet resultat" - kun for gøy).
 * argmax over den Dixon-Coles-korrigerte resultatmatrisen - begrenset til
 * scorelinjer som er FORENLIGE med `pickKey` (markedet som faktisk ble anbefalt),
 * hvis oppgitt, slik at den viste scoren aldri motsier spillet den står ved siden av.
 * @returns {object} { home, away, p } - p er sannsynligheten for akkurat det resultatet
 */
function mostLikelyScore(lambdaH, lambdaA, pickKey) {
  const MAX = 10;
  const cond = pickKey && SCORE_CONDITIONS[pickKey];
  let best = { home: 0, away: 0, p: 0 };
  let totalP = 0;
  for (let h = 0; h <= MAX; h++) {
    for (let a = 0; a <= MAX; a++) {
      const p = poisson(h, lambdaH) * poisson(a, lambdaA) * tau(h, a, lambdaH, lambdaA, RHO);
      totalP += p;
      if ((!cond || cond(h, a)) && p > best.p) best = { home: h, away: a, p };
    }
  }
  best.p /= totalP; // fortsatt sannsynligheten for AKKURAT den scoren, av alle mulige
  return best;
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

// Hjelpere
const fairOdds = (p) => (p > 0 ? 1 / p : null);
const impliedProb = (odds) => (odds > 0 ? 1 / odds : null);

module.exports = {
  poisson, modelMarkets, comboMarkets, mostLikelyScore, SCORE_CONDITIONS,
  RESULT_CONDITIONS, jointProb, fitLambdasToMarket, fairOdds, impliedProb,
};
