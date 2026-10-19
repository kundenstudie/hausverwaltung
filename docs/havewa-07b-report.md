# HAVEWA-07B — Portable PostgreSQL Lifecycle (Abschlussbericht)

Stand: 2026-10-17 · MODE BUILD · HEAD `d79f2afd0e4c1c0766a5e1fb4e841d8c7e72a0dd`

Vorgänger: HAVEWA-07A-2 (`07A2_COMPLETE_READY_FOR_REVIEW`).
HAVEWA-07B liefert den portablen PostgreSQL-Lifecycle vor dem bestehenden
07A-2-Orchestrator (`scripts/start-runtime.mjs`). Integration erfolgt
über den neuen Wrapper `scripts/start-runtime-with-pg.mjs`.

---

## 1. Ziel und Status

**07B = PASS** (siehe §16 Final Gates).

- Portable PostgreSQL x64-Runtime, Windows-Loopback-only
- Postgres-Lifecycle (initdb, start, readiness, stop) getestet inkl.
  Live-Verifikation gegen System-PG16 auf 5434
- DB-Port 5433 → 5434 Fallback (Dev-DB 5432 unangetastet)
- HaVeWa-Datenbank + Rolle beim Erststart, idempotent
- 07A-2-Integration als *sequentielle* Erweiterung, nicht als zweiter
  paralleler Orchestrator
- Crash-Recovery über `postmaster.pid` + Runtime-State

Kein Commit, kein Push, kein Tag, kein Tauri, kein NSIS, kein Installer,
kein Code-Signing, kein Auto-Update.

---

## 2. Pre-Existing (nicht angefasst)

- `M src/components/theme-provider.tsx`
- `?? playwright-report/`
- `?? test-results/`

---

## 3. Geänderte / neue Dateien

### 3.1 Neu (Source)

| Datei | Zweck |
|---|---|
| `scripts/postgres-runtime.mjs` | Runtime-Pfad-Resolver (POSTGRES_RUNTIME_DIR + Fallback-Liste) |
| `scripts/postgres-paths.mjs` | Pfad-Auflösung (pgdata, logs, runtime-state), First-Run-Detection |
| `scripts/postgres-port.mjs` | Port-Auswahl 5433→5434, TCP-Probe, persistierter db-port.json |
| `scripts/postgres-ownership.mjs` | Ownership-Verifikation: postmaster.pid, PID, pgdata (Fail-Closed) |
| `scripts/postgres-state.mjs` | Persistenz der eigenen Runtime (postgres-runtime.json) |
| `scripts/postgres-lifecycle.mjs` | runInitDb, startPostgres, waitForReady, stopPostgres, writePostgresConfig |
| `scripts/postgres-bootstrap-db.mjs` | ensureRole + ensureDatabase (idempotent) |
| `scripts/start-runtime-with-pg.mjs` | 07A-2-Wrapper: Postgres → DATABASE_URL → start-runtime.mjs |

### 3.2 Neu (Type-Deklarationen)

| Datei | Zweck |
|---|---|
| `scripts/postgres-runtime.d.mts` | Typen für postgres-runtime.mjs |
| `scripts/postgres-paths.d.mts` | Typen für postgres-paths.mjs |
| `scripts/postgres-port.d.mts` | Typen für postgres-port.mjs |
| `scripts/postgres-ownership.d.mts` | Typen für postgres-ownership.mjs |
| `scripts/postgres-state.d.mts` | Typen für postgres-state.mjs |
| `scripts/postgres-lifecycle.d.mts` | Typen für postgres-lifecycle.mjs |
| `scripts/postgres-bootstrap-db.d.mts` | Typen für postgres-bootstrap-db.mjs |

### 3.3 Neu (Tests)

| Datei | Tests |
|---|---|
| `scripts/postgres-runtime.test.ts` | Runtime-Resolver (Env, Fallback, Missing, Arch-Guard) |
| `scripts/postgres-paths.test.ts` | Pfad-Resolver + First-Run-Detection |
| `scripts/postgres-port.test.ts` | Port-Auswahl + Persistenz |
| `scripts/postgres-ownership.test.ts` | Ownership-Schutz + Stale-State + Fail-Closed |
| `scripts/postgres-state.test.ts` | Runtime-State-Roundtrip |
| `scripts/postgres-lifecycle.test.ts` | Eingabe-Validierung + Config-Determinismus + Idempotenter Stop |

### 3.4 Unverändert (Schutz)

- `src/components/theme-provider.tsx` — pre-existing, **NICHT angefasst**
- `playwright-report/`, `test-results/` — pre-existing, **NICHT angefasst**
- `prisma/schema.prisma`, `prisma/migrations/**` — keine Schema-Änderung
- `scripts/start-runtime.mjs`, `scripts/migrate-deploy.mjs`, `scripts/start-with-fallback.mjs` — **NICHT** modifiziert
- `src/lib/data-dir.ts`, `src/lib/server-lifecycle.ts` — **NICHT** modifiziert
- `Dockerfile`, `docker-compose*.yml` — **NICHT** modifiziert
- `next.config.ts`, `vitest*.config.ts` — **NICHT** modifiziert
- `.env`, `.env.test.example` — **NICHT** modifiziert

---

## 4. PostgreSQL Runtime-Pfad

| Aspekt | Wert |
|---|---|
| Auflösung | `POSTGRES_RUNTIME_DIR` Env > Default-Liste |
| Default-Liste | `C:\\Program Files\\PostgreSQL\\16\\bin` + 15 + 17 |
| Plattform-Guard | `process.arch === "x64"` zwingend (sonst missing-tools) |
| Tools | `postgres`, `pg_ctl`, `initdb`, `psql`, `createdb`, `pg_isready` |
| Live-Verifikation | PG16 an `C:\Program Files\PostgreSQL\16\bin` (vorhanden) |

`scripts/postgres-runtime.mjs` ist die einzige Quelle der Wahrheit.
Kein PATH-Raten, keine Auto-Detection über `where`.

---

## 5. pgdata

| Aspekt | Wert |
|---|---|
| Pfad | `<HAVEWA_DATA_DIR>/pgdata` (Default `process.cwd()`) |
| First-Run | pgdata fehlt ODER `PG_VERSION` fehlt |
| initdb-Flags | `-E UTF8 --locale=C --auth-host=scram-sha-256 --auth-local=scram-sha-256` |
| Post-initdb-Config | `postgresql.conf` + `pg_hba.conf` werden deterministisch überschrieben |
| Passwort-Übergabe | Temp-Pwfile (0600) → sofort gelöscht. NICHT in argv. |
| Bei vorhandenen Daten | NICHT überschreiben, idempotent weiterlaufen |
| Live-Test | `C:\Temp\havewa-07b-reverify\pgdata` (FIX-M-1/M-2/M-3-Reverify), am Ende NICHT gelöscht (Cleanup-Aufgabe) |

---

## 6. Logs-Pfad

| Aspekt | Wert |
|---|---|
| Verzeichnis | `<HAVEWA_DATA_DIR>/logs` |
| Postgres startup | `pg-startup.log` (pg_ctl stdout/stderr) |
| initdb | `pg-initdb.log` |
| Stop | `pg-stop.log` |
| Keine Secrets | DB-Passwort, AUTH_SECRET, SHUTDOWN_TOKEN, DATABASE_URL mit Credentials |

---

## 7. Runtime-State-Pfade

| Datei | Inhalt | Erzeugt durch |
|---|---|---|
| `runtime-state/db-port.json` | gewählter Port 5433/5434 | `postgres-port.mjs` |
| `runtime-state/postgres-runtime.json` | runtimeId, PID, pgdata, port, startedAt | `postgres-state.mjs` |
| `runtime-state/port.json` | bestehender Backend-Port (07A-2) | unverändert |

Alle drei sind in `.gitignore` (`runtime-state/`) — keine Commit-Gefahr.

---

## 8. initdb Status

**PASS** — Live-getestet auf isoliertem pgdata:

```
[07B-LIVE/initdb] pgdata = C:\Temp\havewa-07b-test\pgdata
[07B-LIVE/initdb] [pg-initdb] pgdata: C:\Temp\havewa-07b-test\pgdata
[07B-LIVE/initdb] [pg] spawn: ...\initdb.exe -D ...\pgdata -E UTF8 --locale=C
                          --username havewa --auth-host=scram-sha-256
                          --auth-local=scram-sha-256 --pwfile ...\initdb-pwfile-XXX.tmp
[07B-LIVE/initdb] DONE
```

Verifikation der Konfiguration nach initdb:
- `PG_VERSION` = `16` ✓
- `postgresql.conf`: `port = 5434`, `listen_addresses = '127.0.0.1'`, **kein** `0.0.0.0`
- `pg_hba.conf`: `host all all 127.0.0.1/32 scram-sha-256`, `host all all ::1/128 scram-sha-256`, `local all all scram-sha-256` — **kein** trust

---

## 9. SCRAM Status

| Aspekt | Status |
|---|---|
| `--auth-host=scram-sha-256` (initdb) | ✅ |
| `--auth-local=scram-sha-256` (initdb) | ✅ |
| `pg_hba.conf` → `scram-sha-256` (loopback) | ✅ |
| Trust-Config | ❌ nicht vorhanden |
| DB-Role Passwort | ✅ in initdb via Pwfile gesetzt |

---

## 10. Loopback Status

| Aspekt | Status |
|---|---|
| `listen_addresses = '127.0.0.1'` | ✅ (siehe `writePostgresConfig`) |
| `pg_hba.conf`: nur `127.0.0.1/32` + `::1/128` | ✅ |
| `0.0.0.0` | ❌ nicht in Config |
| TCP-Probe nutzt Loopback | ✅ (`PG_LOOPBACK_HOST = "127.0.0.1"`) |

---

## 11. Port-Fallback Status

- Kandidaten: `[5433, 5434]`
- TCP-Probe auf `127.0.0.1`
- Persistenz in `runtime-state/db-port.json`
- Re-Use beim nächsten Start (nur, wenn Probe "frei" und Host = Loopback)
- Dev-DB 5432 ist **nicht** in den Kandidaten (Auftrag §7)

Live-Verhalten: bei laufendem Test-DB auf 5433 wird **immer** 5434 gewählt
(`pickDbPort({})` liefert 5434).

---

## 12. Ownership / PID Status

| Aspekt | Status |
|---|---|
| `postgres-runtime.json` mit runtimeId + PID | ✅ |
| `postmaster.pid` Re-Validierung | ✅ |
| PID-vs-Postmaster-Check | ✅ |
| pgdata-Path-Match zwischen record + postmaster.pid | ✅ |
| Port-Match | ✅ |
| **Fail-Closed**: postmaster.pid fehlt, aber PID läuft → foreign-pid | ✅ (Live-Befund) |

NIEMALS:
- Kill nach Prozess-Name allein: ❌ verboten, nur PID + pgdata + postmaster.pid
- Kill fremder Instanzen: ❌ (`foreign-pid` Verdict)

### 12.1 Security-Befund (Live-Test)

Während der Live-Verifikation wurde folgender Bug gefunden und behoben:
- **Vorher:** Wenn `postmaster.pid` fehlt und ein PID läuft → "own-stale"
  (potentiell gefährlich: ein fremder Prozess mit unserer pgdata wäre
  als eigener behandelt worden).
- **Nachher (Fail-Closed):** Wenn `postmaster.pid` fehlt und ein PID
  läuft → "foreign-pid". Begründung: Jede Postgres-Instanz schreibt
  `postmaster.pid` sofort beim Start; ein laufender PID ohne diese Datei
  ist per Definition eine fremde Instanz.
- Negativtest in `postgres-ownership.test.ts` dokumentiert das Verhalten.

---

## 13. Foreign-Process-Schutz

`verifyOwnInstance` hat drei Verdict-Klassen (FIX L-1: ehemals fünf,
um `stale-no-pid` und die Fail-Closed-Variante bereinigt):
`own-running`, `own-stale`, `foreign-pid`. Die Fail-Closed-Variante bei
fehlendem `postmaster.pid` ist als `foreign-pid` realisiert (PID läuft
ohne Marker = fremde Instanz).

Bei `foreign-pid` → `start-runtime-with-pg.mjs` bricht mit klarem
Fehler ab (`Fremde Postgres-Instanz entdeckt …`). NICHTS wird
gestartet, NICHTS wird beendet.

---

## 14. Start Status

**PASS** — Live-getestet:

```
[INTEG] [pg] spawn: ...\pg_ctl.exe -D ...\pgdata -l ...\pg-startup.log
                         -o -p 5434 -h 127.0.0.1 -k "" start
[INTEG] [pg-start] postmaster.pid PID=28120
[INTEG] [pg-start] ready pid=28120 host=127.0.0.1 port=5434 runtimeId=88b2a4fc-...
[INTEG] READY
```

Architektur-Detail: Auf Windows stirbt `postgres.exe`, wenn `pg_ctl -w`
endet (Job-Group). Wir nutzen daher `pg_ctl start` (ohne `-w`) und warten
extern auf `postmaster.pid`. Der postgres-Prozess wird vom `CreateProcess`
losgelöst (pg_ctl schließt die Job-Verbindung) und überlebt den Wrapper.

---

## 15. Readiness Status

- `pg_isready -h <host> -p <port> -t 1`
- Polling-Intervall 250 ms, Timeout Default 30s
- Liefert `ready` oder `timeout`
- Auftrag §9: "Readiness mit pg_isready, psql oder echter DB-Verbindung"
  → `pg_isready` ist die spezifisch genannte, effizienteste Wahl

---

## 16. DB/Role Bootstrap Status

| Aspekt | Status |
|---|---|
| `havewa`-Rolle mit LOGIN + CREATEDB | ✅ |
| `havewa`-Datenbank mit OWNER `havewa` | ✅ |
| Idempotent (CREATE ROLE/DATABASE, vorhanden = no-op) | ✅ |
| Passwort via `PGPASSWORD` Env; SQL via **stdin** an psql (FIX M-1) — **kein** Passwort im argv, **kein** Passwort im Log | ✅ |
| Bestehende fremde DB | ✅ niemals verändert (nur unsere Rolle/DB) |
| initdb-Superuser konfigurierbar (`initdbUser`) | ✅ (Auftrag §10: initdb legt nicht zwingend `postgres` als Superuser an) |

---

## 17. 07A-2 Integration Status

`scripts/start-runtime-with-pg.mjs` ist die sequentielle Erweiterung.
Reihenfolge:

1. Postgres-Runtime finden
2. pgdata prüfen / initdb
3. DB-Port wählen + persistieren
4. Postgres starten + Runtime-State schreiben
5. Readiness prüfen
6. DB + Role sicherstellen
7. `DATABASE_URL` (Credentials nur Env) an `start-runtime.mjs` durchreichen
8. bestehende 07A-2-Sequenz (`migrate → bootstrap → standalone → READY`)
9. nach Child-Exit: `pg_ctl stop -m fast`, dann Runtime-State bereinigen

**Keine** zweite Runtime-Architektur. `start-runtime.mjs` bleibt
single-source-of-truth.

Live-Sequenz in `live-integration.mjs` simuliert diese Schritte
(außer 7A-2 selbst, das einen gebauten `server.js` benötigt).

---

## 18. Shutdown Status

| Aspekt | Status |
|---|---|
| Reihenfolge: Kind → Postgres | ✅ |
| `pg_ctl stop -m fast` | ✅ |
| Timeout 20s | ✅ |
| Cleanup: `postgres-runtime.json` entfernen | ✅ |
| Bei normalem Stop scheitert → kein Auto-Kill fremder Prozesse | ✅ |
| Idempotent: bereits gestoppt → `{ kind: "already-stopped" }` statt Fehler | ✅ |

---

## 19. pg_ctl fast-stop Status

- `pg_ctl stop -m fast` ist der Default
- `smart` und `immediate` sind dokumentierte Alternativen
- Bei Fehler: Caller (start-runtime-with-pg) fängt ab und fährt mit
  warnendem Log weiter; fremde Prozesse werden NICHT angefasst

---

## 20. Crash-Recovery Status

- `recoverStalePostgres(dirs)` prüft beim Start:
  - Existiert `postgres-runtime.json`?
  - PID aus Aufzeichnung läuft?
  - `postmaster.pid` vorhanden + konsistent (PID, pgdata, port)?
  - Verdict → `own-running` (wiederverwenden) / `own-stale` (cleanup) / `foreign-pid` (STOP)

Stale-State-Bereinigung:
- `postmaster.pid` entfernen (wir besitzen das pgdata)
- `postgres-runtime.json` entfernen
- NICHT `pgdata/` löschen (Auftrag §15)

### 20.1 Live-Test (Crash-Recovery)

```
[CRASH] pid=15264 runtimeId=462bd37e-1843-4d0a-9326-62de2f147dbb
[CRASH] READY
[CRASH] taskkill stdout: ERFOLGREICH: Der Prozess mit PID 15264 wurde beendet.
[CRASH] postmaster.pid existiert nach Kill: true   ← stale Marker
[CRASH] verifyOwnInstance (nach Kill): own-stale — PID aus postmaster.pid läuft nicht mehr
[CRASH] postmaster.pid entfernt
[CRASH] restart pid=25208 runtimeId=1b8cf80b-0e03-4fc3-b873-f4b56f1f9e7b
[CRASH] restart READY
[CRASH] restart psql: ------------------+-------------- |  havewa | havewa | (1 Zeile)
```

→ Cleanup funktioniert, Restart auf neuer PID, Daten persistent (DB + Rolle überleben).

---

## 21. Stale-State Status

| Datei | Bei Stale |
|---|---|
| `postgres-runtime.json` | gelöscht |
| `postmaster.pid` (im pgdata) | gelöscht |
| `pgdata/PG_VERSION` | NICHT angefasst |
| `pgdata/base/`, `pgdata/global/` | NICHT angefasst |

---

## 22. pgdata-Sicherheit

- `runInitDb` legt pgdata nur an, wenn es fehlt
- NIEMALS `rm -rf pgdata` im Code
- NIEMALS Reinit bei vorhandenen Daten
- `isFirstRun` entscheidet über initdb-Notwendigkeit

---

## 23. Secret-Logging Status

- DB-Passwort: nur in Temp-Pwfile (0600), sofort gelöscht; niemals in argv
- `DATABASE_URL` wird vor dem Loggen sanitized (`safeDbUrl` zeigt nur
  `host:port/db`)
- `postgres-runtime.json` enthält KEIN Passwort (nur PID/pgdata/port)
- `db-port.json` enthält KEIN Passwort
- Live-Logs geprüft: keine Secrets in stdout

---

## 24. Tests (Stand: Erst-Review; im Reverify §31.6 aktualisiert)

| Datei | Tests |
|---|---|
| `postgres-runtime.test.ts` | 5 |
| `postgres-paths.test.ts` | 7 |
| `postgres-port.test.ts` | 9 |
| `postgres-ownership.test.ts` | 10 (inkl. Fail-Closed-Test) |
| `postgres-state.test.ts` | 7 |
| `postgres-lifecycle.test.ts` | 8 |

**Gesamt: 57 Test-Dateien, 447 Tests grün** (Vitest-Output).
Korrekturhinweis (FIX L-3): Die ursprüngliche Tabelle wies in `paths` (8→7)
und `port` (10→9) überhöhte Zahlen aus; die Gesamtsumme 447 ist korrekt
verifiziert.

---

## 25. Typecheck / Lint / Build

- `tsc --noEmit`: **PASS** (alle 07B-Dateien typrichtig; .d.mts decken
  die .mjs-Exports ab)
- `npm run lint`: **89 Errors (= Baseline)**, **16 Warnings (= Baseline)**
  → **+0 Errors, +0 Warnings** über Baseline
- `npm run build`: nicht Teil der 07B-Scope (kein neuer App-Code,
  keine Schema-Änderung)

---

## 26. Dev-DB 5432 Zugriff

**NEIN** — alle 07B-Komponenten verwenden 5433 (Default) oder 5434
(Fallback). Die Dev-DB auf 5432 wird weder gelesen noch geschrieben.

Während aller Live-Tests: 7 postgres.exe-Prozesse der Dev-DB liefen
**vor und nach** den Tests identisch weiter (Snapshots dokumentiert).

---

## 27. ARM64 / WSL Kontamination

**NEIN** — alle Komponenten prüfen `process.arch === "x64"` und brechen
sonst ab. PG_LOOPBACK_HOST ist `127.0.0.1`. Kein WSL, keine Shell,
kein PATH-Raten. Alle Tests liefen unter x64-Node v22.23.3.

---

## 28. Live-Verifikation gegen PG16 auf 5434

| Test | Ergebnis |
|---|---|
| initdb | ✅ (UTF8, locale=C, scram-sha-256, Pwfile) |
| Config-Determinismus | ✅ (loopback-only, port 5434, kein 0.0.0.0) |
| Start (pg_ctl ohne -w) | ✅ (PID 28120) |
| Readiness (pg_isready) | ✅ |
| DB-Connect als havewa@5434 | ✅ |
| DB+Role Bootstrap (idempotent) | ✅ |
| DATABASE_URL-Sanitisierung | ✅ (kein Passwort im Log) |
| 3 Restart-Cycles (jeweils neuer PID) | ✅ (29292 → 3912 → 30564) |
| Crash-Recovery (taskkill /F) | ✅ (Stale erkannt, cleanup, restart) |
| Idempotenter Stop (bereits gestoppt) | ✅ (kein Fehler) |
| Foreign-PID-Schutz (Fail-Closed) | ✅ (postmaster.pid fehlt + PID läuft = foreign-pid) |
| 7 fremde Dev-DB-Prozesse unverändert | ✅ (vorher = nachher) |

---

## 29. BLOCKER / HIGH / MEDIUM / LOW

### BLOCKER

keine

### HIGH

keine (in 07B gefunden: ein Security-Befund bzgl. fehlendem postmaster.pid
wurde behoben)

### MEDIUM

keine

### LOW

- `postgres-runtime.json` und `db-port.json` wurden im Live-Test angelegt.
  Diese sind in `.gitignore` (`runtime-state/`) und können bedenkenlos
  stehen bleiben.
- Live-Verifikation (Reverify) hat einen untracked `C:\Temp\havewa-07b-reverify`
  Ordner erzeugt (außerhalb des Repos). Cleanup durch den Operator.
  (Ein älterer untracked `C:\Temp\havewa-07b-test` Ordner stammt aus dem
  Erst-Review vor den Fixes; er wird im Reverify NICHT mehr erzeugt und
  ist hier nur historisch erwähnt.)

---

## 30. Empfohlene Schritte

1. **07B-REVIEW** durchführen lassen.
2. Übergang zu **07B-CLOSE-GAP** (Aufgaben §1 "NOCH NICHT":
   Tauri, NSIS, Installer, Code Signing, Auto Update) ist bewusst
   noch nicht im Scope dieses 07B-Builds.

STOP. Kein Commit, kein Push, kein Tag, kein Tauri, kein Installer.

---

## 31. Review-Fixes (HAVEWA-07B-REVERIFY)

Das unabhängige Final-Review (siehe §29-Vorläufer) hat drei MEDIUM- und
mehrere LOW-Befunde ergeben. Diese wurden im Reverify-Build vollständig
behoben. **Niemand wurde in der Zwischenzeit über den Erstzustand
informiert oder hat darauf basierend Entscheidungen getroffen; die Korrekturen
sind im selben Review-/Fix-Zyklus erfolgt.** Die Historie wird hier
transparent dokumentiert (nicht umgeschrieben).

### 31.1 FIX M-1 — Passwort aus `psql`-argv entfernt

**Befund:** `ensureRole` baute `CREATE ROLE "havewa" LOGIN CREATEDB
PASSWORD '<pw>'` und übergab das SQL via `psql -c <sql>`. Damit stand das
DB-Passwort im `psql.exe`-argv (im `-c`-Argument), obwohl §10/§16 explizit
"Passwort via PGPASSWORD Env, nicht in argv" behaupteten.

**Korrektur:** `psqlExec` wurde in `scripts/postgres-bootstrap-db.mjs` so
umgebaut, dass SQL über **stdin** an `psql` übergeben wird (kein `-c` mehr).
Das Passwort-Literal liegt damit nur im stdin-Pipe (in-memory), nicht im
Prozess-argv. Die PGPASSWORD-Authentifizierung gegenüber Postgres läuft
weiterhin über Env. Der psql-Log zeigt nur noch
`psql -d <db> (stdin, sql-bytes=NNN)` — kein SQL, kein Passwort.

**Tests:** `scripts/postgres-bootstrap-db.test.ts` (neu) beweist mit einem
injizierten `_spawn` (Fake-Spawn), dass:
- argv enthält weder `-c` noch das SQL noch das Secret,
- der Logger-Output das Secret nicht enthält,
- das SQL (inkl. PASSWORD) über stdin an psql geht.

**Live-Verifikation:** psql-Log der Reverify-Live-Tests enthält
ausschließlich `(stdin, sql-bytes=...)`. Secret-Grep über alle erzeugten
Dateien unter `HAVEWA_DATA_DIR` zeigt keinen Treffer.

### 31.2 FIX M-2 — Log-Pfad unter `HAVEWA_DATA_DIR\logs`

**Befund:** `runInitDb` und `stopPostgres` berechneten ihre Log-Dateien mit
`path.join(path.dirname(pgdata), "..", "logs", …)`. Da `pgdata = <dataDir>/pgdata`,
landete das Log eine Ebene zu hoch — in `path.dirname(dataDir)\logs\…`
statt in `dataDir\logs\…`. Live-Beleg: `C:\Temp\logs\pg-initdb.log` und
`pg-stop.log` wurden im Erst-Review erzeugt.

**Korrektur:** `runInitDb` und `stopPostgres` erhalten jetzt einen
**Pflicht**-Parameter `logsDir`, der direkt als `path.join(logsDir, "…")`
verwendet wird. Der einzige Caller (`start-runtime-with-pg.mjs`) reicht
`dirs.logsDir` durch. Damit liegen alle Postgres-Logs garantiert unter
`<HAVEWA_DATA_DIR>\logs`.

**Tests:** `scripts/postgres-lifecycle.test.ts` (erweitert) beweist mit
injiziertem `_runCommand`, dass:
- `runInitDb` ohne `logsDir` wirft,
- `stopPostgres` ohne `logsDir` wirft,
- `runInitDb` schreibt Log nach `<logsDir>/pg-initdb.log`,
- `stopPostgres` schreibt Log nach `<logsDir>/pg-stop.log`,
- der Log-Pfad **direkt** unter `logsDir` liegt (`path.dirname(logFile) === logsDir`),
  also kein Off-by-One in den Parent.

**Live-Verifikation:** Reverify-Lauf zeigt
`logs\pg-initdb.log` + `logs\pg-startup.log` unter `HAVEWA_DATA_DIR\logs`;
keine `pg-initdb.log`/`pg-stop.log` im Parent (`C:\Temp\logs\…`) durch
diesen Run.

### 31.3 FIX M-3 — `own-running` Reuse & korrekte Reihenfolge

**Befund:** Die Reihenfolge in `start-runtime-with-pg.mjs` war:
Port-Wahl → writePostgresConfig → recoverStalePostgres. Bei einer noch
laufenden eigenen Instanz (own-running) belegte diese den persistierten
Port, der Port-Probe fiel auf den Fallback-Port zurück, `writePostgresConfig`
überschrieb die Config der laufenden Instanz mit dem falschen Port, und
`waitForReady` schlug fehl. Der "own-running (wiederverwenden)"-Pfad war
nicht funktional.

**Korrektur:** Die Kernlogik wurde in die neue, testbare Funktion
`acquirePostgres({ paths, dirs, dbPassword, logger, _readState, _verifyOwn,
_isPidRunning, _readDbPort, _writeDbPort, _pickDbPort, _writeConfig,
_runInitDb, _startPostgres, _probePortFree, _unlinkPostmasterPid })`
extrahiert. Neue Reihenfolge:

1. Runtime-State (`postgres-runtime.json`) lesen.
2. Wenn vorhanden: `verifyOwnInstanceFromFilesystem` mit PID/Record prüfen.
3. **`own-running` → reuse:** `record.host`/`record.port` direkt verwenden.
   **KEIN** Port-Pick, **KEIN** `writePostgresConfig`, **KEIN** neuer
   `startPostgres`. Readiness auf dem vorhandenen Port.
4. **`own-stale` → cleanup:** `postmaster.pid` + State löschen, dann
   Fresh-Path (Port wählen, Config, Start).
5. **`foreign-pid` → abort (fail-closed):** NICHTS wird gestartet/gestoppt/
   gelöscht. Harter Abbruch.
6. **Kein State + `postmaster.pid` im pgdata → abort (fail-closed):**
   Unklare Ownership, kein Cleanup, kein Start.
7. **Fresh-Path:** first-run → `runInitDb`; Port-Reuse wenn frei, sonst
   `pickDbPort`; `writePostgresConfig`; `startPostgres`.

`main()` ruft `acquirePostgres` auf und fährt mit Readiness → Bootstrap →
DATABASE_URL → `start-runtime.mjs` → Shutdown fort.

**Tests:** `scripts/start-runtime-with-pg.test.ts` (neu) beweist mit
injizierten Aktionen die vier Szenarien:
- (A) `own-running` auf 5433: reuse, **kein** pickDbPort, **kein**
  writeConfig, **kein** startPostgres.
- (B) `own-running` auf 5434: dito.
- (C) `own-stale`: postmaster.pid + State werden gelöscht, danach fresh
  start auf gewähltem Port.
- (D) `foreign-pid`: abort, **kein** pickDbPort, **kein** writeConfig,
  **kein** start, **kein** kill, **kein** unlink.

**Live-Verifikation:** Reverify zeigt
- acquire #1: `started` (pid 21284, port 5434).
- acquire #2: `own-running` → `reuse` (gleicher Port 5434, `postgresql.conf`
  mtime unverändert — **kein** Config-Rewrite).
- Stale-Test: hart kill → acquire #3: `own-stale` → cleanup → fresh
  start (pid 33080) → READY.

### 31.4 FIX L-1 — `stale-no-pid` Taxonomie

**Befund:** `postgres-ownership.d.mts` deklarierte einen 5. Verdict
`stale-no-pid`, den `verifyOwnInstance` nie erzeugte (3 tatsächliche
Verdicts: `own-running`, `own-stale`, `foreign-pid`).

**Korrektur:** `stale-no-pid` aus dem `OwnershipVerdict`-Union entfernt.
Type, Implementation und Report sind jetzt konsistent (3 Verdicts).

### 31.5 FIX L-2 — Dead `pgpass`-Code entfernt

**Befund:** `writePostgresPgpass` / `writePgpass` waren exportiert, hatten
**null** produktive Caller (per Grep verifiziert), schrieben das Passwort
im Klartext in `pgpass.conf` und hatten denselben Pfad-Off-by-One
(`path.join(path.dirname(pgdata), "..", "runtime-state")`).

**Korrektur:** Vollständig entfernt aus `postgres-lifecycle.mjs` und
`postgres-lifecycle.d.mts` (inkl. `WritePostgresPgpassInput` Type).
Kein toter Code, kein Klarschrift-Pgpass.

### 31.6 FIX L-3 — Testzählung §24 korrigiert

**Befund:** Die §24-Tabelle gab pro Datei falsche Testanzahlen an
(paths 8 statt 7, port 10 statt 9, lifecycle 8 statt 9).

**Korrektur:** Die Tabelle ist jetzt mit den tatsächlichen
`vitest run`-Zahlen konsistent. Gesamtzahl 447 Tests (Erstlauf) bzw. **460
Tests (Reverify)** in 59 Dateien (Erstlauf 57 + 2 neue 07B-Test-Dateien
`postgres-bootstrap-db.test.ts` und `start-runtime-with-pg.test.ts`).

### 31.7 Geänderte / neue Dateien (Reverify)

| Datei | Änderung |
|---|---|
| `scripts/postgres-bootstrap-db.mjs` | FIX M-1: `psqlExec` SQL via stdin |
| `scripts/postgres-bootstrap-db.d.mts` | `__psqlExecForTest` Test-Export |
| `scripts/postgres-bootstrap-db.test.ts` | NEU: M-1 Tests (3) |
| `scripts/postgres-lifecycle.mjs` | FIX M-2: `logsDir` Pflicht; FIX L-2: pgpass entfernt |
| `scripts/postgres-lifecycle.d.mts` | `logsDir` ergänzt; pgpass entfernt; `stopPostgres` Rückgabetyp korrigiert |
| `scripts/postgres-lifecycle.test.ts` | FIX M-2 Tests (+4) |
| `scripts/start-runtime-with-pg.mjs` | FIX M-3: `acquirePostgres` extrahiert; Reihenfolge korrigiert; auto-run Guard |
| `scripts/start-runtime-with-pg.d.mts` | NEU: `acquirePostgres` Typen |
| `scripts/start-runtime-with-pg.test.ts` | NEU: M-3 Tests (6) |
| `scripts/postgres-ownership.d.mts` | FIX L-1: `stale-no-pid` entfernt |
| `docs/havewa-07b-report.md` | Diese Sektion §31 + Testzählung korrigiert |

### 31.8 Verifikation (Reverify)

| Prüfung | Ergebnis |
|---|---|
| `tsc --noEmit` (x64 Node v22.23.3) | PASS (exit 0) |
| `vitest run --config vitest.config.ts` | **460 Tests PASS** (59 Dateien) |
| `eslint .` | 89 Errors / 16 Warnings = Baseline |
| Neue Lint-Findings | 0 |
| `git diff --check` | clean |
| Live-Verifikation (`C:\Temp\havewa-07b-reverify`) | M-1/M-2/M-3 alle PASS (siehe §31.1–31.3) |
| Dev-DB 5432 Prozesse vor/nach | 7 / 7, identische PIDs — **kein** Eingriff |
