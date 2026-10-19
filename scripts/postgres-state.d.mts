// HAVEWA-07B — Type-Deklarationen für postgres-state.mjs.

export type PostgresRuntimeRecord = {
  runtimeId: string;
  pid: number;
  pgdata: string;
  host: string;
  port: number;
  startedAt: string;
  loopbackHost: string;
};

export type PostgresStateFile = {
  /** Schema-Version des Records (aktuell 1). */
  schemaVersion: 1;
  record: PostgresRuntimeRecord;
};

export declare function generateRuntimeId(): string;

export declare function buildPostgresRecord(input: {
  pid: number;
  pgdata: string;
  host: string;
  port: number;
  startedAt?: string;
}): PostgresRuntimeRecord;

export declare function readPostgresState(runtimeStateDir: string): PostgresStateFile | null;
export declare function writePostgresState(runtimeStateDir: string, file: PostgresStateFile): Promise<void>;
export declare function removePostgresState(runtimeStateDir: string): Promise<void>;

/** Re-export nur für Tests. */
export declare const __STATE_FILE: string;
export declare const __SCHEMA_VERSION: 1;