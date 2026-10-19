// HAVEWA-07B — Type-Deklarationen für postgres-bootstrap-db.mjs.

import type { PostgresRuntimePaths } from "./postgres-runtime.d.mts";

export type BootstrapDbInput = {
  paths: PostgresRuntimePaths;
  host: string;
  port: number;
  dbPassword: string;
  dbUser?: string;
  dbName?: string;
  /** initdb-Superuser (Default: dbUser). */
  initdbUser?: string;
  logger?: { info: (m: string) => void; warn: (m: string) => void; err: (m: string) => void };
};

export type BootstrapDbResult = {
  /** Wurde die Datenbank neu angelegt? */
  created: boolean;
  user: string;
  dbName: string;
};

export declare function ensureRole(input: BootstrapDbInput): Promise<{ user: string; created: boolean }>;
export declare function ensureDatabase(input: BootstrapDbInput): Promise<{ dbName: string; created: boolean }>;
export declare function bootstrapDatabase(input: BootstrapDbInput): Promise<BootstrapDbResult>;

/**
 * Test-Export (FIX M-1): erlaubt Tests, psqlExec mit einem injizierten
 * _spawn aufzurufen, um argv/Stdin zu prüfen. Typen sind permissiv.
 */
export declare function __psqlExecForTest(
  opts: Record<string, unknown> & { sql: string; paths: { psqlExe: string } },
  _spawnFn: (exe: string, args: readonly string[], opts: unknown) => unknown,
): Promise<{ stdout: string; stderr: string }>;