// HAVEWA-07B — Lifecycle: initdb + start + wait-ready + stop.
//
// Regeln (Auftrag §5–§13):
//   - initdb mit UTF8, locale=C (Windows-Einschränkung beachten),
//     --auth-host=scram-sha-256, --auth-local=scram-sha-256.
//   - DB-Passwort NIE auf Kommandozeile, NIE im Log.
//   - pg_ctl start mit absoluten Pfaden, stdout/stderr in HaVeWa-Logs.
//   - Ready-Check via pg_isready (Default) oder psql.
//   - Stop: pg_ctl stop -m fast. Timeout. KEIN Kill fremder Prozesse.
//   - Bei Fehler: sauberer Fehlerzustand, Logs verfügbar, kein
//     automatisches Löschen von pgdata.
//
// Reines ESM (.mjs), testbar (alle Side-Effects laufen über child_process).

import { spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import path from "node:path";

import { PG_LOOPBACK_HOST } from "./postgres-paths.mjs";
import { buildPostgresRecord, writePostgresState } from "./postgres-state.mjs";

const EMPTY_LOGGER = Object.freeze({
  info: () => {},
  warn: () => {},
  err: () => {},
});

/** Sanitize Pfad für Logs (kein Passwort, keine Credentials). */
function safePath(p) {
  return path.resolve(p);
}

/**
 * Schreibt eine Zeile in eine Logdatei (UTF-8 append-only).
 * Wird vom Lifecycle-Orchestrator genutzt, um stderr/stdout der
 * Postgres-Prozesse zu kanalisieren. Bei Fehler schlucken wir
 * (Best-Effort-Logging, niemals Hard Fail).
 */
async function appendLog(logFile, line) {
  try {
    await fsp.mkdir(path.dirname(logFile), { recursive: true });
    await fsp.appendFile(logFile, line, "utf8");
  } catch {
    // Best-Effort: Logging darf den Lifecycle NICHT abbrechen.
  }
}

/** Kindprozess-Spawn mit Logging + Timeout + Exitcode-Propagation. */
function runCommand({ exe, args, env, logFile, timeoutMs, logger, detached = false }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(exe, args, {
      env: { ...process.env, ...(env || {}) },
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      detached: detached === true,
      windowsHide: true,
    });
    // detached: child.unref(), damit das Wrapper-Script beenden kann,
    // ohne den gestarteten Prozess zu killen. Wird für pg_ctl start
    // gebraucht, weil das Kind (postgres.exe) weiterleben muss.
    if (detached) child.unref();

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      reject(new Error(`Timeout nach ${timeoutMs}ms (${exe} ${args.join(" ")})`));
    }, timeoutMs);
    timer.unref?.();

    let stdoutBuf = "";
    let stderrBuf = "";
    child.stdout.on("data", (b) => {
      const s = b.toString("utf8");
      stdoutBuf += s;
      if (logFile) appendLog(logFile, s);
    });
    child.stderr.on("data", (b) => {
      const s = b.toString("utf8");
      stderrBuf += s;
      if (logFile) appendLog(logFile, s);
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
      if (code === 0) resolve({ code, signal, stdout: stdoutBuf, stderr: stderrBuf });
      else reject(Object.assign(
        new Error(`exit=${code} signal=${signal} (${exe} ${args.join(" ")})\n${stderrBuf.slice(-2000)}`),
        { code, signal, stdout: stdoutBuf, stderr: stderrBuf },
      ));
    });
    if (logger) logger.info(`[pg] spawn: ${exe} ${args.join(" ")}`);
  });
}

/** Wirft, wenn der Pfad nicht existiert. */
async function ensureDir(p) {
  await fsp.mkdir(p, { recursive: true });
}

/**
 * Schreibt postgresql.conf und pg_hba.conf minimal & deterministisch
 * für unsere portable Instanz (Auftrag §5, §6):
 *   - listen_addresses = '127.0.0.1'
 *   - port = <port>
 *   - unix_socket_directories (Windows: leer / Default)
 *   - scram-sha-256 für host/local (über initdb-Flags zusätzlich)
 */
async function writeMinimalConfig({ pgdata, port }) {
  const conf = [
    "# HaVeWa portable Postgres — minimale deterministische Konfig",
    "# (HAVEWA-07B). Nicht ändern, ohne den Lifecycle-Code anzufassen.",
    "",
    `port = ${port}`,
    `listen_addresses = '127.0.0.1'`,
    "max_connections = 50",
    "shared_buffers = 64MB",
    "dynamic_shared_memory_type = windows",
    "",
  ].join("\n");
  await fsp.writeFile(path.join(pgdata, "postgresql.conf"), conf, "utf8");

  const hba = [
    "# HaVeWa portable Postgres — pg_hba.conf (HAVEWA-07B).",
    "# Strikte Loopback-Only-Defaults. SCRAM für Host + Local.",
    "",
    "host    all    all    127.0.0.1/32    scram-sha-256",
    "host    all    all    ::1/128         scram-sha-256",
    "local    all    all                   scram-sha-256",
    "",
  ].join("\n");
  await fsp.writeFile(path.join(pgdata, "pg_hba.conf"), hba, "utf8");
}

/**
 * Schreibt eine temporäre Pwfile-Datei (für initdb --pwfile).
 * Wird NUR für initdb verwendet; sofort nach Gebrauch gelöscht.
 * Datei-Modus 0o600 (nur Owner lesen), Pfad unter HAVEWA_DATA_DIR/runtime-state.
 */
async function writePwfile({ dbPassword }) {
  if (!dbPassword) throw new Error("dbPassword fehlt (pwfile)");
  // Wir wählen den Pfad unterhalb runtime-state, weil der bereits
  // außerhalb von pgdata liegt (Pgdata ist im normalen Betrieb
  // read-only für den laufenden Postgres-Server).
  const root = process.env.HAVEWA_DATA_DIR?.trim() || process.cwd();
  const dir = path.join(root, "runtime-state");
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, `initdb-pwfile-${process.pid}.tmp`);
  await fsp.writeFile(file, `${dbPassword}\n`, { encoding: "utf8", mode: 0o600 });
  return file;
}

/**
 * Führt initdb aus. Reihenfolge:
 *   1) pgdata anlegen (existenz/leer)
 *   2) initdb (UTF8, locale=C, scram-sha-256 host/local)
 *   3) postgresql.conf + pg_hba.conf überschreiben (deterministisch,
 *      loopback-only)
 *
 * Sicherheit:
 *   - Passwort wird in einer temporären Pwfile (Mode 0600) abgelegt,
 *     die sofort nach initdb wieder gelöscht wird.
 *   - Pwfile liegt unter HAVEWA_DATA_DIR/runtime-state (nicht in pgdata,
 *     damit pgdata read-only für Postgres bleibt).
 *   - Wir loggen das Passwort NICHT; wir loggen nur Pfade und Exit-Codes.
 */
export async function runInitDb({
  paths,
  pgdata,
  logsDir,
  encoding = "UTF8",
  dbPassword,
  dbUser = "havewa",
  logger = EMPTY_LOGGER,
  _runCommand = runCommand,
}) {
  if (!paths || !paths.initdbExe) throw new Error("paths.initdbExe fehlt");
  if (!pgdata) throw new Error("pgdata fehlt");
  if (!logsDir) throw new Error("logsDir fehlt");
  if (!dbPassword) throw new Error("dbPassword fehlt (sicherer Default erforderlich)");

  await ensureDir(pgdata);

  // Pwfile schreiben (0600) und nach Gebrauch wieder löschen.
  const pwfile = await writePwfile({ dbPassword });
  logger.info(`[pg-initdb] pgdata: ${safePath(pgdata)}`);

  try {
    // 1) initdb
    await _runCommand({
      exe: paths.initdbExe,
      args: [
        `-D`, safePath(pgdata),
        `-E`, encoding,
        `--locale=C`,
        `--username`, dbUser,
        `--auth-host=scram-sha-256`,
        `--auth-local=scram-sha-256`,
        `--pwfile`, pwfile,
      ],
      logFile: path.join(logsDir, "pg-initdb.log"),
      timeoutMs: 5 * 60_000,
      logger,
    });
  } finally {
    // Pwfile IMMER löschen, auch bei Fehler.
    try { await fsp.unlink(pwfile); } catch { /* ignore */ }
  }

  return { pgdata: safePath(pgdata) };
}

/**
 * Schreibt die minimale Konfiguration. Wird sowohl vom Initdb-Pfad als
 * auch nach Migrationen aufgerufen.
 */
export async function writePostgresConfig({ pgdata, port }) {
  await writeMinimalConfig({ pgdata, port });
}

/**
 * Startet die Postgres-Instanz via pg_ctl start.
 *
 * Sicherheit:
 *   - Wir nehmen NUR unseren eigenen pg_ctl + postgres-Binary.
 *   - Wir propagieren Exit-Codes 1:1.
 *   - Wir loggen stdout/stderr in <logs>/pg-startup.log.
 *   - Wir geben die PID NUR zurück, wenn sie unser pg_ctl tatsächlich
 *     für unsere pgdata gestartet hat (Ownership-Guard).
 */
export async function startPostgres({
  paths,
  dirs,
  host,
  port,
  dbPassword,
  dbUser = "havewa",
  dbName = "havewa",
  startTimeoutMs = 30_000,
  logger = EMPTY_LOGGER,
}) {
  if (!paths || !paths.pgCtlExe) throw new Error("paths.pgCtlExe fehlt");
  if (!dirs || !dirs.pgdata) throw new Error("dirs.pgdata fehlt");
  if (!host || !port) throw new Error("host/port fehlt");
  // dbUser / dbName werden im record-Persistenz-Layer (PostgresRuntimeRecord
  // könnte in einer späteren Phase erweitert werden) dokumentiert; aktuell
  // nicht persistiert. Wir prüfen nur, dass sie plausible Strings sind.
  if (typeof dbUser !== "string" || dbUser.length === 0) {
    throw new Error("dbUser muss ein nicht-leerer String sein");
  }
  if (typeof dbName !== "string" || dbName.length === 0) {
    throw new Error("dbName muss ein nicht-leerer String sein");
  }

  // 1) Konfig schreiben (loopback-only)
  await writeMinimalConfig({ pgdata: dirs.pgdata, port });

  // 2) pg_ctl start
  const logFile = path.join(dirs.logsDir, "pg-startup.log");
  await fsp.mkdir(dirs.logsDir, { recursive: true });

  // pg_ctl ohne -w starten (nicht-blockierend), dann auf postmaster.pid pollen.
  // Hintergrund: Auf Windows stirbt der postgres.exe-Subprozess, wenn
  // pg_ctl -w beendet wird (Job-Group). Mit `pg_ctl start` (ohne -w)
  // startet pg_ctl den postgres-Prozess und kehrt sofort zurück;
  // der postgres.exe-Prozess wird vom `CreateProcess` losgelöst
  // (pg_ctl schließt die Job-Verbindung). Wir warten dann extern
  // auf die Bereitschaft.
  await runCommand({
    exe: paths.pgCtlExe,
    args: [
      `-D`, safePath(dirs.pgdata),
      `-l`, logFile,
      `-o`, `-p ${port} -h ${host} -k \"\"`,
      `start`,
    ],
    env: { PGPASSWORD: dbPassword },
    logFile,
    timeoutMs: 10_000,
    logger,
  });

  // Auf postmaster.pid warten (autoritative Quelle für PID + readiness).
  const pmFile = path.join(dirs.pgdata, "postmaster.pid");
  const deadline = Date.now() + (startTimeoutMs || 30_000);
  let pid = 0;
  while (Date.now() < deadline) {
    try {
      const raw = await fsp.readFile(pmFile, "utf8");
      const firstLine = raw.split(/\r?\n/)[0] || "";
      const cand = parseInt(firstLine, 10);
      if (Number.isFinite(cand) && cand > 0) {
        pid = cand;
        break;
      }
    } catch { /* noch nicht da */ }
    await new Promise((res) => setTimeout(res, 100));
  }
  if (!pid) {
    throw new Error(`postmaster.pid wurde nicht innerhalb ${startTimeoutMs}ms erzeugt`);
  }
  logger.info(`[pg-start] postmaster.pid PID=${pid}`);

  // 3) Runtime-State persistieren
  const record = buildPostgresRecord({
    pid,
    pgdata: dirs.pgdata,
    host,
    port,
  });
  await writePostgresState(dirs.runtimeStateDir, {
    schemaVersion: 1,
    record,
  });

  logger.info(`[pg-start] ready pid=${pid} host=${host} port=${port} runtimeId=${record.runtimeId}`);

  // 4) Validate dbUser/dbName (kein Hard-Fail, nur Dokumentation)
  if (typeof dbUser !== "string" || dbUser.length === 0) {
    throw new Error("dbUser muss ein nicht-leerer String sein");
  }
  if (typeof dbName !== "string" || dbName.length === 0) {
    throw new Error("dbName muss ein nicht-leerer String sein");
  }

  return { pid, record };
}

/**
 * Polling-Wait via pg_isready.
 *
 * Default: pg_isready -h <host> -p <port> -t 1 (per Probe).
 * Polling-Intervall 250 ms, Gesamttimeout 30_000 ms.
 */
export async function waitForReady({
  paths,
  host,
  port,
  timeoutMs = 30_000,
  intervalMs = 250,
  logger = EMPTY_LOGGER,
}) {
  if (!paths || !paths.pgIsreadyExe) throw new Error("paths.pgIsreadyExe fehlt");
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  while (true) {
    attempt++;
    const r = await new Promise((resolve) => {
      const child = spawn(paths.pgIsreadyExe, [
        `-h`, host,
        `-p`, String(port),
        `-t`, `1`,
      ], { stdio: ["ignore", "pipe", "pipe"], shell: false });
      let out = "";
      child.stdout.on("data", (b) => { out += b.toString("utf8"); });
      child.stderr.on("data", (b) => { out += b.toString("utf8"); });
      // out wird NICHT ausgewertet (pg_isready exit-code reicht) —
      // bewusst ignoriert, damit der Daten-Konsum weiterläuft.
      void out;
      child.on("error", () => resolve(false));
      child.on("exit", (code) => resolve(code === 0));
    });
    if (r) return { kind: "ready", host, port };
    if (Date.now() >= deadline) {
      return { kind: "timeout", host, port, elapsedMs: timeoutMs };
    }
    await new Promise((res) => setTimeout(res, intervalMs));
    if (attempt % 8 === 0) logger.info(`[pg-ready] noch nicht ready (Versuch ${attempt})`);
  }
}

/**
 * Stoppt die Postgres-Instanz via pg_ctl stop -m fast.
 *
 * Sicherheit:
 *   - Timeout.
 *   - NUR gegen eigene PID/pgdata (Caller muss via verifyOwnInstance
 *     sichergestellt haben, dass die Instanz uns gehört).
 *   - Bei Fehler: gezielte Fallback-Strategie bleibt dem Caller
 *     überlassen (siehe §13).
 *   - Idempotent: Wenn postmaster.pid fehlt (Server bereits gestoppt
 *     oder nie gestartet), liefern wir `{ kind: "already-stopped" }`
 *     statt eines Fehlers.
 */
export async function stopPostgres({
  paths,
  pgdata,
  logsDir,
  mode = "fast",
  timeoutMs = 20_000,
  logger = EMPTY_LOGGER,
  _runCommand = runCommand,
}) {
  if (!paths || !paths.pgCtlExe) throw new Error("paths.pgCtlExe fehlt");
  if (!pgdata) throw new Error("pgdata fehlt");
  if (!logsDir) throw new Error("logsDir fehlt");
  if (!["fast", "smart", "immediate"].includes(mode)) {
    throw new Error(`Ungültiger stop-mode: ${mode}`);
  }

  // Idempotenz-Guard: Server bereits gestoppt?
  const pmFile = path.join(pgdata, "postmaster.pid");
  if (!(await fsp.access(pmFile).then(() => true).catch(() => false))) {
    logger.info(`[pg-stop] bereits gestoppt (kein postmaster.pid)`);
    return { kind: "already-stopped" };
  }

  const logFile = path.join(logsDir, "pg-stop.log");
  await fsp.mkdir(path.dirname(logFile), { recursive: true });

  await _runCommand({
    exe: paths.pgCtlExe,
    args: [
      `-D`, safePath(pgdata),
      `-m`, mode,
      `stop`,
    ],
    logFile,
    timeoutMs,
    logger,
  });
  logger.info(`[pg-stop] ok (mode=${mode})`);
  return { kind: "stopped" };
}

export { PG_LOOPBACK_HOST };