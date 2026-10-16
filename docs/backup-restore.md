# HaVeWa — Backup & Restore Runbook

_Stand: HAVEWA-05C · Quelle: `README.md`, `README.de.md`, `prisma/schema.prisma`,
`src/lib/storage.ts`, `src/lib/crypto.ts`, `docker-compose*.yml`,
`deploy/proxmox/install.sh`, `Dockerfile`._

Dieses Runbook beschreibt, wie ein produktiver HaVeWa-Stand **vollständig**
gesichert und wiederhergestellt wird. Es deckt die beiden realen
Deployment-Pfade ab: **Docker / Docker Compose** und **Proxmox / plain
Debian**. Beide Pfade teilen sich Architektur und Restore-Reihenfolge, die
Service-Namen und Pfade unterscheiden sich aber.

## 1. Zwei gekoppelte Source-of-Truth-Bestandteile

HaVeWa sichert seine Daten an genau zwei Stellen, die zusammen gesichert
werden müssen:

1. **PostgreSQL** — Mandanten, Stammdaten, Buchungen, Dokumente-Metadaten,
   verschlüsselte Tenant-Secrets, McpApproval-Args, Bank-Connector.
2. **Lokales Filesystem** — Datei-Inhalte (Uploads, PDFs, Mail-Attachments,
   Logos, gespeicherte Dokumente). Verwaltet über `src/lib/storage.ts`,
   Basis `<cwd>/storage/documents`.

DB und Filesystem sind über `storageKey` (siehe `Document.storageKey`,
`Tenant.logoKey`, `InboundEmailAttachment.storageKey`) logisch gekoppelt.
**DB allein reicht nicht. Filesystem allein reicht nicht.**

## 2. Architektur-Fakten (geprüft gegen HEAD)

- **DB-Engine:** PostgreSQL 16 (`postgres:16-alpine` in allen Compose-Dateien).
- **DB-Service (Compose):** `db` (alle Compose-Dateien).
- **Container-Name:** `havewa-db`.
- **DB-Name:** `havewa`.
- **DB-User:** `havewa`.
- **Storage-Typ:** lokales Filesystem (`src/lib/storage.ts`, kein S3/MinIO).
- **Storage-Basis:** `<cwd>/storage/documents` — d. h. im Container
  `/app/storage/documents`, auf Proxmox/Debian
  `/var/lib/havewa/storage/documents`.
- **Docker-Volumes:**
  - `havewa-storage` → `/app/storage` (Dokumente/Logos/PDFs/Attachments).
  - `havewa-db` → `/var/lib/postgresql/data` (PostgreSQL-Daten).
- **Proxmox / plain Debian:** Storage liegt unter
  `/var/lib/havewa/storage` (siehe `deploy/proxmox/install.sh`,
  `DATA_DIR="${HAVEWA_DATA_DIR:-/var/lib/havewa}"`).
- **Migrations:** Docker-Image-`CMD` führt
  `npx prisma migrate deploy` automatisch beim Container-Start aus
  (`Dockerfile`, letzte Zeile). Proxmox-Installer führt
  `npx prisma migrate deploy` explizit aus (`deploy/proxmox/install.sh`).

## 3. Backup-Konsistenz (Pflicht)

DB und Filesystem werden unabhängig voneinander konsistent gesichert
(`pg_dump` ist ein einzelner Snapshot, `tar` des Storage-Volumes ist ein
Punkt-in-der-Zeit-Abbild), **aber nicht atomar gemeinsam**. Während des
Backups neu erzeugte oder gelöschte Dokumente könnten sonst einseitig
in einem der beiden Artefakte landen → verwaiste Datei oder
verwaister DB-Eintrag.

**Empfehlung: vor jedem Backup den App-Service stoppen, den DB-Service
für `pg_dump` weiterlaufen lassen, dann beide Teile sichern, dann den
App-Service wieder starten.**

```bash
# Docker (Beispiel — Dateinamen an den realen Compose-Stand anpassen)
docker compose -f docker-compose.prod.yml stop app
# pg_dump + Storage-Tar hier ausführen (siehe §4 und §6)
docker compose -f docker-compose.prod.yml start app
```

Ein applikationsseitiger Read-only-Modus existiert in der aktuellen
Architektur **nicht** — er darf nicht erfunden werden. Wer auf
Service-Stop verzichten will, muss die unscharfe Snapshot-Fenster
ausdrücklich akzeptieren und dokumentieren.

## 4. Datenbank-Backup (`pg_dump`)

Empfohlene Methode: `pg_dump` im **Custom-Format** (`-Fc`). Das
Custom-Format ist komprimiert, lässt sich selektiv wiederherstellen
(`pg_restore --table …`) und ist robuster als das Plain-Text-Format.

`pg_dumpall` ist **nicht** erforderlich: Es gibt nur eine Datenbank
(`havewa`) und nur eine Anwendungsrolle (`havewa`).

### 4.1 Docker

```bash
# Compose-Datei an den realen Stand anpassen
# (docker-compose.prod.yml | docker-compose.shared.yml |
#  docker-compose.registry.yml). Beispiel hier: Prod-Standalone.
COMPOSE_FILE="docker-compose.prod.yml"

# DB-Passwort aus der realen .env-Datei (NICHT einchecken)
set -a; . ./.env; set +a

# Backup in eine Datei außerhalb des Containers
docker compose -f "$COMPOSE_FILE" exec -T db \
  pg_dump -U havewa -d havewa -Fc \
  > "havewa-db-$(date -u +%Y%m%dT%H%M%SZ).dump"

# Exit-Code prüfen — pg_dump gibt Non-Zero bei Fehlern zurück
echo "pg_dump exit: $?"
```

- `-T` deaktiviert TTY-Zuweisung und ermöglicht sauberes Redirect.
- `pg_dump` läuft im Container unter dem `postgres`-User und verbindet sich
  per Unix-Socket als Rolle `havewa`. Das `PGPASSWORD` (bzw. das in der
  Compose-Datei gesetzte `POSTGRES_PASSWORD`) wird beim Connect
  automatisch verwendet.
- Die `.dump`-Datei sollte **außerhalb** des Containers aufbewahrt werden
  (Host-Volume, Backup-Server, …).

### 4.2 Proxmox / plain Debian

```bash
# Auf dem Host oder im Container, je nach Setup
sudo -u postgres pg_dump -U havewa -d havewa -Fc \
  -f "havewa-db-$(date -u +%Y%m%dT%H%M%SZ).dump"

# Exit-Code prüfen
echo "pg_dump exit: $?"
```

`postgres`-Peer-Authentifizierung ist in der Standard-`pg_hba.conf`
üblich, daher ohne `PGPASSWORD` möglich. Falls die Installation auf
MD5/SCRAM-Auth umgestellt ist, `PGPASSWORD` aus dem Env-File
(`/etc/havewa.env`) verwenden.

## 5. Datenbank-Restore (`pg_restore`)

Restore zu einem **frischen, leeren** Stand. Bei laufender App zuerst
stoppen (siehe §3 / §8).

### 5.1 Docker

```bash
COMPOSE_FILE="docker-compose.prod.yml"
set -a; . ./.env; set +a

# 1) Leere DB bereitstellen (z. B. via Postgres-RESTORE in eine
#    frisch initialisierte Datenbank). Im einfachsten Fall:
docker compose -f "$COMPOSE_FILE" down db           # stoppt + entfernt Container
docker compose -f "$COMPOSE_FILE" up -d db          # frischer Init mit POSTGRES_DB=havewa
docker compose -f "$COMPOSE_FILE" exec -T db \
  pg_isready -U havewa                               # warten, bis DB ready

# 2) Schema-Stand prüfen, Dump einspielen
docker compose -f "$COMPOSE_FILE" exec -T db \
  dropdb -U havewa --if-exists havewa
docker compose -f "$COMPOSE_FILE" exec -T db \
  createdb -U havewa -O havewa havewa
docker compose -f "$COMPOSE_FILE" exec -T db \
  pg_restore -U havewa -d havewa --no-owner --role=havewa \
  < havewa-db-<TIMESTAMP>.dump

# Exit-Code prüfen
echo "pg_restore exit: $?"
```

`pg_restore` kann während des Einspielens **Fehler-Meldungen** für
bereits vorhandene oder schemakollidierende Objekte ausgeben — der
Exit-Code ist die maßgebliche Quelle. Im Zweifel: zuerst in eine
frisch initialisierte DB restoren.

### 5.2 Proxmox / plain Debian

```bash
# 1) Aktuelle Datenbank sichern, dann leeren
sudo -u postgres dropdb --if-exists havewa
sudo -u postgres createdb -O havewa havewa

# 2) Dump einspielen
sudo -u postgres pg_restore -d havewa --no-owner --role=havewa \
  havewa-db-<TIMESTAMP>.dump

echo "pg_restore exit: $?"
```

**Wichtig:** Destruktive Kommandos (`dropdb`, `createdb`) gehören
ausschließlich in den Restore-Kontext und müssen explizit so markiert
sein — nicht im normalen Betrieb verwenden.

## 6. File-Storage-Backup

Was unter dem Storage-Volume liegt (bestätigt in `src/lib/storage.ts`
und den Speicherorten):

- Hochgeladene Dokumente (`Document.storageKey`)
- Logos (`Tenant.logoKey`)
- Mail-Attachments eingehend (`InboundEmailAttachment.storageKey`) und
  ausgehend (`EmailAttachment` liest aus `Document.storageKey`)
- Generierte PDFs (Abrechnungen, Wohnungsgeberbestätigung)

### 6.1 Docker

```bash
# Variante A: Docker-Volume als Tar (routed über einen temporären Container)
docker run --rm \
  -v havewa-storage:/source:ro \
  -v "$(pwd)":/backup \
  alpine \
  tar -czf "/backup/havewa-storage-$(date -u +%Y%m%dT%H%M%SZ).tar.gz" -C /source .

# Variante B: direkt aus dem app-Container (wenn vorhanden und
# ausgeschaltet)
# docker compose -f "$COMPOSE_FILE" exec -T app \
#   tar -czf - -C /app/storage . > "havewa-storage-<TIMESTAMP>.tar.gz"
```

### 6.2 Proxmox / plain Debian

```bash
DATA_DIR="${HAVEWA_DATA_DIR:-/var/lib/havewa}"

tar -czf "havewa-storage-$(date -u +%Y%m%dT%H%M%SZ).tar.gz" \
  -C "$DATA_DIR" storage

echo "tar exit: $?"
```

## 7. ENV, Secrets und AUTH_SECRET

Separates, **verschlüsselt** zu sicherndes Artefakt: das
Deployment-Env-File.

| Variable | Quelle / Wichtigkeit |
|---|---|
| `DB_PASSWORD` | PostgreSQL-Passwort der Rolle `havewa` (Compose-Prod) |
| `AUTH_SECRET` | Doppelt kritisch (siehe unten) |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_NAME` | Optional, nur bei SSO |
| `DOMAIN` | Prod-Caddy-Konfiguration |
| `SEED_DEMO`, `ADMIN_*`, `TENANT_NAME` | Optional, Bootstrap beim ersten Start |

**Regeln:**

- Im Repo liegen **nur** `.env.example` und `.env.prod.example` mit
  Platzhaltern. Echte Werte gehören in eine `.env` außerhalb des Repos
  oder in einen Secret-Store (z. B. HashiCorp Vault, systemd-creds).
- Backups dieser Datei müssen **verschlüsselt** und mit restriktiver
  Berechtigung abgelegt werden.
- Beispielsektionen in diesem Runbook sind mit `set -a; . ./.env; set +a`
  bzw. `PGPASSWORD=…` abstrakt; **kein** Klartext-Credential in
  Doku- oder Beispielcode.

### AUTH_SECRET — zwei Rollen

`AUTH_SECRET` hat im aktuellen Stand mindestens zwei sicherheitskritische
Verwendungen:

1. **Session-/Auth-Signierung** (next-auth). Eine Änderung des Werts
   macht alle bestehenden Sessions ungültig.
2. **Schlüsselableitung für verschlüsselte at-rest-Secrets in der DB**
   via `scrypt(AUTH_SECRET, "havewa-secret-v1", 32)` (siehe
   `src/lib/crypto.ts`). Verschlüsselt sind u. a.:

   - `Tenant.aiApiKey`
   - `Tenant.smtpPassword`
   - `Tenant.imapPassword`
   - `BankConnector.privateKeyEnc`
   - `McpApproval.argsEnc`

Diese Felder werden als `v1:…`-Ciphertext in den Dump geschrieben und
mit dem **ursprünglichen** `AUTH_SECRET` wieder entschlüsselt. Folgen
bei Verlust/Änderung des `AUTH_SECRET` nach dem Restore:

- Der übrige DB-Dump bleibt grundsätzlich restorebar (alle anderen
  Felder sind Klartext).
- Die oben genannten verschlüsselten Felder sind **nicht mehr
  entschlüsselbar**; die App schlägt beim ersten Zugriff auf einen
  dieser Werte mit `SecretDecryptionError` fehl (fail closed).
- Bestehende Sessions werden ungültig (alle Nutzer werden
  ausgeloggt).

Daher beim Restore **immer das originale** `AUTH_SECRET` aus der
Env-Sicherung verwenden — kein neues generieren.

> **Nicht formulieren** als „ohne `AUTH_SECRET` ist der DB-Dump
> nutzlos“. Das wäre zu stark; nur die verschlüsselten Felder
> sind betroffen.

## 8. Restore-Reihenfolge

Die folgenden Schritte sind in genau dieser Reihenfolge auszuführen:

1. **App stoppen / Writes verhindern.** `docker compose stop app` bzw.
   `systemctl stop havewa`. DB-Service weiterlaufen lassen.
2. **PostgreSQL wiederherstellen** gemäß §5.
3. **Storage wiederherstellen** (z. B. `tar -xzf … -C "$DATA_DIR"`).
4. **Environment / Secrets bereitstellen**, insbesondere das
   **originale** `AUTH_SECRET` und `DB_PASSWORD`.
5. **Migrations-Stand prüfen** (`prisma migrate status`).
6. **Falls die App-Version neuer ist als die wiederhergestellte DB**,
   `prisma migrate deploy` ausführen. Sonst ist der Schritt ein
   No-op (idempotent). In Docker läuft dieser Schritt automatisch
   beim Container-Start (`Dockerfile`-`CMD`); im Proxmox-Installationspfad
   wird er vom Installer ausgeführt.
7. **App starten.**
8. **Smoke-/Restore-Validation** gemäß §9.

## 9. `prisma migrate deploy` — Semantik

- **Restore derselben App-/DB-Version:** `migrate deploy` ist
  idempotent (No-op, falls die DB bereits auf dem erwarteten Stand
  ist). Es schadet nicht, ist aber nicht zwingend.
- **Restore einer älteren DB auf neuere App-Version:** `migrate deploy`
  ist **erforderlich**, um das Schema auf den erwarteten Stand zu
  bringen.
- **Docker-Start:** `npx prisma migrate deploy` läuft automatisch als
  Teil des `CMD` (`Dockerfile`, letzte Zeile) — manueller Aufruf ist
  redundant, aber unschädlich.
- **Proxmox-Installationspfad:** `deploy/proxmox/install.sh` führt
  `npx prisma migrate deploy` explizit aus.

Runbook: „`migrate deploy` ist idempotent und nur dann zwingend, wenn
die wiederhergestellte DB-Version älter ist als die App-Version.
Docker-Container und Proxmox-Installer führen den Schritt ohnehin
aus.“ **Nicht:** „`migrate deploy` ist nach jedem Restore zwingend“.

## 10. Restore-Validation (Smoke)

Nach dem App-Start mindestens prüfen:

- PostgreSQL erreichbar (`pg_isready -U havewa` bzw. App-Healthcheck).
- `prisma migrate status` plausibel (keine pending migrations gegen
  die App-Version).
- Login mit einem Admin-Konto möglich.
- Mindestens ein Mandant in der UI sichtbar; Stammdaten
  (Objekte/Einheiten/Personen) plausibel.
- Mindestens ein Dokument/Upload herunterladbar (Storage-Pfad
  intakt, `storageKey` löst auf eine reale Datei auf).
- Eine Statement-Seite lädt und rendert (Core-Pfad).
- Keine Storage-/`SecretDecryptionError`-Einträge in den
  Container-/Service-Logs.

Es ist **keine** neue Test-Suite erforderlich; die obigen
Schritte genügen für ein Runbook.

## 11. Docker vs. Proxmox — Unterschiede

| Aspekt | Docker / Compose | Proxmox / plain Debian |
|---|---|---|
| Container/Service | `app` (oder `havewa` im Shared-Mode), `db` (Container `havewa-db`) | nativ, `systemd`-Service `havewa` |
| Storage-Pfad | `/app/storage/documents` (Volume `havewa-storage`) | `/var/lib/havewa/storage/documents` (Symlink `$DATA_DIR/storage`) |
| Storage-Volume | Docker-Volume `havewa-storage` | Host-Verzeichnis `DATA_DIR/storage` |
| `pg_dump` | `docker compose -f <FILE> exec -T db pg_dump …` | `sudo -u postgres pg_dump …` |
| `pg_restore` | `docker compose -f <FILE> exec -T db pg_restore …` | `sudo -u postgres pg_restore …` |
| Migrations | laufen automatisch beim Container-Start | laufen explizit im Installer / Updater |
| App-Steuerung | `docker compose -f <FILE> stop app` | `systemctl stop havewa` |
| Compose-Datei | `docker-compose.prod.yml`, `docker-compose.shared.yml`, `docker-compose.registry.yml` | n. a. |

Diese Unterschiede ergeben sich direkt aus den Deploy-Dateien
(`docker-compose*.yml`, `deploy/proxmox/install.sh`, `Dockerfile`).
Weitere Deployment-Varianten sind im aktuellen Stand **nicht**
offiziell dokumentiert und sollten hier nicht erfunden werden.
