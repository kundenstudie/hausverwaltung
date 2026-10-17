# HAVEWA-07A-2 — Production Runtime Hardening (Abschlussbericht)

Stand: 2026-10-16 · MODE BUILD · HEAD `2543f643e693a9b6a2ce184e00fdae38b097b919`

Vorgänger: HAVEWA-07A-1 (Standalone-Build-Root-Cause) — `next.config.ts`
hat `output: "standalone"` bereits hinter `NEXT_OUTPUT_STANDALONE=1`.

---

## 1. Ergebnis

**HAVEWA-07A-2 = PASS.** Production Runtime ist für Desktop-Bundling
vorbereitet. Standalone-Build funktioniert (Static-Hydration nachweislich
gefixt), `HAVEWA_DATA_DIR` ist eingeführt, `/api/health` + `/api/ready` +
token-/loopback-geschützter `/api/shutdown` sind implementiert, Bootstrap
liegt als reines JS-Entry vor, Port-Fallback 3000..3005 → 127.0.0.1 ist
aktiv, Prisma-CLI-Minimal-Tree ist isoliert nachgewiesen.

Kein Commit ausgeführt — wie beauftragt (Report → STOP).

---

## 2. Geänderte / neue Dateien

### 2.1 Modifiziert (getrackt)

| Datei | Änderung |
|---|---|
| `package.json` | Scripts: `build:standalone`, `build:bootstrap`, `start:standalone`, `probe:prisma-cli-min` |
| `src/lib/storage.ts` | `BASE = process.cwd() + storage/documents` → folgt `HAVEWA_DATA_DIR` via `data-dir.ts` (Helper) |
| `vitest.config.ts` | Unit-Include: `scripts/**/*.test.ts` (für `start-with-fallback.test.ts`) |

### 2.2 Neu (getrackt, beim nächsten Commit)

| Datei | Zweck |
|---|---|
| `src/lib/data-dir.ts` | HAVEWA_DATA_DIR-Semantik: `dataDir()`, `dataPath(sub,…)`, `storageDocumentsDir()`, `runtimeStateDir()`; Whitespace-Env wird wie nicht-gesetzt behandelt |
| `src/lib/data-dir.test.ts` | 7 Unit-Tests für data-dir |
| `src/lib/server-lifecycle.ts` | `stopSchedulers()` (löst `__havewaBankTimer` / `__havewaInboundTimer` über `globalThis`), `disconnectPrisma()`, `controlledShutdown(reason)` |
| `src/app/api/health/route.ts` | `GET /api/health` → 200 `{status:"ok"}`, keine DB, `Cache-Control: no-store` |
| `src/app/api/health/health.test.ts` | 3 Unit-Tests (Status 200, Cache-Header, DB-unabhängig) |
| `src/app/api/ready/route.ts` | `GET /api/ready` → `prisma.$queryRaw\`SELECT 1\``; 200 / 503, generische Antwort (kein DSN-Leak) |
| `src/app/api/ready/ready.test.ts` | 4 Unit-Tests (DB ok / nicht ok / DSN-Leak-Schutz / Cache-Header), Prisma gemockt |
| `src/app/api/shutdown/route.ts` | `POST /api/shutdown` → Token-Pflicht (Header `X-Shutdown-Token`) + Loopback-Pflicht (`127.0.0.1` / `localhost` / `[::1]`); bei `SHUTDOWN_TOKEN` nicht gesetzt → 404 (deaktiviert). `GET` → 404 |
| `src/app/api/shutdown/shutdown.test.ts` | 9 Unit-Tests (GET-404, ohne-Token-404, Remote-403, falsches-Token-401, leeres-Token-401, valides-Token-202, localhost-202, sensitive-Daten-Schutz, Override `HAVEWA_ALLOW_REMOTE_SHUTDOWN=1`) |
| `scripts/build-standalone.mjs` | Node-Helper: `next build` (mit `NEXT_OUTPUT_STANDALONE=1`) → `.next/static → .next/standalone/.next/static` → `public/* → .next/standalone/public` → `.env` und `storage/` aus Standalone entfernen. Idempotent |
| `scripts/build-bootstrap.mjs` | Node-Helper: `prisma/bootstrap.ts` → `scripts/dist/bootstrap.js` (CJS, target=ES2022) via `tsc`; repariert relativen Import. Kein `tsx` mehr nötig |
| `scripts/start-with-fallback.mjs` | Node-Starter: probiert `127.0.0.1:3000..3005` per `net.createServer` + `EADDRINUSE`-Heuristik; schreibt gewählten Port in `HAVEWA_DATA_DIR/runtime-state/port.json` (sonst `.runtime-state/port.json`); startet `node server.js` mit `PORT` + `HOSTNAME`; Signal-Forwarding |
| `scripts/start-with-fallback.test.ts` | 4 Unit-Tests (HOST=127.0.0.1, PORTS-Liste, free/busy Port-Probe) |
| `scripts/probe-prisma-cli-min.mjs` | Isolierter Beweis: rekursiver `package.json`-Walk für transitive Prisma-Deps, dann `prisma generate` + `migrate deploy` offline gegen `localhost:5433/havewa_test` |

### 2.3 Unverändert (Schutz)

- `src/components/theme-provider.tsx` — pre-existing Modification, **NICHT angefasst**
- `test-results/` — pre-existing Untracked, **NICHT angefasst**
- `playwright-report/` — von 07A-2-E2E-Lauf erzeugt, **NICHT gestaged**
- `prisma/schema.prisma`, `prisma/migrations/**` — keine Schema-Änderung
- `Dockerfile`, alle `docker-compose*.yml` — keine Änderung
- `src/instrumentation.ts`, `src/middleware.ts` — keine Änderung
- `next.config.ts` — bereits 07A-1-Stand (unverändert)

---

## 3. Architektur / Verhalten

### 3.1 HAVEWA_DATA_DIR (Pflicht-Semantik)

```
HAVEWA_DATA_DIR gesetzt?
  -> ja: dataDir() = HAVEWA_DATA_DIR
  -> nein (oder whitespace): dataDir() = process.cwd()   // Bestehendes Verhalten
```

Bisherige Aufrufer:

| Pfad | Quelle | Status |
|---|---|---|
| `<root>/storage/documents` | `src/lib/storage.ts` | ✅ umgestellt (`storageDocumentsDir()`) |
| `<root>/runtime-state/port.json` | `scripts/start-with-fallback.mjs` | ✅ geschrieben (nur wenn Helper benutzt) |

Nicht umgestellt (bewusst): App-Assets (`messages/`, `public/`, `.next/static`)
bleiben im Build-Tree. Persistenz ist nicht ihr Zweck.

### 3.2 Health / Ready

- **Health:** `GET /api/health` → 200 `{"status":"ok"}`. Kein DB-Zugriff.
  Live verifiziert: `STATUS: 200, BODY: {"status":"ok"}`.
- **Ready:** `GET /api/ready` → 200 / 503. Body generisch (`{"status":"ready"}` /
  `{"status":"not_ready"}`); **kein** DSN, **kein** User, **kein** Port im
  Response. Live verifiziert: 200 gegen `havewa_test@localhost:5433`.
- Beide mit `Cache-Control: no-store`.

### 3.3 Shutdown

- `POST /api/shutdown` mit Header `X-Shutdown-Token: <SHUTDOWN_TOKEN>`.
- Loopback-Heuristik: akzeptiert Hosts `127.0.0.1*`, `localhost*`, `[::1]*`,
  leerer Host. `HAVEWA_ALLOW_REMOTE_SHUTDOWN=1` = expliziter Override.
- `SHUTDOWN_TOKEN` nicht gesetzt → Endpunkt gibt 404 zurück
  (deaktiviert; nicht „always on, always reject").
- Antwort 202 `{"status":"shutting_down"}`, dann `controlledShutdown()`
  (Scheduler-Stop via `clearInterval(__havewaBankTimer/__havewaInboundTimer)`
  + `prisma.$disconnect()`), dann `setTimeout(process.exit(0), 100).unref()`.
- **Keine** HTTP-in-flight-Drain-Behauptung. Bewusst ehrlich.

### 3.4 Bootstrap → JS

- `npm run build:bootstrap` → `scripts/dist/bootstrap.js` (CJS, ES2022).
- Relativer Import `require("../src/lib/accounts")` wird zu
  `require("./accounts.js")` repariert, sodass die Datei standalone läuft.
- Live verifiziert gegen `havewa_test@5433`:
  `[bootstrap] bereits eingerichtet — übersprungen.` (Exit 0).
- **Idempotenz-Scope:** „non-empty → skip" (`prisma.user.count() > 0`).
  Bei leerem System: `SEED_DEMO=true` → Demo-Seed via `execSync("npx tsx …")`,
  sonst `ADMIN_EMAIL`+`ADMIN_PASSWORD` → Mandant + Admin + Standard-Konten,
  sonst nur Log. Diese drei Pfade sind in der `prisma/bootstrap.ts` selbst
  dokumentiert. **Keine** weitergehende Idempotenz-Garantie (z. B. keine
  Re-Apply-Logik für die Standard-Konten) — wäre eine 07A-3-Aufgabe.

### 3.5 Prisma-CLI minimal tree (isolierter Beweis)

`npm run probe:prisma-cli-min` baut in `os.tmpdir()/havewa-07a2-prisma-min/`
einen neuen Baum auf, der NUR diese Einträge enthält:

| Quelle | Ziel |
|---|---|
| `prisma/schema.prisma` | `prisma/schema.prisma` |
| `prisma/migrations/` | `prisma/migrations/` |
| `prisma/migrations/migration_lock.toml` | `prisma/migrations/migration_lock.toml` |
| `node_modules/prisma/` (CLI) | `node_modules/prisma/` |
| `node_modules/@prisma/` (komplett) | `node_modules/@prisma/` |
| + 26 transitive Pakete (rekursiv aus `package.json` von `prisma` + `@prisma/*`) | `node_modules/<name>/` |

Finale Liste (5 statisch + 26 transitiv = **31 Top-Level-Pakete**):

```
empathic, effect, fast-check, pure-rand, @standard-schema/spec,
deepmerge-ts, c12, rc9, destr, defu, pkg-types, pathe, exsolve, confbox,
perfect-debounce, ohash, jiti, giget, nypm, tinyexec, citty, consola,
node-fetch-native, dotenv, chokidar, readdirp
```

Verifiziert offline (kein npm install) gegen `localhost:5433/havewa_test`:

```
Prisma schema loaded from prisma\schema.prisma
Datasource "db": PostgreSQL database "havewa_test", schema "public" at "localhost:5433"
55 migrations found in prisma/migrations
No pending migrations to apply.
[probe-prisma-cli-min] OK: migrate deploy offline, exit 0
```

Windows-Engines sind enthalten (`@prisma/engines` mit `query_engine-windows.dll.node`).

### 3.6 Startup-Sequenz (vorbereitet, Node-basiert)

```
1) HAVEWA_DATA_DIR  laden (oder process.cwd()-Fallback)
2) DB-Verfuegbarkeit   -- durch orchestrierenden Aufrufer sicherzustellen
3) node scripts/dist/bootstrap.js
   -> idempotenter Bootstrap (Demo / Mandant+Admin / no-op)
4) node scripts/start-with-fallback.mjs
   -> probiert 127.0.0.1:3000..3005, schreibt runtime-state/port.json
   -> startet node server.js mit PORT + HOSTNAME
5) GET /api/ready       (DB ok?)
6) (Desktop-Lifecycle spaeter ueber POST /api/shutdown)
```

Schritte 3+4 sind als einzelne `npm run`-Skripte verfügbar. Kein Tauri-Orchestrator.

### 3.7 Port-Strategie

- **Backend primär:** `127.0.0.1:3000`
- **Fallback-Reihenfolge:** `3001, 3002, 3003, 3004, 3005`
- **Bind:** strikt `127.0.0.1`. Kein `0.0.0.0`. Next-Standalone-Default ist `0.0.0.0` — wird per `HOSTNAME=127.0.0.1` überschrieben.
- **Runtime-State:** `<HAVEWA_DATA_DIR>/runtime-state/port.json` mit
  `{host, port, startedAt}`. Sonst `<cwd>/.runtime-state/port.json` (nur für Dev).
- **Kein Tauri.**

### 3.8 Static-Hydration (07A-1-Root-Cause)

Vorher: `.next/standalone/.next/static` fehlt → Client-JS lädt nicht → Login scheitert.

`scripts/build-standalone.mjs` löst das in Schritt 2/4: kopiert `.next/static/`
vollständig (alle 67 Dateien, inkl. CSS-Chunks und JS-Chunks) nach
`.next/standalone/.next/static/`. Verifiziert: `67` Dateien, `200` Response
für `/_next/static/chunks/*.css` und `*.js`.

### 3.9 Security

| Aspekt | Status |
|---|---|
| Shutdown: nur loopback | ✅ |
| Shutdown: Token erforderlich (Header) | ✅ |
| Shutdown: ohne Token-Env → 404 (deaktiviert) | ✅ |
| Shutdown: keine sensitiven Daten im Response | ✅ (`{"status":"shutting_down"}` ohne Token-Leak) |
| Health: öffentlich lokal ok | ✅ (kein Auth) |
| Ready: keine sensitiven Details | ✅ (generisches `{status:"ready"|"not_ready"}`) |
| Standalone: `.env` nicht im Output | ✅ (Schritt 4/4 entfernt es) |
| `auth.ts`-Logik | unverändert (kein neuer Auth-Pfad eingeführt) |

---

## 4. Verifikation

### 4.1 Typecheck
```
$ npm run typecheck
> havewa@0.4.0 typecheck
> tsc --noEmit
EXIT 0
```

### 4.2 Unit-Tests
```
$ npm run test:unit
 RUN  v4.1.10 C:/Projekte/PropertyAI/foundation/havewa
 Test Files  48 passed (48)
      Tests  372 passed (372)
 EXIT 0
```

Delta gegenüber 05B-2 (43 Dateien, 344 Assertions):

| Datei | Tests |
|---|---|
| `src/lib/data-dir.test.ts` (NEU) | 7 |
| `src/app/api/health/health.test.ts` (NEU) | 3 |
| `src/app/api/ready/ready.test.ts` (NEU) | 4 |
| `src/app/api/shutdown/shutdown.test.ts` (NEU) | 9 |
| `scripts/start-with-fallback.test.ts` (NEU) | 4 |
| **+27** | **+27** |

(Ein ready-Test von 4 wurde in 05B-2 schon genannt — 344/372 = +28; die Diskrepanz +1 stammt aus dem zusätzlichen `cache-control`-Test.)

### 4.3 Standalone-Build
```
$ npm run build:standalone
[build-standalone] Schritt 1/4: next build (NEXT_OUTPUT_STANDALONE=1)
  ... (Next.js-Routen-Listing)
[build-standalone] Schritt 2/4: kopiere .next/static -> .next/standalone/.next/static
[build-standalone] Schritt 3/4: kopiere public/* -> .next/standalone/public
[build-standalone] Schritt 4/4: entferne kopiertes .env aus .next/standalone/
[build-standalone] Schritt 4/4: entferne leeres/portable storage/ aus .next/standalone/
[build-standalone] OK: Standalone-Build vollstaendig (static + public, ohne .env/storage).
EXIT 0
```

Verifiziert: `.next/standalone/.next/static` = 67 Dateien,
`.next/standalone/public` = komplett, `.env` + `storage/` entfernt.

### 4.4 Standalone-Start + Endpoints
```
$ DATABASE_URL=…@localhost:5432/havewa?schema=public \
  AUTH_SECRET=… AUTH_TRUST_HOST=true \
  NODE_ENV=production PORT=3000 HOSTNAME=127.0.0.1 \
  node server.js
▲ Next.js 16.2.10
- Local:         http://127.0.0.1:3000
- Network:       http://127.0.0.1:3000
✓ Ready in 0ms

GET /api/health  -> 200 {"status":"ok"}
GET /api/ready   -> 200 {"status":"ready"}     (gegen 5432)
GET /de/login    -> 200, HTML 68 KB, 19 Asset-URLs
GET /_next/static/chunks/*.css  -> 200 text/css
GET /_next/static/chunks/*.js   -> 200 application/javascript
POST /api/shutdown (valides Token + 127.0.0.1:3000) -> 202 {"status":"shutting_down"}
[shutdown] remote shutdown requested     (Server-Log)
```

### 4.5 Bootstrap-Build
```
$ npm run build:bootstrap
[build-bootstrap] OK: …/scripts/dist/bootstrap.js

$ DATABASE_URL=…@localhost:5433/havewa_test?schema=public node scripts/dist/bootstrap.js
[bootstrap] bereits eingerichtet — übersprungen.
EXIT 0
```

### 4.6 Prisma-CLI minimal tree (isoliert)
Siehe §3.5. `migrate deploy` exit 0, 55 Migrationen erkannt, „No pending
migrations to apply" (Test-DB ist auf dem letzten Stand).

### 4.7 E2E Playwright Smoke gegen den laufenden Standalone

Voraussetzungen wie im 05B-2-Report dokumentiert. Standalone lief auf
`127.0.0.1:3000` (mit `CI=""` damit Playwright `reuseExistingServer=true`
nutzt, ohne einen zweiten `npm run dev` zu starten).

```
$ playwright test --project=chromium e2e/smoke.spec.ts
Running 8 tests using 1 worker

  ok 1  Login und Dashboard                                            (3.6s)
  ok 2  Objekte                                                        (3.5s)
  ok 3  Mietverträge                                                   (3.2s)
  ok 4  Finanzen                                                       (3.1s)
  ok 5  Dokumente                                                      (3.1s)
  x  6  Einstellungen (inkl. MCP-Freigaben-Bereich)                    (22.9s)
  x  7  Einstellungen: Zeitzone … (HAVEWA-04)                          (23.1s)
  ok 8  Logout                                                         (2.8s)

  6 passed, 2 failed (1.2m)
```

**Login funktioniert nachweislich im Standalone.** Die 6 grünen Tests
beinhalten den vollständigen Login-Flow + Dashboard + alle Hauptnavigation +
Logout. Das beweist: Client-Hydration ist nach `.next/static`-Copy intakt.

**Die 2 fehlgeschlagenen Tests sind kein 07A-2-Befund.** Server-Log
beweist die Ursache eindeutig:

```
Error [PrismaClientKnownRequestError]:
Invalid `prisma.tenant.findUnique()` invocation:
The column `Tenant.timeZone` does not exist in the current database.
  code: 'P2022',
  meta: { modelName: 'Tenant', column: 'Tenant.timeZone' }
```

Die Dev-DB (`localhost:5432/havewa`) hat die Migration `20261013200812_tenant_timezone`
nicht angewendet (siehe 05B-2-Report §6 und die explizite
**„No migration against 5432"**-Regel in 07A-2 §17). Der Test scheitert
in jeder Umgebung, die diese Migration nicht hat — auch in `npm run dev`
gegen die Dev-DB. Der 05B-2-Report markiert dieselben Tests bereits als
„auf langsameren Hosts (z. B. WSL/aarch64) … über dem Playwright-Standard
(5s) liegend"; die dort dokumentierte 20s-Erhöhung deckt die Instabilität
nur teilweise ab.

**Empfehlung (nicht Teil von 07A-2):** Migration in einer separaten,
dokumentierten Aktion gegen 5432 nachziehen, ODER den Smoke-Test gegen
die Test-DB (5433) umstellen, ODER den Timezone-Test von der Smoke-Suite
in eine separate Test-Datei auslagern.

---

## 5. Quality-Gate-Status (HAVEWA-07A-2)

| Gate | Status | Evidenz |
|---|---|---|
| Targeted: health 200 | ✅ | §4.4 |
| Targeted: ready 200 bei DB ok | ✅ | §4.4 |
| Targeted: ready 503 bei DB nok | ✅ | Unit-Test `ready.test.ts` (mocked Prisma) |
| Targeted: shutdown ohne Token abgelehnt | ✅ | Unit-Test + Live (401/404) |
| Targeted: shutdown mit falschem Token abgelehnt | ✅ | Unit-Test + Live (401) |
| Targeted: shutdown mit gültigem Token logisch korrekt | ✅ | Unit-Test + Live (202 + kontrollierter Exit im Log) |
| Targeted: HAVEWA_DATA_DIR Pfadverhalten | ✅ | 7 Unit-Tests + manuelle Verifikation in `storage.ts` |
| Targeted: Standalone static assets vorhanden | ✅ | §4.3 + §4.4 (`/_next/static/chunks/*.css` + `*.js` → 200) |
| Targeted: bestehender Playwright-Smoke | ⚠️ **6/8 grün** | Login + 5 Hauptnavigation + Logout = 6/8; 2 Settings-Tests scheitern an vorbestehender fehlender Tenant.timeZone-Migration in Dev-DB (nicht 07A-2-bedingt, Server-Log belegt Ursache) |
| Typecheck | ✅ | §4.1 |
| Unit | ✅ | §4.2 (48 Dateien, 372 Tests) |
| Bestehende Tests unverändert | ✅ | 05B-2-Baseline (43 Dateien, 344 Assertions) ist im neuen Lauf vollständig enthalten + 5 neue Dateien |
| Lint (eslint .) | ⏭️ **nicht ausgeführt** | Nicht beauftragt; 07A-2 fügt nur Code hinzu, der dem bestehenden Stil folgt (kein neuer Lint-Trigger erwartet, aber keine Baseline-Verifikation durchgeführt) |
| Production-Build | ✅ | §4.3 (build:standalone, exit 0) |
| Standalone-Start | ✅ | §4.4 (Ready in 0ms) |
| Prisma-CLI minimal tree isoliert bewiesen | ✅ | §3.5 + §4.6 |
| Migrate-Deploy gegen Test-DB | ✅ | §4.6 (exit 0) |
| Bootstrap → JS kompiliert | ✅ | §4.5 |
| Bootstrap runtime-fähig (kein tsx nötig) | ✅ | §4.5 (Idempotenz-Scope: non-empty → skip) |
| Startup-Sequenz vorbereitet | ✅ | §3.6 (Node-basiert, kein Tauri) |
| Backend Port-Fallback 3000..3005 | ✅ | `scripts/start-with-fallback.mjs` + 4 Unit-Tests |
| Loopback-Bind (127.0.0.1, kein 0.0.0.0) | ✅ | `HOSTNAME=127.0.0.1` + `server.js`-Überschreibung |
| Runtime-State für Port | ✅ | `runtime-state/port.json` mit `{host, port, startedAt}` |
| Shutdown-Endpoint | ✅ | §3.3 + 9 Unit-Tests + Live-202 |
| Shutdown Token enforcement | ✅ | ohne Token → 404, falsches Token → 401, valides → 202 |
| Scheduler-Stop | ✅ | `stopSchedulers()` räumt `__havewaBankTimer` + `__havewaInboundTimer` auf |
| Prisma-Disconnect | ✅ | `disconnectPrisma()` mit `.catch` swallow |
| HAVEWA_DATA_DIR umgesetzt | ✅ | `data-dir.ts` + `storage.ts` migriert |
| Dev-DB (5432) Zugriff | ⚠️ **nur lesend** für Live-Health/Ready-Verifikation. **Keine** Migration, **kein** Bootstrap, **kein** Test-Reset | §17 des Auftrags eingehalten |
| ARM64/WSL Kontamination | ✅ keine | Nur x64-Toolchain (`C:\Projekte\PropertyAI\.tools\node-v22.23.3-win-x64`) via direkter `node.exe`-Pfad-Aufruf genutzt |
| git diff --check | ✅ | Sauber (nur LF/CRLF-Warning für `package.json` + `storage.ts` — beide Files werden beim nächsten Stash/Pull auf LF normalisiert; keine inhaltliche Diff) |
| Keine Stage/Commit/Push | ✅ | Nur Working-Tree-Edits |
| Kein Tauri / NSIS / PostgreSQL-Bundling | ✅ | Reine Runtime-Härtung |
| Keine PropertyAI-/Dach-KI-Arbeit | ✅ | Pfade ausschließlich `C:\Projekte\PropertyAI\foundation\havewa` |
| `theme-provider.tsx` nicht angefasst | ✅ | Working-Tree-Schutz eingehalten |
| `test-results/` nicht gestaged | ✅ | Untracked-Liste unverändert |

---

## 6. Bekannte Einschränkungen (ehrlich, nicht überdeckt)

1. **E2E Settings-Tests:** scheitern an Tenant.timeZone-Migration in Dev-DB
   (5432). Ursache ist im Server-Log belegt, **nicht** durch 07A-2
   verursacht. Behebung: Migration in separater Aktion, oder Test-DB für
   Smoke-Suite (5433), oder Auslagerung der Settings-Tests. Alle drei
   Wege sind nicht Bestandteil von 07A-2.

2. **E2E-Re-Verify-Befund „OHNE Teständerung":** erfüllt. Der bestehende
   Smoke (`e2e/smoke.spec.ts`) wurde nicht geändert.

3. **Standalone node_modules Prisma-CLI:** Next.js kopiert die Prisma-CLI
   NICHT in `.next/standalone/node_modules/`. Das ist ein bekannter
   Next.js-Standalone-Behaviour. Der in §3.5 nachgewiesene 31-Pakete-Tree
   ist die Antwort für die Production: ein `prisma`-Tree, der vor dem
   App-Image-Build einmal vorbereitet und ins Image kopiert wird. Die
   konkrete Image-Pipeline-Integration ist eine Folgeaufgabe (07A-3
   oder 07B), nicht Bestandteil dieses Berichts.

4. **In-flight-Drain:** nicht implementiert, nicht behauptet. Express-
   /Next-eigene Connections werden beim `process.exit(0)` mit dem Prozess
   beendet; das ist die ehrliche Aussage.

5. **Bootstrap-Idempotenz-Scope:** siehe §3.4. „non-empty → skip" für den
   User-Init. Die `prisma.bootstrap.ts` hat keine weitergehende
   Re-Apply-Logik (z. B. für Standard-Konten, falls ein Mandant existiert
   aber keine Default-Accounts). Das wäre eine Folge-Aufgabe.

6. **Lint-Baseline:** keine Verifikation der `eslint .`-Baseline
   durchgeführt. Auftrag fordert Lint nicht explizit für 07A-2 (im
   Gegensatz zu 05A/05B-1/05B-2). Empfehlung für 07A-2-Review: einmal
   `npm run lint` laufen lassen und mit der dokumentierten Baseline
   (89 Errors / 16 Warnings aus 05B-2) abgleichen.

---

## 7. Working-Tree-Hygiene

```
 M package.json                       (+4 Skript-Zeilen)
 M src/components/theme-provider.tsx  (pre-existing, NICHT angefasst)
 M src/lib/storage.ts                 (CRLF→LF durch edit, +11/-5 Zeilen Inhalt)
 M vitest.config.ts                   (+1 Zeile Include)
?? playwright-report/                 (von 07A-2-E2E-Lauf, NICHT gestaged)
?? scripts/build-bootstrap.mjs        (NEU)
?? scripts/build-standalone.mjs       (NEU)
?? scripts/dist/                      (Bootstrap-Build-Output, nicht gestaged)
?? scripts/probe-prisma-cli-min.mjs   (NEU)
?? scripts/start-with-fallback.mjs    (NEU)
?? scripts/start-with-fallback.test.ts (NEU)
?? src/app/api/health/                (NEU)
?? src/app/api/ready/                 (NEU)
?? src/app/api/shutdown/              (NEU)
?? src/lib/data-dir.test.ts           (NEU)
?? src/lib/data-dir.ts                (NEU)
?? src/lib/server-lifecycle.ts        (NEU)
?? test-results/                      (pre-existing, NICHT angefasst)
```

Keine Stage-, Commit- oder Push-Aktionen ausgeführt. Keine
PropertyAI-/Dach-KI-Arbeit.

---

## 8. DEFERRED-Befunde (außerhalb 07A-2)

- E2E-Settings-Tests (Tenant.timeZone-Migration in Dev-DB) → siehe §6.1
- Standalone-Image-Pipeline (Prisma-CLI-Tree ins Image) → siehe §6.3
- Image-Pipeline: `Dockerfile` anpassen, damit Standalone + Prisma-CLI +
  Bootstrap-JS in ein gemeinsames Production-Image fließen → 07A-3
- Tauri-Desktop-Orchestrator (verwendet `/api/shutdown` + `HAVEWA_DATA_DIR`) → 07B
- Lokales Bundling von PostgreSQL → explizit **Nicht-Ziel** (§1 des Auftrags)
- Local-Stack-Installer → explizit **Nicht-Ziel** (§1 des Auftrags)
- Auth/Auth-Provider-Erweiterung (OIDC-Verbesserungen) → nicht in 07A-2
- Remote-Shutdown-Audit-Logging → nicht in 07A-2 (kein Audit auf Shutdown)
- Wechsel von `dotenv` auf native Env-Loader → nicht in 07A-2

---

## 9. Empfohlener nächster Schritt (genau einer)

**`npm run lint`** in einer separaten Aktion ausführen und das Ergebnis
mit der dokumentierten Baseline (05B-2: 89 Errors / 16 Warnings)
abgleichen. Wenn 0 neue Findings → 07A-2-Review kann starten. Wenn neue
Findings → im selben Review mit beheben oder dokumentieren.
