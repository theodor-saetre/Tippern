// lib/combos.js
// Kombispill i SAMME kamp: resultat/dobbel sjanse (1X, X2, 12) + mål (over/under).
//
// Kombipriser finnes IKKE i odds-feeden vi bruker. Prisen estimeres derfor fra markedet:
// lambda tilpasses Unibets 1X2 + over/under, og felles sannsynlighet for resultat OG mål
// regnes ut direkte fra resultatmatrisen (ikke to sannsynligheter ganget sammen).
//
// REGLENE UNDER ER BASERT PÅ TESTER MOT ALLE ARKIVERTE KAMPER (223 kamper, nov 2026):
//   1. Egen formmodell brukes IKKE. Den var verre enn å gjette snittet på målsum (avvik 1,76
//      mot 1,54; korrelasjon 0,17 mot markedets 0,35), og Brier-score på kombier ble dårligere
//      for HVER prosent modellvekt (0,230 uten, 0,268 med full modell).
//   2. Lagenes nylige målsnitt tilfører ikke noe utover markedet (helning -0,40 ± 0,24).
//   3. Markedets kombi-sannsynligheter er godt kalibrert (69 % sagt -> 72 % traff).
//   4. Bare favorittsiden av dobbel sjanse: BB Golds margin er ~1-5 % der, men ~20 % på
//      underdog-siden (X2 for en hjemmefavoritt, osv.).
//   5. Bare linjer der marginen er lav: over 1,5/2,5 og under 3,5/4,5. Haler (over 3,5+,
//      under 1,5/2,5) har høy margin og er vanskelige å prise riktig.
//   6. Bare spill med høy treffsjanse (p >= 55 %) og rimelig pris (1,25-2,00).
//   7. Ligaavvik: Champions League har (denne sesongen) gitt 4,10 mål pr kamp mot markedets 3,56
//      (48 % av kampene med 5+ mål mot 29 % priset); Premier League 2,60 mot 2,92. Dette ble
//      bekreftet "walk-forward" (hver kamp bedømt kun ut fra tidligere kamper): Brier 0,2303 ->
//      0,2293 totalt, 0,2153 -> 0,2058 i CL. Treffsjansen justeres derfor 60 % av målt ligaavvik.
//      BB Golds PRIS følger fortsatt markedet - forskjellen mellom de to er vår edge.
//      Alt annet vi testet (form, hjemme/borte, rating, modell, avspark, oddsbevegelse, måned:
//      280 tester) var ikke bedre enn tilfeldighet - ingen av dem er med.
// Ingen av disse reglene slår markedet - de fjerner bare det som beviselig forverrer
// utvelgelsen. Forventet avkastning er omtrent minus BB Golds margin (1-4 %).

const { jointProb, fitLambdasToMarket } = require('./poisson');

const MIN_P = 0.55;
const MIN_FAIR = 1.25, MAX_FAIR = 2.00;
// Innbyrdes (tidligere møter mellom de to lagene) flytter forventet total litt mot snittet av
// disse møtene. Vekten er lav og krymper mot null med få møter (n/(n+5)). Står på 0 til testen
// mot arkivet har avgjort om det faktisk hjelper.
const H2H_WEIGHT = 0;
// Forventer markedet så mye mål, er over 1,5 hovedvalget (færre sjanser for at et uventet høyt
// resultat ødelegger spillet, og under 4,5 feiler oftere der: 51 % mot 71 % for over 1,5 ved 3,2+
// forventede mål). Terskel testet walk-forward: treff 72,4 % / ROI +4,9 % mot 70,1 % / +1,2 % uten.
const PREFER_OVER15_FROM = 2.8;
// Over 1,5 som hovedvalg i høyscorende kamper får litt romsligere edge-grense (-5 % mot -3 %), siden
// PL-justeringen ellers siler den bort. Testet: -5 % gir 71,6 % treff / +3,6 % ROI, -8 % gir minus.
const OVER15_MIN_EDGE = -0.05;
// ...men bare hvis over 1,5 ikke er klart svakere enn beste valg (maks 4 prosentpoeng lavere treffsjanse).
// Ellers vinner under 4,5 når den er klart sikrere (f.eks. Arsenal 72 % mot 66 %). Walk-forward: 72 % treff / +3,2 % ROI
// (samme som uten gap), terskel 2,0 pp gir +0,5 %, 6 pp +3,9 % - alt innenfor støy.
const OVER15_MAX_GAP = 0.04;
const LEAGUE_SHRINK = 0.6;   // andel av målt ligaavvik (faktiske mål - markedets forventning) vi stoler på
const MIN_EDGE = -0.03;      // ikke anbefal kombier vi tror er verre enn markedets pris
const MAX_FIT_ERR = 0.04; // dårligere tilpasning mot markedet enn dette = ikke stol på estimatet

// Estimert BB Gold-margin pr kombitype (andel under rimelig pris). Målt mot BB Golds ekte
// priser på 4 PL-kamper 21. nov 2026 - altså grove estimater, ikke garantier.
const MARGIN = {
  'FAV_o1.5': 0.02, 'FAV_o2.5': 0.02, 'FAV_u3.5': 0.03, 'FAV_u4.5': 0.03,
  '12_o1.5': 0.02, '12_o2.5': 0.02,
};
// Tillatte kombier: [resultat ('FAV' = favorittsidens dobbel sjanse), linje, over?]
const ALLOWED = [
  ['FAV', 1.5, true], ['FAV', 2.5, true], ['FAV', 3.5, false], ['FAV', 4.5, false],
  ['12', 1.5, true], ['12', 2.5, true],
];

const fmtLine = (l) => String(l).replace('.', ',');
const RESULT_NAMES = {
  '1X': (f) => `${f.homeName} eller uavgjort`,
  'X2': (f) => `${f.awayName} eller uavgjort`,
  '12': (f) => `${f.homeName} eller ${f.awayName} (ikke uavgjort)`,
};

// Marginfri markedssannsynlighet fra Unibet-priser; null hvis noe mangler.
function marketProbs(ub) {
  if (!ub || !ub.odds || !ub.totals) return null;
  const { pHome, pDraw, pAway } = ub.odds;
  if (!pHome || !pDraw || !pAway) return null;
  const raw = [1 / pHome, 1 / pDraw, 1 / pAway];
  const s = raw[0] + raw[1] + raw[2];
  const pOver = (1 / ub.totals.over) / (1 / ub.totals.over + 1 / ub.totals.under);
  return { pH: raw[0] / s, pD: raw[1] / s, pA: raw[2] / s, line: ub.totals.line, pOver };
}

/**
 * @param {object} f  fixture med homeName/awayName og oddsUnibet (fra fetch-odds.js)
 * @returns {object|null} { source, fit, combos[] (best først) } eller null uten markedsdata
 */
function buildCombos(f, opts = {}) {
  const ref = f.oddsRef || f.oddsUnibet; // konsensus av flere skarpe bøker hvis tilgjengelig, ellers Unibet
  const mp = marketProbs(ref);
  if (!mp) return null;
  const fit = fitLambdasToMarket(mp.pH, mp.pD, mp.pA, mp.line, mp.pOver);
  if (!fit || fit.err > MAX_FIT_ERR) return null;

  // Ligajustering: skaler begge lagenes forventede mål slik at totalen flyttes
  // LEAGUE_SHRINK x målt ligaavvik. Kun til treffsjansen (p) - prisen (pMarket) følger markedet.
  const bias = (opts.leagueBias && opts.leagueBias[f.competition]) || 0;
  const M = fit.lambdaH + fit.lambdaA;
  const minP = opts.minP ?? MIN_P, minFair = opts.minFair ?? MIN_FAIR, maxFair = opts.maxFair ?? MAX_FAIR;
  const shrink = opts.shrink ?? LEAGUE_SHRINK;
  const minEdge = opts.minEdge ?? MIN_EDGE;
  // Ligaavviket flytter forventet total FLATT (alle kamper i ligaen likt). Det er liten effekt
  // (PL -0,19 mål): en kamp med 3,5 forventede mål går fra 68 % til 64 % på over 2,5, og er
  // fortsatt en tydelig over-kamp. En myk variant (avtar ved høye mål, opts.taper) ble testet
  // walk-forward: lik Brier, men dårligere valg (treff 67,6 % mot 70,1 %, ROI -3,4 % mot +1,2 %),
  // så den flate er standard.
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const taper = opts.taper ? (bias < 0 ? clamp01((3.6 - M) / 1.0) : clamp01((M - 2.6) / 1.0)) : 1;
  const shift = shrink * bias * taper;
  const h2hWeight = opts.h2hWeight ?? H2H_WEIGHT;
  let h2hShift = 0;
  if (h2hWeight > 0 && f.h2h && f.h2h.n >= 2 && f.h2h.avgTotal != null) {
    h2hShift = h2hWeight * (f.h2h.n / (f.h2h.n + 5)) * (f.h2h.avgTotal - M);
  }
  const scale = Math.max(0.7, Math.min(1.4, (M + shift + h2hShift) / M));
  const adjH = fit.lambdaH * scale, adjA = fit.lambdaA * scale;

  const favSide = mp.pH >= mp.pA ? '1X' : 'X2'; // dobbel sjanse på favorittens side
  const all = [];
  for (const [resKey, line, over] of ALLOWED) {
    const result = resKey === 'FAV' ? favSide : resKey;
    const pMarket = jointProb(fit.lambdaH, fit.lambdaA, result, line, over);
    const p = jointProb(adjH, adjA, result, line, over); // vår treffsjanse, ligajustert
    const fairMarket = 1 / pMarket;
    const margin = MARGIN[`${resKey}_${over ? 'o' : 'u'}${line}`];
    all.push({
      key: `${result}_${over ? 'o' : 'u'}${line}`,
      result, line, over,
      label: `${RESULT_NAMES[result](f)} + ${over ? 'Over' : 'Under'} ${fmtLine(line)} mål`,
      bb: `${result} og ${over ? 'Over' : 'Under'} ${fmtLine(line)}`, // slik BB Gold skriver det
      p, pMarket, pModel: null, edge: p / pMarket - 1,
      fairMarket,                              // estimert marginfri markedspris
      estBB: fairMarket * (1 - margin),        // estimert pris hos BB Gold (sjekk ekte pris!)
    });
  }

  // Beste over- og beste under-kombi side om side (uten edge-filter), så brukeren kan velge selv.
  const spillbare = all.filter((c) => c.p >= 0.5 && c.fairMarket >= MIN_FAIR && c.fairMarket <= MAX_FAIR);
  const best = (arr) => [...arr].sort((a, b) => b.p - a.p)[0] || null;
  const over = best(spillbare.filter((c) => c.over));
  const under = best(spillbare.filter((c) => !c.over));
  // Alle linjer (1,5 / 2,5 / 3,5 / 4,5) i prisvinduet, så brukeren kan sammenligne mot BB Golds ekte pris
  // ("BB må ha" avgjør om sannsynligheten matcher prisen). Sortert etter treffsjanse.
  const alts = all
    .filter((c) => c.p >= 0.4 && c.fairMarket >= MIN_FAIR && c.fairMarket <= MAX_FAIR + 0.5)
    .sort((a, b) => b.p - a.p);

  // Høyest treffsjanse først, innenfor spillbart prisvindu.
  const combos = all
    .filter((c) => c.p >= minP && c.fairMarket >= minFair && c.fairMarket <= maxFair && c.edge >= minEdge)
    .sort((a, b) => b.p - a.p);
  // I høyscorende kamper settes beste over 1,5-kombi først (egen, litt romsligere edge-grense)
  if (M >= (opts.preferFrom ?? PREFER_OVER15_FROM)) {
    const o15 = all
      .filter((c) => c.over && c.line === 1.5 && c.p >= minP && c.fairMarket >= minFair && c.fairMarket <= maxFair && c.edge >= Math.min(minEdge, OVER15_MIN_EDGE))
      .sort((a, b) => b.p - a.p)[0];
    // (opts.o15Gap: over 1,5 foretrekkes bare hvis den er innenfor så mange prosentpoeng av beste valg)
    const gap = opts.o15Gap ?? OVER15_MAX_GAP;
    if (o15 && (!combos.length || o15.p >= combos[0].p - gap)) {
      const i = combos.findIndex((c) => c.key === o15.key);
      if (i >= 0) combos.splice(i, 1);
      combos.unshift(o15);
    }
  }
  combos.splice(4);

  return {
    source: ref.bookmaker, refBooks: ref.n || 1, refSpread: ref.spread ?? null,
    fit: { lambdaH: fit.lambdaH, lambdaA: fit.lambdaA, err: fit.err, marketTotal: M, leagueAdj: shift, h2hAdj: h2hShift },
    combos, over, under, alts,
  };
}

// Treffer kombien gitt sluttresultatet? (brukes av check-results.js)
function comboHit(c, hg, ag) {
  const { RESULT_CONDITIONS } = require('./poisson');
  const g = hg + ag;
  return !!(RESULT_CONDITIONS[c.result](hg, ag) && (c.over ? g > c.line : g < c.line));
}

module.exports = { buildCombos, comboHit };
