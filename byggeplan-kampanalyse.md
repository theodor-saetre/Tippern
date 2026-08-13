# Byggeplan — Kampanalyse på GitHub

Fra demoen du har nå til en app som oppdaterer seg selv, hostet gratis på din egen GitHub-konto. Denne planen kan du følge selv steg for steg, eller lime rett inn i Claude Code som en oppskrift.

## Slik henger det sammen

Tre deler jobber sammen, alt på GitHub:

- **GitHub Pages** hoster den ferdige siden (frontend-en du allerede har). Gratis, offentlig nettadresse.
- **GitHub Actions** kjører to planlagte jobber: én daglig som regner modellen, og én som henter odds ~1 time før hver kamp.
- **En JSON-datafil i repoet** fungerer som "database". Actions skriver til den, frontend leser fra den.
- **GitHub Secrets** holder API-nøklene trygt — aldri synlig i koden.

Dataflyten en typisk dag: om morgenen henter den daglige jobben dagens kamper, regner tidsvektede hjemme/borte-ratinger og Poisson-modellen, og lagrer alt til `data/today.json`. Rundt en time før hver kamp henter odds-jobben ferske odds (etter at laget er kjent og markedet har justert) og oppdaterer samme fil. Når du åpner appen leser den bare den ferdige fila — rask, og alltid oppdatert.

## Mappestruktur

```
kampanalyse/
├── index.html              # frontend (fra demoen, lett tilpasset til å lese JSON)
├── data/
│   └── today.json          # dagens kamper + modell + odds (skrives av Actions)
├── scripts/
│   ├── build-model.js      # henter kamper, regner ratinger + modell
│   └── fetch-odds.js       # henter ferske odds for dagens kamper
├── lib/
│   ├── ratings.js          # tidsvektet hjemme/borte rating-beregning
│   └── poisson.js          # Poisson-motoren (fra demoen)
└── .github/
    └── workflows/
        ├── daily-model.yml # kjører modell 1x daglig
        └── match-odds.yml  # henter odds før kampene
```

## Steg 1 — Datakilder og nøkler

**football-data.org** (kamper, resultater, form — gratis):
- Registrer deg på football-data.org, få gratis API-nøkkel.
- Gratisplanen dekker de store ligaene (PL, Serie A, La Liga, Bundesliga, Ligue 1, Champions League, EM/VM).
- Grense: ca. 10 kall i minuttet på gratis. Nok, så lenge du ikke spør om alt på én gang.

**The Odds API** (odds — gratis kvote):
- Registrer på the-odds-api.com, få nøkkel.
- Gratis: et fast antall kall pr måned. Fordi du kun henter én gang pr kamp (~1t før avspark), holder dette godt.

Legg begge nøklene inn som **GitHub Secrets** (Settings → Secrets and variables → Actions → New repository secret): `FOOTBALL_DATA_KEY` og `ODDS_API_KEY`. Da ligger de trygt og er tilgjengelige for Actions uten å stå i koden.

## Steg 2 — Rating-beregningen (lib/ratings.js)

Dette er kjernen — den regner tidsvektede hjemme/borte-ratinger fra ekte kampdata. Logikken er den samme som i demoen, bare matet med ekte tall:

1. Hent siste ~10 kamper for hvert lag fra football-data.org.
2. For hvert lag: regn snitt scoret/sluppet inn, der **nyere kamper veier mer** (recency-vekt: eldste kamp vekt 1, nyeste vekt 10).
3. Regn separate tall for **hjemme** og **borte**.
4. Normaliser mot ligagjennomsnittet → angrepsstyrke og forsvarsstyrke (1,00× = snittlag).
5. Ved en kamp: blend 60% venue-spesifikk + 40% totalform for stabilitet.

Forventet mål for kampen:
- Hjemmelag: `hjemme-angrep × borte-lagets borte-forsvar × ligaens hjemmesnitt`
- Bortelag: `borte-angrep × hjemme-lagets hjemme-forsvar × ligaens bortesnitt`

## Steg 3 — Poisson-modellen (lib/poisson.js)

Kopier rett fra demoen — den er ferdig og trenger ingen endring. Den tar de to forventede mål-tallene, bygger en sannsynlighetsmatrise for alle resultater opp til 10–10, og summerer opp markedene: double chance, over/under 1,5/2,5/3,5/4,5, begge lag scorer, full tid.

## Steg 4 — Daglig modell-jobb (build-model.js + daily-model.yml)

Scriptet:
1. Spør football-data.org om dagens kamper i ligaene du følger.
2. For hver kamp: hent begge lags siste 10, regn ratinger, kjør modellen.
3. Regn Dagens spill (beste marked i odds-vindu 1,70–2,50) og The Gambler (10+ combo med ærlig sjanse).
4. Skriv alt til `data/today.json`.

Workflow (`daily-model.yml`) planlegges med cron, f.eks. kl. 07 norsk tid hver dag. Den kjører scriptet og committer den oppdaterte JSON-fila tilbake til repoet.

## Steg 5 — Odds-henting før kamp (fetch-odds.js + match-odds.yml)

Scriptet:
1. Leser `data/today.json` for å se hvilke kamper som spilles og når.
2. For kamper som starter om ~1 time: hent ferske odds fra The Odds API.
3. Legg oddsen inn i JSON-fila ved siden av modellens "rimelige odds".
4. (Valgfritt) lagre forrige odds så du kan vise **oddsbevegelse**.

Workflow (`match-odds.yml`) planlegges tettere på ettermiddag/kveld (f.eks. hver time fra kl. 12 til 23), men scriptet henter bare for kamper som faktisk nærmer seg avspark — så du sparer kvote. Slik blir oddsen riktig til spillet uten å jage oppstillinger: når laget er kjent flytter bookmakerne oddsen, og du henter den ferske versjonen.

## Steg 6 — Frontend leser JSON

Den eneste endringen i `index.html`: i stedet for hardkodet demodata, `fetch('data/today.json')` ved sidelast og render fra det. All visnings-logikken (kort, kupong, modell) er allerede skrevet.

## Steg 7 — Gå live på GitHub Pages

1. Push alt til et GitHub-repo (f.eks. `theodor-saetre/kampanalyse`).
2. Settings → Pages → velg `main`-branch som kilde.
3. Du får en adresse: `theodor-saetre.github.io/kampanalyse`.
4. Åpne på mobil, legg til på hjemskjerm for app-følelse.

## Kvote-huskeliste (så appen ikke stopper midt i måneden)

- Hent kun for ligaene du faktisk følger, ikke alt.
- Odds kun ~1 time før avspark, én gang pr kamp — ikke hele døgnet.
- Cache lagdata gjennom dagen (form endrer seg ikke fra morgen til kveld).

## Neste forbedringer (når grunnmuren står)

- **Oddsbevegelse**: vis hvordan oddsen har flyttet seg — ofte det mest nyttige signalet.
- **Dixon-Coles-korreksjon** for lavscorede resultater (0–0, 1–0, 1–1), der ren Poisson bommer litt.
- **Paper trading-logg**: la appen loggføre modellens spill fiktivt over tid, så du ærlig ser om den slår bookmakeren — den viktigste realitetssjekken.

---

*Til underholdning. Modellen er ett datapunkt, ikke en fasit — bookmakeren har som regel en bedre modell og en innebygd margin. Spill kun for penger du tåler å tape.*
