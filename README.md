# Automatisk RSS-feed for Skaun kommunes postliste

Denne pakken åpner postlisten med Chromium, lager `rss.xml` og publiserer den
med GitHub Pages. GitHub Actions kjører automatisk omtrent én gang i timen.

## 1. Opprett et repository

1. Logg inn på GitHub.
2. Trykk **New repository**.
3. Skriv `skaun-rss` som navn.
4. Velg **Public**.
5. Ikke legg til README, `.gitignore` eller lisens.
6. Trykk **Create repository**.

## 2. Last opp pakken

Pakk ut ZIP-filen på datamaskinen. Åpne Terminal i den utpakkede mappen og
kjør kommandoene GitHub viser under **…or push an existing repository from the
command line**. Kommandoene ligner på dette:

```bash
git init
git add .
git commit -m "Lag Skaun RSS-feed"
git branch -M main
git remote add origin https://github.com/DITT-BRUKERNAVN/skaun-rss.git
git push -u origin main
```

Bytt `DITT-BRUKERNAVN` med GitHub-brukernavnet ditt. På Mac kan du høyreklikke
på mappen i Finder og velge **New Terminal at Folder**. Hvis valget mangler,
åpner du Terminal og skriver `cd `, drar mappen inn i vinduet og trykker Enter.

## 3. Aktiver GitHub Pages

1. Åpne repositoryet på GitHub.
2. Gå til **Settings → Pages**.
3. Under **Build and deployment**, velg **GitHub Actions** som Source.
4. Gå til fanen **Actions**.
5. Åpne **Oppdater RSS-feed** og vent til jobben får grønn hake.

Første kjøring starter automatisk når filene lastes opp. Hvis den ikke starter,
trykker du **Run workflow**.

## 4. Finn RSS-adressen

Når Actions-jobben er grønn, ligger feeden normalt her:

```text
https://DITT-BRUKERNAVN.github.io/skaun-rss/rss.xml
```

Bytt `DITT-BRUKERNAVN` med brukernavnet ditt. Åpne adressen i nettleseren for
å kontrollere at den inneholder flere `<item>`-elementer.

## Hvis jobben blir rød

Åpne den røde jobben i **Actions**, åpne steget som feilet, og ta et
skjermbilde av feilmeldingen. Selektorene kan måtte justeres dersom
ElementsCloud endrer nettsiden.
