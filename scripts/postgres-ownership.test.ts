// HAVEWA-07B — Unit-Tests für postgres-ownership.mjs
// (Ownership-Schutz + Stale-State).
import { describe, it, expect } from "vitest";
import {
  parsePostmasterPid, verifyOwnInstance,
} from "./postgres-ownership.mjs";

describe("parsePostmasterPid", () => {
  it("parst Standard-format korrekt", () => {
    const content = "12345\n/var/lib/postgresql/data\n1712345678\n5433\n";
    const r = parsePostmasterPid(content);
    expect(r).not.toBeNull();
    expect(r!.pid).toBe(12345);
    expect(r!.dataDirLine).toBe("/var/lib/postgresql/data");
    expect(r!.portLine).toBe(5433);
  });

  it("toleriert fehlenden Port", () => {
    const r = parsePostmasterPid("12345\n/var/lib/postgresql/data\n1712345678\n");
    expect(r).not.toBeNull();
    expect(r!.portLine).toBeUndefined();
  });

  it("wirft nicht bei kaputtem Inhalt", () => {
    expect(parsePostmasterPid("")).toBeNull();
    expect(parsePostmasterPid("abc")).toBeNull();
    expect(parsePostmasterPid("12345\ngarbage-port\nfoo\nbar")).not.toBeNull();
    expect(parsePostmasterPid("12345\ngarbage-port\nfoo\nbar")!.portLine).toBeUndefined();
  });
});

const baseRecord = {
  runtimeId: "test-runtime",
  pid: 12345,
  pgdata: "C:\\pg\\data",
  host: "127.0.0.1",
  port: 5433,
  startedAt: "2026-10-17T00:00:00.000Z",
  loopbackHost: "127.0.0.1",
};

describe("verifyOwnInstance", () => {
  it("own-running: alles passt", () => {
    const v = verifyOwnInstance({
      record: baseRecord,
      currentPid: 12345,
      postmasterPid: parsePostmasterPid("12345\nC:\\pg\\data\n1712345678\n5433\n"),
    });
    expect(v.kind).toBe("own-running");
  });

  it("own-stale: postmaster.pid fehlt, PID läuft nicht", () => {
    const v = verifyOwnInstance({
      record: baseRecord,
      currentPid: null,
      postmasterPid: null,
    });
    expect(v.kind).toBe("own-stale");
  });

  it("foreign-pid: postmaster.pid fehlt, aber PID läuft (fremde Instanz, Fail-Closed)", () => {
    // Sicherheits-Befund aus HAVEWA-07B-Live-Tests:
    // Wenn unsere postmaster.pid fehlt und ein PID läuft, ist das
    // eine fremde Instanz (jede Postgres-Instanz schreibt postmaster.pid
    // sofort beim Start). Wir dürfen NICHT annehmen, dass es unsere ist.
    const v = verifyOwnInstance({
      record: baseRecord,
      currentPid: baseRecord.pid, // PID läuft
      postmasterPid: null,        // aber postmaster.pid fehlt
    });
    expect(v.kind).toBe("foreign-pid");
  });

  it("own-stale: PID existiert nicht mehr", () => {
    const v = verifyOwnInstance({
      record: baseRecord,
      currentPid: null,
      postmasterPid: parsePostmasterPid("12345\nC:\\pg\\data\n1712345678\n5433\n"),
    });
    expect(v.kind).toBe("own-stale");
  });

  it("foreign-pid: postmaster.pid.pid passt nicht zur Aufzeichnung", () => {
    const v = verifyOwnInstance({
      record: baseRecord,
      currentPid: 99999,
      postmasterPid: parsePostmasterPid("99999\nC:\\pg\\data\n1712345678\n5433\n"),
    });
    expect(v.kind).toBe("foreign-pid");
  });

  it("foreign-pid: pgdata aus postmaster.pid weicht ab", () => {
    const v = verifyOwnInstance({
      record: baseRecord,
      currentPid: 12345,
      postmasterPid: parsePostmasterPid("12345\nC:\\other\\data\n1712345678\n5433\n"),
    });
    expect(v.kind).toBe("foreign-pid");
  });

  it("foreign-pid: Port weicht ab", () => {
    const v = verifyOwnInstance({
      record: baseRecord,
      currentPid: 12345,
      postmasterPid: parsePostmasterPid("12345\nC:\\pg\\data\n1712345678\n6000\n"),
    });
    expect(v.kind).toBe("foreign-pid");
  });
});