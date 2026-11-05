// HAVEWA-07D G7-FIX — Kurzer installierter Smoke-Test.
//
// Ablauf (NUR Smoke, kein kompletter G4-/G5-Upgrade-Test):
//   1. NSIS-Installer real ausfuehren (silent, currentUser)
//   2. /api/ready = 200
//   3. UI erreichbar
//   4. Migration no-op (kein pending)
//   5. Bootstrap PASS (kein P2021/MissingSecret/UntrustedHost)
//   6. KEIN System-Node / System-PostgreSQL im Prozessbaum
//   7. Port 5432 unangetastet (System-DB)
//   8. Normaler Shutdown (Fenster-Close)
//   9. G7: installierter Payload enthaelt KEINE non-windows-x64 Prisma-Engine
//
// KEIN Signing, kein Tag, kein Push.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";

import {
  scanPrismaEngines,
  formatEngineInventory,
} from "./prisma-engine-scan.mjs";

const LOCALAPPDATA = process.env.LOCALAPPDATA;
const INSTALL_ROOT = path.join(LOCALAPPDATA, "HaVeWa Desktop");

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`[g7-smoke] ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  return ok;
}
function info(msg) { console.log(`[g7-smoke] … ${msg}`); }
function fail(msg, code = 1) {
  console.error(`[g7-smoke] FAIL: ${msg}`);
  process.exit(code);
}

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

function listProcs(filterFn) {
  const r = spawnSync("powershell", ["-NoProfile", "-Command",
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress"],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0 || !r.stdout) return [];
  let data;
  try { data = JSON.parse(r.stdout); } catch { return []; }
  if (!Array.isArray(data)) data = [data];
  return data.filter((p) => p && filterFn(p));
}

function productProcs() {
  const root = INSTALL_ROOT.toLowerCase();
  const all = listProcs((p) => {
    const ep = (p.ExecutablePath || "").toLowerCase();
    if (!ep.startsWith(root + "\\")) return false;
    if ((p.Name || "").toLowerCase() === "msedgewebview2.exe") return false;
    return true;
  });
  return all.filter((p) => {
    const name = (p.Name || "").toLowerCase();
    if (name !== "postgres.exe") return true;
    const parentIsPg = all.some(
      (q) => q.ProcessId === p.ParentProcessId && (q.Name || "").toLowerCase() === "postgres.exe",
    );
    return !parentIsPg;
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function closeAppWindows(exePath) {
  const escaped = exePath.replace(/'/g, "''");
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$sig = @'
using System;
using System.Runtime.InteropServices;
public class WinClose {
  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
}
'@
Add-Type -TypeDefinition $sig
$targets = @(Get-CimInstance Win32_Process -Filter "Name='havewa-desktop.exe'" | Where-Object { $_.ExecutablePath -eq '${escaped}' } | Select-Object -ExpandProperty ProcessId)
if ($targets.Count -eq 0) { Write-Output 'NO_PROCESS'; exit 0 }
$script:found = 0
$cb = [WinClose+EnumWindowsProc]{
  param($hWnd, $lParam)
  $wpid = 0
  [WinClose]::GetWindowThreadProcessId($hWnd, [ref]$wpid) | Out-Null
  if ($targets -contains $wpid -and [WinClose]::IsWindowVisible($hWnd)) {
    [WinClose]::PostMessage($hWnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
    $script:found = $script:found + 1
  }
  return $true
}
[WinClose]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
Write-Output "CLOSED_WINDOWS=$script:found INSTANCES=$($targets.Count)"
`;
  return spawnSync("powershell", ["-NoProfile", "-Command", ps], {
    encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
  });
}

async function waitForReady(ports = [3000, 3001, 3002, 3003, 3004, 3005], timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const port of ports) {
      const r = await httpReq("127.0.0.1", port, "GET", "/api/ready", {}, 2_000);
      if (r.status === 200) return port;
    }
    await sleep(1_000);
  }
  return 0;
}

async function main() {
  const installer = process.env.G4_INSTALLER;
  if (!installer || !existsSync(installer)) {
    fail(`Installer nicht gefunden: ${installer ?? "(G4_INSTALLER nicht gesetzt)"}`);
  }

  console.log("[g7-smoke] ==== G7 INSTALLIERTER SMOKE ====");
  info(`installer: ${installer}`);
  info(`install root: ${INSTALL_ROOT}`);

  // Vorbedingung: kein System-Node/PG im Prozessbaum UNTER dem Install Root.
  // Fremde Prozesse (z.B. die lokale PostgreSQL-16-Installation) sind
  // fremd und werden NICHT angefasst.

  // --- 0) Verwaiste Produktprozesse bereinigen -----------------------
  const orphans = productProcs();
  if (orphans.length > 0) {
    info(`verwaiste Produktprozesse: ${orphans.map((p) => `${p.Name}(${p.ProcessId})`).join(", ")}`);
    for (const p of orphans) {
      spawnSync("powershell", ["-NoProfile", "-Command",
        `Stop-Process -Id ${p.ProcessId} -Force -ErrorAction SilentlyContinue`], { encoding: "utf8" });
    }
    await sleep(3_000);
  }

  // --- 1) Installation -------------------------------------------------
  info("Installer laeuft (silent) …");
  const r = spawnSync(installer, ["/S"], {
    shell: false, encoding: "utf8", timeout: 1_800_000,
  });
  if (r.error) fail(`Installer-Fehler: ${r.error.message}`);
  if (r.status !== 0) fail(`Installer exit=${r.status}`);
  await sleep(6_000);

  const exeCandidates = readdirSync(INSTALL_ROOT, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".exe")
      && !e.name.toLowerCase().startsWith("uninstall"))
    .map((e) => path.join(INSTALL_ROOT, e.name));
  const exePath = exeCandidates[0] || path.join(INSTALL_ROOT, "HaVeWa Desktop.exe");
  check("1. Install Root: EXE + Runtime vorhanden",
    existsSync(exePath)
    && existsSync(path.join(INSTALL_ROOT, "runtime", "node", "node.exe"))
    && existsSync(path.join(INSTALL_ROOT, "runtime", "postgres", "bin", "postgres.exe")),
    exePath);

  // --- 2) G7: Prisma-Engine-Inventar im INSTALLIERTEN Payload --------
  console.log("\n[g7-smoke] ==== PRISMA NATIVE ENGINE INVENTAR (installierter Payload) ====");
  const installedApp = path.join(INSTALL_ROOT, "runtime", "app");
  const { engines, violations } = await scanPrismaEngines(installedApp);
  const linux = engines.filter((e) => e.target.os === "linux").length;
  const arm64 = engines.filter((e) => e.target.arch === "arm64" || e.target.arch === "aarch64").length;
  const nonWin = engines.filter((e) => e.target.os !== "windows" || e.target.arch !== "x64").length;
  console.log(`[g7-smoke] native Prisma engines gesamt: ${engines.length}`);
  console.log(`[g7-smoke] linux: ${linux} | arm64/aarch64: ${arm64} | non-windows-x64: ${nonWin}`);
  console.log(formatEngineInventory(engines));
  check("2. installierter Payload: keine non-windows-x64 Prisma-Engine",
    violations.length === 0,
    violations.length === 0 ? "alle Engines sind windows-x64"
      : violations.map((v) => `${v.target.family}:${v.name}`).join(", "));
  check("3. installierter Payload: Linux-Prisma-Engines = 0", linux === 0, `linux=${linux}`);
  check("4. installierter Payload: ARM64-Prisma-Engines = 0", arm64 === 0, `arm64=${arm64}`);
  check("5. installierter Payload: kein schema-engine-linux-arm64",
    !engines.some((e) => e.name === "schema-engine-linux-arm64-openssl-3.0.x"), "");

  // --- 3) First Start ---------------------------------------------------
  info("First Start der installierten EXE …");
  const child = spawn(exePath, [], {
    shell: false, cwd: os.tmpdir(), env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout?.on("data", (b) => out += b.toString());
  child.stderr?.on("data", (b) => out += b.toString());

  const readyPort = await waitForReady();
  check("6. /api/ready = 200", readyPort > 0,
    readyPort ? `port ${readyPort}` : out.slice(-1500));

  // Log abwarten (Migration/Bootstrap-Marker).
  for (let i = 0; i < 40; i++) {
    out = out;
    if (/migrations found|No pending|bootstrap/i.test(out)) break;
    await sleep(1_000);
  }

  // --- 4) UI -----------------------------------------------------------
  let html = "";
  let loc = "/";
  const chain = [];
  for (let hop = 0; hop < 6; hop++) {
    const rr = await httpReq("127.0.0.1", readyPort, "GET", loc, {}, 30_000);
    if (rr.status >= 300 && rr.status < 400 && rr.headers?.location) {
      const next = String(rr.headers.location);
      loc = next.startsWith("http") ? new URL(next).pathname : next;
      chain.push(`${rr.status}->${loc}`);
      if (rr.body && rr.body.length > 1000) html = rr.body;
      continue;
    }
    chain.push(`${rr.status}${loc}`);
    html = rr.body || html;
    break;
  }
  check("7. UI erreichbar", /HaVeWa/i.test(html),
    `kette=${chain.join(" ")} len=${html.length}`);

  // --- 5) Migration / Bootstrap ---------------------------------------
  check("8. Migration angewandt / no-op", /migrations found|No pending migrations/i.test(out),
    (out.match(/migrations found|No pending migrations[^\r\n]*/i) || [""])[0]);
  check("9. Bootstrap PASS (kein P2021/MissingSecret/UntrustedHost)",
    !/P2021/.test(out) && !/MissingSecret/.test(out) && !/UntrustedHost/.test(out), "");

  // --- 6) Kein System-Node / System-PG --------------------------------
  const procs = productProcs();
  const nodeProc = procs.find((p) => (p.ExecutablePath || "").toLowerCase()
    === path.join(INSTALL_ROOT, "runtime", "node", "node.exe").toLowerCase());
  const pgProc = procs.find((p) => (p.ExecutablePath || "").toLowerCase()
    === path.join(INSTALL_ROOT, "runtime", "postgres", "bin", "postgres.exe").toLowerCase());
  check("10. Produkt-Node aus dem Install Root", !!nodeProc,
    nodeProc ? `pid ${nodeProc.ProcessId}` : "nicht gefunden");
  check("11. Produkt-PostgreSQL aus dem Install Root", !!pgProc,
    pgProc ? `pid ${pgProc.ProcessId}` : "nicht gefunden");
  check("12. KEIN System-PostgreSQL im Prozessbaum",
    !procs.some((p) => /Program Files\\PostgreSQL/i.test(p.ExecutablePath || "")), "");
  check("13. KEIN System-Node im Produktprozessbaum",
    !procs.some((p) => (p.Name || "").toLowerCase() === "node.exe"
      && !/HaVeWa Desktop/i.test(p.ExecutablePath || "")), "");

  // --- 7) Port 5432 unangetastet ---------------------------------------
  const netstat = spawnSync("netstat", ["-an"], { encoding: "utf8" });
  const prodPgPort = procs.find((p) => (p.Name || "").toLowerCase() === "postgres.exe");
  const netstatText = netstat.stdout || "";
  check("14. 5432 unangetastet (System-DB bleibt erreichbar)",
    netstatText.includes(":5432"), "");
  if (prodPgPort) {
    const pgCmd = prodPgPort.CommandLine || "";
    info(`Produkt-PG-Commandline: ${pgCmd.slice(0, 200)}`);
  }

  // --- 8) Normaler Shutdown (Fenster-Close) ----------------------------
  info("Controlled Shutdown (Fenster-Close) …");

  // WICHTIG: Der Exit-Listener muss VOR dem Fenster-Close registriert
  // werden. Andernfalls kann die EXE zwischen "Next-Server beendet"
  // und dem Registrieren bereits ausgelaufen sein — der Shutdown waere
  // dann korrekt, der Check aber trotzdem rot.
  let exitSeen = false;
  child.once("exit", () => { exitSeen = true; });

  const closeRes = closeAppWindows(exePath);
  const closeOut = (closeRes.stdout || "").trim();
  info(`closeAppWindows: ${closeOut}`);

  let shutDown = false;
  const sdDeadline = Date.now() + 90_000;
  while (Date.now() < sdDeadline) {
    const rr = await httpReq("127.0.0.1", readyPort, "GET", "/api/ready", {}, 2_000);
    if (rr.status !== 200) { shutDown = true; break; }
    await sleep(1_000);
  }
  check("15. Shutdown: Next-Server beendet", shutDown, `close=${closeOut}`);

  // Auf das Prozess-Ende warten. Primaer wird der Exit-Event benutzt;
  // falls der Event nicht ankommt (die App ist eine GUI-Subsystem-
  // Anwendung), wird ueber den Prozessbaum verifiziert, dass die EXE
  // wirklich beendet ist.
  const exitDeadline = Date.now() + 120_000;
  while (Date.now() < exitDeadline && !exitSeen) {
    await sleep(1_000);
  }
  const exeStillRunning = productProcs().some(
    (p) => (p.ExecutablePath || "").toLowerCase() === exePath.toLowerCase(),
  );
  check("16. Shutdown: Tauri-EXE beendet", exitSeen || !exeStillRunning,
    `exitEvent=${exitSeen} stillRunning=${exeStillRunning} close=${closeOut}`);

  await sleep(4_000);
  const after = productProcs();
  check("17. Shutdown: keine Produktprozesse uebrig",
    after.length === 0,
    after.map((p) => `${p.Name}(${p.ProcessId})`).join(", ") || "keine");

  console.log("\n[g7-smoke] ==== SUMMARY ====");
  const failed = results.filter((x) => !x.ok);
  for (const x of results) console.log(`  ${x.ok ? "OK  " : "FAIL"} ${x.name}`);
  console.log(`[g7-smoke] ${results.length - failed.length}/${results.length} PASS`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("[g7-smoke] FATAL", e?.stack ?? e);
  process.exit(1);
});
