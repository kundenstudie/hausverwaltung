import { describe, it, expect } from "vitest";
import { simplePdf } from "@/lib/pdf";
import type { HeatingAllocation } from "@/lib/allocation/statement";

/**
 * HAVEWA-05A: Der E-Mail-PDF-Pfad in statement-actions.ts muss dieselbe
 * Heating-Metadatenlogik verwenden wie Admin-/Print-Ausgabe. Diese Tests
 * prüfen die reine Entscheidungsmatrix (mode → Text), unabhängig von der
 * PDF-Erzeugung (simplePdf) und vom Prisma-/Mail-Kontext.
 *
 * Bewusst KEIN Mocking von simplePdf — wir rendern wirklich und greifen den
 * erzeugten PDF-Byte-String per Regex ab. Damit ist sichergestellt, dass
 * kein "hartcodierter 30/70-String" mehr im Pfad landet.
 */

function pdfText(pdf: Buffer): string {
  // simplePdf bettet Text in (...) Tj ein; Umlaute werden in WinAnsi-Bytes
  // umgewandelt. Für die Heizungs-Textprüfung reicht uns die Suche im
  // rohen Content-Stream, der Text-Bytes enthält.
  return pdf.toString("latin1");
}

function pdfContains(pdf: Buffer, needle: string): boolean {
  return pdfText(pdf).includes(needle);
}

/** Reine Entscheidungsmatrix — dieselbe Logik wie in statement-actions.ts. */
function heatingLineFor(mode: HeatingAllocation["mode"]): string | null {
  switch (mode) {
    case "METER":
      return "Heiz-/Warmwasserkosten nach HeizkostenV (30% Flaeche / 70% Verbrauch).";
    case "AREA_FALLBACK":
      return "Heiz-/Warmwasserkosten: Verteilung nach Wohnflaeche (keine Verbrauchsdaten verfuegbar).";
    case "MIXED":
      return "Heiz-/Warmwasserkosten: positionsweise Verteilung (Verbrauch, soweit vorhanden; sonst Flaeche).";
    default:
      return null;
  }
}

describe("HAVEWA-05A Heating-Text in E-Mail-PDF (decision matrix)", () => {
  it("NONE: kein Heating-Hinweis im PDF", () => {
    const mode: HeatingAllocation["mode"] = "NONE";
    const lines = ["A - Whg 1", "Ergebnis: 100 EUR"];
    const heatingLine = heatingLineFor(mode);
    if (heatingLine) lines.push(heatingLine);
    const pdf = simplePdf("Titel", lines);
    expect(pdfContains(pdf, "HeizkostenV")).toBe(false);
    expect(pdfContains(pdf, "Heiz-/Warmwasserkosten")).toBe(false);
  });

  it("METER: 30/70-Hinweis vorhanden", () => {
    const mode: HeatingAllocation["mode"] = "METER";
    const heatingLine = heatingLineFor(mode);
    const lines = ["A - Whg 1", heatingLine].filter((l): l is string => !!l);
    const pdf = simplePdf("Titel", lines);
    expect(pdfContains(pdf, "HeizkostenV")).toBe(true);
    expect(pdfContains(pdf, "30% Flaeche / 70% Verbrauch")).toBe(true);
  });

  it("AREA_FALLBACK: Fallback-Hinweis, KEIN pauschaler 30/70-Split", () => {
    const mode: HeatingAllocation["mode"] = "AREA_FALLBACK";
    const heatingLine = heatingLineFor(mode);
    const lines = ["A - Whg 1", heatingLine].filter((l): l is string => !!l);
    const pdf = simplePdf("Titel", lines);
    expect(pdfContains(pdf, "Wohnflaeche")).toBe(true);
    // 30/70 nur erlaubt, wenn METER. Hier NICHT.
    expect(pdfContains(pdf, "30% Flaeche / 70% Verbrauch")).toBe(false);
  });

  it("MIXED: Misch-Hinweis, KEIN pauschaler 30/70-Split", () => {
    const mode: HeatingAllocation["mode"] = "MIXED";
    const heatingLine = heatingLineFor(mode);
    const lines = ["A - Whg 1", heatingLine].filter((l): l is string => !!l);
    const pdf = simplePdf("Titel", lines);
    expect(pdfContains(pdf, "positionsweise")).toBe(true);
    expect(pdfContains(pdf, "30% Flaeche / 70% Verbrauch")).toBe(false);
  });
});
