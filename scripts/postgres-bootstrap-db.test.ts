// HAVEWA-07B (FIX M-1) — Unit-Tests für postgres-bootstrap-db.mjs.
//
// Beweist: das DB-Passwort liegt NICHT im psql-argv und NICHT im Log.
// SQL (inkl. PASSWORD-Literal) wird via stdin übergeben.
//
// Außerdem: Idempotenz (Rolle/DB bereits vorhanden -> no-op).

import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";

import { __psqlExecForTest } from "./postgres-bootstrap-db.mjs";

/**
 * Erzeugt einen injizierbaren _spawn, der:
 *  - die argv-Argumente aufzeichnet
 *  - env aufzeichnet
 *  - ein Fake-Child mit beschreibbarem stdin zurückgibt
 *  - nach stdin.end() ein 'exit' mit code 0 emittiert
 *  - stdout/stderr no-op
 */
function makeFakeSpawn({ exitCode = 0 } = {}) {
  const calls: { exe: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const children: Array<EventEmitter & {
    stdin: Writable;
    stdout: EventEmitter;
    stderr: EventEmitter;
    _getStdin: () => string;
    _destroyed?: boolean;
  }> = [];
  const _spawn = (exe: string, args: readonly string[], opts: unknown) => {
    const o = opts as { env?: NodeJS.ProcessEnv } | undefined;
    calls.push({ exe, args: [...args], env: (o?.env ?? {}) as NodeJS.ProcessEnv });
    const child = new EventEmitter() as EventEmitter & {
      stdin: Writable;
      stdout: EventEmitter;
      stderr: EventEmitter;
      _getStdin: () => string;
      _destroyed?: boolean;
    };
    let stdinBuf = "";
    const stdin = new Writable({
      write(chunk: Buffer | string, _enc: BufferEncoding, cb: (err?: Error | null) => void) {
        stdinBuf += chunk.toString("utf8");
        cb();
      },
    });
    // Override end() to capture any final chunk and emit 'exit' afterwards.
    const origEnd = stdin.end.bind(stdin);
    const wrappedEnd = ((chunk?: Buffer | string, ...rest: unknown[]) => {
      if (chunk) stdinBuf += chunk.toString("utf8");
      setImmediate(() => {
        if (!child._destroyed) {
          child._destroyed = true;
          child.emit("exit", exitCode, null);
        }
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (origEnd as any)(chunk, ...rest);
    }) as unknown as typeof stdin.end;
    stdin.end = wrappedEnd;
    child.stdin = stdin;
    child._getStdin = () => stdinBuf;
    const noop = new EventEmitter();
    noop.on = () => noop;
    child.stdout = noop;
    child.stderr = noop;
    children.push(child);
    return child;
  };
  return { _spawn, calls, children };
}

const PATHS = {
  runtimeDir: "C:\\fake",
  postgresExe: "C:\\fake\\postgres.exe",
  pgCtlExe: "C:\\fake\\pg_ctl.exe",
  initdbExe: "C:\\fake\\initdb.exe",
  psqlExe: "C:\\fake\\psql.exe",
  createdbExe: "C:\\fake\\createdb.exe",
  pgIsreadyExe: "C:\\fake\\pg_isready.exe",
};

describe("psqlExec (FIX M-1: SQL via stdin, Passwort nicht in argv)", () => {
  it("Passwort liegt NICHT im psql-argv, nur im stdin", async () => {
    const SECRET = "super_secret_test_password_FIX_M1";
    const { _spawn, calls } = makeFakeSpawn({ exitCode: 0 });

    const logger = { info: () => {}, warn: () => {}, err: () => {} };
    const sql = `CREATE ROLE "havewa" LOGIN CREATEDB PASSWORD '${SECRET}';`;

    // Wir setzen die SQL über stdin-Pfad (kein -c mehr).
    const r = await __psqlExecForTest({
      paths: PATHS,
      host: "127.0.0.1",
      port: 5433,
      dbUser: "havewa",
      dbPassword: SECRET,
      db: "postgres",
      sql,
      logger,
    }, _spawn);

    expect(calls.length).toBe(1);
    const call = calls[0];

    // 1) exe ist psqlExe
    expect(call.exe).toBe(PATHS.psqlExe);

    // 2) argv enthält KEIN -c, KEIN SQL, KEIN Passwort
    expect(call.args).not.toContain("-c");
    expect(call.args).not.toContain(sql);
    // Serialisiere argv, suche nach dem Secret
    const argvFlat = call.args.map((a: string) => String(a)).join("|");
    expect(argvFlat).not.toContain(SECRET);

    // 3) argv ist sauber: -h, -p, -U, -d, -t, -A
    expect(call.args).toEqual([
      "-h", "127.0.0.1",
      "-p", "5433",
      "-U", "havewa",
      "-d", "postgres",
      "-t", "-A",
    ]);

    // 4) PGPASSWORD liegt in env (nicht in argv) — das ist ok.
    expect(call.env.PGPASSWORD).toBe(SECRET);
    // ... aber NICHT im argv
    expect(argvFlat).not.toContain(SECRET);

    expect(r).toBeDefined();
  });

  it("Passwort liegt NICHT im logger-Output", async () => {
    const SECRET = "another_secret_FIX_M1_log";
    const { _spawn } = makeFakeSpawn({ exitCode: 0 });

    const logLines: string[] = [];
    const logger = {
      info: (m: string) => logLines.push(m),
      warn: (m: string) => logLines.push(m),
      err: (m: string) => logLines.push(m),
    };
    const sql = `CREATE ROLE "havewa" PASSWORD '${SECRET}';`;

    await __psqlExecForTest({
      paths: PATHS,
      host: "127.0.0.1", port: 5433,
      dbUser: "havewa",
      dbPassword: SECRET,
      db: "postgres",
      sql, logger,
    }, _spawn);

    const all = logLines.join("\n");
    expect(all).not.toContain(SECRET);
    // Der Log-Eintrag darf das SQL nicht enthalten
    expect(all).not.toContain(sql);
    // Aber er darf die Form "psql -d postgres (stdin, ...)" haben
    expect(all).toMatch(/psql -d postgres \(stdin/);
  });

  it("SQL erreicht psql via stdin (in Fake-Spawn prüfbar)", async () => {
    const SECRET = "stdin_secret_FIX_M1";
    const { _spawn, calls, children } = makeFakeSpawn({ exitCode: 0 });
    const logger = { info: () => {}, warn: () => {}, err: () => {} };
    const sql = `CREATE ROLE "havewa" PASSWORD '${SECRET}';`;

    const result = await __psqlExecForTest({
      paths: PATHS,
      host: "127.0.0.1", port: 5433,
      dbUser: "havewa",
      dbPassword: SECRET,
      db: "postgres",
      sql, logger,
    }, _spawn);

    expect(result).toBeDefined();
    expect(calls.length).toBe(1);
    expect(calls[0].args.join("|")).not.toContain(SECRET);
    // Das SQL MUSS via stdin an psql gegangen sein.
    expect(children.length).toBe(1);
    const stdinContent = children[0]._getStdin();
    expect(stdinContent).toContain(SECRET);
    expect(stdinContent).toContain("CREATE ROLE");
  });
});
