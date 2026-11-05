// G2-Hardening: vollstaendiger Live-Re-Proof des isolierten Stages.
// Reihenfolge laut Auftrag §10:
//   1 initdb, 2 pg_ctl start, 3 pg_isready, 4 migrate deploy = 55,
//   5 zweiter migrate = No pending, 6 Bootstrap = PASS,
//   7 Next standalone = PASS, 8 /api/ready = 200,
//   9 Root HTML enthaelt HaVeWa, 10 pg_ctl stop -m fast
//
// Isolierung: bereinigter PATH (nur Stage-Node), Stage-PG, Stage-Prisma,
// Stage-App. Kein System-Node, kein System-PG, kein 5432.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import http from "node:http";

const REPO = "C:\\Projekte\\PropertyAI\\foundation\\havewa";
const STAGE_NODE = path.join(REPO, "src-tauri", "resources", "runtime", "node", "node.exe");
const STAGE_PG_BIN = path.join(REPO, "src-tauri", "resources", "runtime", "postgres", "bin");
const STAGE_APP = path.join(REPO, "src-tauri", "resources", "runtime", "app");
const PG_PORT = 5439;
const WEB_PORT = 3020;

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`[prove] ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

function probePort(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(port, host);
  });
}
function httpGet(host, port, p, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    const req = http.request({ host, port, path: p, method: "GET", timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", (b) => body += b.toString());
      res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.once("error", (e) => resolve({ status: 0, body: "", headers: {}, error: e.message }));
    req.once("timeout", () => { req.destroy(); resolve({ status: 0, body: "", headers: {}, error: "timeout" }); });
    req.end();
  });
}
function run(exe, args, env) {
  return new Promise((resolve) => {
    const p = spawn(exe, args, { shell: false, env: { ...process.env, ...env } });
    let out = "", err = "";
    p.stdout?.on("data", b => out += b.toString());
    p.stderr?.on("data", b => err += b.toString());
    p.on("error", (e) => resolve({ code: -1, out, err: e.message }));
    p.on("exit", code => resolve({ code, out, err }));
  });
}

const CLEAN_ENV = {
  PATH: path.dirname(STAGE_NODE),
  HAVEWA_PRISMA_SKIP_GENERATE: "1",
  HAVEWA_DESKTOP_RUNTIME: "1",
  AUTH_TRUST_HOST: "true",
  AUTH_URL: `http://127.0.0.1:${WEB_PORT}`,
  AUTH_SECRET: "g2-hardening-live-proof-synthetic-not-production",
  NEXTAUTH_SECRET: "g2-hardening-live-proof-synthetic-not-production",
};

async function main() {
  console.log("[prove] Stage-Node:", STAGE_NODE);
  const nodeInfo = await run(STAGE_NODE,
    ["-p", "process.platform+' '+process.arch+' '+process.version+' '+process.execPath"], {});
  const info = (nodeInfo.out || "").trim();
  console.log("[prove] stage node:", info);
  check("10. Stage Node x64 laeuft",
    info.includes("win32 x64 v22.23.3")
    && info.includes(path.join("resources", "runtime", "node", "node.exe")),
    info);

  if (!(await probePort(PG_PORT))) {
    console.error(`[prove] Port ${PG_PORT} belegt`);
    process.exit(1);
  }

  const dataDir = mkdtempSync(path.join(os.tmpdir(), "g2-hardening-"));
  const pgdata = path.join(dataDir, "pgdata");
  const pwfile = path.join(dataDir, "pw.txt");
  writeFileSync(pwfile, "havewa_test\n");

  let r = await run(path.join(STAGE_PG_BIN, "initdb.exe"),
    ["--username=havewa", `--pwfile=${pwfile}`, "--auth=scram-sha-256",
     "--encoding=UTF-8", "-E", "UTF-8", "--locale=C", pgdata], CLEAN_ENV);
  check("1. Stage PG initdb", r.code === 0, `exit=${r.code}`);

  const conf = readFileSync(path.join(pgdata, "postgresql.conf"), "utf8");
  writeFileSync(path.join(pgdata, "postgresql.conf"),
    conf.replace(/^#?port = .*/m, `port = ${PG_PORT}`)
      .replace(/^#?listen_addresses = .*/m, "listen_addresses = '127.0.0.1'"));

  r = await run(path.join(STAGE_PG_BIN, "pg_ctl.exe"),
    ["-D", pgdata, "-l", path.join(dataDir, "log.txt"), "-w", "start"], CLEAN_ENV);
  check("2. Stage PG pg_ctl start", r.code === 0, `exit=${r.code}`);

  r = await run(path.join(STAGE_PG_BIN, "pg_isready.exe"),
    ["-h", "127.0.0.1", "-p", String(PG_PORT), "-U", "havewa"], CLEAN_ENV);
  check("3. Stage PG pg_isready", r.code === 0, (r.out || "").trim());

  r = await run(path.join(STAGE_PG_BIN, "createdb.exe"),
    ["-h", "127.0.0.1", "-p", String(PG_PORT), "-U", "havewa", "havewa"],
    { ...CLEAN_ENV, PGPASSWORD: "havewa_test" });
  check("4. Stage PG createdb", r.code === 0, `exit=${r.code}`);

  const dbUrl = `postgresql://havewa:havewa_test@127.0.0.1:${PG_PORT}/havewa?schema=public`;
  const migrateEnv = {
    ...CLEAN_ENV,
    DATABASE_URL: dbUrl,
    HAVEWA_RUNTIME_PRISMA_DIR: path.join(STAGE_APP, "scripts", ".runtime", "prisma-cli"),
  };

  r = await run(STAGE_NODE, [path.join(STAGE_APP, "scripts", "migrate-deploy.mjs")], migrateEnv);
  const m1 = r.out || "";
  check("5. migrate deploy (1. Lauf)", r.code === 0 && /55 migrations found/.test(m1), `exit=${r.code}`);
  check("6. KEIN runtime prisma generate", /prisma generate SKIPPED/.test(m1) && !/prisma generate \(lokal im Tree\)/.test(m1));
  check("7. Migration Count = 55", /55 migrations found/.test(m1));

  r = await run(path.join(STAGE_PG_BIN, "psql.exe"),
    ["-h", "127.0.0.1", "-p", String(PG_PORT), "-U", "havewa", "-d", "havewa", "-t", "-A",
     "-c", "SELECT COUNT(*) FROM _prisma_migrations;"],
    { ...CLEAN_ENV, PGPASSWORD: "havewa_test" });
  const applied = (r.out || "").trim();
  check("8. _prisma_migrations = 55", applied === "55", `count=${applied}`);

  r = await run(path.join(STAGE_PG_BIN, "psql.exe"),
    ["-h", "127.0.0.1", "-p", String(PG_PORT), "-U", "havewa", "-d", "havewa", "-t", "-A",
     "-c", "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename='User';"],
    { ...CLEAN_ENV, PGPASSWORD: "havewa_test" });
  check("9. User-Tabelle vorhanden", (r.out || "").trim() === "User", `table=${(r.out || "").trim()}`);

  r = await run(STAGE_NODE, [path.join(STAGE_APP, "scripts", "migrate-deploy.mjs")], migrateEnv);
  const m2 = r.out || "";
  check("10. zweiter migrate = No pending", r.code === 0 && /No pending migrations to apply/.test(m2), `exit=${r.code}`);

  r = await run(STAGE_NODE, [path.join(STAGE_APP, "scripts", "dist", "bootstrap.js")],
    { ...CLEAN_ENV, DATABASE_URL: dbUrl });
  const boot = (r.out || "") + (r.err || "");
  check("11. Bootstrap PASS", r.code === 0 && !/P2021/.test(boot) && !/npx|tsx/.test(boot)
    && !/MissingSecret|UntrustedHost/.test(boot), `exit=${r.code}`);

  // Next standalone: ueber start-runtime.mjs (ohne --require-Loader)
  const serverProc = spawn(STAGE_NODE, [path.join(STAGE_APP, "scripts", "start-runtime.mjs")], {
    shell: false,
    env: { ...process.env, ...CLEAN_ENV, DATABASE_URL: dbUrl, HAVEWA_DATA_DIR: dataDir, PORT: String(WEB_PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverOut = "";
  serverProc.stdout.on("data", b => serverOut += b.toString());
  serverProc.stderr.on("data", b => serverOut += b.toString());

  let ready = false;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const rr = await httpGet("127.0.0.1", WEB_PORT, "/api/ready", 5_000);
    if (rr.status === 200) { ready = true; break; }
    await new Promise(r2 => setTimeout(r2, 1000));
  }
  check("12. Next standalone /api/ready = 200", ready, serverOut.includes("READY") ? "READY gemeldet" : "");

  // Root-HTML mit Redirect-Kette
  let html = "";
  let loc = "/";
  for (let hop = 0; hop < 6; hop++) {
    const rr = await httpGet("127.0.0.1", WEB_PORT, loc, 30_000);
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
  check("13. Root HTML enthaelt HaVeWa", /HaVeWa/i.test(html), titleMatch ? titleMatch[0] : "");

  try { serverProc.kill("SIGTERM"); } catch { /* noop */ }
  await new Promise(r2 => { const t = setTimeout(() => r2(), 5000); serverProc.once("exit", () => { clearTimeout(t); r2(); }); });

  r = await run(path.join(STAGE_PG_BIN, "pg_ctl.exe"), ["-D", pgdata, "-m", "fast", "stop"], CLEAN_ENV);
  check("14. pg_ctl stop -m fast", r.code === 0, `exit=${r.code}`);

  console.log("\n[prove] ==== SUMMARY ====");
  const failed = results.filter(x => !x.ok);
  for (const x of results) console.log(`  ${x.ok ? "OK  " : "FAIL"} ${x.name}`);
  console.log(`[prove] ${results.length - failed.length}/${results.length} PASS`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("[prove] FATAL", e?.stack ?? e);
  process.exit(1);
});
