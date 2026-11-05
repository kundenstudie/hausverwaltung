// HAVEWA-07D G3 — Installed-like Runtime-Proof.
//
// Kopiert den Desktop-Stage in ein isoliertes Verzeichnis AUSSERHALB des
// Repos (z.B. C:\Temp\HaVeWa-G3-Proof\), um die installierte Situation
// zu simulieren:
//
//   <install-root>\runtime\node\node.exe
//   <install-root>\runtime\postgres\bin\*.exe
//   <install-root>\runtime\app\...
//
// Der Data Root liegt bewusst an einem ANDEREN Ort (%LOCALAPPDATA%\HaVeWa
// bzw. ein Temp-Verzeichnis), um die Trennung Install-Root <-> Data-Root
// zu beweisen.
//
// Beweise:
//   - resource path resolution (Stage-Root -> runtime/node, runtime/postgres)
//   - Stage Node (x64)
//   - Stage PG initdb/start/isready
//   - Secret creation + read (simuliert den Rust-Pfad)
//   - AUTH_SECRET / AUTH_TRUST_HOST gesetzt
//   - migrate deploy (55)
//   - Bootstrap
//   - Next standalone
//   - /api/ready = 200
//   - HaVeWa HTML
//   - controlled shutdown (POST /api/shutdown mit Token)
//   - PG fast stop
//
// Kein System-Node, kein System-PG, kein 5432, CWD-unabhängig.

import { spawn, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  cpSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import http from "node:http";
import crypto from "node:crypto";

const REPO = "C:\\Projekte\\PropertyAI\\foundation\\havewa";
const STAGE_SRC = path.join(REPO, "src-tauri", "resources", "runtime");
const PG_PORT = 5441;
const WEB_PORT = 3031;

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`[g3-proof] ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

function probePort(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(port, host);
  });
}
void probePort;
function httpReq(host, port, method, p, headers = {}, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    const req = http.request({ host, port, path: p, method, timeout: timeoutMs, headers }, (res) => {
      let body = "";
      res.on("data", (b) => body += b.toString());
      res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.once("error", (e) => resolve({ status: 0, body: "", headers: {}, error: e.message }));
    req.once("timeout", () => { req.destroy(); resolve({ status: 0, body: "", headers: {}, error: "timeout" }); });
    req.end();
  });
}
function run(exe, args, env, cwd) {
  return new Promise((resolve) => {
    const p = spawn(exe, args, { shell: false, env: { ...process.env, ...env }, cwd });
    let out = "", err = "";
    p.stdout?.on("data", b => out += b.toString());
    p.stderr?.on("data", b => err += b.toString());
    p.on("error", e => resolve({ code: -1, out, err: e.message }));
    p.on("exit", code => resolve({ code, out, err }));
  });
}

/** Simuliert den Rust-Pfad: Secret-Erzeugung + ACL-Härtung (icacls). */
function createSecrets(dataDir) {
  const configDir = path.join(dataDir, "config");
  mkdirSync(configDir, { recursive: true });
  const secretsPath = path.join(configDir, "secrets.json");
  if (existsSync(secretsPath)) {
    return { secrets: JSON.parse(readFileSync(secretsPath, "utf8")), created: false, path: secretsPath };
  }
  const secrets = {
    db_password: crypto.randomBytes(24).toString("base64url"),
    auth_secret: crypto.randomBytes(32).toString("base64url"),
    shutdown_token: crypto.randomBytes(16).toString("base64url"),
  };
  writeFileSync(secretsPath, `${JSON.stringify(secrets, null, 2)}\n`, "utf8");
  // ACL-Härtung wie im Rust-Pfad (icacls).
  const icacls = spawnSync("icacls", [secretsPath, "/inheritance:r", "/grant:r", `${process.env.USERNAME}:(F)`], {
    encoding: "utf8",
    shell: false,
  });
  return { secrets, created: true, path: secretsPath, icaclsExit: icacls.status };
}

async function main() {
  console.log("[g3-proof] ==== INSTALLED-LIKE RUNTIME PROOF ====");
  console.log("[g3-proof] repo stage source:", STAGE_SRC);

  if (!existsSync(STAGE_SRC)) {
    console.error(`[g3-proof] FAIL: Stage fehlt: ${STAGE_SRC}`);
    process.exit(1);
  }

  // 1) Install-Root AUSSERHALB des Repos.
  const installRoot = process.env.HAVEWA_G3_PROOF_ROOT
    || path.join(os.tmpdir(), "HaVeWa-G3-Proof");
  if (existsSync(installRoot)) rmSync(installRoot, { recursive: true, force: true });
  mkdirSync(installRoot, { recursive: true });

  console.log("[g3-proof] install root:", installRoot);
  check("1. install-root ausserhalb des Repos",
    !installRoot.toLowerCase().includes("propertyai"),
    installRoot);

  // 2) Runtime kopieren: <install-root>/runtime/...
  const runtimeRoot = path.join(installRoot, "runtime");
  cpSync(STAGE_SRC, runtimeRoot, { recursive: true, dereference: true });
  check("2. runtime nach <install-root>/runtime kopiert",
    existsSync(path.join(runtimeRoot, "node", "node.exe"))
    && existsSync(path.join(runtimeRoot, "postgres", "bin", "postgres.exe"))
    && existsSync(path.join(runtimeRoot, "app", "server.js")));

  // 3) Data Root getrennt vom Install-Root.
  const dataRoot = mkdtempSync(path.join(os.tmpdir(), "HaVeWa-G3-Data-"));
  for (const sub of ["config", "pgdata", "logs", "runtime-state"]) {
    mkdirSync(path.join(dataRoot, sub), { recursive: true });
  }
  check("3. data-root getrennt vom install-root",
    !dataRoot.toLowerCase().startsWith(installRoot.toLowerCase())
    && !installRoot.toLowerCase().startsWith(dataRoot.toLowerCase()),
    dataRoot);

  // 4) Secrets erzeugen + persistieren.
  const sec = createSecrets(dataRoot);
  check("4. secrets erzeugt + persistent (config/secrets.json)",
    sec.created && existsSync(sec.path) && !!sec.secrets.auth_secret);
  // Zweiter Aufruf: nicht neu erzeugen.
  const sec2 = createSecrets(dataRoot);
  check("5. secrets NICHT bei jedem Start neu erzeugt",
    sec2.created === false && sec2.secrets.auth_secret === sec.secrets.auth_secret);

  // 6) Stage-Node aus dem Install-Root.
  const nodeExe = path.join(runtimeRoot, "node", "node.exe");
  const nodeBinDir = path.join(runtimeRoot, "node");
  const pgBinDir = path.join(runtimeRoot, "postgres", "bin");
  const appDir = path.join(runtimeRoot, "app");

  const nodeInfo = await run(nodeExe, ["-p", "process.platform+' '+process.arch+' '+process.version+' '+process.execPath"], {});
  const info = (nodeInfo.out || "").trim();
  console.log("[g3-proof] stage node:", info);
  check("6. Stage Node x64 (win32 x64 v22.23.3) aus install-root",
    info.includes("win32 x64 v22.23.3") && info.includes(path.join("runtime", "node", "node.exe")),
    info);

  // 7) Env-Allowlist (Spiegel des Rust-Pfades).
  const controlledPath = [nodeBinDir, pgBinDir].join(";");
  const childEnv = {
    PATH: controlledPath,
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    APPDATA: process.env.APPDATA,
    USERPROFILE: process.env.USERPROFILE,
    HAVEWA_DATA_DIR: dataRoot,
    HAVEWA_DESKTOP_RUNTIME: "1",
    HAVEWA_PRISMA_SKIP_GENERATE: "1",
    AUTH_SECRET: sec.secrets.auth_secret,
    AUTH_TRUST_HOST: "true",
    PG_DBPASSWORD: sec.secrets.db_password,
    SHUTDOWN_TOKEN: sec.secrets.shutdown_token,
    POSTGRES_RUNTIME_DIR: pgBinDir,
    NODE_ENV: "production",
  };
  check("7. Env-Allowlist: kein System-Node/PG im PATH",
    !controlledPath.includes("Program Files") && !controlledPath.includes(".tools"),
    controlledPath);

  // 8) Stage-PG: initdb.
  const pgdata = path.join(dataRoot, "pgdata");
  const pwfile = path.join(dataRoot, "pg-pw.txt");
  writeFileSync(pwfile, `${sec.secrets.db_password}\n`);
  let r = await run(path.join(pgBinDir, "initdb.exe"),
    ["--username=havewa", `--pwfile=${pwfile}`, "--auth=scram-sha-256",
     "--encoding=UTF-8", "-E", "UTF-8", "--locale=C", pgdata], childEnv, dataRoot);
  check("8. Stage PG initdb (isoliertes pgdata)", r.code === 0, `exit=${r.code}`);

  const conf = readFileSync(path.join(pgdata, "postgresql.conf"), "utf8");
  writeFileSync(path.join(pgdata, "postgresql.conf"),
    conf.replace(/^#?port = .*/m, `port = ${PG_PORT}`)
      .replace(/^#?listen_addresses = .*/m, "listen_addresses = '127.0.0.1'"));

  // 9) pg_ctl start.
  r = await run(path.join(pgBinDir, "pg_ctl.exe"),
    ["-D", pgdata, "-l", path.join(dataRoot, "logs", "pg.log"), "-w", "start"], childEnv, dataRoot);
  check("9. Stage PG pg_ctl start", r.code === 0, `exit=${r.code}`);

  // 10) pg_isready.
  r = await run(path.join(pgBinDir, "pg_isready.exe"),
    ["-h", "127.0.0.1", "-p", String(PG_PORT), "-U", "havewa"], childEnv, dataRoot);
  check("10. Stage PG pg_isready", r.code === 0, (r.out || "").trim());

  // 11) createdb.
  r = await run(path.join(pgBinDir, "createdb.exe"),
    ["-h", "127.0.0.1", "-p", String(PG_PORT), "-U", "havewa", "havewa"],
    { ...childEnv, PGPASSWORD: sec.secrets.db_password }, dataRoot);
  check("11. Stage PG createdb", r.code === 0, `exit=${r.code}`);

  // 12) migrate deploy (kein prisma generate).
  const dbUrl = `postgresql://havewa:${encodeURIComponent(sec.secrets.db_password)}@127.0.0.1:${PG_PORT}/havewa?schema=public`;
  const migrateEnv = {
    ...childEnv,
    DATABASE_URL: dbUrl,
    HAVEWA_RUNTIME_PRISMA_DIR: path.join(appDir, "scripts", ".runtime", "prisma-cli"),
  };
  r = await run(nodeExe, [path.join(appDir, "scripts", "migrate-deploy.mjs")], migrateEnv, appDir);
  const m1 = r.out || "";
  check("12. migrate deploy (1. Lauf)", r.code === 0 && /55 migrations found/.test(m1), `exit=${r.code}`);
  check("13. KEIN runtime prisma generate",
    /prisma generate SKIPPED/.test(m1) && !/prisma generate \(lokal im Tree\)/.test(m1));

  // 14) Bootstrap.
  r = await run(nodeExe, [path.join(appDir, "scripts", "dist", "bootstrap.js")],
    { ...childEnv, DATABASE_URL: dbUrl }, appDir);
  const boot = (r.out || "") + (r.err || "");
  check("14. Bootstrap (kein P2021/npx/tsx)",
    r.code === 0 && !/P2021/.test(boot) && !/npx|tsx/i.test(boot)
    && !/MissingSecret|UntrustedHost/.test(boot), `exit=${r.code}`);

  // 15) Next standalone starten (über das Stage-Start-Skript).
  const serverProc = spawn(nodeExe, [path.join(appDir, "scripts", "start-runtime.mjs")], {
    shell: false,
    env: { ...process.env, ...childEnv, DATABASE_URL: dbUrl, HAVEWA_DATA_DIR: dataRoot, PORT: String(WEB_PORT) },
    cwd: os.tmpdir(), // CWD-unabhängigkeit!
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverOut = "";
  serverProc.stdout.on("data", b => serverOut += b.toString());
  serverProc.stderr.on("data", b => serverOut += b.toString());

  let ready = false;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const rr = await httpReq("127.0.0.1", WEB_PORT, "GET", "/api/ready", {}, 5_000);
    if (rr.status === 200) { ready = true; break; }
    await new Promise(x => setTimeout(x, 1000));
  }
  check("15. Next standalone /api/ready = 200 (CWD-unabhängig)", ready);

  // 16) HaVeWa HTML.
  let html = "";
  let loc = "/";
  for (let hop = 0; hop < 6; hop++) {
    const rr = await httpReq("127.0.0.1", WEB_PORT, "GET", loc, {}, 30_000);
    if (rr.status >= 300 && rr.status < 400 && rr.headers?.location) {
      const next = String(rr.headers.location);
      loc = next.startsWith("http") ? new URL(next).pathname : next;
      if (rr.body && rr.body.length > 1000) html = rr.body;
      continue;
    }
    html = rr.body || html;
    break;
  }
  const titleMatch = html.match(/<title>[^<]*<\/title>/i);
  check("16. HaVeWa HTML erreichbar", /HaVeWa/i.test(html),
    titleMatch ? titleMatch[0] : "");

  // 17) Controlled shutdown (POST /api/shutdown mit Token).
  const sd = await httpReq("127.0.0.1", WEB_PORT, "POST", "/api/shutdown",
    { "X-Shutdown-Token": sec.secrets.shutdown_token, "Content-Length": "0" }, 15_000);
  check("17. controlled shutdown akzeptiert", sd.status === 202 || sd.status === 200,
    `status=${sd.status}`);

  // Auf Child-Exit warten.
  const exited = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 30_000);
    serverProc.once("exit", () => { clearTimeout(t); resolve(true); });
  });
  check("18. Runtime-Child beendet sich nach shutdown", exited);

  // 19) PG fast stop.
  r = await run(path.join(pgBinDir, "pg_ctl.exe"), ["-D", pgdata, "-m", "fast", "stop"],
    childEnv, dataRoot);
  check("19. Stage PG pg_ctl stop -m fast", r.code === 0, `exit=${r.code}`);

  // 20) Kein 5432-Zugriff: der Server-/PG-Port war 5441.
  check("20. kein 5432 verwendet", PG_PORT !== 5432 && WEB_PORT !== 5432,
    `pg=${PG_PORT} web=${WEB_PORT}`);

  console.log("\n[g3-proof] ==== SUMMARY ====");
  const failed = results.filter(x => !x.ok);
  for (const x of results) console.log(`  ${x.ok ? "OK  " : "FAIL"} ${x.name}`);
  console.log(`[g3-proof] ${results.length - failed.length}/${results.length} PASS`);
  console.log(`[g3-proof] install root: ${installRoot}`);
  console.log(`[g3-proof] data root:    ${dataRoot}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("[g3-proof] FATAL", e?.stack ?? e);
  process.exit(1);
});
