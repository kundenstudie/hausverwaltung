// HAVEWA-07B — Type-Deklarationen für start-runtime-with-pg.mjs (FIX M-3).

import type { PostgresRuntimePaths } from "./postgres-runtime.d.mts";
import type { PostgresDirs } from "./postgres-paths.d.mts";

export type AcquireVerdict =
  | { kind: "reuse"; host: string; port: number; record: { runtimeId: string; pid: number; pgdata: string; host: string; port: number; startedAt: string; loopbackHost: string } }
  | { kind: "started"; host: string; port: number; record: { runtimeId: string; pid: number; pgdata: string; host: string; port: number; startedAt: string; loopbackHost: string } }
  | { kind: "abort"; reason: string; verdict?: { kind: string; reason?: string } };

/**
 * FIX M-3: Testbarer Orchestrator-Kern. Alle Seiteneffekte sind
 * injizierbar (readState, verifyOwn, pickPort, writeConfig, startPostgres, ...).
 */
export declare function acquirePostgres(input: {
  paths: PostgresRuntimePaths;
  dirs: PostgresDirs;
  dbPassword: string;
  logger?: { info: (m: string) => void; warn: (m: string) => void; err: (m: string) => void };
  _readState?: (runtimeStateDir: string) => unknown;
  _removeState?: (runtimeStateDir: string) => Promise<void>;
  _verifyOwn?: (input: { pgdata: string; record: unknown; isPidRunning: (pid: number) => boolean }) => { kind: string; reason?: string; runtimeId?: string };
  _isPidRunning?: (pid: number) => boolean;
  _readDbPort?: (runtimeStateDir: string) => { host: string; port: number } | null;
  _writeDbPort?: (runtimeStateDir: string, rec: unknown) => Promise<void>;
  _pickDbPort?: (opts: { host?: string; candidates?: number[] }) => Promise<{ kind: string; host?: string; port?: number; tried?: number[] }>;
  _writeConfig?: (input: { pgdata: string; port: number }) => Promise<void>;
  _runInitDb?: (input: unknown) => Promise<unknown>;
  _startPostgres?: (input: unknown) => Promise<{ pid: number; record: unknown }>;
  _probePortFree?: (input: { host: string; port: number }) => Promise<boolean>;
  _unlinkPostmasterPid?: () => Promise<void>;
}): Promise<AcquireVerdict>;
