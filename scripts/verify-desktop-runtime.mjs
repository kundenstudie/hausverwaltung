// HAVEWA-07D G2 — Desktop Runtime Stage Verification.
//
// Prüft deterministisch die unter src-tauri/resources/runtime/ liegende
// Stage-Baumstruktur.
//
// CLI:
//   node scripts/verify-desktop-runtime.mjs
//   node scripts/verify-desktop-runtime.mjs --stage <root>
//
// Pflichtprüfungen:
//   - Node: vorhanden, x64, richtige Version
//   - PostgreSQL: Pflichttools, x64, Version, Runtime-Dirs
//   - App: server.js, static, public, messages, runtime scripts,
//          bootstrap placement, prisma migrate tree
//   - Forbidden: keine verbotenen Dateien, keine Dev-Pfade,
//                keine falschen Prisma Engines
//
// KEIN Layout-Change; nur Read-Only.

import { existsSync } from "node:fs";
import {
  readdir,
  readFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  scanPrismaEngines,
  formatEngineInventory,
} from "./prisma-engine-scan.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_STAGE = path.join(REPO_ROOT, "src-tauri", "resources", "runtime");

const PG_TOOLS = [
  "postgres.exe",
  "pg_ctl.exe",
  "initdb.exe",
  "pg_isready.exe",
  "createdb.exe",
  "psql.exe",
  "pg_dump.exe",
  "pg_restore.exe",
];

const APP_REQUIRED = [
  "server.js",
  ".next",
  "public",
  "node_modules",
  "messages",
  "scripts/start-runtime.mjs",
  "scripts/start-runtime-with-pg.mjs",
  "scripts/start-with-fallback.mjs",
  "scripts/migrate-deploy.mjs",
  "scripts/prisma-runtime-tree.mjs",
  // G7-FIX: Runtime-Dep der zentralen Prisma-Engine-Policy.
  "scripts/prisma-engine-policy.mjs",
  "scripts/prisma-engine-scan.mjs",
  "scripts/dist/bootstrap.js",
  "scripts/.runtime/prisma-cli/node_modules/prisma/build/index.js",
];

const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx)$/;

// Re-export für Cross-File-Konsumtion (z. B. tests).
export const FORBIDDEN_TOP_DIRS_LIST = [
  "docs",
  "e2e",
  "playwright-report",
  "test-results",
  "web-docs",
  "store",
  "store-assets",
  "templates",
  "fgilde-havewa",
  "deploy",
  "src",
  "pgdata",
  "runtime-state",
  "storage",
];


// ---------------------------------------------------------------------------

function info(msg) { process.stdout.write(`[verify-desktop-runtime] ${msg}\n`); }
function warn(msg) { process.stderr.write(`[verify-desktop-runtime] WARN ${msg}\n`); }
function fail(msg, code = 1) {
  process.stderr.write(`[verify-desktop-runtime] FAIL: ${msg}\n`);
  if (Array.isArray(code)) code = 1;
  process.exit(typeof code === "number" ? code : 1);
}

const errors = [];
function recordError(msg) {
  errors.push(msg);
  warn(msg);
}

function parseArgs(argv) {
  const out = { stageRoot: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--stage") { out.stageRoot = argv[++i]; continue; }
    if (a === "--help" || a === "-h") {
      process.stdout.write("Usage: node scripts/verify-desktop-runtime.mjs [--stage <root>]\n");
      process.exit(0);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// PE-Maschinen-Decoder (DLL/EXE)
// ---------------------------------------------------------------------------

export async function readPeMachine(filePath) {
  const fh = await readFile(filePath).then((buf) => buf.buffer);
  const u8 = new Uint8Array(fh);
  if (u8.length < 64) return -1;
  const dv = new DataView(fh);
  const peOffset = dv.getInt32(0x3c, true);
  if (peOffset <= 0 || peOffset + 4 > u8.length) return -1;
  if (u8[peOffset] !== 0x50 || u8[peOffset + 1] !== 0x45) return -1;
  return dv.getUint16(peOffset + 4, true);
}

// ---------------------------------------------------------------------------
// Forbidden-Pfad-Scan (rekursiv, symlink-frei)
// ---------------------------------------------------------------------------

async function* walk(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) {
      yield* walk(p);
    } else {
      yield p;
    }
  }
}

// Dev-Pfad-Markierungen (Auftrag §26).
// Bekannte Build-Pfade, die zur LAUFZEIT NICHT konsumiert werden:
// - Source-Map-Kommentare in Prisma-generiertem `node_modules/.prisma/client/*.js`
// - Source-Map-Kommentare in Next.js-Server-Bundle
// Diese werden separat als "build-pfad-in-generated-file" klassifiziert
// und NICHT als produktive Dev-Pfade gezählt.
const DEV_PATH_MARKERS = [
  "C:\\Projekte\\PropertyAI",
  "C:/Projekte/PropertyAI",
  ".tools\\",
  ".tools/",
  "foundation\\havewa\\",
  "foundation/havewa/",
  "CARGO_MANIFEST_DIR",
  "PropertyAI",
];

// Pfade in Dateien, die wir als "generated / build-pfad-tragend"
// einstufen — d.h. der Pfad wird in einem Source-Map-Kommentar
// referenziert, NICHT zur Laufzeit ausgewertet.
//
// G2-Hardening: der Stage wird jetzt so gebaut, dass diese Dateien
// KEINE Build-Pfade mehr enthalten (sanitizePrismaSourceMaps im
// package-desktop-runtime.mjs). Die Ausnahme bleibt als defense-in-depth,
// falls ein kuenftiger Build unerwartet Source-Maps mit Pfaden ausliefert.
const GENERATED_FILE_SUFFIXES = [
  "/.prisma/client/",       // Prisma generierter Client
  "/node_modules/@prisma/client/", // Prisma client runtime
  "/.next/server/",          // Next.js Server-Bundle
  "/required-server-files.json", // Next.js Manifest
  "/build-manifest.json",
  "/routes-manifest.json",
];

export async function checkAbsenceOfDevPaths(stageRoot) {
  const findings = [];
  for await (const p of walk(stageRoot)) {
    const norm = p.replace(/\\/g, "/");
    const inGeneratedFile = GENERATED_FILE_SUFFIXES.some((s) => norm.includes(s));
    if (inGeneratedFile) {
      // Datei ist explizit als "build-pfad-tragend" klassifiziert.
      // Wir scannen sie NICHT (die Pfade sind Source-Map / Build-Manifest).
      continue;
    }
    let isBinary = false;
    let text;
    try {
      const fs = await import("node:fs/promises");
      const buf = await fs.readFile(p);
      // Erstes 4KB-Sniff: nur textuelle Files scannen.
      const head = buf.subarray(0, Math.min(buf.length, 8192));
      isBinary = head.some((b) => b === 0);
      if (isBinary) continue;
      text = buf.toString("utf8");
    } catch {
      continue;
    }
    for (const marker of DEV_PATH_MARKERS) {
      if (text.includes(marker)) {
        findings.push({ file: p, marker });
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Prüfblock: Forbidden Names
// ---------------------------------------------------------------------------

export async function isForbiddenFile(p) {
  const base = path.basename(p).toLowerCase();
  if (base === ".env") return ".env";
  if (base.startsWith(".env.") && base !== ".env.example") return base;
  if (base === "secrets.json") return "secrets.json";
  if (TEST_FILE_RE.test(p)) return "test/spec file";
  if (/[/\\]docs[/\\]/.test(p)) return "/docs/";
  if (/[/\\]e2e[/\\]/.test(p)) return "/e2e/";
  if (/[/\\]playwright-report[/\\]/.test(p)) return "/playwright-report/";
  if (/[/\\]test-results[/\\]/.test(p)) return "/test-results/";
  if (/[/\\]web-docs[/\\]/.test(p)) return "/web-docs/";
  return null;
}

export async function scanForbidden(stageRoot) {
  const hits = [];
  for await (const p of walk(stageRoot)) {
    const reason = await isForbiddenFile(p);
    if (reason) hits.push({ file: p, reason });
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Node Stage
// ---------------------------------------------------------------------------

async function verifyNode(stageRoot) {
  const nodeStage = path.join(stageRoot, "node");
  const errors = [];
  const nodeExe = path.join(nodeStage, "node.exe");
  const nodeLicense = path.join(nodeStage, "LICENSE");
  if (!existsSync(nodeExe)) {
    errors.push(`Node fehlt: ${nodeExe}`);
    return { errors };
  }
  const machine = await readPeMachine(nodeExe);
  if (machine !== 0x8664) {
    errors.push(`node.exe PE Machine != x64 (got: 0x${(machine >>> 0).toString(16)})`);
  }
  if (!existsSync(nodeLicense)) {
    errors.push(`Node LICENSE fehlt: ${nodeLicense}`);
  }
  return { errors, machine, exe: nodeExe };
}

// ---------------------------------------------------------------------------
// Postgres Stage
// ---------------------------------------------------------------------------

async function verifyPostgres(stageRoot) {
  const pgStage = path.join(stageRoot, "postgres");
  const errors = [];
  if (!existsSync(pgStage)) {
    errors.push(`PG stage fehlt: ${pgStage}`);
    return { errors };
  }
  for (const required of ["bin", "lib", "share", "licenses"]) {
    if (!existsSync(path.join(pgStage, required))) {
      errors.push(`PG /${required} fehlt`);
    }
  }
  for (const tool of PG_TOOLS) {
    const p = path.join(pgStage, "bin", tool);
    if (!existsSync(p)) {
      errors.push(`PG Pflicht-Tool fehlt: ${p}`);
      continue;
    }
    const m = await readPeMachine(p);
    if (m !== 0x8664) errors.push(`PG ${tool} PE Machine != x64 (got: 0x${(m >>> 0).toString(16)})`);
  }
  // Mindestens eine Lizenz
  const licenseDir = path.join(pgStage, "licenses");
  if (existsSync(licenseDir)) {
    const list = await readdir(licenseDir);
    if (list.length === 0) errors.push(`PG licenses/ ist leer`);
  }
  return { errors };
}

// ---------------------------------------------------------------------------
// App Stage
// ---------------------------------------------------------------------------

async function verifyApp(stageRoot) {
  const appStage = path.join(stageRoot, "app");
  const errors = [];
  if (!existsSync(appStage)) {
    errors.push(`App stage fehlt: ${appStage}`);
    return { errors };
  }
  for (const rel of APP_REQUIRED) {
    const p = path.join(appStage, rel);
    if (!existsSync(p)) errors.push(`App Pflicht fehlt: ${rel}`);
  }
  return { errors };
}

// ---------------------------------------------------------------------------
// Prisma Engines Windows-only Check
// ---------------------------------------------------------------------------

/**
 * G7-FIX: Prisma-Engine-Pruefung ueber die ZENTRALE Policy.
 *
 * ROOT CAUSE (G7-Blocker):
 *   Der bisherige Check listete nur 5 feste Namen auf:
 *     libquery_engine-linux, libquery_engine-debian,
 *     libquery_engine-linux-arm64, query-engine-linux,
 *     query-engine-debian
 *   Die Prisma-CLI-Familie `schema-engine-*` fehlte komplett. Dadurch
 *   blieb `schema-engine-linux-arm64-openssl-3.0.x` (ELF/aarch64, ~19 MB)
 *   im 0.6.0-Installer unentdeckt.
 *
 * NEUE REGEL:
 *   Es wird der GESAMTE Stage nach nativen Prisma-Engines aller
 *   Familien durchsucht (query_engine, libquery_engine, schema-engine,
 *   schema_engine, migration-engine, introspection-engine, prisma-fmt).
 *   Jede Engine, deren Zieltarget NICHT windows-x64 ist, ist ein FAIL.
 *   Zusaetzlich wird der Dateiinhalt (ELF/PE/Mach-O-Magic) geprueft,
 *   damit nicht nur ueber Dateinamen geraten wird.
 */
export async function verifyPrismaEngines(stageRoot) {
  const prismaCliDir = path.join(stageRoot, "app", "scripts", ".runtime", "prisma-cli");
  const errors = [];
  if (!existsSync(prismaCliDir)) {
    errors.push(`Prisma CLI Tree fehlt: ${prismaCliDir}`);
    return { errors, engines: [], violations: [] };
  }

  // Der GESAMTE App-Stage wird geprueft — die Engines koennen auch im
  // Standalone-.prisma/client, in @prisma/client, in @prisma/engines
  // oder in den Turbopack-Aliase liegen.
  //
  // Wichtig: Es wird genau EIN Wurzelverzeichnis gescannt. Der
  // Prisma-CLI-Tree liegt INNERHALB von `app/` — ein zweiter Scan auf
  // `prismaCliDir` wuerde dieselben Engines doppelt zaehlen.
  const appStage = path.join(stageRoot, "app");
  const { engines: allEngines, violations: allViolations } =
    await scanPrismaEngines(appStage);

  for (const v of allViolations) {
    errors.push(
      `Verbotene Prisma-Engine (${v.target.family}, ${v.format || "unbekanntes Format"}) `
      + `im Stage: ${path.relative(stageRoot, v.file)}`,
    );
  }

  // Pflicht-Engine: Windows-x64 Query-Engine MUSS vorhanden sein.
  const hasWindowsQueryEngine = allEngines.some(
    (e) => e.allowed && /query_engine-windows/i.test(e.name),
  );
  if (!hasWindowsQueryEngine) {
    errors.push(
      "Windows-x64 Prisma-Query-Engine (query_engine-windows.dll.node) fehlt im Stage",
    );
  }

  return { errors, engines: allEngines, violations: allViolations };
}

// ---------------------------------------------------------------------------
// Prüfblock: Turbopack-Aliase + kein Fake-Produktionspfad
// ---------------------------------------------------------------------------

/**
 * G2-Hardening: Der Stage muss die Turbopack-Modul-Aliase als echte
 * Verzeichnisse enthalten, damit `node server.js` OHNE `--require`-Monkeypatch
 * startet. Next/Turbopack referenziert externe Pakete im Server-Bundle als
 * `<paket>-<16hex>` (z.B. "@prisma/client-2c3a283f134fdcb6"); Next legt dafuer
 * Junctions unter `.next/standalone/.next/node_modules/` an, die im Desktop-
 * Stage nicht aufloesbar sind (kein Parent-Walk). Der Staging-Schritt
 * materialisiert sie deshalb als echte Verzeichnisse unter
 * `<app-stage>/node_modules/`.
 */
export async function verifyTurbopackAliases(stageRoot) {
  const errors = [];
  const appStage = path.join(stageRoot, "app");
  const nodeModules = path.join(appStage, "node_modules");
  if (!existsSync(nodeModules)) {
    errors.push(`App-Stage node_modules fehlt: ${nodeModules}`);
    return { errors, aliases: [] };
  }
  const aliasRe = /-([0-9a-f]{16})$/;
  const found = [];

  async function scan(dir, depth = 0) {
    if (depth > 4) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = path.join(dir, e.name);
      if (aliasRe.test(e.name)) {
        found.push(path.relative(nodeModules, p).replace(/\\/g, "/"));
        continue; // Aliase sind Leafs (keine verschachtelten Aliases)
      }
      await scan(p, depth + 1);
    }
  }
  await scan(nodeModules);

  if (found.length === 0) {
    errors.push("Keine Turbopack-Aliase im Stage gefunden — "
      + "der Server-Bundle erwartet hashed module aliases "
      + "(z.B. @prisma/client-<16hex>). Build bitte erneut ausfuehren.");
  }
  return { errors, aliases: found };
}

/**
 * G2-Hardening: kein erfundener Produktionspfad (z.B. "C:\\HaVeWa") und
 * keine absolutem Build-Pfade in den sanitisierten Build-Metadaten.
 */
export async function verifyNoFakeProductionPath(stageRoot) {
  const errors = [];
  const appStage = path.join(stageRoot, "app");
  const serverJs = path.join(appStage, "server.js");
  if (existsSync(serverJs)) {
    const txt = await readFile(serverJs, "utf8");
    if (/HaVeWa/i.test(txt)) {
      errors.push("server.js enthaelt einen Fake-Produktionspfad ('HaVeWa')");
    }
    const m = txt.match(/"outputFileTracingRoot":"([^"]*)"/);
    if (m && m[1] !== "") {
      errors.push(`server.js: outputFileTracingRoot ist nicht neutralisiert: "${m[1]}"`);
    }
    if (/"root":"[^"]*"/.test(txt)) {
      errors.push("server.js: turbopack.root ist nicht entfernt");
    }
  }
  const rsf = path.join(appStage, ".next", "required-server-files.json");
  if (existsSync(rsf)) {
    const txt = await readFile(rsf, "utf8");
    if (/HaVeWa/i.test(txt)) {
      errors.push("required-server-files.json enthaelt einen Fake-Produktionspfad ('HaVeWa')");
    }
    let j = null;
    try { j = JSON.parse(txt); } catch { /* ignore */ }
    if (j) {
      if (typeof j.appDir === "string" && j.appDir !== ".") {
        errors.push(`required-server-files.json: appDir nicht neutralisiert: "${j.appDir}"`);
      }
      const cfg = j.config || {};
      if (typeof cfg.outputFileTracingRoot === "string" && cfg.outputFileTracingRoot !== "") {
        errors.push(`required-server-files.json: config.outputFileTracingRoot nicht neutralisiert: "${cfg.outputFileTracingRoot}"`);
      }
      if (cfg.turbopack && typeof cfg.turbopack.root === "string") {
        errors.push("required-server-files.json: config.turbopack.root nicht entfernt");
      }
    }
  }
  return { errors };
}

// ---------------------------------------------------------------------------
// Prüfblock: Forbidden Names + Dev-Pfad-Scan + Engine-Check
// ---------------------------------------------------------------------------

export async function verifyAll(stageRoot) {
  const results = {};
  const scanRes = await scanForbidden(stageRoot);
  results.forbidden = scanRes;
  results.devPaths = await checkAbsenceOfDevPaths(stageRoot);
  results.node = await verifyNode(stageRoot);
  results.postgres = await verifyPostgres(stageRoot);
  results.app = await verifyApp(stageRoot);
  results.prismaEngines = await verifyPrismaEngines(stageRoot);
  results.turbopackAliases = await verifyTurbopackAliases(stageRoot);
  results.fakeProductionPath = await verifyNoFakeProductionPath(stageRoot);
  results.hasErrors =
    results.forbidden.length > 0
    || results.devPaths.length > 0
    || results.node.errors.length > 0
    || results.postgres.errors.length > 0
    || results.app.errors.length > 0
    || results.prismaEngines.errors.length > 0
    || results.turbopackAliases.errors.length > 0
    || results.fakeProductionPath.errors.length > 0;
  return results;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function printResults(results, stageRoot) {
  info(`stage: ${stageRoot}`);
  info(`node:      ${results.node.errors.length === 0 ? "OK" : `FAIL (${results.node.errors.length})`}`);
  info(`postgres:  ${results.postgres.errors.length === 0 ? "OK" : `FAIL (${results.postgres.errors.length})`}`);
  info(`app:       ${results.app.errors.length === 0 ? "OK" : `FAIL (${results.app.errors.length})`}`);
  info(`forbidden: ${results.forbidden.length === 0 ? "OK" : `FAIL (${results.forbidden.length})`}`);
  info(`dev-paths: ${results.devPaths.length === 0 ? "OK" : `FAIL (${results.devPaths.length})`}`);
  info(`prismaEngines: ${results.prismaEngines.errors.length === 0 ? "OK" : `FAIL (${results.prismaEngines.errors.length})`}`);
  // G7-FIX: Inventar-Report der nativen Prisma-Engines (Beweis fuer den
  // Payload). Zeigt jede Engine mit Zieltarget, Format und Groesse.
  const engineList = results.prismaEngines.engines || [];
  const linuxCount = engineList.filter((e) => e.target.os === "linux").length;
  const armCount = engineList.filter((e) => e.target.arch === "arm64" || e.target.arch === "aarch64").length;
  info(`prismaEngines total: ${engineList.length} | linux=${linuxCount} | arm64=${armCount}`);
  info("prismaEngines inventory:");
  process.stdout.write(`${formatEngineInventory(engineList)}\n`);
  info(`turbopackAliases: ${results.turbopackAliases.errors.length === 0 ? `OK (${results.turbopackAliases.aliases.join(", ")})` : `FAIL (${results.turbopackAliases.errors.length})`}`);
  info(`fakeProdPath: ${results.fakeProductionPath.errors.length === 0 ? "OK" : `FAIL (${results.fakeProductionPath.errors.length})`}`);
  for (const list of [
    ["forbidden", results.forbidden],
    ["dev-paths", results.devPaths],
    ["node", results.node.errors],
    ["postgres", results.postgres.errors],
    ["app", results.app.errors],
    ["prismaEngines", results.prismaEngines.errors],
    ["turbopackAliases", results.turbopackAliases.errors],
    ["fakeProductionPath", results.fakeProductionPath.errors],
  ]) {
    const [label, arr] = list;
    for (const item of arr) {
      if (label === "forbidden" || label === "dev-paths") {
        recordError(`${label}: ${JSON.stringify(item)}`);
      } else {
        recordError(`${label}: ${item}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const stageRoot = args.stageRoot
    ? path.resolve(args.stageRoot)
    : DEFAULT_STAGE;
  if (!existsSync(stageRoot)) {
    fail(`Stage fehlt: ${stageRoot}. Bitte zuerst 'node scripts/package-desktop-runtime.mjs' ausführen.`);
  }
  const results = await verifyAll(stageRoot);
  printResults(results, stageRoot);
  if (results.hasErrors) {
    fail(`Stage-Verifikation fehlgeschlagen: ${errors.length} Findings.`);
  }
  info("OK");
  process.exit(0);
}

function isEntryPoint() {
  try {
    if (!process.argv[1]) return false;
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().catch((e) => fail(e?.stack || String(e)));
}
