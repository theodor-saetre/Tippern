// lib/ratings.js
// Tidsvektet, hjemme/borte-bevisst styrkeberegning.
// Kjernen i modellen — gjør at 4 mål mot et topplag teller mer enn 4 mot bunnlag,
// og at nylig form og hjemme/borte-forskjeller påvirker forventet mål.

// Ligagjennomsnitt for mål pr kamp. Juster pr liga hvis du vil være presis;
// dette er typiske toppliga-tall. Kan også regnes dynamisk fra sesongdata.
const LEAGUE = { homeAvg: 1.55, awayAvg: 1.20 };

/**
 * @param {Array} results  Siste ~10 kamper, ELDST → NYEST. Hvert element:
 *   { gf: mål scoret, ga: mål sluppet inn, venue: 'H' | 'A' }
 * @returns {object} overall/home/away angreps- og forsvarsratinger (relativt til liga)
 */
function computeRatings(results) {
  let wSum = 0, gfW = 0, gaW = 0;
  let hGf = 0, hGa = 0, hW = 0;
  let aGf = 0, aGa = 0, aW = 0;

  results.forEach((m, i) => {
    const w = i + 1; // recency-vekt: eldste = 1 ... nyeste = n
    wSum += w; gfW += m.gf * w; gaW += m.ga * w;
    if (m.venue === 'H') { hGf += m.gf * w; hGa += m.ga * w; hW += w; }
    else { aGf += m.gf * w; aGa += m.ga * w; aW += w; }
  });

  const overallGf = gfW / wSum, overallGa = gaW / wSum;
  const homeGf = hW ? hGf / hW : overallGf, homeGa = hW ? hGa / hW : overallGa;
  const awayGf = aW ? aGf / aW : overallGf, awayGa = aW ? aGa / aW : overallGa;

  const midAvg = (LEAGUE.homeAvg + LEAGUE.awayAvg) / 2;

  return {
    overall: { atk: overallGf / midAvg, def: overallGa / midAvg },
    home:    { atk: homeGf / LEAGUE.homeAvg, def: homeGa / LEAGUE.awayAvg },
    away:    { atk: awayGf / LEAGUE.awayAvg, def: awayGa / LEAGUE.homeAvg },
  };
}

/**
 * Blander venue-spesifikk form (60%) med totalform (40%) for stabilitet.
 * @param {object} rat  fra computeRatings
 * @param {'H'|'A'} side
 */
function venueBlend(rat, side) {
  const base = rat.overall;
  const v = side === 'H' ? rat.home : rat.away;
  return {
    atk: 0.6 * v.atk + 0.4 * base.atk,
    def: 0.6 * v.def + 0.4 * base.def,
  };
}

/**
 * Forventet mål for en kamp, gitt begge lags siste resultater.
 * @param {Array} homeResults  hjemmelagets siste ~10 (eldst→nyest)
 * @param {Array} awayResults  bortelagets siste ~10 (eldst→nyest)
 * @returns {object} { lambdaH, lambdaA, ratingsH, ratingsA }
 */
function expectedGoals(homeResults, awayResults) {
  const rH = computeRatings(homeResults);
  const rA = computeRatings(awayResults);
  const bH = venueBlend(rH, 'H');
  const bA = venueBlend(rA, 'A');

  // hjemme xG = hjemmeangrep × borteforsvar × ligaens hjemmesnitt
  const lambdaH = bH.atk * bA.def * LEAGUE.homeAvg;
  const lambdaA = bA.atk * bH.def * LEAGUE.awayAvg;

  return { lambdaH, lambdaA, ratingsH: rH, ratingsA: rA, blendH: bH, blendA: bA };
}

module.exports = { LEAGUE, computeRatings, venueBlend, expectedGoals };
