// HAVEWA-07B — Type-Deklarationen für postgres-runtime.mjs.
//
// Die Implementierung ist reines ESM (.mjs), damit sie ohne Build-Schritt
// und ohne tsx-Loader im produktiven Runtime-Pfad läuft. Diese Datei
// existiert NUR, damit `tsc --noEmit` die Importe aus den Test-Dateien
// und aus dem 07A-2-Orchestrator auflösen kann.
//
// Vertraglich werden ALLE exportierten Helfer und Typen in postgres-runtime.mjs
// exportiert und hier 1:1 abgebildet.

export type PostgresTool = "postgres" | "pg_ctl" | "initdb" | "psql" | "createdb" | "pg_isready";

export type PostgresRuntimePaths = {
  /** Wurzel der portablen Runtime (Tools + Libs). */
  runtimeDir: string;
  /** Absoluter Pfad zu postgres.exe (oder leer, wenn nicht gefunden). */
  postgresExe: string;
  /** Absoluter Pfad zu pg_ctl.exe. */
  pgCtlExe: string;
  /** Absoluter Pfad zu initdb.exe. */
  initdbExe: string;
  /** Absoluter Pfad zu psql.exe. */
  psqlExe: string;
  /** Absoluter Pfad zu createdb.exe. */
  createdbExe: string;
  /** Absoluter Pfad zu pg_isready.exe. */
  pgIsreadyExe: string;
};

export type ResolveOptions = {
  /** Env-Override, der die Runtime-Wurzel setzt. */
  envValue?: string | null;
  /** Zusätzliche bekannte Suchpfade, wenn envValue nicht gesetzt ist. */
  fallbackDirs?: readonly string[];
  /** Optionaler Logger; default: still (no-op). */
  logger?: { info: (msg: string) => void; warn: (msg: string) => void };
};

export type ResolveStatus =
  | { kind: "ok"; paths: PostgresRuntimePaths }
  | { kind: "missing-tools"; paths: PostgresRuntimePaths; missing: readonly PostgresTool[] };

export declare function resolvePostgresRuntime(opts?: ResolveOptions): ResolveStatus;

/** Re-export nur für Tests (nicht dokumentierte Runtime-API). */
export declare const __REQUIRED_TOOLS: readonly PostgresTool[];
export declare const __DEFAULT_FALLBACK_DIRS: readonly string[];