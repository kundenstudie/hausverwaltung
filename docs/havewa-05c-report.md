# HAVEWA-05C — Release Documentation & Backup/Restore (Abschlussbericht)

Stand: 2026-10-16 · MODE BUILD · HEAD `3f1d03fba397793b7276b4c5a19fdb1b50f94106`

Vorgänger: HAVEWA-05A = COMPLETE, HAVEWA-05B-1 = COMPLETE, HAVEWA-05B-2 = COMPLETE.

> **Review-Ergebnis (HAVEWA-05C REVIEW):** `APPROVE_WITH_CHANGES` — Backup-Architektur
> und Runbook-Struktur belegbar; eine fachliche Korrektur am PDF-Encoding-Hinweis
> wurde in diesem BUILD umgesetzt.

---

## 1. Ergebnis

**HAVEWA-05C = PASS.** Drei nachweislich stale README-Punkte sind korrigiert
und ein vollständiges Backup-/Restore-Runbook ist neu dokumentiert. Es gab
**keine** Code-, Schema-, Migrations- oder Dependency-Änderung.

## 2. Scope

Dokumentations-Scope (genau vier Dateien):

| Datei | Art |
|---|---|
| `README.md` | Stale-Punkt-Korrekturen, Script-Tabelle ergänzt |
| `README.de.md` | Stale-Punkt-Korrekturen, Script-Tabelle ergänzt |
| `docs/backup-restore.md` | **NEU** — Backup-/Restore-Runbook |
| `docs/havewa-05c-report.md` | **NEU** — dieser Bericht |

**Nicht** angefasst: `docs/flaechenmodell.md` (Statuszeile „bereit zur
Umsetzung“ bleibt unverändert, deferred), `src/**`, `prisma/**`,
`messages/**`, `package.json`, `package-lock.json`, alle
`docker-compose*.yml`, `Dockerfile`, `deploy/**`, `PropertyAI/**`,
Dach-KI, HAVEWA-06/-07.

## 3. Korrigierte README-Stale-Punkte

### 3.1 Sprach- und Locale-Aussagen

- „bilingual (DE/EN)“ → **„trilingual (DE / EN / pt-BR)“**
  (`README.md`, `README.de.md`).
- `messages/{de,en}.json` → **`messages/{de,en,pt-BR}.json`**
  (`README.md`, Projektstruktur-Block; analoge deutsche Formulierung
  in `README.de.md`).

Belegt durch `src/i18n/routing.ts` (`locales: ["de","en","pt-BR"]`) und
das Vorhandensein von `messages/pt-BR.json`.

### 3.2 Flächenmodell-Status

- „the time-based area model (`docs/flaechenmodell.md`) is specified as
  a draft but not yet implemented“ → entfernt
  (`README.md`, „Known simplifications“).
- Deutsch analog entfernt (`README.de.md`).

Belegt durch `prisma/schema.prisma` (`Property.areaModel/totalArea`,
`AreaAllocation`), `src/lib/allocation/area-time.ts` (vollständige
m²·Tage-Logik), UI in `src/app/[locale]/(admin)/properties/[id]/page.tsx`
und `src/app/[locale]/(admin)/leasing/page.tsx`, sowie die
entsprechenden Tests.

> **Konsistenzhinweis (deferred):** Nach diesem BUILD lautet die
> README-Aussage „Flächenmodell implementiert“ (kein Stale-Finding
> mehr), während `docs/flaechenmodell.md` weiterhin den historischen
> Status „bereit zur Umsetzung“ trägt. Diese Datei ist vom aktuellen
> Scope explizit ausgenommen; eine konsolidierende Überarbeitung ist
> **DEFER**.

### 3.3 Script-Tabelle

Die Tabellen in `README.md` / `README.de.md` waren unvollständig (alle
gelisteten Scripts existieren, aber mehrere für Entwicklung und Betrieb
nützliche Scripts fehlten). Ergänzt um: `lint`, `typecheck`,
`test:unit`, `test:integration`, `test:e2e`, `test:all`,
`db:generate`, `db:migrate-secrets`, `db:reset`. Jeder Eintrag wurde
gegen `package.json` verifiziert; keine erfundenen Kommandos.

### 3.4 PDF-Encoding-Hinweis (fachlich präzisiert, nicht pt-BR-spezifisch)

Der `simplePdf`-Encoder in `src/lib/pdf.ts` unterstützt nur
WinAnsi/CP1252. Zeichen außerhalb von Latin-1/CP1252 (z. B. Emoji, CJK,
Kyrillisch) werden in `encodeWinAnsi` zu `?` ersetzt. Standardmäßige
deutsche Umlaute und **alle** portugiesischen Akzentzeichen
(à á â ã ç é ê í ó ô õ ú ü, …) liegen in Latin-1 und werden korrekt
kodiert.

Der Hinweis wurde **allgemein** formuliert (Known simplifications)
und nimmt **keine** pt-BR-spezifische Fehlbehauptung über
lateinisch-1-konforme Zeichen auf. Belegt durch `encodeWinAnsi`
(`code <= 0xff` → direkte Übernahme) und `src/lib/pdf.test.ts`
(`äöüÄÖÜß` → Latin-1-Bytes, nur `😀` → `?`).

## 4. Backup-/Restore-Runbook (`docs/backup-restore.md`)

Neues Runbook, das die reale HaVeWa-Architektur adressiert:

- Zwei gekoppelte Source-of-Truth-Bestandteile (PostgreSQL 16 + lokales
  Filesystem) und ihre Kopplung über `storageKey` / `logoKey`.
- Geprüfte Fakten: Service `db`, Container `havewa-db`, DB/User `havewa`,
  Storage-Basis `<cwd>/storage/documents`, Docker-Volumes
  `havewa-storage` / `havewa-db`, Proxmox-`DATA_DIR=/var/lib/havewa`.
- Backup-Konsistenz: App-Stopp empfohlen (kein erfundener Read-only-Modus).
- `pg_dump -Fc` für DB-Backup (Custom-Format, `pg_dumpall` ausdrücklich
  nicht nötig), `pg_restore` für Restore — jeweils für Docker und
  Proxmox/plain Debian, mit Compose-Datei-Hinweis pro Deployment.
- Storage-Backup per `tar` gegen `havewa-storage` (Docker) bzw.
  `/var/lib/havewa/storage` (Proxmox).
- ENV/Secrets getrennt sichern; `AUTH_SECRET` mit präziser Doppelrolle
  (Session-Signierung **und** Schlüsselableitung für AES-256-GCM
  at-rest-Secrets in `Tenant.aiApiKey/smtpPassword/imapPassword`,
  `BankConnector.privateKeyEnc`, `McpApproval.argsEnc`).
- Restore-Reihenfolge in 8 Schritten, mit ausdrücklicher Betonung des
  **originalen** `AUTH_SECRET`.
- `migrate deploy` als idempotent/auto beschrieben — keine
  „immer zwingend“-Falschaussage.
- Restore-Validation als schlanker Smoke, ohne neue Test-Suite.
- Docker vs. Proxmox-Tabelle für die realen Unterschiede.

## 5. Geänderte Dateien (final)

| Datei | Änderung |
|---|---|
| `README.md` | Sprach-/Locale-Aussage, Script-Tabelle, Known simplifications (Area + PDF) |
| `README.de.md` | Sprach-/Locale-Aussage, Script-Tabelle, Known simplifications (Area + PDF) |
| `docs/backup-restore.md` | **NEU** |
| `docs/havewa-05c-report.md` | **NEU** |

## 6. Quality-Gate-Status

| Gate | Status |
|---|---|
| Scope-Treue (4 Dateien) | ✅ |
| Keine Codeänderung | ✅ |
| Keine Schema-/Migrationsänderung | ✅ |
| Keine Dependency-Änderung | ✅ |
| Keine Tests erforderlich (Docs-only) | ✅ |
| Alle dokumentierten Pfade/Volumes/Service-Namen verifiziert | ✅ |
| `pg_dump -Fc` / `pg_restore` Konsistenz | ✅ |
| AUTH_SECRET-Rolle präzise, ohne Übertreibung | ✅ |
| Backup-Konsistenz (App-Stopp) dokumentiert, kein erfundener Read-only-Modus | ✅ |
| Keine echten Credentials im Doku-Text | ✅ |
| Keine pt-BR-spezifische PDF-Fehlbehauptung | ✅ |
| `migrate deploy` als idempotent/auto beschrieben | ✅ |
| Working-Tree-Schutz (`theme-provider.tsx`, `test-results/`) eingehalten | ✅ |
| PropertyAI/Dach-KI/HAVEWA-06/-07 unangetastet | ✅ |
| Build / Typecheck / Lint | n. a. (docs-only) |

## 7. Verifikation (lokal durchgeführt)

- `git status --short` zeigt genau vier Einträge (zwei modifizierte
  READMEs, zwei neue Doku-Dateien) plus die vorbestehenden
  `M src/components/theme-provider.tsx` und `?? test-results/`.
- `git diff --check` ist sauber.
- Alle in `README.md`/`README.de.md` aufgeführten Script-Namen wurden
  gegen `package.json` (HEAD) verifiziert.
- Alle in `docs/backup-restore.md` aufgeführten Pfade, Service-Namen,
  Volume-Namen, Container-Namen und DB-Identitäten wurden gegen die
  jeweiligen `docker-compose*.yml`-, `Dockerfile`-,
  `deploy/proxmox/install.sh`- und `src/lib/storage.ts`-Inhalte
  verifiziert.
- Secret-Scan: Keine Klartext-Credentials in den Diffs.

## 8. Working-Tree-Hygiene

- `src/components/theme-provider.tsx` — pre-existing Modification, **nicht angefasst**
- `test-results/` — pre-existing Untracked, **nicht angefasst**
- Keine Staging-, Commit- oder Push-Aktionen ausgeführt.
- Keine PropertyAI-/Dach-KI-Arbeit.

## 9. DEFERRED-Befunde (außerhalb dieses BUILD)

- **docs/flaechenmodell.md Statuszeile** — historisch „bereit zur
  Umsetzung“. Diese Datei ist vom 05C-Scope explizit ausgenommen.
  Konsolidierung mit dem aktualisierten README-Status (Flächenmodell
  implementiert) ist **DEFER** und gehört in eine separate Planung.
- **05B-2-Bericht §7 (PDF-Encoding-Aussage zu `ñ`/`ç`/`á`):** Der
  historische 05B-2-Bericht enthält eine fachlich falsche Aussage
  („nicht in latin1 vorkommen“). Die 05B-2-Doku wird hier **nicht**
  rückwirkend korrigiert; die README-Korrektur in diesem BUILD ist die
  maßgebliche aktuelle Aussage. Korrektur des 05B-2-Berichts ist
  **DEFER**.
- **V-2 (Verbrauchs-Vakanz bei unterjähriger Lease):** bereits
  vorgängig deferred.
- **Empfänger-Locale (`Person.locale` / `Renter.locale` / `Lease.locale`):**
  bereits vorgängig deferred.
- **Timezone-Hinweis in README** — kein 05C-Finding; bleibt
  unverändert, keine Aktion.
