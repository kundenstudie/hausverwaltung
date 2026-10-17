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
