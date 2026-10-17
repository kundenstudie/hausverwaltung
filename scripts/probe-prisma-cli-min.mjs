// HAVEWA-07A-2 — Isolierter Beweis: minimaler Prisma-CLI-Baum.
//
// Spike-Validierung, die `scripts/prisma-runtime-tree.mjs` benutzt und
// in os.tmpdir() laeuft. Nach dem Lauf wird der temp-Baum wieder
// aufgeraeumt. Bleibt als Sanity-Check im Repo.
//
// KEIN Netzwerk-Zugriff.

import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import process from "node:process";

import { buildPrismaTree, runPrismaCli } from "./prisma-runtime-tree.mjs";

const TEMP_BASE = path.join(os.tmpdir(), "havewa-07a2-prisma-min");

function fail(msg, code = 1) {
  process.stderr.write(`[probe-prisma-cli-min] FAIL: ${msg}\n`);
  process.exit(code);
}

async function main() {
  const id = crypto.randomBytes(4).toString("hex");
  const tmp = path.join(TEMP_BASE, id);
  process.stdout.write(`[probe-prisma-cli-min] temp: ${tmp}\n`);

  const copied = await buildPrismaTree(tmp);
  process.stdout.write(`[probe-prisma-cli-min] kopierte Top-Level-Pakete: ${copied.length}\n`);

  const env = { ...process.env, DATABASE_URL: "postgresql://havewa_test:havewa_test@localhost:5433/havewa_test?schema=public" };

  process.stdout.write("[probe-prisma-cli-min] prisma generate (lokal im temp-Baum) …\n");
  const rGen = spawnSync(
    process.execPath,
    [path.join(tmp, "node_modules", "prisma", "build", "index.js"), "generate"],
    { stdio: "inherit", shell: false, env, cwd: tmp },
  );
  if (rGen.error) fail(`prisma generate: ${rGen.error.message}`);
  if (rGen.status !== 0) fail(`prisma generate -> exit ${rGen.status}`);

  process.stdout.write("[probe-prisma-cli-min] migrate deploy (offline) …\n");
  try {
    await runPrismaCli(tmp, ["migrate", "deploy"], {
      env,
      inheritStdout: true,
      inheritStderr: true,
    });
  } catch (e) {
    fail(e?.message || String(e));
  }

  process.stdout.write(`\n[probe-prisma-cli-min] OK: migrate deploy offline, exit 0\n`);
  process.stdout.write(`[probe-prisma-cli-min] tatsaechlich kopierte Wurzel-Eintraege (${copied.length}):\n`);
  for (const c of copied) process.stdout.write(`  - ${c}\n`);

  for (let i = 0; i < 5; i++) {
    try { await fs.rm(tmp, { recursive: true, force: true }); break; }
    catch { await new Promise((r) => setTimeout(r, 200)); }
  }
}

main().catch((e) => fail(e?.stack || String(e)));
