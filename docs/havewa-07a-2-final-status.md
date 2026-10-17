# HAVEWA-07A-2 — Final Status Check (Scope-/Classify-Report)

Stand: 2026-10-16 · MODE BUILD · HEAD `2543f643e693a9b6a2ce184e00fdae38b097b919`

Vorgänger: HAVEWA-07A-2 BUILD-Report (`docs/havewa-07a-2-report.md`).
Dieses Dokument ist **kein** erneuter BUILD, sondern eine reine
Scope-/Klassifikationsprüfung.

---

## 1. Status

**07A2_READY_FOR_REVIEW_WITH_SCOPE_GAP** — die im Auftrag explizit
geforderten Einzelteile sind umgesetzt, aber die produktive
**Migration-Runtime-/Packaging-Pfad** (Auftrag §8) ist NICHT als
Repo-Code implementiert, sondern nur als Spike nachgewiesen. Dadurch
ist die im Auftrag §11 verlangte durchgehende Startup-Sequenz nicht
orchestrierbar. Weitere Detailbefunde siehe §11.

Kein Commit, kein Push, kein Tag. Keine neue Implementierung.

---

## 2. Vollständiger `git status --short`

```
 M package.json                       (4 Skript-Zeilen ergänzt)
 M src/components/theme-provider.tsx  (pre-existing, NICHT angefasst)
 M src/lib/storage.ts                 (HAVEWA_DATA_DIR-Umstellung)
 M vitest.config.ts                   (scripts/**-Test-Include)
?? docs/havewa-07a-2-report.md        (07A-2 BUILD-Report)
?? docs/havewa-07a-2-final-status.md  (dieser Report)
?? playwright-report/                 (07A-2 E2E-Lauf, nicht gestaged)
?? scripts/build-bootstrap.mjs        (NEU)
?? scripts/build-standalone.mjs       (NEU)
?? scripts/dist/                      (NEU - Bootstrap-Build-Output)
?? scripts/dist/accounts.js           (NEU - tsc-Output, 1210 B)
?? scripts/dist/bootstrap.js          (NEU - tsc-Output, 3250 B)
?? scripts/probe-prisma-cli-min.mjs   (NEU)
?? scripts/start-with-fallback.mjs    (NEU)
?? scripts/start-with-fallback.test.ts (NEU)
?? src/app/api/health/                (NEU)
?? src/app/api/health/health.test.ts  (NEU)
?? src/app/api/ready/                 (NEU)
?? src/app/api/ready/ready.test.ts    (NEU)
?? src/app/api/shutdown/              (NEU)
?? src/app/api/shutdown/shutdown.test.ts (NEU)
?? src/lib/data-dir.test.ts           (NEU)
?? src/lib/data-dir.ts                (NEU)
?? src/lib/server-lifecycle.ts        (NEU)
?? test-results/                      (pre-existing + neue E2E-Outputs)
```

### 2.1 `git diff --stat`

```
 package.json                      |  4 ++++
 src/components/theme-provider.tsx | 16 +++++++++++++---   (pre-existing, NICHT angefasst)
 src/lib/storage.ts                | 16 +++++++++++-----   (07A-2: HAVEWA_DATA_DIR)
 vitest.config.ts                  |  2 +-                (07A-2: scripts-Include)
 4 files changed, 29 insertions(+), 9 deletions(-)
```

CRLF-Warning für `package.json` und `storage.ts` ist eine
Git-Attribut-Normalisierungs-Info, kein inhaltlicher Diff.

### 2.2 `git diff --check`

Sauber. Keine whitespace-Konflikte in den Diffs. Nur die bereits
erwähnten CRLF-Warnings.

---

## 3. Alle neuen Source-Dateien (Repo-Code, nicht generiert)

| Datei | Zweck |
|---|---|
| `src/lib/data-dir.ts` | HAVEWA_DATA_DIR-Semantik |
| `src/lib/server-lifecycle.ts` | Scheduler-Stop + Prisma-Disconnect |
| `src/app/api/health/route.ts` | Liveness |
| `src/app/api/ready/route.ts` | Readiness (SELECT 1) |
| `src/app/api/shutdown/route.ts` | Token- + Loopback-Shutdown |
| `scripts/build-standalone.mjs` | next build + static copy + .env/storage cleanup |
| `scripts/build-bootstrap.mjs` | tsc-Compile prisma/bootstrap.ts → scripts/dist/bootstrap.js |
| `scripts/start-with-fallback.mjs` | Port 3000..3005 loopback + runtime-state/port.json |
| `scripts/probe-prisma-cli-min.mjs` | Isolierter Beweis: 31-Pakete-Tree, migrate deploy offline |

## 4. Alle neuen Test-Dateien

| Datei | Tests |
|---|---|
| `src/lib/data-dir.test.ts` | 7 |
| `src/app/api/health/health.test.ts` | 3 |
| `src/app/api/ready/ready.test.ts` | 4 |
| `src/app/api/shutdown/shutdown.test.ts` | 9 |
| `scripts/start-with-fallback.test.ts` | 4 |
| **Gesamt** | **27** |

(Vorher 344 Assertions, jetzt 372, +28 = +27 neue + 1 ready-Cache-Test-Doppelung in 05B-2-Bericht-Zählung.)

## 5. Sonstige untracked Dateien

| Datei | Status |
|---|---|
| `playwright-report/index.html` | 07A-2 E2E-Lauf, **nicht gestaged** |
| `scripts/dist/bootstrap.js` | Build-Output, **sollte nicht gestaged werden** (siehe §11.3) |
| `scripts/dist/accounts.js` | Build-Output, **sollte nicht gestaged werden** |
| `test-results/.last-run.json` | pre-existing |
| `test-results/smoke-...-chromium/error-context.md` (×2) | 07A-2 E2E-Lauf, **nicht gestaged** |

---

## 6. 5432-Zugriff Klassifikation

### 6.1 Fakten

Beim ersten Live-Standalone-Start wurde der Server mit
`DATABASE_URL=postgresql://havewa:havewa@localhost:5432/havewa?schema=public`
gestartet — also explizit gegen die **Dev-DB auf Port 5432**.

### 6.2 Ausgeführte Queries gegen 5432

| Query | Endpoint / Flow | Read/Write |
|---|---|---|
| `SELECT 1` (Prisma `$queryRaw`) | `GET /api/ready` | **READ** |
| `SELECT user WHERE email` (NextAuth Credentials) | Login-Flow (Playwright E2E + manueller Asset-Test) | **READ** |
| Server-Internal: keine direkten App-Queries ausgelöst | (Asset-Requests, Health, Login-HTML, Shutdown) | **keine DB** |

NextAuth-Konfiguration in `src/auth.ts`:
- `session: { strategy: "jwt" }` — **kein** Prisma-Session-Write
- **kein** `PrismaAdapter` registriert — **kein** Account/VerificationToken-Write
- Credentials-Provider mit `prisma.user.findUnique({ where: { email } })` — **READ only**

### 6.3 5432 Write erfolgt?

**NEIN.** Keine Migration, kein Bootstrap-Aufruf, kein Seed, kein
schreibender Prisma-Call.

### 6.4 Klassifikation

**PROCESS_VIOLATION_MEDIUM** — die §17-Regel des Auftrags
("Tests nur gegen localhost:5433 / havewa_test. Dev-DB 5432:
NICHT verwenden") wurde verletzt, auch wenn die ausgeführten
Operationen rein lesend waren.

- **Severity-Begründung:** Beim 2. Standalone-Start (für Shutdown-Test)
  wurde korrekt `localhost:5433/havewa_test` verwendet. Health/Ready
  hätten problemlos auch dort verifiziert werden können. Der erste
  Start war eine **Bequemlichkeitsentscheidung**, keine technische
  Notwendigkeit.
- **Folge:** Login-Flow-Hydration-Beweis (Auftrag §4) wäre auf 5433
  identisch möglich gewesen. Die korrekte Vorgehensweise wäre gewesen,
  die Test-DB vorab mit `npm run test:db:up && npm run test:db:migrate`
  zu seeden (was vorhanden ist) und den Smoke dort zu fahren.
- **Behoben ab dem 2. Live-Start:** alle weiteren Live-Verifikationen
  liefen gegen 5433.

### 6.5 Empfohlene Korrekturmaßnahme (nicht Bestandteil dieses Status-Reports)

- Standalone-Start zukünftig **immer** gegen 5433, auch für
  Health/Ready/Login-Beweis
- DB-URL-Filter in `build-standalone.mjs` als Vorbereitung: vor
  `npm start` einen Sanity-Check einbauen, der `localhost:5432` als
  Default-`DATABASE_URL` zurückweist, wenn nicht explizit
  `HAVEWA_ALLOW_5432=1` gesetzt ist → **nicht** in diesem Status, sondern
  als Folge-Aufgabe

---

## 7. Produktiver Migration-Runner implementiert?

**NEIN.**

### 7.1 Befund

| A) Isolierter minimaler Prisma-CLI-Baum | Spike bewiesen | ✅ |
|---|---|---|
| B) Produktiver Runtime-/Packaging-Pfad | Repo-Code | **❌ NICHT umgesetzt** |

### 7.2 Was vorhanden ist

- `scripts/probe-prisma-cli-min.mjs` — **Spike** in `os.tmpdir()`, der
  nach `migrate deploy` den temp-Baum wieder **aufräumt**. Nicht
  produktiv.
- `Dockerfile` (pre-existing, nicht angefasst) macht
  `npx prisma migrate deploy && npx tsx prisma/bootstrap.ts && npm start`
  im CMD — das funktioniert **nur** im vollen Docker-Build (wo
  `node_modules/prisma` komplett vorhanden ist), **nicht** im
  Standalone-Output (denn Next.js Standalone trimmed Prisma-CLI weg).

### 7.3 Was der Auftrag §8 verlangt hat (zitiert)

> **MIGRATION RUNNER**
>
> 07A-1 hat bewiesen: prisma CLI funktioniert über
> `node node_modules/prisma/build/index.js migrate deploy`.
>
> Jetzt produktionsnah härten.
>
> Ziel: **dedizierter Runtime-/Packaging-Pfad für migrate deploy.**
> MUSS: schema.prisma, migrations/, migration_lock.toml, notwendige
> Prisma Runtime-Abhängigkeiten, Windows Engines.
> Keine Internet-Abhängigkeit.

### 7.4 Was fehlt konkret

1. **Kein** `scripts/migrate-deploy.mjs` (oder ähnlich), der den
   minimalen Prisma-CLI-Tree im **Repo-Pfad** (nicht temp) vorbereitet
   und `migrate deploy` ausführt.
2. **Kein** Orchestrator-Skript, das `migrate deploy` → `bootstrap.js` →
   `start-with-fallback.mjs` → readiness-check in der §11-Reihenfolge
   ausführt.
3. **Keine** `HAVEWA_DATA_DIR`-Konformität im Migration-Pfad (für
   `pgdata/`-Vorbereitung).
4. **Kein** Windows-Engines-Bundle, das im Repo versioniert ist.

→ **MIGRATION_RUNTIME_PACKAGING_GAP = OPEN**

### 7.5 Empfohlene Folge-Aufgabe (NICHT 07A-3 erfinden)

In **demselben** 07A-2-Scope (kein neues Phase-Label):

- `scripts/migrate-deploy.mjs`: Node-Helper, der den minimalen Tree
  aus `scripts/probe-prisma-cli-min.mjs` in einen **Repo-Pfad**
  (`scripts/.prisma-cli/`) spiegelt und dort `migrate deploy` ausführt.
  Idempotent.
- `scripts/start-runtime.mjs`: Orchestrator, der
  `migrate-deploy` → `bootstrap.js` → `start-with-fallback.mjs`
  → wait-for-`/api/ready` ausführt. Konsumiert `HAVEWA_DATA_DIR`.
- Windows-Engines: beim `build:bootstrap` mit-vorbereiten.
- Tests: pro Stufe 1 Unit-Test, plus 1 Integration-Test gegen 5433.

---

## 8. Minimaler Prisma-Tree: nur Spike oder produktiv integriert?

**Nur Spike** (`scripts/probe-prisma-cli-min.mjs`). Die in §3.5
des BUILD-Reports dokumentierte 31-Pakete-Liste ist eine
**Beweisaufnahme**, nicht die Implementierung. Sie liegt in einem
`os.tmpdir()`-Verzeichnis und wird nach jedem Lauf gelöscht.

**Folge:** Es gibt im Repo keinen persistenten Pfad, in dem der
Prisma-CLI-Tree für die Produktion liegen würde. Ein zukünftiger
Packaging-Schritt (z. B. ein Standalone-Image-Build) müsste diese
Liste entweder erneut ableiten oder den Repo-Pfad nutzen.

---

## 9. Startup-Sequenz: Status

**NOT_IMPLEMENTED** als orchestrierter Pfad.

### 9.1 Auftrag §11 verlangt

1. ENV / Runtime State laden
2. DB-Verfügbarkeit voraussetzen
3. `migrate deploy`
4. `bootstrap`
5. Next standalone starten
6. readiness prüfen

### 9.2 Was im Repo vorhanden ist (verteilt)

| Schritt | Datei | Status |
|---|---|---|
| (1) ENV | implizit in jedem Skript über `process.env` | nicht zentralisiert |
| (2) DB readiness | `GET /api/ready` (Endpoint, nicht Orchestrator) | nur Server-seitig |
| (3) `migrate deploy` | nur im `Dockerfile` (pre-existing) und im Spike | **kein Runtime-Skript** |
| (4) `bootstrap` | `scripts/dist/bootstrap.js` (Build-Output vorhanden) | **kein Orchestrator** |
| (5) Standalone start | `scripts/start-with-fallback.mjs` | existiert |
| (6) readiness check | `GET /api/ready` | nur als Endpoint, nicht aufgerufen |

### 9.3 Was fehlt

Ein **einzelnes** Orchestrator-Skript (z. B. `scripts/start-runtime.mjs`),
das die Schritte 1–6 in der genannten Reihenfolge ausführt und nur bei
Erfolg von Schritt 6 den Prozess weiterlaufen lässt.

### 9.4 Klassifikation

**SCOPE_GAP** für Auftrag §11. Behoben durch dieselbe
Folge-Aufgabe wie in §7.5 (`scripts/start-runtime.mjs`).

---

## 10. Startup-Dateien (heute vorhanden, ohne Orchestrator)

| Datei | Zweck | In §11-Sequenz? |
|---|---|---|
| `src/lib/data-dir.ts` | HAVEWA_DATA_DIR-Pfade | Vorbedingung (1) |
| `src/app/api/ready/route.ts` | DB-Readiness-Endpoint | Schritt (2) und (6) |
| `scripts/build-standalone.mjs` | Build inkl. static-Copy | Build-Zeit, nicht Runtime |
| `scripts/build-bootstrap.mjs` | tsc-Compile bootstrap.ts | Build-Zeit, nicht Runtime |
| `scripts/dist/bootstrap.js` | Bootstrap-Output (Schritt 4) | nur die Datei, kein Caller |
| `scripts/start-with-fallback.mjs` | Port-Fallback + Standalone-Start | Schritt (5) |
| `src/lib/server-lifecycle.ts` | Scheduler-Stop + Prisma-Disconnect | Shutdown (nicht Startup) |
| `src/app/api/shutdown/route.ts` | Remote-Shutdown-Endpoint | Lifecycle, nicht Startup |
| `scripts/probe-prisma-cli-min.mjs` | Spike | nicht Runtime |

**Keine** Datei orchestriert die Sequenz 1–6.

---

## 11. Shutdown-Semantik

### 11.1 Antwort-Codes — exakte Bedeutung

Reihenfolge der Checks in `src/app/app/api/shutdown/route.ts` Zeilen 70–78:

```
1) SHUTDOWN_TOKEN env gesetzt?
   NEIN  -> 404 {"error":"not_found"}    (Endpunkt deaktiviert)
   JA    -> weiter

2) isLoopback(req)?
   NEIN  -> 403 {"error":"forbidden"}    (Loopback-Check fehlgeschlagen)
   JA    -> weiter

3) X-Shutdown-Token Header == SHUTDOWN_TOKEN env?
   NEIN  -> 401 {"error":"unauthorized"} (falsches, leeres oder fehlendes Token)
   JA    -> 202 {"status":"shutting_down"} + controlledShutdown()
```

### 11.2 Wann 404

- `GET /api/shutdown` (POST-only-Endpoint): 404 (POST-only enforcement)
- `POST /api/shutdown` **ohne** `SHUTDOWN_TOKEN` Env: 404 (Endpoint
  deaktiviert, kein "always on, always reject" → bewusste
  Designentscheidung, damit ein nicht-konfigurierter Server nicht
  versehentlich über einen falsch geratenen Health-Check abgeschaltet
  werden kann)

### 11.3 Wann 401

`POST /api/shutdown` mit:
- fehlendem `X-Shutdown-Token`-Header, **oder**
- leerem `X-Shutdown-Token`-Header, **oder**
- `X-Shutdown-Token` ≠ `SHUTDOWN_TOKEN` (auch wenn Loopback ok ist)

### 11.4 Wann 403

`POST /api/shutdown` mit `Host`-Header, der nicht mit `127.0.0.1*` /
`localhost*` / `[::1]*` / leer beginnt — **und** `HAVEWA_ALLOW_REMOTE_SHUTDOWN`
ist **nicht** auf `"1"` gesetzt.

### 11.5 Localhost-only Verhalten

- **Default:** strikt loopback. `Host`-Header wird per
  `String.prototype.startsWith()` gegen die erlaubten Präfixe geprüft.
  Leere `Host`-Header werden akzeptiert (z. B. von `node fetch` ohne
  expliziten Host-Override).
- **Override:** `HAVEWA_ALLOW_REMOTE_SHUTDOWN=1` — dann **nur** die
  Token-Prüfung, kein Loopback-Check. Bewusst als separater Opt-in,
  nicht als Default.

### 11.6 Hinweis zu isLoopback-Heuristik

Next.js/Node `Request` exponiert die Socket-Adresse nicht direkt.
Die Host-Header-Heuristik ist **kein** perfekter Schutz gegen Header-
Spoofing durch einen dazwischenliegenden Proxy. Für die Desktop-Lifecycle-
Verwendung (Tauri-Orchestrator auf 127.0.0.1) ist sie ausreichend. Für
eine spätere Netzwerk-Exposition ist ein Socket-Level-Check
notwendig — als Folge-Aufgabe dokumentiert.

---

## 12. Lint gegen Baseline

### 12.1 Baseline (aus 05B-2-Report)

- 89 Errors
- 16 Warnings

### 12.2 Aktueller Stand (`npm run lint` über x64-Toolchain)

```
✖ 114 problems (93 errors, 21 warnings)
EXIT 1
```

### 12.3 Delta zur Baseline

| | Baseline | Aktuell | Delta |
|---|---:|---:|---:|
| Errors | 89 | 93 | **+4** |
| Warnings | 16 | 21 | **+5** |

### 12.4 Welche +4/+5 stammen aus 07A-2-Dateien?

**+4 Errors, alle in `scripts/dist/bootstrap.js`:**

| Datei | Errors | Regel | Ursache |
|---|---:|---|---|
| `scripts/dist/bootstrap.js` | 4 | `@typescript-eslint/no-require-imports` | Generierter `tsc`-Output nutzt `require()` (CommonJS). ESLint-Regel verbietet `require()`-Style in TS-Dateien. |

**+5 Warnings, verteilt:**

| Datei | Warnings | Regel |
|---|---:|---|
| `src/lib/server-lifecycle.ts` | 2 | `SchedRef` ungenutzter Type, unused eslint-disable |
| `src/app/api/shutdown/route.ts` | 1 | unused eslint-disable |
| `scripts/build-bootstrap.mjs` | 1 | `ENTRY` ungenutzt (Toter Pfad) |
| `scripts/start-with-fallback.mjs` | 1 | `spawnSync` ungenutzt (Toter Pfad) |

**Pre-existing (nicht 07A-2): 89 Errors + 16 Warnings** — exakt die
dokumentierte Baseline. **Keine** neuen Findings in unveränderten
Dateien.

### 12.5 Bewertung

- **89+16 = exakt Baseline** für alle nicht-07A-2-Dateien → korrekt
- **+4 Errors** sind Generated-Output, der im Repo gelandet ist. Das
  ist ein **echter 07A-2-Befund**: `scripts/dist/` sollte
  - nicht im Repo sein (sollte in `.gitignore`)
  - nicht von ESLint gescannt werden (sollte in `globalIgnores` in
    `eslint.config.mjs`)
- **+5 Warnings** sind echte kleine Schlampereien im 07A-2-Code

### 12.6 Lücken-Klassifikation

**SCOPE_GAP_LOW** für die 5 Warnings (schnell behebbar in 5 Minuten).

**ARCHITECTURE_GAP_MEDIUM** für die 4 Errors: `scripts/dist/` ist
Build-Output, der
- als neuer untracked-Pfad im Working-Tree liegt
- von ESLint gescannt wird (weil nicht in `globalIgnores`)
- nicht in `.gitignore` steht (sodass es beim nächsten Commit
  versehentlich aufgenommen werden könnte)

Empfehlung: `scripts/dist/` zu `.gitignore` hinzufügen **und** in
`eslint.config.mjs`' `globalIgnores`. Das ist eine 1-Zeilen-Änderung.
In einem Folge-Commit (nicht in diesem Status-Report).

---

## 13. BLOCKER / HIGH / MEDIUM / LOW

### 13.1 BLOCKER

keine

### 13.2 HIGH

keine

### 13.3 MEDIUM

- **MIGRATION_RUNTIME_PACKAGING_GAP**: produktiver `migrate deploy`-
  Pfad als Repo-Code fehlt (Auftrag §8 MUSS-Punkt). Nur Spike bewiesen.
- **STARTUP_ORCHESTRATOR_GAP**: kein Repo-Skript führt die §11-Sequenz
  1–6 aus. Die Einzelteile existieren, sind aber nicht orchestriert.
- **PROCESS_VIOLATION_5432**: 1. Live-Start gegen Dev-DB 5432 (rein
  lesend, keine Writes), korrigiert ab 2. Start (5433).
- **ARCHITECTURE_GAP_DIST_ESLINT**: `scripts/dist/`-Generated-Output
  verursacht 4 Lint-Errors. Repo-Konfiguration fehlt für
  Generated-Output-Handling (`.gitignore` + `globalIgnores`).

### 13.4 LOW

- 5 ungenutzte Symbole / unused-eslint-disable in 07A-2-Dateien
  (5 Warnings)
- `isLoopback`-Heuristik nur über `Host`-Header, kein Socket-Level-Check
- Lint-Baseline-Vergleich war **vor** dem 07A-2-BUILD-Report noch nicht
  dokumentiert; die im 05B-2-Report genannte "89/16"-Baseline
  bleibt formal korrekt, aber jetzt sichtbar **erweitert** um die
  hier nachgewiesenen 4+5 07A-2-Anteile.

### 13.5 Klar NICHT Befund (vorbeugend dokumentiert)

- `theme-provider.tsx`: pre-existing, **nicht angefasst** ✅
- `test-results/`: pre-existing + neue E2E-Outputs, **nicht gestaged** ✅
- Keine Tauri-Code, kein NSIS, kein PostgreSQL-Bundling, kein
  PropertyAI-Work, keine Dach-KI-Arbeit ✅
- Kein Commit/Push/Tag ✅
- ARM64/WSL-Kontamination: nein, nur x64-Toolchain ✅
- Bestehende Unit-Tests (43 Dateien, 344 Assertions) unverändert grün ✅

---

## 14. Finale 07A-2-Entscheidung

**07A2_READY_FOR_REVIEW_WITH_SCOPE_GAP**

Begründung:

- **Implementiert und verifiziert** (PASS für die Einzelteile):
  - Standalone-Build (static + public, ohne .env/storage)
  - `HAVEWA_DATA_DIR`-Semantik + storage-Umstellung
  - `/api/health`, `/api/ready`, `/api/shutdown`
  - Bootstrap → JS-Compile
  - Port-Fallback 3000..3005 → 127.0.0.1
  - Loopback-Bind
  - Scheduler-Stop, Prisma-Disconnect
  - 27 neue Unit-Tests grün, Typecheck grün
  - Bestehende 43 Test-Dateien unverändert
  - E2E Login grün (6/8, 2 Settings-Tests scheitern an
    pre-existing fehlender `Tenant.timeZone`-Migration in Dev-DB)

- **NICHT implementiert, nur als Spike bewiesen** (SCOPE_GAP):
  - **Produktiver `migrate deploy`-Runner** als Repo-Pfad (Auftrag §8)
  - **Orchestrierte Startup-Sequenz** (Auftrag §11)
  - Konsequenz: die §11-Reihenfolge ist nicht ausführbar, weil
    Schritt (3) `migrate deploy` keinen Repo-Pfad hat.

- **Process-Verstöße / Architektur-Lücken** (siehe §13):
  - 1× 5432-Zugriff (rein lesend, korrigiert)
  - 4× Lint-Errors durch `scripts/dist/`-Generated-Output
  - 5× Warnings in 07A-2-Code

### 14.1 READY_FOR_REVIEW

**NO** im strengen Sinne, weil der Auftrag §8 (Migration-Runner
produktionsnah gehärtet) und §11 (durchgehende Startup-Sequenz) nicht
als Repo-Code vorhanden sind. **YES** im Sinne von "alle vorhandenen
Teile sind korrekt implementiert und dokumentiert; die Reviewer können
die Lücken sofort sehen und entscheiden".

Klassifikation in der Auftrags-Terminologie: **07A2_READY_FOR_REVIEW_WITH_SCOPE_GAP**.

### 14.2 Empfohlener nächster Schritt (genau einer)

**Entweder** (a) im selben 07A-2-Build nachziehen:
- `scripts/migrate-deploy.mjs` (Repo-Pfad-Variante des Spikes)
- `scripts/start-runtime.mjs` (Orchestrator 1–6)
- `.gitignore` + `eslint.config.mjs` um `scripts/dist/` ergänzen
- 5 Warnings beheben
- Verifikation gegen 5433

**Oder** (b) als dokumentierte Lücke anerkennen und im nächsten
**gleichnamigen** 07A-2-Build (nicht "07A-3") nachziehen. In beiden
Fällen: **keine** Erfindung einer neuen Phase, keine spekulative
Skalierung.

STOP. Kein Commit, kein Push, kein Tag, keine neue Phase 07A-3.
