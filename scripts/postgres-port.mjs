// HAVEWA-07B — Port-Auswahl 5433 -> 5434 mit Persistenz.
//
// Regeln (Auftrag §7):
//   - Default-Kandidaten: [5433, 5434]
//   - Loopback-only: Host = 127.0.0.1 (siehe postgres-paths.PG_LOOPBACK_HOST)
//   - Portbelegung allein heisst NICHT, dass es unsere Instanz ist.
//     Wir prüfen NUR die TCP-Verfügbarkeit; Ownership wird über
//     postgres-runtime-state (postmaster.pid + PID) verifiziert.
//   - Persistenz in <runtimeStateDir>/db-port.json (NICHT committen,
//     siehe .gitignore — runtime-state ist bereits ignored).
//
// Reines ESM (.mjs), testbar mit injizierter probe-Funktion.

import { existsSync, readFileSync } from "node:fs";
import { promises as fsp } from "node:fs";
import net from "node:net";
import path from "node:path";

import { PG_LOOPBACK_HOST } from "./postgres-paths.mjs";

const DEFAULT_CANDIDATES = Object.freeze([5433, 5434]);
const DEFAULT_PROBE_TIMEOUT_MS = 800;

/** TCP-Probe: ist der Port auf dem Loopback-Host verfügbar? */
export function defaultProbe({ host, port }) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* ignore */ }
      resolve(v);
    };
    socket.setTimeout(DEFAULT_PROBE_TIMEOUT_MS);
    socket.once("connect", () => finish(false)); // belegt = belegt
    socket.once("timeout", () => finish(true));
    socket.once("error", (e) => {
      // ECONNREFUSED = Port frei; EADDRINUSE = belegt; alles andere
      // behandeln wir konservativ als "belegt" (sicherer).
      finish(e && e.code === "ECONNREFUSED");
    });
    socket.connect(port, host);
  });
}

/**
 * Wählt den ersten freien Port aus den Kandidaten.
 * Gibt NUR dann `ok` zurück, wenn die Probe (Default: TCP-Probe)
 * "frei" meldet. Bei "exhausted" wurden alle Kandidaten geprüft.
 *
 * Caller kann eine eigene probe-Funktion injizieren (Tests).
 */
export async function pickDbPort(opts = {}, probe = defaultProbe) {
  const host = opts.host || PG_LOOPBACK_HOST;
  const candidates = (opts.candidates && opts.candidates.length > 0)
    ? opts.candidates
    : DEFAULT_CANDIDATES;
  const timeoutMs = Number.isFinite(opts.probeTimeoutMs) && opts.probeTimeoutMs > 0
    ? opts.probeTimeoutMs
    : DEFAULT_PROBE_TIMEOUT_MS;
  void timeoutMs;

  for (const port of candidates) {
    const free = await probe({ host, port });
    if (free) return { kind: "ok", host, port };
  }
  return { kind: "exhausted", tried: candidates, host };
}

/** Liest die persistierte Portwahl (oder null). */
export function readDbPortRecord(runtimeStateDir) {
  if (!runtimeStateDir) return null;
  const file = path.join(runtimeStateDir, "db-port.json");
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, "utf8");
    const obj = JSON.parse(raw);
    if (
      obj &&
      typeof obj.host === "string" &&
      Number.isFinite(obj.port) &&
      typeof obj.selectedAt === "string" &&
      Array.isArray(obj.tried)
    ) {
      return obj;
    }
    return null;
  } catch {
    return null;
  }
}

/** Schreibt die Portwahl atomar (Temp -> Rename). */
export async function writeDbPortRecord(runtimeStateDir, rec) {
  if (!runtimeStateDir) throw new Error("runtimeStateDir fehlt");
  await fsp.mkdir(runtimeStateDir, { recursive: true });
  const target = path.join(runtimeStateDir, "db-port.json");
  const tmp = `${target}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(rec, null, 2) + "\n", "utf8");
  await fsp.rename(tmp, target);
}

export const __DEFAULT_CANDIDATES = DEFAULT_CANDIDATES;