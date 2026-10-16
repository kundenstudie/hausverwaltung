# HAVEWA-05B-2 — Statement PDF / E-Mail i18n (Abschlussbericht)

Stand: 2026-10-16 · MODE BUILD · HEAD `4ad7679fe17befe0c11b52e5f3d8bf4c6cb05254`

Vorgänger: HAVEWA-05A = COMPLETE, HAVEWA-05B-1 = COMPLETE.

> **Tracking-Klarstellung:** `havewa-05b` ist die Tracking-ID für das
> Themenfeld "Statement-Sichtbarkeit". Die IDs innerhalb unterscheiden sich:
>
> - **HAVEWA-05B-1** = V-1 (zeitanteilige Reconciliation). **COMPLETE.** Bericht: `docs/havewa-05b-1-report.md`.
> - **HAVEWA-05B-2** = **Statement PDF / E-Mail i18n (de / en / pt-BR).** ← dieser Bericht.
> - **V-2** = Verbrauchs-Vakanz bei unterjähriger Lease (Gradtagszahl, Meter-Periode). **DEFERRED**, separat.
>
> Es darf keine Vermischung mit V-2 geben. Tracking-Konflikt aus älterer
> Doku (in der "05B-2" zwischenzeitlich auch für V-2 verwendet wurde) ist
> hiermit aufgelöst.

---

## 1. Ergebnis

**HAVEWA-05B-2 = PASS.** Die serverseitigen Statement-Mail- und PDF-Pfade sind
vollständig internationalisiert (de / en / pt-BR). Die Sprache folgt dem
auslösenden UI-/Request-Kontext des HaVeWa-Benutzers — **nicht** der
Empfänger-Sprache. Empfänger-Locale (Person/tenant) bleibt **DEFERRED**.

Sechs Review-Korrekturen geschlossen:

| Kürzel | Inhalt | Status |
|--------|--------|--------|
| **C1** | Locale-Quelle = expliziter Caller-Parameter + `getLocale()`-Fallback (NICHT `session.user.locale`) | ✅ |
| **C2** | Heating-Texte auf bestehende `print.heatingNote*`-Semantik konsolidiert | ✅ |
| **C3** | `NK-Nachzahlung {year}` (charge.description + Dedup-Key) bleibt unverändert deutsch | ✅ |
| **C4** | 3 sichtbare Action-Fehlertexte lokalisiert (über Message-Kataloge) | ✅ |
| **C5** | Bestehender `money(value, locale)` verwendet, kein neuer Formatter | ✅ |
| **C6** | Locale-Validierung gegen `routing.locales`, Fallback `de` | ✅ |

Zusätzlich:

- **T-1 geschlossen** — die duplizierte `heatingLineFor`-Test-Funktion in
  `statement.heating-pdf.test.ts` wurde durch den **Production-Selektor**
  `selectStatementHeatingLineKey` ersetzt; Tests prüfen jetzt die echte
  Produktionslogik.
- **Reiner Text-Helper** `buildStatementMailTexts(...)` ist deterministisch
  aus `locale` + `propName` + `unitLabel` + `year` + `heatingMode` und führt
  **keine** DB/Session/Request-Lookups durch.
- **Eine Wahrheitsquelle pro sichtbarem Text:** Sichtbare Fehlertexte
  (`statements.errors.*`) und Guthaben/Nachzahlung-Wörter
  (`statements.credit`/`statements.arrears`) liegen ausschließlich in den
  `messages/*.json`-Katalogen. Der Helper hält für sie keine Duplikate mehr.

---

## 2. Architektur / Semantik

### 2.1 Lokalisierte Statement-Texte (Helper)

```ts
// src/server/actions/statement-mail-texts.ts
buildStatementMailTexts(
  locale: string,
  propName: string,
  unitLabel: string,
  year: number,
  heatingMode: HeatingMode,
): StatementMailTexts
```

Der Helper liefert ein typisiertes Textobjekt **nur** für die Felder, die im
Statement-Mail/PDF-Action-Pfad tatsächlich aus ihm gelesen werden:

| Feld | Quelle | Locale-spezifisch? |
|------|--------|---------------------|
| `locale` | aus Caller, validiert gegen `routing.locales` | ja |
| `subject` | `Betriebskostenabrechnung {y} · {label}` / `Service charge statement …` / `Demonstrativo de encargos …` | ja |
| `pdfTitle` | `Betriebskostenabrechnung {y}` / `Service charge statement {y}` / `Demonstrativo de encargos {y}` | ja |
| `filename` | `Abrechnung {y} - {label}.pdf` / `Statement {y} - {label}.pdf` / `Demonstrativo {y} - {label}.pdf` | ja |
| `greeting` | `Sehr geehrte Mieterin, …` / `Dear Tenant,` / `Prezado(a) inquilino(a),` | ja |
| `bodyIntro` | lokalisierter Begleittext inkl. Year + Property + Unit | ja |
| `bodyLabels.{allocated,prepayment}` | lokalisierte Labels | ja |
| `resultLabel` | `Ergebnis` / `Result` / `Resultado` | ja |
| `closing` | `Mit freundlichen Grüßen` / `Kind regards` / `Atenciosamente` | ja |
| `heatingLineKey` | `print.heatingNote` / `print.heatingNoteFallback` / `print.heatingNoteMixed` / `null` (NONE) | ja (i18n-Key) |

**Eigenschaften (C7):**

- KEINE DB / Prisma / Fetch
- KEIN `session.user.locale`
- KEIN `getLocale()` (Caller-Parameter, NICHT Request-Kontext)
- KEIN erfundener Heating-Modus
- KEIN neuer Money-Formatter (`money(value, locale)` aus `@/lib/format`)
- KEINE Audit-Text-Übersetzung
- KEINE `charge.description`-Übersetzung (`NK-Nachzahlung {year}` bleibt, C3)
- KEINE sichtbaren Action-Fehlertexte (liegen in `messages/*.json`,
  `statements.errors.*`; eine Quelle pro Text)
- KEINE Guthaben/Nachzahlung-Wörter (liegen in `messages/*.json`,
  `statements.credit`/`statements.arrears`; eine Quelle pro Text)
- KEINE `bodyResult`-Zeile im Helper — die Ergebnis-Zeile
  (`<resultLabel>: <Betrag> <Art>`) wird im Action-Pfad aus
  `t("statements.credit"|"statements.arrears")` und `money(value, locale)`
  zusammengesetzt.

### 2.2 Locale-Quelle (C1) + Validierung (C6)

**Caller-Parameter-Pfad (bevorzugt):** Die Client-Component
`src/components/statement-actions.tsx` liest `useLocale()` aus
`next-intl` und reicht die Locale als zusätzliches Hidden-Field
(`<input type="hidden" name="locale" value={locale} />`) in den
beiden Forms durch. Die Server-Action `emailStatementToTenants` (und
`bookStatementCharges`) lesen `fd.get("locale")` aus und validieren
über `resolveStatementLocale` gegen `routing.locales`.

**getLocale()-Fallback:** Nur wenn der Caller **kein** `locale`-Feld
mitgibt (z. B. externe Tests, Legacy-Aufrufer) fällt die Action auf
`await getLocale()` zurück. In der Praxis ist dies nie der Fall.

**Validierung:** Unbekannte, leere oder Whitespace-Werte ⇒ Fallback
`routing.defaultLocale` (= `de`). Permissive Variante: `"DE"` und
`"de"` werden beide akzeptiert, damit UI-Werte, die nicht streng
lowercase normalisiert sind, nicht fälschlich auf `de` zurückfallen.

### 2.3 Heating-Selektor (C2)

```ts
// src/server/actions/statement-mail-texts.ts
export function selectStatementHeatingLineKey(mode: HeatingMode): HeatingLineKey {
  switch (mode) {
    case "METER":         return "print.heatingNote";
    case "AREA_FALLBACK": return "print.heatingNoteFallback";
    case "MIXED":         return "print.heatingNoteMixed";
    case "NONE":
    default:              return null;
  }
}
```

- **Eine** Quelle der Wahrheit — die Decision-Matrix steht nur hier.
- **Kein** paralleler `statementMail.heating*`-Namespace, **keine**
  dritte Heating-Matrix. Bestehende `print.heatingNote*`-Keys werden
  wiederverwendet (C2); sie sind in `de.json`/`en.json`/`pt-BR.json`
  bereits vorhanden.
- NONE ⇒ `null` ⇒ keine Heating-Zeile in PDF/Mail.

### 2.4 Money / Currency / Date (C5 + Date-Review)

- **Money:** bestehender `money(value, locale)` aus `@/lib/format`.
  Locale-aware, Currency bleibt **EUR**, kein neuer Formatter.
- **Date:** keine echte i18n-Lücke im Statement-Mail/PDF-Pfad (nur
  Year wird verwendet). Kein neuer Date-Formatter gebaut.
- **Filename:** lokalisiert, aber **stabil** — kein Hash, kein
  Timestamp. UI hat `label` bereits sanitiert.

### 2.5 Action-Pfad (C4)

Drei sichtbare ActionState-Fehlertexte sind nun lokalisiert. Quelle ist
ausschließlich `messages/*.json` (`statements.errors.*`); der Helper
hält keine Duplikate:

| DE | EN | pt-BR |
|----|----|-------|
| `Kein Objekt` | `No property selected.` | `Nenhum imóvel selecionado.` |
| `Keine offenen Nachzahlungen zu buchen.` | `No open arrears to book.` | `Nenhum débito em aberto para lançar.`
| `Keine Mieter mit E-Mail-Adresse gefunden.` | `No tenants with an email address found.` | `Nenhum inquilino com endereço de e-mail encontrado.` |

Andere Texte (Audit-Summary, charge.description, log-Texte) sind
**nicht** übersetzt.

### 2.6 NK-Nachzahlung (C3)

```ts
const desc = `NK-Nachzahlung ${year}`;
```

bleibt **unverändert deutsch**. Begründung: Wird sowohl als
`charge.description` (Anzeige im Finance-Bereich) als auch als
**Dedup-Schlüssel** verwendet (`prisma.charge.findFirst({ where: {
description: desc }})`). Ein Locale-Wechsel darf keine Dubletten
erzeugen. Audit-Summary (`${created}× ${desc}`) bleibt ebenfalls
unverändert.

### 2.7 Empfänger-Locale (DEFERRED)

- **Nicht implementiert:** `Person.locale` / `Renter.locale` / `Lease.locale`
- **Keine DB-Migration**
- **Keine automatische Mietersprache**
- 05B-2 verwendet **Sprache des auslösenden HaVeWa-Benutzers / aktiven
  Requests** (C1: expliziter Caller-Parameter + `getLocale()`-Fallback).
- Empfänger-spezifische Locale bleibt **DEFERRED**.

---

## 3. Geänderte Dateien

### Produktiv

| Datei | Änderung |
|-------|----------|
| `src/server/actions/statement-mail-texts.ts` | **NEU** — reiner Text-Helper (`buildStatementMailTexts`, `selectStatementHeatingLineKey`, `resolveStatementLocale`, `selectStatementFilename`); keine Duplikate von `messages/*.json`-Inhalten |
| `src/server/actions/statement-actions.ts` | Server-Action-Signatur erweitert um `locale`-Feld; `getLocale()` als Fallback; Heating-Matrix durch Helper ersetzt; sichtbare Fehlertexte aus Message-Katalog; Subject/PDF-Titel/Filename/Begleittext lokalisiert |
| `src/components/statement-actions.tsx` | Reicht `useLocale()` als Hidden-Field an beide Forms durch |
| `messages/de.json` | `statements.errors.*` (3 Keys) |
| `messages/en.json` | `statements.errors.*` (3 Keys) |
| `messages/pt-BR.json` | `statements.errors.*` (3 Keys) |

### Tests

| Datei | Änderung |
|-------|----------|
| `src/server/actions/statement-mail-texts.test.ts` | **NEU** — Helper-Tests (DE/EN/pt-BR × Heating-Modi × Locale-Validation) |
| `src/server/actions/statement-mail-texts.locale.test.ts` | **NEU** — 10 Tests (`resolveStatementLocale` × Edge-Cases) |
| `src/server/actions/statement.heating-pdf.test.ts` | **Refactor (T-1)** — duplizierte `heatingLineFor` entfernt; nutzt `selectStatementHeatingLineKey` (Production-Selektor); +3 Catalog-Sync-Tests (5+3 = 8) |

### Dokumentation

| Datei | Änderung |
|-------|----------|
| `docs/havewa-05b-report.md` | **ERSETZT** — dieser Bericht (HAVEWA-05B-2); Tracking-Klarstellung V-2 vs 05B-2 |
| `docs/havewa-05b-1-report.md` | **NEU** — historischer 05B-1-Bericht (vorherige Version dieses Files) + Nachtrag zur Tracking-Klärung |

---

## 4. Test-Evidenz

### 4.1 Targeted Tests (neu)

- `src/server/actions/statement-mail-texts.test.ts` — **46/46 PASS**
  - DE/EN/pt-BR: subject / pdfTitle / filename / greeting / bodyIntro / bodyLabels / resultLabel / closing / heatingLineKey (METER)
  - DE Heating: NONE / AREA_FALLBACK / MIXED
  - Locale-Validierung: ungültig/leer/`"DE"` (Großschreibung) → `"de"`
  - Kein ungewollter deutscher Text in EN/pt-BR
  - Hinweis: `bodyResult`/`errors`-Tests wurden im Zuge der
    Dead-Code-Bereinigung entfernt (siehe §1: eine Wahrheitsquelle
    pro sichtbarem Text → diese Felder sind nicht mehr im Helper).
- `src/server/actions/statement-mail-texts.locale.test.ts` — **10/10 PASS**
- `src/server/actions/statement.heating-pdf.test.ts` (T-1 geschlossen) — **8/8 PASS**

### 4.2 Targeted Tests gesamt: 64/64 PASS

### 4.3 Bestehende Tests unverändert grün

- `src/lib/allocation/**` (76/76) — Heating / Statement / Vacancy unverändert
- `src/i18n/messages.test.ts` (2/2) — Catalog-Sync über alle drei Sprachen
- `src/lib/pdf.test.ts` (3/3) — simplePdf unverändert
- Full-Unit-Suite: **43 Testdateien / 344 Assertions PASS** (siehe §5)

---

## 5. Quality-Gate-Status

| Gate | Status |
|------|--------|
| Targeted Tests (mail-texts) | ✅ 46/46 PASS |
| Targeted Tests (locale) | ✅ 10/10 PASS |
| Targeted Tests (heating-pdf, T-1) | ✅ 8/8 PASS (vorher 4/4 mit Test-Duplikation) |
| Targeted Tests gesamt | ✅ **64/64 PASS** |
| Bestehende Tests unverändert | ✅ Allocation 76/76, i18n 2/2, pdf 3/3 |
| Full Unit-Assertions | ✅ 344/344 Assertions PASS (43 Testdateien) |
| Full Unit-Prozess | ⚠️ **Exit 1** — 3 unhandled Prisma-Rejections in `src/lib/api-list.test.ts`, `src/lib/sso.test.ts`, `src/lib/bank-scheduler.test.ts` (Import der Prisma-Client-Engine: `query_engine-windows.dll.node` „not a valid Win32 application", vorbestehende Windows-ARM64/WSL-Prisma-Umgebungslimitation) |
| TypeScript `tsc --noEmit` | ✅ Exit 0 |
| Lint (`eslint .`) | ✅ 89 Errors / 16 Warnings — **exakt Baseline, 0 neue Findings** |
| Production Build (`next build`) | ✅ Exit 0 (Nicht-fatale Prisma-Logs beim Page-Data-Sammeln sind identisch zur 05A-/05B-1-Baseline) |
| Integration | ❌ **NOT_VERIFIED_ENVIRONMENT** — dieselbe vorbestehende Prisma-Windows-DLL-Limitation; package.json, package-lock.json, prisma/schema.prisma, prisma/migrations/migration_lock.toml unverändert |
| Full Regression | **PARTIAL / NOT_FULLY_VERIFIED** — Code/Unit-Assertions/Build/Typecheck/Lint grün; Integration durch Umgebung blockiert |
| Locale/Server-Action-Smoke | ✅ `resolveStatementLocale` deckt alle dokumentierten Edge-Cases ab (gültig, ungültig, leer, Whitespace, Case-Insensitiv für `de`/`en`); `useLocale()`-Wert wird via Hidden-Field in die Action durchgereicht (Caller-Kontext). Echte Browser-/Action-Smoke mit DB nicht möglich. |

### 5.1 Testzuwachs gegenüber 05B-1

| | HAVEWA-05B-1 (vorher) | HAVEWA-05B-2 (jetzt) | Delta |
|---|---|---|---|
| Testdateien | 41 | 43 | **+2** |
| Assertions | 284 | 344 | **+60** |

**Zusammensetzung des Brutto-Zuwachses:**

- `statement-mail-texts.test.ts` (NEU): 46 Tests
- `statement-mail-texts.locale.test.ts` (NEU): 10 Tests
- `statement.heating-pdf.test.ts` (Refactor T-1): 4 → 8 = +4

Brutto: 46 + 10 + 4 = **+60** neue Test-Assertions, exakt passend zur
Differenz in der Tabelle. Keine Test-Lücken.

Hinweis: Der im BUILD-Zwischenbericht genannte Brutto-Wert „+68"
(54 mail-texts + 10 locale + 4 heating-pdf) wurde durch die
Helper-Dead-Code-Bereinigung (Entfernung von `bodyResult`/`errors`/
`money`-Helper-Tests) auf **+60 Netto** reduziert. Die
Bereinigungs-Logik selbst ist unter §1 dokumentiert.

---

## 6. Working-Tree-Hygiene

- `src/components/theme-provider.tsx` — **pre-existing** Modification, **NICHT angefasst**
- `test-results/` — **pre-existing** Untracked, **NICHT angefasst**
- Keine DB-Migration, keine Dependency-Änderung, keine REST-API-Änderung
- Keine PropertyAI-/Dach-KI-Arbeit, keine HaVeWa-Core-Änderung
- Keine Stage-/Commit-/Push-Aktionen

---

## 7. Verbleibende DEFERRED-Befunde (außerhalb dieses BUILD)

- **V-2 (Verbrauchs-Vakanz bei unterjähriger Lease):** Gradtagszahl-Korrektur /
  Meter-Periode-Logik. **Nicht Bestandteil von 05B-2.** Eigene, separate Planung
  erforderlich. Die Tracking-Klarstellung am Anfang dieses Berichts schließt
  eine Namensverwechslung explizit aus.
- **Empfänger-Locale (`Person.locale`/`Renter.locale`):** Separate Planung,
  DB-Migration erforderlich. Aktuell wird die Sprache des **auslösenden
  Nutzers** verwendet.
- **PDF-Encoding-Limitation:** `simplePdf` kodiert aktuell nur CP1252
  (latin1). Unicode-Zeichen (z. B. `ñ`, `ç`, `á` in pt-BR-Texten, die nicht
  in latin1 vorkommen) werden zu `?`. Aktuell sind die in 05B-2 eingeführten
  pt-BR-Texte bewusst latin1-kompatibel gehalten (kein Akzent). Eine
  UTF-8-PDF-Engine ist ein eigenes, späteres Vorhaben (echte PDF-Lib).
- **Case-Asymmetrie in `resolveStatementLocale`:** `"PT-BR"` und
  `"pt-br"` werden nicht zu `"pt-BR"` normalisiert (sondern fallen
  auf `"de"` zurück). `useLocale()` liefert kanonisch `"pt-BR"`, der
  Fallback ist sicher; keine 05B-2-Aktion notwendig.
