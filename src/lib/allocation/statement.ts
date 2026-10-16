import { allocate, type AllocationMethod, type AllocationParticipant } from "./index";

/** HeizkostenV §7/§8: Anteil der Heiz-/Warmwasserkosten, der nach Verbrauch
 *  umgelegt wird (zulässig 50–70 %; hier 70 %). Rest = Grundkosten nach Fläche. */
export const HEATING_CONSUMPTION_SHARE = 0.7;

/**
 * Domänen-lokaler Identifier für die Vermieter-/Reconciliation-Zeile im
 * Statement. Bewusst NICHT identisch mit `VACANCY_ID` aus `area-time.ts`
 * (`"__vacancy__"`), um Cross-Domain-Key-Kollisionen in Tabellen und UI zu
 * vermeiden.
 *
 * HAVEWA-05B-1: Die Reconciliation-Zeile wird angehängt, wenn die sichtbare
 * Summe der Statement-Zeilen nicht cent-genau == totalUmlage ist
 * (positiver Residual = zeitanteiliger Leerstand / Vermieteranteil). Sie ist
 * kein echter Lease (`leaseId = null`), nicht buchungsfähig und nicht
 * mailbar.
 */
export const STATEMENT_VACANCY_ID = "__statement_vacancy__";

/**
 * Anzahl Kalendermonate des Jahres `year`, in denen ein Mietverhältnis aktiv ist.
 * Grundlage für die anteilige Vorauszahlung bei unterjährigem Miet-Beginn/-Ende
 * (sonst würde immer mit 12 Monaten gerechnet).
 */
export function monthsActiveInYear(start: Date, end: Date | null, year: number): number {
  let count = 0;
  for (let m = 0; m < 12; m++) {
    const monthStart = new Date(Date.UTC(year, m, 1));
    const monthEnd = new Date(Date.UTC(year, m + 1, 0, 23, 59, 59));
    if (start <= monthEnd && (!end || end >= monthStart)) count++;
  }
  return count;
}

/** Ein Mietverhältnis (Zeitscheibe) einer Einheit im Abrechnungsjahr. */
export interface LeaseSlice {
  id: string;
  /** Aktive Mietmonate im Abrechnungsjahr (0..12). */
  monthsActive: number;
  /** NK-Vorauszahlung im Zeitraum (monatlich × aktive Monate). */
  prepayment: number;
}

export interface UnitInput {
  id: string;
  label: string;
  area: number;
  persons: number;
  mea?: number;
  consumption?: number; // gemessener Heiz-/Warmwasserverbrauch (Einheiten)
  /** Mietverhältnisse der Einheit im Abrechnungsjahr (0..n). Bei Mieterwechsel
   *  mehrere; leer = Leerstand. Zeitanteilige Kosten werden pro Lease nach
   *  aktiven Monaten gekürzt (Leerstand trägt der Vermieter); Verbrauchskosten
   *  werden auf die Leases der Einheit nach Monatsanteil verteilt (der Zähler
   *  deckt nur die Gesamt-Nutzungszeit ab). */
  leases: LeaseSlice[];
}

export interface CostInput {
  id: string;
  amount: number;
  method: AllocationMethod;
  umlagefaehig: boolean;
  /** Heiz-/Warmwasserkosten → HeizkostenV-Split (Grundkosten Fläche / Verbrauch). */
  heating?: boolean;
  /** Verbrauchsanteil 0..1 (nur heating). Fehlt → HEATING_CONSUMPTION_SHARE (0,7).
   *  1 = 100 % nach Verbrauch (bei exaktem Verbrauch). */
  consumptionShare?: number;
  /** Nur diese Einheiten tragen die Position (Untergemeinschaft, #42). Fehlt → alle. */
  unitIds?: string[];
}

export interface StatementLine {
  unitId: string;
  leaseId: string | null; // null = Einheit ohne Mietverhältnis (Leerstand)
  label: string;
  allocated: number; // umgelegte Kosten
  prepayment: number;
  balance: number; // >0 Guthaben, <0 Nachzahlung
}

function participants(units: UnitInput[]): AllocationParticipant[] {
  return units.map((u) => ({
    id: u.id,
    area: u.area,
    persons: u.persons,
    mea: u.mea,
    consumption: u.consumption ?? 0,
  }));
}

/**
 * Effektive Verteilungsbasis einer Heiz-/Warmwasser-Kostenposition.
 *
 * - METER: consumptionShare>0, Verbrauchsdaten im scope vorhanden → Grundkosten
 *   nach Fläche + Verbrauchskosten nach Zähler (klassischer HeizkostenV-Split).
 * - AREA_FALLBACK: Heizposition mit method=CONSUMPTION, aber keine Verbrauchs-
 *   daten im scope → die Position wird nach Fläche umgelegt.
 * - NONE: keine relevante Heizposition.
 */
export type HeatingCostMode = "METER" | "AREA_FALLBACK";

/**
 * Statement-weite Zusammenfassung der tatsächlich verwendeten Heating-Verteilung.
 *
 * - NONE: keine relevanten Heiz-/Warmwasserpositionen.
 * - METER: alle relevanten Heizpositionen konnten meter-/verbrauchsbasiert
 *   verarbeitet werden.
 * - AREA_FALLBACK: relevante CONSUMPTION-Heizpositionen mussten wegen
 *   fehlendem Verbrauch auf Fläche zurückfallen.
 * - MIXED: innerhalb desselben Statements existieren sowohl meterbasierte als
 *   auch AREA-Fallback-Heizpositionen.
 *
 * `relevantCosts` zählt alle Heizpositionen, die im Statement berücksichtigt
 * werden. `meterCosts` und `fallbackCosts` disaggregieren für UI/Reporting.
 */
export interface HeatingAllocation {
  mode: "NONE" | "METER" | "AREA_FALLBACK" | "MIXED";
  /** Anzahl umlagefähiger Heiz-/Warmwasserpositionen mit consumption>0 im scope. */
  meterCosts: number;
  /** Anzahl umlagefähiger Heiz-/Warmwasserpositionen mit method=CONSUMPTION
   *  und consumption<=0 im scope (effektiv Flächenverteilung). */
  fallbackCosts: number;
  /** Summe aus meterCosts + fallbackCosts (Heizpositionen, die Anzeige
   *  beeinflussen). Andere Heating-Methoden (z. B. method=AREA) sind hier
   *  ausdrücklich NICHT enthalten, weil sie kein Fallback sind. */
  relevantCosts: number;
}

/**
 * Leitet den effektiven Heating-Modus aus den tatsächlich verarbeiteten
 * Heiz-/Warmwasserkostenpositionen ab. Wird sowohl für die UI-Anzeige als
 * auch für E-Mail-/PDF- und AI-Kontext verwendet.
 *
 * Wichtig: Die Metadaten folgen dem **effektiven** Pfad, den `buildStatement`
 * wählt — nicht nur `cost.method`. `buildStatement` splittet 30/70 immer dann,
 * wenn `cost.heating && totalConsumption > 0` ist, unabhängig von `method`.
 * Daher klassifizieren wir:
 * - `method=CONSUMPTION` + Verbrauch vorhanden → meter
 * - `method=CONSUMPTION` + kein Verbrauch      → fallback
 * - `method!=CONSUMPTION` + Verbrauch vorhanden → meter (effektiv 30/70)
 * - `method!=CONSUMPTION` + kein Verbrauch      → ignorieren (bewusst gewählter
 *   Schlüssel ohne Fallback-Bedeutung).
 */
export function deriveHeatingAllocation(units: UnitInput[], costs: CostInput[]): HeatingAllocation {
  let meterCosts = 0;
  let fallbackCosts = 0;
  for (const cost of costs) {
    if (!cost.heating || !cost.umlagefaehig || cost.amount <= 0) continue;
    const scope = cost.unitIds ? units.filter((u) => cost.unitIds!.includes(u.id)) : units;
    if (scope.length === 0) continue;
    const totalConsumption = scope.reduce((a, u) => a + (u.consumption ?? 0), 0);
    if (cost.method === "CONSUMPTION") {
      if (totalConsumption > 0) meterCosts++;
      else fallbackCosts++;
    } else {
      // method=AREA|UNITS|PERSONS|MEA|CUSTOM + heating + Verbrauchsdaten:
      // buildStatement splittet 30/70 (HeizkostenV). Metadaten müssen folgen.
      if (totalConsumption > 0) meterCosts++;
      // Sonst: bewusst gewählter Schlüssel ohne Verbrauchsdaten → nicht zählen.
    }
  }
  const total = meterCosts + fallbackCosts;
  let mode: HeatingAllocation["mode"];
  if (total === 0) mode = "NONE";
  else if (meterCosts > 0 && fallbackCosts === 0) mode = "METER";
  else if (meterCosts === 0 && fallbackCosts > 0) mode = "AREA_FALLBACK";
  else mode = "MIXED";
  return { mode, meterCosts, fallbackCosts, relevantCosts: total };
}

/**
 * Selektor für den Admin-UI-Heizhinweis (Ergebnis-Card-Header). Reine Funktion,
 * damit sie ohne React/Next testbar ist. Liefert den next-intl-Schlüssel, der
 * in der Admin-UI als Hinweiszeile gerendert werden soll, oder `null`, wenn
 * kein Hinweis erscheinen soll.
 *
 * - NONE           → null (kein Heizhinweis)
 * - METER          → statements.heatingHintMeter (30/70)
 * - AREA_FALLBACK  → statements.heatingHintFallback (nur Fläche)
 * - MIXED          → statements.heatingHintMixed (positionsweise)
 */
export function selectAdminHeatingHint(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _t: (key: string) => any,
  mode: HeatingAllocation["mode"],
): string | null {
  switch (mode) {
    case "METER":
      return "statements.heatingHintMeter";
    case "AREA_FALLBACK":
      return "statements.heatingHintFallback";
    case "MIXED":
      return "statements.heatingHintMixed";
    default:
      return null;
  }
}

/**
 * Betriebskostenabrechnung: legt jede umlagefähige Kostenposition per
 * Verteilerschlüssel auf die Einheiten um, summiert und verrechnet mit
 * der Vorauszahlung.
 *
 * Heizungs-/Warmwasserpositionen (heating) folgen der HeizkostenV: 30 % der
 * Kosten nach Fläche (Grundkosten), 70 % nach gemessenem Verbrauch. Fehlen alle
 * Verbrauchswerte, fällt die ganze Position auf Fläche zurück (§9a-Näherung).
 *
 * ponytail: Verbrauch = Ablesedifferenz im Jahr; keine Gradtagszahl-/Leerstands-
 * korrektur. Interface trägt bereits `consumption` je Einheit.
 */
export function buildStatement(units: UnitInput[], costs: CostInput[]) {
  // Zwei Töpfe je Einheit: zeitanteilig kürzbare Kosten (Fläche/Einheit/Person/
  // MEA) und Verbrauchskosten (Zähler). Nur der Zeit-Topf wird bei unterjährigem
  // Mietverhältnis gekürzt; der Verbrauch deckt bereits nur die Nutzungszeit ab.
  const perUnitTime: Record<string, number> = {};
  const perUnitCons: Record<string, number> = {};
  units.forEach((u) => {
    perUnitTime[u.id] = 0;
    perUnitCons[u.id] = 0;
  });
  let totalUmlage = 0;

  for (const cost of costs) {
    if (!cost.umlagefaehig || cost.amount <= 0) continue;
    // Verteilerkreis: alle Einheiten oder nur die der Untergemeinschaft.
    const scope = cost.unitIds ? units.filter((u) => cost.unitIds!.includes(u.id)) : units;
    if (scope.length === 0) continue;
    const parts = participants(scope);
    const totalConsumption = scope.reduce((a, u) => a + (u.consumption ?? 0), 0);

    if (cost.heating && totalConsumption > 0) {
      // Grundkosten nach Fläche + Verbrauchskosten nach Zähler.
      // Anteil je Position einstellbar (Default 70 %, 100 % = rein nach Verbrauch).
      const share = Math.min(1, Math.max(0, cost.consumptionShare ?? HEATING_CONSUMPTION_SHARE));
      const consAmount = cost.amount * share;
      const baseAmount = cost.amount - consAmount;
      allocate(baseAmount, "AREA", parts).forEach((r) => (perUnitTime[r.id] += r.amount));
      allocate(consAmount, "CONSUMPTION", parts).forEach((r) => (perUnitCons[r.id] += r.amount));
    } else {
      // Nicht-Heizung, oder Heizung ohne Verbrauchsdaten → nach gewählter Methode
      // (CONSUMPTION ohne Zählerdaten fällt auf Fläche zurück).
      const method: AllocationMethod =
        cost.method === "CONSUMPTION" && totalConsumption <= 0 ? "AREA" : cost.method;
      const bucket = method === "CONSUMPTION" ? perUnitCons : perUnitTime;
      allocate(cost.amount, method, parts).forEach((r) => (bucket[r.id] += r.amount));
    }
    totalUmlage += cost.amount;
  }

  const round = (n: number) => Math.round(n * 100) / 100;
  const clampMonths = (m: number) => Math.min(12, Math.max(0, m));

  // Eine Zeile je Mietverhältnis. Zeitkosten der Einheit werden nach aktiven
  // Monaten/12 auf die Leases verteilt (Rest = Leerstand → Vermieter, keine
  // Zeile). Verbrauchskosten werden auf die Leases der Einheit nach ihrem
  // Monatsanteil aufgeteilt (eine Lease → voll; kein taggenauer Zwischenstand).
  const lines: StatementLine[] = [];
  for (const u of units) {
    const timeTotal = perUnitTime[u.id];
    const consTotal = perUnitCons[u.id];

    if (u.leases.length === 0) {
      lines.push({ unitId: u.id, leaseId: null, label: u.label, allocated: 0, prepayment: 0, balance: 0 });
      continue;
    }

    const sumMonths = u.leases.reduce((a, l) => a + clampMonths(l.monthsActive), 0);
    for (const lease of u.leases) {
      const m = clampMonths(lease.monthsActive);
      const timePart = timeTotal * (m / 12);
      const consPart = sumMonths > 0 ? consTotal * (m / sumMonths) : 0;
      const allocated = round(timePart + consPart);
      lines.push({
        unitId: u.id,
        leaseId: lease.id,
        label: u.label,
        allocated,
        prepayment: round(lease.prepayment),
        balance: round(lease.prepayment - allocated),
      });
    }
  }

  // HAVEWA-05B-1 (V-1 Reconciliation): wenn die sichtbare Summe der
  // Mieter-/Leerstands-Zeilen den ausgewiesenen Gesamtbetrag (totalUmlage)
  // nicht cent-genau erreicht, wird eine zusätzliche Reconciliation-Zeile
  // ("Leerstand / Vermieteranteil (zeitanteilig)") angehängt. Berechnung in
  // Integer-Cent; Guard: residualCents <= 0 → keine Zeile.
  //
  // V-2 (Verbrauchs-Vakanz bei unterjähriger Lease) bleibt deferred.
  const totalCents = Math.round(totalUmlage * 100);
  const allocatedCents = lines.reduce((a, l) => a + Math.round(l.allocated * 100), 0);
  const residualCents = totalCents - allocatedCents;
  if (residualCents > 0) {
    lines.push({
      unitId: STATEMENT_VACANCY_ID,
      leaseId: null,
      label: STATEMENT_VACANCY_ID, // UI/Print ersetzt das Label durch Lokalisierung.
      allocated: residualCents / 100,
      prepayment: 0,
      balance: -(residualCents / 100),
    });
  }

  return { lines, totalUmlage: round(totalUmlage), heatingAllocation: deriveHeatingAllocation(units, costs) };
}
