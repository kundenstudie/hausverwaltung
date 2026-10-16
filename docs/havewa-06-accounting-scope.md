# HAVEWA-06 — Accounting Scope Freeze

Stand: 2026-10-16 · MODE BUILD · HEAD `c0c78c6b5ce62c6e9807da40ec09fb0987d0cf8b`

Vorgänger: HAVEWA-05A / HAVEWA-05B-1 / HAVEWA-05B-2 / HAVEWA-05C = COMPLETE.

> **Review-Ergebnis (HAVEWA-06 REVIEW):** `APPROVE_WITH_CHANGES` — Frozen Direction
> (docs-only, `FULL_G_L_NOT_REQUIRED`) bestätigt; alle im Review benannten
> Statuspräzisierungen sind in dieses Dokument eingearbeitet.

---

## 1. Decision

HaVeWa liefert **operatives Hausverwaltungs-Accounting** für Miete, Nebenkosten,
Kaution, offene Posten, Mahnwesen, Bank-Imports, Eigentümer- und WEG-Abrechnung
sowie operative Exporte.

HaVeWa liefert **keine** vollständige steuerliche Finanzbuchhaltung (FiBu).

Für den HaVeWa-Core gilt:

**`FULL_G_L_NOT_REQUIRED`**

Damit ist verbindlich festgelegt: eine vollständige General-Ledger-Funktion ist
kein Bestandteil des HaVeWa-Core-Scopes und ist für den Freeze des Kerns nicht
erforderlich. Die steuerliche Buchführung wird über den vereinfachten
DATEV-Export (siehe §4, §5) an einen externen Steuerberater übergeben — das ist
das Standard-Muster für Hausverwaltungen in Deutschland und entspricht der
realen Verwendung des Kerns.

---

## 2. Product Accounting Boundary

**Vorhanden — operatives Hausverwaltungs-Accounting:**

- Sollstellungen (Charges) für Miete, Nebenkosten, Hausgeld, Kaution, Sonstiges
- Manuelle und camt.053-basierte Zahlungserfassung
- Bank-Sync (Open Banking) mit externer Transaktions-ID und Konto-Saldo
- Offene Posten je Sollstellung
- Mahnwesen (3 Stufen, mit Mindestabstand)
- Betriebskostenabrechnung (BetrKV + HeizkostenV, inkl. Verbrauchs-/Flächen-Split)
- WEG-Abrechnung (Hausgeld, Wirtschaftsplan, Rücklagen, Untergemeinschaften)
- Kaution mit Verzinsungsmodell
- Eigentümer-Konten (MEA, Hausgeld, Rücklagen, Vermögensbericht)
- Operatives Reporting (offene Posten, Portfolio, Vakanz, Zahlungen, KPIs)
- Exporte (CSV, SEPA, vereinfachter DATEV-Buchungsstapel)
- E-Rechnungs-Parser (XRechnung / ZUGFeRD / Factur-X; CII + UBL)

**Bewusst nicht vorhanden — keine FiBu, kein ERP, kein Payroll:**

- Kontenplan nach SKR03/SKR04
- Soll/Haben-Journal mit doppelter Buchführung
- Debitoren- und Kreditoren-Hauptbuch
- Umsatzsteuer-Engine (Vorsteuer, UStVA)
- Periodenabschluss
- Bilanz
- Gewinn- und Verlustrechnung (GuV)
- Anlagenbuchhaltung / AfA
- Vollständiges steuerliches Journal
- Vollständige DATEV-Konformität
- Payroll / Lohnbuchhaltung
- ERP-Funktionen

**Formulierung in einem Satz:** *HaVeWa ersetzt keine steuerliche FiBu.*

---

## 3. Supported Core Accounting

Die folgenden operativen Kernfunktionen sind im HaVeWa-Core vorhanden und sind
die Grundlage des Freeze-Satzes in §7.

- **Sollstellungslauf (manuell ausgelöst):** monatliche Erzeugung der
  Miet-Sollstellungen je aktivem Vertrag (Kaltmiete + Umlage-Komponenten) sowie
  für Flächenmodell-Teilflächen. Dedup gegen bereits vorhandene Sollstellungen.
- **Zahlungserfassung:** manuell (`createPayment`) sowie per
  camt.053-Datei-Import (`import_camt` / `importCamt`) und per
  Bank-Synchronisierung (Enable Banking) über `bank-sync`/`bank-scheduler`.
- **Import-Auto-Matching:** einfaches, betragsbasiertes First-Match
  (offene Sollstellung mit passendem Restbetrag). **Kein** referenz- oder
  personenbasiertes Matching. Siehe §6 (Deferred Nonblockers).
- **Offene Posten + Mahnwesen:** `open = amount − Σ payments`, automatischer
  Mahnlauf (`run_dunning`, `createDunning`) mit bis zu 3 Stufen und
  Mindestabstand.
- **Betriebskosten- und WEG-Abrechnung:** deterministische Verteilung nach
  Fläche, Einheit, Personen, MEA oder Verbrauch; Heiz-/Warmwassersplit nach
  HeizkostenV; optionale Untergemeinschaften. **Nachzahlungen** (Saldo < 0)
  werden als zusätzliche Sollstellung gebucht (`bookStatementCharges`).
  Guthaben (Saldo ≥ 0) werden **nicht** automatisch verbucht (siehe §6).
- **Kaution:** Modell mit Betrag, Typ, Konto, Zinssatz und Laufzeit; Zins wird
  taggenau **berechnet und angezeigt** (`depositInterest`). Zins wird **nicht**
  automatisch als Kontobewegung verbucht.
- **Operatives Reporting:** Dashboard-Kennzahlen, offene Posten, Portfolio-,
  Vakanz- und Zahlungsübersichten; Exporte als CSV, SEPA-XML und DATEV-EXTF
  (vereinfacht).

---

## 4. Status Matrix

Die folgenden Statusbegriffe sind die einzigen, die für den HaVeWa-Core
bezüglich Accounting verwendet werden. **Keine stärkeren Aussagen.**

| Bereich | Status | Bemerkung |
|---|---|---|
| Charges (Sollstellungen) | **COMPLETE** | manueller / ausgelöster Lauf, inkl. Dedup |
| Payments | **COMPLETE** | manuell, camt.053, Bank-Sync |
| Bank Transactions | **COMPLETE** | camt.053 + Enable Banking, mit `externalId`-Dedup (Bank-Sync) |
| Matching | **PARTIAL** | betragsbasiert, First-Match; kein Re-Match |
| Open Balances | **COMPLETE** | `amount − Σ payments` |
| Tenant Account | **COMPLETE_FOR_SCOPE** | offene Posten + Historie; kein klassisches Kontokorrent mit Anfangs-/Endsaldo |
| Operating Cost Posting | **COMPLETE_FOR_ARREARS** | Nachzahlung wird gebucht; Guthaben nicht |
| Deposits | **COMPLETE** | Modell + berechnete/angezeigte Verzinsung |
| Owner Accounting | **COMPLETE_FOR_SCOPE** | MEA, Hausgeld, Wirtschaftsplan, Jahresabrechnung, Rücklagen, Vermögensbericht — operativ, keine Eigentümer-FiBu |
| Income / Expense | **PARTIAL** | Transaktions-Summenübersicht; kein eigenständiger FiBu-Report |
| Invoice Handling | **PARTIAL** | E-Rechnung-Parse (CII/UBL); kein Kreditoren-Workflow, keine OCR |
| Reporting | **SUFFICIENT_FOR_SCOPE** | operativ; keine FiBu-Reports |
| DATEV | **SIMPLIFIED_DATEV_EXPORT** | EXTF-Buchungsstapel, nur Payments, Platzhalter-Konten, kein Mapping |
| G/L | **NOT_NEEDED** | nicht Bestandteil des Core |
| Double Entry | **NOT_NEEDED** | nicht Bestandteil des Core |
| VAT Engine | **NOT_NEEDED** | nicht Bestandteil des Core |
| Period Close | **NOT_NEEDED** | nicht Bestandteil des Core |

---

## 5. Explicit Non-Goals

Die folgenden Funktionen sind **kein** Bestandteil des HaVeWa-Core und werden
auch nicht für den Freeze nachgerüstet. Sie sind als bewusste Nicht-Ziele
geführt, nicht als Fehler oder Lücken:

- Vollständiger Kontenplan (SKR03/SKR04)
- Soll/Haben-Journal
- Doppelte Buchführung
- Debitoren- und Kreditoren-Hauptbuch
- Umsatzsteuer-Engine, Vorsteuerverrechnung, UStVA
- Periodenabschluss
- Bilanz
- Gewinn- und Verlustrechnung
- Anlagenbuchhaltung, AfA
- Vollständiges steuerliches Journal
- Vollständige DATEV-Konformität
- DATEV-Vollmapping (Kostenstellen, BU-Schlüssel, Skonto)
- Vollständiger Income-/Expense-FiBu-Report
- Payroll / Lohnbuchhaltung
- ERP-Funktionen

**Wichtiger Ausschluss:** *HaVeWa sichert keine steuerliche oder
DATEV-Vollkonformität zu.* Der vorhandene Export ist ein vereinfachter
Buchungsstapel mit Platzhalter-Konten und ist ausdrücklich als Übergabe an
einen Steuerberater gedacht, nicht als Ersatz für eine FiBu.

---

## 6. Deferred Nonblockers

Die folgenden Punkte sind fachlich bekannt, sind für den Freeze des Kerns
**nicht** blockierend und sind als bewusste Defers dokumentiert. Keiner dieser
Punkte erzwingt einen Code-Build vor dem Freeze.

1. **Payment-Re-Match.** Es existiert keine Funktion, um die
   `chargeId`-Zuordnung eines bestehenden Payments nachträglich in-place zu
   ändern. **Aktueller Workaround:** falsch zugeordneten oder ungematchten
   Payment löschen und über `createPayment` mit korrekter `chargeId` neu
   anlegen. Diese Einschränkung resultiert aus dem bewusst einfachen,
   betragsbasierten First-Match-Matching und ist für den operativen Core
   tragbar.
2. **Guthaben-Verrechnung / -Rückzahlungsworkflow.** Nachzahlungen aus
   Betriebskostenabrechnungen werden als zusätzliche Sollstellung gebucht;
   Guthaben (Saldo ≥ 0) werden **nicht** automatisch als negative Charge oder
   Credit verbucht. Das ist **kein Bug** — die fachlich korrekte Behandlung
   eines Guthabens ist die Verrechnung mit künftigen Forderungen oder die
   Rückzahlung an den Mieter. Eine automatische Guthaben-Buchung ist daher
   nicht zwingend.
3. **DATEV-Konten-Mapping.** Der EXTF-Export verwendet Platzhalter-Konten
   (`1200` Bank, `8000` Erlöse) und keine kostenstellengerechte Zuordnung. Für
   die Übergabe an den Steuerberater ist das ausreichend; ein vollständiges
   Mapping ist nicht Teil des Core.
4. **Eingangsrechnung / Kreditoren-Workflow.** Der vorhandene
   E-Rechnungs-Parser (CII/UBL) extrahiert Rechnungsnummer, Datum, Betrag,
   Währung und Lieferant. Ein AP-/Kreditoren-Workflow
   (Rechnungseingangsbuch, Zuordnung zu Kostenpositionen, Freigabe, Skonto) ist
   nicht Teil des Core.
5. **Charge Scheduler.** Sollstellungen werden **manuell oder ausgelöst**
   erzeugt (`generateCharges` / `run_charge_generation`). Ein automatischer,
   zeitgesteuerter Sollstellungslauf (z. B. nächtlicher Job) existiert nicht.
   Hintergrund-Scheduler existieren nur für Bank-Sync und eingehende E-Mails.
6. **camt-Datei-Import: `externalId`/Dedup-Härtung.** Der
   camt.053-Datei-Import setzt aktuell keine externe Transaktions-ID und
   führt keine Dedup-Prüfung gegen früher importierte Dateien durch. Bei
   wiederholtem Import derselben Datei können Duplikate entstehen. Der
   Bank-Sync-Pfad hingegen dedupliziert über `externalId`.

---

## 7. Freeze Definition

Für den HaVeWa-Core gilt Accounting als **ausreichend und freeze-fähig**, wenn
die folgenden operativen Kernfunktionen vorhanden und nicht durch offene
MUST-Punkte eingeschränkt sind:

1. Manuell ausgelöste Sollstellung für Miete, Nebenkosten und Hausgeld.
2. Manuelle sowie camt.053- und Bank-Sync-basierte Zahlungserfassung.
3. Einfaches Import-Auto-Matching (betragsbasiert, First-Match).
4. Offene Posten und Mahnwesen.
5. Betriebskosten- und WEG-Abrechnung mit Nachzahlungs-Buchung.
6. Kaution einschließlich berechneter und angezeigter Verzinsung.
7. Operatives Reporting sowie SEPA-, OP- und vereinfachter DATEV-Export.

**Nicht-Ziele (gleichzeitig mit dem Freeze-Satz verbindlich):**

- Keine vollständige FiBu (kein Kontenplan, kein doppeltes Journal, keine
  doppelte Buchführung).
- Keine Umsatzsteuer-Engine, kein Periodenabschluss, keine Bilanz, keine GuV,
  keine AfA.
- Keine vollständige DATEV-Konformität; der Export ist ein vereinfachter
  Buchungsstapel.
- Kein Kreditoren-/Debitoren-Hauptbuch, kein Payroll, kein ERP.

---

## 8. Release Impact

Aus der Status-Matrix und den Deferred Nonblockers ergibt sich folgende
Release-Priorisierung für den HaVeWa-Core.

**MUST_BEFORE_FREEZE:** keine.

**SHOULD_BEFORE_FREEZE:** keine.

**DEFER (blockiert den Freeze nicht):**

- Payment-Re-Match
- Guthaben-Verrechnung / -Rückzahlungsworkflow
- DATEV-Konten-Mapping
- Eingangsrechnung / Kreditoren-Workflow
- Charge Scheduler
- camt-Datei-Import `externalId`/Dedup-Härtung

**NOT_NEEDED (bewusste Nicht-Ziele, keine Bugs):**

- Full G/L
- Doppelte Buchführung
- VAT / USt-Engine
- Periodenabschluss
- Bilanz
- GuV
- AfA
- Vollständiges Debitoren-/Kreditoren-Hauptbuch
- Vollständiger Income-/Expense-FiBu-Report
- DATEV-Vollkonformität
- Payroll / ERP

**HAVEWA-07:** Keiner der hier dokumentierten Accounting-Punkte blockiert
HAVEWA-07. In diesem Build wird keine Desktop-Arbeit ausgeführt.

---

## 9. Conclusion

HaVeWa liefert das operative Hausverwaltungs-Accounting, das die Realität
kleiner und mittlerer Verwaltungen in Deutschland abdeckt: Miet- und
Nebenkosten-Sollstellungen, Bank-Imports, offene Posten, Mahnwesen,
Betriebskosten- und WEG-Abrechnung, Kaution, Eigentümer-Abrechnung,
E-Rechnungs-Erkennung sowie operative Exporte. Eine vollständige steuerliche
Finanzbuchhaltung ist **kein** Bestandteil des Kerns; der vorhandene
vereinfachte DATEV-Export ist die Übergabe-Schnittstelle an den
Steuerberater.

Der HaVeWa-Core ist mit dieser klaren Scope-Abgrenzung **freeze-fähig**
(`READY_WITH_DEFERRED_NONBLOCKERS`). Die dokumentierten Defers sind als
bewusste Engineering-Entscheidung geführt und stellen keine Fehler dar. Die
nächste Ausbauphase kann diese Defers gezielt adressieren, ohne den Freeze
dieses Standes zu berühren.
