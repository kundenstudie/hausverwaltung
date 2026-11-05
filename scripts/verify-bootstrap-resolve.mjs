// Liste die Module, die aus dem Bootstrap-Entry (`scripts/dist/bootstrap.js`)
// als `require(...)`-Aufrufe resultieren. Wir parsen den Source (transitiv).
//
// Bootstrap liegt im Stage unter runtime/app/scripts/dist/bootstrap.js
// und wird mit `node scripts/dist/bootstrap.js` ausgeführt.
// Wir wollen sicherstellen, dass ALLE transitiven requires im Stage
// aufgelöst werden können, ohne Repo-Fallbacks.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const APP_STAGE = path.join(REPO_ROOT, "src-tauri", "resources", "runtime", "app");
const BOOTSTRAP = path.join(APP_STAGE, "scripts", "dist", "bootstrap.js");

if (!existsSync(BOOTSTRAP)) {
  process.stderr.write(`[verify-bootstrap] Bootstrap fehlt: ${BOOTSTRAP}\n`);
  process.exit(2);
}

/**
 * Sehr einfache require-/import-Extractor:
 *   - require("name")
 *   - require('name')
 *   - import "name" / import "name"
 *   - import name from "name"
 *
 * Erkennt keine dynamischen Requires (String-Variablen), keine ESM-Imports
 * außer statische. F\u00fcr Bootstrap (CJS) reicht das.
 */
const requireRegex = /(?:require\(\s*['"]([^'"]+)['"]\s*\)|from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"])/g;

async function extractDeps(filePath, seen = new Set()) {
  if (seen.has(filePath)) return [];
  seen.add(filePath);
  const text = await readFile(filePath, "utf8");
  const out = [];
  let m;
  while ((m = requireRegex.exec(text)) !== null) {
    const name = m[1] || m[2] || m[3];
    if (!name) continue;
    if (name.startsWith(".") || name.startsWith("/")) {
      // lokale Datei — versuchen, sie zu laden
      const baseDir = path.dirname(filePath);
      const resolved = path.resolve(baseDir, name);
      for (const ext of ["", ".js", ".mjs", ".cjs", ".json"]) {
        const tryPath = resolved + ext;
        if (existsSync(tryPath)) {
          const inner = await extractDeps(tryPath, seen);
          out.push(...inner);
          break;
        }
      }
    } else {
      // node-Modul
      out.push(name);
    }
  }
  return out;
}

const directDeps = await extractDeps(BOOTSTRAP);
const uniqDeps = [...new Set(directDeps)];

// Wir checken Resolution pro Modul
const stageRequire = createRequire(path.join(APP_STAGE, "scripts", "bootstrap-entry.js"));

const repoLeaks = [];
const stageHits = [];

for (const dep of uniqDeps) {
  if (dep.startsWith("node:")) continue; // built-in
  let resolved;
  try {
    resolved = stageRequire.resolve(dep);
  } catch (e) {
    // vielleicht optional/dev-only — wir vermerken, brechen nicht sofort ab.
    repoLeaks.push(`${dep}: not resolvable from Stage (${e.message.split('\n')[0]})`);
    continue;
  }
  if (!resolved.startsWith(APP_STAGE)) {
    repoLeaks.push(`${dep} resolved OUTSIDE Stage (${resolved})`);
  } else {
    stageHits.push(`${dep} \u2192 ${resolved}`);
  }
}

if (repoLeaks.length > 0) {
  process.stderr.write(`[verify-bootstrap] FAIL: Repo-Leaks gefunden:\n`);
  for (const l of repoLeaks) process.stderr.write(`  - ${l}\n`);
  process.exit(1);
}

process.stdout.write(`[verify-bootstrap] OK: alle ${stageHits.length} Bootstrap-Deps resolvable im Stage\n`);
