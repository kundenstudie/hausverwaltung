// HAVEWA-07A-2 — bootstrap.ts -> bootstrap.js (CJS) kompilieren.
//
// Erzeugt scripts/dist/bootstrap.js, das ohne tsx/TypeScript direkt mit
// `node scripts/dist/bootstrap.js` ausgefuehrt werden kann (Produktions-Runtime).
//
// Vorgehen:
//   - tsc transpiliert NUR prisma/bootstrap.ts + transitive Imports nach
//     scripts/dist/<mirror>/bootstrap.js (CJS, target=ES2022)
//   - danach wird der Spiegel-Baum in einen festen Pfad scripts/dist/bootstrap.js
//     kopiert, mit bereinigtem require('../src/lib/accounts') -> require('./accounts.js')
//   - Idempotent
//
// Bewusst KEIN esbuild-Build, weil ohne neue Dev-Dependency.

import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const TSC = path.join(ROOT, "node_modules", "typescript", "bin", "tsc");
const ENTRY_REL = "prisma/bootstrap.ts";
const OUT_DIR = path.join(ROOT, "scripts", "dist");
const FINAL_FILE = path.join(OUT_DIR, "bootstrap.js");

function fail(msg, code = 1) {
  process.stderr.write(`[build-bootstrap] FAIL: ${msg}\n`);
  process.exit(code);
}

async function rmrf(p) {
  await fs.rm(p, { recursive: true, force: true });
}

async function copyFile(src, dst) {
  await fs.mkdir(path.dirname(dst), { recursive: true });
  await fs.copyFile(src, dst);
}

async function read(p) { return fs.readFile(p, "utf8"); }
async function write(p, c) { await fs.writeFile(p, c, "utf8"); }

async function main() {
  // 1) Vorher aufraeumen, damit keine stale Files uebrig bleiben.
  await rmrf(OUT_DIR);
  await fs.mkdir(OUT_DIR, { recursive: true });

  // 2) tsc mit minimalen Overrides (Projekt-tsconfig ist noEmit).
  const r = spawnSync(
    process.execPath,
    [
      TSC,
      "--target", "ES2022",
      "--module", "commonjs",
      "--moduleResolution", "node",
      "--esModuleInterop",
      "--skipLibCheck",
      "--resolveJsonModule",
      "--outDir", OUT_DIR,
      "--rootDir", ROOT,
      ENTRY_REL,
    ],
    { stdio: "inherit", shell: false, cwd: ROOT },
  );
  if (r.error) fail(`tsc: ${r.error.message}`);
  if (r.status !== 0) fail(`tsc -> exit ${r.status}`);

  // 3) tsc legt den Output unter scripts/dist/prisma/bootstrap.js ab.
  //    Wir verschieben ihn auf einen festen Pfad und reparieren den
  //    accounts-Import (war relativ zu prisma/, jetzt relativ zu scripts/dist/).
  const tscOut = path.join(OUT_DIR, "prisma", "bootstrap.js");
  try {
    await fs.access(tscOut);
  } catch {
    fail(`tsc hat ${tscOut} nicht erzeugt.`);
  }

  let code = await read(tscOut);
  // Vorher: require("../src/lib/accounts")  ->  nachher: require("./accounts.js")
  code = code.replace(/require\("\.\.\/src\/lib\/accounts"\)/g, 'require("./accounts.js")');
  await write(FINAL_FILE, code);

  // 4) Hilfsdateien (accounts.js) ebenfalls in den finalen Pfad kopieren.
  const accountsTsc = path.join(OUT_DIR, "src", "lib", "accounts.js");
  try {
    await fs.access(accountsTsc);
    await copyFile(accountsTsc, path.join(OUT_DIR, "accounts.js"));
  } catch {
    // type-only import -> tsc hat accounts.js gar nicht erzeugt. Dann ist
    // accounts.js im Output nicht noetig (kein runtime-require). OK.
  }

  // 5) Mirror-Verzeichnis (prisma/, src/) wegraeumen.
  await rmrf(path.join(OUT_DIR, "prisma"));
  await rmrf(path.join(OUT_DIR, "src"));

  process.stdout.write(`[build-bootstrap] OK: ${FINAL_FILE}\n`);
}

main().catch((e) => fail(e?.stack || String(e)));
