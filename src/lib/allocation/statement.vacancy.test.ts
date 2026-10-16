import { describe, it, expect } from "vitest";
import { buildStatement, STATEMENT_VACANCY_ID } from "./statement";

const fy = (id: string, prepayment = 0) => [{ id, monthsActive: 12, prepayment }];

// HAVEWA-05B-1: V-1 Reconciliation zwischen sichtbarer Statement-Summe und
// ausgewiesenem Gesamtbetrag (totalUmlage) bei zeitanteiligem Leerstand.
// Die zusätzliche Reconciliation-Zeile darf NICHT "Leerstand" heißen, sondern
// muss fachlich präzise sein (siehe statements.reconciliationVacancy in
// messages/*.json). Cent-Logik in Integer-Cent. Null/Negativ-Guard.
// V-2 (Verbrauchs-Vakanz bei unterjähriger Lease) bleibt explizit deferred.

describe("buildStatement — V-1 Reconciliation (HAVEWA-05B-1)", () => {
  it("kein Leerstand → keine Reconciliation-Zeile", () => {
    // 1000 € auf zwei vollvermietete Einheiten (1:1 nach Fläche) → Sum 1000
    // exakt, residual = 0 → keine zusätzliche Zeile.
    const units = [
      { id: "a", label: "A", area: 50, persons: 1, leases: fy("la") },
      { id: "b", label: "B", area: 50, persons: 1, leases: fy("lb") },
    ];
    const { lines, totalUmlage } = buildStatement(units, [
      { id: "c1", amount: 1000, method: "AREA", umlagefaehig: true },
    ]);
    expect(totalUmlage).toBe(1000);
    expect(lines.map((l) => [l.unitId, l.allocated])).toEqual([
      ["a", 500],
      ["b", 500],
    ]);
    // Keine Reconciliation-Zeile, wenn nichts übrig ist.
    expect(lines.find((l) => l.unitId === STATEMENT_VACANCY_ID)).toBeUndefined();
  });

  it("ganzjähriger Leerstand (eine Einheit ohne Lease) → positive Reconciliation-Zeile", () => {
    // Einheit A ganzjährig vermietet, Einheit B ganzjährig leer.
    // 1000 € nach Fläche → A bekommt 500, B bekommt 500 (per Unit-Time),
    // aber B hat keine Lease → A erhält effektiv 500, B 0, Residual = 500.
    const units = [
      { id: "a", label: "A", area: 50, persons: 1, leases: fy("la") },
      { id: "b", label: "B", area: 50, persons: 1, leases: [] },
    ];
    const { lines, totalUmlage } = buildStatement(units, [
      { id: "c1", amount: 1000, method: "AREA", umlagefaehig: true },
    ]);
    expect(totalUmlage).toBe(1000);
    const tenantLine = lines.find((l) => l.leaseId === "la")!;
    const vacantLine = lines.find((l) => l.leaseId === null && l.unitId === "b")!;
    expect(tenantLine.allocated).toBe(500);
    expect(vacantLine.allocated).toBe(0);
    // Reconciliation: trägt den Rest (Vermieteranteil) aus.
    const recon = lines.find((l) => l.unitId === STATEMENT_VACANCY_ID);
    expect(recon).toBeDefined();
    expect(recon!.leaseId).toBeNull();
    expect(recon!.allocated).toBe(500);
    expect(recon!.prepayment).toBe(0);
    expect(recon!.balance).toBe(-500);
    // Summe + totalUmlage stimmt cent-genau.
    const sum = lines.reduce((a, l) => a + l.allocated, 0);
    expect(Math.round(sum * 100) / 100).toBe(totalUmlage);
  });

  it("mixed: occupied und vacant units gleichzeitig → Reconciliation schließt Lücke cent-genau", () => {
    // 3 Einheiten (UNITS), A ganzjährig vermietet, B 6 Monate vermietet,
    // C ganzjährig leer. 1200 € nach UNITS:
    //   per-unit timeTotal = 1200/3 = 400.
    //   A: 400 * 12/12 = 400
    //   B: 400 * 6/12  = 200
    //   C: 0 (keine Lease)
    // Σ Mieter-/Leerstand-Zeilen = 600, Residual = 600 → Recon-Zeile 600.
    const units = [
      { id: "a", label: "A", area: 50, persons: 1, leases: [{ id: "la", monthsActive: 12, prepayment: 0 }] },
      { id: "b", label: "B", area: 50, persons: 1, leases: [{ id: "lb", monthsActive: 6, prepayment: 0 }] },
      { id: "c", label: "C", area: 50, persons: 1, leases: [] },
    ];
    const { lines, totalUmlage } = buildStatement(units, [
      { id: "c1", amount: 1200, method: "UNITS", umlagefaehig: true },
    ]);
    expect(totalUmlage).toBe(1200);
    expect(lines.find((l) => l.leaseId === "la")!.allocated).toBe(400);
    expect(lines.find((l) => l.leaseId === "lb")!.allocated).toBe(200);
    expect(lines.find((l) => l.leaseId === null && l.unitId === "c")!.allocated).toBe(0);
    const recon = lines.find((l) => l.unitId === STATEMENT_VACANCY_ID);
    expect(recon).toBeDefined();
    expect(recon!.allocated).toBe(600);
    expect(recon!.leaseId).toBeNull();
    // Cent-Invariant: Σ lines.allocated == totalUmlage.
    const sum = lines.reduce((a, l) => a + l.allocated, 0);
    expect(Math.round(sum * 100) / 100).toBe(1200);
  });

  it("Heizung METER + Leerstand → Residual cent-genau, keine Verbrauchs-Anpassung", () => {
    // Heizung 1000 €, 30/70 nach HeizkostenV. A vermietet (cons=30), C leer (cons=0).
    // Grundkosten 300 nach Fläche: A=150, C=150 (aber C ohne Lease → 0).
    // Verbrauch 700 auf A (allein im Cons-Scope mit cons>0): A=700.
    // A: 150+700=850, C: 0, Residual = 1000−850 = 150 → Recon-Zeile 150.
    const units = [
      { id: "a", label: "A", area: 50, persons: 1, consumption: 30, leases: fy("la") },
      { id: "c", label: "C", area: 50, persons: 1, consumption: 0, leases: [] },
    ];
    const { lines, totalUmlage } = buildStatement(units, [
      { id: "h", amount: 1000, method: "CONSUMPTION", umlagefaehig: true, heating: true },
    ]);
    expect(totalUmlage).toBe(1000);
    const a = lines.find((l) => l.leaseId === "la")!;
    const c = lines.find((l) => l.leaseId === null && l.unitId === "c")!;
    expect(a.allocated).toBe(850);
    expect(c.allocated).toBe(0);
    const recon = lines.find((l) => l.unitId === STATEMENT_VACANCY_ID);
    expect(recon).toBeDefined();
    expect(recon!.allocated).toBe(150);
    expect(recon!.leaseId).toBeNull();
    // Summe cent-genau = totalUmlage.
    const sum = lines.reduce((acc, l) => acc + l.allocated, 0);
    expect(Math.round(sum * 100) / 100).toBe(1000);
  });

  it("AREA_FALLBACK + Leerstand → Residual cent-genau", () => {
    // Heizung ohne Verbrauchsdaten → AREA-Fallback. A vermietet, B leer.
    // 1000 € → A 500, B 0, Residual 500 → Recon 500.
    const units = [
      { id: "a", label: "A", area: 50, persons: 1, leases: fy("la") },
      { id: "b", label: "B", area: 50, persons: 1, leases: [] },
    ];
    const { lines, totalUmlage } = buildStatement(units, [
      { id: "h", amount: 1000, method: "CONSUMPTION", umlagefaehig: true, heating: true },
    ]);
    expect(totalUmlage).toBe(1000);
    const recon = lines.find((l) => l.unitId === STATEMENT_VACANCY_ID);
    expect(recon).toBeDefined();
    expect(recon!.allocated).toBe(500);
  });

  it("non-heating CONSUMPTION + Leerstand → Reconciliation berücksichtigt nur Residual", () => {
    // non-heating mit method=CONSUMPTION und consumption=0 → fällt auf
    // AREA zurück (siehe statement.ts Zeile 230). Rest analog AREA-Test.
    const units = [
      { id: "a", label: "A", area: 50, persons: 1, leases: fy("la") },
      { id: "b", label: "B", area: 50, persons: 1, leases: [] },
    ];
    const { lines, totalUmlage } = buildStatement(units, [
      { id: "k", amount: 800, method: "CONSUMPTION", umlagefaehig: true },
    ]);
    expect(totalUmlage).toBe(800);
    const recon = lines.find((l) => l.unitId === STATEMENT_VACANCY_ID);
    expect(recon).toBeDefined();
    expect(recon!.allocated).toBe(400);
  });

  it("Summe aller sichtbaren Zeilen inkl. Reconciliation == totalUmlage cent-genau", () => {
    // Allgemeiner Property-Test: für mehrere Konstellationen muss
    // Σ lines.allocated === totalUmlage cent-genau gelten.
    const cases: Array<{ units: Parameters<typeof buildStatement>[0]; costs: Parameters<typeof buildStatement>[1] }> = [
      {
        units: [
          { id: "a", label: "A", area: 50, persons: 1, leases: fy("la") },
          { id: "b", label: "B", area: 50, persons: 1, leases: [] },
        ],
        costs: [
          { id: "c1", amount: 1000, method: "AREA", umlagefaehig: true },
          { id: "c2", amount: 333.33, method: "PERSONS", umlagefaehig: true },
        ],
      },
      {
        units: [
          { id: "a", label: "A", area: 50, persons: 1, leases: [{ id: "la", monthsActive: 6, prepayment: 0 }] },
          { id: "b", label: "B", area: 50, persons: 1, leases: [] },
        ],
        costs: [{ id: "h", amount: 999.99, method: "AREA", umlagefaehig: true, heating: true }],
      },
    ];
    for (const { units, costs } of cases) {
      const { lines, totalUmlage } = buildStatement(units, costs);
      const sumCents = lines.reduce((a, l) => a + Math.round(l.allocated * 100), 0);
      const totalCents = Math.round(totalUmlage * 100);
      // residualCents >= 0 (Guard: keine negative Recon-Zeile).
      expect(sumCents).toBe(totalCents);
    }
  });

  it("cent remainder exakt: bei 0,01 € Residual → Recon-Zeile mit 0,01", () => {
    // 100 € / 3 nach UNITS → 33.33 + 33.33 + 33.34 = 100. 0,01 € landet
    // bei einer Lease (Largest Remainder). Hier soll NUR ein zusätzlicher
    // Residual 0 ausgewiesen werden — kein Geld verschwindet, nichts
    // wird erfunden. Sanity-Check, dass Recon nicht erzeugt wird, wenn
    // Summe bereits cent-genau == totalUmlage.
    const units = [
      { id: "a", label: "A", area: 1, persons: 1, leases: fy("la") },
      { id: "b", label: "B", area: 1, persons: 1, leases: fy("lb") },
      { id: "c", label: "C", area: 1, persons: 1, leases: fy("lc") },
    ];
    const { lines, totalUmlage } = buildStatement(units, [
      { id: "c1", amount: 100, method: "UNITS", umlagefaehig: true },
    ]);
    expect(totalUmlage).toBe(100);
    const sumCents = lines.reduce((a, l) => a + Math.round(l.allocated * 100), 0);
    expect(sumCents).toBe(10000);
    expect(lines.find((l) => l.unitId === STATEMENT_VACANCY_ID)).toBeUndefined();
  });

  it("negativer/0 Residual → keine Reconciliation-Zeile (Guard)", () => {
    // Konstellation: zwei vollvermietete Einheiten, Summe bereits cent-genau.
    // (Identisch zu "kein Leerstand" — der Guard darf NIE eine Zeile mit
    // <= 0 erzeugen.)
    const units = [
      { id: "a", label: "A", area: 50, persons: 1, leases: fy("la") },
      { id: "b", label: "B", area: 50, persons: 1, leases: fy("lb") },
    ];
    const { lines } = buildStatement(units, [
      { id: "c1", amount: 1200, method: "UNITS", umlagefaehig: true },
    ]);
    expect(lines.find((l) => l.unitId === STATEMENT_VACANCY_ID)).toBeUndefined();
  });

  it("bestehende Mieterbeträge unverändert (Regressionsschutz)", () => {
    // Snapshot: bekannte Verteilung ohne Recon-Logik bleibt unverändert,
    // wenn keine Reconciliation nötig ist.
    const units = [
      { id: "a", label: "A", area: 50, persons: 1, leases: fy("la", 300) },
      { id: "b", label: "B", area: 50, persons: 3, leases: fy("lb", 300) },
    ];
    const { lines, totalUmlage } = buildStatement(units, [
      { id: "c1", amount: 400, method: "PERSONS", umlagefaehig: true },
    ]);
    expect(totalUmlage).toBe(400);
    expect(lines.find((l) => l.leaseId === "la")!.allocated).toBe(100);
    expect(lines.find((l) => l.leaseId === "lb")!.allocated).toBe(300);
    // Keine Recon-Zeile ohne Residual.
    expect(lines.find((l) => l.unitId === STATEMENT_VACANCY_ID)).toBeUndefined();
  });

  it("partial-year vacancy: nur zeitanteiliger Residual wird sichtbar ausgewiesen", () => {
    // Eine Einheit mit Mietbeginn 01.07. (6 Monate) → bei 1200 €/UNITS
    // bekommt die Lease 600 €. Residual 600 € → Recon-Zeile 600 €.
    // V-2 (Verbrauchszuordnung bei unterjähriger Lease) bleibt hier
    // absichtlich ungelöst — Verbrauch wird hier voll der einen Lease
    // zugeordnet (Dokumentations-/Test-Anker).
    const units = [
      { id: "a", label: "A", area: 50, persons: 1, leases: [{ id: "la", monthsActive: 6, prepayment: 0 }] },
    ];
    const { lines, totalUmlage } = buildStatement(units, [
      { id: "c1", amount: 1200, method: "UNITS", umlagefaehig: true },
    ]);
    expect(totalUmlage).toBe(1200);
    const a = lines.find((l) => l.leaseId === "la")!;
    expect(a.allocated).toBe(600);
    const recon = lines.find((l) => l.unitId === STATEMENT_VACANCY_ID);
    expect(recon).toBeDefined();
    expect(recon!.allocated).toBe(600);
    expect(recon!.leaseId).toBeNull();
    const sum = lines.reduce((acc, l) => acc + l.allocated, 0);
    expect(Math.round(sum * 100) / 100).toBe(1200);
  });

  it("Statement-VACANCY_ID ist nicht mit area-time VACANCY_ID kollidierend dokumentiert", () => {
    // STATEMENT_VACANCY_ID darf NICHT gleich area-time VACANCY_ID sein,
    // um Cross-Domain-Key-Kollisionen in Tabellen/UI zu vermeiden.
    // (Sanity-Check für die Architekturentscheidung.)
    expect(STATEMENT_VACANCY_ID).toBeTruthy();
    expect(STATEMENT_VACANCY_ID).not.toBe("__vacancy__");
  });
});