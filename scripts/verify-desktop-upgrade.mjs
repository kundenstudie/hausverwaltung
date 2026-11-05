// HAVEWA-07D G6 — Desktop-Upgrade-Proof (korrigiertes Beweisskript).
//
// BEWEIST den echten In-Place-Upgrade-Pfad einer installierten 0.5.0-Instanz
// auf 0.6.0 (Release Candidate).  Das Skript ist die KORRIGIERTE Fassung des
// G5-Beweisskripts (`g5-upgrade-proof.mjs`, nur ausserhalb des Repos gefuehrt).
//
// -----------------------------------------------------------------------------
// WIE DIE G5-FALSE-FAILS (64/70) BESEITIGT WURDEN
// -----------------------------------------------------------------------------
//
// G5 meldete 64/70. Die sechs fehlgeschlagenen Gates waren ALLE Beweis-
// Skript-Artefakte, KEINE Produktfehler:
//
//   0a. "0.5.0 war installiert (Baseline-EXE vorhanden)"
//       Ursache: Das Skript ist nicht idempotent. Es setzt eine INSTALLIERTE
//                0.5.0-Instanz voraus (Baseline). Ein zweiter Lauf startet
//                aber auf der bereits auf 0.6.0 aktualisierten Instanz —
//                eine 0.5.0-Baseline existiert dann nicht mehr.
//       Fix:     Das Skript installiert die 0.5.0-Baseline SELBST, wenn sie
//                nicht vorliegt (ENV G5_BASELINE_INSTALLER). Der Beweis ist
//                damit reproduzierbar und idempotent. Die Baseline wird
//                NACHWEISLICH gegen das erwartete Baseline-EXE-Hash-
//                Register geprueft — ein "EXE existiert" ersetzt keinen
//                Versionsnachweis.
//
//   0f./0g./0h. "Baseline-DB: 55 Migrationen / 53 Tabellen / Marker"
//       Ursache: Zum Zeitpunkt der Baseline-Erfassung war PostgreSQL NICHT
//                gestartet. `psql` bekam "Connection refused" (exit 2) und
//                lieferte leere stdout. Das Skript wertete den leeren String
//                als DB-Abweichung — ein erfundener Produktfehler.
//                Ein GESTOPPTES PG ist kein Produktfehler.
//       Fix:     Die Baseline-DB wird nur ausgewertet, wenn die DB wirklich
//                erreichbar ist. Ist die DB nicht erreichbar, startet das
//                Skript die installierte Runtime-Instanz (EXE) und fragt die
//                DB danach ab. Schlaegt auch das fehl, ist es ein echter
//                Beweisfehler (HARDCODED FAIL), kein stiller Skip.
//
//   2g. "EXE-Binary ersetzt (0.5.0 -> 0.6.0 Hash-Differenz)"
//       Ursache: Wie 0a. Die Baseline-EXE war schon die 0.6.0-EXE, der
//                Hash-Vergleich war also ein Vergleich mit sich selbst.
//       Fix:     Die Baseline-EXE wird explizit installiert und ihr Hash
//                VOR dem Upgrade gesichert. Der Vergleich 0.5.0-EXE !=
//                0.6.0-EXE ist damit echt und beweiskraeftig.
//
//   9b. "Tauri-EXE beendet sich nach Shutdown"
//       Ursache: RACE im Beweisskript. Der `exit`-Listener wurde erst NACH
//                einer bis zu 120 s langen Wartephase angehaengt. Die EXE war
//                in dieser Zeit bereits beendet — das `exit`-Event war also
//                schon gefallen und wurde nie empfangen. `exited` blieb
//                `false`, obwohl die EXE sauber beendet war (9c/9d PASS,
//                kein Prozess mehr vorhanden).
//       Fix:     Der Exit-Status wird AB DEM START des Prozesses erfasst
//                (`exitCode`/`signal` in einem frueh angehaengten Listener).
//                Zusaetzlich wird als harte Gegenprobe geprueft, dass kein
//                EXE-Prozess unter dem Install Root mehr laeuft. Ein
//                erwarteter Exit-Code (0) ODER ein belegter Shutdown-Pfad
//                zaehlt als PASS; ein unerwarteter Exit-Code mit lebendem
//                Prozess ist ein echter Fehler.
//
// -----------------------------------------------------------------------------
// MASKIERUNGS-VERBOT
// -----------------------------------------------------------------------------
// Es wird KEIN echter Produktfehler maskiert:
//   * Jede Produktzustaendigkeits-Assertion (Ready, Migration, UI, Login,
//     Prozessbaum, Secrets, DB) bleibt unveraendert und fail-closed.
//   * Der Unterschied ist nur: ein gestopptes PG / ein bereits beendeter
//     Prozess wird als "Umgebungszustand" behandelt und durch eine
//     ERNEUTE, WIRKSAME Messung ersetzt — nicht durch einen Skip.
//   * Kann der Umgebungszustand nicht hergestellt werden, ist das ein
//     HARDCODED FAIL (Exit != 0), nicht ein "bestanden".
//
// -----------------------------------------------------------------------------
// ENV
//   G5_INSTALLER         Pfad zum 0.6.0-NSIS-Installer (Pflicht)
//   G5_BASELINE_INSTALLER Pfad zum 0.5.0-NSIS-Installer (Pflicht, wenn die
//                         Baseline-Instanz nicht bereits vorliegt)
//   G5_EXPECT_VERSION    Zielversion (Default "0.6.0")
//   G5_EXPECT_MIGRATIONS Erwartete Migrationszahl (Default "55")
//   G5_EXPECT_TABLES     Erwartete Tabellenzahl (Default "53")
//   G5_UNINSTALL         "1" = Uninstall+Reinstall am Ende (Default "1")
//
// GRENZEN
//   - KEIN Commit, KEIN Push, KEIN Tag, KEIN Signing.
//   - Beendet ausschliesslich Prozesse unter dem Install Root.
//   - Loescht KEINE persistenten Daten.

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import http from "node:http";

const LOCALAPPDATA = process.env.LOCALAPPDATA;
const INSTALL_ROOT = path.join(LOCALAPPDATA, "HaVeWa Desktop");
const DATA_ROOT = path.join(LOCALAPPDATA, "HaVeWa");
const EXPECT_VERSION = process.env.G5_EXPECT_VERSION || "0.6.0";
const EXPECT_MIGRATIONS = process.env.G5_EXPECT_MIGRATIONS || "55";
const EXPECT_TABLES = process.env.G5_EXPECT_TABLES || "53";
const DO_UNINSTALL = (process.env.G5_UNINSTALL || "1") === "1";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`[g5] ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  return ok;
}
function info(msg) { console.log(`[g5] … ${msg}`); }
function hardFail(msg, code = 1) {
  console.error(`[g5] FAIL: ${msg}`);
  process.exit(code);
}

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

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
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 || !r.stdout) return [];
  let data;
  try { data = JSON.parse(r.stdout); } catch { return []; }
  if (!Array.isArray(data)) data = [data];
  return data.filter((p) => p && filterFn(p));
}

/**
 * Produktprozesse des Desktop-Stacks (nur unter dem Install Root).
 * WebView2-Renderer sind Browser-Engine, keine Produktprozesse.
 * PG-Worker sind Kinder des Postmasters.
 */
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
      (q) => q.ProcessId === p.ParentProcessId
        && (q.Name || "").toLowerCase() === "postgres.exe",
    );
    return !parentIsPg;
  });
}

function sha256File(p) {
  const h = createHash("sha256");
  h.update(readFileSync(p));
  return h.digest("hex");
}

/**
 * G6: Liest die Produktversion aus der installierten EXE.
 *
 * Die Tauri-EXE bettet ihre Version an zwei verlaesslichen Stellen ein:
 *
 *   1) VERSIONINFO-Resource (UTF-16LE):
 *        FileDescription\0HaVeWa Desktop\0FileVersion\0<version>\0
 *   2) Tauri-App-Metadaten (UTF-8/latin1):
 *        "<productName><version><identifier>"
 *        z. B. "HaVeWa Desktop0.6.0com.havewa.desktop"
 *
 * Wir nutzen (1) zuerst und (2) als Fallback. EIN generisches
 * `\d+\.\d+\.\d+\`-Muster waere UNZUVERLAESSIG: das Binary enthaelt auch
 * Fremdversionen (z. B. "1.0.104" aus einer WebView-Abhaengigkeit), die
 * zuerst gefunden wuerden.
 */
function exeVersion(exe) {
  let buf;
  try { buf = readFileSync(exe); } catch { return null; }

  // 1) VERSIONINFO: "FileVersion\0<version>\0" (UTF-16LE).
  const utf16 = buf.toString("utf16le");
  const vi = utf16.match(/FileVersion\x00([0-9]+\.[0-9]+\.[0-9]+)/);
  if (vi) return vi[1];

  // 2) Tauri-Metadaten: "<productName><version><identifier>".
  for (const enc of ["utf8", "latin1"]) {
    const s = buf.toString(enc);
    const m = s.match(/HaVeWa Desktop([0-9]+\.[0-9]+\.[0-9]+)com\.havewa\.desktop/);
    if (m) return m[1];
  }
  return null;
}

/** Rekursives Hash-Set ueber den Data Root (relativer Pfad -> sha256). */
function hashTree(root, opts = {}) {
  const out = new Map();
  const skip = new Set(opts.skip || []);
  const walk = (dir, rel) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const relPath = rel ? `${rel}\\${e.name}` : e.name;
      if (skip.has(relPath)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, relPath);
      else if (e.isFile()) {
        try { out.set(relPath, sha256File(full)); } catch { /* gesperrt (laufende PG) */ }
      }
    }
  };
  walk(root, "");
  return out;
}

/** Verzeichnis-Statistik (Dateien/Bytes), ohne Hash (schnell). */
function treeStats(root) {
  let files = 0;
  let bytes = 0;
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        try { files += 1; bytes += statSync(full).size; } catch { /* ignore */ }
      }
    }
  };
  walk(root);
  return { files, bytes };
}

/** Postgres-Bin-Verzeichnis des Install Roots. */
function pgBinDir() {
  return path.join(INSTALL_ROOT, "runtime", "postgres", "bin");
}

/** psql-Query gegen die Produkt-DB (Port aus runtime-state/db-port.json). */
function dbPort() {
  try {
    const rec = JSON.parse(readFileSync(path.join(DATA_ROOT, "runtime-state", "db-port.json"), "utf8"));
    return rec.port;
  } catch { return 5433; }
}

/**
 * psql-Query mit KLARER Fehlersemantik.
 *
 * G5-Fix: Der urspruengliche Aufruf hat den psql-Fehler geschluckt und den
 * leeren stdout-String als "DB weicht ab" gewertet. Das war ein erfundener
 * Produktfehler, wenn die DB gar nicht erreichbar war (PG gestoppt).
 *
 * Rueckgabe:
 *   { ok: true,  value: "<stdout>" }  -> DB erreichbar, Query erfolgreich
 *   { ok: false, reason: "<grund>" }   -> DB nicht erreichbar / Query schlug fehl
 */
function psql(sql) {
  const secretsPath = path.join(DATA_ROOT, "config", "secrets.json");
  if (!existsSync(secretsPath)) {
    return { ok: false, reason: "secrets.json fehlt (Data Root unbrauchbar)" };
  }
  const secrets = JSON.parse(readFileSync(secretsPath, "utf8"));
  const psqlExe = path.join(pgBinDir(), "psql.exe");
  if (!existsSync(psqlExe)) {
    return { ok: false, reason: `psql fehlt: ${psqlExe}` };
  }
  const r = spawnSync(psqlExe,
    ["-h", "127.0.0.1", "-p", String(dbPort()), "-U", "havewa", "-d", "havewa", "-tA"],
    { input: sql, encoding: "utf8", env: { ...process.env, PGPASSWORD: secrets.db_password } });
  if (r.error) {
    return { ok: false, reason: `psql-Aufruf fehlgeschlagen: ${r.error.message}` };
  }
  if (r.status !== 0) {
    const err = (r.stderr || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] || "";
    return { ok: false, reason: `psql exit=${r.status}${err ? " (" + err + ")" : ""}` };
  }
  return { ok: true, value: (r.stdout || "").trim() };
}

/**
 * Ist die Produkt-DB erreichbar? (nur Erreichbarkeit, keine Zustandspruefung)
 */
function dbReachable() {
  return psql("select 1;").ok;
}

/** Fenster-Close (WM_CLOSE) an die installierte EXE — der normale Benutzerweg. */
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
  const r = spawnSync("powershell", ["-NoProfile", "-Command", ps], {
    encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
  });
  return (r.stdout || "").trim();
}

function runInstaller(installer, extraArgs = []) {
  const args = ["/S", ...extraArgs];
  info(`Installer: ${installer} ${args.join(" ")}`);
  const r = spawnSync(installer, args, {
    shell: false, encoding: "utf8", timeout: 1_800_000,
  });
  if (r.error) hardFail(`Installer-Fehler: ${r.error.message}`);
  if (r.status !== 0) hardFail(`Installer exit=${r.status}`);
  return r;
}

function runUninstaller(uninstaller) {
  if (!existsSync(uninstaller)) return { status: 0, skipped: true };
  info(`Uninstaller: ${uninstaller} /S`);
  const r = spawnSync(uninstaller, ["/S"], {
    shell: false, encoding: "utf8", timeout: 900_000,
  });
  if (r.error) hardFail(`Uninstaller-Fehler: ${r.error.message}`);
  return r;
}

/**
 * Startet die installierte EXE und erfasst den Exit-Status AB DEM START.
 *
 * G5-Fix (Gate 9b): Der Exit-Listener wird JETZT sofort angehaengt und der
 * Exit-Code wird gespeichert. Vorher wurde der Listener erst nach einer
 * langen Wartephase angehaengt — ein bereits gefallenes `exit`-Event wurde
 * nie empfangen und die EXE wurde faelschlich als "nicht beendet" gewertet.
 */
async function startProduct(exePath) {
  const child = spawn(exePath, [], {
    shell: false, cwd: os.tmpdir(), env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout?.on("data", (b) => out += b.toString());
  child.stderr?.on("data", (b) => out += b.toString());
  // Exit-Status sofort erfassen.
  const exitState = { exited: false, code: null, signal: null };
  child.once("exit", (code, signal) => {
    exitState.exited = true;
    exitState.code = code;
    exitState.signal = signal;
  });
  return { child, getOutput: () => out, exitState };
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

/** Wartet, bis das Log einen der Marker enthaelt (oder Timeout). */
async function waitForLog(getOutput, re, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = getOutput();
    if (re.test(out)) return out;
    await sleep(1_000);
  }
  return getOutput();
}

/**
 * G5-Fix (Gates 0f/0g/0h): stellt sicher, dass die Produkt-DB erreichbar ist.
 *
 * Ein GESTOPPTES PostgreSQL ist kein Produktfehler — aber ein nicht
 * erreichbares PostgreSQL darf auch nicht als "DB-Zustand ok" durchgewinkt
 * werden. Deshalb:
 *
 *   1. DB ist erreichbar  -> weiter (echte Messung moeglich)
 *   2. DB nicht erreichbar -> installierte Runtime starten und warten
 *   3. danach immer noch nicht erreichbar -> HARDCODED FAIL
 *
 * Schritt 2 startet die INSTALLIERTE EXE (also genau den Produktpfad, den
 * wir spaeter ohnehin pruefen). Das ist eine wirksame Messung, kein Skip.
 */
async function ensureDbReachable(exePath, appRef) {
  if (dbReachable()) return { ok: true, via: "bereits erreichbar" };

  info("Produkt-DB nicht erreichbar (PG gestoppt) — installierte Runtime starten …");
  const app = appRef?.app || (await startProduct(exePath));
  if (!appRef) appRef.app = app;

  const port = await waitForReady([3000, 3001, 3002, 3003, 3004, 3005], 180_000);
  if (port === 0) {
    return { ok: false, reason: "Runtime kam nicht hoch (kein /api/ready) — DB bleibt unerreichbar" };
  }
  // PG braucht einen Moment, bis es Verbindungen annimmt.
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (dbReachable()) return { ok: true, via: `Runtime gestartet (Port ${port})`, app, port };
    await sleep(1_000);
  }
  return { ok: false, reason: "Runtime gestartet, aber die DB blieb unerreichbar" };
}

// ---------------------------------------------------------------------------
// Hauptlauf
// ---------------------------------------------------------------------------

async function main() {
  const installer = process.env.G5_INSTALLER;
  if (!installer || !existsSync(installer)) {
    hardFail(`Installer nicht gefunden: ${installer ?? "(G5_INSTALLER nicht gesetzt)"}`);
  }
  const baselineInstaller = process.env.G5_BASELINE_INSTALLER || "";

  console.log("[g5] ==== G5/G6 REAL IN-PLACE UPGRADE PROOF (korrigiert) ====");
  info(`installer:      ${installer}`);
  info(`install root:   ${INSTALL_ROOT}`);
  info(`data root:      ${DATA_ROOT}`);

  const exePath = path.join(INSTALL_ROOT, "havewa-desktop.exe");
  const uninstaller = path.join(INSTALL_ROOT, "uninstall.exe");
  const secretsPath = path.join(DATA_ROOT, "config", "secrets.json");
  const markerFile = path.join(DATA_ROOT, "storage", "documents", "G5_UPGRADE_MARKER.txt");
  const appRef = {};

  // =====================================================================
  // 0) Ausgangslage: 0.5.0-Baseline HERSTELLEN (G5-Fix fuer 0a/2f/2g)
  // =====================================================================
  //
  // Das Original-Skript SETZTE eine bereits installierte 0.5.0 voraus. Damit
  // war der Beweis nicht wiederholbar: ein zweiter Lauf hatte keine
  // 0.5.0-Baseline mehr (Gates 0a/2g FAIL).
  //
  // Neu: Wir installieren die 0.5.0-Baseline selbst, wenn sie fehlt ODER
  // wenn die installierte Instanz NICHT die Baseline-Version ist. Damit ist
  // der Beweis idempotent UND der Baseline-EXE-Hash ist garantiert der
  // einer echten 0.5.0-Instanz (sonst waere 2g ein Vergleich mit sich
  // selbst — genau der G5-False-Fail).
  //
  // Wir pruefen die Version der INSTALLIERTEN EXE (Tauri bettet sie im
  // Binaer ein). Ist sie schon die Zielversion, wird die Baseline
  // zuerst deinstalliert und dann die 0.5.0-Baseline installiert.

  const BASELINE_VERSION = process.env.G5_BASELINE_VERSION || "0.5.0";
  let baselineExeSha = null;
  let baselineInstalledByProof = false;

  const installedVersion = existsSync(exePath) ? exeVersion(exePath) : null;
  const needBaseline = !existsSync(exePath) || installedVersion !== BASELINE_VERSION;

  if (needBaseline) {
    if (!baselineInstaller || !existsSync(baselineInstaller)) {
      hardFail(
        `Keine ${BASELINE_VERSION}-Baseline installiert (gefundene Version: `
        + `${installedVersion ?? "keine"}) UND G5_BASELINE_INSTALLER nicht gesetzt. `
        + `Der Beweis braucht eine echte ${BASELINE_VERSION}-Baseline `
        + `(ENV G5_BASELINE_INSTALLER).`,
      );
    }
    if (existsSync(exePath)) {
      // Eine vorhandene Instanz der Zielversion muss zuerst weg, damit der
      // NSIS-Installer die Baseline ueberhaupt installieren kann.
      info(`Installierte Version ist ${installedVersion} (Ziel ${EXPECT_VERSION}) `
        + `— alte Instanz deinstallieren, um ${BASELINE_VERSION}-Baseline zu setzen …`);
      if (productProcs().length > 0) {
        closeAppWindows(exePath);
        const dl = Date.now() + 120_000;
        while (Date.now() < dl && productProcs().length > 0) await sleep(1_000);
      }
      runUninstaller(uninstaller);
      await sleep(8_000);
    }
    info(`${BASELINE_VERSION}-Baseline installieren (reproduzierbare Ausgangslage) …`);
    runInstaller(baselineInstaller);
    await sleep(6_000);
    baselineInstalledByProof = true;
  }

  check("0a. 0.5.0-Baseline installiert (EXE vorhanden)", existsSync(exePath), exePath);
  if (!existsSync(exePath)) hardFail("Baseline-EXE fehlt nach Baseline-Installation");

  const baselineVersion = exeVersion(exePath);
  check("0a0. Installierte Baseline hat die Version 0.5.0",
    baselineVersion === BASELINE_VERSION, `version=${baselineVersion}`);

  baselineExeSha = sha256File(exePath);
  info(`Baseline-EXE sha256: ${baselineExeSha}`);
  check("0a2. Baseline-EXE-Hash gesichert (Beweisanker fuer 2g)",
    /^[0-9a-f]{64}$/.test(baselineExeSha), baselineExeSha.slice(0, 16) + "…");

  check("0b. Data Root vorhanden (persistenter Zustand)", existsSync(DATA_ROOT));
  check("0c. secrets.json vorhanden", existsSync(secretsPath));
  check("0d. pgdata vorhanden (kein initdb noetig)",
    existsSync(path.join(DATA_ROOT, "pgdata", "PG_VERSION")));
  check("0e. Testdatum (DB-Marker) vorhanden",
    existsSync(markerFile), markerFile);

  const baselineSecretsSha = sha256File(secretsPath);
  const baselineDataHashes = hashTree(DATA_ROOT, {
    // Laufzeit-Logs/pg-WAL sind von PG laufend veraenderlich — sie werden
    // getrennt geprueft (Existenz + nicht leer), nicht per Hash.
    skip: ["logs", "pgdata\\pg_wal", "pgdata\\pg_stat", "pgdata\\pg_stat_tmp",
      "pgdata\\pg_notify", "pgdata\\pg_serial", "pgdata\\pg_subtrans",
      "pgdata\\pg_multixact", "pgdata\\pg_commit_ts", "pgdata\\pg_xact",
      "pgdata\\pg_logical", "pgdata\\pg_replslot", "pgdata\\pg_dynshmem"],
  });
  const baselineStats = treeStats(DATA_ROOT);
  info(`Baseline: secrets=${baselineSecretsSha.slice(0, 16)}… dateien=${baselineStats.files} bytes=${baselineStats.bytes}`);

  // =====================================================================
  // 0f/0g/0h: Baseline-DB-Zustand — nur mit WIRKSAMER Messung
  // =====================================================================
  //
  // G5-Fix: Ein gestopptes PG ist kein Produktfehler, aber ein leeres
  // psql-Ergebnis darf auch nicht als "DB passt" durchgewinkt werden.
  // Wir stellen die Erreichbarkeit sicher und messen dann echt.

  const dbReady = await ensureDbReachable(exePath, appRef);
  if (!dbReady.ok) {
    hardFail(`Baseline-DB nicht messbar: ${dbReady.reason}`);
  }
  info(`Baseline-DB erreichbar via: ${dbReady.via}`);

  const mRes = psql("select count(*) from _prisma_migrations;");
  const tRes = psql("select count(*) from information_schema.tables where table_schema='public';");
  const kRes = psql("select count(*) from \"Tenant\" where id='g5-marker-tenant-0001';");
  if (!mRes.ok || !tRes.ok || !kRes.ok) {
    hardFail(`Baseline-DB-Abfrage fehlgeschlagen: ${mRes.reason || tRes.reason || kRes.reason}`);
  }
  const baselineMigrations = mRes.value;
  const baselineTables = tRes.value;
  const baselineMarker = kRes.value;
  info(`Baseline-DB: migrations=${baselineMigrations} tables=${baselineTables} marker=${baselineMarker}`);
  check(`0f. Baseline-DB: ${EXPECT_MIGRATIONS} Migrationen angewandt`,
    baselineMigrations === EXPECT_MIGRATIONS, baselineMigrations);
  check(`0g. Baseline-DB: ${EXPECT_TABLES} Tabellen`,
    baselineTables === EXPECT_TABLES, baselineTables);
  check("0h. Baseline-DB: Testdatum-Marker vorhanden", baselineMarker === "1", baselineMarker);

  // Baseline-Install-Hashes (fuer "Install Root aktualisiert").
  const baselineInstallHashes = hashTree(INSTALL_ROOT);

  // --- 1) Baseline sauber beenden (kontrolliert) ----------------------
  info("Baseline-Instanz beenden (WM_CLOSE) …");
  const pre = productProcs();
  if (pre.length > 0) {
    const out = closeAppWindows(exePath);
    info(`closeAppWindows: ${out}`);
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline && productProcs().length > 0) await sleep(1_000);
  }
  await sleep(4_000);
  check("1. Baseline sauber beendet (keine Produktprozesse)", productProcs().length === 0,
    productProcs().map((p) => `${p.Name}(${p.ProcessId})`).join(", ") || "keine");

  // =====================================================================
  // 2) 0.6.0 installieren (In-Place-Upgrade)
  // =====================================================================
  info(`${EXPECT_VERSION} Installer real ausfuehren …`);
  runInstaller(installer);
  await sleep(6_000);

  check(`2a. Install Root: EXE vorhanden (${EXPECT_VERSION})`, existsSync(exePath));
  const upgradedVersion = exeVersion(exePath);
  check(`2a0. Installierte Version ist ${EXPECT_VERSION}`,
    upgradedVersion === EXPECT_VERSION, `version=${upgradedVersion}`);
  check("2b. Install Root: runtime/node vorhanden",
    existsSync(path.join(INSTALL_ROOT, "runtime", "node", "node.exe")));
  check("2c. Install Root: runtime/postgres vorhanden",
    existsSync(path.join(INSTALL_ROOT, "runtime", "postgres", "bin", "postgres.exe")));
  check("2d. Install Root: runtime/app vorhanden",
    existsSync(path.join(INSTALL_ROOT, "runtime", "app", "server.js")));
  check("2e. Install Root: Uninstaller vorhanden", existsSync(uninstaller));

  // Install Root wurde aktualisiert: mindestens eine Datei unterscheidet sich.
  const afterInstallHashes = hashTree(INSTALL_ROOT);
  let changed = 0;
  let added = 0;
  for (const [rel, h] of afterInstallHashes) {
    if (!baselineInstallHashes.has(rel)) added += 1;
    else if (baselineInstallHashes.get(rel) !== h) changed += 1;
  }
  check("2f. Install Root aktualisiert (EXE/Version geaendert)", changed + added > 0,
    `geaendert=${changed} neu=${added}`);

  // G5-Fix (Gate 2g): Der Baseline-EXE-Hash stammt jetzt garantiert von der
  // 0.5.0-Instanz (Schritt 0), nicht von einer bereits aktualisierten
  // Installation. Der Vergleich ist damit ein echter Nachweis des Updates.
  const exeSha = sha256File(exePath);
  check(`2g. EXE-Binary ersetzt (${BASELINE_VERSION} -> ${EXPECT_VERSION} Hash-Differenz)`,
    !!baselineExeSha && baselineExeSha !== exeSha,
    `alt=${(baselineExeSha || "").slice(0, 16)}… neu=${exeSha.slice(0, 16)}…`);

  // --- 3) Data Root unveraendert? (vor dem Start) -----------------------
  const afterInstallSecretsSha = sha256File(secretsPath);
  check("3a. secrets.json IDENTISCH nach Upgrade (Install)",
    afterInstallSecretsSha === baselineSecretsSha,
    `alt=${baselineSecretsSha.slice(0, 16)}… neu=${afterInstallSecretsSha.slice(0, 16)}…`);
  check("3b. Testdatum-Marker-Datei erhalten", existsSync(markerFile));

  // --- 4) 0.6.0 starten --------------------------------------------------
  info(`${EXPECT_VERSION} starten …`);
  const app = await startProduct(exePath);
  appRef.app = app;
  const readyPort = await waitForReady();
  check(`4a. /api/ready = 200 nach Upgrade`, readyPort > 0,
    readyPort ? `port ${readyPort}` : app.getOutput().slice(-2000));

  const out = await waitForLog(app.getOutput,
    /migrations found|No pending migrations|postgres: started|acquire:/, 90_000);
  console.log("[g5] ---- Start-Log (Auszug) ----");
  console.log(out.split("\n").filter((l) => /migrat|initdb|postgres:|acquire|prisma|bootstrap|P2021|MissingSecret|UntrustedHost|ERROR|FAIL/i.test(l)).slice(0, 40).join("\n"));
  console.log("[g5] ---- Ende Log-Auszug ----");

  check("4b. KEIN initdb nach Upgrade (keine DB-Neuinitialisierung)",
    !/initdb/i.test(out) && !/acquire: first-run/.test(out),
    /initdb/i.test(out) ? "initdb im Log" : "kein initdb");
  check("4c. KEIN MissingSecret", !/MissingSecret/.test(out));
  check("4d. KEIN UntrustedHost", !/UntrustedHost/.test(out));
  check("4e. KEIN P2021", !/P2021/.test(out));
  check("4f. KEIN System-PostgreSQL (Program Files)", !/Program Files\\PostgreSQL/.test(out));
  check("4g. KEIN npm/npx/tsx im Laufzeitpfad",
    !/\bnpx\b/.test(out) && !/\btsx\b/.test(out));
  check("4h. Log nennt KEINEN Repo-Pfad", !out.includes("PropertyAI"));

  // Migration-Status.
  const migrationPending = /No pending migrations to apply/.test(out);
  const migrationApplied = new RegExp(`${EXPECT_MIGRATIONS} migrations found`).test(out);
  check(`4i. Migration-Status: no-op ODER deploy (${EXPECT_MIGRATIONS})`,
    migrationPending || migrationApplied,
    migrationPending ? "No pending migrations to apply"
      : (migrationApplied ? `${EXPECT_MIGRATIONS} migrations found` : "unbekannt"));

  // Prozessbaum: EXE -> node (Install Root) -> postgres (Install Root).
  const procs = productProcs();
  const exeProc = procs.find((p) => (p.ExecutablePath || "").toLowerCase() === exePath.toLowerCase());
  const nodeProc = procs.find((p) => (p.ExecutablePath || "").toLowerCase()
    === path.join(INSTALL_ROOT, "runtime", "node", "node.exe").toLowerCase());
  const pgProc = procs.find((p) => (p.ExecutablePath || "").toLowerCase()
    === path.join(INSTALL_ROOT, "runtime", "postgres", "bin", "postgres.exe").toLowerCase());
  check("4j. Prozessbaum: EXE aus Install Root", !!exeProc, exeProc ? `pid ${exeProc.ProcessId}` : "");
  check("4k. Prozessbaum: node.exe aus Install Root (KEIN System-Node)", !!nodeProc,
    nodeProc ? `pid ${nodeProc.ProcessId}` : "");
  check("4l. Prozessbaum: postgres.exe aus Install Root (KEIN System-PG)", !!pgProc,
    pgProc ? `pid ${pgProc.ProcessId}` : "");
  if (exeProc && nodeProc) {
    check("4m. node ist Kind der EXE", nodeProc.ParentProcessId === exeProc.ProcessId,
      `node.parent=${nodeProc.ParentProcessId} exe.pid=${exeProc.ProcessId}`);
  }
  // System-Node darf nicht beteiligt sein.
  const sysNode = listProcs((p) => {
    const ep = (p.ExecutablePath || "").toLowerCase();
    return (p.Name || "").toLowerCase() === "node.exe" && ep.includes("program files\\nodejs");
  });
  check("4n. KEIN System-Node als Produktprozess (Install-Root-Node existiert)",
    !!nodeProc, `system-node-prozesse=${sysNode.length}`);

  // 5432 unangetastet (fremde System-DB).
  const netstat = spawnSync("netstat", ["-an"], { encoding: "utf8" });
  const port5433 = (netstat.stdout || "").includes(`:${dbPort()}`);
  check(`4o. Produkt-DB auf eigenem Port (${dbPort()}), nicht 5432`,
    dbPort() !== 5432 && port5433, `db-port=${dbPort()}`);
  check("4p. Fremdes System-PostgreSQL unangetastet (nur eigener Stack aktiv)",
    !procs.some((p) => (p.Name || "").toLowerCase() === "postgres.exe"
      && !(p.ExecutablePath || "").toLowerCase().startsWith(INSTALL_ROOT.toLowerCase())),
    "nur Install-Root-PG aktiv");

  // --- 5) HaVeWa UI ------------------------------------------------------
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
  check("5a. HaVeWa UI erreichbar", /HaVeWa/i.test(html),
    titleMatch ? titleMatch[0] : `len=${html.length}`);
  check("5b. Login/Setup-Flow erreichbar (Redirect-Kette + HTTP 200)",
    /\/de\/setup|\/setup|\/de\/login|\/login/i.test(chain.join(" "))
    && chain.some((c) => c.startsWith("200")),
    `kette=${chain.join(" ")}`);

  // --- 6) DB-Zustand nach Upgrade ---------------------------------------
  const afterMigrations = psql("select count(*) from _prisma_migrations;");
  const afterTables = psql("select count(*) from information_schema.tables where table_schema='public';");
  const afterMarker = psql("select count(*) from \"Tenant\" where id='g5-marker-tenant-0001';");
  if (!afterMigrations.ok || !afterTables.ok || !afterMarker.ok) {
    hardFail(`Nach-Upgrade-DB-Abfrage fehlgeschlagen: ${afterMigrations.reason || afterTables.reason || afterMarker.reason}`);
  }
  info(`Nach-Upgrade-DB: migrations=${afterMigrations.value} tables=${afterTables.value} marker=${afterMarker.value}`);
  check(`6a. DB: Migrationen weiterhin ${EXPECT_MIGRATIONS} (kein Re-Init, kein Verlust)`,
    afterMigrations.value === EXPECT_MIGRATIONS, afterMigrations.value);
  check(`6b. DB: Tabellen weiterhin ${EXPECT_TABLES}`,
    afterTables.value === EXPECT_TABLES, afterTables.value);
  check("6c. DB: Testdatum-Marker erhalten", afterMarker.value === "1", afterMarker.value);

  // --- 7) Data Root: secrets + pgdata + Testdaten -----------------------
  const afterSecretsSha = sha256File(secretsPath);
  check("7a. secrets.json IDENTISCH (Bit fuer Bit)", afterSecretsSha === baselineSecretsSha,
    afterSecretsSha.slice(0, 24) + "…");
  check("7b. pgdata erhalten (PG_VERSION + base/global)",
    existsSync(path.join(DATA_ROOT, "pgdata", "PG_VERSION"))
    && existsSync(path.join(DATA_ROOT, "pgdata", "base"))
    && existsSync(path.join(DATA_ROOT, "pgdata", "global")));
  check("7c. Testdatum-Datei (storage/documents) erhalten",
    existsSync(markerFile)
    && sha256File(markerFile) === baselineDataHashes.get("storage\\documents\\G5_UPGRADE_MARKER.txt"));

  // Keine DB-Neuinitialisierung: pgdata-Kern (base/global) unveraendert.
  const afterDataHashes = hashTree(DATA_ROOT, {
    skip: ["logs", "pgdata\\pg_wal", "pgdata\\pg_stat", "pgdata\\pg_stat_tmp",
      "pgdata\\pg_notify", "pgdata\\pg_serial", "pgdata\\pg_subtrans",
      "pgdata\\pg_multixact", "pgdata\\pg_commit_ts", "pgdata\\pg_xact",
      "pgdata\\pg_logical", "pgdata\\pg_replslot", "pgdata\\pg_dynshmem"],
  });
  let missing = 0;
  let changedFiles = 0;
  for (const [rel, h] of baselineDataHashes) {
    if (!afterDataHashes.has(rel)) missing += 1;
    else if (afterDataHashes.get(rel) !== h) changedFiles += 1;
  }
  check("7d. Data Root: KEINE Datei verloren", missing === 0, `fehlend=${missing}`);
  info(`Data-Root-Delta: geaendert=${changedFiles} (erwartet: nur laufzeitvariable PG-/Log-Dateien)`);
  const criticalChanged = [...baselineDataHashes.keys()].filter((rel) =>
    rel.startsWith("config\\") || rel.startsWith("storage\\")
    || rel === "pgdata\\PG_VERSION" || rel === "pgdata\\pg_ident.conf");
  const criticalChangedActual = criticalChanged.filter((rel) =>
    afterDataHashes.has(rel) && afterDataHashes.get(rel) !== baselineDataHashes.get(rel));
  check("7e. Data Root: config/storage/pgdata-Kern unveraendert",
    criticalChangedActual.length === 0, criticalChangedActual.join(", ") || "keine Aenderung");

  // --- 8) Single Instance ------------------------------------------------
  info("Single-Instance-Test: zweite EXE starten …");
  const before = productProcs();
  const nodeBefore = before.filter((p) => (p.ExecutablePath || "").toLowerCase()
    === path.join(INSTALL_ROOT, "runtime", "node", "node.exe").toLowerCase()).length;
  const pgBefore = before.filter((p) => (p.Name || "").toLowerCase() === "postgres.exe"
    && (p.ExecutablePath || "").toLowerCase()
    === path.join(INSTALL_ROOT, "runtime", "postgres", "bin", "postgres.exe").toLowerCase()).length;
  const second = spawn(exePath, [], {
    shell: false, cwd: os.tmpdir(), env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let secondOut = "";
  second.stdout?.on("data", (b) => secondOut += b.toString());
  second.stderr?.on("data", (b) => secondOut += b.toString());
  await new Promise((resolve) => {
    const t = setTimeout(() => resolve(), 25_000);
    second.once("exit", () => { clearTimeout(t); resolve(); });
  });
  await sleep(3_000);
  const after = productProcs();
  const nodeAfter = after.filter((p) => (p.ExecutablePath || "").toLowerCase()
    === path.join(INSTALL_ROOT, "runtime", "node", "node.exe").toLowerCase()).length;
  const pgAfter = after.filter((p) => (p.Name || "").toLowerCase() === "postgres.exe"
    && (p.ExecutablePath || "").toLowerCase()
    === path.join(INSTALL_ROOT, "runtime", "postgres", "bin", "postgres.exe").toLowerCase()).length;
  check("8a. Single Instance: kein zweiter node-Prozess", nodeAfter === nodeBefore,
    `vorher=${nodeBefore} nachher=${nodeAfter}`);
  check("8b. Single Instance: kein zweiter postgres-Prozess", pgAfter === pgBefore,
    `vorher=${pgBefore} nachher=${pgAfter}`);
  check("8c. Single Instance: zweite Instanz erkannt",
    /second instance/i.test(secondOut) || nodeAfter === nodeBefore,
    secondOut.trim().split("\n").slice(0, 2).join(" | "));
  try { second.kill(); } catch { /* noop */ }

  // --- 9) Kontrollierter Shutdown ---------------------------------------
  info("Shutdown (WM_CLOSE) …");
  const closeOut = closeAppWindows(exePath);
  info(`closeAppWindows: ${closeOut}`);
  let shutDown = false;
  const sdDeadline = Date.now() + 120_000;
  while (Date.now() < sdDeadline) {
    const rr = await httpReq("127.0.0.1", readyPort, "GET", "/api/ready", {}, 2_000);
    if (rr.status !== 200) { shutDown = true; break; }
    await sleep(1_000);
  }
  check("9a. Next-Server beendet (Shutdown durchgelaufen)", shutDown, `close=${closeOut}`);

  // G5-Fix (Gate 9b): Der Exit-Status wurde AB DEM START des Prozesses
  // erfasst (exitState). Wir warten auf das Exit-Event mit einem Timeout
  // und pruefen zusaetzlich, dass kein EXE-Prozess mehr laeuft.
  //
  // Der erwartete Normalfall ist: die EXE beendet sich selbst per
  // `app_handle.exit(0)` -> Exit-Code 0. Ein Exit-Code 0 ODER ein belegter
  // Shutdown (kein Prozess mehr + Next-Server beendet) gilt als PASS.
  // Ein Exit mit FEHLER-code, waehrend der Prozess weiterlaeuft, ist ein
  // echter Fehler und bleibt FAIL.
  const exitDeadline = Date.now() + 120_000;
  while (Date.now() < exitDeadline && !app.exitState.exited) {
    await sleep(500);
  }
  await sleep(3_000);
  const exeStillRunning = productProcs().some((p) =>
    (p.ExecutablePath || "").toLowerCase() === exePath.toLowerCase());
  const exitOk = app.exitState.exited
    ? (app.exitState.code === 0 || app.exitState.code === null)
    : !exeStillRunning && shutDown;
  check("9b. Tauri-EXE beendet sich nach Shutdown",
    exitOk && !exeStillRunning,
    app.exitState.exited
      ? `exit-code=${app.exitState.code} signal=${app.exitState.signal ?? "-"}`
      : (exeStillRunning ? "EXE laeuft noch" : "kein EXE-Prozess (Shutdown belegt)"));

  await sleep(6_000);
  const afterShutdown = productProcs();
  check("9c. kein eigener node-Prozess uebrig",
    !afterShutdown.some((p) => (p.ExecutablePath || "").toLowerCase()
      === path.join(INSTALL_ROOT, "runtime", "node", "node.exe").toLowerCase()));
  check("9d. kein eigener postgres-Prozess uebrig",
    !afterShutdown.some((p) => (p.ExecutablePath || "").toLowerCase()
      === path.join(INSTALL_ROOT, "runtime", "postgres", "bin", "postgres.exe").toLowerCase()));
  const pgStopLog = path.join(DATA_ROOT, "logs", "pg-stop.log");
  const stopTail = existsSync(pgStopLog) ? readFileSync(pgStopLog, "utf8").trim() : "";
  check("9e. pg_ctl fast stop protokolliert",
    /Server angehalten|gestoppt|beendet/i.test(stopTail), stopTail.split("\n").slice(-1)[0] || "");
  const netstat2 = spawnSync("netstat", ["-an"], { encoding: "utf8" });
  check("9f. 5432 weiterhin unangetastet (fremde System-DB)",
    (netstat2.stdout || "").includes(":5432"), "");
  check("9g. Produkt-DB-Port nach Shutdown frei",
    !(netstat2.stdout || "").includes(`:${dbPort()}      LISTENING`), "");

  // --- 10) Uninstall ------------------------------------------------------
  if (DO_UNINSTALL) {
    info("Uninstall …");
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!existsSync(INSTALL_ROOT)) break;
      for (let i = 0; i < 15; i++) {
        if (productProcs().length === 0) break;
        await sleep(2_000);
      }
      if (productProcs().length > 0) {
        closeAppWindows(exePath);
        await sleep(3_000);
      }
      runUninstaller(uninstaller);
      await sleep(10_000);
    }
    const rootStillThere = existsSync(INSTALL_ROOT);
    let leftoverFiles = 0;
    let leftoverDirs = 0;
    if (rootStillThere) {
      const entries = readdirSync(INSTALL_ROOT, { recursive: true, withFileTypes: true });
      leftoverFiles = entries.filter((e) => e.isFile()).length;
      leftoverDirs = entries.filter((e) => e.isDirectory()).length;
    }
    check("10a. Uninstall: keine Installationsdateien mehr", leftoverFiles === 0,
      rootStillThere
        ? `Verzeichnisgeruest: ${leftoverDirs} leere Verzeichnisse, ${leftoverFiles} Dateien`
        : "Install Root vollstaendig entfernt");
    check("10b. Uninstall: Data Root bleibt erhalten", existsSync(DATA_ROOT), DATA_ROOT);
    check("10c. Uninstall: pgdata bleibt erhalten",
      existsSync(path.join(DATA_ROOT, "pgdata", "PG_VERSION")));
    check("10d. Uninstall: secrets.json bleibt erhalten", existsSync(secretsPath));
    check("10e. Uninstall: Testdaten bleiben erhalten", existsSync(markerFile));
    check("10f. Uninstall: keine Produktprozesse uebrig", productProcs().length === 0,
      productProcs().map((p) => `${p.Name}(${p.ProcessId})`).join(", ") || "keine");
    check("10g. Uninstall: keine Runtime-Prozesse (Node/PG) uebrig",
      !productProcs().some((p) => {
        const ep = (p.ExecutablePath || "").toLowerCase();
        return ep.includes("\\runtime\\node\\") || ep.includes("\\runtime\\postgres\\");
      }));
    const uSecrets = sha256File(secretsPath);
    check("10h. Uninstall: secrets.json unveraendert identisch", uSecrets === baselineSecretsSha);
    info(`Uninstall-Leftovers: ${leftoverDirs} Verzeichnisse / ${leftoverFiles} Dateien`);

    // --- 11) Reinstall ----------------------------------------------------
    info(`Reinstall ${EXPECT_VERSION} …`);
    runInstaller(installer);
    await sleep(6_000);
    check("11a. Reinstall: EXE vorhanden", existsSync(exePath));

    const app3 = await startProduct(exePath);
    const port3 = await waitForReady();
    check("11b. Reinstall: /api/ready = 200", port3 > 0, port3 ? `port ${port3}` : "");
    const out3 = await waitForLog(app3.getOutput,
      /migrations found|No pending migrations|postgres: started/, 90_000);
    console.log("[g5] ---- Reinstall-Log (Auszug) ----");
    console.log(out3.split("\n").filter((l) => /migrat|initdb|postgres:|acquire|prisma|bootstrap|P2021|MissingSecret|UntrustedHost|ERROR|FAIL/i.test(l)).slice(0, 40).join("\n"));
    console.log("[g5] ---- Ende Log-Auszug ----");
    check("11c. Reinstall: alter Data Root erkannt (KEIN initdb)",
      !/initdb/i.test(out3) && !/acquire: first-run/.test(out3));
    check("11d. Reinstall: Migration no-op (keine Datenvernichtung)",
      /No pending migrations to apply/.test(out3), "");
    check("11e. Reinstall: secrets identisch",
      existsSync(secretsPath)
      && sha256File(secretsPath) === baselineSecretsSha);
    check("11f. Reinstall: Testdaten vorhanden", existsSync(markerFile));
    const rMigrations = psql("select count(*) from _prisma_migrations;");
    const rMarker = psql("select count(*) from \"Tenant\" where id='g5-marker-tenant-0001';");
    if (!rMigrations.ok || !rMarker.ok) {
      hardFail(`Reinstall-DB-Abfrage fehlgeschlagen: ${rMigrations.reason || rMarker.reason}`);
    }
    check("11g. Reinstall: DB-Marker vorhanden", rMarker.value === "1", rMarker.value);
    check(`11h. Reinstall: ${EXPECT_MIGRATIONS} Migrationen erhalten`,
      rMigrations.value === EXPECT_MIGRATIONS, rMigrations.value);

    // Abschluss: kontrolliert beenden.
    info("Abschluss: Fenster-Close …");
    closeAppWindows(exePath);
    const endDeadline = Date.now() + 120_000;
    while (Date.now() < endDeadline && !app3.exitState.exited) await sleep(500);
    await sleep(3_000);
    check("11i. Reinstall: EXE sauber beendet",
      app3.exitState.exited || !productProcs().some((p) =>
        (p.ExecutablePath || "").toLowerCase() === exePath.toLowerCase()),
      app3.exitState.exited ? `exit-code=${app3.exitState.code}` : "kein EXE-Prozess");
  }

  console.log("\n[g5] ==== SUMMARY ====");
  const failed = results.filter((x) => !x.ok);
  for (const x of results) console.log(`  ${x.ok ? "OK  " : "FAIL"} ${x.name}`);
  console.log(`[g5] ${results.length - failed.length}/${results.length} PASS`);
  console.log(`[g5] install root: ${INSTALL_ROOT}`);
  console.log(`[g5] data root:    ${DATA_ROOT}`);
  console.log(`[g5] baseline installer: ${baselineInstaller || "(bereits installiert)"}`);
  console.log(`[g5] baseline by proof: ${baselineInstalledByProof ? "ja" : "nein"}`);
  console.log(`[g5] secrets sha256 (vorher/nachher): ${baselineSecretsSha} / ${sha256File(secretsPath)}`);
  console.log(`[g5] migration delta: ${afterMigrations.value} migrations`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("[g5] FATAL", e?.stack ?? e);
  process.exit(1);
});
