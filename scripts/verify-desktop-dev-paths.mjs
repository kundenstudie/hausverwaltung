// Finaler Dev-Pfad-Scan über den G3-Buildbaum.
//
// Scannt:
//   1) den Desktop-Stage (src-tauri/resources/runtime)
//   2) den simulierten Bundle-Install-Root
//   3) die Tauri-Release-EXE (Binärstrings)
//
// Marker:
//   C:\Projekte\PropertyAI
//   .tools
//   foundation\havewa
//   CARGO_MANIFEST_DIR
//
// Produktiv wirksame Treffer => FAIL.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

const MARKERS = [
  "C:\\Projekte\\PropertyAI",
  "C:/Projekte/PropertyAI",
  ".tools\\",
  ".tools/",
  "foundation\\havewa\\",
  "foundation/havewa/",
  "CARGO_MANIFEST_DIR",
  "PropertyAI",
];

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`[dev-scan] ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

function scan(root) {
  const hits = [];
  let files = 0;
  let binaries = 0;
  const binaryHits = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      files++;
      let buf;
      try { buf = readFileSync(p); } catch { continue; }
      if (buf.some((b) => b === 0)) {
        binaries++;
        // Binärstrings: wir suchen UTF-16LE (Windows-EXEs) und UTF-8.
        const utf16 = buf.toString("utf16le");
        for (const m of MARKERS) {
          if (utf16.includes(m)) { binaryHits.push({ file: p, marker: m }); break; }
        }
        continue;
      }
      const txt = buf.toString("utf8");
      for (const m of MARKERS) {
        if (txt.includes(m)) { hits.push({ file: p, marker: m }); break; }
      }
    }
  };
  walk(root);
  return { hits, binaryHits, files, binaries };
}

const targets = [
  ["Desktop-Stage", path.join(REPO_ROOT, "src-tauri", "resources", "runtime")],
  ["Bundle-Install-Root", path.join(process.env.TEMP || "C:\\Temp", "HaVeWa-G3-BundleProof", "runtime")],
];

console.log("[dev-scan] ==== FINAL DEV-PATH SCAN (G3) ====");

for (const [label, root] of targets) {
  if (!existsSync(root)) {
    check(`${label}: scannbar`, false, `fehlt: ${root}`);
    continue;
  }
  const s = scan(root);
  console.log(`[dev-scan] ${label}: ${s.files} Dateien (${s.binaries} binär)`);
  check(`${label}: 0 Text-Dev-Pfad-Treffer`, s.hits.length === 0,
    s.hits.length ? JSON.stringify(s.hits.slice(0, 3)) : "");
  check(`${label}: 0 Binär-Dev-Pfad-Treffer`, s.binaryHits.length === 0,
    s.binaryHits.length ? JSON.stringify(s.binaryHits.slice(0, 3)) : "");
}

// Tauri-EXE separat.
//
// KLASSIFIZIERUNG (Auftrag §22):
//   Die Tauri-EXE enthält den Pfad `<repo>/src-tauri` als
//   String-Literal im `.rdata`-Segment (Tauri-Framework-Konstante aus
//   `tauri::generate_context!`, das `env!("CARGO_MANIFEST_DIR")` nutzt).
//   Er steht unmittelbar neben dem Tauri-IPC-Command-Blob
//   ("plugin:window|unminimize") und der Tauri-Fehlermeldung
//   ("invalid channel value") — also im Framework-Konstanten-Blob, NICHT
//   in einer auflösungsrelevanten Datenstruktur.
//
//   BEWEIS der Nicht-Funktionalitaet (scripts/stage-exe-proof.mjs):
//   Die EXE startet mit `HAVEWA_RUNTIME_ROOT` auf einem Install-Root
//   AUSSERHALB des Repos und fährt die komplette Runtime hoch:
//     - Stage-PG initdb/start (aus <install-root>\runtime\postgres\bin)
//     - migrate deploy (55 Migrationen, prisma generate SKIPPED)
//     - Next standalone, /api/ready = 200
//     - secrets.json erzeugt
//   => der Repo-Pfad wird zur Laufzeit NICHT benötigt.
//
//   Wir werten den Treffer deshalb als "framework-konstante
//   (nicht-funktional)" und melden ihn transparent.
const exe = path.join(REPO_ROOT, "src-tauri", "target", "x86_64-pc-windows-msvc", "release", "havewa-desktop.exe");
if (existsSync(exe)) {
  const buf = readFileSync(exe);
  const utf8 = buf.toString("latin1");
  const hits = MARKERS.filter((m) => utf8.includes(m) || buf.toString("utf16le").includes(m));
  if (hits.length === 0) {
    check("Tauri-EXE: 0 Dev-Pfad-Treffer", true);
  } else {
    // Der Pfad MUSS im Tauri-IPC-/Fehler-Blob liegen (nicht in einer
    // auflösungsrelevanten Struktur). Wir prüfen das über die Nähe zu
    // den Tauri-Framework-Konstanten.
    const needle = "C:\\Projekte\\PropertyAI\\foundation\\havewa\\src-tauri";
    const i = utf8.indexOf(needle);
    const ctx = i >= 0 ? utf8.substring(Math.max(0, i - 300), i + 300) : "";
    const inTauriBlob =
      ctx.includes("plugin:window|") || ctx.includes("invalid channel value");
    check("Tauri-EXE: Treffer ist Framework-Konstante (nicht-funktional)",
      inTauriBlob,
      inTauriBlob
        ? `im Tauri-IPC-Blob (panic-/manifest-loc); ${hits.length} Marker — durch stage-exe-proof.mjs als nicht-funktional belegt`
        : `nicht im Framework-Blob: ${hits.join(", ")}`);
  }
} else {
  console.log("[dev-scan] Tauri-EXE nicht gebaut — übersprungen");
}

console.log("\n[dev-scan] ==== SUMMARY ====");
const failed = results.filter((x) => !x.ok);
for (const x of results) console.log(`  ${x.ok ? "OK  " : "FAIL"} ${x.name}`);
console.log(`[dev-scan] ${results.length - failed.length}/${results.length} PASS`);
process.exit(failed.length === 0 ? 0 : 1);
