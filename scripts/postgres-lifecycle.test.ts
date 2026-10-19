// HAVEWA-07B — Unit-Tests für postgres-lifecycle.mjs.
//
// Wir testen NICHT den echten pg_ctl-Spawn (würde eine laufende
// PG-Instanz brauchen — Auftrag §18 verbietet das für Unit-Tests).
// Stattdessen testen wir die Helfer:
//   - writeMinimalConfig (postgresql.conf + pg_hba.conf sind loopback-only)
//   - Verhalten bei ungültigen Eingaben (Fehler-Pfade)
//
// Die echte Live-Verifikation (initdb + start + stop gegen PG16)
// erfolgt separat und gegen 5434, dokumentiert im Abschluss-Report.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  runInitDb, startPostgres, waitForReady, stopPostgres, writePostgresConfig,
} from "./postgres-lifecycle.mjs";

const PATHS = {
  runtimeDir: "C:\\fake",
  postgresExe: "C:\\fake\\postgres.exe",
  pgCtlExe: "C:\\fake\\pg_ctl.exe",
  initdbExe: "C:\\fake\\initdb.exe",
  psqlExe: "C:\\fake\\psql.exe",
  createdbExe: "C:\\fake\\createdb.exe",
  pgIsreadyExe: "C:\\fake\\pg_isready.exe",
};

describe("writePostgresConfig (loopback-only, SCRAM)", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pg-lifecycle-"));
  });
  afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

  it("schreibt postgresql.conf mit listen_addresses=127.0.0.1", async () => {
    const pgdata = path.join(tmp, "pgdata");
    await fs.mkdir(pgdata, { recursive: true });
    await writePostgresConfig({ pgdata, port: 5433 });
    const conf = await fs.readFile(path.join(pgdata, "postgresql.conf"), "utf8");
    expect(conf).toContain("listen_addresses = '127.0.0.1'");
    expect(conf).toContain("port = 5433");
    expect(conf).not.toContain("0.0.0.0");
  });

  it("schreibt pg_hba.conf mit scram-sha-256 für loopback", async () => {
    const pgdata = path.join(tmp, "pgdata");
    await fs.mkdir(pgdata, { recursive: true });
    await writePostgresConfig({ pgdata, port: 5433 });
    const hba = await fs.readFile(path.join(pgdata, "pg_hba.conf"), "utf8");
    expect(hba).toContain("127.0.0.1/32");
    expect(hba).toContain("::1/128");
    expect(hba).toContain("scram-sha-256");
    expect(hba).not.toContain("trust");
  });
});

describe("runInitDb (Eingabe-Validierung)", () => {
  it("wirft bei fehlenden paths.initdbExe", async () => {
    await expect(runInitDb({
      paths: { ...PATHS, initdbExe: "" },
      pgdata: "C:\\x", logsDir: "C:\\x\\logs", dbPassword: "p",
    } as never)).rejects.toThrow(/initdbExe/);
  });

  it("wirft bei fehlendem pgdata", async () => {
    await expect(runInitDb({
      paths: PATHS,
      pgdata: "", logsDir: "C:\\x\\logs", dbPassword: "p",
    } as never)).rejects.toThrow(/pgdata/);
  });

  it("wirft bei fehlendem logsDir (FIX M-2)", async () => {
    await expect(runInitDb({
      paths: PATHS,
      pgdata: "C:\\x", dbPassword: "p",
    } as never)).rejects.toThrow(/logsDir/);
  });

  it("wirft bei leerem dbPassword", async () => {
    await expect(runInitDb({
      paths: PATHS,
      pgdata: "C:\\x", logsDir: "C:\\x\\logs", dbPassword: "",
    } as never)).rejects.toThrow(/dbPassword/);
  });
});

describe("runInitDb (FIX M-2: Log-Pfad unter logsDir, NICHT parent)", () => {
  it("initdb-Log landet unter logsDir, nicht unter parent", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pg-m2-init-"));
    try {
      const pgdata = path.join(tmp, "pgdata");
      await fs.mkdir(pgdata, { recursive: true });
      const logsDir = path.join(tmp, "logs");

      let captured: { logFile: string; exe: string; args: readonly string[]; env?: NodeJS.ProcessEnv; timeoutMs?: number; logger?: unknown } | null = null;
      const fakeRunCommand = async (opts: { logFile: string; exe: string; args: readonly string[]; env?: NodeJS.ProcessEnv; timeoutMs?: number; logger?: unknown }) => {
        captured = opts;
        return { code: 0, signal: null, stdout: "", stderr: "" };
      };

      await runInitDb({
        paths: { ...PATHS, initdbExe: "C:\\fake\\initdb.exe" },
        pgdata,
        logsDir,
        dbPassword: "secret-m2",
        dbUser: "havewa",
        _runCommand: fakeRunCommand as unknown as (opts: unknown) => Promise<unknown>,
        logger: { info: () => {}, warn: () => {}, err: () => {} },
      });

      expect(captured).not.toBeNull();
      // Log-Pfad MUSS exakt logsDir + "pg-initdb.log" sein.
      expect(captured!.logFile).toBe(path.join(logsDir, "pg-initdb.log"));
      // FIX M-2: der Log-Pfad liegt DIREKT unter logsDir (kein Off-by-One
      // in den Parent-Dir, der bei path.join(dirname(pgdata), "..", "logs")
      // entstehen würde).
      expect(path.dirname(captured!.logFile)).toBe(logsDir);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("startPostgres (Eingabe-Validierung)", () => {
  it("wirft bei fehlenden paths.pgCtlExe", async () => {
    await expect(startPostgres({
      paths: { ...PATHS, pgCtlExe: "" },
      dirs: { dataDir: "C:\\x", pgdata: "C:\\x\\pgdata", logsDir: "C:\\x\\logs", runtimeStateDir: "C:\\x\\runtime-state" },
      host: "127.0.0.1", port: 5433, dbPassword: "p",
    } as never)).rejects.toThrow(/pgCtlExe/);
  });

  it("wirft bei fehlendem host/port", async () => {
    await expect(startPostgres({
      paths: PATHS,
      dirs: { dataDir: "C:\\x", pgdata: "C:\\x\\pgdata", logsDir: "C:\\x\\logs", runtimeStateDir: "C:\\x\\runtime-state" },
      host: "", port: 5433, dbPassword: "p",
    } as never)).rejects.toThrow(/host\/port/);
  });
});

describe("waitForReady (Eingabe-Validierung)", () => {
  it("wirft bei fehlenden paths.pgIsreadyExe", async () => {
    await expect(waitForReady({
      paths: { ...PATHS, pgIsreadyExe: "" },
      host: "127.0.0.1", port: 5433,
    } as never)).rejects.toThrow(/pgIsreadyExe/);
  });
});

describe("stopPostgres (Eingabe-Validierung)", () => {
  it("wirft bei fehlendem logsDir (FIX M-2)", async () => {
    await expect(stopPostgres({
      paths: PATHS, pgdata: "C:\\x", mode: "fast",
    } as never)).rejects.toThrow(/logsDir/);
  });

  it("wirft bei ungültigem mode", async () => {
    await expect(stopPostgres({
      paths: PATHS, pgdata: "C:\\x", logsDir: "C:\\x\\logs", mode: "wipe" as never,
    } as never)).rejects.toThrow(/mode/);
  });
});

describe("stopPostgres (FIX M-2: Log-Pfad unter logsDir)", () => {
  it("stop-Log landet unter logsDir, nicht unter parent", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pg-m2-stop-"));
    try {
      const pgdata = path.join(tmp, "pgdata");
      await fs.mkdir(pgdata, { recursive: true });
      // postmaster.pid anlegen, damit stopPostgres nicht "already-stopped" returnt.
      await fs.writeFile(path.join(pgdata, "postmaster.pid"), "9999\n", "utf8");
      const logsDir = path.join(tmp, "logs");

      let captured: { logFile: string; exe: string; args: readonly string[]; env?: NodeJS.ProcessEnv; timeoutMs?: number; logger?: unknown } | null = null;
      const fakeRunCommand = async (opts: { logFile: string; exe: string; args: readonly string[]; env?: NodeJS.ProcessEnv; timeoutMs?: number; logger?: unknown }) => {
        captured = opts;
        return { code: 0, signal: null, stdout: "", stderr: "" };
      };

      const r = await stopPostgres({
        paths: { ...PATHS, pgCtlExe: "C:\\fake\\pg_ctl.exe" },
        pgdata,
        logsDir,
        mode: "fast",
        _runCommand: fakeRunCommand as unknown as (opts: unknown) => Promise<unknown>,
        logger: { info: () => {}, warn: () => {}, err: () => {} },
      });

      expect(r.kind).toBe("stopped");
      expect(captured).not.toBeNull();
      expect(captured!.logFile).toBe(path.join(logsDir, "pg-stop.log"));
      // FIX M-2: Log liegt direkt unter logsDir, nicht in einem
      // Off-by-One-Verzeichnis.
      expect(path.dirname(captured!.logFile)).toBe(logsDir);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});