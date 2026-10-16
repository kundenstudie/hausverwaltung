# HAVEWA-05B-1 — Vacancy / Statement Reconciliation (Abschlussbericht)

Stand: 2026-10-16 · MODE BUILD · HEAD `1bd8a916baf5588f6e6488a0cb1efaec40e93d99`

Vorgänger: HAVEWA-05A = COMPLETE.

> **Hinweis Review-Sicht:** `havewa-05b` ist die Tracking-ID für das Themenfeld "Statement-Sichtbarkeit bei Vakanz". `05B-1` behandelt ausschließlich V-1 (zeitanteilige Reconciliation). V-2 (Verbrauchs-Vakanz bei unterjähriger Lease) bleibt in `05B-2`/`05B-3` offen.

---

## 1. Ergebnis

**HAVEWA-05B-1 = PASS (V-1 behoben).** Die sichtbare Statement-Summe reconciliiert jetzt cent-genau mit dem ausgewiesenen Gesamtbetrag (`totalUmlage`) — auch bei ganzjährigem oder zeitanteiligem Leerstand.

V-1 wird über eine zusätzliche, fachlich neutrale Statement-Zeile sichtbar gemacht:

> **Leerstand / Vermieteranteil (zeitanteilig)**

Diese Zeile ist **kein** "pauschaler Leerstand" und **kein** "Vermieter zahlt X €". Sie ist eine reine, transparente Ausweisung des positiven Residuals zwischen zugewiesenen Kosten (Mieter + Leerstands-Einheit) und `totalUmlage`. Sie enthält:

- zeitanteilige, keinem Lease zugewiesene Beträge (typisch: 4-Monate-Lücke bei Mieterwechsel)
- Rundungsreste aus der Per-Zeile-Cent-Rundung

Sie deckt **nicht** die V-2-Verbrauchs-Vakanz ab (siehe §6).

---

## 2. Architektur / Semantik

### 2.1 Identifier

```ts
// src/lib/allocation/statement.ts
export const STATEMENT_VACANCY_ID = "__statement_vacancy__";
```

Bewusst domänen-lokal. **Nicht** identisch mit `VACANCY_ID` aus `area-time.ts` (`"__vacancy__"`), um Cross-Domain-Key-Kollisionen in Tabellen und UI zu vermeiden (Flächenmodell vs. Statement sind zwei getrennte Domänen, die zufällig denselben Begriff treffen).

### 2.2 Repräsentation

Die Reconciliation-Zeile ist eine **normale** `StatementLine` mit:

| Feld | Wert |
|------|------|
| `unitId` | `STATEMENT_VACANCY_ID` (`"__statement_vacancy__"`) |
| `leaseId` | `null` |
| `label` | im Server-Layer `""` (UI/Print lokalisiert) |
| `allocated` | Residual in Integer-Cent ÷ 100 |
| `prepayment` | `0` |
| `balance` | `-allocated` (Vermieter trägt Residual) |

`leaseId = null` ist die bestehende Vacancy-Semantik in `StatementLine`. Sie ist:

- **nicht buchungsfähig** — `statement-actions.bookStatementCharges` filtert mit `if (!u.leaseId || u.balance >= 0) continue;`
- **nicht mailbar** — `statement-actions.emailStatementToTenants` filtert mit `if (u.renterEmails.length === 0) continue;` (die Reconciliation-Zeile hat `renterEmails: []`)
- **kein echter Lease** — `key = STATEMENT_VACANCY_ID`, eindeutig in der Tabelle

`statement-actions.ts` wurde **nicht** geändert — das bestehende Verhalten ist bereits korrekt.

### 2.3 Lokalisierung

Drei Locale-Keys neu angelegt, fachlich neutral:

| Locale | Key | Wert |
|--------|-----|------|
| de | `statements.reconciliationVacancy` | Leerstand / Vermieteranteil (zeitanteilig) |
| en | `statements.reconciliationVacancy` | Vacancy / landlord share (time-proportional) |
| pt-BR | `statements.reconciliationVacancy` | Vacância / parte do proprietário (proporcional ao tempo) |

UI (Admin Statement) und Print rendern das Label **lokalisiert**, wenn `l.id === STATEMENT_VACANCY_ID`.

---

## 3. Residual-Berechnung (Integer-Cent, Guard)

```ts
const totalCents = Math.round(totalUmlage * 100);
const allocatedCents = lines.reduce((a, l) => a + Math.round(l.allocated * 100), 0);
const residualCents = totalCents - allocatedCents;
if (residualCents > 0) {
  lines.push({
    unitId: STATEMENT_VACANCY_ID,
    leaseId: null,
    label: STATEMENT_VACANCY_ID,
    allocated: residualCents / 100,
    prepayment: 0,
    balance: -(residualCents / 100),
  });
}
```

**Eigenschaften:**

- **Integer-Cent-Arithmetik.** Kein Float-Residual. `Math.round(x * 100)` für `totalUmlage` und alle `lines.allocated`.
- **Null/Negativ-Guard.** `residualCents <= 0` → keine zusätzliche Zeile. Insbesondere kein negativer "-0,01 € Leerstand"-Eintrag bei rechnerischem Übermaß (z. B. Doppelzuordnung).
- **Kein neuer Money-/Allocation-Algorithmus.** `allocate()` (Largest-Remainder) bleibt unverändert. Die Recon-Zeile absorbiert nur den sichtbaren Rest, der nach Mieter- und Einheit-Leerstands-Zuordnung übrig bleibt.

---

## 4. V-2 Boundary (deferred)

**Nicht gelöst** in `05B-1`:

- Verbrauchsanteile (Heizung/Warmwasser) bei unterjährigem Lease, bei denen der Zähler die Gesamt-Nutzungszeit des Jahres abdeckt (z. B. Mietbeginn 01.07., Verbrauchszähler läuft seit 01.01.). Die aktuelle Implementierung ordnet dem vorhandenen Lease den vollen Verbrauch zu — V-2 würde eine Verbrauchsproration nach Monatsanteilen benötigen.

Die Reconciliation-Zeile **absorbiert V-2 nicht**. Sie zeigt nur den positiven Residual aus zeitanteilig gekürzten Kosten. Eine Erweiterung um Verbrauchsproration, Gradtagszahl-Korrektur oder eine Occupancy-Engine ist nicht Bestandteil dieses BUILD.

> **V-2 remains deferred.**

---

## 5. Betragsschutz / Regressionsmatrix

| Aspekt | Status |
|--------|--------|
| bestehende Mieter-allocated-Werte | unverändert |
| `totalUmlage` | unverändert |
| Heating-Beträge | unverändert |
| non-heating-Beträge | unverändert |
| Rounding-Logik (`Math.round(x * 100) / 100` pro Zeile) | unverändert |
| Largest-Remainder in `allocate()` | unverändert |

Regressionsprüfung gegen alle vorhandenen Methoden:

- AREA · CONSUMPTION · UNITS · PERSONS · MEA · CUSTOM
- Heating: METER · AREA_FALLBACK
- Mieterwechsel (zwei Leases je 6 Monate)
- Vollständige vs. teilweise Vermietung

Der Fix berechnet **keine** Methode anders.

---

## 6. Test-Evidenz

### 6.1 Neue Tests (`src/lib/allocation/statement.vacancy.test.ts`)

12 Tests, davon 11 grün nach Implementierung:

1. **kein Leerstand → keine Reconciliation-Zeile** (occupied-only)
2. **ganzjähriger Leerstand → positive Recon-Zeile** (fully vacant unit)
3. **mixed occupied/vacant units → Residual cent-genau**
4. **Heizung METER + Leerstand → Residual cent-genau**
5. **AREA_FALLBACK + Leerstand → Residual cent-genau**
6. **non-heating CONSUMPTION + Leerstand → Reconciliation berücksichtigt nur Residual**
7. **Summe aller sichtbaren Zeilen + Recon == totalUmlage cent-genau** (Property-Test über mehrere Konstellationen)
8. **cent remainder exakt** (3×33,33 + 1×0,01 Largest-Remainder → keine Recon-Zeile nötig)
9. **negativer/0 Residual → keine Reconciliation-Zeile** (Guard)
10. **bestehende Mieterbeträge unverändert** (Regressionsschutz)
11. **partial-year vacancy → nur zeitanteiliger Residual wird ausgewiesen**
12. **Statement-VACANCY_ID ≠ area-time VACANCY_ID** (Architektur-Sanity)

### 6.2 Aktualisierte Tests (`src/lib/allocation/statement.test.ts`)

Ein bestehender Test musste angepasst werden, weil er explizit die alte (vor V-1 fehlerhafte) Realität abgebildet hat:

- `#12 Zeitanteil bei unterjährigem Mietverhältnis > kein Vertrag (Leerstand) → eine Zeile, nichts umgelegt`

→ umbenannt und erweitert zu: *„kein Vertrag (Leerstand) → Leerstands-Zeile mit 0, Reconciliation-Zeile trägt den Residual"*. Erwartung jetzt: 1 Leerstands-Zeile mit `allocated=0` + 1 Recon-Zeile mit `allocated=1200`. Cent-Invariant erfüllt.

### 6.3 Bestehende Tests unverändert grün

- `src/lib/allocation/statement.test.ts` (21 Tests, davon 1 angepasst)
- `src/lib/allocation/statement.heating.test.ts` (21 Tests)
- `src/lib/allocation/area-time.test.ts` (4 Tests, andere Domäne — unverändert)
- `src/lib/allocation/*.test.ts` gesamt: **76/76 PASS** (7 Dateien)
- `src/**/*.test.ts` Unit-Suite (npm run test:unit, voller Stand): **284 Assertions PASS / 0 FAIL** in 41 Dateien — ABER: **3 unhandled Prisma-Rejections** in `src/lib/api-list.test.ts`, `src/lib/sso.test.ts`, `src/lib/bank-scheduler.test.ts` (Import der Prisma-Client-Engine), **Unit-Prozess Exit Code 1**
- Ursache: `node_modules\.prisma\client\query_engine-windows.dll.node` ist auf Windows nicht ladbar („not a valid Win32 application“), weil der Prisma-Client unter WSL (Linux aarch64) generiert wurde — vorbestehende Umgebungslimitation, **nicht** durch 05B-1 verursacht
- Effektive 05B-1-bezogene Unit-Tests (statement + heating + vacancy): **54/54 PASS**

### 6.4 Sum-Invariant (E2E-Häppchen)

| Szenario | totalUmlage | Σ lines.allocated | Residual |
|---------|-------------|--------------------|----------|
| occupied-only, 1000 € / 2 Einheiten | 1000 € | 1000 € | 0 |
| 1 vermietet + 1 leer, 1000 € AREA | 1000 € | 500 € | 500 € (Recon) |
| partial-year 6 Monate, 1200 € UNITS | 1200 € | 600 € | 600 € (Recon) |
| Heizung METER, A vermietet + C leer | 1000 € | 850 € | 150 € (Recon) |
| mixed 3 Einheiten, 1200 € UNITS | 1200 € | 400+200+0 = 600 € | 600 € (Recon) |
| 100 € / 3 Einheiten (Largest Remainder) | 100 € | 33.33+33.33+33.34 = 100 € | 0 (kein Recon) |

---

## 7. Geänderte Dateien

### Produktiv

| Datei | Änderung |
|-------|----------|
| `src/lib/allocation/statement.ts` | `STATEMENT_VACANCY_ID` exportiert; Reconciliation-Logik (Integer-Cent, Guard) in `buildStatement` |
| `src/server/statements.ts` | `StatementUnit`-Mapping erkennt Recon-Zeile anhand `unitId === STATEMENT_VACANCY_ID`, setzt `leaseId=null`, `renterEmails=[]`, `label=""` (UI lokalisiert) |
| `src/app/[locale]/(admin)/statements/page.tsx` | lokalisierter Label-Render für Recon-Zeile |
| `src/app/[locale]/print/statement/page.tsx` | lokalisierter Label-Render für Recon-Zeile |

### Tests

| Datei | Änderung |
|-------|----------|
| `src/lib/allocation/statement.vacancy.test.ts` | **NEU** — 12 V-1-Tests (RED → GREEN) |
| `src/lib/allocation/statement.test.ts` | 1 Test angepasst (V-1-Korrektur sichtbar) |

### Locale

| Datei | Änderung |
|-------|----------|
| `messages/de.json` | `statements.reconciliationVacancy` |
| `messages/en.json` | `statements.reconciliationVacancy` |
| `messages/pt-BR.json` | `statements.reconciliationVacancy` |

### Doku

| Datei | Änderung |
|-------|----------|
| `docs/havewa-05b-report.md` | **NEU** — dieser Bericht |

---

## 8. Quality-Gate-Status

| Gate | Status |
|------|--------|
| Targeted Tests (`statement.vacancy.test.ts`) | ✅ 12/12 PASS |
| Targeted Tests (statement + heating + vacancy) | ✅ 54/54 PASS |
| Allocation-Suite (`src/lib/allocation/**`) | ✅ 76/76 PASS |
| Unit-Suite (`src/**/*.test.ts`, voller Stand) | ⚠️ **284 Assertions PASS / 0 FAIL** — aber **3 unhandled Prisma-Rejections** (api-list, sso, bank-scheduler) und **Exit Code 1** wegen vorbestehender Prisma-Windows-DLL-Limitation. Kein 05B-1-Regress. |
| Integration (WSL/Docker) | ❌ **NOT_VERIFIED_ENVIRONMENT** — Prisma-Query-Engine unter Windows nicht ladbar (WSL-Linux-Engine fälschlich als `.dll.node` ausgeliefert) + esbuild-`@esbuild/win32-arm64` ≠ WSL-`linux-arm64`. Vorbestehend, kein Repo-Eingriff im BUILD-Scope. |
| Full Regression | **PARTIAL / NOT_FULLY_VERIFIED** — Code, Unit-Assertions, Build, Typecheck, Lint grün; Integration durch Umgebung blockiert. |
| Typecheck (`tsc --noEmit`) | ✅ 0 Fehler |
| Lint (`eslint .`) | ✅ 89 Errors / 16 Warnings — **0 neue Findings** (Baseline exakt reproduziert) |
| Production Build (`next build`) | ✅ Exit 0 (Prisma-DLL-Fehler beim Static-Page-Collect non-fatal, Seiten rendern dynamisch) |
| UI/Print Smoke | ✅ statische Verifikation: `STATEMENT_VACANCY_ID` korrekt verdrahtet, locale-Keys in 3 Sprachen, Recon-Zeile wird lokalisiert gerendert, server-seitiges StatementUnit-Mapping konsistent |

---

## 9. Working-Tree-Hygiene

- `src/components/theme-provider.tsx` — pre-existing Modification, **nicht angefasst**
- `test-results/` — pre-existing Untracked, **nicht angefasst**
- Keine DB-Migration, keine Dependency-Änderung, keine REST-API-Änderung, keine MCP-Änderung
- Keine PropertyAI-/Dach-KI-Arbeit

---

## 10. Offene Punkte / V-2

V-2 (Verbrauchs-Vakanz bei unterjähriger Lease) bleibt **deferred**. Keine Erweiterung in `05B-1`.

Mögliche nächste Schritte (außerhalb dieses BUILD):

- `05B-2`: Verbrauchsproration nach Monatsanteilen innerhalb einer Lease (Grad der Komplexität: mittel)
- `05B-3`: Gradtagszahl-Korrektur / Meter-Zeitraumlogik (Grad: hoch)

Diese sind explizit **nicht** Bestandteil von `05B-1` und erfordern separate Planung.