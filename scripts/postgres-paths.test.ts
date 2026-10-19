// HAVEWA-07B — Unit-Tests für postgres-paths.mjs.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  resolvePostgresDirs, isFirstRun, PG_LOOPBACK_HOST,
} from "./postgres-paths.mjs";

describe("PG_LOOPBACK_HOST", () => {
  it("ist 127.0.0.1 (strikt loopback)", () => {
    expect(PG_LOOPBACK_HOST).toBe("127.0.0.1");
  });
});

describe("resolvePostgresDirs", () => {
  let savedEnv: string | undefined;

  beforeEach(() => { savedEnv = process.env.HAVEWA_DATA_DIR; });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.HAVEWA_DATA_DIR;
    else process.env.HAVEWA_DATA_DIR = savedEnv;
  });

  it("liefert HAVEWA_DATA_DIR-basiertes Layout", () => {
    process.env.HAVEWA_DATA_DIR = "C:\\fake\\root";
    const d = resolvePostgresDirs();
    expect(d.dataDir).toBe("C:\\fake\\root");
    expect(d.pgdata.endsWith("pgdata")).toBe(true);
    expect(d.logsDir.endsWith("logs")).toBe(true);
    expect(d.runtimeStateDir.endsWith("runtime-state")).toBe(true);
  });

  it("override gewinnt über Env", () => {
    process.env.HAVEWA_DATA_DIR = "C:\\env";
    const d = resolvePostgresDirs({ dataDirOverride: "C:\\override" });
    expect(d.dataDir).toBe("C:\\override");
  });

  it("Whitespace-Env wird wie nicht gesetzt behandelt", () => {
    process.env.HAVEWA_DATA_DIR = "   ";
    const d = resolvePostgresDirs();
    // Fallback auf process.cwd()
    expect(d.dataDir.length).toBeGreaterThan(0);
  });
});

describe("isFirstRun", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pg-paths-"));
  });
  afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

  it("pgdata existiert nicht → first run", () => {
    const dirs = { dataDir: tmp, pgdata: path.join(tmp, "pgdata"), logsDir: path.join(tmp, "logs"), runtimeStateDir: path.join(tmp, "runtime-state") };
    expect(isFirstRun({ dirs })).toBe(true);
  });

  it("pgdata existiert, PG_VERSION fehlt → first run", async () => {
    const pg = path.join(tmp, "pgdata");
    await fs.mkdir(pg, { recursive: true });
    const dirs = { dataDir: tmp, pgdata: pg, logsDir: path.join(tmp, "logs"), runtimeStateDir: path.join(tmp, "runtime-state") };
    expect(isFirstRun({ dirs })).toBe(true);
  });

  it("pgdata + PG_VERSION → kein first run", async () => {
    const pg = path.join(tmp, "pgdata");
    await fs.mkdir(pg, { recursive: true });
    await fs.writeFile(path.join(pg, "PG_VERSION"), "16\n", "utf8");
    const dirs = { dataDir: tmp, pgdata: pg, logsDir: path.join(tmp, "logs"), runtimeStateDir: path.join(tmp, "runtime-state") };
    expect(isFirstRun({ dirs })).toBe(false);
  });
});