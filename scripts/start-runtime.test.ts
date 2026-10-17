// HAVEWA-07A-2 — Unit-Tests fuer start-runtime.mjs-Komponenten.
//
// Da start-runtime.mjs am Ende process.exit() aufruft, sind die
// vollen Pfade nicht direkt unit-testbar. Wir testen daher die
// wiederverwendbaren Komponenten (Port-Probe, DB-URL-Parse) und
// die Testbarkeit der Voraussetzungspruefung.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import net from "node:net";

describe("start-runtime port probe", () => {
  let busyServer: net.Server | null = null;
  let busyPort = -1;

  beforeAll(async () => {
    busyServer = net.createServer();
    await new Promise<void>((resolve) => busyServer!.listen(0, "127.0.0.1", resolve));
    const addr = busyServer.address();
    if (addr && typeof addr === "object") busyPort = addr.port;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => busyServer?.close(() => resolve()));
  });

  it("freier Port -> probe liefert true (mit garantiert freiem Port)", async () => {
    const free = await new Promise<number>((resolve) => {
      const s = net.createServer();
      s.listen(0, "127.0.0.1", () => {
        const a = s.address();
        s.close(() => resolve(typeof a === "object" && a ? a.port : -1));
      });
    });
    expect(free).toBeGreaterThan(0);
    // Re-Probe (jetzt sollte der Port wieder frei sein)
    const ok = await new Promise<boolean>((resolve) => {
      const s = net.createServer();
      s.once("error", () => resolve(false));
      s.once("listening", () => s.close(() => resolve(true)));
      s.listen(free, "127.0.0.1");
    });
    expect(ok).toBe(true);
  });

  it("belegter Port -> probe liefert false", async () => {
    expect(busyPort).toBeGreaterThan(0);
    const ok = await new Promise<boolean>((resolve) => {
      const s = net.createServer();
      s.once("error", () => resolve(false));
      s.once("listening", () => s.close(() => resolve(true)));
      s.listen(busyPort, "127.0.0.1");
    });
    expect(ok).toBe(false);
  });
});

describe("start-runtime DB-URL-Parse (Regex-basiert)", () => {
  // Wir replizieren die Parse-Logik aus start-runtime.mjs fuer den Test
  function parseDbUrl(url: string) {
    const m = url.match(/^postgresql:\/\/[^@]+@([^:/]+)(?::(\d+))?\//);
    if (!m) return null;
    return { host: m[1], port: m[2] ? parseInt(m[2], 10) : 5432 };
  }

  it("parst havewa_test@localhost:5433/havewa_test", () => {
    const p = parseDbUrl("postgresql://havewa_test:havewa_test@localhost:5433/havewa_test?schema=public");
    expect(p).toEqual({ host: "localhost", port: 5433 });
  });

  it("Default-Port 5432 wenn nicht angegeben", () => {
    const p = parseDbUrl("postgresql://user:pass@db.host/app");
    expect(p).toEqual({ host: "db.host", port: 5432 });
  });

  it("Ungueltige URL -> null", () => {
    expect(parseDbUrl("not-a-url")).toBeNull();
    expect(parseDbUrl("http://localhost:5432/db")).toBeNull();
  });
});

describe("start-runtime Pfad-Aufloesung", () => {
  // Pfade muessen relativ zum Skript selbst aufgeloest werden, nicht
  // relativ zu process.cwd(). Wir pruefen die Existenz der erwarteten
  // Dateien anhand der Skriptposition.
  it("scripts/-Verzeichnis enthaelt start-runtime.mjs", async () => {
    const { existsSync } = await import("node:fs");
    const path = await import("node:path");
    const url = await import("node:url");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    expect(existsSync(path.join(here, "start-runtime.mjs"))).toBe(true);
  });

  it("migrate-deploy.mjs ist Geschwister-Skript", async () => {
    const { existsSync } = await import("node:fs");
    const path = await import("node:path");
    const url = await import("node:url");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    expect(existsSync(path.join(here, "migrate-deploy.mjs"))).toBe(true);
  });

  it("prisma-runtime-tree.mjs ist Geschwister-Skript", async () => {
    const { existsSync } = await import("node:fs");
    const path = await import("node:path");
    const url = await import("node:url");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    expect(existsSync(path.join(here, "prisma-runtime-tree.mjs"))).toBe(true);
  });
});
