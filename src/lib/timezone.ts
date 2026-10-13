// Zeitzonen-Helfer (HAVEWA-04). Pure Funktionen ohne Server-/DB-Abhängigkeit,
// damit sie in Unit-Tests (inkl. DST) direkt testbar sind.
//
// Prinzip: absolute Timestamps bleiben UTC/DB-Semantik. Die Mandanten-Zeitzone
// wird nur für Anzeige und lokale Tagesgrenzen (Termin-/Fristsemantik) genutzt.

export const DEFAULT_TIME_ZONE = "Europe/Berlin";

/** Validiert einen IANA-Zeitzonen-Identifier (z. B. "Europe/Berlin"). */
export function isValidIanaTimezone(tz: string): boolean {
  if (typeof tz !== "string" || tz.trim() === "") return false;
  try {
    // Wirft RangeError für unbekannte/ungültige Identifier.
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

interface ZonedParts {
  year: number;
  month: number; // 1-basiert
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function zonedParts(date: Date, tz: string): ZonedParts {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    second: Number(p.second),
  };
}

/** Offset der Zeitzone relativ zu UTC in ms (positiv = UTC+Offset), zum Zeitpunkt `utcMs`. */
function timeZoneOffsetMs(tz: string, utcMs: number): number {
  const p = zonedParts(new Date(utcMs), tz);
  const asLocalMs = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asLocalMs - utcMs;
}

/** Lokale Mitternacht (Tagesanfang) in der Zeitzone als UTC-Instant. */
export function startOfDayInTimeZone(date: Date, tz: string): Date {
  const p = zonedParts(date, tz);
  const wallClockMidnightUtc = Date.UTC(p.year, p.month - 1, p.day, 0, 0, 0);
  let offset = timeZoneOffsetMs(tz, wallClockMidnightUtc);
  let result = wallClockMidnightUtc - offset;
  // Einmal verfeinern für DST-Übergangstage (23/25h-Tage).
  offset = timeZoneOffsetMs(tz, result);
  result = wallClockMidnightUtc - offset;
  return new Date(result);
}

/** Exklusives lokales Tagesende (nächste lokale Mitternacht) als UTC-Instant. */
export function endOfDayInTimeZone(date: Date, tz: string): Date {
  const p = zonedParts(date, tz);
  const nextMidnightUtc = Date.UTC(p.year, p.month - 1, p.day + 1, 0, 0, 0); // Date.UTC normalisiert Überlauf
  let offset = timeZoneOffsetMs(tz, nextMidnightUtc);
  const result = nextMidnightUtc - offset;
  offset = timeZoneOffsetMs(tz, result);
  return new Date(nextMidnightUtc - offset);
}
