// HAVEWA-07A-2 — Produktiver Prisma-Runtime-Packaging-Schritt.
//
// Erzeugt einen stabilen, reproduzierbaren Runtime-Baum unter
//   scripts/.runtime/prisma-cli/
// der alle fuer `prisma migrate deploy` (und `prisma generate`)
// notwendigen Dateien enthaelt: schema.prisma, migrations/,
// migration_lock.toml, node_modules/prisma (CLI) + @prisma/* (gesamter
// Tree) + transitive Abhaengigkeiten.
//
// Aufruf:
//   node scripts/package-runtime.mjs
//
// Idempotent: Zielverzeichnis wird vorher aufgeraeumt.
// KEIN npm install, KEIN Netzwerk-Zugriff.
//
// Verwendung durch scripts/migrate-deploy.mjs und scripts/start-runtime.mjs.

import { buildPrismaTree } from "./prisma-runtime-tree.mjs";
import path from "node:path";
import process from "node:process";

const TARGET = path.join(process.cwd(), "scripts", ".runtime", "prisma-cli");

function fail(msg, code = 1) {
  process.stderr.write(`[package-runtime] FAIL: ${msg}\n`);
  process.exit(code);
}

async function main() {
  process.stdout.write(`[package-runtime] target: ${TARGET}\n`);
  const copied = await buildPrismaTree(TARGET);
  const dropped = buildPrismaTree.lastDroppedEngines || [];
  if (dropped.length > 0) {
    process.stdout.write(
      `[package-runtime] non-windows-x64 Prisma-Engines ausgeschlossen (${dropped.length}):\n`,
    );
    for (const d of dropped) process.stdout.write(`  - ${d}\n`);
  }
  process.stdout.write(`[package-runtime] kopierte Top-Level-Eintraege: ${copied.length}\n`);
  for (const c of copied) process.stdout.write(`  - ${c}\n`);
  process.stdout.write(`[package-runtime] OK\n`);
}

main().catch((e) => fail(e?.stack || String(e)));
