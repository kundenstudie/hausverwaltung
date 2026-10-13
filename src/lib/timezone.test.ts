import { describe, expect, it } from "vitest";
import {
  DEFAULT_TIME_ZONE,
  isValidIanaTimezone,
  startOfDayInTimeZone,
  endOfDayInTimeZone,
} from "@/lib/timezone";

const iso = (d: Date) => d.toISOString();

describe("timezone isValidIanaTimezone", () => {
  it("accepts valid IANA identifiers", () => {
    expect(isValidIanaTimezone("Europe/Berlin")).toBe(true);
    expect(isValidIanaTimezone("Europe/Vienna")).toBe(true);
    expect(isValidIanaTimezone("Europe/Zurich")).toBe(true);
    expect(isValidIanaTimezone("America/New_York")).toBe(true);
    expect(isValidIanaTimezone("UTC")).toBe(true);
  });

  it("rejects invalid identifiers and empty values", () => {
    expect(isValidIanaTimezone("Europe/Atlantis")).toBe(false);
    expect(isValidIanaTimezone("Foo/Bar")).toBe(false);
    expect(isValidIanaTimezone("")).toBe(false);
    expect(isValidIanaTimezone("Berlin")).toBe(false);
  });

  it("default is Europe/Berlin", () => {
    expect(DEFAULT_TIME_ZONE).toBe("Europe/Berlin");
  });
});

describe("timezone local day boundaries", () => {
  it("start of day in winter (CET, UTC+1)", () => {
    // 15.01.2026 mittags UTC → lokale Mitternacht = 14.01. 23:00 UTC.
    expect(iso(startOfDayInTimeZone(new Date("2026-01-15T12:00:00Z"), "Europe/Berlin"))).toBe("2026-01-14T23:00:00.000Z");
  });

  it("start of day in summer (CEST, UTC+2)", () => {
    // 15.06.2026 mittags UTC → lokale Mitternacht = 14.06. 22:00 UTC.
    expect(iso(startOfDayInTimeZone(new Date("2026-06-15T12:00:00Z"), "Europe/Berlin"))).toBe("2026-06-14T22:00:00.000Z");
  });

  it("end of day is exclusive (next local midnight)", () => {
    // Sommer: lokale Mitternacht 16.06. = 15.06. 22:00 UTC.
    expect(iso(endOfDayInTimeZone(new Date("2026-06-15T12:00:00Z"), "Europe/Berlin"))).toBe("2026-06-15T22:00:00.000Z");
  });
});

describe("timezone DST transitions (Europe/Berlin 2026)", () => {
  it("DST start (spring forward, 29.03.2026, 23h day)", () => {
    const start = startOfDayInTimeZone(new Date("2026-03-29T12:00:00Z"), "Europe/Berlin");
    expect(iso(start)).toBe("2026-03-28T23:00:00.000Z"); // CET (UTC+1)
    const end = endOfDayInTimeZone(new Date("2026-03-29T12:00:00Z"), "Europe/Berlin");
    expect(iso(end)).toBe("2026-03-29T22:00:00.000Z"); // CEST (UTC+2)
    // 23-Stunden-Tag
    expect(end.getTime() - start.getTime()).toBe(23 * 3600_000);
  });

  it("DST end (fall back, 25.10.2026, 25h day)", () => {
    const start = startOfDayInTimeZone(new Date("2026-10-25T12:00:00Z"), "Europe/Berlin");
    expect(iso(start)).toBe("2026-10-24T22:00:00.000Z"); // CEST (UTC+2)
    const end = endOfDayInTimeZone(new Date("2026-10-25T12:00:00Z"), "Europe/Berlin");
    expect(iso(end)).toBe("2026-10-25T23:00:00.000Z"); // CET (UTC+1)
    // 25-Stunden-Tag
    expect(end.getTime() - start.getTime()).toBe(25 * 3600_000);
  });

  it("no manual +1/+2 hour assumptions (offsets differ correctly)", () => {
    const winterStart = startOfDayInTimeZone(new Date("2026-01-15T12:00:00Z"), "Europe/Berlin");
    const summerStart = startOfDayInTimeZone(new Date("2026-06-15T12:00:00Z"), "Europe/Berlin");
    expect(winterStart.getTime() - summerStart.getTime()).not.toBe(0);
  });
});

describe("timezone tenant-specific boundaries", () => {
  it("tenant A (Berlin) differs from tenant B (New York)", () => {
    const instant = new Date("2026-06-15T12:00:00Z");
    const berlin = startOfDayInTimeZone(instant, "Europe/Berlin");
    const newYork = startOfDayInTimeZone(instant, "America/New_York");
    // Berlin UTC+2 (Mitternacht = 22:00 UTC Vortag), New York UTC-4 (Mitternacht
    // = 04:00 UTC desselben Tages) → unterschiedliche Instants.
    expect(berlin.getTime()).not.toBe(newYork.getTime());
    expect(newYork.getTime()).toBeGreaterThan(berlin.getTime());
  });
});
