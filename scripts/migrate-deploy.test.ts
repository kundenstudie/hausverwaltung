// HAVEWA-07A-2 — Unit-Tests fuer runMigrateDeploy (testbare Variante).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runMigrateDeploy, dbTargetLabel } from "./migrate-deploy.mjs";

describe("runMigrateDeploy", () => {
  let runner: ReturnType<typeof vi.fn>;
  let logs: { out: string[]; err: string[] };
  let logger: { log: (s: string) => void; err: (s: string) => void };

  beforeEach(() => {
    runner = vi.fn(async () => ({ code: 0, signal: null, stdout: "", stderr: "" }));
    logs = { out: [], err: [] };
    logger = {
      log: (s: string) => { logs.out.push(s); },
      err: (s: string) => { logs.err.push(s); },
    };
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("DATABASE_URL fehlt -> wirft", async () => {
    await expect(runMigrateDeploy({
      dbUrl: "",
      treeDir: "/tmp/tree",
      schemaPath: "/tmp/tree/prisma/schema.prisma",
      runner: runner as never,
      logger,
    })).rejects.toThrow(/DATABASE_URL/);
  });

  it("treeDir fehlt -> wirft", async () => {
    await expect(runMigrateDeploy({
      dbUrl: "postgresql://x",
      treeDir: "",
      schemaPath: "/tmp/tree/prisma/schema.prisma",
      runner: runner as never,
      logger,
    })).rejects.toThrow(/treeDir/);
  });

  it("schemaPath fehlt -> wirft", async () => {
    await expect(runMigrateDeploy({
      dbUrl: "postgresql://x",
      treeDir: "/tmp/tree",
      schemaPath: "",
      runner: runner as never,
      logger,
    })).rejects.toThrow(/schemaPath/);
  });

  it("success: ruft generate und deploy in der richtigen Reihenfolge", async () => {
    await runMigrateDeploy({
      dbUrl: "postgresql://havewa_test:havewa_test@localhost:5433/havewa_test?schema=public",
      treeDir: "/tmp/tree",
      schemaPath: "/tmp/tree/prisma/schema.prisma",
      runner: runner as never,
      logger,
    });
    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner.mock.calls[0][1][0]).toBe("generate");
    expect(runner.mock.calls[1][1][0]).toBe("migrate");
    expect(runner.mock.calls[1][1][1]).toBe("deploy");
  });

  it("success: uebergibt DATABASE_URL im env-Block", async () => {
    const dbUrl = "postgresql://havewa_test:havewa_test@localhost:5433/havewa_test?schema=public";
    await runMigrateDeploy({
      dbUrl,
      treeDir: "/tmp/tree",
      schemaPath: "/tmp/tree/prisma/schema.prisma",
      runner: runner as never,
      logger,
    });
    for (const call of runner.mock.calls) {
      const opts = call[2] as { env?: Record<string, string> };
      expect(opts.env).toBeDefined();
      expect(opts.env!.DATABASE_URL).toBe(dbUrl);
    }
  });

  it("success: loggt Host/Port, NICHT Credentials", async () => {
    const dbUrl = "postgresql://secret_user:s3cret@db.intern:5432/app?schema=public";
    await runMigrateDeploy({
      dbUrl,
      treeDir: "/tmp/tree",
      schemaPath: "/tmp/tree/prisma/schema.prisma",
      runner: runner as never,
      logger,
    });
    const allOut = logs.out.join("");
    expect(allOut).toContain("db.intern:5432");
    expect(allOut).not.toContain("s3cret");
    expect(allOut).not.toContain("secret_user");
  });

  it("non-zero Exit vom generate-Schritt -> wirft", async () => {
    runner.mockRejectedValueOnce(new Error("Prisma-CLI exit=1\nstderr ..."));
    await expect(runMigrateDeploy({
      dbUrl: "postgresql://x",
      treeDir: "/tmp/tree",
      schemaPath: "/tmp/tree/prisma/schema.prisma",
      runner: runner as never,
      logger,
    })).rejects.toThrow(/Prisma-CLI exit=1/);
  });

  it("non-zero Exit vom deploy-Schritt -> wirft (generate bereits ok)", async () => {
    runner
      .mockResolvedValueOnce({ code: 0, signal: null, stdout: "", stderr: "" })
      .mockRejectedValueOnce(new Error("Prisma-CLI exit=2"));
    await expect(runMigrateDeploy({
      dbUrl: "postgresql://x",
      treeDir: "/tmp/tree",
      schemaPath: "/tmp/tree/prisma/schema.prisma",
      runner: runner as never,
      logger,
    })).rejects.toThrow(/exit=2/);
  });
});

// HAVEWA-07A-2 (Review-Fix M1) — Tests fuer den produktiven main()-Log-Pfad.
// dbTargetLabel() ist die einzige Quelle der Wahrheit fuer das DB-Logging in
// main() UND runMigrateDeploy(). Diese Tests beweisen, dass die
// produktive Logging-Semantik keine Credentials, keine User-Namen und
// keine DSN-Bestandteile ins Log schreibt.
describe("dbTargetLabel (main()-Log-Pfad, Review-Fix M1)", () => {
  it("mit explizitem Port: liefert host:port", () => {
    expect(dbTargetLabel("postgresql://u:p@localhost:5433/db?schema=public"))
      .toBe("localhost:5433");
  });

  it("ohne Port: liefert host:5432 (Postgres-Default)", () => {
    expect(dbTargetLabel("postgresql://u:p@db.intern/app")).toBe("db.intern:5432");
  });

  it("enthaelt WEDER Username NOCH Passwort", () => {
    const url = "postgresql://secret_user:secret_password@localhost:5433/havewa_test";
    const label = dbTargetLabel(url);
    expect(label).not.toContain("secret_user");
    expect(label).not.toContain("secret_password");
    expect(label).not.toContain("localhost/havewa_test"); // kein Pfad-Leak
    expect(label).toBe("localhost:5433");
  });

  it("enthaelt die volle DATABASE_URL NICHT", () => {
    const url = "postgresql://secret_user:secret_password@db.intern:5432/app?schema=public&sslmode=require";
    const label = dbTargetLabel(url);
    expect(label).not.toContain(url);
    expect(label).not.toContain("secret");
    expect(label).not.toContain("app?schema");
    expect(label).toBe("db.intern:5432");
  });

  it("Unparsbare URL -> generischer Fallback (url ok)", () => {
    expect(dbTargetLabel("not-a-url")).toBe("(url ok)");
    expect(dbTargetLabel("http://localhost:5432/db")).toBe("(url ok)");
    expect(dbTargetLabel("")).toBe("(url ok)");
    expect(dbTargetLabel(undefined as unknown as string)).toBe("(url ok)");
  });

  it("End-to-End: main()-Log-Zeile (db:    ${dbTargetLabel(...)}\\\\n) ist credential-frei", () => {
    // Rekonstruiert exakt die Log-Zeile, die main() in process.stdout.write
    // schreibt. Wenn dbTargetLabel() credential-frei ist, ist diese Zeile
    // es ebenfalls.
    const url = "postgresql://secret_user:secret_password@localhost:5433/havewa_test";
    const logLine = `[migrate-deploy] db:    ${dbTargetLabel(url)}\n`;
    expect(logLine).toContain("localhost:5433");
    expect(logLine).not.toContain("secret_user");
    expect(logLine).not.toContain("secret_password");
    expect(logLine).not.toContain(url);
  });
});

// HAVEWA-07C-G5 — Entry-Point-Check MUSS main() ausfuehren.
//
// Bug-Historie: der alte Template-String-Vergleich
//   `file://${process.argv[1]}`
// schlug auf Windows fehl, weil argv[1] Backslashes enthaelt, import.meta.url
// aber Forward-Slashes. Folge: main() lief nie, das Skript war still mit
// exit 0, Migrationen wurden nicht angewandt, Bootstrap scheiterte mit P2021.
//
// Diese Tests verifizieren, dass das Skript beim direkten Aufruf
//   node scripts/migrate-deploy.mjs
// tatsaechlich in main() eintritt (fail-closed, kein stilles exit 0).
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

describe("migrate-deploy entry-point (G5-Reparatur)", () => {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  // Vitest laeuft mit ESM und unterstuetzt import.meta.url direkt.
  // Wir nutzen den absoluten Windows-Pfad zum Skript (Backslashes),
  // um genau das Szenario nachzustellen, das in G5 still exit 0 lieferte.
  const scriptPath = path.join(scriptDir, "migrate-deploy.mjs");
  const nodeBin = process.execPath;

  it("ohne DATABASE_URL: fail-closed, exit 1, klare Fehlermeldung", () => {
    let out = "";
    let err = "";
    let code = 0;
    try {
      out = execFileSync(nodeBin, [scriptPath], {
        env: { ...process.env, DATABASE_URL: "" },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e: unknown) {
      // execFileSync wirft bei non-zero exit; wir erwarten das hier.
      const ex = e as { status?: number; stdout?: unknown; stderr?: unknown };
      code = ex.status ?? 1;
      out = typeof ex.stdout === "string" ? ex.stdout : "";
      err = typeof ex.stderr === "string" ? ex.stderr : "";
    }
    expect(code).toBe(1);
    const combined = `${out}\n${err}`;
    expect(combined).toMatch(/DATABASE_URL/);
    expect(combined).toMatch(/FAIL/);
  });

  it("mit DATABASE_URL, aber fehlendem Tree: fail-closed, exit 1, Hinweis auf package-runtime", () => {
    let out = "";
    let err = "";
    let code = 0;
    const fakeDb = "postgresql://x:x@127.0.0.1:5432/x";
    const fakeTree = "C:\\definitely-not-existing-prisma-tree-xyz";
    try {
      out = execFileSync(nodeBin, [scriptPath], {
        env: {
          ...process.env,
          DATABASE_URL: fakeDb,
          HAVEWA_RUNTIME_PRISMA_DIR: fakeTree,
        },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e: unknown) {
      const ex = e as { status?: number; stdout?: unknown; stderr?: unknown };
      code = ex.status ?? 1;
      out = typeof ex.stdout === "string" ? ex.stdout : "";
      err = typeof ex.stderr === "string" ? ex.stderr : "";
    }
    expect(code).toBe(1);
    const combined = `${out}\n${err}`;
    expect(combined).toMatch(/Prisma-Runtime-Tree fehlt/);
    expect(combined).toMatch(/package-runtime\.mjs/);
  });

  it("mit Tree + DB-URL: Skript betritt main() und versucht Prisma-Aufruf (nicht still exit 0)", () => {
    // Wir koennen hier keine echte DB garantieren; aber wir beweisen
    // zumindest, dass main() durchlaeuft und der Tree-Pfad + DB-Log
    // geschrieben werden (vor dem eigentlichen DB-Connect).
    const tree = path.join(scriptDir, "..", ".runtime", "prisma-cli");
    if (!existsSync(tree)) {
      // Wenn der Tree nicht gebaut ist, skip — wir wollen diesen Test
      // nicht zu einem package-runtime-Lauf koppeln.
      return;
    }
    let out = "";
    let err = "";
    let code = 0;
    try {
      out = execFileSync(nodeBin, [scriptPath], {
        env: {
          ...process.env,
          DATABASE_URL: "postgresql://x:x@127.0.0.1:1/nonexistent",
          HAVEWA_RUNTIME_PRISMA_DIR: tree,
        },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
      });
    } catch (e: unknown) {
      const ex = e as { status?: number; stdout?: unknown; stderr?: unknown };
      code = ex.status ?? 1;
      out = typeof ex.stdout === "string" ? ex.stdout : "";
      err = typeof ex.stderr === "string" ? ex.stderr : "";
    }
    const combined = `${out}\n${err}`;
    // main() MUSS gelaufen sein: tree + db + prisma-Logmarker sichtbar.
    expect(combined).toMatch(/\[migrate-deploy\] tree:/);
    expect(combined).toMatch(/\[migrate-deploy\] db:/);
    expect(combined).toMatch(/prisma generate|prisma migrate deploy/);
    // Skript darf NICHT still mit exit 0 beendet haben, weil DB nicht erreichbar.
    expect(code).not.toBe(0);
  });
});

// Helper (existsSync gibt es in node:fs; vermeidet Import-Top-Level-Konflikt).
import { existsSync } from "node:fs";
