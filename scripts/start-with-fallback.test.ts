// HAVEWA-07A-2 — Unit-Tests fuer die Port-Fallback-Probe (ohne Server-Start).
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import net from "node:net";
// .mjs-Datei: kein TypeScript-Resolve noetig, Import geht ueber Vitest-Loader.
// Allerdings brauchen wir eine Type-Declaration, damit tsc nicht meckert.
import { probe, HOST, PORTS } from "./start-with-fallback.mjs";

describe("start-with-fallback probe()", () => {
  let busyServer: net.Server | null = null;
  let busyPort = -1;

  beforeAll(async () => {
    busyServer = net.createServer();
    await new Promise<void>((resolve) => busyServer!.listen(0, HOST, resolve));
    const addr = busyServer.address();
    if (addr && typeof addr === "object") busyPort = addr.port;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => busyServer?.close(() => resolve()));
  });

  it("HOST ist 127.0.0.1 (kein 0.0.0.0-Binding)", () => {
    expect(HOST).toBe("127.0.0.1");
  });

  it("PORTS enthaelt 3000..3005 in aufsteigender Reihenfolge", () => {
    expect(PORTS).toEqual([3000, 3001, 3002, 3003, 3004, 3005]);
  });

  it("probe() auf einem freien Port liefert true", async () => {
    // Sicher freien Port ausserhalb unserer Busy-Range finden
    const free = await new Promise<number>((resolve) => {
      const s = net.createServer();
      s.listen(0, HOST, () => {
        const a = s.address();
        s.close(() => resolve(typeof a === "object" && a ? a.port : -1));
      });
    });
    expect(free).toBeGreaterThan(0);
    expect(await probe(free)).toBe(true);
  });

  it("probe() auf einem belegten Port liefert false", async () => {
    expect(busyPort).toBeGreaterThan(0);
    expect(await probe(busyPort)).toBe(false);
  });
});
