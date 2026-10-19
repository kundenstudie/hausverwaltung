// HAVEWA-07B — Unit-Tests für postgres-runtime.mjs
// (Runtime-Pfad-Resolver).
import { describe, it, expect } from "vitest";
import {
  resolvePostgresRuntime,
  __REQUIRED_TOOLS,
} from "./postgres-runtime.mjs";

describe("resolvePostgresRuntime (mit realem System-Postgres16 als Default)", () => {
  it("liefert ok-Pfad, wenn POSTGRES_RUNTIME_DIR auf existierendes PG16 zeigt", () => {
    const real = "C:\\Program Files\\PostgreSQL\\16\\bin";
    const r = resolvePostgresRuntime({ envValue: real });
    if (r.kind === "ok") {
      expect(r.paths.postgresExe.endsWith("postgres.exe")).toBe(true);
      expect(r.paths.pgCtlExe.endsWith("pg_ctl.exe")).toBe(true);
      expect(r.paths.initdbExe.endsWith("initdb.exe")).toBe(true);
    } else {
      // Falls das System kein PG16 hat, ist der Test N/A — wir akzeptieren
      // explizit das Fehlen, aber dokumentieren es.
      expect(r.kind).toBe("missing-tools");
      expect(r.missing.length).toBeGreaterThan(0);
    }
  });

  it("zeigt fehlende Tools, wenn der Pfad nicht existiert", () => {
    const r = resolvePostgresRuntime({
      envValue: "C:\\does\\not\\exist\\bin",
      fallbackDirs: ["C:\\also\\missing"],
    });
    expect(r.kind).toBe("missing-tools");
    if (r.kind === "missing-tools") {
      expect(r.missing).toEqual(__REQUIRED_TOOLS);
    }
  });

  it("zeigt fehlende Tools, wenn einzelne Tools fehlen (gemockte Lücke)", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const os = await import("node:os");
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pg-runtime-test-"));
    try {
      // Wir erstellen einen leeren Test-Pfad: kein Tool ist vorhanden.
      // (Bewusst NICHT postgres.exe kopieren — wir wollen einen sauberen
      // Mock, der garantiert kein Tool enthält.)
      const r = resolvePostgresRuntime({
        envValue: tmp,
        fallbackDirs: [],
      });
      expect(r.kind).toBe("missing-tools");
      if (r.kind === "missing-tools") {
        // Alle 6 Pflicht-Tools müssen fehlen.
        expect(r.missing).toContain("postgres");
        expect(r.missing).toContain("pg_ctl");
        expect(r.missing).toContain("initdb");
        expect(r.missing).toContain("psql");
        expect(r.missing).toContain("createdb");
        expect(r.missing).toContain("pg_isready");
      }
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("findet postgres vorhanden, aber pg_ctl/initdb/etc. fehlen", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const os = await import("node:os");
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pg-runtime-test-"));
    try {
      // Wir erstellen NUR postgres.exe — andere Tools fehlen.
      // Wir erzeugen eine leere Datei; ob sie ein gültiges Binary ist,
      // ist für diesen Test egal (existsSync reicht).
      await fs.writeFile(path.join(tmp, "postgres.exe"), "fake");
      const r = resolvePostgresRuntime({
        envValue: tmp,
        fallbackDirs: [],
      });
      expect(r.kind).toBe("missing-tools");
      if (r.kind === "missing-tools") {
        expect(r.missing).not.toContain("postgres");
        expect(r.missing).toContain("pg_ctl");
        expect(r.missing).toContain("initdb");
        expect(r.missing).toContain("psql");
        expect(r.missing).toContain("createdb");
        expect(r.missing).toContain("pg_isready");
      }
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("envValue mit Whitespace wird ignoriert (Fallback wird genutzt)", () => {
    const r = resolvePostgresRuntime({
      envValue: "   ",
      fallbackDirs: ["C:\\Program Files\\PostgreSQL\\16\\bin"],
    });
    if (r.kind === "ok") {
      expect(r.paths.runtimeDir.toLowerCase()).toContain("postgresql");
    } else {
      // System hat kein PG16 → erwartetes missing-tools
      expect(r.kind).toBe("missing-tools");
    }
  });
});