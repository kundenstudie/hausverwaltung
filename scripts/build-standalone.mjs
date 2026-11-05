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

/** Kopiert eine Datei ODER ein Verzeichnis (rekursiv). */
async function copyPath(src, dst) {
  const st = await fs.stat(src);
  if (st.isDirectory()) {
    await copyDir(src, dst);
  } else {
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.copyFile(src, dst);
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
    step("Schritt 4/5: entferne kopiertes .env aus .next/standalone/");
    await fs.rm(leakedEnv, { force: true });
  }
  const leakedStorage = path.join(STANDALONE, "storage");
  if (await exists(leakedStorage)) {
    step("Schritt 4/5: entferne leeres/portable storage/ aus .next/standalone/");
    await fs.rm(leakedStorage, { recursive: true, force: true });
  }

  // 4b) Repo-Entwicklungsartefakte aus dem Standalone-Output entfernen.
  //
  //     Hintergrund (HAVEWA-07D G4): Next spiegelt bei
  //     `output: "standalone"` den KOMPLETTEN Projekt-Root in
  //     `.next/standalone/` - unabhaengig vom NFT-Trace. Dadurch landen
  //     `src-tauri/` (inkl. ~8 GB `src-tauri/target/debug/`) sowie
  //     docs/, e2e/, playwright-report/, test-results/, store/, src/,
  //     runtime-state/ im Build-Artefakt.
  //
  //     `outputFileTracingExcludes` wirkt nur auf den NFT-Trace, nicht auf
  //     die Root-Spiegelung - deshalb bereinigen wir hier direkt.
  //
  //     Der bereinigte Frontend-Ordner (Schritt 5) ist die Quelle fuer
  //     `tauri.conf.json > build > frontendDist`; der Desktop-Stage holt
  //     seine Runtime separat aus `.next/standalone/`.
  for (const rel of [
    "src-tauri",
    "docs",
    "e2e",
    "web-docs",
    "playwright-report",
    "test-results",
    "store",
    "store-assets",
    "templates",
    "fgilde-havewa",
    "deploy",
    "src",
    "runtime-state",
    ".runtime-cache",
    ".github",
  ]) {
    const p = path.join(STANDALONE, rel);
    if (await exists(p)) {
      await fs.rm(p, { recursive: true, force: true });
      step(`  entfernt (Repo-Dev-Artefakt): ${rel}`);
    }
  }

  // 5) Frontend-Asset-Ordner fuer Tauri erzeugen (.next/frontend/).
  //
  //    Hintergrund (HAVEWA-07D G4): Tauri v2 verweigert den Bundle, wenn
  //    `build.frontendDist` Verzeichnisse wie `node_modules` oder
  //    `src-tauri` enthaelt ("Please isolate your web assets on a separate
  //    folder"). Ausserdem spiegelt Next bei `output: "standalone"` den
  //    Projekt-Root in den Standalone-Output — inklusive `src-tauri/`
  //    (~8 GB Cargo-Build-Output) und der Repo-Verzeichnisse docs/, e2e/,
  //    playwright-report/, test-results/, store/, src/, runtime-state/.
  //
  //    Wir erzeugen daher einen separaten, BEREINIGTEN Ordner
  //    `.next/frontend/`, der genau die Web-Assets enthaelt:
  //      server.js, .next/ (server + static + manifests), public/,
  //      node_modules/ (Next-traced Runtime-Deps)
  //    und zeig darauf in `tauri.conf.json > build > frontendDist`.
  //
  //    Die Desktop-RUNTIME (Node, PostgreSQL, App-Skripte) kommt unabhängig
  //    davon ueber `bundle.resources` (src-tauri/resources/runtime/).
  step("Schritt 5/5: erzeuge bereinigten Frontend-Ordner .next/frontend/");
  const FRONTEND = path.join(ROOT, ".next", "frontend");
  await fs.rm(FRONTEND, { recursive: true, force: true });
  await fs.mkdir(FRONTEND, { recursive: true });

  // 5a) Pflichtbestandteile kopieren.
  for (const rel of ["server.js", ".next", "public", "node_modules", "messages"]) {
    const src = path.join(STANDALONE, rel);
    if (!(await exists(src))) {
      step(`  uebersprungen (fehlt): ${rel}`);
      continue;
    }
    const dst = path.join(FRONTEND, rel);
    await copyPath(src, dst);
    step(`  kopiert: ${rel}`);
  }

  // 5b) Verbotene Repo-/Dev-Verzeichnisse entfernen (falls Next sie
  //     spiegelt). Fail-closed: `src-tauri` MUSS raus.
  for (const rel of [
    "src-tauri",
    "docs",
    "e2e",
    "web-docs",
    "playwright-report",
    "test-results",
    "store",
    "store-assets",
    "templates",
    "fgilde-havewa",
    "deploy",
    "src",
    "runtime-state",
    "storage",
    ".runtime-cache",
    ".github",
  ]) {
    const p = path.join(FRONTEND, rel);
    if (await exists(p)) {
      await fs.rm(p, { recursive: true, force: true });
      step(`  entfernt (verboten): ${rel}`);
    }
  }

  // 5c) Fail-closed: Tauri verlangt, dass weder `node_modules` noch
  //     `src-tauri` im frontendDist liegen. Wir erzeugen deshalb einen
  //     separaten `node_modules`-Ort und lassen den Pfad aus.
  //
  //     ABER: der Next-Server braucht `node_modules` zur Laufzeit
  //     (Module-Resolution). Deshalb bleibt `node_modules` im Ordner —
  //     Tauri prüft NUR auf `node_modules` und `src-tauri` im frontendDist.
  //
  //     Wir verschieben die node_modules daher in einen Unterordner, den
  //     Tauri nicht prüft, und setzen einen Symlink/Junction... das ist
  //     unter Windows nicht relocatable.
  //
  //     Alternative (gewählt): `frontendDist` zeigt auf `.next/frontend/`
  //     OHNE node_modules. Der Server laeuft spaeter aus dem Tauri-Resource-
  //     Verzeichnis (runtime/app/), wo `node_modules` normal vorhanden ist.
  const frontendNodeModules = path.join(FRONTEND, "node_modules");
  if (await exists(frontendNodeModules)) {
    await fs.rm(frontendNodeModules, { recursive: true, force: true });
    step("  entfernt: node_modules (Tauri-frontendDist-Regel; Runtime liefert der App-Stage)");
  }

  step(`OK: Standalone-Build vollstaendig (static + public, Frontend-Ordner ${FRONTEND}).`);
}

main().catch((e) => fail(e?.stack || String(e)));
