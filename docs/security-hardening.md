# Security Hardening (HAVEWA-02)

Dieses Dokument beschreibt die beiden Sicherheitsmaßnahmen des
Increments HAVEWA-02: **Secrets-at-Rest-Verschlüsselung** und die
**MCP-Human-Approval-Boundary**.

## 1. Secrets at Rest

Die drei Mandanten-Secrets werden **nie mehr als Klartext** neu persistiert:

| Feld               | Modell   | Verschlüsselung |
| ------------------ | -------- | --------------- |
| `aiApiKey`         | `Tenant` | AES-256-GCM     |
| `smtpPassword`     | `Tenant` | AES-256-GCM     |
| `imapPassword`     | `Tenant` | AES-256-GCM     |

Es wird die **bestehende** Krypto-Infrastruktur aus `src/lib/crypto.ts`
wiederverwendet (identisch zum Bank-Connector-Private-Key, kein zweites
Krypto-System). Format: `v1:` + Base64(iv[12] | tag[16] | ciphertext).

- Verschlüsselung ausschließlich **serverseitig** (Server Actions / API-Operationen).
- Kein Secret verlässt den Server: Die Settings-Seite lädt nur `hasKey` /
  `hasPassword`-Booleans; der Klartext wird nie an den Client, in Logs,
  Fehlermeldungen, API-Antworten, Audit-Einträge oder HTML zurückgegeben.
- **UX bleibt erhalten:** leeres Secret-Feld = bestehenden Wert behalten;
  nur bei expliziter Eingabe wird neu verschlüsselt.

### Encryption Key

Der Schlüssel wird aus `AUTH_SECRET` abgeleitet (via `scryptSync`).
**`AUTH_SECRET` muss über die Lebensdauer der Daten stabil bleiben** —
ein Wechsel macht alle at-rest Secrets unlesbar. Im Dev-Betrieb greift der
bestehende Fallback `havewa-dev-secret-change-me` (nur für lokale Entwicklung).

### Legacy-Plaintext-Migration

Bestehende Installationen können noch Klartext-Werte enthalten. Der
Lese-Pfad (`decryptSecretValue`) erkennt verschlüsselte (`v1:…`) von
Klartext-Werten:

- Klartext wird für eine Übergangszeit unverändert gelesen (Kompatibilität).
- Beim nächsten expliziten Update wird der Wert verschlüsselt gespeichert.

Für den Stable-Core-Zielzustand gibt es zusätzlich eine **explizite, kontrollierte
Migration** (`scripts/migrate-legacy-secrets.ts`, Aufruf `npm run db:migrate-secrets`):

- läuft tenant-/feldweise über `Tenant.aiApiKey`, `Tenant.smtpPassword`,
  `Tenant.imapPassword`;
- überspringt bereits verschlüsselte Werte (validiert sie, keine
  Doppelverschlüsselung) und verschlüsselt nur echte Legacy-Plaintext-Werte;
- ist **idempotent** (mehrfach ausführbar) und gibt ausschließlich Zähler/Status
  aus (`scanned` / `alreadyEncrypted` / `migrated` / `failed`) — nie Secret-Werte;
- **fail closed**: ohne `AUTH_SECRET` bricht sie ab; korrupte oder mit fremdem
  Schlüssel erzeugte `v1:`-Werte bleiben unverändert und werden als `failed`
  gemeldet (Exit-Code 1);
- `--dry-run` zeigt anstehende Änderungen ohne Schreibzugriff;
- wird **nicht** automatisch beim App-Start ausgeführt (keine automatische,
  destruktive Massen-Migration).

### Fail-Closed

Bei fehlendem/geändertem Schlüssel, korruptem Ciphertext oder Auth-Tag-Fehler
wirft die Entschlüsselung einen typisierten `SecretDecryptionError`
(sanitized, ohne Ciphertext/Secret) und fällt **nicht** still auf ENV oder
leer zurück. ENV-Fallback (`ANTHROPIC_API_KEY`, `SMTP_PASSWORD`, `IMAP_PASSWORD`
usw.) greift weiterhin nur, wenn der Mandant **kein** eigenes Secret hinterlegt
hat.

## 2. MCP Human Approval Boundary

Der MCP-Server (`src/app/api/mcp`) verlangt für **materielle, destruktive,
finanzielle, rechtlich erhebliche oder externe Kommunikation auslösende**
Aktionen eine menschliche Freigabe. Bearer-Token + Rollen-Autorisierung bleiben
notwendig, sind aber nicht mehr hinreichend.

### Ablauf

1. Externer Agent ruft ein MCP-Tool auf (Bearer-Token).
2. Server klassifiziert die Aktion (`src/lib/mcp-risk.ts`).
3. Ist Freigabe erforderlich, wird die Aktion **nicht** ausgeführt, sondern ein
   `PENDING`-Zustand erzeugt (`McpApproval`) und dem Client ein strukturierter
   Zustand zurückgegeben:
   `{ "status": "APPROVAL_REQUIRED", "approvalId": "...", "tool": "...", "summary": "..." }`.
4. Ein Mensch gibt die Aktion in HaVeWa (Einstellungen → KI & API) frei oder lehnt sie ab.
5. Erst nach Freigabe wird die Aktion **at-most-once** ausgeführt (siehe unten).

Die Freigabe ist **serverseitig gebunden** und niemals vom Modell/Request
behauptbar (`approved=true` o. ä. existiert nicht als Autorität).

### Klassifikation

| Klasse | Beispiele | Approval? |
| ------ | --------- | --------- |
| `READ_ONLY` | `list_*`, `get_*`, `portfolio_summary`, `list_entities`, `list_operations` | nein |
| `LOW_RISK_WRITE` | `create_task`, `create_ticket`, `create_person`, `advance_maintenance`, `add_ticket_time`, `toggle_task`, low-risk `create/update_record` | nein |
| `DESTRUCTIVE_WRITE` | `delete_record` (jede Entität) | **ja** |
| `FINANCIAL_OPERATION` | `run_charge_generation`, `run_dunning`, `apply_adjustment`, `import_camt`; `create/update_record` für `charge`, `payment`, `deposit`, `account`, `cost`, `economic-plan`, `reserve`, `reserve-transaction`, `insurance`, `property-tax`, `component`, `adjustment`, `owner` | **ja** |
| `LEGAL_EFFECT_OPERATION` | `create/update_record` für `lease`, `mandate`, `resolution` | **ja** |
| `EXTERNAL_COMMUNICATION` | `run_operation` → `send_email` | **ja** |
| `MATERIAL_WRITE` | `run_operation` → `upload_document` | **ja** |
| `CONFIG_SECURITY_OPERATION` | `run_operation` → `update_ai_config`, `update_smtp_config`; `create/update_record` → `user` | **ja** (nur Admin) |

### Sicherheitsgarantien

- **Tenant-Bindung:** Freigabe nur innerhalb desselben Mandanten (cross-tenant unmöglich).
- **Rollen-Bindung:** Freigebender muss Schreibrecht besitzen; Config/Security-Operationen nur durch ADMIN.
- **Replay-Schutz:** atomarer Zustandsübergang `PENDING → APPROVED` verhindert Doppel-/Mehrfach-Ausführung (single-claim).
- **Audit:** jede materielle MCP-Aktion erzeugt einen `AuditLog`-Eintrag (Requester, Tool, Zeitpunkt, Entscheidung, Ausgang) — ohne Secret-Inhalte.
- **Keine Secret-Persistenz in der Freigabe:** `McpApproval.argsEnc` liegt AES-256-GCM-verschlüsselt.

### Ausführungssemantik: AT-MOST-ONCE (nicht exactly-once)

Die Boundary garantiert **at-most-once** (single-claim, replay-geschützt),
**nicht** exactly-once:

- **Replay verhindert:** der atomare Claim `PENDING → APPROVED` stellt sicher,
  dass eine Freigabe nicht doppelt ausgeführt werden kann.
- **Doppel-Ausführung verhindert:** derselbe Claim kann nicht zweimal gewonnen werden.
- **Kein automatischer Retry:** ein Crash/Fehler **nach** dem Claim kann die Aktion
  verlieren. Es gibt bewusst keine automatische Wiederholung und keine
  Distributed-Transaction-/Workflow-Engine — für destruktive MCP-Aktionen ist
  at-most-once sicherer als eine riskante automatische Wiederholung.

### Ausführungs- und Fehlerzustände

Ein `McpApproval` unterscheidet diese Zustände; sie dürfen **nicht** semantisch
als „erfolgreich ausgeführt“ dargestellt werden:

| Zustand | Bedeutung |
| ------- | --------- |
| `PENDING` | noch nicht entschieden, Aktion wurde **nicht** ausgeführt |
| `REJECTED` | abgelehnt, Aktion wurde **nie** ausgeführt |
| `APPROVED` + `outcome=OK` + `executedAt` gesetzt | **EXECUTED** — erfolgreich ausgeführt |
| `APPROVED` + `outcome=FEHLER` | **FAILED** — ausgeführt, aber mit Fehler (wird als Fehler gemeldet) |
| `APPROVED` + kein `outcome`/`executedAt` | **EXECUTION_UNKNOWN / NOT_COMPLETED** — nach dem Claim abgebrochen (Crash); Ausgang unbekannt, kein automatischer Retry |

Die Freigabe-Oberfläche zeigt aktuell nur `PENDING`-Einträge (Freigeben/Ablehnen);
ein fehlgeschlagener Lauf wird dem Freigebenden als Fehler gemeldet, nicht als
Erfolg.

### Admin-only Security-/Config-Operationen

`update_ai_config`, `update_smtp_config` und `create/update_record → user`
(Credentials/RBAC) sind **ausschließlich** einem ADMIN vorbehalten — konsistent
für das **Anfordern** (Request-Gate) **und** das **Freigeben/Ablehnen**:

- ein Nicht-Admin kann diese Aktionen weder ausführen noch anfordern;
- nur ein ADMIN darf die zugehörige Freigabe **erteilen oder ablehnen**.

## Kompatibilität

- Bestehende Read-Tools funktionieren unverändert.
- REST-API v1 und die normale HaVeWa-UI sind **nicht** von der Approval-Boundary
  betroffen (die Boundary sichert ausschließlich die extern-agentische
  MCP-Ausführung ab).
- Bei Freigabe liefert das Tool `APPROVAL_REQUIRED` statt eines Fake-Success.
