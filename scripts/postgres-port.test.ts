// HAVEWA-07B — Unit-Tests für postgres-port.mjs.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  pickDbPort, writeDbPortRecord, readDbPortRecord,
  __DEFAULT_CANDIDATES,
} from "./postgres-port.mjs";
import { PG_LOOPBACK_HOST } from "./postgres-paths.mjs";

describe("__DEFAULT_CANDIDATES", () => {
  it("ist exakt [5433, 5434]", () => {
    expect(__DEFAULT_CANDIDATES).toEqual([5433, 5434]);
  });
});

describe("pickDbPort", () => {
  it("liefert den ersten freien Port (Probe injiziert)", async () => {
    const probe = async ({ port }: { port: number }) => port === 5434;
    const r = await pickDbPort({}, probe);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.host).toBe(PG_LOOPBACK_HOST);
      expect(r.port).toBe(5434);
    }
  });

  it("exhausted, wenn alle Kandidaten belegt sind", async () => {
    const probe = async () => false;
    const r = await pickDbPort({}, probe);
    expect(r.kind).toBe("exhausted");
    if (r.kind === "exhausted") {
      expect(r.tried).toEqual([5433, 5434]);
    }
  });

  it("verwendet benutzerdefinierte Kandidaten, wenn angegeben", async () => {
    const probe = async ({ port }: { port: number }) => port === 6000;
    const r = await pickDbPort({ candidates: [6000, 6001] }, probe);
    if (r.kind === "ok") expect(r.port).toBe(6000);
    else throw new Error("unexpected exhausted");
  });

  it("Default-Probe erkennt ECONNREFUSED als 'frei'", async () => {
    // Wir können ECONNREFUSED nicht direkt auslösen, aber wir können
    // einen garantiert unbelegten Port prüfen. Auf Windows kann ein
    // zufälliger Port 0 ein freier sein — wir suchen einen freien und
    // nutzen ihn als "freier Kandidat".
    const net = await import("node:net");
    const free = await new Promise<number>((resolve) => {
      const s = net.createServer();
      s.listen(0, PG_LOOPBACK_HOST, () => {
        const a = s.address();
        s.close(() => resolve(typeof a === "object" && a ? a.port : -1));
      });
    });
    expect(free).toBeGreaterThan(0);
    const { defaultProbe } = await import("./postgres-port.mjs");
    const r = await defaultProbe({ host: PG_LOOPBACK_HOST, port: free });
    expect(r).toBe(true);
  });
});

describe("writeDbPortRecord / readDbPortRecord", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pg-port-"));
  });
  afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

  it("schreibt und liest korrekt", async () => {
    const rec = { host: PG_LOOPBACK_HOST, port: 5433, selectedAt: "2026-10-17T00:00:00.000Z", tried: [5433, 5434] };
    await writeDbPortRecord(tmp, rec);
    const back = readDbPortRecord(tmp);
    expect(back).toEqual(rec);
  });

  it("liefert null bei fehlendem Verzeichnis", () => {
    expect(readDbPortRecord(path.join(tmp, "missing"))).toBeNull();
  });

  it("ignoriert kaputten JSON-Inhalt", async () => {
    const file = path.join(tmp, "db-port.json");
    await fs.writeFile(file, "not-json", "utf8");
    expect(readDbPortRecord(tmp)).toBeNull();
  });

  it("ignoriert Records ohne Pflichtfelder", async () => {
    const file = path.join(tmp, "db-port.json");
    await fs.writeFile(file, JSON.stringify({ host: "127.0.0.1" }), "utf8");
    expect(readDbPortRecord(tmp)).toBeNull();
  });
});