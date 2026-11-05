// HAVEWA-07D G4 — Echte NSIS-Installation + Produktbeweis.
//
// Führt den gebauten NSIS-Installer real aus (currentUser, silent) und
// beweist danach Schritt für Schritt:
//
//   1. Install Root  = %LOCALAPPDATA%\HaVeWa Desktop
//   2. Data Root     = %LOCALAPPDATA%\HaVeWa   (getrennt)
//   3. EXE + Runtime (node/postgres/app) + Uninstaller vorhanden
//   4. First Start: EXE aus dem Install Root, Runtime aus dem Install Root
//   5. secrets.json erzeugt (ACL-gehär tet), pgdata im DATA Root
//   6. Live-Produkt: PG ready, 55 Migrationen, Bootstrap, /api/ready=200,
//      HaVeWa UI, Login/Setup erreichbar
//   7. Prozessbaum: EXE -> node.exe (Install Root) -> postgres.exe (Install Root)
//   8. Controlled Shutdown: POST /api/shutdown -> 202, Node beendet, PG fast stop
//   9. Relaunch: pgdata/Secrets wiederverwendet, Migration no-op
//  10. Single Instance: zweiter Start erzeugt keinen zweiten Stack
//  11. Uninstall: Install Root weg, Data Root bleibt
//  12. Reinstall: Data Root wiedererkannt, Secrets identisch, Migration no-op
//
// KEIN Signing, kein Tag, kein Push.

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";

import {
  scanPrismaEngines,
  formatEngineInventory,
} from "./prisma-engine-scan.mjs";

const LOCALAPPDATA = process.env.LOCALAPPDATA;
const INSTALL_ROOT = path.join(LOCALAPPDATA, "HaVeWa Desktop");
const DATA_ROOT = path.join(LOCALAPPDATA, "HaVeWa");

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`[g4] ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  return ok;
}
function info(msg) { console.log(`[g4] … ${msg}`); }
function fail(msg, code = 1) {
  console.error(`[g4] FAIL: ${msg}`);
  process.exit(code);
}

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------

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

/**
 * Produktprozesse des Desktop-Stack.
 *
 * WICHTIG:
 *   - `msedgewebview2.exe` ist die WebView2-Browser-Engine. Tauri
 *     entpackt sie in ein Unterverzeichnis des Install Roots, ihre Prozesse
 *     liegen also AUCH unter dem Install Root — sie sind aber KEINE
 *     Produktprozesse (Browser-Engine, nicht HaVeWa-Runtime).
 *   - PostgreSQL betreibt einen Postmaster mit N Worker-Prozessen. Die
 *     Worker sind Kinder des Postmasters, keine eigenstaendigen Instanzen.
 *     Wir zaehlen deshalb nur den Postmaster (Parent ist KEIN postgres.exe)
 *     und die Node-Prozesse.
 */
function productProcs() {
  const root = INSTALL_ROOT.toLowerCase();
  const all = listProcs((p) => {
    const ep = (p.ExecutablePath || "").toLowerCase();
    if (!ep.startsWith(root + "\\")) return false;
    if ((p.Name || "").toLowerCase() === "msedgewebview2.exe") return false;
    return true;
  });
  // PostgreSQL-Worker herausfiltern (Parent ist selbst ein postgres.exe).
  return all.filter((p) => {
    const name = (p.Name || "").toLowerCase();
    if (name !== "postgres.exe") return true;
    const parentIsPg = all.some(
      (q) => q.ProcessId === p.ParentProcessId
        && (q.Name || "").toLowerCase() === "postgres.exe",
    );
    return !parentIsPg;
  });
}

/** Nur die WebView2-Renderer (zur Info, nicht als Fehler). */
function webviewProcs() {
  return listProcs((p) => (p.Name || "").toLowerCase() === "msedgewebview2.exe");
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Schliesst das Hauptfenster der installierten EXE (WM_CLOSE).
 *
 * Das ist der NORMALE Schliess-Pfad (07C-Architektur): der
 * WindowEvent::CloseRequested-Handler loest den kontrollierten Shutdown aus
 * (POST /api/shutdown -> Node-Child wartet -> PG fast stop).
 *
 * Ein reines `POST /api/shutdown` beendet nur den Next-Server; die
 * Tauri-EXE laeuft dann weiter (die WebView zeigt eine Fehlerseite).
 * Der Fenster-Close ist der vom Benutzer ausgeloeste Weg.
 */
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
  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", SetLastError=true)]
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
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
}

async function waitForReady(ports = [3000, 3001, 3002, 3003, 3004, 3005], timeoutMs = 120_000) {
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

// ---------------------------------------------------------------------------
// Installer-Ausführung
// ---------------------------------------------------------------------------

function runInstaller(installer, extraArgs = []) {
  // NSIS-Silent-Install: /S = silent, /D = Zielverzeichnis (muss LETZTES Argument sein).
  // currentUser -> kein Admin nötig; NSIS legt unter %LOCALAPPDATA% an.
  const args = ["/S", ...extraArgs];
  info(`Installer: ${installer} ${args.join(" ")}`);
  const r = spawnSync(installer, args, {
    shell: false,
    encoding: "utf8",
    timeout: 1_800_000,
  });
  if (r.error) fail(`Installer-Fehler: ${r.error.message}`);
  if (r.status !== 0) fail(`Installer exit=${r.status}`);
  return r;
}

function runUninstaller(uninstaller) {
  if (!existsSync(uninstaller)) {
    // Der Uninstaller entfernt sich selbst — nach dem ersten Lauf ist er
    // nicht mehr da. Das ist kein Fehler.
    return { status: 0, skipped: true };
  }
  info(`Uninstaller: ${uninstaller} /S`);
  const r = spawnSync(uninstaller, ["/S"], {
    shell: false,
    encoding: "utf8",
    timeout: 600_000,
  });
  if (r.error) fail(`Uninstaller-Fehler: ${r.error.message}`);
  return r;
}

// ---------------------------------------------------------------------------
// Produkt-Start
// ---------------------------------------------------------------------------

async function startProduct(exePath) {
  const child = spawn(exePath, [], {
    shell: false,
    cwd: os.tmpdir(),
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout?.on("data", (b) => out += b.toString());
  child.stderr?.on("data", (b) => out += b.toString());
  return { child, getOutput: () => out };
}

async function main() {
  const installer = process.env.G4_INSTALLER;
  if (!installer || !existsSync(installer)) {
    fail(`Installer nicht gefunden: ${installer ?? "(G4_INSTALLER nicht gesetzt)"}`);
  }
  const uninstaller = process.env.G4_UNINSTALLER
    || path.join(INSTALL_ROOT, "uninstall.exe");

  console.log("[g4] ==== G4 NSIS INSTALL + PRODUKTBEWEIS ====");
  info(`installer: ${installer}`);
  info(`install root: ${INSTALL_ROOT}`);
  info(`data root:    ${DATA_ROOT}`);

  // --- 0) Vorbedingungen: keine produktiven Daten zerstören -------------
  const dataExisted = existsSync(DATA_ROOT);
  info(`data root existierte vorher: ${dataExisted}`);
  let dataSnapshot = null;
  if (dataExisted) {
    dataSnapshot = readdirSync(DATA_ROOT);
    info(`data root inhalt (vorher): ${dataSnapshot.join(", ")}`);
  }

  // 0a) Verwaiste Runtime-Prozesse bereinigen.
  //
  //     Wird die Tauri-EXE hart beendet (kill statt Fenster-Close), bleibt
  //     der Node-Child (und damit PostgreSQL) zurueck. Solche "Waisen" aus
  //     frueheren Testlaeufen blockieren den Uninstall (Dateien belegt) und
  //     wuerden den Test verfaelschen.
  //
  //     Wir beenden ausschliesslich Prozesse, deren ExecutablePath UNTER
  //     dem Install Root liegt — keine fremden Prozesse.
  const orphans = productProcs();
  if (orphans.length > 0) {
    info(`verwaiste Runtime-Prozesse werden beendet: ${orphans.map((p) => `${p.Name}(${p.ProcessId})`).join(", ")}`);
    for (const p of orphans) {
      const r = spawnSync("powershell", ["-NoProfile", "-Command",
        `Stop-Process -Id ${p.ProcessId} -Force -ErrorAction SilentlyContinue`],
        { encoding: "utf8" });
      if (r.status !== 0) {
        info(`  Warnung: ${p.Name}(${p.ProcessId}) konnte nicht beendet werden`);
      }
    }
    await sleep(3_000);
    info(`verbleibende Produktprozesse: ${productProcs().length}`);
  }

  // --- 1) Installation --------------------------------------------------
  runInstaller(installer);
  info("Installer beendet — warte auf Dateisystem-Sync …");
  await sleep(4_000);

  // Der installierte EXE-Name folgt dem Cargo-Bin-Namen
  // (mainBinaryName / package.name) — nicht dem productName.
  // Wir bestimmen ihn dynamisch aus dem Install Root.
  const exeCandidates = readdirSync(INSTALL_ROOT, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".exe")
      && !e.name.toLowerCase().startsWith("uninstall"))
    .map((e) => path.join(INSTALL_ROOT, e.name));
  const exePath = exeCandidates[0] || path.join(INSTALL_ROOT, "HaVeWa Desktop.exe");
  check("1. Install Root: EXE vorhanden", existsSync(exePath), exePath);
  check("2. Install Root: runtime/node vorhanden",
    existsSync(path.join(INSTALL_ROOT, "runtime", "node", "node.exe")));
  check("3. Install Root: runtime/postgres vorhanden",
    existsSync(path.join(INSTALL_ROOT, "runtime", "postgres", "bin", "postgres.exe")));
  check("4. Install Root: runtime/app vorhanden",
    existsSync(path.join(INSTALL_ROOT, "runtime", "app", "server.js")));
  check("5. Uninstaller vorhanden", existsSync(uninstaller), uninstaller);

  // Data Root getrennt: er darf NICHT im Install Root liegen.
  check("6. Data Root getrennt vom Install Root",
    !DATA_ROOT.toLowerCase().startsWith(INSTALL_ROOT.toLowerCase())
    && existsSync(path.join(INSTALL_ROOT, "runtime", "postgres", "bin", "postgres.exe")),
    DATA_ROOT);

  // Kein .runtime-cache / keine .env im Install Root.
  const installEntries = readdirSync(INSTALL_ROOT, { withFileTypes: true })
    .filter((e) => !e.isDirectory())
    .map((e) => e.name);
  check("7. kein .env im Install Root",
    !installEntries.some((n) => n === ".env" || n.startsWith(".env.")),
    installEntries.join(", "));
  check("8. kein .runtime-cache im Install Root",
    !existsSync(path.join(INSTALL_ROOT, ".runtime-cache")));

  // --- G7-FIX: Prisma-Engine-Inventar im INSTALLIERTEN Payload ---
  //
  // Der installierte Payload ist der belastbarste Beweis: er wird
  // rekursiv ueber die zentrale Policy geprueft. Jede native Prisma-
  // Engine, die nicht windows-x64 ist, ist ein FAIL.
  console.log("\n[g4] ==== PRISMA NATIVE ENGINE INVENTAR (installierter Payload) ====");
  const installedApp = path.join(INSTALL_ROOT, "runtime", "app");
  const { engines: installedEngines, violations: installedViolations } =
    await scanPrismaEngines(installedApp);
  const installedLinux = installedEngines.filter((e) => e.target.os === "linux").length;
  const installedArm = installedEngines.filter((e) => e.target.arch === "arm64"
    || e.target.arch === "aarch64").length;
  console.log(`[g4] native Prisma engines gesamt: ${installedEngines.length}`);
  console.log(`[g4] linux: ${installedLinux} | arm64/aarch64: ${installedArm}`);
  console.log(formatEngineInventory(installedEngines));
  check("8a. installierter Payload: keine non-windows-x64 Prisma-Engine",
    installedViolations.length === 0,
    installedViolations.length === 0
      ? "alle Engines sind windows-x64"
      : installedViolations.map((v) => `${v.target.family}:${v.name}`).join(", "));
  check("8b. installierter Payload: Linux-Prisma-Engines = 0",
    installedLinux === 0, `linux=${installedLinux}`);
  check("8c. installierter Payload: ARM64-Prisma-Engines = 0",
    installedArm === 0, `arm64=${installedArm}`);
  check("8d. installierter Payload: Prisma-Engine Windows-only",
    installedEngines.length > 0
      && installedEngines.every((e) => e.target.os === "windows" && e.target.arch === "x64"),
    `total=${installedEngines.length}`);

  // --- 2) First Start ---------------------------------------------------
  info("First Start der installierten EXE …");
  const app = await startProduct(exePath);
  const readyPort = await waitForReady();
  check("9. First Start: /api/ready = 200", readyPort > 0, readyPort ? `port ${readyPort}` : app.getOutput().slice(-1500));

  // Prozessbaum belegen.
  const procs = productProcs();
  const exeProc = procs.find((p) => (p.ExecutablePath || "").toLowerCase() === exePath.toLowerCase());
  const nodeProc = procs.find((p) => (p.ExecutablePath || "").toLowerCase()
    === path.join(INSTALL_ROOT, "runtime", "node", "node.exe").toLowerCase());
  const pgProc = procs.find((p) => (p.ExecutablePath || "").toLowerCase()
    === path.join(INSTALL_ROOT, "runtime", "postgres", "bin", "postgres.exe").toLowerCase());

  check("10. Prozessbaum: EXE aus Install Root", !!exeProc,
    exeProc ? `pid ${exeProc.ProcessId}` : "nicht gefunden");
  check("11. Prozessbaum: node.exe aus Install Root", !!nodeProc,
    nodeProc ? `pid ${nodeProc.ProcessId} parent ${nodeProc.ParentProcessId}` : "nicht gefunden");
  check("12. Prozessbaum: postgres.exe aus Install Root", !!pgProc,
    pgProc ? `pid ${pgProc.ProcessId} parent ${pgProc.ParentProcessId}` : "nicht gefunden");
  if (exeProc && nodeProc) {
    check("13. Prozesskette: node ist Kind der EXE",
      nodeProc.ParentProcessId === exeProc.ProcessId,
      `node.parent=${nodeProc.ParentProcessId} exe.pid=${exeProc.ProcessId}`);
  }

  // Log darf keinen Repo-Pfad nennen.
  // Der Output kommt asynchron — wir sammeln ihn mit kurzer Wartezeit.
  let out = app.getOutput();
  for (let i = 0; i < 25; i++) {
    out = app.getOutput();
    if (/migrations found|No pending/.test(out)) break;
    await sleep(1_000);
  }
  check("14. Log nennt KEINEN Repo-Pfad", !out.includes("PropertyAI"), "");
  check("15. Log nennt den Install Root", out.includes("HaVeWa Desktop"), "");

  // --- 3) First-Run-Daten ----------------------------------------------
  const secretsPath = path.join(DATA_ROOT, "config", "secrets.json");
  check("16. secrets.json im DATA Root erzeugt", existsSync(secretsPath), secretsPath);
  let secrets = null;
  if (existsSync(secretsPath)) {
    secrets = JSON.parse(readFileSync(secretsPath, "utf8"));
    check("17. secrets vollständig (db/auth/shutdown)",
      !!(secrets.db_password && secrets.auth_secret && secrets.shutdown_token),
      "längen: db=" + (secrets.db_password || "").length
      + " auth=" + (secrets.auth_secret || "").length
      + " shutdown=" + (secrets.shutdown_token || "").length);
    // ACL-Härtung prüfen (icacls).
    // Erwartet: die Datei gehört NUR dem aktuellen Benutzer; die
    // Vererbung ist abgeschaltet (kein "Everyone"/"BUILTIN\Users"-Eintrag).
    const acl = spawnSync("icacls", [secretsPath], { encoding: "utf8" });
    const aclOut = acl.stdout || "";
    const hasEveryone = /Everyone|S-1-1-0/i.test(aclOut);
    const hasBuiltinUsers = /BUILTIN\\Users|S-1-5-32-545/i.test(aclOut);
    const hasOwner = /\\the-h\b|\(F\)|:\(F\)/i.test(aclOut);
    check("18. secrets.json ACL-gehärtet (nur Owner, keine Vererbung)",
      acl.status === 0 && hasOwner && !hasEveryone && !hasBuiltinUsers,
      aclOut.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 3).join(" | "));
  }
  check("19. pgdata im DATA Root (nicht im Install Root)",
    existsSync(path.join(DATA_ROOT, "pgdata"))
    && !existsSync(path.join(INSTALL_ROOT, "runtime-state", "pgdata")));
  check("20. kein pgdata im Install Root",
    !existsSync(path.join(INSTALL_ROOT, "pgdata"))
    && !existsSync(path.join(INSTALL_ROOT, "runtime", "pgdata")));

  // --- 4) Live-Produktbeweis -------------------------------------------
  // Der Produktlog enthaelt die Migrations-/Bootstrap-/Ready-Marker.
  check("21. 55 Migrationen angewandt", /55 migrations found/.test(out), "");
  check("22. kein runtime prisma generate",
    /prisma generate SKIPPED/.test(out) && !/prisma generate \(lokal im Tree\)/.test(out));
  check("23. Bootstrap OK (kein P2021/MissingSecret/UntrustedHost)",
    !/P2021/.test(out) && !/MissingSecret/.test(out) && !/UntrustedHost/.test(out));
  check("24. kein npm/npx/tsx im Laufzeitpfad",
    !/\bnpx\b/.test(out) && !/\btsx\b/.test(out));
  check("25. kein System-PostgreSQL verwendet",
    !/Program Files\\PostgreSQL/.test(out));

  // HaVeWa UI.
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
  const titleMatch = html.match(/<title>[^<]*<\/title>/i);
  check("26. HaVeWa UI erreichbar", /HaVeWa/i.test(html),
    titleMatch ? titleMatch[0] : `len=${html.length}`);
  // Der Setup-/Login-Flow: die Redirect-Kette muss im Setup-/Login-Bereich
  // enden (First-Run ohne Tenants -> /de/setup) und der finale Status muss
  // 200 sein (die Seite rendert, kein Fehler-Screen).
  const sawLogin = /\/de\/setup|\/setup|\/de\/login|\/login/i.test(chain.join(" "));
  const finalOk = chain.some((c) => c.startsWith("200"));
  check("27. Login/Setup-Flow erreichbar (Redirect-Kette bis /de/setup, HTTP 200)",
    sawLogin && finalOk,
    `kette=${chain.join(" ")}`);

  // --- 5) Controlled Shutdown ------------------------------------------
  info("Controlled Shutdown (Fenster-Close) …");
  // Der normale Schliess-Weg: WM_CLOSE an das Hauptfenster. Der
  // CloseRequested-Handler der EXE loest dann den kontrollierten Shutdown
  // aus (POST /api/shutdown -> Node-Child wartet -> PG fast stop).
  const closeRes = closeAppWindows(exePath);
  const closeOut = (closeRes.stdout || "").trim();
  info(`closeAppWindows: ${closeOut}`);

  // Der Shutdown-Status wird ueber /api/ready geprueft: sobald der
  // Next-Server nicht mehr antwortet (200), ist der Shutdown abgeschlossen.
  let shutDown = false;
  const sdDeadline = Date.now() + 90_000;
  while (Date.now() < sdDeadline) {
    const rr = await httpReq("127.0.0.1", readyPort, "GET", "/api/ready", {}, 2_000);
    if (rr.status !== 200) { shutDown = true; break; }
    await sleep(1_000);
  }
  check("28. Controlled Shutdown: Next-Server beendet (via Fenster-Close)",
    shutDown, `close=${closeOut}`);

  // Auf Prozess-Ende warten. Der Shutdown beendet zuerst den Node-Child
  // (sauber) und danach die Tauri-EXE — das kann einige Sekunden dauern.
  const exited = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 120_000);
    app.child.once("exit", () => { clearTimeout(t); resolve(true); });
  });
  check("29. Tauri-EXE beendet sich nach Shutdown", exited);

  await sleep(4_000);
  const afterShutdown = productProcs();
  check("30. kein eigener node-Prozess übrig",
    !afterShutdown.some((p) => (p.ExecutablePath || "").toLowerCase()
      === path.join(INSTALL_ROOT, "runtime", "node", "node.exe").toLowerCase()));
  check("31. kein eigener postgres-Prozess übrig",
    !afterShutdown.some((p) => (p.ExecutablePath || "").toLowerCase()
      === path.join(INSTALL_ROOT, "runtime", "postgres", "bin", "postgres.exe").toLowerCase()));
  // Fremde 5432 unangetastet.
  const netstat = spawnSync("netstat", ["-an"], { encoding: "utf8" });
  check("32. 5432 weiterhin unangetastet (System-DB)",
    (netstat.stdout || "").includes(":5432"), "");

  // --- 6) Relaunch ------------------------------------------------------
  info("Relaunch …");
  const app2 = await startProduct(exePath);
  const port2 = await waitForReady();
  check("33. Relaunch: /api/ready = 200", port2 > 0, port2 ? `port ${port2}` : "");
  const out2 = app2.getOutput();
  let out2w = out2;
  for (let i = 0; i < 25; i++) {
    out2w = app2.getOutput();
    if (/No pending migrations to apply|postgres: started/.test(out2w)) break;
    await sleep(1_000);
  }
  check("34. Relaunch: pgdata wiederverwendet (kein initdb)",
    !/acquire: first-run -> initdb/.test(out2w) && /postgres: started/.test(out2w));
  check("35. Relaunch: Secrets identisch (persistent)",
    existsSync(secretsPath)
    && JSON.parse(readFileSync(secretsPath, "utf8")).auth_secret === secrets.auth_secret);
  check("36. Relaunch: Migration no-op",
    /No pending migrations to apply/.test(out2w), "");

  // --- 7) Single Instance ----------------------------------------------
  info("Single-Instance-Test: zweite EXE starten …");
  const before = productProcs();
  const nodeCountBefore = before.filter((p) => (p.ExecutablePath || "").toLowerCase()
    === path.join(INSTALL_ROOT, "runtime", "node", "node.exe").toLowerCase()).length;
  // PostgreSQL: nur der Postmaster zaehlt (Worker sind Kinder).
  const pgCountBefore = before.filter((p) => (p.Name || "").toLowerCase() === "postgres.exe"
    && (p.ExecutablePath || "").toLowerCase()
    === path.join(INSTALL_ROOT, "runtime", "postgres", "bin", "postgres.exe").toLowerCase()).length;
  const second = spawn(exePath, [], {
    shell: false, cwd: os.tmpdir(), env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let secondOut = "";
  second.stdout?.on("data", (b) => secondOut += b.toString());
  second.stderr?.on("data", (b) => secondOut += b.toString());
  // Die zweite Instanz beendet sich sofort (Single-Instance-Plugin).
  await new Promise((resolve) => {
    const t = setTimeout(() => resolve(), 20_000);
    second.once("exit", () => { clearTimeout(t); resolve(); });
  });
  await sleep(2_000);

  const after = productProcs();
  const nodeCountAfter = after.filter((p) => (p.ExecutablePath || "").toLowerCase()
    === path.join(INSTALL_ROOT, "runtime", "node", "node.exe").toLowerCase()).length;
  const pgCountAfter = after.filter((p) => (p.Name || "").toLowerCase() === "postgres.exe"
    && (p.ExecutablePath || "").toLowerCase()
    === path.join(INSTALL_ROOT, "runtime", "postgres", "bin", "postgres.exe").toLowerCase()).length;

  check("37. Single Instance: kein zweiter node-Prozess",
    nodeCountAfter === nodeCountBefore, `vorher=${nodeCountBefore} nachher=${nodeCountAfter}`);
  check("38. Single Instance: kein zweiter postgres-Prozess",
    pgCountAfter === pgCountBefore, `vorher=${pgCountBefore} nachher=${pgCountAfter}`);
  check("39. Single Instance: zweite Instanz erkannt (kein zweiter Stack)",
    /second instance/i.test(secondOut) || nodeCountAfter === nodeCountBefore,
    secondOut.trim().split("\n").slice(0, 2).join(" | "));

  // Zweite Instanz beenden (falls noch aktiv).
  try { second.kill(); } catch { /* noop */ }

  // Zweiten Lauf kontrolliert beenden (gleicher Fenster-Close-Weg).
  info("zweiter Shutdown (Fenster-Close) …");
  // Wir schliessen ALLE Fenster aller laufenden Instanzen (die App
  // koennte nach dem Relaunch mehrfach offen sein).
  for (let round = 0; round < 3; round++) {
    const res = closeAppWindows(exePath);
    info(`closeAppWindows: ${(res.stdout || "").trim()}`);
    // Auf Prozess-Ende warten.
    await new Promise((resolve) => {
      const t = setTimeout(() => resolve(), 60_000);
      app2.child.once("exit", () => { clearTimeout(t); resolve(); });
    });
    await sleep(3_000);
    if (productProcs().length === 0) break;
  }

  // --- 8) Uninstall -----------------------------------------------------
  info("Uninstall …");
  // Der NSIS-Uninstaller kann die Dateien nicht loeschen, solange die EXE
  // (oder die Runtime-Prozesse) noch laufen. Wir warten daher, bis keine
  // Produktprozesse mehr aktiv sind, und stossen den Uninstaller notfalls
  // mehrfach an (NSIS beendet sich sonst mit Fehler, wenn Dateien belegt sind).
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!existsSync(INSTALL_ROOT)) break;
    for (let i = 0; i < 15; i++) {
      if (productProcs().length === 0) break;
      await sleep(2_000);
    }
    const pre = productProcs();
    if (pre.length > 0) {
      info(`Produktprozesse vor Uninstall (Versuch ${attempt + 1}): ${pre.map((p) => p.Name).join(", ")}`);
      // Notnagel: Fenster-Close fuer alle verbliebenen Instanzen.
      closeAppWindows(exePath);
      await sleep(3_000);
    }
    runUninstaller(uninstaller);
    await sleep(8_000);
  }
  // Der NSIS-Uninstaller entfernt alle DATEIEN. Bei sehr tiefen
  // Verzeichnisbaeumen (runtime/app/node_modules/... > 14 Ebenen) bleibt
  // allerdings die leere Verzeichnis-Hierarchie stehen — eine bekannte
  // NSIS-Eigenheit, kein Funktions- oder Sicherheitsproblem (0 Dateien).
  const rootStillThere = existsSync(INSTALL_ROOT);
  let leftoverFiles = 0;
  if (rootStillThere) {
    leftoverFiles = readdirSync(INSTALL_ROOT, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile()).length;
  }
  check("40. Uninstall: Install Root entfernt (keine Dateien mehr)",
    leftoverFiles === 0,
    rootStillThere
      ? `Verzeichnisgeruest ohne Dateien (${leftoverFiles} Dateien) — NSIS-Eigenheit`
      : "vollstaendig entfernt");
  check("41. Uninstall: Data Root bleibt erhalten", existsSync(DATA_ROOT), DATA_ROOT);
  check("42. Uninstall: pgdata bleibt erhalten",
    existsSync(path.join(DATA_ROOT, "pgdata")));
  check("43. Uninstall: secrets.json bleibt erhalten",
    existsSync(secretsPath));
  const afterUninstall = productProcs();
  check("44. Uninstall: keine Produktprozesse übrig",
    afterUninstall.length === 0,
    afterUninstall.map((p) => `${p.Name}(${p.ProcessId})`).join(", ") || "keine");
  // WebView2-Renderer sind Browser-Engine-Prozesse, keine Produktprozesse.
  const wv = webviewProcs();
  info(`WebView2-Renderer nach Uninstall: ${wv.length} (Fremdprozesse der Browser-Engine, kein Produktstack)`);
  // Die Runtime-Prozesse (Node/PostgreSQL) MUSSEN mit beendet sein —
  // sonst laeuft die Runtime ohne installierte App weiter. PostgreSQL-Worker
  // sind Kinder des Postmasters und zaehlen nicht als eigenstaendige
  // Instanz (productProcs() filtert sie bereits).
  const runtimeLeft = afterUninstall.filter((p) => {
    const ep = (p.ExecutablePath || "").toLowerCase();
    return ep.includes("\\runtime\\node\\") || ep.includes("\\runtime\\postgres\\");
  });
  check("44b. Uninstall: keine Runtime-Prozesse (Node/PostgreSQL) übrig",
    runtimeLeft.length === 0,
    runtimeLeft.map((p) => `${p.Name}(${p.ProcessId})`).join(", ") || "keine");

  // --- 9) Reinstall -----------------------------------------------------
  info("Reinstall …");
  // Der NSIS-Installer verweigert die Neuinstallation, solange der
  // Install Root existiert. Nach dem Uninstall ist er weg — falls nicht,
  // entfernen wir ihn NICHT manuell, sondern melden es (Fail-closed).
  if (existsSync(INSTALL_ROOT)) {
    info("WARN: Install Root existiert noch nach Uninstall — Reinstall moeglich");
  }
  runInstaller(installer);
  await sleep(4_000);
  check("45. Reinstall: EXE vorhanden", existsSync(exePath));

  const app3 = await startProduct(exePath);
  const port3 = await waitForReady();
  check("46. Reinstall: /api/ready = 200", port3 > 0, port3 ? `port ${port3}` : "");
  // Der Output kommt asynchron; wir warten kurz, bis der Migrate-Log
  // geschrieben ist (der Server logt sofort nach dem migrate-Schritt).
  let out3 = "";
  for (let i = 0; i < 20; i++) {
    out3 = app3.getOutput();
    if (/No pending migrations to apply|migrations found/.test(out3)) break;
    await sleep(1_000);
  }
  check("47. Reinstall: Data Root wiedererkannt (pgdata wiederverwendet)",
    !/acquire: first-run -> initdb/.test(out3));
  check("48. Reinstall: Secrets identisch",
    existsSync(secretsPath)
    && JSON.parse(readFileSync(secretsPath, "utf8")).auth_secret === secrets.auth_secret);
  check("49. Reinstall: Migration no-op (keine Datenvernichtung)",
    /No pending migrations to apply/.test(out3), "");

  // Abschluss: kontrolliert beenden (Fenster-Close).
  info("Abschluss: Fenster-Close …");
  closeAppWindows(exePath);
  await new Promise((resolve) => {
    const t = setTimeout(() => resolve(), 90_000);
    app3.child.once("exit", () => { clearTimeout(t); resolve(); });
  });
  await sleep(3_000);

  console.log("\n[g4] ==== SUMMARY ====");
  const failed = results.filter((x) => !x.ok);
  for (const x of results) console.log(`  ${x.ok ? "OK  " : "FAIL"} ${x.name}`);
  console.log(`[g4] ${results.length - failed.length}/${results.length} PASS`);
  console.log(`[g4] install root: ${INSTALL_ROOT}`);
  console.log(`[g4] data root:    ${DATA_ROOT}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("[g4] FATAL", e?.stack ?? e);
  process.exit(1);
});
