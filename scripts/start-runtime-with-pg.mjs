// HAVEWA-07B — 07A-2 Integration: portable PostgreSQL-Lifecycle
//                                 +
//                                 bestehender 07A-2-Startup-Orchestrator.
//
// Ablauf (FIX M-3, Auftrag §12):
//   A) Postgres-Runtime finden
//   B) Runtime-State (postgres-runtime.json) lesen
//   C) Wenn State vorhanden: Ownership verifizieren
//        own-running  -> vorhandene Instanz wiederverwenden (Record.host/port)
//                        KEIN Port-Pick, KEIN Config-Write, KEIN neuer Start.
//        own-stale    -> postmaster.pid + State löschen, danach fresh path.
//        foreign-pid  -> fail closed. NICHTS anfassen, NICHTS starten.
//        Kein State + postmaster.pid in pgdata -> fail closed (unklare Ownership).
//   D) Fresh path (kein own-running):
//        first-run? -> initdb
//        Port wählen (persisted-port-reuse wenn frei, sonst 5433 -> 5434)
//        writePostgresConfig (loopback-only)
//        startPostgres
//   E) Readiness
//   F) Role + DB bootstrap
//   G) DATABASE_URL an 07A-2 (start-runtime.mjs) durchreichen
//   H) bestehende 07A-2-Sequenz (migrate -> bootstrap -> standalone -> READY)
//   I) Shutdown: erst Child sauber, dann pg_ctl stop -m fast
//
// KEIN zweiter paralleler Orchestrator. start-runtime.mjs bleibt
// single-source-of-truth.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolvePostgresRuntime } from "./postgres-runtime.mjs";
import {
  resolvePostgresDirs, isFirstRun, PG_LOOPBACK_HOST,
} from "./postgres-paths.mjs";
import { pickDbPort, readDbPortRecord, writeDbPortRecord } from "./postgres-port.mjs";
import {
  runInitDb, writePostgresConfig, startPostgres, waitForReady, stopPostgres,
} from "./postgres-lifecycle.mjs";
import {
  readPostgresState, removePostgresState,
} from "./postgres-state.mjs";
import {
  verifyOwnInstanceFromFilesystem, defaultIsPidRunning,
} from "./postgres-ownership.mjs";
import { bootstrapDatabase } from "./postgres-bootstrap-db.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..");
const START_RUNTIME = path.join(ROOT, "scripts", "start-runtime.mjs");

function info(msg) { process.stdout.write(`[start-pg] ${msg}\n`); }
function warn(msg) { process.stderr.write(`[start-pg] WARN: ${msg}\n`); }
function fail(msg, code = 1) {
  process.stderr.write(`[start-pg] FAIL: ${msg}\n`);
  process.exit(code);
}

function readDbPassword() {
  const pw = process.env.PG_DBPASSWORD?.trim();
  if (!pw) {
    fail("PG_DBPASSWORD nicht gesetzt (Pflicht, niemals defaulten).");
  }
  return pw;
}

/**
 * FIX M-3: Ermittelt, ob ein Port via TCP-Bind-Probe frei ist.
 * Wird für die Port-Reuse-Prüfung genutzt (nur fresh path).
 */
function probePortFree({ host, port }) {
  return new Promise((resolve) => {
    import("node:net").then((net) => {
      const s = net.createServer();
      s.once("error", () => resolve(false));
      s.once("listening", () => s.close(() => resolve(true)));
      s.listen(port, host);
    });
  });
}

/**
 * FIX M-3: Kernlogik — entscheidet und führt aus, was für den
 * Postgres-Lifecycle nötig ist, BEVOR Readiness/07A-2 starten.
 *
 * Reihenfolge (FIX M-3):
 *   1) State lesen
 *   2) postmaster.pid-Ownership verifizieren
 *   3) own-running -> reuse (kein port-pick, kein config-write, kein start)
 *   4) own-stale   -> cleanup, dann fresh
 *   5) foreign-pid / unklar -> abort
 *   6) fresh       -> ggf. initdb, port-pick, config-write, start
 *
 * Rückgabe:
 *   { kind: "reuse",   host, port, record }
 *   { kind: "started", host, port, record }
 *   { kind: "abort",   reason, verdict? }
 *
 * Parameter sind injizierbar für Tests (FIX M-3 §9).
 */
export async function acquirePostgres({
  paths,
  dirs,
  dbPassword,
  logger = { info, warn, err: warn },
  // Ab hier alles injizierbar (Defaults: reale Implementierungen).
  _readState = readPostgresState,
  _removeState = removePostgresState,
  _verifyOwn = verifyOwnInstanceFromFilesystem,
  _isPidRunning = defaultIsPidRunning,
  _readDbPort = readDbPortRecord,
  _writeDbPort = writeDbPortRecord,
  _pickDbPort = pickDbPort,
  _writeConfig = writePostgresConfig,
  _runInitDb = runInitDb,
  _startPostgres = startPostgres,
  _probePortFree = probePortFree,
  _unlinkPostmasterPid = async () => {
    const pmFile = path.join(dirs.pgdata, "postmaster.pid");
    try {
      if (existsSync(pmFile)) {
        const { unlinkSync } = await import("node:fs");
        unlinkSync(pmFile);
      }
    } catch { /* ignore */ }
  },
} = {}) {
  if (!paths) throw new Error("paths fehlt");
  if (!dirs || !dirs.pgdata) throw new Error("dirs.pgdata fehlt");
  if (!dbPassword) throw new Error("dbPassword fehlt");

  // 1) State lesen
  const state = await _readState(dirs.runtimeStateDir);
  logger.info(`acquire: state=${state ? "present" : "none"}`);

  // 2) State vorhanden -> Ownership verifizieren
  if (state) {
    const verdict = _verifyOwn({
      pgdata: dirs.pgdata,
      record: state.record,
      isPidRunning: _isPidRunning,
    });
    logger.info(`acquire: verdict=${verdict.kind} (${verdict.reason || "ok"})`);

    if (verdict.kind === "own-running") {
      // FIX M-3: vorhandene Instanz wiederverwenden.
      // Quelle der Wahrheit: record.host/port (nicht db-port.json, nicht Port-Probe).
      // KEIN writePostgresConfig (würde laufende Instanz korrumpieren),
      // KEIN neuer Start, KEIN Port-Pick.
      return {
        kind: "reuse",
        host: state.record.host,
        port: state.record.port,
        record: state.record,
      };
    }

    if (verdict.kind === "own-stale") {
      // pgdata gehört uns, aber PID weg. Stale-Marker sauber entfernen,
      // dann fresh path.
      logger.info("acquire: own-stale -> cleanup postmaster.pid + state");
      await _unlinkPostmasterPid();
      await _removeState(dirs.runtimeStateDir);
      // Fall through to fresh path
    } else {
      // foreign-pid: fail closed. KEIN Cleanup, KEIN Start, KEIN Stop.
      return { kind: "abort", reason: "foreign-pid", verdict };
    }
  } else {
    // Kein State. Wenn postmaster.pid in unserem pgdata liegt, ist die
    // Ownership unklar (fail-closed).
    const pmFile = path.join(dirs.pgdata, "postmaster.pid");
    if (existsSync(pmFile)) {
      return {
        kind: "abort",
        reason: "no-state-but-postmaster.pid-present",
        verdict: { kind: "foreign-pid", reason: "postmaster.pid ohne Runtime-State in unserem pgdata" },
      };
    }
  }

  // 3) Fresh path: ggf. initdb, Port wählen, Config, Start.
  if (isFirstRun({ dirs })) {
    logger.info("acquire: first-run -> initdb");
    await _runInitDb({
      paths,
      pgdata: dirs.pgdata,
      logsDir: dirs.logsDir,
      dbPassword,
      dbUser: "havewa",
      logger,
    });
  } else {
    logger.info("acquire: pgdata bereits initialisiert");
  }

  // Port wählen: persisted port wiederverwenden wenn loopback + frei;
  // sonst pickDbPort (5433 -> 5434).
  const existingPort = await _readDbPort(dirs.runtimeStateDir);
  let chosenPort = null;
  if (existingPort
      && existingPort.host === PG_LOOPBACK_HOST
      && await _probePortFree({ host: existingPort.host, port: existingPort.port })) {
    chosenPort = existingPort;
    logger.info(`acquire: port-reuse ${chosenPort.host}:${chosenPort.port}`);
  } else if (existingPort) {
    logger.info(`acquire: persisted port ${existingPort.host}:${existingPort.port} nicht frei — neue Wahl`);
  }
  if (!chosenPort) {
    const r = await _pickDbPort({});
    if (r.kind !== "ok") {
      return { kind: "abort", reason: "no-free-port", verdict: { kind: "exhausted", tried: [5433, 5434] } };
    }
    chosenPort = {
      host: r.host,
      port: r.port,
      selectedAt: new Date().toISOString(),
      tried: [5433, 5434],
    };
    await _writeDbPort(dirs.runtimeStateDir, chosenPort);
    logger.info(`acquire: port ${chosenPort.host}:${chosenPort.port}`);
  }

  // Loopback-Config schreiben (idempotent).
  await _writeConfig({ pgdata: dirs.pgdata, port: chosenPort.port });

  // Starten.
  const started = await _startPostgres({
    paths,
    dirs,
    host: chosenPort.host,
    port: chosenPort.port,
    dbPassword,
    logger,
  });
  logger.info(`acquire: started pid=${started.pid} runtimeId=${started.record.runtimeId}`);
  return { kind: "started", host: chosenPort.host, port: chosenPort.port, record: started.record };
}

async function main() {
  info(`node ${process.version} ${process.platform}/${process.arch}`);

  const dataDirOverride = process.env.HAVEWA_DATA_DIR?.trim() || null;
  const dirs = resolvePostgresDirs({ dataDirOverride });
  info(`dataDir: ${dirs.dataDir}`);
  info(`pgdata: ${dirs.pgdata}`);

  // 1) Runtime-Pfad auflösen
  const resolved = resolvePostgresRuntime({
    envValue: process.env.POSTGRES_RUNTIME_DIR?.trim() || null,
  });
  if (resolved.kind !== "ok") {
    fail(`PostgreSQL-Runtime fehlt: tools missing=${resolved.missing.join(",")}`);
  }
  const paths = resolved.paths;
  info(`pg-runtime: ${paths.runtimeDir}`);

  // 2) Lifecycle: State/Ownership/Port/Start (FIX M-3 Reihenfolge)
  const dbPassword = readDbPassword();
  const acquired = await acquirePostgres({
    paths,
    dirs,
    dbPassword,
    logger: { info, warn, err: warn },
  });

  if (acquired.kind === "abort") {
    fail(`Postgres nicht startbar: ${acquired.reason} (${acquired.verdict?.reason || ""})`);
  }
  const { host, port, record: acquiredRecord } = acquired;
  info(`postgres: ${acquired.kind} on ${host}:${port} runtimeId=${acquiredRecord?.runtimeId || "(unknown)"}`);

  // 3) Readiness
  const ready = await waitForReady({
    paths,
    host,
    port,
    timeoutMs: 30_000,
    logger: { info, warn, err: warn },
  });
  if (ready.kind !== "ready") {
    fail(`Postgres nicht ready nach ${ready.elapsedMs}ms`);
  }
  info(`postgres ready: ${ready.host}:${ready.port}`);

  // 4) Role + Datenbank sicherstellen
  await bootstrapDatabase({
    paths,
    host,
    port,
    dbPassword,
    dbUser: "havewa",
    dbName: "havewa",
    logger: { info, warn, err: warn },
  });

  // 5) DATABASE_URL für 07A-2 zusammensetzen (Credential nur in env)
  const databaseUrl = buildDatabaseUrl({
    user: "havewa",
    password: dbPassword,
    host,
    port,
    dbName: "havewa",
  });
  info(`DATABASE_URL: ${safeDbUrl(databaseUrl)}`);

  // 6) bestehenden 07A-2-Orchestrator starten (Subprozess)
  const child = spawn(process.execPath, [START_RUNTIME], {
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
    },
    stdio: "inherit",
    shell: false,
  });

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

  await new Promise((resolve) => {
    if (childExited) return resolve();
    child.on("exit", () => resolve());
  });

  // 7) Nach Child-Exit: kontrolliert Postgres stoppen
  info("07A-2 beendet — kontrolliertes Postgres-Shutdown …");
  try {
    await stopPostgres({
      paths,
      pgdata: dirs.pgdata,
      logsDir: dirs.logsDir,
      mode: "fast",
      timeoutMs: 20_000,
      logger: { info, warn, err: warn },
    });
  } catch (e) {
    warn(`postgres stop fehlgeschlagen: ${e?.message || e}`);
  }
  await removePostgresState(dirs.runtimeStateDir).catch(() => {});
  info("postgres gestoppt, runtime-state bereinigt.");

  process.exit(childExit?.code ?? (childExit?.signal ? 128 + 15 : 0));
}

function buildDatabaseUrl({ user, password, host, port, dbName }) {
  return `postgresql://${user}:${encodeURIComponent(password)}@${host}:${port}/${dbName}?schema=public`;
}

function safeDbUrl(url) {
  const m = url.match(/^postgresql:\/\/[^@]+@([^:/]+)(?::(\d+))?\/(.+?)(\?|$)/);
  if (!m) return "(url ok)";
  return `${m[1]}:${m[2] || "5432"}/${m[3]}`;
}

// Nur auto-starten, wenn diese Datei der Entry-Point ist (nicht bei Import
// durch Tests, die nur acquirePostgres nutzen wollen).
const isEntry = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] || "").href;
  } catch {
    return false;
  }
})();
if (isEntry) {
  main().catch((e) => fail(e?.stack || String(e)));
}
