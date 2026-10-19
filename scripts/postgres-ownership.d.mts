// HAVEWA-07B — Type-Deklarationen für postgres-ownership.mjs.

export type PostgresRuntimeRecord = {
  runtimeId: string;
  pid: number;
  pgdata: string;
  host: string;
  port: number;
  startedAt: string;
  loopbackHost: string;
};

export type PostmasterPid = {
  pid: number;
  /** Erste Zeile des Data-Verzeichnisses (oft leer). */
  dataDirLine?: string;
  /** Port aus postmaster.pid (sofern vorhanden). */
  portLine?: number;
  /** Raw-Zeilen, ausschließlich für Diagnose-Zwecke. */
  rawLines?: readonly string[];
};

export type OwnershipCheckInput = {
  /** Persistierte Aufzeichnung der letzten eigenen Instanz. */
  record: PostgresRuntimeRecord;
  /** Aktuelle Sicht des Systems. */
  currentPid: number | null;
  /** Geparste postmaster.pid-Datei (oder null, wenn fehlt). */
  postmasterPid: PostmasterPid | null;
};

export type OwnershipVerdict =
  | { kind: "own-running"; runtimeId: string }
  | { kind: "own-stale"; reason: string }
  | { kind: "foreign-pid"; reason: string };

export declare function parsePostmasterPid(content: string): PostmasterPid;

export declare function verifyOwnInstance(input: OwnershipCheckInput): OwnershipVerdict;

export declare function isPidRunning(pid: number): boolean;