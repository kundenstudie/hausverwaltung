// Verifiziert die Tauri-Resource-Map-Semantik fuer den Desktop-Stage.
//
// Tauri-Semantik (offizielle Doku, v2.12):
//   bundle.resources als Map: {"<quelle>": "<ziel>"}
//   - Quelle relativ zum src-tauri-Verzeichnis (oder absolut)
//   - "dir/" kopiert rekursiv und BEWAHRT die Ordnerstruktur
//   - Ziel "" bedeutet: direkt in das Resource-Verzeichnis
//   - Ziel "runtime/" bedeutet: <RESOURCE>/runtime/...
//
// Auf Windows ist resource_dir() == das Verzeichnis der EXE.
//
// Dieses Skript bildet die Kopie-Semantik nach und prueft das Ergebnis
// an einem isolierten Ziel (simuliert den installierten Bundle-Ordner).

import { existsSync, readdirSync, statSync, cpSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const TAURI_DIR = path.join(REPO_ROOT, "src-tauri");
const CONF_PATH = path.join(TAURI_DIR, "tauri.conf.json");

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`[bundle-proof] ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  â€” " + detail : ""}`);
}

/** LÃ¶st eine Resource-Map-Quelle relativ zum src-tauri-Verzeichnis auf. */
function resolveResourceSource(src) {
  // Absolute Pfade bleiben absolut; relative sind relativ zu src-tauri/.
  if (path.isAbsolute(src)) return src;
  return path.join(TAURI_DIR, src);
}

/**
 * Bildet Tauri-Map-Semantik nach:
 *   key "resources/runtime/"  -> rekursiv kopieren, Struktur erhalten
 *   value "runtime/"          -> relativ zum Resource-Root
 */
function applyResourceMap(resources, resourceRoot) {
  const copied = [];
  for (const [src, dest] of Object.entries(resources)) {
    const srcPath = resolveResourceSource(src);
    if (!existsSync(srcPath)) {
      throw new Error(`Resource-Quelle fehlt: ${srcPath}`);
    }
    const destPath = path.join(resourceRoot, dest);
    mkdirSync(destPath, { recursive: true });
    if (statSync(srcPath).isDirectory()) {
      cpSync(srcPath, destPath, { recursive: true, dereference: true });
      copied.push({ src, dest, kind: "dir" });
    } else {
      cpSync(srcPath, path.join(destPath, path.basename(srcPath)), { dereference: true });
      copied.push({ src, dest, kind: "file" });
    }
  }
  return copied;
}

/** Rekursiver Dev-Pfad-Scan Ã¼ber einen Baum. */
function scanDevPaths(root) {
  const MARKERS = [
    "C:\\Projekte\\PropertyAI",
    "C:/Projekte/PropertyAI",
    ".tools\\",
    ".tools/",
    "foundation\\havewa\\",
    "foundation/havewa/",
    "CARGO_MANIFEST_DIR",
  ];
  const hits = [];
  let files = 0;
  let binaries = 0;
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      files++;
      let buf;
      try { buf = readFileSync(p); } catch { continue; }
      if (buf.some((b) => b === 0)) { binaries++; continue; }
      const txt = buf.toString("utf8");
      for (const m of MARKERS) {
        if (txt.includes(m)) { hits.push({ file: p, marker: m }); break; }
      }
    }
  };
  walk(root);
  return { hits, files, binaries };
}

async function main() {
  const conf = JSON.parse(readFileSync(CONF_PATH, "utf8"));

  console.log("[bundle-proof] ==== TAURI RESOURCE BUNDLE PROOF ====");
  console.log("[bundle-proof] tauri.conf.json:", CONF_PATH);

  // 1) bundle.resources ist als Map konfiguriert.
  const resources = conf.bundle?.resources;
  const isMap = resources && !Array.isArray(resources) && typeof resources === "object";
  check("1. bundle.resources ist eine Map (Quelle -> Ziel)", isMap);
  if (!isMap) {
    console.error("[bundle-proof] FAIL: resources ist keine Map");
    process.exit(1);
  }
  console.log("[bundle-proof] resource map:", JSON.stringify(resources));

  // 2) Die Quelle zeigt auf den G2-Stage.
  const entries = Object.entries(resources);
  check("2. genau eine Resource-Quelle (keine Doppelstruktur)",
    entries.length === 1, `${entries.length} EintrÃ¤ge`);

  const [srcKey, destKey] = entries[0];
  check("3. Quelle == src-tauri/resources/runtime/",
    srcKey.replace(/\\/g, "/") === "resources/runtime/", srcKey);
  check("4. Ziel == runtime/ (installiert: <install-root>\\runtime)",
    destKey.replace(/\\/g, "/") === "runtime/", destKey);

  // 5) Quelle existiert.
  const srcPath = resolveResourceSource(srcKey);
  check("5. Resource-Quelle existiert (G2-Stage)",
    existsSync(srcPath), srcPath);

  // 6) Ziel ist im Resource-Root (kein Unterordner-Nesting).
  check("6. Ziel liegt direkt im Resource-Root",
    !destKey.replace(/\\/g, "/").startsWith("../")
    && !destKey.startsWith("/")
    && !destKey.includes(".."),
    destKey);

  // 7) Bundle-Simulation: Resources in einen isolierten "Install-Root" kopieren.
  const installRoot = path.join(process.env.TEMP || process.env.TMP || "C:\\Temp", "HaVeWa-G3-BundleProof");
  if (existsSync(installRoot)) rmSync(installRoot, { recursive: true, force: true });
  mkdirSync(installRoot, { recursive: true });
  // Das Tauri-Resource-Verzeichnis ist auf Windows das EXE-Verzeichnis.
  const resourceRoot = installRoot;
  const copied = applyResourceMap(resources, resourceRoot);
  console.log("[bundle-proof] kopiert:", JSON.stringify(copied));

  // 8) Runtime-Dateien im simulierten Bundle.
  const runtimeDir = path.join(resourceRoot, "runtime");
  const nodeExe = path.join(runtimeDir, "node", "node.exe");
  const pgExe = path.join(runtimeDir, "postgres", "bin", "postgres.exe");
  const appSrv = path.join(runtimeDir, "app", "server.js");
  check("8. <install-root>\\runtime\\node\\node.exe vorhanden", existsSync(nodeExe));
  check("9. <install-root>\\runtime\\postgres\\bin\\postgres.exe vorhanden", existsSync(pgExe));
  check("10. <install-root>\\runtime\\app\\server.js vorhanden", existsSync(appSrv));

  // 11) Node x64?
  const nb = readFileSync(nodeExe);
  const peOff = nb.readUInt32LE(0x3c);
  const nodeMachine = nb.readUInt16LE(peOff + 4);
  check("11. gebÃ¼ndeltes node.exe ist x64 (0x8664)",
    nodeMachine === 0x8664, `0x${nodeMachine.toString(16)}`);

  // 12) PG-Tools x64?
  let pgOk = true;
  for (const t of ["postgres.exe", "initdb.exe", "pg_ctl.exe", "pg_isready.exe"]) {
    const b = readFileSync(path.join(runtimeDir, "postgres", "bin", t));
    const o = b.readUInt32LE(0x3c);
    if (b.readUInt16LE(o + 4) !== 0x8664) { pgOk = false; console.log(`   ${t} nicht x64`); }
  }
  check("12. gebÃ¼ndelte PG-EXEs sind x64", pgOk);

  // 13) Prisma: nur Windows-Engine.
  //     `query_engine_bg.*` ist die WASM/Browser-Engine (plattformneutral),
  //     KEINE native Plattform-Engine — die zählt nicht.
  const prismaClient = path.join(runtimeDir, "app", "node_modules", ".prisma", "client");
  let engines = [];
  try {
    engines = readdirSync(prismaClient).filter(
      (f) => f.startsWith("libquery_engine-") || f.startsWith("query_engine-"),
    );
  } catch { /* ignore */ }
  const foreign = engines.filter(
    (e) => !e.toLowerCase().includes("windows") && !e.startsWith("query_engine_bg"),
  );
  check("13. Prisma: nur Windows-Engine im Bundle",
    engines.length > 0 && foreign.length === 0,
    `engines=[${engines.join(", ")}]`);

  // 14) Keine .env / Test-/Docs-Artefakte.
  const forbidden = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      const b = path.basename(p);
      if (b === ".env" || b.startsWith(".env.")) forbidden.push(p);
      if (/\.(test|spec)\.(ts|tsx)$/.test(b)) forbidden.push(p);
      const rel = p.replace(/\\/g, "/");
      if (/(^|\/)(docs|e2e|web-docs|playwright-report|test-results|storage|pgdata|runtime-state)(\/|$)/.test(rel)) {
        forbidden.push(p);
      }
    }
  };
  walk(runtimeDir);
  check("14. keine .env / Test-/Docs-Artefakte im Bundle",
    forbidden.length === 0, forbidden.slice(0, 5).join(" | "));

  // 15) Kein .runtime-cache im Bundle.
  check("15. kein .runtime-cache im Bundle",
    !existsSync(path.join(resourceRoot, ".runtime-cache"))
    && !existsSync(path.join(runtimeDir, ".runtime-cache")));

  // 16) Dev-Pfad-Scan Ã¼ber den Bundle-Baum.
  const scan = scanDevPaths(runtimeDir);
  check("16. Dev-Pfad-Scan im Bundle: 0 Treffer",
    scan.hits.length === 0,
    `${scan.files} Dateien (${scan.binaries} binÃ¤r), ${scan.hits.length} Treffer`
    + (scan.hits.length ? ` :: ${JSON.stringify(scan.hits.slice(0, 3))}` : ""));

  console.log("\n[bundle-proof] ==== SUMMARY ====");
  const failed = results.filter((x) => !x.ok);
  for (const x of results) console.log(`  ${x.ok ? "OK  " : "FAIL"} ${x.name}`);
  console.log(`[bundle-proof] ${results.length - failed.length}/${results.length} PASS`);
  console.log(`[bundle-proof] simulated install root: ${installRoot}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("[bundle-proof] FATAL", e?.stack ?? e);
  process.exit(1);
});
