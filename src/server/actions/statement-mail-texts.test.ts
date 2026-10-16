import { describe, it, expect } from "vitest";
import {
  buildStatementMailTexts,
  selectStatementHeatingLineKey,
  selectStatementFilename,
  type HeatingMode,
} from "./statement-mail-texts";

/**
 * HAVEWA-05B-2: Reiner Text-Helper für Statement-Mail + PDF (de/en/pt-BR).
 *
 * Keine DB, keine Session, kein Request-Kontext. Nur locale + propName +
 * unitLabel + year + heatingMode → Textobjekt.
 *
 * Sichtbare Action-Fehlertexte (`statements.errors.*`) und die
 * "Guthaben/Nachzahlung"-Wörter (`statements.credit`/`statements.arrears`)
 * werden bewusst NICHT im Helper gehalten — sie liegen in den
 * Message-Katalogen und werden im Action-Pfad über `getTranslations()`
 * aufgelöst. Damit gibt es pro sichtbarem Text genau eine Wahrheitsquelle.
 *
 * Semantik des Helper-Outputs:
 * - subject       : Mail-Betreff
 * - pdfTitle      : PDF-Titel
 * - filename      : Mail-Anhang (Windows-/mailanhängsicher)
 * - greeting      : Anrede
 * - bodyIntro     : Begleittext (eine Zeile)
 * - bodyLabels    : { allocated, prepayment } in der aktiven Locale
 * - resultLabel   : "Ergebnis" / "Result" / "Resultado" (Prefix der
 *                   Ergebnis-Zeile; Betrag+Art kommen aus money() + t()
 *                   im Action-Pfad, NICHT aus diesem Helper)
 * - closing       : Grußformel
 * - heatingLineKey: i18n-Key des Heating-Hinweises (NONE = null)
 */

// ---------------------------------------------------------------------------
// Heating-Selektor
// ---------------------------------------------------------------------------

describe("selectStatementHeatingLineKey (Production-Selektor)", () => {
  it("NONE → null", () => {
    expect(selectStatementHeatingLineKey("NONE")).toBeNull();
  });
  it("METER → print.heatingNote", () => {
    expect(selectStatementHeatingLineKey("METER")).toBe("print.heatingNote");
  });
  it("AREA_FALLBACK → print.heatingNoteFallback", () => {
    expect(selectStatementHeatingLineKey("AREA_FALLBACK")).toBe("print.heatingNoteFallback");
  });
  it("MIXED → print.heatingNoteMixed", () => {
    expect(selectStatementHeatingLineKey("MIXED")).toBe("print.heatingNoteMixed");
  });
  it("akzeptiert genau die vier dokumentierten Modi", () => {
    const modes: HeatingMode[] = ["NONE", "METER", "AREA_FALLBACK", "MIXED"];
    for (const m of modes) {
      // Nur METER/AREA_FALLBACK/MIXED liefern einen i18n-Key; NONE liefert null.
      const k = selectStatementHeatingLineKey(m);
      if (m === "NONE") expect(k).toBeNull();
      else expect(k).toMatch(/^print\.heatingNote/);
    }
  });
});

// ---------------------------------------------------------------------------
// Filename
// ---------------------------------------------------------------------------

describe("selectStatementFilename (lokalisiert, Windows-/Mail-anhangssicher)", () => {
  it("de → 'Abrechnung {year} - {label}.pdf'", () => {
    expect(selectStatementFilename("de", 2025, "Whg 1")).toBe("Abrechnung 2025 - Whg 1.pdf");
  });
  it("en → 'Statement {year} - {label}.pdf'", () => {
    expect(selectStatementFilename("en", 2025, "Whg 1")).toBe("Statement 2025 - Whg 1.pdf");
  });
  it("pt-BR → 'Demonstrativo {year} - {label}.pdf'", () => {
    expect(selectStatementFilename("pt-BR", 2025, "Whg 1")).toBe("Demonstrativo 2025 - Whg 1.pdf");
  });
  it("ungültige Locale → 'de' Fallback", () => {
    expect(selectStatementFilename("fr" as "de", 2025, "Whg 1")).toBe("Abrechnung 2025 - Whg 1.pdf");
  });
  it("Label wird unverändert übernommen (UI hat es bereits sanitiert)", () => {
    expect(selectStatementFilename("de", 2025, "Top 1")).toBe("Abrechnung 2025 - Top 1.pdf");
  });
});

// ---------------------------------------------------------------------------
// buildStatementMailTexts — Deutsch
// ---------------------------------------------------------------------------

describe("buildStatementMailTexts — DE", () => {
  const t = buildStatementMailTexts("de", "Hochstraße 5", "Whg 1", 2025, "METER");

  it("locale-validated (= de)", () => {
    expect(t.locale).toBe("de");
  });

  it("subject = 'Betriebskostenabrechnung {year} · {label}'", () => {
    expect(t.subject).toBe("Betriebskostenabrechnung 2025 · Whg 1");
  });

  it("pdfTitle = 'Betriebskostenabrechnung {year}'", () => {
    expect(t.pdfTitle).toBe("Betriebskostenabrechnung 2025");
  });

  it("filename = 'Abrechnung 2025 - Whg 1.pdf'", () => {
    expect(t.filename).toBe("Abrechnung 2025 - Whg 1.pdf");
  });

  it("greeting enthält Mieteranrede", () => {
    expect(t.greeting).toBe("Sehr geehrte Mieterin, sehr geehrter Mieter,");
  });

  it("bodyIntro enthält Property+Unit+Jahr (DE)", () => {
    expect(t.bodyIntro).toBe(
      "anbei die Betriebskostenabrechnung 2025 für Hochstraße 5, Whg 1.",
    );
  });

  it("bodyLabels (allocated/prepayment/result) sind DE-Labels", () => {
    expect(t.bodyLabels.allocated).toBe("Umgelegte Kosten");
    expect(t.bodyLabels.prepayment).toBe("Vorauszahlungen");
  });

  it("resultLabel = 'Ergebnis' (Ergebnis-Zeile selbst wird im Action-Pfad gebaut)", () => {
    expect(t.resultLabel).toBe("Ergebnis");
  });

  it("closing = 'Mit freundlichen Grüßen'", () => {
    expect(t.closing).toBe("Mit freundlichen Grüßen");
  });

  it("heatingLineKey METER → 'print.heatingNote'", () => {
    expect(t.heatingLineKey).toBe("print.heatingNote");
  });
});

describe("buildStatementMailTexts — DE Heating NONE / AREA_FALLBACK / MIXED", () => {
  it("NONE → heatingLineKey = null", () => {
    const t = buildStatementMailTexts("de", "Hochstraße 5", "Whg 1", 2025, "NONE");
    expect(t.heatingLineKey).toBeNull();
  });
  it("AREA_FALLBACK → 'print.heatingNoteFallback'", () => {
    const t = buildStatementMailTexts("de", "Hochstraße 5", "Whg 1", 2025, "AREA_FALLBACK");
    expect(t.heatingLineKey).toBe("print.heatingNoteFallback");
  });
  it("MIXED → 'print.heatingNoteMixed'", () => {
    const t = buildStatementMailTexts("de", "Hochstraße 5", "Whg 1", 2025, "MIXED");
    expect(t.heatingLineKey).toBe("print.heatingNoteMixed");
  });
});

// ---------------------------------------------------------------------------
// buildStatementMailTexts — Englisch
// ---------------------------------------------------------------------------

describe("buildStatementMailTexts — EN", () => {
  const t = buildStatementMailTexts("en", "Hochstraße 5", "Apt 1", 2025, "METER");

  it("subject lokalisiert", () => {
    expect(t.subject).toBe("Service charge statement 2025 · Apt 1");
  });

  it("pdfTitle lokalisiert", () => {
    expect(t.pdfTitle).toBe("Service charge statement 2025");
  });

  it("filename lokalisiert", () => {
    expect(t.filename).toBe("Statement 2025 - Apt 1.pdf");
  });

  it("greeting enthält 'Dear Tenant'", () => {
    expect(t.greeting).toBe("Dear Tenant,");
  });

  it("bodyIntro enthält 'please find ...'", () => {
    expect(t.bodyIntro).toBe(
      "please find attached the 2025 service charge statement for Hochstraße 5, Apt 1.",
    );
  });

  it("bodyLabels EN", () => {
    expect(t.bodyLabels.allocated).toBe("Allocated costs");
    expect(t.bodyLabels.prepayment).toBe("Prepayments");
  });

  it("resultLabel EN = 'Result'", () => {
    expect(t.resultLabel).toBe("Result");
  });

  it("closing = 'Kind regards'", () => {
    expect(t.closing).toBe("Kind regards");
  });

  it("heatingLineKey METER bleibt 'print.heatingNote' (gleicher i18n-Key)", () => {
    expect(t.heatingLineKey).toBe("print.heatingNote");
  });
});

// ---------------------------------------------------------------------------
// buildStatementMailTexts — Portugiesisch (pt-BR)
// ---------------------------------------------------------------------------

describe("buildStatementMailTexts — pt-BR", () => {
  const t = buildStatementMailTexts("pt-BR", "Hochstraße 5", "Apto 1", 2025, "METER");

  it("subject lokalisiert", () => {
    expect(t.subject).toBe("Demonstrativo de encargos 2025 · Apto 1");
  });

  it("pdfTitle lokalisiert", () => {
    expect(t.pdfTitle).toBe("Demonstrativo de encargos 2025");
  });

  it("filename lokalisiert", () => {
    expect(t.filename).toBe("Demonstrativo 2025 - Apto 1.pdf");
  });

  it("greeting = 'Prezado(a) inquilino(a),'", () => {
    expect(t.greeting).toBe("Prezado(a) inquilino(a),");
  });

  it("bodyIntro lokalisiert", () => {
    expect(t.bodyIntro).toBe(
      "segue em anexo o demonstrativo de encargos de 2025 para Hochstraße 5, Apto 1.",
    );
  });

  it("bodyLabels pt-BR", () => {
    expect(t.bodyLabels.allocated).toBe("Custos rateados");
    expect(t.bodyLabels.prepayment).toBe("Adiantamentos");
  });

  it("resultLabel pt-BR = 'Resultado'", () => {
    expect(t.resultLabel).toBe("Resultado");
  });

  it("closing = 'Atenciosamente'", () => {
    expect(t.closing).toBe("Atenciosamente");
  });

  it("heatingLineKey METER bleibt 'print.heatingNote'", () => {
    expect(t.heatingLineKey).toBe("print.heatingNote");
  });
});

// ---------------------------------------------------------------------------
// Locale-Validation + Fallback
// ---------------------------------------------------------------------------

describe("buildStatementMailTexts — Locale-Validierung (Fallback 'de')", () => {
  it("ungültiger Locale-String → Fallback 'de'", () => {
    const t = buildStatementMailTexts("fr", "Hochstraße 5", "Whg 1", 2025, "METER");
    expect(t.locale).toBe("de");
    expect(t.subject).toBe("Betriebskostenabrechnung 2025 · Whg 1");
  });

  it("leerer Locale-String → Fallback 'de'", () => {
    const t = buildStatementMailTexts("", "Hochstraße 5", "Whg 1", 2025, "METER");
    expect(t.locale).toBe("de");
  });

  it("'DE' (Großschreibung) wird akzeptiert/normalisiert — 'de'", () => {
    // bewusst permissiv genug, dass UI-„DE" zu „de" wird; nicht erfunden.
    const t = buildStatementMailTexts("DE", "Hochstraße 5", "Whg 1", 2025, "METER");
    expect(t.locale).toBe("de");
  });
});

// ---------------------------------------------------------------------------
// Kein bedingungsloser deutscher Text in EN/pt-BR Mail/PDF-Helper
// ---------------------------------------------------------------------------

describe("buildStatementMailTexts — kein ungewollter deutscher Text", () => {
  it("EN: keine hartcodierten DE-Fragmente ('Betriebskostenabrechnung', 'Sehr geehrte')", () => {
    const t = buildStatementMailTexts("en", "Hochstraße 5", "Whg 1", 2025, "METER");
    expect(t.subject).not.toMatch(/Betriebskostenabrechnung/);
    expect(t.greeting).not.toMatch(/Sehr geehrte/);
    expect(t.bodyIntro).not.toMatch(/anbei die/);
    expect(t.closing).not.toMatch(/Mit freundlichen Grüßen/);
  });

  it("pt-BR: keine hartcodierten DE-Fragmente", () => {
    const t = buildStatementMailTexts("pt-BR", "Hochstraße 5", "Whg 1", 2025, "METER");
    expect(t.subject).not.toMatch(/Betriebskostenabrechnung/);
    expect(t.greeting).not.toMatch(/Sehr geehrte/);
    expect(t.bodyIntro).not.toMatch(/anbei die/);
    expect(t.closing).not.toMatch(/Mit freundlichen Grüßen/);
  });
});
