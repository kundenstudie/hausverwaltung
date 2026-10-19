// HAVEWA-07B — Type-Deklarationen für postgres-lifecycle.mjs.

import type { PostgresRuntimePaths } from "./postgres-runtime.d.mts";
import type { PostgresDirs } from "./postgres-paths.d.mts";

export type StartPostgresInput = {
  paths: PostgresRuntimePaths;
  dirs: PostgresDirs;
  /** Gewählter Host (immer 127.0.0.1). */
  host: string;
  /** Gewählter Port. */
  port: number;
  /** DB-Passwort für den Bootstrap-User "havewa" (wird NIE geloggt). */
  dbPassword: string;
  /** Timeout für den pg_ctl start-Aufruf. */
  startTimeoutMs?: number;
  /** DB-Username (Default: "havewa"). */
  dbUser?: string;
  /** DB-Name (Default: "havewa"). */
  dbName?: string;
  /** logger; default still. */
  logger?: { info: (m: string) => void; warn: (m: string) => void; err: (m: string) => void };
};

export type StartPostgresResult = {
  pid: number;
  record: {
    runtimeId: string;
    pid: number;
    pgdata: string;
    host: string;
    port: number;
    startedAt: string;
    loopbackHost: string;
  };
};

export type WaitReadyOptions = {
  paths: PostgresRuntimePaths;
  host: string;
  port: number;
  /** Default: 30_000 ms. */
  timeoutMs?: number;
  /** Probe-Intervall. Default: 250 ms. */
  intervalMs?: number;
  logger?: { info: (m: string) => void; warn: (m: string) => void; err: (m: string) => void };
};

export type StopPostgresInput = {
  paths: PostgresRuntimePaths;
  pgdata: string;
  /** Pflicht: <HAVEWA_DATA_DIR>/logs. */
  logsDir: string;
  /** "fast" (Default) oder "smart". */
  mode?: "fast" | "smart" | "immediate";
  /** Timeout für pgctl stop. */
  timeoutMs?: number;
  logger?: { info: (m: string) => void; warn: (m: string) => void; err: (m: string) => void };
  /** Test-Hook (FIX M-2). */
  _runCommand?: (opts: unknown) => Promise<unknown>;
};

export type StopPostgresResult =
  | { kind: "stopped" }
  | { kind: "already-stopped" };

export type DbLocationResult =
  | { kind: "ready"; host: string; port: number }
  | { kind: "timeout"; host: string; port: number; elapsedMs: number };

export type InitDbInput = {
  paths: PostgresRuntimePaths;
  pgdata: string;
  /** Pflicht: <HAVEWA_DATA_DIR>/logs (FIX M-2). */
  logsDir: string;
  /** UTF8 + locale C. */
  encoding?: string;
  /** DB-Passwort für den Bootstrap-Superuser. */
  dbPassword: string;
  /** Username (Default "havewa"). */
  dbUser?: string;
  logger?: { info: (m: string) => void; warn: (m: string) => void; err: (m: string) => void };
  /** Test-Hook (FIX M-2). */
  _runCommand?: (opts: unknown) => Promise<unknown>;
};

export type InitDbResult = {
  pgdata: string;
};

export declare function runInitDb(input: InitDbInput): Promise<InitDbResult>;
export declare function startPostgres(input: StartPostgresInput): Promise<StartPostgresResult>;
export declare function waitForReady(opts: WaitReadyOptions): Promise<DbLocationResult>;
export declare function stopPostgres(input: StopPostgresInput): Promise<StopPostgresResult>;

export type WritePostgresConfigInput = {
  pgdata: string;
  port: number;
};
export declare function writePostgresConfig(input: WritePostgresConfigInput): Promise<void>;