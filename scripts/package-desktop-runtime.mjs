// HAVEWA-07D G2 â€” Isolated Desktop Runtime Staging.
//
// Erzeugt einen vollstÃ¤ndig isolierten Windows-x64 Runtime-Staging-Baum unter
//   src-tauri/resources/runtime/{node,postgres,app}/
//
// Quellen:
//   - Node + Postgres aus dem G1-verifizierten Cache (.runtime-cache/).
//   - App aus dem Next-Standalone-Build (.next/standalone) +
//     Bootstrap (scripts/dist/) + Prisma-CLI-Tree (scripts/.runtime/prisma-cli/).
//
// Eigenschaften:
//   - Deterministisch: Zielverzeichnis wird vor dem Schreiben kontrolliert
//     neu erstellt (nur runtime/, niemals Source).
//   - Allowlist + Forbidden-Liste am Ende geprÃ¼ft.
//   - Pflichtdateien werden explizit verifiziert; fehlende Dateien => HARD FAIL.
//   - Kein rm -rf auf dynamischen Pfaden.
//   - Keine Secrets in Logs.
//
// CLI:
//   node scripts/package-desktop-runtime.mjs                 # default
//   node scripts/package-desktop-runtime.mjs --cache <root>  # explizit G1-Cache
//   node scripts/package-desktop-runtime.mjs --no-app         # ohne App-Stage
//
// Erforderliche Umgebungs-Voraussetzungen:
//   - x64-Node-Toolchain (project-local unter .tools/ wird empfohlen)
//   - kein Network fÃ¼r den Stage selbst (nur Tools sind G1-pinned und offline)

import { existsSync } from "node:fs";
import {
  mkdir,
  rm,
  copyFile,
  readdir,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  loadLockfile,
  verifyArchiveHash,
} from "./runtime-assets.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const LOCKFILE_PATH = path.join(REPO_ROOT, "scripts", "runtime-assets.lock.json");
const STAGE_ROOT = path.join(REPO_ROOT, "src-tauri", "resources", "runtime");
const CACHE_ROOT = path.join(REPO_ROOT, ".runtime-cache");
const NODE_STAGE = path.join(STAGE_ROOT, "node");
const PG_STAGE = path.join(STAGE_ROOT, "postgres");
const APP_STAGE = path.join(STAGE_ROOT, "app");
const STANDALONE_DIR = path.join(REPO_ROOT, ".next", "standalone");
const BOOTSTRAP_JS = path.join(REPO_ROOT, "scripts", "dist", "bootstrap.js");
const PRISMA_TREE_SRC = path.join(REPO_ROOT, "scripts", ".runtime", "prisma-cli");

// ---------------------------------------------------------------------------
// Default-Logger
// ---------------------------------------------------------------------------

function info(msg) { process.stdout.write(`[package-desktop-runtime] ${msg}\n`); }
function warn(msg) { process.stderr.write(`[package-desktop-runtime] WARN ${msg}\n`); }
function fail(msg, code = 1) {
  process.stderr.write(`[package-desktop-runtime] FAIL: ${msg}\n`);
  process.exit(code);
}

// ---------------------------------------------------------------------------
// CLI-Parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { skipApp: false, cacheRoot: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--cache") { out.cacheRoot = argv[++i]; continue; }
    if (a === "--no-app") { out.skipApp = true; continue; }
    if (a === "--help" || a === "-h") {
      process.stdout.write(
        "Usage: node scripts/package-desktop-runtime.mjs [--cache <root>] [--no-app]\n",
      );
      process.exit(0);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// G1-Cache-Validierung
// ---------------------------------------------------------------------------

async function validateCache(cacheRoot) {
  const lockfile = loadLockfile(LOCKFILE_PATH);
  for (const kind of ["node", "postgres"]) {
    const entry = lockfile[kind];
    const archive = path.join(cacheRoot, "downloads", entry.archive);
    if (!existsSync(archive)) {
      fail(`G1-Cache unvollstÃ¤ndig: ${archive}. Bitte zuerst 'node scripts/runtime-assets.mjs prepare' ausfÃ¼hren.`);
    }
    const r = await verifyArchiveHash(archive, entry.sha256);
    if (!r.ok) {
      fail(`G1-Cache-Verify fehlgeschlagen fÃ¼r ${kind}: ${r.reason}`);
    }
    info(`cache OK: ${kind} (${entry.version}, sha256=${entry.sha256.slice(0, 12)}â€¦)`);
  }
  return lockfile;
}

// ---------------------------------------------------------------------------
// Stage-Reset (nur den eigenen Stage lÃ¶schen)
// ---------------------------------------------------------------------------

async function resetStage() {
  if (existsSync(STAGE_ROOT)) {
    // Defensiv: nichts oberhalb des STAGE_ROOT lÃ¶schen.
    const stageRootAbs = path.resolve(STAGE_ROOT);
    const repoAbs = path.resolve(REPO_ROOT);
    // Sicherheits-Check: STAGE_ROOT MUSS unter repoAbs liegen.
    if (!stageRootAbs.startsWith(repoAbs + path.sep)) {
      fail(`STAGE_ROOT entkommt dem Repo: ${stageRootAbs}`);
    }
    info(`reset stage: rm -rf ${stageRootAbs}`);
    await rm(stageRootAbs, { recursive: true, force: true });
  }
  await mkdir(STAGE_ROOT, { recursive: true });
}

// ---------------------------------------------------------------------------
// Kopier-Helfer
// ---------------------------------------------------------------------------

async function copyDirFiltered(src, dst, predicate, depth = 0) {
  await mkdir(dst, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) {
      // Der Predicate wird auf JEDER Ebene angewendet. `depth` zaehlt die
      // Verzeichnis-Ebene (0 = direkt unter der Wurzel des Kopiervorgangs).
      //
      // HAVEWA-07D G5: `standalonePredicate` braucht die Tiefe, um
      // `icon.png` NUR auf Top-Level auszuschliessen (Logo-Asset) und das
      // Next.js-Route-Verzeichnis `.next/server/app/icon.png/` zu behalten.
      // Andere Predicates (nodeModulesPredicate, pgBinPredicate, ...) sind
      // tiefen-unabhaengig und ignorieren den Zusatz-Parameter.
      if (!predicate(e.name, depth)) continue;
      await copyDirFiltered(s, d, predicate, depth + 1);
    } else if (e.isFile()) {
      if (!predicate(e.name, depth)) continue;
      await mkdir(path.dirname(d), { recursive: true });
      await copyFile(s, d);
    } else if (e.isSymbolicLink()) {
      // symlinks wÃ¼rden Stage und Quell-Risiken verknÃ¼pfen, wir Ã¼berspringen.
    }
  }
}

async function copyDirAll(src, dst) {
  return copyDirFiltered(src, dst, () => true);
}

/**
 * Predicate fuer node_modules-Pakete: entfernt nicht-Runtime-relevante
 * Verzeichnisse/Dateien (Dokumentation, Tests, Beispiele, Benchmarks).
 *
 * Wird fuer die materialisierten Turbopack-Aliase verwendet, damit diese
 * nicht die ungefilterte Paket-Distribution (inkl. docs/, test/, examples/)
 * in den Release-Stage nachziehen.
 */
export function nodeModulesPredicate(name) {
  if (name === "docs" || name === "doc" || name === "test" || name === "tests"
    || name === "example" || name === "examples" || name === "benchmark"
    || name === "benchmarks" || name === "coverage") {
    return false;
  }
  if (name.endsWith(".md") && name !== "LICENSE" && name !== "README.md") return false;
  if (name === ".nojekyll" || name === "CNAME" || name === "favicon.ico"
    || name === "index.html" || name === "tsconfig.json"
    || name === "eslint.config.js" || name === ".prettierignore"
    || name === "inc-version.sh" || name === "CONTRIBUTING.md"
    || name === "SECURITY.md") {
    return false;
  }
  return true;
}

async function safeCopyFile(src, dst) {
  if (!existsSync(src)) fail(`Quelle fehlt: ${src}`);
  await mkdir(path.dirname(dst), { recursive: true });
  await copyFile(src, dst);
}

// ---------------------------------------------------------------------------
// Turbopack-Modul-Aliase materialisieren
// ---------------------------------------------------------------------------

/**
 * HAVEWA-07D G2 Hardening â€” Turbopack "hashed module alias" Support.
 *
 * ROOT CAUSE (konkrete Build-Artefakte, siehe G2-Hardening-Report):
 *
 *   Next 16 + Turbopack erzeugt fuer EXTERNE Pakete (next: serverExternalPackages)
 *   eine deterministische Modul-ID der Form `<paket>-<16-hex>`. Im Server-Bundle
 *   steht dann:
 *
 *     b.exports = a.x("@prisma/client-2c3a283f134fdcb6",
 *                      () => require("@prisma/client-2c3a283f134fdcb6"))
 *
 *   `a.x` ist Turbopacks `externalRequire`, das den Namen unveraendert an
 *   `require.resolve` weitergibt. Aufloesen kann Node das nur, wenn ein
 *   Verzeichnis/Filesystem-Eintag mit genau diesem Namen im `node_modules`
 *   liegt.
 *
 *   Next legt diesen Eintrag als **Windows-JUNCTION** an:
 *     .next/node_modules/@prisma/client-2c3a283f134fdcb6
 *       -> <repo>/node_modules/@prisma/client
 *     .next/standalone/.next/node_modules/@prisma/client-2c3a283f134fdcb6
 *       -> <repo>/node_modules/@prisma/client
 *
 *   Im Repo funktioniert das, weil Node vom Server-CWD `.next/standalone/`
 *   aus im Parent-Walk `.next/node_modules/...` findet (1 Ebene hoeher).
 *
 *   Im Desktop-Stage liegt der Server unter
 *   `src-tauri/resources/runtime/app/`. Der Parent-Walk fuehrt dort ins
 *   Leere â€” der Alias existiert nicht, der Server startet mit
 *   "Cannot find module '@prisma/client-<hash>'".
 *
 * LOESUNG (statisch, ohne Monkeypatch):
 *   Wir materialisieren die Aliase als ECHTE VERZEICHNISSE (keine Junctions â€”
 *   Junctions zeigten auf Dev-Pfade) direkt unter
 *   `<app-stage>/node_modules/`, also genau dort, wo der Server-CWD sie sucht.
 *
 *   Der Hash wird NICHT geraten: er wird aus dem Build-Artefakt
 *   `.next/standalone/.next/node_modules/` gelesen (dort liegen die Original-
 *   Junctions) und der Inhalt wird aus dem dort referenzierten Ziel gelesen.
 *
 *   Damit ist der Stage deterministisch und selbstheilend gegen Hash-Wechsel
 *   zwischen Builds.
 */
const TURBOPACK_ALIAS_RE = /-([0-9a-f]{16})$/;

async function readJunctionTarget(linkPath) {
  const fs = await import("node:fs/promises");
  try {
    return await fs.readlink(linkPath);
  } catch {
    return null;
  }
}

/**
 * Findet alle Turbopack-Aliase im Standalone-Build und materialisiert sie
 * als echte Verzeichnisse unter `<appStage>/node_modules/`.
 *
 * Inhalt der Aliase: wir bevorzugen das bereits im Stage vorhandene
 * "normale" Paket-Pendant (`node_modules/pino/`, `node_modules/@prisma/client/`,
 * ...). Das ist exakt der Tree, den Next fuer das Production-Bundle als
 * `node_modules/` ausgeliefert hat â€” also bereits bereinigt (kein docs/,
 * kein test/, kein examples/). Das verhindert, dass der Alias die
 * ungefilterte Paket-Distribution (inkl. Dokumentation) in den Stage
 * nachzieht.
 *
 * Falls das Pendant fehlt (Next hat es nicht getraced), kopieren wir die
 * Junction-Quelle mit demselben node_modules-Predicate.
 *
 * @returns {Promise<{materialized: string[], skipped: string[], source: string[]}>}
 */
export async function materializeTurbopackAliases(appStage) {
  const fs = await import("node:fs/promises");
  const aliasRoot = path.join(STANDALONE_DIR, ".next", "node_modules");
  const result = { materialized: [], skipped: [], source: [] };
  if (!existsSync(aliasRoot)) {
    warn(`Keine Turbopack-Aliase gefunden (${aliasRoot} fehlt) â€” Server-Bundle ohne Alias-Requires?`);
    return result;
  }

  async function walkAliasDir(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) {
        // Junction / Symlink: der Name ist der Alias.
        if (!TURBOPACK_ALIAS_RE.test(e.name)) continue;
        const target = await readJunctionTarget(p);
        if (!target) {
          result.skipped.push(`${e.name} (kein lesbarer Link)`);
          continue;
        }
        // Ziel ist absolut (Junction) â€” wir nehmen den Inhalt des Ziels.
        const srcDir = path.isAbsolute(target) ? target : path.resolve(path.dirname(p), target);
        if (!existsSync(srcDir)) {
          result.skipped.push(`${e.name} (Ziel fehlt: ${srcDir})`);
          continue;
        }
        // Ziel relativ zum Stage-Root machen: der Alias landet unter
        // <appStage>/node_modules/<scope?>/<name>.
        const rel = path.relative(aliasRoot, p);
        const dst = path.join(appStage, "node_modules", rel);

        // Bevorzugt: das bereits bereinigte Pendant aus dem Stage verwenden.
        // Beispiel: rel = "@prisma/client-<hash>" -> Pendant = "@prisma/client".
        const baseName = rel.replace(/\\/g, "/").replace(/-[0-9a-f]{16}$/, "");
        const pending = path.join(appStage, "node_modules", baseName);
        if (existsSync(pending)) {
          await rm(dst, { recursive: true, force: true });
          await copyDirAll(pending, dst);
          result.materialized.push(rel.replace(/\\/g, "/"));
          result.source.push(`${rel.replace(/\\/g, "/")} <- ${baseName} (stage-pending)`);
          continue;
        }

        // Fallback: Junction-Quelle mit demselben node_modules-Predicate.
        await rm(dst, { recursive: true, force: true });
        await copyDirFiltered(srcDir, dst, nodeModulesPredicate);
        result.materialized.push(rel.replace(/\\/g, "/"));
        result.source.push(`${rel.replace(/\\/g, "/")} <- ${srcDir} (junction-ziel, gefiltert)`);
        continue;
      }
      if (e.isDirectory()) {
        await walkAliasDir(p);
      }
    }
  }

  await walkAliasDir(aliasRoot);
  return result;
}

// ---------------------------------------------------------------------------
// Node Stage
// ---------------------------------------------------------------------------

async function stageNode(lockfile, cacheRoot) {
  info("staging node ...");
  const nodeEntry = lockfile.node;
  const extractedRoot = path.join(
    cacheRoot,
    "extracted",
    `node-${nodeEntry.version.replace(/^v/, "")}-win-x64`,
  );
  const nodeInner = path.join(extractedRoot, "node-v22.23.3-win-x64");
  if (!existsSync(nodeInner)) fail(`Node-Extract fehlt: ${nodeInner}`);

  await mkdir(NODE_STAGE, { recursive: true });
  const requireList = ["node.exe", "LICENSE"];
  for (const f of requireList) {
    await safeCopyFile(path.join(nodeInner, f), path.join(NODE_STAGE, f));
  }
  info(`node stage: ${NODE_STAGE} -> ${requireList.join(", ")}`);
}

// ---------------------------------------------------------------------------
// Postgres Stage
// ---------------------------------------------------------------------------

// PG-Binaries, die explizit keine Runtime-Tools sind und entfernt werden.
//
// NICHT entfernt (kritisch fÃ¼r Runtime und Prisma-Anbindung):
//   - libpq.dll        PostgreSQL-Client-Lib (von Prisma geladen)
//   - libecpg*.dll     ECPG-Runtime-Libs
//   - libpgtypes.dll   ECPG-PostgreSQL-Type-Lib
//
// Entfernt:
//   - ecpg.exe              Frontend-Tool (nicht Runtime)
//   - isolationtester.exe   Test-Tool
//   - libcurl.lib           Import-Library
//   - libpgcommon.dll       Postgres-Server-intern, wird via Postgres.exe
//                            selbst referenziert und bleibt im Stage-Verzeichnis
//                            (Stage-Dir-Lookup findet es direkt)
//   - libpgfeutils.dll      dto.
//   - libpgport.dll         dto.
//   - regress.dll           Test-Lib
const PG_BIN_EXCLUDE = new Set([
  "ecpg.exe",
  "isolationtester.exe",
  "libcurl.lib",
  "regress.dll",
]);

/**
 * Filter fÃ¼r `pgsql/bin/` â€” nur zulÃ¤ssige Pflicht-Tools + dynamische DLLs.
 * *.lib (import libs), *.pdb (debug) werden ebenfalls entfernt (Entwickler-Symbole).
 */
function pgBinPredicate(name) {
  if (PG_BIN_EXCLUDE.has(name)) return false;
  if (name.endsWith(".lib")) return false;
  if (name.endsWith(".pdb")) return false;
  // Alle EXEs durchlassen (Tools + Hilfsskripte), alle DLLs durchlassen
  // (Runtime benÃ¶tigt sie wahrscheinlich) â€” die EXE-Allowlist wird
  // zusÃ¤tzlich separat verifiziert (pgRequiredBinariesCheck).
  return true;
}

/**
 * Filter fÃ¼r `pgsql/share/` â€” alles lassen (fÃ¼r initdb nÃ¶tig: timezone,
 * locale, conversion functions, etc.). Docs werden vom Filter ausgenommen.
 */
function pgSharePredicate(name) {
  if (name === "doc" || name === "man" || name === "docs") return false;
  return true;
}

/**
 * Filter fÃ¼r `pgsql/lib/`: aktuell ohne EinschrÃ¤nkung (Auftrag Â§8:
 * FunktionalitÃ¤t hat Vorrang vor MinimalgrÃ¶ÃŸe, alle Libraries bleiben).
 */
// (lib/ wird ungefiltert kopiert; Konstante ist als Policy-Hook dokumentiert.)

async function stagePostgres(lockfile, cacheRoot) {
  info("staging postgres ...");
  const pgEntry = lockfile.postgres;
  const extractedRoot = path.join(
    cacheRoot,
    "extracted",
    `postgres-${pgEntry.version}-win-x64`,
  );
  const pgsqlRoot = path.join(extractedRoot, "pgsql");
  if (!existsSync(pgsqlRoot)) fail(`PG-Extract-Wurzel fehlt: ${pgsqlRoot}`);

  // 1) Top-Level-Struktur: bin/, share/, lib/, licenses/
  await mkdir(PG_STAGE, { recursive: true });
  await mkdir(path.join(PG_STAGE, "bin"), { recursive: true });
  await mkdir(path.join(PG_STAGE, "lib"), { recursive: true });
  await mkdir(path.join(PG_STAGE, "share"), { recursive: true });
  await mkdir(path.join(PG_STAGE, "licenses"), { recursive: true });

  // 2) bin/ â€” selektiv kopieren
  const srcBin = path.join(pgsqlRoot, "bin");
  await copyDirFiltered(srcBin, path.join(PG_STAGE, "bin"), pgBinPredicate);

  // 3) share/ â€” komplett (minus docs)
  const srcShare = path.join(pgsqlRoot, "share");
  if (existsSync(srcShare)) {
    await copyDirFiltered(srcShare, path.join(PG_STAGE, "share"), pgSharePredicate);
  } else {
    warn(`PG share-Verzeichnis fehlt im Extract (unerwartet, runtime risk).`);
  }

  // 4) lib/ â€” komplett
  const srcLib = path.join(pgsqlRoot, "lib");
  if (existsSync(srcLib)) {
    await copyDirAll(srcLib, path.join(PG_STAGE, "lib"));
  } else {
    warn(`PG lib-Verzeichnis fehlt im Extract (unerwartet, runtime risk).`);
  }

  // 5) licenses/ â€” selektiv (nur Server + Commandlinetools)
  const topEntries = (await readdir(pgsqlRoot, { withFileTypes: true })).filter(
    (e) => e.isFile(),
  );
  for (const e of topEntries) {
    if (
      e.name === "server_license.txt" ||
      e.name === "commandlinetools_3rd_party_licenses.txt"
    ) {
      await safeCopyFile(path.join(pgsqlRoot, e.name), path.join(PG_STAGE, "licenses", e.name));
    }
  }

  // 6) Pflicht-EXEs verifizieren
  for (const tool of ["postgres", "pg_ctl", "initdb", "pg_isready", "createdb", "psql", "pg_dump", "pg_restore"]) {
    const p = path.join(PG_STAGE, "bin", `${tool}.exe`);
    if (!existsSync(p)) fail(`PG-Pflicht-Tool fehlt im Stage: ${p}`);
  }

  info(`postgres stage: ${PG_STAGE}`);
}

// ---------------------------------------------------------------------------
// App Stage
// ---------------------------------------------------------------------------

const STANDALONE_FORBIDDEN_TOP = new Set([
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
  // G3: Next-File-Tracing zieht das komplette `src-tauri/`-Verzeichnis
  // (inkl. ~8 GB Cargo-Build-Output `src-tauri/target/`) in den
  // Standalone-Trace, weil die Rust-Quellen Repo-Dateien referenzieren.
  // Der Desktop-Stage braucht davon NICHTS — die Runtime wird separat
  // als Tauri-Resource gebündelt. Wir schließen es aus (Auftrag §4:
  // "NICHT bundeln ... Source-Dateien außerhalb des erlaubten App-Stage").
  "src-tauri",
  // G3: weitere Repo-Verzeichnisse ohne Produktbedarf.
  "runtime-state",
  "storage",
  ".github",
  ".runtime-cache",
]);

// Dateien, die im Stage nichts zu suchen haben (Top-Level und in scripts/).
// Wichtig:
//   - `package.json` und `package-lock.json` sind HIER NICHT enthalten â€”
//     `package.json` wird im stage-root AUF APP-EBENE ueberschrieben
//     (siehe Schritt 2a), und in node_modules/ brauchen wir die
//     Modul-eigenen package.json-Eintraege fuer createRequire-Resolution.
const STANDALONE_FORBIDDEN_FILES = new Set([
  "Caddyfile",
  "ca_profile.xml",
  "components.json",
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.prod.yml",
  "docker-compose.registry.yml",
  "docker-compose.shared.yml",
  "docker-compose.test.yml",
  "eslint.config.mjs",
  "icon.png",
  "LICENSING.md",
  "next.config.ts",
  "next-env.d.ts",
  "package-lock.json",
  "playwright.config.ts",
  "postcss.config.mjs",
  "quickrun.yml",
  "README.de.md",
  "README.md",
  "tsconfig.json",
  "tsconfig.tsbuildinfo",
  "umbrel-app-store.yml",
  "vitest.config.ts",
  "vitest.integration.config.ts",
  ".gitignore",
  ".dockerignore",
  ".gitattributes",
  "Caddyfile",
  "ca_profile.xml",
  "Dockerfile",
  ".env.example",
  ".env.prod.example",
  ".env.test.example",
]);

// Predicate fÃ¼r `runtime/app/scripts/`: aktuell nicht direkt verwendet,
// weil der Standalone-`scripts/`-Inhalt im Stage-Build komplett verworfen
// und durch eine handgepflegte Whitelist in `stageApp()` ersetzt wird.
// Die unten dokumentierte Set-Definition ist als expliziter Vertrag stehen
// geblieben â€” falls G3+ weitere Skripte hinzufÃ¼gt, wird sie reaktiviert.

const STANDALONE_FORBIDDEN_FILE_EXT = new Set([".test.ts", ".spec.ts", ".test.tsx", ".spec.tsx"]);
const FORBIDDEN_FORBIDDEN_FILES = new Set([
  ".env",
  ".env.local",
  ".env.prod",
  ".env.test",
  "secrets.json",
]);

const APP_REQUIRED_PATHS = [
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
  "scripts/dist/bootstrap.js",
  "scripts/.runtime/prisma-cli/node_modules/prisma/build/index.js",
];

function isTestFile(name) {
  return name.endsWith(".test.ts")
    || name.endsWith(".test.tsx")
    || name.endsWith(".spec.ts")
    || name.endsWith(".spec.tsx");
}

function isForbiddenEnv(name) {
  if (name === ".env") return true;
  if (name.startsWith(".env.") && name !== ".env.example") return true;
  return false;
}

/**
 * Filter fÃ¼r `runtime/app/`: Allowlist, alles oberhalb der Pflicht-EintrÃ¤ge.
 */
function standalonePredicate(name, depth = 0) {
  if (STANDALONE_FORBIDDEN_TOP.has(name)) return false;
  // pgdata / runtime-state / storage werden vom Standalone nicht erwartet,
  // aber wenn vorhanden: skippen (Defensive).
  if (name === "pgdata" || name === "runtime-state" || name === "storage") return false;
  if (isTestFile(name)) return false;
  if (isForbiddenEnv(name)) return false;
  if (FORBIDDEN_FORBIDDEN_FILES.has(name)) return false;
  // HAVEWA-07D G5 (Icon-Route-Fix): `icon.png` steht in
  // STANDALONE_FORBIDDEN_FILES, weil das Repo-Root-`icon.png` (Logo-Asset)
  // NICHT in den Stage gehoert. Der Predicate wird aber rekursiv auch in
  // `.next/server/app/` angewendet - dort ist `icon.png` ein Next.js
  // ROUTE-VERZEICHNIS (`app/icon.png/route.js`), das
  // `app-paths-manifest.json` zwingend referenziert. Ohne dieses Verzeichnis
  // startet der Server mit `MODULE_NOT_FOUND: .../app/icon.png/route.js`
  // und `/icon.png` liefert HTTP 500.
  // Deshalb: `icon.png` wird NUR auf Top-Level (depth 0) ausgeschlossen;
  // in Unterverzeichnissen bleibt das Route-Verzeichnis erhalten.
  // WICHTIG: `icon.png` muss VOR dem generellen Set-Check behandelt werden,
  // sonst faellt es in `STANDALONE_FORBIDDEN_FILES` auch in der Tiefe durch.
  if (name === "icon.png") return depth === 0 ? false : true;
  if (STANDALONE_FORBIDDEN_FILES.has(name)) return false;
  return true;
}

/**
 * Predicate-Policy fÃ¼r kÃ¼nftige Stage-Varianten. Wir verwerfen den
 * Standalone-`scripts/`-Inhalt komplett zugunsten unserer eigenen
 * handgepflegten Whitelist â€” daher wird der Predicate aktuell nicht
 * in stageApp aufgerufen. Wir behalten die Set-Definition als
 * dokumentierte Policy.
 */
// (STAGE_SCRIPTS_FORBIDDEN Set bleibt fÃ¼r kÃ¼nftige Erweiterungen stehen.)

/**
 * Im `.prisma/client/`-Tree von `.next/standalone/node_modules/` und im
 * `scripts/.runtime/prisma-cli/node_modules/.prisma/client/` enthaltene
 * **fremde Engines** (Linux/Debian/ARM64) entfernen â€” der Stage braucht
 * nur Windows-x64-Engines.
 *
 * Klassifikation: Funktionsumfang (Windows-Prisma) bleibt vollstÃ¤ndig;
 * nur Multi-Plattform-Build-Artefakte werden entfernt.
 */
async function prunePrismaClientEngines(prismaClientRoot) {
  if (!existsSync(prismaClientRoot)) return;
  const entries = await readdir(prismaClientRoot, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isFile()) continue;
    const name = e.name.toLowerCase();
    if (!name.startsWith("libquery_engine-") && !name.startsWith("query_engine-")) continue;
    // Beispiel-Namen:
    //   libquery_engine-debian-openssl-3.0.x.so.node (L)
    //   libquery_engine-linux-arm64-openssl-3.0.x.so.node (L)
    //   query_engine-windows.dll.node (W â€” BEHALTEN)
    const isWindows = name.includes("windows");
    if (isWindows) continue;
    await rm(path.join(prismaClientRoot, e.name), { force: true });
  }
}

/**
 * Saniert die NICHT-FUNKTIONALEN Build-Metadaten in server.js und
 * required-server-files.json.
 *
 * ROOT CAUSE / EVIDENCE (G2-Hardening, konkrete Build-Artefakte):
 *
 *   1) server.js
 *      Next.js Standalone serialisiert die aufgeloeste nextConfig als
 *      Konstante `nextConfig` in server.js und reicht sie ueber
 *      `process.env.__NEXT_PRIVATE_STANDALONE_CONFIG` an den Server.
 *      Darin stehen als absolute Pfade aus der BUILD-Umgebung:
 *        - outputFileTracingRoot  (File-Tracing-Wurzel, nur zur BUILD-Zeit)
 *        - turbopack.root        (Workspace-Root, nur zur BUILD-Zeit)
 *
 *      Beweis der Nicht-Runtime-Relevanz (next/dist, 871 js-files geprueft):
 *        - outputFileTracingRoot wird konsumiert in:
 *            lib/find-root.js                    -> nur in WARN-TEXTEN
 *            server/config.js                    -> loadConfig(), BUILD-Zeit
 *            server/config-shared.js             -> Default-Definition, BUILD
 *            server/config-schema.js             -> Schema, BUILD-Zeit
 *            server/dev/hot-reloader-turbopack.js -> DEV-ONLY
 *        - turbopack.root wird ausschliesslich in
 *            server/dev/hot-reloader-turbopack.js (DEV-ONLY) konsumiert.
 *        - Im Production-Standalone-Pfad (`node server.js`, kein --turbo)
 *          wird keiner der beiden Werte gelesen.
 *        - LIVE-BEWEIS: Der Server laeuft mit diesen Werten und antwortet
 *          `/api/ready = 200`.
 *
 *   2) .next/required-server-files.json
 *      Enthaelt `appDir: "<build-pfad>"` und dieselben Config-Felder.
 *      Beweis der Nicht-Runtime-Relevanz:
 *        - `server/route-modules/route-module.js` (Zeile 313/362):
 *            const nextConfig = routerServerContext?.nextConfig
 *                            || serverFilesManifest?.config;
 *          -> der Manifest-Config ist nur der FALLBACK; `server.js`
 *             liefert die Primaer-Config ueber __NEXT_PRIVATE_STANDALONE_CONFIG.
 *        - `appDir` aus dem Manifest wird im Production-Pfad NICHT gelesen
 *          (alle Treffer fuer `.appDir` liegen in next/dist/server/dev/* und
 *          next/dist/server/mcp/*, wo appDir aus `options` stammt).
 *
 * BEHANDLUNG (Option C aus dem Auftrag):
 *   Die Werte werden auf den LEEREN String bzw. auf "." gesetzt â€” exakt
 *   Next's eigene Default-Semantik
 *   (`outputFileTracingRoot: process.env.NEXT_PRIVATE_OUTPUT_TRACE_ROOT || ''`,
 *    `appDir` relativ zum Server-Root).
 *   Es wird KEIN erfundener Produktionspfad eingefuegt, der spaeter wie ein
 *   Produktionspfad missverstanden werden koennte.
 */
export async function sanitizeServerJsBuildMetadata(serverJsPath) {
  if (!existsSync(serverJsPath)) return { changed: false };
  const fsp = await import("node:fs/promises");
  const src = await fsp.readFile(serverJsPath, "utf8");

  // server.js enthaelt die minified nextConfig als Konstante:
  //   const nextConfig = {â€¦};
  // Wir parsen genau dieses Objekt JSON-aequivalent und schreiben es zurueck.
  const marker = "const nextConfig = ";
  const start = src.indexOf(marker);
  if (start < 0) return { changed: false };
  const objStart = start + marker.length;
  // Klammerbalance, um das Objekt-Ende zu finden.
  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = -1;
  for (let i = objStart; i < src.length; i++) {
    const c = src[i];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end < 0) return { changed: false };

  let obj;
  try {
    obj = JSON.parse(src.slice(objStart, end));
  } catch {
    warn("server.js: nextConfig ist kein gueltiges JSON â€” nicht sanitisiert");
    return { changed: false };
  }

  let changed = false;
  if (typeof obj.outputFileTracingRoot === "string" && obj.outputFileTracingRoot !== "") {
    obj.outputFileTracingRoot = "";
    changed = true;
  }
  if (obj.turbopack && typeof obj.turbopack === "object"
    && typeof obj.turbopack.root === "string") {
    delete obj.turbopack.root;
    changed = true;
  }
  if (!changed) return { changed: false };

  const out = src.slice(0, objStart) + JSON.stringify(obj) + src.slice(end);
  await fsp.writeFile(serverJsPath, out, "utf8");
  return { changed: true };
}

/**
 * Saniert die gleichen Build-Metadaten in `.next/required-server-files.json`.
 *
 * JSON-basiert (nicht regex-basiert), weil Next die Datei pretty-printed
 * schreibt (`"appDir": "..."` mit Leerzeichen) â€” ein Regex auf die minified
 * Form greift nicht.
 *
 *   - appDir                     -> "."   (relativ zum Server-Root)
 *   - config.outputFileTracingRoot -> ""  (Next-Default: nicht gesetzt)
 *   - config.turbopack.root      -> entfernt (Default-Config kennt kein root)
 *
 * Beweis der Nicht-Runtime-Relevanz: siehe Doku in
 * sanitizeServerJsBuildMetadata().
 */
export async function sanitizeRequiredServerFiles(nextDir) {
  const fsp = await import("node:fs/promises");
  const f = path.join(nextDir, "required-server-files.json");
  if (!existsSync(f)) return { changed: false };
  const raw = await fsp.readFile(f, "utf8");
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    warn("required-server-files.json ist kein gueltiges JSON â€” nicht sanitisiert");
    return { changed: false };
  }
  let changed = false;

  if (typeof j.appDir === "string" && j.appDir !== ".") {
    j.appDir = ".";
    changed = true;
  }
  if (j.config && typeof j.config === "object") {
    if (typeof j.config.outputFileTracingRoot === "string" && j.config.outputFileTracingRoot !== "") {
      j.config.outputFileTracingRoot = "";
      changed = true;
    }
    if (j.config.turbopack && typeof j.config.turbopack === "object"
      && typeof j.config.turbopack.root === "string") {
      delete j.config.turbopack.root;
      changed = true;
    }
  }
  if (changed) {
    await fsp.writeFile(f, `${JSON.stringify(j, null, 2)}\n`, "utf8");
  }
  return { changed };
}

/**
 * Saniert die Source-Map-Metadaten im Prisma-generierten Client.
 *
 * EVIDENCE:
 *   Prisma 6 haengt an `node_modules/.prisma/client/{index,edge,wasm}.js` einen
 *   Source-Map an. Darin stehen die absoluten BUILD-Pfade:
 *     "value":        "<build-pfad>/node_modules/@prisma/client"
 *     "sourceFilePath": "<build-pfad>/prisma/schema.prisma"
 *
 *   Diese Felder stehen ausschliesslich im `//# sourceMappingURL`-Kommentar
 *   bzw. im Source-Map-Array. Der zur Laufzeit benutzte Prisma-Client
 *   (runtimeDataModel, config, engine-Pfade) steht im Code selbst und
 *   enthaelt KEINE Build-Pfade.
 *
 *   Wir entfernen den Source-Map-Kommentar bzw. entschaerfen die
 *   sourceMappingURL-Referenz, damit kein Dev-Pfad-Leak im Release-Stage
 *   verbleibt. Das ist deterministisch und hat keine Laufzeitwirkung.
 */
export async function sanitizePrismaSourceMaps(dir) {
  const fsp = await import("node:fs/promises");
  if (!existsSync(dir)) return 0;
  let changed = 0;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!/\.(js|mjs|cjs)$/.test(e.name)) continue;
    const p = path.join(dir, e.name);
    let txt;
    try { txt = await fsp.readFile(p, "utf8"); } catch { continue; }
    if (!txt.includes("PropertyAI")) continue;
    // Source-Map-Referenz entfernen (der Map-Comment selbst ist optional).
    let out = txt.replace(/^\/\/# sourceMappingURL=.*$/gm, "");
    // Verbleibende absolute Build-Pfade in Source-Map-Arrays neutralisieren.
    out = out.replace(/"\/mnt\/[a-z]\/[^"]*PropertyAI[^"]*"/g, '""');
    out = out.replace(/"[A-Za-z]:\\\\[^"]*PropertyAI[^"]*"/g, '""');
    if (out !== txt) {
      await fsp.writeFile(p, out, "utf8");
      changed++;
    }
  }
  return changed;
}

async function stageApp() {
  info("staging app ...");

  // 1) Voraussetzungen prÃ¼fen.
  if (!existsSync(STANDALONE_DIR)) {
    fail(`Standalone fehlt: ${STANDALONE_DIR}. Bitte zuerst 'node scripts/build-standalone.mjs' ausfÃ¼hren.`);
  }
  if (!existsSync(path.join(STANDALONE_DIR, "server.js"))) {
    fail(`Standalone/server.js fehlt: ${STANDALONE_DIR}`);
  }
  if (!existsSync(BOOTSTRAP_JS)) {
    fail(`Bootstrap fehlt: ${BOOTSTRAP_JS}. Bitte zuerst 'node scripts/build-bootstrap.mjs' ausfÃ¼hren.`);
  }
  if (!existsSync(PRISMA_TREE_SRC)) {
    fail(`Prisma-CLI-Tree fehlt: ${PRISMA_TREE_SRC}. Bitte zuerst 'node scripts/package-runtime.mjs' ausfÃ¼hren.`);
  }

  // 2) Standalone-Tree nach runtime/app/ kopieren.
  //    Wichtig: das Standalone enthÃ¤lt ein eigenes `scripts/`-Verzeichnis
  //    (Next-Konvention). Wir kopieren es NICHT, sondern Ã¼berschreiben den
  //    scripts/-Pfad spÃ¤ter mit unserem sorgfÃ¤ltig kuratierten Set.
  await mkdir(APP_STAGE, { recursive: true });
  await copyStandaloneIntoApp(STANDALONE_DIR, APP_STAGE);

  // 2a) Stage-package.json â€” leere HÃ¼lle mit minimalen Feldern, damit Node's
  //     createRequire NICHT zum Repo-Wurzel-package.json zurÃ¼ckfÃ¤llt. Wenn der
  //     Stage im Installer nach C:\HaVeWa installiert wird, ist das die
  //     verlÃ¤ssliche AuflÃ¶sungs-Wurzel. Keine Dependencies deklariert, weil
  //     die Installation Ã¼ber Next-Standalone-File-Tracing + Bootstrap-Liste
  //     gefolgt von unserer expliziten Kopier-Aktion erfolgt.
  const stagePkgPath = path.join(APP_STAGE, "package.json");
  const stagePkg = {
    name: "havewa-desktop-stage",
    version: "0.4.0",
    private: true,
    description: "HaVeWa desktop runtime stage. No dependencies declared.",
    dependencies: {},
  };
  await import("node:fs/promises").then((m) => m.writeFile(stagePkgPath, JSON.stringify(stagePkg, null, 2), "utf8"));

  // 2b) prisma/ in Stage reduzieren â€” schema.prisma + migrations/ bleiben,
  //     Source-TS-Dateien (bootstrap.ts, seed.ts) und Repo-TS-Verweise
  //     (../src/lib/...) NICHT.
  const stagePrisma = path.join(APP_STAGE, "prisma");
  if (existsSync(stagePrisma)) {
    const fsp = await import("node:fs/promises");
    await fsp.rm(stagePrisma, { recursive: true, force: true });
    await fsp.mkdir(stagePrisma, { recursive: true });
    const sourcePrisma = path.join(REPO_ROOT, "prisma");
    // schema.prisma
    await safeCopyFile(
      path.join(sourcePrisma, "schema.prisma"),
      path.join(stagePrisma, "schema.prisma"),
    );
    // migrations/ (komplett)
    await copyDirAll(
      path.join(sourcePrisma, "migrations"),
      path.join(stagePrisma, "migrations"),
    );
  }

  // 3) scripts/ (NUR die Runtime-Skripte, NICHT das gesamte Repo-Skript-Verzeichnis)
  const appScripts = path.join(APP_STAGE, "scripts");
  await mkdir(appScripts, { recursive: true });

  for (const required of [
    "start-runtime.mjs",
    "start-runtime-with-pg.mjs",
    "start-with-fallback.mjs",
    "migrate-deploy.mjs",
    "prisma-runtime-tree.mjs",
  ]) {
    await safeCopyFile(
      path.join(REPO_ROOT, "scripts", required),
      path.join(appScripts, required),
    );
  }

  // 4) Postgres-Helper-Skripte, die im Stage nÃ¶tig sind (NICHT der gesamte Block)
  //    - postgres-runtime.mjs (Resolver)
  //    - postgres-paths.mjs
  //    - postgres-port.mjs
  //    - postgres-ownership.mjs
  //    - postgres-state.mjs
  //    - postgres-lifecycle.mjs
  //    - postgres-bootstrap-db.mjs
  for (const helper of [
    "postgres-runtime.mjs",
    "postgres-paths.mjs",
    "postgres-port.mjs",
    "postgres-ownership.mjs",
    "postgres-state.mjs",
    "postgres-lifecycle.mjs",
    "postgres-bootstrap-db.mjs",
  ]) {
    await safeCopyFile(
      path.join(REPO_ROOT, "scripts", helper),
      path.join(appScripts, helper),
    );
  }

  // 5) Bootstrap-Datei
  await safeCopyFile(BOOTSTRAP_JS, path.join(appScripts, "dist", "bootstrap.js"));

  // 5a) Bootstrap-Runtime-Deps, die Next-Standalone NICHT selbst nachzieht,
  //     explizit in den Stage spiegeln. Resolve-Quelle ist die Repo-
  //     `node_modules/`. Beide kommen in `node_modules/` des APP_STAGE.
  for (const runtimeDep of ["bcryptjs"]) {
    const srcPath = path.join(REPO_ROOT, "node_modules", runtimeDep);
    if (!existsSync(srcPath)) {
      fail(`Runtime-Dep fehlt im Repo: ${srcPath}`);
    }
    const dstPath = path.join(APP_STAGE, "node_modules", runtimeDep);
    await copyDirAll(srcPath, dstPath);
  }

  // 5b) accounts.js neben bootstrap.js (transitiver Import aus src/lib/accounts).
  //     build-bootstrap.mjs erzeugt es unter scripts/dist/accounts.js.
  const distDir = path.join(REPO_ROOT, "scripts", "dist");
  for (const f of ["accounts.js", "bootstrap.js"]) {
    const src = path.join(distDir, f);
    if (existsSync(src) && !existsSync(path.join(appScripts, "dist", f))) {
      await safeCopyFile(src, path.join(appScripts, "dist", f));
    }
  }

  // 6) Prisma-CLI-Tree
  await copyDirAll(PRISMA_TREE_SRC, path.join(appScripts, ".runtime", "prisma-cli"));

  // 6.x) Neutralisierung des server.js â€” Build-Pfade aus server.js
  //      durch einen neutralen Stage-Marker ersetzen.
  await sanitizeServerJsBuildMetadata(path.join(APP_STAGE, "server.js"));
  // .next/required-server-files.json enthaelt dieselben Build-Metadaten
  // (appDir, outputFileTracingRoot, turbopack.root) â€” ebenfalls nicht
  // runtime-relevant (siehe Doku in sanitizeRequiredServerFiles).
  await sanitizeRequiredServerFiles(path.join(APP_STAGE, ".next"));

  // 6a) Fremde Prisma-Engines aus dem Standalone-.prisma/client entfernen,
  //     damit der Stage nur Windows-Engines enthÃ¤lt.
  await prunePrismaClientEngines(
    path.join(APP_STAGE, "node_modules", ".prisma", "client"),
  );
  // 6b) â€¦ und im Prisma-CLI-Tree.
  await prunePrismaClientEngines(
    path.join(appScripts, ".runtime", "prisma-cli", "node_modules", ".prisma", "client"),
  );

  // 6c) Fremde Prisma-Engines auch aus dem @prisma/engines-Tree entfernen
  //     (transitives Package, das Engines-Binaries mitbringt).
  await prunePrismaClientEngines(
    path.join(appScripts, ".runtime", "prisma-cli", "node_modules", "@prisma", "engines"),
  );
  // 6d) â€¦ und aus dem `prisma/`-Paket selbst (das `libquery_engine-*.so.node`
  //     mitbringt, die der CLI beim `migrate deploy` **nicht** lÃ¤dt).
  await prunePrismaClientEngines(
    path.join(appScripts, ".runtime", "prisma-cli", "node_modules", "prisma"),
  );

  // 6e) `@prisma/client` ist ein Framework-Distributions-Modul â€” Next-Standalone-
  //     File-Tracing reduziert es aggressiv, aber der Server-Bundle referenziert
  //     Pfade wie `@prisma/client/runtime/library.js`. Wir kopieren daher die
  //     vollstaendige `@prisma/client`-Distribution aus dem Repo-
  //     `node_modules/@prisma/client/` in den Stage. Anschliessend beschneiden
  //     wir die unnÃ¶tigen Engines (s.o. prunePrismaClientEngines).
  await copyDirAll(
    path.join(REPO_ROOT, "node_modules", "@prisma", "client"),
    path.join(APP_STAGE, "node_modules", "@prisma", "client"),
  );
  // Engines innerhalb von @prisma/client/runtime/ etc. ebenfalls beschneiden.
  await prunePrismaClientEngines(
    path.join(APP_STAGE, "node_modules", "@prisma", "client"),
  );

  // 6f) Turbopack-Modul-Aliase materialisieren.
  //     Next 16 + Turbopack referenziert externe Pakete im Server-Bundle unter
  //     einem deterministischen Alias-Namen (`@prisma/client-<16hex>`,
  //     `pino-<16hex>`, ...) und legt dazu JUNCTIONS unter
  //     `.next/standalone/.next/node_modules/` an. Im Repo loest Node das ueber
  //     den Parent-Walk auf (`.next/node_modules/...`), im Desktop-Stage gibt es
  //     diesen Pfad nicht â€” der Server wuerde mit
  //     "Cannot find module '@prisma/client-<hash>'" abbrechen.
  //     Wir materialisieren die Aliase deshalb als echte Verzeichnisse direkt
  //     unter `<app-stage>/node_modules/` (dort sucht der Server-CWD).
  //     Details + Root Cause: materializeTurbopackAliases() oben.
  const aliasResult = await materializeTurbopackAliases(APP_STAGE);
  if (aliasResult.materialized.length > 0) {
    info(`Turbopack-Aliase materialisiert: ${aliasResult.materialized.join(", ")}`);
    for (const s of aliasResult.source) info(`  alias: ${s}`);
  }
  if (aliasResult.skipped.length > 0) {
    warn(`Turbopack-Aliase uebersprungen: ${aliasResult.skipped.join(", ")}`);
  }
  if (aliasResult.materialized.length === 0) {
    fail("Keine Turbopack-Aliase gefunden â€” Server-Bundle erwartet hashed module aliases. "
      + "Build-Artefakt .next/standalone/.next/node_modules/ fehlt oder ist leer. "
      + "Bitte 'node scripts/build-standalone.mjs' erneut ausfuehren.");
  }

  // 6g) Engines in den materialisierten Aliase ebenfalls beschneiden.
  for (const rel of aliasResult.materialized) {
    await prunePrismaClientEngines(
      path.join(APP_STAGE, "node_modules", rel),
    );
  }

  // 6h) Source-Map-Metadaten im Prisma-generierten Client sanitizen
  //     (enthaelt absolute BUILD-Pfade, rein informativ, nicht runtime-relevant).
  const sm1 = await sanitizePrismaSourceMaps(
    path.join(APP_STAGE, "node_modules", ".prisma", "client"),
  );
  const sm2 = await sanitizePrismaSourceMaps(
    path.join(appScripts, ".runtime", "prisma-cli", "node_modules", ".prisma", "client"),
  );
  if (sm1 + sm2 > 0) {
    info(`Prisma-Source-Maps sanitisiert: ${sm1 + sm2} Datei(en)`);
  }

  // 7) Pflicht-PrÃ¤senz verifizieren
  for (const rel of APP_REQUIRED_PATHS) {
    const p = path.join(APP_STAGE, rel);
    if (!existsSync(p)) fail(`App-Pflichtpfad fehlt im Stage: ${p}`);
  }

  info(`app stage: ${APP_STAGE}`);
}

/**
 * Spezieller Standalone-Kopierer: wir kopieren alles aus .next/standalone/
 * mit dem normalen Predicate, BIS AUF das `scripts/`-Subdir (das wir spÃ¤ter
 * manuell sauber befÃ¼llen). Damit verhindern wir, dass buchstÃ¤blich alle
 * Repo-Skripte in den Stage driften.
 */
async function copyStandaloneIntoApp(srcRoot, dstRoot) {
  const entries = await readdir(srcRoot, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(srcRoot, e.name);
    const d = path.join(dstRoot, e.name);
    if (e.isDirectory()) {
      if (e.name === "scripts") {
        // scripts/ wird Ã¼berschrieben â€” wir lassen den Standalone-Inhalt hier
        // bewusst weg, weil wir gleich einen sauberen Set legen.
        continue;
      }
      if (!standalonePredicate(e.name)) continue;
      await copyDirFiltered(s, d, standalonePredicate);
    } else if (e.isFile()) {
      if (!standalonePredicate(e.name)) continue;
      await mkdir(path.dirname(d), { recursive: true });
      await copyFile(s, d);
    }
  }
}

// ---------------------------------------------------------------------------
// Forbidden-Datei-Detection (fÃ¼r verify-desktop-runtime.mjs exportiert)
// ---------------------------------------------------------------------------

export const FORBIDDEN_RULES = Object.freeze({
  fileExtensions: [...STANDALONE_FORBIDDEN_FILE_EXT],
  topDirs: [...STANDALONE_FORBIDDEN_TOP],
  names: [...FORBIDDEN_FORBIDDEN_FILES, ".pgdata", ".runtime-state", ".storage"],
});

export function isForbiddenName(name) {
  if (FORBIDDEN_FORBIDDEN_FILES.has(name)) return true;
  if (isTestFile(name)) return true;
  if (isForbiddenEnv(name)) return true;
  if (STANDALONE_FORBIDDEN_TOP.has(name)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Phase-Glue
// ---------------------------------------------------------------------------

function isEntryPoint() {
  try {
    if (!process.argv[1]) return false;
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cacheRoot = args.cacheRoot
    ? path.resolve(args.cacheRoot)
    : CACHE_ROOT;
  info(`repo: ${REPO_ROOT}`);
  info(`stage: ${STAGE_ROOT}`);
  info(`cache: ${cacheRoot}`);

  const lockfile = await validateCache(cacheRoot);
  await resetStage();
  await stageNode(lockfile, cacheRoot);
  await stagePostgres(lockfile, cacheRoot);
  if (!args.skipApp) {
    await stageApp();
  }
  info("OK");
}

if (isEntryPoint()) {
  main().catch((e) => fail(e?.stack || String(e)));
}
