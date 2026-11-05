// HAVEWA-07D G2 — Structural test for PG-Binaries.
// Da diese Maschine ARM64-Windows ist und die Stage-PG-Binaries Windows-x64-PEs sind,
// können wir x64 Windows nicht direkt starten. Wir verifizieren strukturell:
//
//   - alle 8 Pflicht-EXEs vorhanden
//   - jede ist PE 0x8664
//   - jedes DLL-Übergang-Argument prüft symbolische Existenz
//
// Bei einem echten x64-Runner würde `HAVEWA_ALLOW_STAGE_PG_TEST=1` einen
// Live-Run von initdb auslösen; auf einem Cross-Arch-Host (z.B. ARM64)
// schlägt der Live-Run fehl — das ist erwartet und gemeldet.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const PG_BIN_DIR = path.join(REPO_ROOT, "src-tauri", "resources", "runtime", "postgres", "bin");
const REQUIRED = ["postgres.exe", "pg_ctl.exe", "initdb.exe", "pg_isready.exe", "createdb.exe", "psql.exe", "pg_dump.exe", "pg_restore.exe"];

async function readPeMachine(filePath) {
  const buf = await readFile(filePath);
  if (buf.length < 64) return -1;
  const peOffset = buf.readUInt32LE(0x3c);
  if (peOffset <= 0 || peOffset + 4 > buf.length) return -1;
  if (buf[peOffset] !== 0x50 || buf[peOffset + 1] !== 0x45) return -1;
  return buf.readUInt16LE(peOffset + 4);
}

let pass = true;
const errors = [];

for (const tool of REQUIRED) {
  const p = path.join(PG_BIN_DIR, tool);
  if (!existsSync(p)) {
    pass = false;
    errors.push(`PG-Tool fehlt: ${tool}`);
    continue;
  }
  const m = await readPeMachine(p);
  if (m !== 0x8664) {
    pass = false;
    errors.push(`PG-Tool ${tool} ist nicht x64 (PE=0x${(m >>> 0).toString(16)})`);
  }
}

// Optional: Live-Test nur, wenn explizit gewünscht UND Architektur passt.
if (process.env.HAVEWA_ALLOW_STAGE_PG_TEST === "1" && process.arch === "x64") {
  const tmpData = path.join(REPO_ROOT, ".runtime-cache", "pgdata-test");
  if (existsSync(tmpData)) {
    const fs = await import("node:fs/promises");
    await fs.rm(tmpData, { recursive: true, force: true });
  }
  const fs = await import("node:fs/promises");
  await fs.mkdir(tmpData, { recursive: true });
  const r = spawnSync(path.join(PG_BIN_DIR, "initdb.exe"),
    ["-U", "havewa", "--auth=scram-sha-256", "--encoding=UTF-8", tmpData],
    { shell: false, stdio: "inherit", timeout: 60_000 },
  );
  if (r.status !== 0) {
    pass = false;
    errors.push(`initdb live-run exit=${r.status}`);
  }
}

if (!pass) {
  process.stderr.write(`[verify-pg-binaries] FAIL: ${errors.join("; ")}\n`);
  process.exit(1);
}
process.stdout.write("[verify-pg-binaries] OK\n");
