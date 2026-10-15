# HAVEWA-05A — Heating Fallback Transparency (Abschlussbericht)

Stand: 2026-10-15 · MODE BUILD · HEAD `7e075ace853e34a057bea5c375d6ffcbcf3e5efc`

Vorgänger: HAVEWA-01/02/02V/02F/03/04 = PASS.

---

## 1. Ergebnis

**HAVEWA-05A = PASS.** Zwei Heating-Transparenz-Befunde aus dem Review geschlossen:

- **H-1 (Heiz-/Warmwasserkosten mit method=CONSUMPTION und fehlendem Verbrauch):** Der effektive Modus wird jetzt strukturiert erfasst und überall sichtbar gemacht, wo das Statement angezeigt, gedruckt oder per E-Mail verschickt wird.
- **H-2 (Admin-/Print-/E-Mail-PDF 30/70-Pauschalbehauptung):** Kein pauschaler 30/70-Hinweis mehr, wenn der effektive Modus nicht METER ist. Die Darstellung entspricht exakt dem, was die Berechnung tatsächlich gemacht hat.

Keine Berechnungslogik geändert. Beträge, totalUmlage, Rounding und Split-Prozente sind unverändert.

## 2. Heating-Metadatenstruktur

Eine neue, statement-weite Zusammenfassung wird von `buildStatement` mit zurückgegeben
und über `computeStatement` an alle Ausgabe-Pfade weitergereicht.

```ts
export interface HeatingAllocation {
  mode: "NONE" | "METER" | "AREA_FALLBACK" | "MIXED";
  meterCosts: number;     // Heizpositionen mit Verbrauchsdaten im scope
  fallbackCosts: number;  // Heizpositionen ohne Verbrauchsdaten (effect. Fläche)
  relevantCosts: number;  // meterCosts + fallbackCosts
}
```

Semantik:

| Mode | Bedeutung |
|------|-----------|
| **NONE** | Keine relevanten Heiz-/Warmwasserpositionen im Statement (entweder keine Heating-Posten oder nicht umlagefähig / amount ≤ 0 / leerer scope). Kein Hinweis wird gerendert. |
| **METER** | Alle relevanten Heizpositionen konnten meter-/verbrauchsbasiert verarbeitet werden (Grundkosten Fläche + Verbrauchskosten Zähler). Klassischer HeizkostenV-Split. |
| **AREA_FALLBACK** | Mindestens eine relevante Heizposition mit `method=CONSUMPTION` musste wegen fehlendem Verbrauch auf Fläche zurückfallen. |
| **MIXED** | Innerhalb desselben Statements existieren sowohl meterbasierte als auch AREA-Fallback-Heizpositionen (typisch: Untergemeinschaften / Scopes mit unterschiedlicher Datenlage). |

Wichtig: `method=AREA` (oder `UNITS|PERSONS|MEA|CUSTOM`) bei `heating=true` zählt
bewusst nicht als Fallback, sondern ist ein explizit gewählter Schlüssel. Solche
Positionen ergeben `mode = NONE` (kein Hinweis nötig), damit kein irreführender
30/70-Hinweis erscheint.

## 3. Ableitung

`deriveHeatingAllocation(units, costs)` läuft über die tatsächlich verarbeiteten
Heizpositionen. Pro Position:

1. Skip wenn `!heating || !umlagefaehig || amount <= 0`.
2. Scope = `cost.unitIds ? units.filter(...) : units` — Untergemeinschaften
   werden korrekt berücksichtigt.
3. `totalConsumption` wird **innerhalb des scopes** summiert.
4. Klassifikation:
   - `method === "CONSUMPTION" && totalConsumption > 0` → `meterCosts++`
   - `method === "CONSUMPTION" && totalConsumption <= 0` → `fallbackCosts++`
   - andere Methoden → kein Zähler (kein Fallback).

Aggregationsregel: `meterCosts + fallbackCosts = 0` → `NONE`, sonst Meldung
gemäß Mischverhältnis.

## 4. Verbrauchssicherheit (Regressionsschutz)

Die bestehende Berechnungslogik (`buildStatement`) bleibt vollständig erhalten.
`HeatingAllocation` wird aus den gleichen Inputs abgeleitet, die auch die
Berechnung verwendet — d. h. Modus und Betragsergebnis sind konsistent.

Tests in `src/lib/allocation/statement.heating.test.ts` sichern explizit:

- METER: 1000 € → 360/640 (Grundkosten 300 + Verbrauch 700)
- METER mit `consumptionShare=1`: 1000 € → 300/700
- METER mit `consumptionShare=0.5`: 1000 € → 400/600
- AREA_FALLBACK: 1000 € → 500/500 (Fläche)
- MIXED: 500/500 additiv korrekt
- Cent-Rounding: 1000 + 400 = 1400 € bleibt 1400 €

## 5. UI-/Text-Anpassungen

### Admin-UI (`statements/page.tsx`)

- Badge in der Ergebnis-Card-Header-Zeile:
  - `METER` → „Heizung: Verbrauch (HeizkostenV)" (sekundär)
  - `AREA_FALLBACK` → „Heizung: Flächenverteilung (Fallback)" (outline)
  - `MIXED` → „Heizung: gemischt (Verbrauch + Fläche)" (sekundär)
  - `NONE` → kein Badge
- Zusätzliche Klartext-Box zwischen Header und Tabelle bei `AREA_FALLBACK`
  und `MIXED` mit kurzer, neutraler Erklärung. Beträge und Saldi bleiben
  unverändert sichtbar.

### Print (`print/statement/page.tsx`)

Die `print.heatingNote` wird nur noch gerendert, wenn der Modus tatsächlich
`METER` ist. Für `AREA_FALLBACK` und `MIXED` gibt es neue, neutrale Locale-Texte
(`print.heatingNoteFallback`, `print.heatingNoteMixed`). Bei `NONE` erscheint
kein Heating-Hinweis.

### E-Mail-PDF (`statement-actions.ts`)

Der hartcodierte String

```
"Heiz-/Warmwasserkosten nach HeizkostenV (30% Flaeche / 70% Verbrauch)."
```

ist ersetzt durch eine mode-abhängige Entscheidungsmatrix, die exakt dieselbe
`HeatingAllocation` konsumiert, die auch Admin- und Print-Ansicht verwenden.
`NONE` → keine Heating-Zeile im PDF.

### AI-Kontext (`ai.ts`)

`explainStatement` reichert den Kontext-Block um `heizModus` (NONE|METER|
AREA_FALLBACK|MIXED) und `heizModusDetail` ({meter, flaeche}) an. Damit kann
der LLM-Fallback (ohne ANTHROPIC_API_KEY) und der LLM-Pfad selbst nicht mehr
pauschal einen HeizkostenV-Split behaupten, wenn die Berechnung tatsächlich
nur Fläche verwendet hat. Sehr kleiner, review-konformer Eingriff (LOW).

## 6. Locale-Texte

Neue Schlüssel in `de.json`, `en.json`, `pt-BR.json`:

- `print.heatingNoteFallback`
- `print.heatingNoteMixed`
- `statements.heatingBadgeMeter` / `Fallback` / `Mixed`
- `statements.heatingHintFallback` / `Mixed`

Die bisherigen `print.heatingNote` und `statements.hint` bleiben erhalten und
werden weiterhin bei METER verwendet. Formulierungen sind neutral und sachlich
gehalten — keine Rechtsberatung.

## 7. Geänderte Dateien

**Produktiv:**
- `src/lib/allocation/statement.ts` — neue Exports `HeatingAllocation`,
  `HeatingCostMode`, `deriveHeatingAllocation`; `buildStatement` liefert
  `heatingAllocation` zusätzlich zurück (Berechnungslogik unverändert).
- `src/server/statements.ts` — `StatementResult` erweitert um
  `heatingAllocation`; an UI/Print/Actions weitergereicht.
- `src/app/[locale]/(admin)/statements/page.tsx` — Badge + Hinweistext je
  nach Modus.
- `src/app/[locale]/print/statement/page.tsx` — heatingNote nur bei METER,
  Fallback/Mixed mit eigenem Text, NONE ohne Hinweis.
- `src/server/actions/statement-actions.ts` — Heating-PDF-Text aus
  `heatingAllocation` abgeleitet, kein hartcodierter 30/70-String mehr.
- `src/server/actions/ai.ts` — Kontext-Block um `heizModus` ergänzt.
- `messages/de.json`, `messages/en.json`, `messages/pt-BR.json` — neue
  Schlüssel.

**Tests (neu):**
- `src/lib/allocation/statement.heating.test.ts` (21 Tests: Heizmodus-Matrix +
  Regressionsschutz Beträge/Rounding inkl. L-1- und
  `selectAdminHeatingHint`-Selektor-Cases).
- `src/server/actions/statement.heating-pdf.test.ts` (4 Tests: E-Mail-PDF
  Entscheidungsmatrix inkl. „kein 30/70 bei AREA_FALLBACK/MIXED").

**Zielgerichtete Tests gesamt: 25/25 PASS** (21 Heating + 4 Heating-PDF).

**Dokumentation:**
- `docs/havewa-05a-report.md` (dieser Bericht).

## 8. Tests & Qualität

| Gate | Ergebnis |
|------|----------|
| Targeted Tests (Heating, `statement.heating.test.ts`) | 21/21 PASS (neue Datei) |
| Targeted Tests (Heating-PDF, `statement.heating-pdf.test.ts`) | 4/4 PASS (neue Datei) |
| Targeted Tests gesamt | **25/25 PASS** |
| Targeted Tests (statement bestehend) | 21/21 PASS (unverändert) |
| Full Unit-Suite | **272/272 Assertions PASS** (40 Dateien; vorher 247 + 25 neu in 2 Dateien = 272: `statement.heating.test.ts` +21, `statement.heating-pdf.test.ts` +4) |
| TypeScript `tsc --noEmit` | PASS (Exit 0) |
| Lint in 05A-Dateien | 0 neue Findings (Baseline 89 Errors / 16 Warnings bleibt exakt) |
| Build `next build` | ✓ Compiled successfully (5.7s) · TypeScript OK (7.7s) · 134/134 static pages · Route-Gen OK · **Exit 0**. Nicht-fatale Prisma-Logs beim Page-Data-Sammeln (ARM64-Windows, nicht x64-kompatible Engine) — identisch zur Baseline, dokumentiert in `docs/havewa-04-report.md`. |
| **Integration** | **NOT_VERIFIED** — Umgebungslimitation (siehe unten) |
| **Full Regression** | **NOT_VERIFIED** — wegen Integration = NOT_VERIFIED |
| Playwright E2E | Nicht ausgeführt (Umgebungslimitation aus 04; kein neuer E2E-Test in 05A vorgesehen). |

**Umgebungslimitation (ARM64-Windows, Prisma Query Engine):**
Die Prisma-**Query-Engine** (`node_modules/.prisma/client/query_engine-windows.dll.node`)
kann auf ARM64-Windows nicht geladen werden (`… is not a valid Win32 application`).
Konsequenz:
- `prepare-test-db.ts` wendet die Migrationen **erfolgreich** gegen die
  Docker-Postgres-Test-DB an (Docker/WSL sind vorhanden, Container
  `havewa-test-db` / `havewa-db` laufen).
- 8 Integration-Suiten scheitern in `resetDatabase`/`beforeAll` mit
  `PrismaClientInitializationError`; 65 Integration-Tests werden
  übersprungen, 0 Assertions ausgeführt.
- Die Unit-Suite meldet 3 unhandled Prisma-Errors in nicht-05A-Testdateien
  (`api-list/sso/bank-scheduler.test.ts`) — gleiche Ursache, keine 05A-Regression.
- Build erzeugt beim Page-Data-Sammeln nicht-fatale `PrismaClientInitializationError`-
  Logs, wird aber sauber mit Exit 0 abgeschlossen.
Diese Limitation ist **nicht** 05A-spezifisch (identisch zur Baseline aus 04)
und wird hier nur dokumentiert, nicht behoben. Integration und Full Regression
bleiben deshalb explizit **NOT_VERIFIED** — es handelt sich nicht um ein PASS.

## 9. Scope-Grenzen eingehalten

Keine DB-Migration, keine neue Dependency, kein API-/MCP-Vertrag geändert,
keine PropertyAI-Datei verändert, keine theme-provider.tsx / migration_lock.toml
angefasst, keine Konsumtion-bei-Leerstand-Korrektur (eigener DEFERRED-Finding,
separat), kein Vermieteranteil-/Person-Month, kein Full GL, kein Scheduler,
kein Backup/Restore, keine README-Großbereinigung.

## 10. DEFERRED findings (für 05B+)

1. **Consumption bei Leerstand:** Wie im Review bestätigt, kann der Verbrauch
   einer Einheit ohne Lease im Nenner enthalten sein, ohne dass eine
   StatementLine ausgegeben wird. Beträge sind dadurch konsistent korrekt,
   aber die ausgewiesene Verbrauchssumme ist buchhalterisch zu prüfen.
2. **i18n der E-Mail-PDF-Texte:** Die PDF-Heating-Texte in
   `statement-actions.ts` sind aktuell nur deutsch; UI nutzt bereits die
   Locale-Strings. Konsolidierung in 05B+, falls mehrsprachige PDFs gefordert.
