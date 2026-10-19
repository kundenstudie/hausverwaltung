// HAVEWA-07B — Type-Deklarationen für postgres-paths.mjs.

export type PostgresDirs = {
  /** Wurzel der HaVeWa-Daten, in der Regel HAVEWA_DATA_DIR. */
  dataDir: string;
  /** Persistenter Postgres-Datenpfad (<dataDir>/pgdata). */
  pgdata: string;
  /** Persistenter Logs-Pfad (<dataDir>/logs). */
  logsDir: string;
  /** Persistenter Runtime-State-Pfad (<dataDir>/runtime-state). */
  runtimeStateDir: string;
};

export type ResolvePostgresDirsOptions = {
  /** Override für die Wurzel (Default: process.env.HAVEWA_DATA_DIR ?? process.cwd()). */
  dataDirOverride?: string | null;
};

export declare function resolvePostgresDirs(opts?: ResolvePostgresDirsOptions): PostgresDirs;

export type IsFirstRunOptions = {
  /** Expliziter pgdata-Pfad (überschreibt den aus dataDir abgeleiteten). */
  pgdataOverride?: string;
  /** HavewaDirs-Override. */
  dirs?: PostgresDirs;
};

export declare function isFirstRun(opts?: IsFirstRunOptions): boolean;

export type DbPortRecord = {
  host: string;
  port: number;
  startedAt: string;
  /** Welche Instanz diese Wahl getroffen hat (Runtime-ID). */
  runtimeId: string;
};

export type PostgresRuntimeRecord = {
  /** UUID-v4-artige Runtime-ID, deterministisch pro Start. */
  runtimeId: string;
  pid: number;
  pgdata: string;
  host: string;
  port: number;
  /** ISO-Zeitstempel des Starts. */
  startedAt: string;
  /** Loopback-only-Host (immer 127.0.0.1). */
  loopbackHost: string;
};

export declare const PG_LOOPBACK_HOST: string;