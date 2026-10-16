import { describe, it, expect } from "vitest";
import { resolveStatementLocale } from "./statement-mail-texts";

/**
 * HAVEWA-05B-2 / §6 Smoke: getLocale() in Server-Actions ist unzuverlässig.
 * Daher: Caller reicht `locale` als Hidden-Field durch (StatementActions.tsx
 * → useLocale()). `resolveStatementLocale` validiert gegen routing.locales
 * und fällt auf "de" zurück.
 *
 * Diese Tests verifizieren die explizite Locale-Validierung.
 */
describe("resolveStatementLocale (C6 Locale-Validation + Fallback de)", () => {
  it("akzeptiert 'de'", () => {
    expect(resolveStatementLocale("de")).toBe("de");
  });
  it("akzeptiert 'en'", () => {
    expect(resolveStatementLocale("en")).toBe("en");
  });
  it("akzeptiert 'pt-BR'", () => {
    expect(resolveStatementLocale("pt-BR")).toBe("pt-BR");
  });
  it("normalisiert 'DE' (Großschreibung) zu 'de'", () => {
    expect(resolveStatementLocale("DE")).toBe("de");
  });
  it("Fallback 'de' für unbekannte Locale 'fr'", () => {
    expect(resolveStatementLocale("fr")).toBe("de");
  });
  it("Fallback 'de' für leeren String", () => {
    expect(resolveStatementLocale("")).toBe("de");
  });
  it("Fallback 'de' für null", () => {
    expect(resolveStatementLocale(null)).toBe("de");
  });
  it("Fallback 'de' für undefined", () => {
    expect(resolveStatementLocale(undefined)).toBe("de");
  });
  it("Fallback 'de' für numerische Eingabe", () => {
    // Eingabe ist String | null | undefined — TypeScript schließt Number aus.
    // Wir akzeptieren aber explizit auch leere Whitespace-Strings.
    expect(resolveStatementLocale("   ")).toBe("de");
  });
  it("toleriert Whitespace", () => {
    expect(resolveStatementLocale("  en  ")).toBe("en");
    expect(resolveStatementLocale(" de ")).toBe("de");
  });
});
