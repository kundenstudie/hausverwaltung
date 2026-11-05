// HAVEWA-07A-2 — Produktiver Startup-Orchestrator.
//
// Einziger Einstiegspunkt fuer die produktionsnahe Startup-Sequenz
// (Auftrag §11):
//
//   1. Runtime ENV / HAVEWA_DATA_DIR laden
//   2. Backend-Port 3000..3005 bestimmen (127.0.0.1, loopback)
//   3. DB-Erreichbarkeit voraussetzen (TCP-Probe gegen DATABASE_URL)
//   4. scripts/migrate-deploy.mjs   (subprocess, propagiert Exit)
//   5. scripts/dist/bootstrap.js     (subprocess)
//   6. Next standalone starten       (server.js aus .next/standalone/,
//                                    mit PORT + HOSTNAME)
//   7. /api/ready pollen             (max 60s)
//   8. bei Erfolg READY melden
//   9. bei Fehler non-zero beenden   (kind-process sauber stoppen)
//
// Voraussetzungen:
//   - DATABASE_URL gesetzt
//   - scripts/.runtime/prisma-cli/   gebaut (scripts/package-runtime.mjs)
//   - scripts/dist/bootstrap.js     gebaut (scripts/build-bootstrap.mjs)
//   - .next/standalone/             gebaut (scripts/build-standalone.mjs)
//
// Robustheit:
//   - Signal-Forwarding (SIGINT/SIGTERM) an die Standalone-Subprocess
//   - Auf exit des Kindes: non-zero beenden mit dessen Exitcode
//   - Kein Tauri, kein PostgreSQL-Prozessmanagement hier
//   - 5432 nicht hart kodiert; DB-URL kommt aus ENV

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { HOST, PORTS } from "./start-with-fallback.mjs";
// data-dir.ts ist TypeScript; wir replizieren die Pfad-Logik hier in
// reinem JS, damit dieses Skript ohne tsx-Loader laeuft. Die TS-Quelle
// bleibt kanonisch (siehe src/lib/data-dir.ts) und hat Unit-Tests.

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..");

/**
 * HAVEWA-07D G2 — Stage-Aware Standalone-Lookup.
 *
 * Im Dev-/Repo-Pfad erwarten wir `.next/standalone/server.js`.
 * Im Desktop-Stage ist der Next-Standalone-Baum direkt in `runtime/app/`
 * flach kopiert — d.h. `server.js` liegt im Stage-Root. Wir erkennen das an
 * einer Stage-Marker-Datei (`runtime/app/package.json` MIT `name ==
 * "havewa-desktop-stage"`).
 *
 * Wenn der Marker vorhanden ist:
 *   - STANDALONE_DIR = ROOT (= app/ Stage-Root)
 *   - SERVER_JS = ROOT/server.js (kein `.next/standalone/`-Prefix)
 * Sonst:
 *   - STANDALONE_DIR = ROOT/.next/standalone
 *   - SERVER_JS = ROOT/.next/standalone/server.js
 *
 * Das beruehrt keine Dev-Pfade; nur wenn der Stage-Marker existiert,
 * schaltet das Script auf Stage-Layout.
 */
function isStage() {
  try {
    const pkgRaw = readFileSync(path.join(ROOT, "package.json"), "utf8");
    const pkg = JSON.parse(pkgRaw);
    return pkg?.name === "havewa-desktop-stage";
  } catch {
    return false;
  }
}

const STAGE = isStage();
const STANDALONE_DIR = STAGE ? ROOT : path.join(ROOT, ".next", "standalone");
const BOOTSTRAP_JS = STAGE
  ? path.join(ROOT, "scripts", "dist", "bootstrap.js")
  : path.join(ROOT, "scripts", "dist", "bootstrap.js");
const MIGRATE_RUNNER = STAGE
  ? path.join(ROOT, "scripts", "migrate-deploy.mjs")
  : path.join(ROOT, "scripts", "migrate-deploy.mjs");

const READY_TIMEOUT_MS = 60_000;
const DB_PROBE_TIMEOUT_MS = 5_000;

function fail(msg, code = 1) {
  process.stderr.write(`[start-runtime] FAIL: ${msg}\n`);
  process.exit(code);
}

function info(msg) {
  process.stdout.write(`[start-runtime] ${msg}\n`);
}
function warn(msg) {
  process.stderr.write(`[start-runtime] WARN ${msg}\n`);
}

function dataDirLocal() {
  return process.env.HAVEWA_DATA_DIR?.trim() || process.cwd();
}

function runtimeStateDirLocal() {
  return path.join(dataDirLocal(), "runtime-state");
}

function parseDbUrl(url) {
  // postgresql://user:pass@host:port/db?schema=public
  // Wir matchen NUR host/port, nicht user/pass.
  const m = url.match(/^postgresql:\/\/[^@]+@([^:/]+)(?::(\d+))?\//);
  if (!m) return null;
  return { host: m[1], port: m[2] ? parseInt(m[2], 10) : 5432 };
}

async function probeDb(dbUrl) {
  const p = parseDbUrl(dbUrl);
  if (!p) throw new Error(`DATABASE_URL nicht parsbar: ${dbUrl}`);
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: p.host, port: p.port });
    const t = setTimeout(() => {
      sock.destroy();
      reject(new Error(`DB-Connect-Timeout nach ${DB_PROBE_TIMEOUT_MS}ms (${p.host}:${p.port})`));
    }, DB_PROBE_TIMEOUT_MS);
    t.unref?.();
    sock.once("connect", () => { clearTimeout(t); sock.end(); resolve({ host: p.host, port: p.port }); });
    sock.once("error", (e) => { clearTimeout(t); reject(e); });
  });
}

function probePort(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(port, HOST);
  });
}

async function pickPort() {
  for (const p of PORTS) {
    if (await probePort(p)) return p;
    info(`Port ${p} belegt, versuche naechsten …`);
  }
  fail(`Kein freier Port in [${PORTS.join(", ")}] auf ${HOST}.`);
}

async function writeRuntimeState(port) {
  const dir = runtimeStateDirLocal();
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "port.json"),
      JSON.stringify({ host: HOST, port, startedAt: new Date().toISOString() }, null, 2),
      "utf8",
    );
  } catch (e) {
    info(`Hinweis: runtime-state konnte nicht geschrieben werden: ${e?.message || e}`);
  }
}

function runChild(cmd, args, env, label) {
  return new Promise((resolve, reject) => {
    info(`${label}: ${cmd} ${args.join(" ")}`);
    const child = spawn(cmd, args, {
      stdio: "inherit",
      shell: false,
      env: { ...process.env, ...env },
    });
    child.on("error", (e) => reject(e));
    child.on("exit", (code, signal) => {
      if (code === 0) resolve({ code, signal });
      else reject(new Error(`${label} exit=${code}${signal ? " signal=" + signal : ""}`));
    });
  });
}

async function pollReady(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ok = await new Promise((resolve) => {
        const req = http.request(
          { host: HOST, port, path: "/api/ready", method: "GET", timeout: 2000 },
          (res) => {
            res.resume();
            resolve(res.statusCode === 200);
          },
        );
        req.once("error", () => resolve(false));
        req.once("timeout", () => { req.destroy(); resolve(false); });
        req.end();
      });
      if (ok) return true;
    } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function main() {
  info(`node ${process.version} ${process.platform}/${process.arch}`);

  // 1) ENV / HAVEWA_DATA_DIR
  info(`HAVEWA_DATA_DIR: ${process.env.HAVEWA_DATA_DIR?.trim() || "(unset, fallback process.cwd)"}`);
  info(`dataDir: ${dataDirLocal()}`);

  // 2) Port bestimmen.
  //    Repo-Pfad: Auto-Pick (3000..3005).
  //    Stage-Pfad mit HAVEWA_DESKTOP_RUNTIME=1: explizit aus process.env.PORT
  //    (z. B. vom Installer gesetzt); fallback auf Auto-Pick.
  let port;
  if (process.env.HAVEWA_DESKTOP_RUNTIME === "1" && process.env.PORT) {
    port = parseInt(process.env.PORT, 10);
    if (!Number.isFinite(port) || port <= 0) {
      fail(`PORT ungueltig: ${process.env.PORT}`);
    }
    // Sicherstellen, dass der Port loopback-bind-frei ist. Wenn nicht,
    // fallback auf Auto-Pick.
    const free = await probePort(port);
    if (!free) {
      warn(`Port ${port} belegt — fallback auf Auto-Pick`);
      port = await pickPort();
    }
  } else {
    port = await pickPort();
  }
  info(`chosen port: ${HOST}:${port}`);
  await writeRuntimeState(port);

  // 3) DB-Erreichbarkeit
  const dbUrl = process.env.DATABASE_URL?.trim();
  if (!dbUrl) fail("DATABASE_URL nicht gesetzt (Pflicht).");
  info(`probing DB: ${(() => { const p = parseDbUrl(dbUrl); return p ? `${p.host}:${p.port}` : "(url ok)"; })()}`);
  try {
    await probeDb(dbUrl);
    info("DB reachable.");
  } catch (e) {
    fail(`DB nicht erreichbar: ${e?.message || e}`);
  }

  // Voraussetzungen pruefen
  if (!existsSync(MIGRATE_RUNNER)) fail(`migrate-deploy.mjs fehlt: ${MIGRATE_RUNNER}`);
  if (!existsSync(BOOTSTRAP_JS)) fail(`bootstrap.js fehlt: ${BOOTSTRAP_JS}. Bitte zuerst 'node scripts/build-bootstrap.mjs' ausfuehren.`);
  if (!existsSync(STANDALONE_DIR)) fail(`Standalone-Build fehlt: ${STANDALONE_DIR}. Bitte zuerst 'node scripts/build-standalone.mjs' ausfuehren.`);
  if (!existsSync(path.join(STANDALONE_DIR, "server.js"))) fail(`server.js fehlt im Standalone: ${STANDALONE_DIR}`);

  // 4) migrate deploy
  try {
    await runChild(process.execPath, [MIGRATE_RUNNER], { DATABASE_URL: dbUrl }, "migrate-deploy");
  } catch (e) {
    fail(`migrate-deploy: ${e?.message || e}`);
  }

  // 5) bootstrap
  try {
    await runChild(process.execPath, [BOOTSTRAP_JS], { DATABASE_URL: dbUrl }, "bootstrap");
  } catch (e) {
    fail(`bootstrap: ${e?.message || e}`);
  }

  // 6) Next standalone starten
  info(`starte standalone server.js mit PORT=${port} HOSTNAME=${HOST}`);
  // HAVEWA-07D G2 Hardening: KEIN `--require`-Monkeypatch mehr.
  // Next/Turbopack-Aliase (`@prisma/client-<16hex>`) werden beim Staging
  // statisch als echte Verzeichnisse unter <app-stage>/node_modules/
  // materialisiert (siehe scripts/package-desktop-runtime.mjs ->
  // materializeTurbopackAliases). Dadurch laesst sich der Server ohne
  // globalen Module._resolveFilename-Patch starten.
  const child = spawn(process.execPath, [path.join(STANDALONE_DIR, "server.js")], {
    stdio: "inherit",
    shell: false,
    env: { ...process.env, DATABASE_URL: dbUrl, PORT: String(port), HOSTNAME: HOST },
    cwd: STANDALONE_DIR,
  });

  // Signal-Forwarding
  const forward = (sig) => {
    try { child.kill(sig); } catch { /* ignore */ }
  };
  process.on("SIGINT", () => forward("SIGINT"));
  process.on("SIGTERM", () => forward("SIGTERM"));
  process.on("SIGHUP", () => forward("SIGHUP"));

  let childExited = false;
  let childExit = null;
  child.on("exit", (code, signal) => {
    childExited = true;
    childExit = { code, signal };
  });

  // 7) /api/ready pollen
  info(`polling /api/ready (timeout ${READY_TIMEOUT_MS}ms) …`);
  const ready = await pollReady(port, READY_TIMEOUT_MS);
  if (!ready) {
    if (childExited) {
      fail(`Backend beendete sich waehrend readiness-poll: ${JSON.stringify(childExit)}`);
    } else {
      forward("SIGTERM");
      fail(`readiness-Timeout nach ${READY_TIMEOUT_MS}ms (kein 200 von /api/ready)`);
    }
    return;
  }

  // 8) READY
  info(`READY: ${HOST}:${port}`);

  // Auf exit des Kindes warten
  await new Promise((resolve) => {
    if (childExited) return resolve();
    child.on("exit", () => resolve());
  });

  // 9) Propagiere Exit
  if (!childExit) process.exit(0);
  process.exit(childExit.code ?? (childExit.signal ? 128 + 15 : 1));
}

main().catch((e) => fail(e?.stack || String(e)));
