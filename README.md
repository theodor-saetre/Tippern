# Kampanalyse — startpakke for Claude Code

Alt du trenger for å bygge fotball-analyseappen live på GitHub. Kjernekoden (modell, rating, kupong) er ferdig og testet. Skjelettene for API-henting og GitHub Actions er på plass — du fyller inn hentingen og deployer, gjerne med Claude Code.

## Kjør testen først (ingen nøkkel nødvendig)

```bash
node scripts/test-model.js
```

Skal skrive ut forventede mål, bekrefte at Liverpool forventes å score mer mot Hull enn mot City, og at Dagens spill lander i odds-vinduet. Hvis den grønne linja nederst kommer, er kjernen frisk.

## Lim dette inn i Claude Code som første melding

> Jeg bygger en fotball-analyseapp. I denne mappa ligger `byggeplan-kampanalyse.md` (full plan), `kampanalyse.html` (ferdig frontend med demodata), og en `lib/`-mappe med ferdig, testet modell-logikk (ratings.js, poisson.js, coupon.js). Det finnes skjeletter i `scripts/` og `.github/workflows/`.
>
> Les byggeplanen og koden først. Så hjelp meg, steg for steg:
> 1. Fyll inn API-hentingen i `scripts/build-model.js` mot football-data.org (jeg har gratis nøkkel).
> 2. Fyll inn odds-mapping i `scripts/fetch-odds.js` mot The Odds API.
> 3. Endre `kampanalyse.html` så den leser `data/today.json` i stedet for demodata.
> 4. Sett opp `.env` lokalt for nøklene, test at ekte kamper hentes riktig.
> 5. Opprett GitHub-repo, legg nøklene inn som Secrets, slå på Pages, verifiser at begge Actions kjører.
>
> Behold modell-logikken i `lib/` som den er — den er testet. Ikke hardkod nøkler noe sted. Forklar hvert steg kort så jeg lærer underveis.

## Hva ligger hvor

```
lib/ratings.js      ✅ ferdig — tidsvektet hjemme/borte rating
lib/poisson.js      ✅ ferdig — markedssannsynligheter
lib/coupon.js       ✅ ferdig — Dagens spill (1,70–2,50) + The Gambler
scripts/build-model.js   🔧 skjelett — fyll inn football-data-henting
scripts/fetch-odds.js    🔧 skjelett — fyll inn The Odds API-mapping
scripts/test-model.js    ✅ ferdig — røyktest uten nøkkel
kampanalyse.html         ✅ frontend (leser demodata nå → bytt til data/today.json)
byggeplan-kampanalyse.md 📄 full plan / referanse
.github/workflows/       ⚙️ daglig modell + odds før kamp
```

## Nøkler (gratis)

- **football-data.org** → `FOOTBALL_DATA_KEY` — kamper, form, resultater
- **the-odds-api.com** → `ODDS_API_KEY` — odds

Lokalt: legg i `.env` (ikke commit den). På GitHub: Settings → Secrets and variables → Actions.

## Kvote-huskeliste

- Hent kun ligaene du følger (rediger `COMPETITIONS` i build-model.js).
- Odds hentes bare ~1t før avspark, én gang pr kamp (odds-scriptet styrer dette selv).
- Cache lagform gjennom dagen — den endrer seg ikke fra morgen til kveld.

## Når grunnmuren står

- Oddsbevegelse (skjelettet lagrer allerede `oddsHistory`).
- Dixon-Coles-korreksjon for lavscorede resultater.
- Paper trading-logg — la modellen loggføre spill fiktivt, se ærlig om den slår bookmakeren.

---

*Til underholdning. Modellen er ett datapunkt, ikke en fasit — bookmakeren har som regel en bedre modell og en innebygd margin. Spill kun for penger du tåler å tape.*
