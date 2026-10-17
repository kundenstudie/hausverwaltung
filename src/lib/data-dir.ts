// HAVEWA-07A-2 — HAVEWA_DATA_DIR-Semantik.
//
// Einziger Lese-/Schreibpfad fuer persistente Anwendungsdaten. Wenn die Env-Variable
// HAVEWA_DATA_DIR gesetzt ist, wird sie als Basis verwendet. Sonst Fallback auf
// process.cwd() (Bestehendes Verhalten, technisch kompatibel).
//
// Pfade-Schema (Vorbereitung fuer Desktop, keine Installer-Arbeit):
//   <root>/
//     config/         Konfig-Dateien (Zukunft)
//     pgdata/         Postgres-Datenverzeichnis (Zukunft, kein Bundling)
//     storage/        storage/documents (jetzt) — bestehender File-Storage
//     logs/           Log-Dateien (Zukunft)
//     runtime-state/  Port-Info, Last-Run-Status (jetzt)
//
// App-Assets (next-intl messages, public, .next/static) werden NICHT in den
// Datenpfad verschoben. Sie sind Build-Artefakte bzw. Anwendungs-Bundle.

import path from "node:path";

export type DataSubdir = "config" | "pgdata" | "storage" | "logs" | "runtime-state";

/** Basisverzeichnis fuer persistente Anwendungsdaten. */
export function dataDir(): string {
  return process.env.HAVEWA_DATA_DIR?.trim() || process.cwd();
}

/** Absoluter Pfad zu einem Unterverzeichnis. Existiert nicht zwangslaeufig. */
export function dataPath(sub: DataSubdir, ...rest: string[]): string {
  return path.join(dataDir(), sub, ...rest);
}

/** Storage-Basis (Dokumente). Existierende Semantik aus src/lib/storage.ts:
 *  `path.join(process.cwd(), "storage", "documents")`. */
export function storageDocumentsDir(): string {
  return dataPath("storage", "documents");
}

/** Runtime-State-Basis (z. B. port.json, last-shutdown.json). */
export function runtimeStateDir(): string {
  return dataPath("runtime-state");
}
