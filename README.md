# Tippern — fotballtips fra markedspriser

Pre-match-analyse for Premier League, La Liga og Champions League. Siden (GitHub Pages) viser ett hovedspill pr kamp (resultat/dobbel sjanse + antall mål i samme kamp), kuponger, og statistikk. Alt drives av GitHub Actions.

**Hvordan det fungerer:** ingen egen formmodell. Sannsynligheter regnes fra markedspriser (flere skarpe bookmakere via The Odds API): forventede mål tilpasses 1X2 + over/under, og felles sannsynlighet for resultat OG mål regnes ut av resultatmatrisen. Det eneste som justeres er et lite ligaavvik (Premier League −, Champions League +). BB Golds priser kan ikke hentes automatisk, så «BB ca.» er et **estimat**, og «BB må ha ≥» viser prisen som trengs for å ha verdi.

## Kjør testen først (ingen nøkkel nødvendig)

```bash
node scripts/test-model.js
```

Sjekker markedstilpasning, felles sannsynlighet, kombier, treffsjekk og kuponger. Grønn linje nederst = kjernen er frisk.

## Hva ligger hvor

```
lib/poisson.js      Poisson/Dixon-Coles: markedstilpasning (fitLambdasToMarket) og jointProb
lib/combos.js       Hovedspill pr kamp: resultat/dobbel sjanse + over/under, regler, reservespill og "andre alternativ"
lib/coupons.js      Kuponger pr avspark-tid + Dagens kupong (3-4 ben, estimert pris ca. 3-4)
scripts/build-model.js   Henter dagens kamper + lagform (football-data.org) -> data/today.json
scripts/fetch-odds.js    Henter markedspriser (The Odds API), bygger kombier og kuponger
scripts/check-results.js Henter resultater, markerer treff/bom, logger til data/combo-history.json
                         og data/coupon-history.json
scripts/test-model.js    Røyktest uten nøkkel
index.html          Tips (ett spill pr kamp, kuponger, verdi-finner for BB Golds pris)
statistikk.html     Treffprosent for enkeltspill
avkastning.html     Estimert avkastning for enkeltspill (100 kr pr spill)
kuponger.html       Kuponger for seg: treff og estimert avkastning (250 kr pr kupong)
.github/workflows/  daily-model.yml (daglig) + match-odds.yml (hver halvtime)
data/               today.json, archive/, combo-history.json, coupon-history.json
```

`data/history.json` er loggen fra den gamle formmodellen. Ingen side leser den lenger.

## Nøkler (gratis)

- **football-data.org** -> `FOOTBALL_DATA_KEY` — kamper, form, resultater
- **the-odds-api.com** -> `ODDS_API_KEY` — odds (500 kreditter/måned)

Lokalt: legg i `.env` (ikke commit den). På GitHub: Settings -> Secrets and variables -> Actions.

## Kvote-huskeliste

- Morgenjobben henter ett kall pr liga (h2h + totals). «Odds før kamp» henter pr kamp bare ~90 min før avspark.
- Kjør ikke `build-model.js` lokalt og push `data/` derfra: det overskriver robotens data.

---

*Til underholdning. Forventet avkastning er omtrent minus BB Golds margin; den eneste realistiske edgen er at BB Gold betaler mer enn «BB må ha ≥». Spill kun for penger du tåler å tape.*
