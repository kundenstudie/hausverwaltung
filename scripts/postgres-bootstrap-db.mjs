// HAVEWA-07B — Datenbank/Role-Bootstrap (idempotent).
//
// Regeln (Auftrag §10, FIX M-1):
//   - Sicherstellen, dass die HaVeWa-Runtime-Role vorhanden ist
//   - Sicherstellen, dass die HaVeWa-Datenbank vorhanden ist
//   - Idempotent: vorhandene DBs/Users NICHT verändern
//   - Keine Secrets loggen, keine Secrets im spawn-argv
//   - Keine bestehende fremde DB verändern
//
// Implementation: psql via child_process (kein DB-Driver im Sidecar).
//
// Sicherheit (FIX M-1):
//   - SQL wird über stdin an psql übergeben (NICHT via -c argv).
//   - Damit landet das DB-Passwort (in CREATE ROLE ... PASSWORD '…')
//     NIE im Prozess-argv, sondern nur im stdin-Pipe (in-memory).
//   - Authentifizierung gegenüber Postgres via PGPASSWORD-Env.
//   - Wir loggen weder das SQL noch das Passwort; nur host/port/db.

import { spawn } from "node:child_process";

const EMPTY_LOGGER = Object.freeze({
  info: () => {},
  warn: () => {},
  err: () => {},
});

/**
 * psql-Helfer. Liefert stdout zurück. Bei Fehler wirft.
 *
 * FIX M-1: SQL wird via stdin an psql gepiped; psql-argv enthält
 * nur host/port/user/db (kein Passwort, kein SQL).
 */
function psqlExec({ paths, host, port, dbUser, dbPassword, db, sql, timeoutMs = 10_000, logger = EMPTY_LOGGER, _spawn = spawn }) {
  return new Promise((resolve, reject) => {
    // Bewusst OHNE `-c <sql>` — das SQL geht durch stdin.
    const args = [
      `-h`, host,
      `-p`, String(port),
      `-U`, dbUser,
      `-d`, db || `postgres`,
      `-t`, `-A`, // tuples-only, unaligned
    ];
    const child = _spawn(paths.psqlExe, args, {
      env: { ...process.env, PGPASSWORD: dbPassword },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      reject(new Error(`psql Timeout nach ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on("data", (b) => { stdout += b.toString("utf8"); });
    child.stderr?.on("data", (b) => { stderr += b.toString("utf8"); });
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      else reject(new Error(`psql exit=${code}: ${stderr.trim() || stdout.trim()}`));
    });

    // SQL via stdin an psql senden und stdin schließen.
    // Das SQL (inkl. PASSWORD-Literal) liegt damit NUR im stdin-Pipe,
    // nicht im argv.
    if (child.stdin) {
      child.stdin.on("error", () => { /* ignore EPIPE etc. */ });
      child.stdin.write(sql);
      child.stdin.end();
    }

    // Wir loggen absichtlich NICHT das SQL (enthält das Passwort).
    logger.info(`[pg-bootstrap] psql -d ${db || "postgres"} (stdin, sql-bytes=${Buffer.byteLength(sql, "utf8")})`);
  });
}

/**
 * Test-Export (FIX M-1): erlaubt Tests, psqlExec mit einem injizierten
 * _spawn aufzurufen, um argv/Stdin zu prüfen.
 */
export function __psqlExecForTest(opts, _spawnFn) {
  return psqlExec({ ...opts, _spawn: _spawnFn });
}

/**
 * Stellt sicher, dass die Rolle existiert.
 *
 * WICHTIG: wir verändern KEIN Passwort bestehender User. Wenn der User
 * schon existiert, lassen wir ihn in Ruhe (Auftrag §10: idempotent).
 *
 * Architektur-Hinweis: Der initdb-Superuser heißt NICHT zwingend
 * "postgres". Bei `initdb --username havewa` ist `havewa` der
 * Superuser. Wir nutzen deshalb `initdbUser` (Default = dbUser) als
 * Login-User für die CREATE ROLE / CREATE DATABASE.
 */
export async function ensureRole({
  paths, host, port, dbPassword,
  dbUser = "havewa",
  initdbUser,
  logger = EMPTY_LOGGER,
}) {
  if (!paths || !paths.psqlExe) throw new Error("paths.psqlExe fehlt");
  const superUser = initdbUser || dbUser;

  // Existenz prüfen (gegen System-Katalog).
  const sql = `SELECT 1 FROM pg_roles WHERE rolname = '${dbUser.replace(/'/g, "")}';`;
  const r = await psqlExec({
    paths, host, port,
    dbUser: superUser,
    dbPassword: dbPassword,
    db: "postgres",
    sql, logger,
  }).catch((e) => {
    logger.warn(`[pg-bootstrap] role-check via ${superUser} fehlgeschlagen: ${e?.message || e}`);
    return { stdout: "" };
  });

  if (r.stdout === "1") {
    logger.info(`[pg-bootstrap] Rolle '${dbUser}' existiert bereits.`);
    return { user: dbUser, created: false };
  }

  // Anlegen
  const createSql = `CREATE ROLE "${dbUser.replace(/"/g, "\"\"")}" LOGIN CREATEDB PASSWORD '${dbPassword.replace(/'/g, "''")}';`;
  await psqlExec({
    paths, host, port,
    dbUser: superUser,
    dbPassword,
    db: "postgres",
    sql: createSql,
    logger,
  });

  logger.info(`[pg-bootstrap] Rolle '${dbUser}' angelegt.`);
  return { user: dbUser, created: true };
}

/**
 * Stellt sicher, dass die Datenbank existiert. NICHT überschreiben.
 */
export async function ensureDatabase({
  paths, host, port, dbPassword, dbUser = "havewa", dbName = "havewa",
  initdbUser,
  logger = EMPTY_LOGGER,
}) {
  if (!paths || !paths.psqlExe) throw new Error("paths.psqlExe fehlt");
  const superUser = initdbUser || dbUser;

  const sql = `SELECT 1 FROM pg_database WHERE datname = '${dbName.replace(/'/g, "")}';`;
  const r = await psqlExec({
    paths, host, port,
    dbUser: superUser,
    dbPassword,
    db: "postgres",
    sql, logger,
  }).catch(() => ({ stdout: "" }));

  if (r.stdout === "1") {
    logger.info(`[pg-bootstrap] Datenbank '${dbName}' existiert bereits.`);
    return { dbName, created: false };
  }

  const owner = dbUser.replace(/"/g, "\"\"");
  const createSql = `CREATE DATABASE "${dbName.replace(/"/g, "\"\"")}" OWNER "${owner}";`;
  await psqlExec({
    paths, host, port,
    dbUser: superUser,
    dbPassword,
    db: "postgres",
    sql: createSql,
    logger,
  });

  logger.info(`[pg-bootstrap] Datenbank '${dbName}' angelegt.`);
  return { dbName, created: true };
}

/**
 * Vollständiger Bootstrap: Rolle + Datenbank. Idempotent.
 */
export async function bootstrapDatabase({
  paths, host, port, dbPassword,
  dbUser = "havewa", dbName = "havewa",
  initdbUser,
  logger = EMPTY_LOGGER,
}) {
  const role = await ensureRole({ paths, host, port, dbPassword, dbUser, initdbUser, logger });
  const db = await ensureDatabase({ paths, host, port, dbPassword, dbUser, dbName, initdbUser, logger });
  return {
    created: role.created || db.created,
    user: role.user,
    dbName: db.dbName,
  };
}

export const __EMPTY_LOGGER = EMPTY_LOGGER;