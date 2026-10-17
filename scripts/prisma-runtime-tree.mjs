// HAVEWA-07A-2 — Prisma-Runtime-Tree-Builder (gemeinsame Logik).
//
// Wird verwendet von:
//   - scripts/package-runtime.mjs  (legt den Tree in scripts/.runtime/prisma-cli/ ab)
//   - scripts/migrate-deploy.mjs   (nutzt den gepackagten Tree)
//   - scripts/probe-prisma-cli-min.mjs (Spike-Validierung; kann bestehen bleiben)
//
// Eigenschaften:
//   - KEIN Netzwerk-Zugriff
//   - KEIN npm install
//   - Vollautomatischer Resolve via package.json-Walk
//   - Idempotent: Zielpfad wird vorher aufgeraeumt
//   - Optionaler Schema-Generate- und/oder Migrate-Deploy-Schritt

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

export const ROOT = process.cwd();

/** Benoetigte statische Top-Level-Eintraege (immer kopieren). */
export const STATIC_ENTRIES = [
  ["prisma/schema.prisma", "prisma/schema.prisma"],
  ["prisma/migrations", "prisma/migrations"],
  ["prisma/migrations/migration_lock.toml", "prisma/migrations/migration_lock.toml"],
  ["node_modules/prisma", "node_modules/prisma"],
  ["node_modules/@prisma", "node_modules/@prisma"],
];

export async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

export async function copyDir(src, dst) {
  await fs.mkdir(dst, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) await copyDir(s, d);
    else if (e.isFile()) await fs.copyFile(s, d);
  }
}

async function readJson(p) {
  return JSON.parse(await fs.readFile(p, "utf8"));
}

function collectDeps(pkg) {
  const out = new Set();
  const add = (obj) => {
    if (obj && typeof obj === "object") {
      for (const k of Object.keys(obj)) out.add(k);
    }
  };
  add(pkg.dependencies);
  add(pkg.optionalDependencies);
  return out;
}

/** Resolved rekursiv transitive Abhaengigkeiten aus package.json. */
export async function resolveTransitiveDeps(roots) {
  const seen = new Set();
  const stack = [...roots];
  while (stack.length) {
    const name = stack.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    const pkgPath = path.join(ROOT, "node_modules", name, "package.json");
    if (!(await exists(pkgPath))) continue;
    let pkg;
    try { pkg = await readJson(pkgPath); } catch { continue; }
    for (const dep of collectDeps(pkg)) {
      if (!seen.has(dep)) stack.push(dep);
    }
  }
  return seen;
}

/**
 * Baut den Tree im Zielverzeichnis auf. Liefert eine Liste der
 * tatsaechlich kopierten Top-Level-Eintraege.
 */
export async function buildPrismaTree(targetDir) {
  // Zielverzeichnis aufraeumen, dann anlegen
  await fs.rm(targetDir, { recursive: true, force: true });
  await fs.mkdir(targetDir, { recursive: true });

  const copied = [];

  // 1) Statische Eintraege
  for (const [rel, dst] of STATIC_ENTRIES) {
    const src = path.join(ROOT, rel);
    if (!(await exists(src))) {
      throw new Error(`Quelle fehlt: ${src}`);
    }
    const fullDst = path.join(targetDir, dst);
    await fs.mkdir(path.dirname(fullDst), { recursive: true });
    if ((await fs.stat(src)).isDirectory()) {
      await copyDir(src, fullDst);
    } else {
      await fs.copyFile(src, fullDst);
    }
    copied.push(rel);
  }

  // 2) Transitive Abhaengigkeiten
  const rootDeps = new Set();
  rootDeps.add("prisma");
  const prismaNs = path.join(ROOT, "node_modules", "@prisma");
  for (const ent of await fs.readdir(prismaNs, { withFileTypes: true })) {
    if (ent.isDirectory()) rootDeps.add(`@prisma/${ent.name}`);
  }
  const transitive = await resolveTransitiveDeps(rootDeps);
  for (const dep of transitive) {
    if (rootDeps.has(dep)) continue;
    const src = path.join(ROOT, "node_modules", dep);
    if (!(await exists(src))) continue;
    const dst = path.join(targetDir, "node_modules", dep);
    await copyDir(src, dst);
    copied.push(`node_modules/${dep}`);
  }

  return copied;
}

/**
 * Fuehrt einen Prisma-CLI-Befehl im gebauten Tree aus. Node-spawn,
 * kein Shell-Quoting, env durchgereicht, non-zero-Exit propagiert,
 * Timeout optional.
 */
export function runPrismaCli(treeDir, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const cliPath = path.join(treeDir, "node_modules", "prisma", "build", "index.js");
    const env = { ...process.env, ...(opts.env || {}) };
    const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
    const child = spawn(process.execPath, [cliPath, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      env,
      cwd: treeDir,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      reject(new Error(`Prisma-CLI Timeout nach ${timeoutMs}ms (args=${args.join(" ")})`));
    }, timeoutMs);
    timer.unref?.();

    child.stdout.on("data", (b) => {
      const s = b.toString();
      stdout += s;
      if (opts.inheritStdout) process.stdout.write(s);
    });
    child.stderr.on("data", (b) => {
      const s = b.toString();
      stderr += s;
      if (opts.inheritStderr) process.stderr.write(s);
    });
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve({ code, signal, stdout, stderr });
      else reject(Object.assign(new Error(
        `Prisma-CLI exit=${code} signal=${signal}\n${stderr.slice(-2000)}`,
      ), { code, signal, stdout, stderr }));
    });
  });
}
