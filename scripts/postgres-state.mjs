// HAVEWA-07B — Persistenz des eigenen Postgres-Runtime-States.
//
// Persistiert pro laufende Instanz eine Datei:
//   <runtimeStateDir>/postgres-runtime.json
//
// Inhalt:
//   - schemaVersion
//   - record: { runtimeId, pid, pgdata, host, port, startedAt, loopbackHost }
//
// Damit unterscheiden wir unsere Instanz sauber von fremden postgres.exe-
// Prozessen (Auftrag §8).

import { existsSync, readFileSync } from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const STATE_FILE = "postgres-runtime.json";
const SCHEMA_VERSION = 1;

/** Erzeugt eine neue Runtime-ID (UUID v4). */
export function generateRuntimeId() {
  return randomUUID();
}

/** Baut einen vollständigen Record (für die Tests). */
export function buildPostgresRecord({
  pid,
  pgdata,
  host,
  port,
  startedAt,
}) {
  return {
    runtimeId: generateRuntimeId(),
    pid: Number(pid),
    pgdata: path.resolve(pgdata),
    host,
    port: Number(port),
    startedAt: startedAt || new Date().toISOString(),
    loopbackHost: "127.0.0.1",
  };
}

/** Liest den persistierten State (oder null). */
export function readPostgresState(runtimeStateDir) {
  if (!runtimeStateDir) return null;
  const file = path.join(runtimeStateDir, STATE_FILE);
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, "utf8");
    const obj = JSON.parse(raw);
    if (
      obj &&
      obj.schemaVersion === SCHEMA_VERSION &&
      obj.record &&
      typeof obj.record.runtimeId === "string" &&
      Number.isFinite(obj.record.pid)
    ) {
      return obj;
    }
    return null;
  } catch {
    return null;
  }
}

/** Schreibt atomar (Temp -> Rename). */
export async function writePostgresState(runtimeStateDir, file) {
  if (!runtimeStateDir) throw new Error("runtimeStateDir fehlt");
  await fsp.mkdir(runtimeStateDir, { recursive: true });
  const target = path.join(runtimeStateDir, STATE_FILE);
  const tmp = `${target}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(file, null, 2) + "\n", "utf8");
  await fsp.rename(tmp, target);
}

/** Entfernt die State-Datei (idempotent). */
export async function removePostgresState(runtimeStateDir) {
  if (!runtimeStateDir) return;
  const file = path.join(runtimeStateDir, STATE_FILE);
  try {
    await fsp.unlink(file);
  } catch (e) {
    if (e && e.code === "ENOENT") return;
    throw e;
  }
}

export const __STATE_FILE = STATE_FILE;
export const __SCHEMA_VERSION = SCHEMA_VERSION;