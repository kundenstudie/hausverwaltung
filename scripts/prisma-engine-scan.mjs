// HAVEWA-07D G7-FIX — Zentraler Prisma-Engine-Scanner (Packaging + Verify).
//
// Ein einziger Scanner, zwei Verwendungen:
//   1) PACKAGING  — filtert beim Kopieren nicht-windows-x64 Engines raus
//   2) VERIFY     — meldet jede non-windows-x64 Engine als FAIL
//
// Der Scanner arbeitet auf dem Dateinamen (Familie) UND auf dem
// Dateiinhalt (native Magic: ELF / PE / Mach-O). Damit wird nicht ueber
// Dateinamen geraten: eine Datei mit Engine-Namen, aber ohne native Magic
// und ohne native Endung (z.B. ein README) wird nicht als Engine gewertet.

import { promises as fs } from "node:fs";
import path from "node:path";

import {
  classifyPrismaEngine,
  detectBinaryFormat,
  engineFamily,
  engineTarget,
  isNativePrismaEngineFile,
} from "./prisma-engine-policy.mjs";

/**
 * Rekursiver Datei-Walk (symlink-frei, folgt keinen Verzeichnis-Symlinks).
 */
export async function* walkFiles(root) {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) {
      yield* walkFiles(p);
    } else if (e.isFile()) {
      yield p;
    }
  }
}

/**
 * Liest die ersten Bytes einer Datei (fuer die Magic-Erkennung).
 */
async function readHead(filePath, len = 64) {
  try {
    const fh = await fs.open(filePath, "r");
    try {
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, 0);
      return buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

/**
 * Scannt einen Baum nach nativen Prisma-Engines.
 *
 * @param {string} root        Wurzelverzeichnis
 * @param {object} [opts]
 * @param {boolean} [opts.includeFormat]  Magic der Datei mitausgeben
 * @returns {Promise<{engines:Array, violations:Array}>}
 *
 * `engines`   — alle erkannten nativen Prisma-Engines (inkl. erlaubter)
 * `violations`— alle Engines, die NICHT windows-x64 sind (=> FAIL)
 */
export async function scanPrismaEngines(root, opts = {}) {
  const engines = [];
  const violations = [];

  for await (const p of walkFiles(root)) {
    const name = path.basename(p);
    if (!isNativePrismaEngineFile(name)) continue;

    const cls = classifyPrismaEngine(name);
    const head = await readHead(p);
    const format = head ? detectBinaryFormat(head) : null;

    // Fail-closed: Eine Datei mit Engine-Namen und nativer Endung, deren
    // Magic NICHT gelesen werden konnte, gilt als potenziell verboten —
    // wir melden sie als Violation (kein "nicht pruefbar = ok").
    const magicKnown = format !== null;
    const nativeSuffix = /\.(exe|dll|node|so|dylib)$/i.test(name);

    const entry = {
      file: p,
      name,
      family: cls.family,
      target: cls.target,
      allowed: cls.allowed,
      reason: cls.reason,
      format,
      magicKnown,
      size: null,
    };
    try {
      const st = await fs.stat(p);
      entry.size = st.size;
    } catch { /* ignore */ }

    // Ohne lesbare Magic: nur als Violation melden, wenn sie NICHT
    // eindeutig windows-x64 benannt ist. Eine klar als Windows-x64
    // benannte Datei darf behalten werden (Magic ist optional).
    if (!cls.allowed) {
      entry.verdict = "forbidden";
      violations.push(entry);
    } else if (!magicKnown && nativeSuffix) {
      entry.verdict = "unverified";
      violations.push(entry);
    } else {
      entry.verdict = "allowed";
    }

    if (opts.includeFormat === false) {
      // Nur Violations melden (schneller Modus).
    } else {
      engines.push(entry);
    }
  }

  return { engines, violations };
}

/**
 * Kurzform: nur die Violations.
 */
export async function findPrismaEngineViolations(root) {
  const { violations } = await scanPrismaEngines(root);
  return violations;
}

/**
 * Filtert eine Liste von Dateinamen (relativ zum Wurzelverzeichnis)
 * gegen die Windows-x64-Policy. Wird beim Kopieren benutzt, damit
 * verbotene Engines NIE in den Stage gelangen (fail-closed).
 *
 * @param {string} root
 * @param {string[]} relativeNames
 * @returns {Promise<{keep:string[], drop:string[], droppedDetails:Array}>}
 */
export async function filterWindowsX64Only(root, relativeNames) {
  const keep = [];
  const drop = [];
  const droppedDetails = [];

  for (const rel of relativeNames) {
    const base = path.basename(rel);
    if (!isNativePrismaEngineFile(base)) {
      keep.push(rel);
      continue;
    }
    const cls = classifyPrismaEngine(base);
    if (cls.allowed) {
      keep.push(rel);
      continue;
    }
    const abs = path.join(root, rel);
    const head = await readHead(abs);
    const format = head ? detectBinaryFormat(head) : null;
    drop.push(rel);
    droppedDetails.push({
      file: rel,
      family: cls.family,
      target: cls.target.family,
      format,
      size: null,
    });
  }

  return { keep, drop, droppedDetails };
}

/**
 * Report-Hilfe: formatiert eine Engine-Inventarliste fuer Logs.
 */
export function formatEngineInventory(engines) {
  if (!engines || engines.length === 0) return "  (keine nativen Prisma-Engines gefunden)";
  const lines = [];
  for (const e of engines) {
    const size = typeof e.size === "number" ? ` ${(e.size / 1024 / 1024).toFixed(1)} MB` : "";
    const fmt = e.format ? ` format=${e.format}` : "";
    lines.push(`  [${e.verdict || "?"}] ${e.target.family} ${e.name}${size}${fmt}`);
  }
  return lines.join("\n");
}

export { classifyPrismaEngine, detectBinaryFormat, engineFamily, engineTarget, isNativePrismaEngineFile };
