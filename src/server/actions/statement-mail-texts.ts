// HAVEWA-05B-2: Reiner Text-Helper für Statement-Mail + PDF.
// Keine DB, keine Session, kein Request-Kontext. Nur `locale` + fachliche
// Statement-Daten → deterministisches Textobjekt.
//
// Wird vom Statement-Mail/PDF-Action-Pfad (statement-actions.ts) aufgerufen,
// nachdem die Locale explizit vom Caller (lokalisierter UI/Page) durchgereicht
// wurde (Server-Action-Kontext: `getLocale()` ist unzuverlässig). Die
// Locale-Validation gegen routing.locales erfolgt hier; ungültige / leere
// Werte fallen auf `de` zurück.
//
// Bewusst KEIN paralleler `statementMail.heating*`-Namespace, sondern
// Wiederverwendung der bestehenden `print.heatingNote*`-Keys (C2).
//
// Sichtbare Action-Fehlertexte und die "Guthaben/Nachzahlung"-Wörter werden
// NICHT hier gehalten — sie liegen in den `messages/*.json`-Katalogen
// (`statements.errors.*`, `statements.credit`, `statements.arrears`) und
// werden im Action-Pfad über `getTranslations()` aufgelöst. Damit gibt es
// pro sichtbarem Text genau eine Wahrheitsquelle.

import { routing } from "@/i18n/routing";
import type { HeatingAllocation } from "@/lib/allocation/statement";

/** Heating-Modi, wie sie von `HeatingAllocation.mode` geliefert werden. */
export type HeatingMode = HeatingAllocation["mode"];

/** Sprachcode, den der Helper akzeptiert (gegen routing.locales validiert). */
export type SupportedStatementLocale = (typeof routing.locales)[number];

/** i18n-Key für die Heating-Hinweis-Zeile (NONE = keine Zeile). */
export type HeatingLineKey =
  | "print.heatingNote"
  | "print.heatingNoteFallback"
  | "print.heatingNoteMixed"
  | null;

export interface StatementBodyLabels {
  /** Label der "Umgelegte Kosten"-Zeile. */
  allocated: string;
  /** Label der "Vorauszahlungen"-Zeile. */
  prepayment: string;
}

export interface StatementMailTexts {
  /** Normalisierte, validierte Locale (eine der routing.locales). */
  locale: SupportedStatementLocale;
  /** Mail-Betreff. */
  subject: string;
  /** PDF-Titel. */
  pdfTitle: string;
  /** Mail-Anhang-Dateiname (Windows-/mailanhangsicher, keine instabilen IDs). */
  filename: string;
  /** Anrede. */
  greeting: string;
  /** Begleittext (eine Zeile, inkl. Year + Property + Unit). */
  bodyIntro: string;
  /** Labels für die Tabellenzeilen. */
  bodyLabels: StatementBodyLabels;
  /** Label-Wort für die "Ergebnis"-Zeile (z. B. "Ergebnis", "Result", "Resultado"). */
  resultLabel: string;
  /** Grußformel. */
  closing: string;
  /** i18n-Key der Heating-Hinweis-Zeile, oder null. */
  heatingLineKey: HeatingLineKey;
}

// ---------------------------------------------------------------------------
// Locale-Validierung + Fallback
// ---------------------------------------------------------------------------

const SUPPORTED_LOCALES = routing.locales;

/**
 * Validiert die übergebene Locale gegen `routing.locales`.
 * Fallback: `routing.defaultLocale` (typischerweise `de`).
 *
 * Akzeptiert zusätzlich `DE`/`de` (Groß-/Kleinschreibung toleriert), so dass
 * UI-Werte wie "DE" nicht zu einem ungewollten Fallback führen.
 */
export function resolveStatementLocale(locale: string | null | undefined): SupportedStatementLocale {
  if (!locale) return routing.defaultLocale as SupportedStatementLocale;
  const normalized = locale.trim();
  if ((SUPPORTED_LOCALES as readonly string[]).includes(normalized)) {
    return normalized as SupportedStatementLocale;
  }
  // tolerante Variante: "DE" -> "de"
  const lower = normalized.toLowerCase();
  if ((SUPPORTED_LOCALES as readonly string[]).includes(lower)) {
    return lower as SupportedStatementLocale;
  }
  return routing.defaultLocale as SupportedStatementLocale;
}

// ---------------------------------------------------------------------------
// Heating-Selektor (Production — wiederverwendet von statement-actions.ts)
// ---------------------------------------------------------------------------

/**
 * Production-Selektor: HeatingMode → i18n-Key.
 * NONE = null (kein Heating-Hinweis).
 * Bewusst KEIN dritter Heating-Entscheidungsbaum; nutzt die bestehenden
 * `print.heatingNote*`-Keys (C2), die schon in Admin-/Print-Routes
 * verwendet werden.
 */
export function selectStatementHeatingLineKey(mode: HeatingMode): HeatingLineKey {
  switch (mode) {
    case "METER":
      return "print.heatingNote";
    case "AREA_FALLBACK":
      return "print.heatingNoteFallback";
    case "MIXED":
      return "print.heatingNoteMixed";
    case "NONE":
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Filename
// ---------------------------------------------------------------------------

const FILENAME_PREFIX: Record<SupportedStatementLocale, string> = {
  de: "Abrechnung",
  en: "Statement",
  "pt-BR": "Demonstrativo",
};

/**
 * Windows-/Mail-anhangssicherer Dateiname für den PDF-Anhang der
 * Statement-Mail. UI hat `label` bereits sanitiert; hier KEINE
 * Instabilität einbauen (kein Hash, keine Timestamp).
 */
export function selectStatementFilename(
  locale: string,
  year: number,
  label: string,
): string {
  const l = resolveStatementLocale(locale);
  return `${FILENAME_PREFIX[l]} ${year} - ${label}.pdf`;
}

// ---------------------------------------------------------------------------
// Lokalisierte Textbausteine (Subject/PDF-Titel/Greeting/Body/Closing)
// ---------------------------------------------------------------------------

interface StatementCoreTexts {
  subject: (year: number, label: string) => string;
  pdfTitle: (year: number) => string;
  greeting: string;
  bodyIntro: (year: number, propName: string, label: string) => string;
  bodyLabels: StatementBodyLabels;
  closing: string;
  /** Label-Wort für die "Ergebnis"-Zeile (kurze Mail-Body-Variante). */
  resultLabel: string;
}

const CORE_TEXTS: Record<SupportedStatementLocale, StatementCoreTexts> = {
  de: {
    subject: (year, label) => `Betriebskostenabrechnung ${year} · ${label}`,
    pdfTitle: (year) => `Betriebskostenabrechnung ${year}`,
    greeting: "Sehr geehrte Mieterin, sehr geehrter Mieter,",
    bodyIntro: (year, propName, label) =>
      `anbei die Betriebskostenabrechnung ${year} für ${propName}, ${label}.`,
    bodyLabels: { allocated: "Umgelegte Kosten", prepayment: "Vorauszahlungen" },
    closing: "Mit freundlichen Grüßen",
    resultLabel: "Ergebnis",
  },
  en: {
    subject: (year, label) => `Service charge statement ${year} · ${label}`,
    pdfTitle: (year) => `Service charge statement ${year}`,
    greeting: "Dear Tenant,",
    bodyIntro: (year, propName, label) =>
      `please find attached the ${year} service charge statement for ${propName}, ${label}.`,
    bodyLabels: { allocated: "Allocated costs", prepayment: "Prepayments" },
    closing: "Kind regards",
    resultLabel: "Result",
  },
  "pt-BR": {
    subject: (year, label) => `Demonstrativo de encargos ${year} · ${label}`,
    pdfTitle: (year) => `Demonstrativo de encargos ${year}`,
    greeting: "Prezado(a) inquilino(a),",
    bodyIntro: (year, propName, label) =>
      `segue em anexo o demonstrativo de encargos de ${year} para ${propName}, ${label}.`,
    bodyLabels: { allocated: "Custos rateados", prepayment: "Adiantamentos" },
    closing: "Atenciosamente",
    resultLabel: "Resultado",
  },
};

// ---------------------------------------------------------------------------
// buildStatementMailTexts
// ---------------------------------------------------------------------------

/**
 * Erzeugt das deterministische Textobjekt für die Statement-Mail + PDF
 * (Subject, PDF-Titel, Anhangsname, Greeting, Body, Labels, Ergebnis-Label,
 * Grußformel, Heating-Hinweis-Key).
 *
 * Bewusst:
 *  - KEINE DB, KEIN Prisma, KEIN Fetch
 *  - KEIN `session.user.locale`, KEIN `getLocale()` (Aufrufer reicht `locale` durch)
 *  - KEIN erfundener Heating-Modus (Selektor nutzt `HeatingAllocation.mode` direkt)
 *  - KEIN zusätzlicher Money-Formatter: `money(value, locale)` aus @/lib/format
 *  - KEIN Audit-Text übersetzt (Audit-Summary bleibt unverändert deutsch)
 *  - KEIN Rechnungs-/Buchungstext übersetzt (description="NK-Nachzahlung {year}" bleibt)
 *  - KEINE sichtbaren Fehlertexte (liegen in messages/*.json unter
 *    `statements.errors.*`; eine Quelle pro Text)
 *  - KEINE Guthaben/Nachzahlung-Wörter (liegen unter `statements.credit`/
 *    `statements.arrears`; eine Quelle pro Text)
 *
 * Der Helper nimmt bewusst nur die Felder entgegen, die er für die obigen
 * Texte tatsächlich braucht. `unit.balance` und damit die Ergebnis-Zeile
 * ("<Betrag> <Art>") werden im Action-Pfad aus
 * `t("statements.credit"|"statements.arrears")` und `money(value, locale)`
 * zusammengesetzt.
 */
export function buildStatementMailTexts(
  locale: string,
  propName: string,
  unitLabel: string,
  year: number,
  heatingMode: HeatingMode,
): StatementMailTexts {
  const resolved = resolveStatementLocale(locale);
  const core = CORE_TEXTS[resolved];

  return {
    locale: resolved,
    subject: core.subject(year, unitLabel),
    pdfTitle: core.pdfTitle(year),
    filename: selectStatementFilename(resolved, year, unitLabel),
    greeting: core.greeting,
    bodyIntro: core.bodyIntro(year, propName, unitLabel),
    bodyLabels: core.bodyLabels,
    resultLabel: core.resultLabel,
    closing: core.closing,
    heatingLineKey: selectStatementHeatingLineKey(heatingMode),
  };
}
