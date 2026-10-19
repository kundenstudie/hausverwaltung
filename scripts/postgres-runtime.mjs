// HAVEWA-07B — PostgreSQL-Runtime-Pfad-Resolver.
//
// Einziger Lese-/Schreibpfad zur portablen PostgreSQL-Runtime.
//
// Regeln (siehe Auftrag §4):
//   - POSTGRES_RUNTIME_DIR setzt die Wurzel explizit (Default-Fallback unten).
//   - Niemals vom System-PATH raten. Wenn POSTGRES_RUNTIME_DIR nicht gesetzt
//     ist, suchen wir in einer dokumentierten, kleinen Allowlist bekannter
//     Installationspfade (Windows x64). Wer das nicht will, setzt die Env.
//   - Tools heißen: postgres.exe, pg_ctl.exe, initdb.exe, psql.exe,
//     createdb.exe, pg_isready.exe. Alle MÜSSEN vorhanden sein, sonst
//     `missing-tools`.
//   - Reine ESM-Datei (.mjs), damit die produktive Runtime ohne tsx läuft.
//
// Auftrag §3: ARM64 via x64 weiterhin EXPERIMENTAL. Wir prüfen
// process.arch = "x64" und brechen ab, wenn das nicht passt (sicherer
// Default — kein stilles Akzeptieren einer falschen Plattform).

import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const REQUIRED_TOOLS = ["postgres", "pg_ctl", "initdb", "psql", "createdb", "pg_isready"];

/** Mappt tool-name -> Pfad-Property-Name (camelCase). */
const TOOL_TO_PATH_KEY = Object.freeze({
  postgres: "postgresExe",
  pg_ctl: "pgCtlExe",
  initdb: "initdbExe",
  psql: "psqlExe",
  createdb: "createdbExe",
  pg_isready: "pgIsreadyExe",
});

/** Windows x64: Standardpfade für portable/Installer-Runtime. */
const DEFAULT_FALLBACK_DIRS = Object.freeze([
  // Offizielle Installer-Defaults (EnterpriseDB / BigSQL):
  "C:\\Program Files\\PostgreSQL\\16\\bin",
  "C:\\Program Files\\PostgreSQL\\15\\bin",
  "C:\\Program Files\\PostgreSQL\\17\\bin",
]);

const EMPTY_LOGGER = Object.freeze({
  info: () => {},
  warn: () => {},
});

function toolPath(runtimeDir, tool) {
  const exeName = process.platform === "win32" ? `${tool}.exe` : tool;
  return path.join(runtimeDir, exeName);
}

function buildPaths(runtimeDir) {
  return {
    runtimeDir,
    postgresExe: toolPath(runtimeDir, "postgres"),
    pgCtlExe: toolPath(runtimeDir, "pg_ctl"),
    initdbExe: toolPath(runtimeDir, "initdb"),
    psqlExe: toolPath(runtimeDir, "psql"),
    createdbExe: toolPath(runtimeDir, "createdb"),
    pgIsreadyExe: toolPath(runtimeDir, "pg_isready"),
  };
}

function findMissing(tools, paths) {
  const missing = [];
  for (const t of tools) {
    const key = TOOL_TO_PATH_KEY[t];
    if (!key) {
      // Unbekannter Tool-Name: defensiv als missing werten.
      missing.push(t);
      continue;
    }
    if (!existsSync(paths[key])) missing.push(t);
  }
  return missing;
}

/**
 * Löst die PostgreSQL-Runtime auf. Erwartet `POSTGRES_RUNTIME_DIR` über
 * die Optionen (wir lesen selbst KEIN process.env, damit Tests deterministisch
 * sind). Reihenfolge:
 *   1. opts.envValue (höchste Priorität; nicht-leer/whitespace)
 *   2. opts.fallbackDirs (Default: DEFAULT_FALLBACK_DIRS)
 *
 * Liefert `ok` nur, wenn alle Pflicht-Tools existieren. Sonst
 * `missing-tools` mit der fehlenden Liste (Caller entscheidet, wie er
 * weiter verfährt — Hard Fail, kein stiller Fallback).
 *
 * Architektur-Guard (Auftrag §3): Auf ARM64 wird NICHT stillschweigend
 * weitergearbeitet. Wir liefern `missing-tools` mit allen Tools, der
 * Caller sieht, dass die Plattform nicht passt.
 */
export function resolvePostgresRuntime(opts = {}) {
  const logger = opts.logger || EMPTY_LOGGER;
  const envValue = (opts.envValue ?? "").trim();
  const fallbackDirs = opts.fallbackDirs ?? DEFAULT_FALLBACK_DIRS;

  // Plattform-Guard: nicht still abnicken.
  if (process.arch !== "x64") {
    logger.warn(`[pg-runtime] Plattform ist ${process.arch}; HAVEWA-07B ist nur x64.`);
    const stubDir = "<not found: arch mismatch>";
    return {
      kind: "missing-tools",
      paths: buildPaths(stubDir),
      missing: REQUIRED_TOOLS,
    };
  }

  // 1) Env-Override.
  const candidates = [];
  if (envValue) candidates.push(envValue);
  // 2) Fallbacks.
  for (const d of fallbackDirs) {
    if (!candidates.includes(d)) candidates.push(d);
  }

  // Wir tracken die letzte Missing-Liste, damit der finale Verdict die
  // tatsächlich fehlenden Tools des letzten Kandidaten zurückgibt.
  let lastMissing = REQUIRED_TOOLS.slice();
  let lastPaths = null;

  for (const dir of candidates) {
    const paths = buildPaths(dir);
    const missing = findMissing(REQUIRED_TOOLS, paths);
    if (missing.length === 0) {
      logger.info(`[pg-runtime] resolved: ${dir}`);
      return { kind: "ok", paths };
    }
    logger.warn(`[pg-runtime] candidate ${dir}: missing ${missing.join(", ")}`);
    lastMissing = missing;
    lastPaths = paths;
  }

  // Kein Kandidat gefunden.
  return {
    kind: "missing-tools",
    paths: lastPaths || buildPaths(candidates[0] || "<no candidate>"),
    missing: lastMissing,
  };
}

/** Re-export für Tests. NICHT in der Runtime-API dokumentiert. */
export const __REQUIRED_TOOLS = REQUIRED_TOOLS;
export const __DEFAULT_FALLBACK_DIRS = DEFAULT_FALLBACK_DIRS;