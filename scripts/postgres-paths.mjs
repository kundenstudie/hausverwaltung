// HAVEWA-07B — Pfade und Erkennung des First-Run-Zustands.
//
// Regeln (Auftrag §3, §5):
//   - pgdata       = <HAVEWA_DATA_DIR>/pgdata (Default HAVEWA_DATA_DIR ?? process.cwd())
//   - logsDir      = <HAVEWA_DATA_DIR>/logs
//   - runtimeState = <HAVEWA_DATA_DIR>/runtime-state
//   - First-Run = Verzeichnis pgdata existiert NICHT oder enthält kein PG_VERSION
//   - PG_LOOPBACK_HOST = "127.0.0.1" — strikt loopback, kein 0.0.0.0
//
// Reines ESM (.mjs), keine ENV-Reads außerhalb resolvePostgresDirs().
//
// Bewusst KEINE Singleton-Logik: jeder Caller bekommt frische Werte.
// Tests dürfen `dataDirOverride` setzen.

import { existsSync } from "node:fs";
import path from "node:path";

export const PG_LOOPBACK_HOST = "127.0.0.1";

/**
 * Bestimmt die HaVeWa-Datenpfade.
 *
 * Reihenfolge:
 *   1. opts.dataDirOverride (höchste Priorität)
 *   2. process.env.HAVEWA_DATA_DIR (sofern gesetzt und nicht whitespace)
 *   3. process.cwd() (bestehende Konvention; siehe 07A-2)
 */
export function resolvePostgresDirs(opts = {}) {
  const fromEnv = (process.env.HAVEWA_DATA_DIR || "").trim();
  const dataDir = (opts.dataDirOverride ?? "").trim() || fromEnv || process.cwd();
  return {
    dataDir,
    pgdata: path.join(dataDir, "pgdata"),
    logsDir: path.join(dataDir, "logs"),
    runtimeStateDir: path.join(dataDir, "runtime-state"),
  };
}

/**
 * Erkennt, ob initdb nötig ist.
 *
 * Bestimmt:
 *   - pgdata-Verzeichnis fehlt -> first run
 *   - PG_VERSION fehlt im pgdata-Verzeichnis -> first run
 *   - alles andere -> bereits initialisiert
 *
 * Der Caller entscheidet, was im First-Run-Fall passiert
 * (initdb ausführen, scram-config setzen, Datenbank anlegen).
 */
export function isFirstRun(opts = {}) {
  const dirs = opts.dirs || resolvePostgresDirs();
  const pgdata = opts.pgdataOverride || dirs.pgdata;
  if (!existsSync(pgdata)) return true;
  const pgVersion = path.join(pgdata, "PG_VERSION");
  if (!existsSync(pgVersion)) return true;
  return false;
}