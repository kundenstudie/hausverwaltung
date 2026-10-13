# HAVEWA-04 — API Completeness & Tenant Timezone (Abschlussbericht)

Stand: 2026-10-13 · MODE BUILD · HEAD `a881c7b4ae0071596a298c4af161e229d0f425a6`

Vorgänger-Status (bestätigt, nicht erneut verändert): HAVEWA-01/02/02V/02F/03 = PASS.

---

## 1. Ergebnis

**HAVEWA-04 = PASS.**

Zwei P2-/Small-Completion-Themen aus HAVEWA-01 wurden abwärtskompatibel geschlossen:

- **A. API List Completeness** — Pagination / Filter / Sort für alle `/api/v1`-Listen.
- **B. Tenant Timezone** — IANA-Zeitzone je Mandant (Default `Europe/Berlin`), Display +
  lokale Tagesgrenzen, DST-korrekt.

## 2. API-Pagination-Contract

Ein konsistentes, abwärtskompatibles Schema für alle Listen-Endpunkte.

**Legacy (ohne List-Parameter):** Antwort bleibt das bisherige Bare-Array `[ ... ]` —
unverändert. Bestehende MCP-Tools, PropertyAI-Read-Adapter und externe Clients brechen nicht.

**Paginiert (mind. ein List-Parameter gesetzt):**

```json
{
  "data": [ ... ],
  "pagination": {
    "page": 1,
    "pageSize": 50,
    "total": 123,
    "totalPages": 3,
    "hasNext": true,
    "hasPrevious": false
  }
}
```

- `page` 1-basiert, Default 1.
- `pageSize` Default 50, hartes Maximum 200.
- Ungültige Eingaben (`page=0`, negative, NaN, `pageSize=201`, unbekannter Filter/Sort) → **400**.
- **Deterministische Ordnung:** jede paginierte Query erhält den `id`-Tiebreaker.
- **Tenant-Scope bleibt zuerst:** `tenantId` + fachliche Filter + Sort + Pagination.
  Cross-Tenant-IDs liefern leer (kein Existenz-Leak).

## 3. Filter / Sort (Whitelists)

- **Filter:** explizit whitelisted je Endpoint (Enum-/ID-/Boolean-/Int-Filter). Keine
  generische Prisma-Where-API nach außen. Beispiele: `status`, `type`, `priority`,
  `category`, `direction`, `propertyId`, `unitId`, `leaseId`, `accountId`, `chargeId`,
  `done` (bool), `year` (int).
- **Sort:** Whitelist je Endpoint (`sort=<feld>&order=asc|desc`). Immer deterministischer
  Tie-Breaker (`id`). Alle Whitelists zentral in `LIST_CONFIG` (`src/lib/api-data.ts`) und
  werden auch zur Generierung der OpenAPI-Doku verwendet (keine Dokumentationslüge).

## 4. MRC-04 (Rent Adjustment History)

**Vorher:** `PAGINATION_INCOMPLETE` — `take: limit` ohne Total-Count; `pagination.count`
= gelieferte Items, Vollständigkeit nicht beweisbar.

**Nachher (HaVeWa-Seite):** `listLeaseRentAdjustments` liefert jetzt
`pagination.total` (echte Gesamtzahl via `count`) und unterstützt `offset`. Abwärtskompatibel:
`items` + `pagination.count/limit` bleiben erhalten (PropertyAI-Validator liest weiterhin nur
`count`/`limit`), zusätzlich `total` + `offset`. Die Historie ist vollständig deterministisch
iterierbar (getestet mit 75 Datensätzen > Default-Page-Size, keine Duplikate, kein Abschneiden).

**MRC-04 external read capability: PARTIAL.**

Begründung: Der HaVeWa-API-Vertrag ist nun vollständig (Total + Offset + deterministische
Ordnung → „Vollständigkeit beweisbar"). Der PropertyAI-Read-Adapter bleibt jedoch
unverändert (Scope-Grenze) und konsumiert weiterhin nur `?limit=` und liest nur
`count`/`limit` (verwirft `total`, nutzt kein `offset`). Damit ist die vollständige
Iteration API-seitig verfügbar, aber vom externen Reader noch nicht genutzt. PropertyAIs
eigenes MRC-Registry bleibt daher (korrekt) bei `PAGINATION_INCOMPLETE`, bis der Adapter
Offset/Total übernimmt.

## 5. Tenant Timezone

- **Prisma:** `Tenant.timeZone String @default("Europe/Berlin")` (Migration
  `20261013200812_tenant_timezone`). Bestehende Tenants behalten semantisch `Europe/Berlin`.
- **Validierung:** `isValidIanaTimezone` (serverseitig, `Intl.DateTimeFormat`). Nur gültige
  IANA-Identifier; ungültig → Validation-Error.
- **Semantik:** absolute Timestamps bleiben UTC/DB. Die Zeitzone wird nur für Anzeige
  (`dateTime(..., tz)`) und lokale Tagesgrenzen (`startOfDayInTimeZone`/`endOfDayInTimeZone`)
  genutzt. Kein massenhaftes Date-Refactoring.
- **DST:** `Europe/Berlin` Sommer-/Winterzeit inkl. Übergängen (29.03./25.10.2026, 23h/25h-Tage)
  getestet — ohne manuelle +1/+2-Stunden-Annahmen.
- **Settings-UI:** `TimezoneConfig` (Dropdown, IANA), Server-Action `updateTimeZone`
  (ADMIN, Audit, revalidate). Default sichtbar.
- **Scheduler:** geprüft (`run_charge_generation`/`run_dunning` nutzen UTC-Monatsgrenzen;
  Datumswerte sind Datums-Felder). Es gab keine fachliche Europe/Berlin-Festcodierung mit
  Mandanten-Auswirkung, die geändert werden musste — nur die Display-Schicht war festkodiert.

## 6. Tests & Qualität

| Gate | Ergebnis |
|------|----------|
| Unit-Tests | 247 PASS (38 Dateien; vorher 217) |
| Integration-Tests | 65 PASS (8 Dateien; vorher 50) |
| `npm run test:all` | 312/312 PASS |
| TypeScript `tsc --noEmit` | PASS |
| Lint | 89 Errors / 16 Warnings (= Baseline, **0 neue** Findings) |
| Build `next build` | PASS (✓ Compiled successfully) |
| Playwright E2E | Test ergänzt (Settings→Zeitzone→Speichern→Reload); Ausführung durch fehlende Chromium-System-Libs (`libnspr4.so`) im WSL ohne `sudo` blockiert (Umgebungs-Limitation, kein Code-Fehler) |

Neu: `src/lib/api-list.ts` + `api-list.test.ts`, `src/lib/timezone.ts` + `timezone.test.ts`,
`src/lib/tenant-timezone.ts`, `src/components/timezone-config.tsx`,
`src/test/havewa-04.integration.test.ts`, Migration `20261013200812_tenant_timezone`.

## 7. Scope-Grenzen eingehalten

Keine Dach-KI, kein OCR/RAG, keine neuen AI-Provider/MCP-Tools, kein General Ledger,
keine neuen Immobilien-/Business-/Betriebskosten-/Heizkosten-/Dokument-/Banking-Features.
PropertyAI unverändert. `theme-provider.tsx` unverändert.
