// HAVEWA-07D G3 — Desktop-Release-Build-Orchestrator.
//
// Führt die Desktop-Build-Kette DETERMINISTISCH aus:
//
//   1. build-standalone.mjs       (Next-Standalone-Build)
//   2. package-desktop-runtime.mjs (Runtime-Stage aus dem G1-Cache)
//   3. verify-desktop-runtime.mjs  (Stage-Verifikation, fail-closed)
//   4. cargo build --target x86_64-pc-windows-msvc  (Tauri-EXE)
//
// GRUND der Reihenfolge (Auftrag §5):
//   Die Turbopack-Modul-Aliase (`@prisma/client-<16hex>`) sind
//   build-abhängig. `package-desktop-runtime.mjs` liest sie aus dem
//   gerade erzeugten Build-Artefakt
//   (`.next/standalone/.next/node_modules/`). Ein Packaging eines
//   alten/stale Stage würde einen Alias pinnen, den der neue Bundle
//   nicht referenziert — der Server startet dann nicht.
//
// Bei Fehler eines Schritts: HARD STOP (kein weiterer Schritt).
//
// CLI:
//   node scripts/build-desktop-release.mjs
//   node scripts/build-desktop-release.mjs --skip-cargo   (nur Stage bauen)
//   node scripts/build-desktop-release.mjs --target x86_64-pc-windows-msvc
//
// Der Stage selbst liegt in `src-tauri/resources/runtime/` und ist
// gitignored. Er wird von `tauri build` als Resource gebündelt.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_TARGET = "x86_64-pc-windows-msvc";

function info(msg) {
  process.stdout.write(`[build-desktop-release] ${msg}\n`);
}
function fail(msg, code = 1) {
  process.stderr.write(`[build-desktop-release] FAIL: ${msg}\n`);
  process.exit(code);
}

/**
 * Führt einen Schritt aus und wirft bei Fehler.
 * `stdio: inherit` — der Output gehört dem Build-Log.
 */
function runStep(label, exe, args, opts = {}) {
  info(`── ${label} ──`);
  info(`${label}: ${exe} ${args.join(" ")}`);
  const r = spawnSync(exe, args, {
    cwd: opts.cwd ?? REPO_ROOT,
    shell: false,
    stdio: "inherit",
    env: { ...process.env, ...(opts.env ?? {}) },
  });
  if (r.error) {
    fail(`${label}: ${r.error.message}`);
  }
  if (r.status !== 0) {
    fail(`${label}: exit=${r.status}`);
  }
  info(`${label}: OK`);
}

function parseArgs(argv) {
  const out = { skipCargo: false, target: DEFAULT_TARGET, bundles: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--skip-cargo") { out.skipCargo = true; continue; }
    if (a === "--target") { out.target = argv[++i]; continue; }
    if (a === "--bundles") { out.bundles = argv[++i]; continue; }
    if (a === "--help" || a === "-h") {
      process.stdout.write(
        "Usage: node scripts/build-desktop-release.mjs [--skip-cargo] "
        + "[--target <triple>] [--bundles <list>]\n",
      );
      process.exit(0);
    }
  }
  return out;
}

/** Ermittelt die Cargo-EXE (ohne PATH-Abhängigkeit). */
function resolveCargo() {
  const candidates = [];
  if (process.env.CARGO) candidates.push(process.env.CARGO);
  if (process.env.USERPROFILE) {
    candidates.push(path.join(process.env.USERPROFILE, ".cargo", "bin", "cargo.exe"));
    candidates.push(path.join(process.env.USERPROFILE, ".cargo", "bin", "cargo"));
  }
  candidates.push("cargo");
  candidates.push("cargo.exe");
  for (const c of candidates) {
    if (c.includes(path.sep) || path.isAbsolute(c)) {
      if (existsSync(c)) return c;
    } else {
      // Auf PATH suchen.
      const found = spawnSync("where", [c], { shell: true, encoding: "utf8" });
      if (found.status === 0) {
        const first = (found.stdout || "").split(/\r?\n/)[0].trim();
        if (first) return first;
      }
    }
  }
  return null;
}

/**
 * G6: PATH-Umgebung fuer Kindprozesse, damit `cargo` gefunden wird.
 *
 * Hintergrund: Die Tauri-CLI (`tauri build`) ruft selbst `cargo metadata`
 * auf. Ist `cargo` nicht im PATH des Kindprozesses (z. B. weil Rust nur
 * unter `%USERPROFILE%\.cargo\bin` installiert ist und der PATH des
 * aufrufenden Prozesses nicht dorthin zeigt), bricht der Bundle-Schritt
 * mit "program not found" ab.
 *
 * Wir ergaenzen daher das Verzeichnis der aufgeloesten Cargo-EXE am ANFANG
 * des PATH. Das aendert die Toolchain-Auswahl NICHT (es ist genau die
 * Cargo-EXE, die auch Schritt 4/6 benutzt) — es macht den Bundle-Schritt
 * nur unabhaengig vom PATH des aufrufenden Prozesses.
 */
function pathWithCargo(cargoExe) {
  const current = process.env.PATH || "";
  if (!cargoExe) return current;
  const cargoDir = path.dirname(cargoExe);
  if (!existsSync(cargoDir)) return current;
  const entries = current.split(path.delimiter).filter(Boolean);
  if (entries.some((e) => path.resolve(e).toLowerCase() === path.resolve(cargoDir).toLowerCase())) {
    return current;
  }
  return [cargoDir, ...entries].join(path.delimiter);
}

/**
 * Ermittelt die projektlokale Tauri-CLI und den Aufruf-Kommando.
 *
 * Bevorzugt wird die PROJEKTLOKALE CLI (devDependency `@tauri-apps/cli`),
 * damit keine globale cargo-tauri-Installation nötig ist und die
 * CLI-Version exakt zur Rust-Crate-Version passt.
 *
 * WICHTIG (Windows): `node_modules/.bin/tauri.cmd` ist eine Batch-Datei und
 * kann mit `spawnSync(..., { shell: false })` NICHT gestartet werden
 * (EINVAL). Wir rufen daher die CLI direkt über Node auf:
 *   node node_modules/@tauri-apps/cli/tauri.js <args>
 * Das ist plattformneutral, braucht kein Shell und nutzt dieselbe
 * x64-Node-Toolchain wie der restliche Build.
 */
function resolveTauriCli() {
  const cliEntry = path.join(
    REPO_ROOT, "node_modules", "@tauri-apps", "cli", "tauri.js",
  );
  if (existsSync(cliEntry)) {
    return { exe: process.execPath, prefixArgs: [cliEntry] };
  }
  // Fallback: irgendein `tauri` im PATH (mit shell, weil .cmd).
  const found = spawnSync("where", ["tauri"], { shell: true, encoding: "utf8" });
  if (found.status === 0) {
    const first = (found.stdout || "").split(/\r?\n/)[0].trim();
    if (first) return { exe: first, prefixArgs: [] };
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  info(`repo:   ${REPO_ROOT}`);
  info(`target: ${args.target}`);
  info("build order: build-bootstrap -> package-runtime -> build-standalone "
    + "-> package-desktop-runtime -> verify-desktop-runtime -> cargo build");

  // Der Stage darf KEINEN alten Inhalt behalten. package-desktop-runtime.mjs
  // setzt den Stage ohnehin komplett neu auf (resetStage), aber wir prüfen
  // zusätzlich, dass der Cache (G1) überhaupt vorhanden ist.
  const cacheRoot = path.join(REPO_ROOT, ".runtime-cache", "downloads");
  if (!existsSync(cacheRoot)) {
    fail(`G1-Cache fehlt: ${cacheRoot}. Bitte zuerst 'node scripts/runtime-assets.mjs prepare' ausführen.`);
  }

  // 0a) Bootstrap kompilieren (prisma/bootstrap.ts -> scripts/dist/bootstrap.js).
  //     package-desktop-runtime.mjs braucht das Ergebnis.
  runStep(
    "0a/6 build-bootstrap",
    process.execPath,
    [path.join(SCRIPT_DIR, "build-bootstrap.mjs")],
  );

  // 0b) Prisma-CLI-Runtime-Tree bauen (scripts/.runtime/prisma-cli/).
  //     package-desktop-runtime.mjs braucht das Ergebnis.
  runStep(
    "0b/6 package-runtime",
    process.execPath,
    [path.join(SCRIPT_DIR, "package-runtime.mjs")],
  );

  // 1) Next-Standalone-Build.
  //    NEXT_OUTPUT_STANDALONE=1 aktiviert output: "standalone".
  runStep(
    "1/6 build-standalone",
    process.execPath,
    [path.join(SCRIPT_DIR, "build-standalone.mjs")],
    { env: { NEXT_OUTPUT_STANDALONE: "1" } },
  );

  // 2) Runtime-Stage bauen (liest die Turbopack-Aliase aus dem frischen Build).
  runStep(
    "2/6 package-desktop-runtime",
    process.execPath,
    [path.join(SCRIPT_DIR, "package-desktop-runtime.mjs")],
  );

  // 3) Stage verifizieren (fail-closed).
  runStep(
    "3/6 verify-desktop-runtime",
    process.execPath,
    [path.join(SCRIPT_DIR, "verify-desktop-runtime.mjs")],
  );

  if (args.skipCargo) {
    info("cargo build + NSIS-Bundle übersprungen (--skip-cargo)");
    info("OK");
    return;
  }

  // 4) Tauri-EXE bauen (x64 only).
  const cargo = resolveCargo();
  if (!cargo) {
    fail("cargo nicht gefunden (weder im PATH noch unter %USERPROFILE%\\.cargo\\bin)");
  }
  const tauriDir = path.join(REPO_ROOT, "src-tauri");
  runStep(
    "4/6 cargo build",
    cargo,
    ["build", "--release", "--target", args.target],
    { cwd: tauriDir },
  );

  // 5) NSIS-Installer bauen (echter Tauri-v2-Bundle).
  //
  //    Die projektlokale CLI (@tauri-apps/cli, devDependency) orchestriert
  //    den Bundle. Sie nutzt selbst den Target aus tauri.conf.json /
  //    --target; wir übergeben es explizit.
  //
  //    WICHTIG: `tauri build` führt `beforeBuildCommand` aus. Wir setzen ihn
  //    leer (tauri.conf.json), damit der Stage NICHT doppelt gebaut wird —
  //    der Stage ist bereits frisch aus Schritt 2/3.
  const tauriCli = resolveTauriCli();
  if (!tauriCli) {
    fail("Tauri-CLI nicht gefunden (node_modules/@tauri-apps/cli/tauri.js). "
      + "Bitte 'npm install' ausführen (devDependency @tauri-apps/cli).");
  }
  const tauriArgs = [
    ...tauriCli.prefixArgs,
    "build",
    "--target",
    args.target,
  ];
  if (args.bundles) tauriArgs.push("--bundles", args.bundles);
  runStep(
    "5/6 tauri build (NSIS)",
    tauriCli.exe,
    tauriArgs,
    // G6: Die Tauri-CLI ruft selbst `cargo metadata` auf. Wir geben ihr
    //     deshalb ein PATH, in dem die aufgeloeste Cargo-EXE liegt.
    { cwd: REPO_ROOT, env: { PATH: pathWithCargo(cargo) } },
  );

  info("OK");
}

main().catch((e) => fail(e?.stack || String(e)));

// Der Import von pathToFileURL ist nur für Konsistenz mit den anderen
// Skripten — er wird hier nicht benötigt, aber die Datei bleibt konsistent.
void pathToFileURL;
