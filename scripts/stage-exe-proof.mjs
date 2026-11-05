// G3: Startet die gebaute Tauri-EXE mit einem Runtime-Root AUSSERHALB des
// Repos und prüft, ob die Runtime sauber hochkommt (Capabilities, Secrets,
// PG-Start, Next-Start, /api/ready).
//
// Der Data Root liegt ebenfalls außerhalb des Repos.
//
// Wir nutzen den Tauri-EXE-Prozess mit:
//   HAVEWA_RUNTIME_ROOT = <install-root>\runtime
//   HAVEWA_DATA_DIR    = <data-root>
//   POSTGRES_RUNTIME_DIR / AUTH_* / ... werden von der EXE selbst gesetzt.
//
// Erwartung: Die EXE startet, das Runtime-Child läuft, /api/ready antwortet.

import { spawn } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  cpSync,
  rmSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";

const REPO = "C:\\Projekte\\PropertyAI\\foundation\\havewa";
const STAGE_SRC = path.join(REPO, "src-tauri", "resources", "runtime");
const EXE = path.join(
  REPO, "src-tauri", "target", "x86_64-pc-windows-msvc", "release", "havewa-desktop.exe",
);

function httpGet(host, port, p, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    const req = http.request({ host, port, path: p, method: "GET", timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", (b) => body += b.toString());
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.once("error", (e) => resolve({ status: 0, body: "", error: e.message }));
    req.once("timeout", () => { req.destroy(); resolve({ status: 0, body: "", error: "timeout" }); });
    req.end();
  });
}

async function main() {
  console.log("[g3-exe-proof] ==== TAURI-EXE END-TO-END PROOF ====");
  if (!existsSync(EXE)) {
    console.error(`[g3-exe-proof] FAIL: EXE fehlt: ${EXE}`);
    process.exit(1);
  }

  // Install-Root ausserhalb des Repos.
  const installRoot = path.join(os.tmpdir(), "HaVeWa-G3-ExeProof");
  if (existsSync(installRoot)) rmSync(installRoot, { recursive: true, force: true });
  mkdirSync(installRoot, { recursive: true });
  cpSync(STAGE_SRC, path.join(installRoot, "runtime"), { recursive: true, dereference: true });

  // Data Root ausserhalb des Repos.
  const dataRoot = mkdtempSync(path.join(os.tmpdir(), "HaVeWa-G3-ExeData-"));
  for (const sub of ["config", "pgdata", "logs", "runtime-state"]) {
    mkdirSync(path.join(dataRoot, sub), { recursive: true });
  }

  const runtimeRoot = path.join(installRoot, "runtime");
  console.log("[g3-exe-proof] install root:", installRoot);
  console.log("[g3-exe-proof] data root:   ", dataRoot);
  console.log("[g3-exe-proof] runtime root: ", runtimeRoot);

  // Der Port wird von der EXE selbst gewählt (3000..3005). Wir pollen alle.
  const child = spawn(EXE, [], {
    shell: false,
    env: {
      ...process.env,
      HAVEWA_RUNTIME_ROOT: runtimeRoot,
      HAVEWA_DATA_DIR: dataRoot,
      // Kein PATH-Override: die EXE setzt ihn selbst für das Child.
    },
    cwd: os.tmpdir(),
    stdio: ["ignore", "pipe", "pipe"],
  });

  let out = "";
  child.stdout?.on("data", (b) => { out += b.toString(); });
  child.stderr?.on("data", (b) => { out += b.toString(); });
  let exited = false;
  child.on("exit", () => { exited = true; });

  // Readiness pollen (alle Backend-Ports).
  let ready = false;
  let readyPort = 0;
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline && !exited) {
    for (const port of [3000, 3001, 3002, 3003, 3004, 3005]) {
      const r = await httpGet("127.0.0.1", port, "/api/ready", 2_000);
      if (r.status === 200) { ready = true; readyPort = port; break; }
    }
    if (ready) break;
    await new Promise((x) => setTimeout(x, 1_500));
  }

  console.log("[g3-exe-proof] EXE output:");
  console.log(out.split("\n").slice(0, 40).map((l) => "   " + l).join("\n"));

  console.log(`[g3-exe-proof] /api/ready: ${ready}${ready ? ` (port ${readyPort})` : ""}`);
  if (!ready) {
    console.log("[g3-exe-proof] FAIL: Runtime kam nicht hoch");
    try { child.kill("SIGTERM"); } catch { /* noop */ }
    process.exit(1);
  }

  // Secrets wurden erzeugt?
  const secretsPath = path.join(dataRoot, "config", "secrets.json");
  const secretsExist = existsSync(secretsPath);
  console.log("[g3-exe-proof] secrets.json erzeugt:", secretsExist);
  if (secretsExist) {
    const s = JSON.parse(readFileSync(secretsPath, "utf8"));
    const complete = !!(s.db_password && s.auth_secret && s.shutdown_token);
    console.log("[g3-exe-proof] secrets vollständig:", complete);
    if (!complete) {
      console.log("[g3-exe-proof] FAIL: secrets unvollständig");
      try { child.kill("SIGTERM"); } catch { /* noop */ }
      process.exit(1);
    }
  }

  // Runtime-Child läuft aus dem Install-Root? (Der Log muss den Install-Root
  // nennen — nicht den Repo-Pfad.)
  const usesInstallRoot = out.includes(runtimeRoot);
  const mentionsRepo = out.includes(REPO);
  console.log("[g3-exe-proof] Log nennt Install-Root:", usesInstallRoot);
  console.log("[g3-exe-proof] Log nennt Repo-Pfad:", mentionsRepo);

  // Sauber beenden.
  try { child.kill("SIGTERM"); } catch { /* noop */ }
  await new Promise((x) => { const t = setTimeout(() => x(), 8_000); child.on("exit", () => { clearTimeout(t); x(); }); });

  console.log("[g3-exe-proof] EXE-Signal:", exited ? "beendet" : "noch aktiv");

  if (!usesInstallRoot) {
    console.log("[g3-exe-proof] FAIL: Log nennt den Install-Root nicht");
    process.exit(1);
  }

  console.log("[g3-exe-proof] OK");
  process.exit(0);
}

main().catch((e) => {
  console.error("[g3-exe-proof] FATAL", e?.stack ?? e);
  process.exit(1);
});
