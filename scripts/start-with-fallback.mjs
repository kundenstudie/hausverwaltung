// HAVEWA-07A-2 — Port-Fallback-Starter (Node, plattform-neutral).
//
// Aufruf:
//   node scripts/start-with-fallback.mjs [start-command...]
//
// Standardmaessig: `node server.js` im aktuellen Arbeitsverzeichnis
// (= .next/standalone). Wenn ein anderes Startkommando gewuenscht ist, wird
// der Rest der argv als Kommando verwendet.
//
// Verhalten:
//   - Versucht der Reihe nach 127.0.0.1:3000 .. 3005
//   - Probiert den naechsten Port nur, wenn EADDRINUSE aufgetreten ist
//     (also der Port belegt, nicht irgendein anderer Fehler)
//   - Schreibt den gewaehlten Port in <HAVEWA_DATA_DIR>/runtime-state/port.json
//     (Fallback: ./.runtime-state/port.json), wenn HAVEWA_DATA_DIR gesetzt ist
//   - Signal-Forwarding: SIGINT/SIGTERM werden an den Kind-Prozess weitergereicht
//   - Auf exit des Kind-Prozesses: selber mit dessen Exitcode beenden
//
// Kein 0.0.0.0-Binding, kein Netzwerk-Discovery. Strikt loopback.

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const HOST = "127.0.0.1";
const PORTS = [3000, 3001, 3002, 3003, 3004, 3005];
const START_CMD = process.argv.slice(2);
const DEFAULT_CMD = ["node", "server.js"];

function fail(msg, code = 1) {
  process.stderr.write(`[start] FAIL: ${msg}\n`);
  process.exit(code);
}

function info(msg) {
  process.stdout.write(`[start] ${msg}\n`);
}

function probe(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(port, HOST);
  });
}

async function pickPort() {
  for (const p of PORTS) {
    if (await probe(p)) return p;
    info(`Port ${p} belegt, versuche naechsten …`);
  }
  fail(`Kein freier Port in [${PORTS.join(", ")}] auf ${HOST}.`);
}

async function writeRuntimeState(port) {
  const dataDir = process.env.HAVEWA_DATA_DIR || "";
  const dir = dataDir
    ? path.join(dataDir, "runtime-state")
    : path.join(process.cwd(), ".runtime-state");
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "port.json"),
      JSON.stringify({ host: HOST, port, startedAt: new Date().toISOString() }, null, 2),
      "utf8",
    );
  } catch (e) {
    info(`Hinweis: runtime-state konnte nicht geschrieben werden: ${e?.message || e}`);
  }
}

async function main() {
  info(`node ${process.version} ${process.platform}/${process.arch}`);
  const port = await pickPort();
  info(`gewahlt: ${HOST}:${port}`);
  await writeRuntimeState(port);

  const cmd = START_CMD.length ? START_CMD : DEFAULT_CMD;
  const exe = cmd[0];
  const args = cmd.slice(1);
  info(`starte: ${exe} ${args.join(" ")} (PORT=${port} HOSTNAME=${HOST})`);

  const child = spawn(exe, args, {
    stdio: "inherit",
    env: { ...process.env, PORT: String(port), HOSTNAME: HOST },
    shell: false,
  });

  const forward = (sig) => {
    try { child.kill(sig); } catch { /* ignore */ }
  };
  process.on("SIGINT", () => forward("SIGINT"));
  process.on("SIGTERM", () => forward("SIGTERM"));
  process.on("SIGHUP", () => forward("SIGHUP"));

  const code = await new Promise((resolve) => {
    child.on("exit", (c, signal) => {
      // Konsistent mit Node-Konventionen: signal -> 128 + n
      resolve(signal ? 128 + (typeof signal === "string" ? 15 : signal) : (c ?? 1));
    });
  });
  process.exit(code);
}

// Wenn dieses Skript direkt aufgerufen wird, main() ausfuehren.
// Beim Import (z. B. von Tests) nur die Helfer exportieren.
// Korrekt plattformübergreifend: argv[1] hat Windows-Backslashes,
// import.meta.url hat Forward-Slashes — daher pathToFileURL().
function isEntryPoint() {
  try {
    if (!process.argv[1]) return false;
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
}
if (isEntryPoint()) {
  main().catch((e) => fail(e?.stack || String(e)));
}

export { probe, pickPort, HOST, PORTS };
