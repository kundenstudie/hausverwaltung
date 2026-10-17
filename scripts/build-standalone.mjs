// HAVEWA-07A-2 — Standalone-Build-Helper (Node, plattform-neutral).
//
// Aufruf (aus package.json):
//   node scripts/build-standalone.mjs
//
// Schritte:
//   1) next build  (NEXT_OUTPUT_STANDALONE=1 aktiviert output: "standalone"
//      in next.config.ts; Default-Verhalten ohne diese Variable ist unveraendert)
//   2) .next/static  -> .next/standalone/.next/static     (Client-Hydration)
//   3) public/*     -> .next/standalone/public            (statische Assets)
//   4) .env und storage/ aus dem Standalone entfernen     (portabel + sicher)
//
// Idempotent: kann beliebig oft aufgerufen werden, jedes Schritt-Teilergebnis
// wird vor der Aktion geprueft.
//
// Kein fragiles Inline-cmd-Quoting: ruft node/npm/cmd ueber child_process auf.

import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const NEXT = path.join(ROOT, ".next");
const STANDALONE = path.join(NEXT, "standalone");
const STATIC_SRC = path.join(NEXT, "static");
const STATIC_DST = path.join(STANDALONE, ".next", "static");
const PUBLIC_SRC = path.join(ROOT, "public");
const PUBLIC_DST = path.join(STANDALONE, "public");

function fail(msg, code = 1) {
  process.stderr.write(`[build-standalone] FAIL: ${msg}\n`);
  process.exit(code);
}

function step(label) {
  process.stdout.write(`[build-standalone] ${label}\n`);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    stdio: "inherit",
    shell: false,
    ...opts,
  });
  if (r.error) fail(`${cmd} ${args.join(" ")}: ${r.error.message}`);
  if (r.status !== 0) fail(`${cmd} ${args.join(" ")} -> exit ${r.status}`);
}

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function copyDir(src, dst) {
  await fs.mkdir(dst, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) {
      await copyDir(s, d);
    } else if (e.isFile()) {
      await fs.copyFile(s, d);
    }
  }
}

async function main() {
  // 0) Toolchain-Provenienz (analog run-x64.cmd). Hier nur als sichtbarer Check.
  step(`node ${process.version} ${process.platform}/${process.arch}`);

  // 1) next build mit Standalone-Output
  step("Schritt 1/4: next build (NEXT_OUTPUT_STANDALONE=1)");
  run(
    process.execPath,
    [path.join(ROOT, "node_modules", "next", "dist", "bin", "next"), "build"],
    { env: { ...process.env, NEXT_OUTPUT_STANDALONE: "1" } },
  );

  if (!(await exists(STANDALONE))) {
    fail(`.next/standalone fehlt nach next build. Pfad: ${STANDALONE}`);
  }

  // 2) Static-Assets in den Standalone uebernehmen (Root Cause 07A-1).
  if (!(await exists(STATIC_SRC))) {
    fail(`.next/static fehlt. Pfad: ${STATIC_SRC}`);
  }
  step("Schritt 2/4: kopiere .next/static -> .next/standalone/.next/static");
  await fs.rm(STATIC_DST, { recursive: true, force: true });
  await copyDir(STATIC_SRC, STATIC_DST);

  // 3) public/* uebernehmen (Standalone uebernimmt nicht alle Subordner zuverlaessig).
  if (await exists(PUBLIC_SRC)) {
    step("Schritt 3/4: kopiere public/* -> .next/standalone/public");
    await fs.rm(PUBLIC_DST, { recursive: true, force: true });
    await copyDir(PUBLIC_SRC, PUBLIC_DST);
  } else {
    step("Schritt 3/4: public/ fehlt - uebersprungen");
  }

  // 4) Sensitive / nicht portable Artefakte aus dem Standalone entfernen.
  const leakedEnv = path.join(STANDALONE, ".env");
  if (await exists(leakedEnv)) {
    step("Schritt 4/4: entferne kopiertes .env aus .next/standalone/");
    await fs.rm(leakedEnv, { force: true });
  }
  const leakedStorage = path.join(STANDALONE, "storage");
  if (await exists(leakedStorage)) {
    step("Schritt 4/4: entferne leeres/portable storage/ aus .next/standalone/");
    await fs.rm(leakedStorage, { recursive: true, force: true });
  }

  step("OK: Standalone-Build vollstaendig (static + public, ohne .env/storage).");
}

main().catch((e) => fail(e?.stack || String(e)));
