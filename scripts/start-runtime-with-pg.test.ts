// HAVEWA-07B (FIX M-3) — Unit-Tests für acquirePostgres (Orchestrator-Flow).
//
// Beweist die korrigierte Reihenfolge:
//   A) own-running   -> reuse, KEIN port-pick, KEIN config-write, KEIN start
//   B) own-stale     -> cleanup, danach fresh
//   C) foreign-pid   -> abort (fail-closed), NICHTS wird gestartet/gestoppt
//   D) no-state + postmaster.pid -> abort (fail-closed)
//   E) fresh path    -> initdb (wenn nötig) + port-pick + config + start
//
// Wir injizieren ALLE Seiteneffekte (readState, verifyOwn, pickPort, ...)
// und beobachten, welche aufgerufen werden.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { acquirePostgres } from "./start-runtime-with-pg.mjs";

const PATHS = {
  runtimeDir: "C:\\fake",
  postgresExe: "C:\\fake\\postgres.exe",
  pgCtlExe: "C:\\fake\\pg_ctl.exe",
  initdbExe: "C:\\fake\\initdb.exe",
  psqlExe: "C:\\fake\\psql.exe",
  createdbExe: "C:\\fake\\createdb.exe",
  pgIsreadyExe: "C:\\fake\\pg_isready.exe",
};

const DIRS = (root: string) => ({
  dataDir: root,
  pgdata: path.join(root, "pgdata"),
  logsDir: path.join(root, "logs"),
  runtimeStateDir: path.join(root, "runtime-state"),
});

function makeRecord({ pid = 12345, port = 5433, host = "127.0.0.1" } = {}) {
  return {
    runtimeId: "test-runtime-id",
    pid,
    pgdata: "PLACEHOLDER", // wird im Test überschrieben
    host,
    port,
    startedAt: "2026-10-17T00:00:00.000Z",
    loopbackHost: "127.0.0.1",
  };
}

const silentLogger = { info: () => {}, warn: () => {}, err: () => {} };

describe("acquirePostgres (FIX M-3)", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pg-acquire-"));
    await fs.mkdir(DIRS(tmp).pgdata, { recursive: true });
    await fs.mkdir(DIRS(tmp).logsDir, { recursive: true });
    await fs.mkdir(DIRS(tmp).runtimeStateDir, { recursive: true });
  });
  afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

  // ============== A) own-running -> reuse ==============
  describe("own-running (FIX M-3 §9.A)", () => {
    it("5433: reuse ohne port-pick, config-write, start", async () => {
      const rec = makeRecord({ port: 5433 });
      rec.pgdata = DIRS(tmp).pgdata;

      const calls = { pickDbPort: 0, writeConfig: 0, startPostgres: 0, runInitDb: 0, unlinkPostmasterPid: 0 };
      const r = await acquirePostgres({
        paths: PATHS,
        dirs: DIRS(tmp),
        dbPassword: "pw",
        logger: silentLogger,
        _readState: () => ({ schemaVersion: 1, record: rec }),
        _verifyOwn: () => ({ kind: "own-running", runtimeId: rec.runtimeId }),
        _isPidRunning: () => true,
        _pickDbPort: async () => { calls.pickDbPort++; return { kind: "ok", host: "127.0.0.1", port: 5434 }; },
        _writeConfig: async () => { calls.writeConfig++; },
        _startPostgres: async () => { calls.startPostgres++; return { pid: 99, record: rec }; },
        _runInitDb: async () => { calls.runInitDb++; },
        _unlinkPostmasterPid: async () => { calls.unlinkPostmasterPid++; },
        _readDbPort: () => null,
      });

      expect(r.kind).toBe("reuse");
      if (r.kind !== "reuse") throw new Error("expected reuse");
      expect(r.host).toBe("127.0.0.1");
      expect(r.port).toBe(5433);
      expect(calls.pickDbPort).toBe(0);
      expect(calls.writeConfig).toBe(0);
      expect(calls.startPostgres).toBe(0);
      expect(calls.runInitDb).toBe(0);
      expect(calls.unlinkPostmasterPid).toBe(0);
    });

    it("5434: reuse ohne port-pick, config-write, start", async () => {
      const rec = makeRecord({ port: 5434 });
      rec.pgdata = DIRS(tmp).pgdata;

      const calls = { pickDbPort: 0, writeConfig: 0, startPostgres: 0 };
      const r = await acquirePostgres({
        paths: PATHS,
        dirs: DIRS(tmp),
        dbPassword: "pw",
        logger: silentLogger,
        _readState: () => ({ schemaVersion: 1, record: rec }),
        _verifyOwn: () => ({ kind: "own-running", runtimeId: rec.runtimeId }),
        _isPidRunning: () => true,
        _pickDbPort: async () => { calls.pickDbPort++; return { kind: "ok", host: "127.0.0.1", port: 5433 }; },
        _writeConfig: async () => { calls.writeConfig++; },
        _startPostgres: async () => { calls.startPostgres++; return { pid: 99, record: rec }; },
      });

      expect(r.kind).toBe("reuse");
      if (r.kind !== "reuse") throw new Error("expected reuse");
      expect(r.port).toBe(5434);
      expect(calls.pickDbPort).toBe(0);
      expect(calls.writeConfig).toBe(0);
      expect(calls.startPostgres).toBe(0);
    });
  });

  // ============== B) own-stale -> cleanup -> fresh ==============
  describe("own-stale (FIX M-3 §9.C)", () => {
    it("cleanup von postmaster.pid + state, dann fresh start auf gewähltem Port", async () => {
      const rec = makeRecord({ port: 5433 });
      rec.pgdata = DIRS(tmp).pgdata;
      // postmaster.pid anlegen (simuliert stale Marker unserer Instanz)
      await fs.writeFile(path.join(DIRS(tmp).pgdata, "postmaster.pid"), "9999\n", "utf8");
      // runtime-state.json anlegen
      await fs.writeFile(
        path.join(DIRS(tmp).runtimeStateDir, "postgres-runtime.json"),
        JSON.stringify({ schemaVersion: 1, record: rec }),
        "utf8",
      );

      const calls = { unlinkPostmasterPid: 0, removeState: 0, runInitDb: 0, pickDbPort: 0, writeConfig: 0, startPostgres: 0 };
      const r = await acquirePostgres({
        paths: PATHS,
        dirs: DIRS(tmp),
        dbPassword: "pw",
        logger: silentLogger,
        _readState: () => ({ schemaVersion: 1, record: rec }),
        _verifyOwn: () => ({ kind: "own-stale", reason: "PID weg" }),
        _isPidRunning: () => false,
        _unlinkPostmasterPid: async () => { calls.unlinkPostmasterPid++; },
        _removeState: async () => { calls.removeState++; },
        _runInitDb: async () => { calls.runInitDb++; },
        _pickDbPort: async () => { calls.pickDbPort++; return { kind: "ok", host: "127.0.0.1", port: 5433 }; },
        _writeConfig: async () => { calls.writeConfig++; },
        _startPostgres: async () => {
          calls.startPostgres++;
          return { pid: 777, record: { ...rec, port: 5433, pid: 777 } };
        },
        _readDbPort: () => null,
      });

      expect(r.kind).toBe("started");
      if (r.kind !== "started") throw new Error("expected started");
      expect(r.port).toBe(5433);
      expect(calls.unlinkPostmasterPid).toBe(1);
      expect(calls.removeState).toBe(1);
      expect(calls.runInitDb).toBe(1); // first-run path (PG_VERSION fehlt)
      expect(calls.pickDbPort).toBe(1);
      expect(calls.writeConfig).toBe(1);
      expect(calls.startPostgres).toBe(1);
    });
  });

  // ============== C) foreign-pid -> abort (fail-closed) ==============
  describe("foreign-pid (FIX M-3 §9.D)", () => {
    it("hard abort: KEIN start, KEIN stop, KEIN config-write, KEIN kill", async () => {
      const rec = makeRecord({ port: 5433 });
      rec.pgdata = DIRS(tmp).pgdata;

      const calls = { pickDbPort: 0, writeConfig: 0, startPostgres: 0, runInitDb: 0, unlinkPostmasterPid: 0, removeState: 0 };
      const r = await acquirePostgres({
        paths: PATHS,
        dirs: DIRS(tmp),
        dbPassword: "pw",
        logger: silentLogger,
        _readState: () => ({ schemaVersion: 1, record: rec }),
        _verifyOwn: () => ({ kind: "foreign-pid", reason: "fremd" }),
        _isPidRunning: () => true,
        _pickDbPort: async () => { calls.pickDbPort++; return { kind: "ok", host: "127.0.0.1", port: 5433 }; },
        _writeConfig: async () => { calls.writeConfig++; },
        _startPostgres: async () => { calls.startPostgres++; return { pid: 1, record: rec }; },
        _runInitDb: async () => { calls.runInitDb++; },
        _unlinkPostmasterPid: async () => { calls.unlinkPostmasterPid++; },
        _removeState: async () => { calls.removeState++; },
      });

      expect(r.kind).toBe("abort");
      if (r.kind !== "abort") throw new Error("expected abort");
      expect(r.reason).toBe("foreign-pid");
      // KEINE Seiteneffekte auf das fremde pgdata / keine Starts / keine Stops
      expect(calls.pickDbPort).toBe(0);
      expect(calls.writeConfig).toBe(0);
      expect(calls.startPostgres).toBe(0);
      expect(calls.runInitDb).toBe(0);
      expect(calls.unlinkPostmasterPid).toBe(0);
      expect(calls.removeState).toBe(0);
    });
  });

  // ============== D) no-state + postmaster.pid in pgdata -> abort ==============
  describe("no-state + postmaster.pid (FIX M-3 unklarer Fall)", () => {
    it("fail-closed: keine Aktion, abort", async () => {
      // pgdata existiert, postmaster.pid liegt drin, aber KEIN runtime-state
      await fs.writeFile(path.join(DIRS(tmp).pgdata, "postmaster.pid"), "9999\n", "utf8");

      const calls = { pickDbPort: 0, writeConfig: 0, startPostgres: 0, runInitDb: 0 };
      const r = await acquirePostgres({
        paths: PATHS,
        dirs: DIRS(tmp),
        dbPassword: "pw",
        logger: silentLogger,
        _readState: () => null,
        _pickDbPort: async () => { calls.pickDbPort++; return { kind: "ok", host: "127.0.0.1", port: 5433 }; },
        _writeConfig: async () => { calls.writeConfig++; },
        _startPostgres: async () => { calls.startPostgres++; return { pid: 1, record: makeRecord() }; },
        _runInitDb: async () => { calls.runInitDb++; },
      });

      expect(r.kind).toBe("abort");
      expect(calls.pickDbPort).toBe(0);
      expect(calls.writeConfig).toBe(0);
      expect(calls.startPostgres).toBe(0);
      expect(calls.runInitDb).toBe(0);
    });
  });

  // ============== E) fresh path ==============
  describe("fresh path (kein State, keine postmaster.pid)", () => {
    it("initdb (first-run) + port-pick + config + start", async () => {
      const calls = { runInitDb: 0, pickDbPort: 0, writeConfig: 0, startPostgres: 0 };
      const r = await acquirePostgres({
        paths: PATHS,
        dirs: DIRS(tmp),
        dbPassword: "pw",
        logger: silentLogger,
        _readState: () => null,
        _runInitDb: async (opts) => {
          calls.runInitDb++;
          const o = opts as { logsDir: string; pgdata: string };
          // FIX M-2: runInitDb erhält logsDir
          expect(o.logsDir).toBe(DIRS(tmp).logsDir);
          // pgdata-Ordner anlegen + PG_VERSION simulieren, damit isFirstRun false wird
          await fs.writeFile(path.join(o.pgdata, "PG_VERSION"), "16\n", "utf8");
        },
        _pickDbPort: async () => { calls.pickDbPort++; return { kind: "ok", host: "127.0.0.1", port: 5433 }; },
        _writeConfig: async (opts) => {
          calls.writeConfig++;
          const o = opts as { port: number };
          expect(o.port).toBe(5433);
        },
        _startPostgres: async (opts) => {
          calls.startPostgres++;
          const o = opts as { port: number };
          return { pid: 555, record: makeRecord({ port: o.port, pid: 555 }) };
        },
        _readDbPort: () => null,
      });

      expect(r.kind).toBe("started");
      if (r.kind !== "started") throw new Error("expected started");
      expect(r.port).toBe(5433);
      expect(calls.runInitDb).toBe(1);
      expect(calls.pickDbPort).toBe(1);
      expect(calls.writeConfig).toBe(1);
      expect(calls.startPostgres).toBe(1);
    });
  });
});
