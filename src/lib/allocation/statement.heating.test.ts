import { describe, it, expect } from "vitest";
import { buildStatement, deriveHeatingAllocation, selectAdminHeatingHint } from "./statement";

const fy = (id: string, prepayment = 0) => [{ id, monthsActive: 12, prepayment }];

describe("deriveHeatingAllocation (HAVEWA-05A Heating-Modus-Transparenz)", () => {
  it("A) keine Heiz-/Warmwasserposition → NONE", () => {
    const units = [
      { id: "a", label: "A", area: 50, persons: 1, leases: fy("la") },
      { id: "b", label: "B", area: 50, persons: 1, leases: fy("lb") },
    ];
    const alloc = deriveHeatingAllocation(units, [
      { id: "c1", amount: 1000, method: "AREA", umlagefaehig: true },
      { id: "c2", amount: 400, method: "PERSONS", umlagefaehig: true },
    ]);
    expect(alloc.mode).toBe("NONE");
    expect(alloc.relevantCosts).toBe(0);
  });

  it("B) Heating + Verbrauch vorhanden → METER", () => {
    const units = [
      { id: "a", label: "A", area: 50, persons: 1, consumption: 30, leases: fy("la") },
      { id: "b", label: "B", area: 50, persons: 1, consumption: 70, leases: fy("lb") },
    ];
    const alloc = deriveHeatingAllocation(units, [
      { id: "h", amount: 1000, method: "CONSUMPTION", umlagefaehig: true, heating: true },
    ]);
    expect(alloc.mode).toBe("METER");
    expect(alloc.relevantCosts).toBe(1);
    expect(alloc.fallbackCosts).toBe(0);
  });

  it("C) CONSUMPTION-Heating ohne Verbrauch → AREA_FALLBACK", () => {
    const units = [
      { id: "a", label: "A", area: 50, persons: 1, leases: fy("la") },
      { id: "b", label: "B", area: 50, persons: 1, leases: fy("lb") },
    ];
    const alloc = deriveHeatingAllocation(units, [
      { id: "h", amount: 1000, method: "CONSUMPTION", umlagefaehig: true, heating: true },
    ]);
    expect(alloc.mode).toBe("AREA_FALLBACK");
    expect(alloc.relevantCosts).toBe(1);
    expect(alloc.fallbackCosts).toBe(1);
  });

  it("D) Mischfall: eine Position meterbasiert, andere AREA-Fallback → MIXED", () => {
    const units = [
      { id: "a", label: "A", area: 50, persons: 1, consumption: 100, leases: fy("la") },
      { id: "b", label: "B", area: 50, persons: 1, consumption: 0, leases: fy("lb") },
    ];
    const alloc = deriveHeatingAllocation(units, [
      // Position 1: scope "a" mit Verbrauch → METER
      { id: "h1", amount: 500, method: "CONSUMPTION", umlagefaehig: true, heating: true, unitIds: ["a"] },
      // Position 2: scope "b" ohne Verbrauch → AREA_FALLBACK
      { id: "h2", amount: 500, method: "CONSUMPTION", umlagefaehig: true, heating: true, unitIds: ["b"] },
    ]);
    expect(alloc.mode).toBe("MIXED");
    expect(alloc.meterCosts).toBe(1);
    expect(alloc.fallbackCosts).toBe(1);
  });

  it("E) method=AREA ohne Verbrauch → KEIN fälschlicher AREA_FALLBACK", () => {
    const units = [
      { id: "a", label: "A", area: 50, persons: 1, leases: fy("la") },
    ];
    const alloc = deriveHeatingAllocation(units, [
      // method=AREA ist kein Fallback, sondern explizit gewählter Schlüssel.
      { id: "h", amount: 1000, method: "AREA", umlagefaehig: true, heating: true },
    ]);
    expect(alloc.mode).toBe("NONE");
  });

  it("F) andere non-CONSUMPTION-Methode ohne Verbrauch → KEIN fälschlicher AREA_FALLBACK", () => {
    const units = [
      { id: "a", label: "A", area: 50, persons: 1, leases: fy("la") },
    ];
    for (const method of ["UNITS", "PERSONS", "MEA", "CUSTOM"] as const) {
      const alloc = deriveHeatingAllocation(units, [
        { id: "h", amount: 1000, method, umlagefaehig: true, heating: true },
      ]);
      expect(alloc.mode).toBe("NONE");
    }
  });

  it("heating=false wird ignoriert (kein Heating-Marker → NONE)", () => {
    const units = [
      { id: "a", label: "A", area: 50, persons: 1, leases: fy("la") },
    ];
    const alloc = deriveHeatingAllocation(units, [
      { id: "c1", amount: 1000, method: "CONSUMPTION", umlagefaehig: true, heating: false },
    ]);
    expect(alloc.mode).toBe("NONE");
  });

  it("nicht umlagefähige Heating-Position zählt nicht als relevant", () => {
    const units = [
      { id: "a", label: "A", area: 50, persons: 1, leases: fy("la") },
    ];
    const alloc = deriveHeatingAllocation(units, [
      { id: "h", amount: 1000, method: "CONSUMPTION", umlagefaehig: false, heating: true },
    ]);
    expect(alloc.mode).toBe("NONE");
  });

  it("amount<=0 wird ignoriert", () => {
    const units = [
      { id: "a", label: "A", area: 50, persons: 1, leases: fy("la") },
    ];
    const alloc = deriveHeatingAllocation(units, [
      { id: "h", amount: 0, method: "CONSUMPTION", umlagefaehig: true, heating: true },
    ]);
    expect(alloc.mode).toBe("NONE");
  });

  it("leerer scope (unitIds ohne Treffer) wird ignoriert", () => {
    const units = [
      { id: "a", label: "A", area: 50, persons: 1, leases: fy("la") },
    ];
    const alloc = deriveHeatingAllocation(units, [
      { id: "h", amount: 1000, method: "CONSUMPTION", umlagefaehig: true, heating: true, unitIds: ["x"] },
    ]);
    expect(alloc.mode).toBe("NONE");
  });

  // HAVEWA-05A-Fix: heating=true + method!=CONSUMPTION + consumption>0
  // → effektiv METER-Pfad (buildStatement splittet 30/70 wegen
  // cost.heating && totalConsumption>0). Metadaten müssen denselben Pfad
  // abbilden, nicht nur cost.method.
  it("L-1: heating+method=AREA+consumption>0 → METER (nicht NONE)", () => {
    const units = [
      { id: "a", label: "A", area: 50, persons: 1, consumption: 30, leases: fy("la") },
      { id: "b", label: "B", area: 50, persons: 1, consumption: 70, leases: fy("lb") },
    ];
    const alloc = deriveHeatingAllocation(units, [
      { id: "h", amount: 1000, method: "AREA", umlagefaehig: true, heating: true },
    ]);
    expect(alloc.mode).toBe("METER");
    expect(alloc.meterCosts).toBe(1);
    expect(alloc.fallbackCosts).toBe(0);
    expect(alloc.relevantCosts).toBe(1);
  });

  it("L-1: heating+method=PERSONS+consumption>0 → METER", () => {
    const units = [
      { id: "a", label: "A", area: 50, persons: 1, consumption: 10, leases: fy("la") },
    ];
    const alloc = deriveHeatingAllocation(units, [
      { id: "h", amount: 500, method: "PERSONS", umlagefaehig: true, heating: true },
    ]);
    expect(alloc.mode).toBe("METER");
  });
});

describe("buildStatement — Beträge unverändert trotz Heating-Metadaten (Regressionsschutz)", () => {
  const units = [
    { id: "a", label: "A", area: 50, persons: 1, leases: fy("la", 300) },
    { id: "b", label: "B", area: 50, persons: 1, leases: fy("lb", 300) },
  ];

  it("G) Beträge bei METER bleiben identisch (360/640)", () => {
    const heiz = [
      { id: "a", label: "A", area: 50, persons: 1, consumption: 30, leases: fy("la", 300) },
      { id: "b", label: "B", area: 50, persons: 1, consumption: 70, leases: fy("lb", 300) },
    ];
    const { lines, totalUmlage } = buildStatement(heiz, [
      { id: "h", amount: 1000, method: "CONSUMPTION", umlagefaehig: true, heating: true },
    ]);
    expect(totalUmlage).toBe(1000);
    expect(lines[0].allocated).toBe(360);
    expect(lines[1].allocated).toBe(640);
  });

  it("H) totalUmlage bei AREA-Fallback bleibt 1000", () => {
    const { totalUmlage, lines } = buildStatement(units, [
      { id: "h", amount: 1000, method: "CONSUMPTION", umlagefaehig: true, heating: true },
    ]);
    expect(totalUmlage).toBe(1000);
    expect(lines[0].allocated).toBe(500);
    expect(lines[1].allocated).toBe(500);
  });

  it("I) Cent-Rounding cent-genau (1400 € bleibt 1400)", () => {
    const { lines } = buildStatement(units, [
      { id: "c1", amount: 1000, method: "AREA", umlagefaehig: true },
      { id: "c2", amount: 400, method: "PERSONS", umlagefaehig: true },
    ]);
    const sum = lines.reduce((a, l) => a + l.allocated, 0);
    expect(Math.round(sum * 100) / 100).toBe(1400);
  });

  it("Heating mit 100% Verbrauchsanteil (METER) bleibt 300/700", () => {
    const heiz = [
      { id: "a", label: "A", area: 50, persons: 1, consumption: 30, leases: fy("la") },
      { id: "b", label: "B", area: 50, persons: 1, consumption: 70, leases: fy("lb") },
    ];
    const { lines } = buildStatement(heiz, [
      { id: "h", amount: 1000, method: "CONSUMPTION", umlagefaehig: true, heating: true, consumptionShare: 1 },
    ]);
    expect(lines[0].allocated).toBe(300);
    expect(lines[1].allocated).toBe(700);
  });

  it("Mischfall (MIXED) Beträge bleiben additiv korrekt", () => {
    // 500 € Heizung für A (METER, cons=100, share=1) + 500 € Heizung für B (AREA-Fallback)
    // → A: 500 nach Verbrauch (allein), B: 500 nach Fläche.
    const mixedUnits = [
      { id: "a", label: "A", area: 50, persons: 1, consumption: 100, leases: fy("la", 300) },
      { id: "b", label: "B", area: 50, persons: 1, consumption: 0, leases: fy("lb", 300) },
    ];
    const { lines, totalUmlage } = buildStatement(mixedUnits, [
      { id: "h1", amount: 500, method: "CONSUMPTION", umlagefaehig: true, heating: true, unitIds: ["a"], consumptionShare: 1 },
      { id: "h2", amount: 500, method: "CONSUMPTION", umlagefaehig: true, heating: true, unitIds: ["b"] },
    ]);
    expect(totalUmlage).toBe(1000);
    expect(lines[0].allocated).toBe(500); // 100% Verbrauch auf A alleine
    expect(lines[1].allocated).toBe(500); // 500 nach Fläche auf B alleine
  });
});

// HAVEWA-05A-Fix: Selektor für den Admin-UI-Heizhinweis. Reine Funktion,
// damit der modusabhängige Text in page.tsx ohne Logik-Duplikation getestet
// werden kann (B-1: kein unbedingter 30/70-Hinweis im Admin mehr).
describe("selectAdminHeatingHint (HAVEWA-05A-Fix B-1)", () => {
  const t = (s: string) => s; // triviale t-Funktion für Test

  it("NONE → kein Hint (null)", () => {
    expect(selectAdminHeatingHint(t, "NONE")).toBeNull();
  });

  it("METER → METER-Hint (mit 30/70-Split)", () => {
    const out = selectAdminHeatingHint(t, "METER");
    expect(out).toBe("statements.heatingHintMeter");
  });

  it("AREA_FALLBACK → Fallback-Hint, kein 30/70", () => {
    const out = selectAdminHeatingHint(t, "AREA_FALLBACK");
    expect(out).toBe("statements.heatingHintFallback");
  });

  it("MIXED → Mixed-Hint, kein 30/70", () => {
    const out = selectAdminHeatingHint(t, "MIXED");
    expect(out).toBe("statements.heatingHintMixed");
  });
});
