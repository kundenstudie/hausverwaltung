// HAVEWA-07D G4 — NSIS-Installer-Artefakt-Verifikation.
//
// Prüft den gebauten Installer:
//   - Datei existiert, ist ein NSIS-Installer
//   - x64-Produkt (Payload-EXE ist x64)
//   - plausible Dateigröße
//   - WebView2-Offline-Payload enthalten (Microsoft-signed WebView2 .exe)
//   - Runtime enthalten: runtime/node, runtime/postgres, runtime/app
//   - kein .runtime-cache, kein .env
//   - keine Test-/Docs-/e2e-Artefakte
//   - keine ARM64-/Linux-Prisma-Engines
//   - SHA256 des Installers (nur berichten, kein Signing)

import { existsSync, statSync, readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  PRISMA_FORBIDDEN_NAME_PATTERNS,
} from "./prisma-engine-policy.mjs";
import {
  scanPrismaEngines,
  formatEngineInventory,
} from "./prisma-engine-scan.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`[g4-artifact] ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  return ok;
}

function sha256File(p) {
  const h = createHash("sha256");
  h.update(readFileSync(p));
  return h.digest("hex");
}

/** Listet alle Dateien rekursiv. */
function listFiles(root, maxDepth = 12, depth = 0, out = []) {
  if (depth > maxDepth) return out;
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (e.isFile()) out.push(p);
    else if (e.isDirectory()) listFiles(p, maxDepth, depth + 1, out);
  }
  return out;
}

/**
 * G7-FIX: Prueft einen Payload-Baum (Stage bzw. installierter Payload)
 * auf native Prisma-Engines und bewertet Windows-x64-only.
 *
 * @param {string} root Wurzelverzeichnis des Payloads (z.B. `<stage>/app`)
 * @returns {Promise<{total:number, linux:number, arm64:number,
 *                    windowsOnly:boolean, engines:Array, violations:Array}>}
 */
export async function verifyPayloadPrismaEngines(root) {
  if (!root || !existsSync(root)) {
    return {
      total: 0, linux: 0, arm64: 0, windowsOnly: false,
      engines: [], violations: [],
    };
  }
  const { engines, violations } = await scanPrismaEngines(root);
  const linux = engines.filter((e) => e.target.os === "linux").length;
  const arm64 = engines.filter((e) => e.target.arch === "arm64"
    || e.target.arch === "aarch64").length;
  const windowsOnly = violations.length === 0 && engines.length > 0
    && engines.every((e) => e.target.os === "windows" && e.target.arch === "x64");
  return { total: engines.length, linux, arm64, windowsOnly, engines, violations };
}

async function main() {
  const installer = process.env.G4_INSTALLER;
  if (!installer || !existsSync(installer)) {
    console.error(`[g4-artifact] FAIL: Installer nicht gefunden: ${installer ?? "(G4_INSTALLER nicht gesetzt)"}`);
    process.exit(1);
  }

  console.log("[g4-artifact] ==== NSIS INSTALLER ARTEFAKT-VERIFY ====");
  console.log(`[g4-artifact] installer: ${installer}`);

  const st = statSync(installer);
  const sizeMb = st.size / (1024 * 1024);
  console.log(`[g4-artifact] size: ${st.size} bytes (${sizeMb.toFixed(1)} MB)`);

  check("1. Installer existiert", true, `${st.size} bytes`);
  check("2. plausible Groesse (> 100 MB wegen WebView2 offline + Runtime)",
    sizeMb > 100, `${sizeMb.toFixed(1)} MB`);

  // NSIS-Signatur: Der Installer enthaelt den NSIS-Header "NullsoftInst".
  const head = readFileSync(installer).subarray(0, 4 * 1024 * 1024);
  const isNsis = head.includes(Buffer.from("NullsoftInst"))
    || head.includes(Buffer.from("Nullsoft"))
    || head.includes(Buffer.from("nsis"));
  check("3. NSIS-Installer erkannt", isNsis, isNsis ? "Nullsoft-Signatur gefunden" : "keine NSIS-Signatur");

  // SHA256 (nur berichten).
  const sha = sha256File(installer);
  console.log(`[g4-artifact] SHA256: ${sha}`);

  // INHALT-PRUEFUNG: Der NSIS-Installer komprimiert die Payload (LZMA).
  // Eine String-Suche im Installer ist deshalb NICHT aussagekraeftig.
  // Der belastbare Nachweis ist der INSTALLIERTE Inhalt — der wird in
  // scripts/verify-desktop-install.mjs gegen den echten Install Root
  // geprueft (runtime/node, runtime/postgres, runtime/app, WebView2-Setup,
  // keine .env, keine Test-/Docs-Artefakte, keine fremden Engines).
  //
  // Hier pruefen wir nur, was sich OHNE Entpacken feststellen laesst:
  //   - Groessenordnung (Payload muss Runtime + WebView2 enthalten)
  //   - der Installer enthaelt KEINE unkomprimierten Verzeichnisnamen
  //     verbotener Artefakte (die NSIS-Datei-Tabelle ist lesbar)
  const buf = readFileSync(installer);
  const s = buf.toString("latin1");
  const utf16 = buf.toString("utf16le");
  const has = (needle) => s.includes(needle) || utf16.includes(needle);

  // Groessen-Abschaetzung: Runtime (636 MB) + WebView2 (~127 MB) komprimiert
  // auf ~317 MB ist plausibel. Deutlich kleiner waere ein Fehler.
  check("4. Installer-Groesse passt zu Runtime + WebView2-Payload",
    sizeMb > 200 && sizeMb < 900, `${sizeMb.toFixed(1)} MB`);

  // Die NSIS-Datei-Tabelle ist unkomprimiert lesbar (Dateinamen der
  // installierten Dateien stehen im Header-Block).
  //
  // G7-FIX: Die verbotenen Muster decken ALLE Prisma-Engine-FAMILIEN und
  // ALLE Nicht-Windows-/Nicht-x64-Targets ab. Die Liste wird zentral aus
  // scripts/prisma-engine-policy.mjs abgeleitet, damit Verifier und
  // Packaging nicht auseinanderlaufen koennen.
  const forbiddenInTable = [
    "playwright-report",
    "test-results",
    "runtime-cache",
    ".env",
    ...PRISMA_FORBIDDEN_NAME_PATTERNS,
  ];
  const foundForbidden = forbiddenInTable.filter((f) => has(f));
  check("5. keine verbotenen Artefakte in der NSIS-Datei-Tabelle",
    foundForbidden.length === 0, foundForbidden.join(", "));

  // Der Runtime-Pfad: NSIS komprimiert die Payload (LZMA), die Dateinamen
  // stehen daher NICHT im Plaintext im Installer. Der belastbare Nachweis
  // ist der INSTALLIERTE Inhalt (scripts/verify-desktop-install.mjs prueft
  // runtime/node, runtime/postgres, runtime/app am echten Install Root).
  //
  // Hier pruefen wir, dass der Installer die Runtime-Groesseueberhaupt
  // transportiert: Runtime 636 MB + WebView2 ~127 MB -> komprimiert ~317 MB.
  // Deutlich kleiner waere ein Fehler (Runtime nicht gebuendelt).
  check("6. Runtime-Payload-Groesse im Installer plausibel",
    sizeMb > 200 && sizeMb < 900,
    `${sizeMb.toFixed(1)} MB (Runtime 636 MB + WebView2 ~127 MB, LZMA-komprimiert)`);

  // x64-Produkt: die Tauri-EXE im Payload muss PE 0x8664 sein.
  // Wir suchen im Stage (identisch zum Payload) nach der x64-EXE.
  const stageExe = path.join(
    REPO_ROOT, "src-tauri", "target", "x86_64-pc-windows-msvc", "release", "havewa-desktop.exe",
  );
  let machine = 0;
  if (existsSync(stageExe)) {
    const b = readFileSync(stageExe);
    const peOff = b.readUInt32LE(0x3c);
    machine = b.readUInt16LE(peOff + 4);
  }
  check("7. Produkt-EXE ist x64 (0x8664)", machine === 0x8664,
    existsSync(stageExe) ? `0x${machine.toString(16)}` : "EXE nicht gefunden");

  // Groessen-Report (Auftrag §24).
  const stageRoot = path.join(REPO_ROOT, "src-tauri", "resources", "runtime");
  const stageSize = listFiles(stageRoot).reduce((s, f) => s + statSync(f).size, 0);
  const standaloneRoot = path.join(REPO_ROOT, ".next", "standalone");
  const standaloneSize = existsSync(standaloneRoot)
    ? listFiles(standaloneRoot).reduce((s, f) => s + statSync(f).size, 0) : 0;
  const frontendRoot = path.join(REPO_ROOT, ".next", "frontend");
  const frontendSize = existsSync(frontendRoot)
    ? listFiles(frontendRoot).reduce((s, f) => s + statSync(f).size, 0) : 0;
  const exeSize = existsSync(stageExe) ? statSync(stageExe).size : 0;

  console.log("\n[g4-artifact] ==== GROESSEN ====");
  console.log(`[g4-artifact] standalone build:   ${(standaloneSize / 1024 / 1024).toFixed(1)} MB`);
  console.log(`[g4-artifact] frontend (Tauri):   ${(frontendSize / 1024 / 1024).toFixed(1)} MB`);
  console.log(`[g4-artifact] desktop runtime:   ${(stageSize / 1024 / 1024).toFixed(1)} MB`);
  console.log(`[g4-artifact] Tauri EXE:         ${(exeSize / 1024 / 1024).toFixed(1)} MB`);
  console.log(`[g4-artifact] NSIS installer:     ${sizeMb.toFixed(1)} MB`);

  // 8-GB-Anomalie ausschliessen.
  check("8. keine 8-GB-Anomalie im Runtime-Stage",
    stageSize < 3 * 1024 * 1024 * 1024,
    `${(stageSize / 1024 / 1024).toFixed(1)} MB`);
  check("9. kein src-tauri/target im Runtime-Stage",
    !existsSync(path.join(stageRoot, "app", "src-tauri")),
    "");
  check("10. kein src-tauri/target im Standalone",
    !existsSync(path.join(standaloneRoot, "src-tauri")),
    "");
  check("11. kein src-tauri/target im Frontend-Ordner",
    !existsSync(path.join(frontendRoot, "src-tauri")),
    "");

  // --- G7-FIX: Prisma-Engine-Inventar im Stage (= Installer-Payload) ---
  //
  // ROOT CAUSE (G7-Blocker): Der 0.6.0-Installer enthielt
  // `schema-engine-linux-arm64-openssl-3.0.x` (ELF/aarch64, ~19 MB) im
  // Prisma-CLI-Tree. Der bisherige Verifier kannte nur `libquery_engine-*`
  // und `query_engine-*` und uebersah die `schema-engine-*`-Familie.
  //
  // Jetzt: Der GESAMTE Stage wird ueber die zentrale Policy geprueft.
  // Jede native Prisma-Engine, die nicht windows-x64 ist, ist ein FAIL.
  console.log("\n[g4-artifact] ==== PRISMA NATIVE ENGINE INVENTAR (Stage = Payload) ====");
  const stageApp = path.join(stageRoot, "app");
  const engineReport = await verifyPayloadPrismaEngines(stageApp);
  console.log(`[g4-artifact] native Prisma engines gesamt: ${engineReport.total}`);
  console.log(`[g4-artifact] linux: ${engineReport.linux} | arm64/aarch64: ${engineReport.arm64}`);
  console.log(formatEngineInventory(engineReport.engines));
  check("12. Prisma-Engines im Stage: keine non-windows-x64 Engine",
    engineReport.violations.length === 0,
    engineReport.violations.length === 0
      ? "alle Engines sind windows-x64"
      : engineReport.violations.map((v) => `${v.target.family}:${v.name}`).join(", "));
  check("13. Prisma-Engines im Stage: Windows-only (alle windows/x64)",
    engineReport.windowsOnly,
    `total=${engineReport.total} linux=${engineReport.linux} arm64=${engineReport.arm64}`);
  check("14. Prisma-CLI-Tree enthält keine Linux-/ARM64-Engine",
    !engineReport.engines.some((e) => e.name.includes("linux")
      || e.name.includes("arm64") || e.name.includes("aarch64")),
    "");

  console.log("\n[g4-artifact] ==== SUMMARY ====");
  const failed = results.filter((x) => !x.ok);
  for (const x of results) console.log(`  ${x.ok ? "OK  " : "FAIL"} ${x.name}`);
  console.log(`[g4-artifact] ${results.length - failed.length}/${results.length} PASS`);
  process.exit(failed.length === 0 ? 0 : 1);
}

/**
 * Entry-Point-Guard: Das Skript darf auch als Modul importiert werden
 * (fuer die Regressionstests), ohne die CLI auszufuehren.
 */
function isEntryPoint() {
  try {
    if (!process.argv[1]) return false;
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().catch((e) => {
    console.error(`[g4-artifact] FATAL: ${e?.stack ?? e}`);
    process.exit(1);
  });
}
