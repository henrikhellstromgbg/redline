# Redline — plan (v0.1, MVP)

Arbetsnamn: **redline**. Ett granskningsverktyg där en designer markerar områden på en levande webbsida, skriver en kort instruktion per markering, och stänger reviewen. Resultatet är en strukturerad JSON-kölista som en kodagent (Claude Code via Chrome MCP) läser och betar av. Kategorin är "design-QA för agentkodning": människan gör bedömningen, agenten gör implementationen, verktyget är kontraktet mellan dem.

Detta är INTE ett byggverktyg (Onlook/Subframe) och INTE ett kommentarsverktyg för människor (Vercel Toolbar/Marker.io). Mottagaren är en agent, därför måste varje anteckning bära teknisk grund: selector, computed styles, React-komponentnamn, helst filväg.

## Deliverables

Allt i `~/tools/redline/`:

1. `overlay.js` — hela verktyget. En självständig IIFE i vanilla JS, noll beroenden, inget byggsteg. Injiceras i valfri flik via Chrome MCP `javascript_tool` eller klistras in i DevTools-konsolen. Idempotent: körs den igen på samma sida ska den återanvända/återställa befintlig instans, inte dubblera.
2. `AGENT.md` — arbetsflödet ur agentens perspektiv (injicera → vänta → hämta kö → implementera). Skrivs så att en Claude Code-session kan följa den rakt av.
3. `README.md` — kort: vad det är, hur Henrik startar en review, datamodellen.
4. `test/demo.html` — statisk testsida med medvetna fel (fel border-radius, saknad padding, VERSALER som ska vara sentence case, fel gråton) så verktyget kan testas utan SlayCRM.

## Overlay: UX

- **Aktivering:** när skriptet körs visas en liten flytande toolbar (fast position, nedre högra hörnet, flyttbar är inte nödvändigt i MVP). Knappar: `Markera` (rit-läge), `Bläddra` (pausläge), `Klar` (avsluta review), samt räknare "3 markeringar".
- **Rit-läge:** krysshårs-cursor. Dra en rektangel. Vid mouseup öppnas en liten popover förankrad vid rektangeln med ett textfält: skriv instruktionen, Enter sparar, Esc ångrar rektangeln. Efter spar: rektangeln ligger kvar som en numrerad ram (badge med löpnummer i hörnet).
- **Pausläge (viktigt):** i pausläge släpper overlayen igenom alla pointer events så att sidan kan användas normalt (öppna en dropdown, öppna en modal, öppna en kalender) och sedan växlar man tillbaka till rit-läge och markerar i det nya tillståndet. Henriks exempel är just markeringar i en öppen modal med öppen datumväljare.
- **Kortkommandon:** `r` = rit-läge, `b` = bläddra, `Esc` i rit-läge utan pågående drag = bläddra. Lyssna bara när fokus inte är i sidans egna fält.
- **Panelen:** klick på räknaren visar en lista över markeringar (nummer + första ~40 tecken av instruktionen). Klick i listan scrollar till och blinkar ramen. Varje rad har ta bort-knapp.
- **Klar:** serialiserar kön (se datamodell), skriver den till `localStorage['redline.queue']` OCH `window.__redlineQueue`, loggar `[redline] queue ready: N items` till konsolen, visar en bekräftelse med en "Kopiera JSON"-knapp, och plockar sedan ner overlayen (ramarna försvinner så att agenten kan ta rena screenshots).

### Overlay: stilregler (Henriks krav, inga undantag)

- Minsta fontstorlek i overlay-UI: **14px**.
- All UI-copy i **sentence case** ("Kopiera JSON", aldrig "Kopiera JSON" i title case eller versaler).
- Markeringsramar och element med accentfärgad kant ska ha **skarpa hörn** (border-radius 0). Toolbar/popover får ha diskret radius (max 6px).
- Ramfärger: cykla genom en liten palett med hög kontrast (t.ex. #e11d48, #7c3aed, #059669, #d97706, #2563eb). Badge = samma färg, vit text, 14px.
- Overlayen får aldrig påverka sidans layout: allt position:fixed/absolute i ett eget rot-element med `z-index: 2147483000+`, egen `<style>`-tagg med unika klassprefix (`rl-`). Ingen Shadow DOM behövs i MVP men prefixa allt.

## Datamodell

`localStorage['redline.queue']` = JSON:

```json
{
  "version": 1,
  "url": "http://localhost:3000/app/konton/123",
  "createdAt": "2026-07-29T09:00:00.000Z",
  "viewport": { "w": 1440, "h": 900, "dpr": 2, "scrollX": 0, "scrollY": 0 },
  "items": [
    {
      "id": 1,
      "color": "#e11d48",
      "instruction": "Dropdown ska inte ha runda kanter",
      "rect": { "x": 24, "y": 88, "w": 440, "h": 56 },
      "pageRect": { "x": 24, "y": 388, "w": 440, "h": 56 },
      "scroll": { "x": 0, "y": 300 },
      "elements": [
        {
          "selector": "#activity-modal .rl-best-selector",
          "tag": "button",
          "text": "Aktivitet Samtal (max 80 tecken, trimmat)",
          "overlap": 0.94,
          "styles": {
            "color": "…", "backgroundColor": "…", "fontSize": "…",
            "fontWeight": "…", "padding": "…", "margin": "…",
            "borderRadius": "…", "display": "…", "gap": "…",
            "textTransform": "…", "border": "…"
          },
          "react": {
            "components": ["ActivityTypeSelect", "ActivityModal"],
            "source": { "fileName": "src/components/ActivityTypeSelect.tsx", "lineNumber": 42 }
          }
        }
      ]
    }
  ]
}
```

- `rect` = viewport-koordinater vid markeringstillfället, `pageRect` = dokumentkoordinater, `scroll` = scrollläge då. Alla tre behövs för att agenten ska kunna beskära screenshots och återfinna elementet.
- `elements`: max 5 kandidater, rankade efter överlapp med rektangeln (skärningsarea / elementarea, vikta bort element som är mycket större än rektangeln, t.ex. body/wrappers: straffa element vars area > 4× rektangelns). Hoppa över overlayens egna element.

## Elementfångst: implementation

1. Vid spar: samla kandidater genom att gå igenom `document.querySelectorAll('*')` är för dyrt — använd i stället `document.elementsFromPoint()` på ett rutnät av provpunkter i rektangeln (t.ex. 3×3 plus centrum), slå ihop, deduplicera.
2. För varje kandidat: beräkna överlapp via `getBoundingClientRect()`, filtrera enligt ovan, sortera, ta topp 5.
3. **Selector:** prioritera `id` → `data-testid`/`data-test` → kortaste unika kombination av tagg + stabila klasser (filtrera bort klasser som ser hashade ut: innehåller siffror/understreck-mönster typ CSS modules `_abc_1x2y3`) → fall tillbaka på nth-child-kedja från närmaste förälder med id. Verifiera att `document.querySelector(selector)` träffar rätt element, annars förläng kedjan.
4. **Computed styles:** exakt den delmängd som listas i datamodellen, via `getComputedStyle`.
5. **React fiber:** leta nyckel som börjar med `__reactFiber$` på elementet, gå uppåt via `.return`, samla `type.name`/`type.displayName` för funktions- och klasskomponenter (hoppa över host-komponenter och anonyma), max 3 namn. `_debugSource` (fileName, lineNumber) tas med om det finns (React dev mode). Allt med optional chaining, får aldrig kasta; saknas React blir `react: null`.

## AGENT.md: flödet

1. Agenten (Claude Code med Chrome MCP) läser `overlay.js` från disk och injicerar hela innehållet i målfliken via `javascript_tool`.
2. Säger till Henrik: "Reviewläget är på, säg till när du tryckt Klar" — och väntar (Henrik svarar i chatten när han är klar; ingen polling behövs i MVP).
3. Hämtar kön: `javascript_tool` → `localStorage.getItem('redline.queue')`.
4. Tar en screenshot av fliken. Använder `pageRect`/`scroll` per punkt för att veta var på sidan varje markering satt (agenten kan scrolla till `pageRect.y` och zooma på regionen vid behov).
5. Konverterar kön till en tasklista (TaskCreate per punkt), implementerar i kodbasen punkt för punkt med selector + komponentnamn + styles som grund, och verifierar i webbläsaren.
6. Efter avslutad körning: `localStorage.removeItem('redline.queue')`.

## Testkrav (byggagenten ska verifiera, inte bara skriva)

- Öppna `test/demo.html` i en debuggbar Chrome (chrome-devtools MCP-verktygen finns och auto-startar headless), injicera `overlay.js` via `evaluate_script`.
- Simulera programmatiskt (dispatchEvent av mousedown/mousemove/mouseup samt direktanrop av interna funktioner är ok) att två markeringar skapas med instruktioner, tryck Klar, och läs tillbaka `localStorage['redline.queue']`.
- Verifiera: 2 items, korrekta rect-värden, minst 1 elementkandidat med fungerande selector (`document.querySelector` träffar), styles ifyllda, `react: null` på den statiska sidan.
- Verifiera idempotens: injicera skriptet två gånger, ingen dubblerad toolbar.
- Verifiera pausläget: i bläddra-läge når `elementFromPoint` sidans element, inte overlayen.

## Avgränsningar (MVP)

- Ingen persistens utöver localStorage, ingen server, ingen extension, ingen multi-sida-review (en review = en URL).
- Inga screenshot-crops i själva verktyget; agenten löser det med koordinaterna.
- Ingen redigering av sparad instruktion (ta bort + gör om räcker).
- Svenska eller engelska i UI-copy: engelska, kort och sentence case ("Mark", "Browse", "Done", "Copy JSON", "3 marks").

---

# v0.2 — ändringar efter första skarpa testet (SlayCRM, 2026-07-29)

Tre ändringar, i prioritetsordning:

## 1. Multi-vy-review (flödesluckan)

Done avslutade hela reviewen. Nytt flöde:

- Knappen **Done** ersätts av **Save view**. Vid klick: nuvarande vys markeringar arkiveras som en "view" (`{ url, title: document.title, savedAt, viewport, items }`), ramarna töms, räknaren nollställs, och Henrik fortsätter till nästa vy (Browse-läge aktiveras automatiskt). Toolbar ligger kvar.
- Kön i `localStorage['redline.queue']` blir `{ version: 2, createdAt, views: [...] }`. Skriv efter VARJE Save view (inkrementellt, så inget tappas vid hård omladdning).
- Ny knapp **Finish** (samma gröna stil som Done hade): arkiverar ev. osparade markeringar som en sista view, skriver kön, loggar `[redline] queue ready: N views, M marks`, visar toast, plockar ner overlayen.
- SPA-navigering: overlayen överlever client-side-nav (roten sitter på documentElement). Lyssna på URL-ändringar (popstate + polling av location.href, 500 ms). När URL ändras med osparade markeringar: arkivera dem automatiskt som en view (samma som Save view) så koordinater aldrig blandas mellan vyer.
- Hård omladdning: overlayen försvinner, men sparade views ligger kvar i localStorage. Vid återinjicering: läs befintlig version 2-kö och FORTSÄTT på den (visa antal i räknaren, t.ex. "2 views, 5 marks"), skriv inte över. Kön rensas först när agenten kör `localStorage.removeItem`.

## 2. Testid-ankrade selectors

Nuvarande fallback ger långa nth-child-kedjor från roten (`div > main > div > div > ...`). Ny prioritering i buildSelector steg 4: gå uppåt från elementet till närmaste förälder som har `data-testid`, `data-test` eller stabilt id, och bygg en KORT nth-child-kedja därifrån: `[data-testid="deal-sidebar-meta"] > div:nth-child(2) > dt`. Bara om ingen sådan förälder finns inom 10 nivåer används dagens rot-kedja. Verifiera unikhet som förut.

## 3. Löv-element-fångst för text-instruktioner

9-punktsrutnätet missar små textelement med luft emellan (dt-labels i en kolumn gav bara containers). Komplettera captureElements: efter punktproverna, gör en TreeWalker-svepning över alla element vars boundingRect skär rektangeln till >50% av ELEMENTETS area och vars area < rektangelns area (dvs. löv/småelement inuti markeringen, inte wrappers). Lägg till dessa i kandidatmängden före scoring. Begränsa svepningen till närmaste gemensamma container för punktprovernas träffar (inte hela dokumentet) för prestanda. Höj kandidattaket till 8 och lägg till fältet `role: "leaf" | "container"` per kandidat (löv = area < rektangelns area, annars container) så agenten ser skillnaden.

## Testkrav v0.2

Utöver v0.1-testerna, verifiera i riktig Chrome:
- Save view → markera på "sida 2" (ändra URL via history.pushState i testet) → Finish → kön har 2 views med rätt URL per view och inga blandade koordinater.
- Hård omladdning mellan två Save view: återinjicering fortsätter på befintlig kö.
- En markering över en kolumn med tre små labels ger löv-kandidater för lablarna (role: "leaf"), inte bara containers.
- Selector-testet: ett element utan id/klasser inuti en `[data-testid]`-container får testid-ankrad selector.
- Uppdatera AGENT.md (version 2-schema, views-loop) och README.md.

---

# v0.3 — redigera befintliga kommentarer

Henriks krav: kunna gå tillbaka och ändra redan gjorda kommentarer, även i sparade vyer.

1. **Redigera aktuell vys markeringar.** Badgen på varje ram får pointer-events:auto och cursor:pointer. Klick på badge ELLER på radens text i panelen öppnar instruktions-popovern förankrad vid ramen, förifylld med befintlig text. Enter sparar ändringen (uppdaterar mark.instruction + panelrad), Esc stänger utan ändring. Elementfångsten görs INTE om vid redigering, bara texten ändras.
2. **Panelen visar sparade vyer.** Under aktuella vyns rader: en sektion per sparad vy (hopfälld som standard), rubrik = vyns titel eller URL-path + antal punkter, klick fäller ut. Varje rad: nummer, instruktion (trunkerad ~40 tecken), Edit- och Remove-knapp. Edit öppnar samma popover (centrerad eller vid panelen, ramen finns inte längre); Enter sparar till views[i].items[j].instruction och kör writeQueue() direkt. Remove tar bort punkten ur vyn (tom vy tas bort helt) och kör writeQueue().
3. Sentence case, 14px-golv, skarpa hörn på allt accentfärgat som tidigare. Idempotens-fixen (finished-instans rivs och byggs om) ligger redan i overlay.js, behåll den.
4. **Testkrav:** verifiera i riktig Chrome: (a) klick på badge öppnar förifylld popover, Enter ändrar instruktionen i serialiserad kö; (b) redigering av en punkt i en SPARAD vy uppdaterar localStorage direkt; (c) Remove i sparad vy skriver om kön; (d) Esc lämnar allt oförändrat; (e) elementlistan är intakt efter textredigering.

---

# v0.3.1 — spökram vid redigering av sparad punkt

Henriks feedback: vid Edit på en punkt i en sparad vy syns bara dialogen, inte var markeringen satt.

1. **Samma URL:** om location.href === view.url när Edit öppnas: rita en tillfällig spökram (samma utseende som .rl-frame men dashed border + item.color, med sifferbadge) på item.pageRect (positionerad mot aktuell scroll, dvs. left = pageRect.x - scrollX). Scrolla först så ramen hamnar i övre tredjedelen av viewporten (samma logik som blinkMark). Förankra popovern vid spökramen i stället för centrerat. Ta bort spökramen när popovern stängs (Enter eller Esc).
2. **Annan URL:** behåll centrerad popover men lägg till en rad ovanför textfältet: vyns titel/label + punktnummer (14px, grå #71717a), så det syns vilken punkt som redigeras.
3. Samma sak för Edit via radtexten. Ingen ändring av elementfångst eller datamodell.
4. **Testkrav:** i riktig Chrome: (a) Edit på sparad punkt när URL matchar → spökram synlig på rätt koordinater + popover förankrad vid den, försvinner vid Enter och Esc; (b) Edit när URL INTE matchar (pushState bort) → centrerad popover med vy-label + nummer; (c) befintliga v0.3-tester regresserar inte (kör åtminstone edit-current-mark och saved-edit-writes-queue igen).

---

# v0.4 — Reopen efter Finish

Henriks feedback: efter Finish finns inget sätt att återgå till redigering.

1. Finish-toasten får en tredje knapp: **Reopen** (samma rl-btn-stil som Copy JSON/Close). Klick: toasten tas bort och reviewen återöppnas med hela kön intakt (alla vyer + räknare + panel-tillgång), i browse-läge. Tekniskt: den finished-instansen river sig själv och kör om init-flödet (samma resume-väg som vid återinjicering, kön ligger redan i localStorage). Enklast: bryt ut init till en intern funktion eller låt Reopen göra teardown + köra en sparad kopia av hela IIFE:n är INTE rimligt — i stället: sätt finished = false, återskapa drawLayer/toolbar/marksLayer (de revs vid finish), läs INTE om kön från localStorage (views-arrayen finns kvar i minnet). Verifiera att event-lyssnare (urlTimer, keyboard) återaktiveras korrekt.
2. Konsollogg: `[redline] review reopened: N views, M marks`.
3. **Testkrav:** i riktig Chrome: Finish → Reopen → toolbar tillbaka med rätt räknare, markera en ny punkt, Finish igen → kön innehåller gamla + nya vyer; ingen dubblerad urlTimer/lyssnare (t.ex. räkna console-loggar vid URL-byte); Esc/kortkommandon fungerar efter Reopen.

---

# v0.5 — one-paste handoff (Copy agent prompt)

Henriks feedback: för många steg i delningen. Målet: EN kopiering → EN inklistring i mottagarens agent-CLI.

1. Finish-toasten får knappen **Copy agent prompt** som primär (före Copy JSON). Den kopierar en komplett engelsk prompt med kö-JSON:en inbäddad sist. Prompten instruerar mottagarens agent att:
   - Först fråga användaren: (a) implementera kön direkt, eller (b) öppna reviewen visuellt i användarens browser för triage först.
   - Vid (a): behandla varje item som en task (selector + styles + leaf/container + instruction), verifiera i browsern, och efteråt `localStorage.removeItem('redline.queue')`.
   - Vid (b): skriv JSON till localStorage i en flik som kör appen, hämta overlay.js från https://raw.githubusercontent.com/henrikhellstromgbg/redline/main/overlay.js och injicera INNEHÅLLET via Chrome MCP javascript_tool (inte script-tag, CSP), vänta på användarens Finish, läs om kön, kör (a).
   - Referens: https://github.com/henrikhellstromgbg/redline (AGENT.md).
2. Exponera promptbyggaren som `window.__redline.buildHandoffPrompt()` så agenter kan hämta den programmatiskt.
3. README: förenkla "Sharing a review" till det nya enstegsflödet (behåll manuella vägen som fallback).
4. Testkrav: buildHandoffPrompt() innehåller giltig JSON (JSON.parse på delen efter markören lyckas), rätt URL:er, och Copy agent prompt-knappen finns i toasten.
