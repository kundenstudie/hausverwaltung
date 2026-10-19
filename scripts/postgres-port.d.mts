// HAVEWA-07B — Type-Deklarationen für postgres-port.mjs.

export type PortProbe = {
  host: string;
  port: number;
};

export type PickPortOptions = {
  /** Bevorzugte Ports (Default: [5433, 5434]). */
  candidates?: readonly number[];
  /** Loopback-Host (Default: PG_LOOPBACK_HOST aus postgres-paths.mjs). */
  host?: string;
  /** Pro-Port-Probe-Timeout in ms (Default: 800). */
  probeTimeoutMs?: number;
};

export type PickPortResult =
  | { kind: "ok"; host: string; port: number }
  | { kind: "exhausted"; tried: readonly number[]; host: string };

export type PickPortProbeFn = (p: PortProbe) => Promise<boolean>;

export declare function pickDbPort(opts?: PickPortOptions, probe?: PickPortProbeFn): Promise<PickPortResult>;

export type DbPortRecord = {
  host: string;
  port: number;
  /** ISO-Zeitstempel der Auswahl. */
  selectedAt: string;
  /** Welche Kandidaten in Reihenfolge geprüft wurden. */
  tried: readonly number[];
};

export declare function readDbPortRecord(runtimeStateDir: string): DbPortRecord | null;
export declare function writeDbPortRecord(runtimeStateDir: string, rec: DbPortRecord): Promise<void>;

/** TCP-Probe-Funktion (Default-Implementierung). */
export declare function defaultProbe(p: PortProbe): Promise<boolean>;

/** Re-export nur für Tests. */
export declare const __DEFAULT_CANDIDATES: readonly number[];