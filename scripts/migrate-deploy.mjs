// HAVEWA-07A-2 — Produktiver Migration-Runner fuer die Standalone-Runtime.
//
// Erwartet, dass `scripts/package-runtime.mjs` bereits gelaufen ist und
// der Prisma-CLI-Tree unter scripts/.runtime/prisma-cli/ liegt.
//
// Aufruf:
//   DATABASE_URL=postgresql://... node scripts/migrate-deploy.mjs
//
// Optional:
//   HAVEWA_RUNTIME_PRISMA_DIR  -- Override-Pfad zum Prisma-Tree
//                                  (Default: scripts/.runtime/prisma-cli)
//   HAVEWA_RUNTIME_TIMEOUT_MS  -- Timeout in ms (Default 5 min)
//
//   node scripts/migrate-deploy.mjs --schema /abs/path/to/schema.prisma
//     (Override fuer den Schema-Pfad innerhalb des Trees)
//
// Eigenschaften:
//   - KEIN Shell-Quoting, spawn() direkt
//   - KEIN Netzwerk
//   - DATABASE_URL ist PFLICHT
//   - non-zero Exit-Code bei Fehler
//   - stdout/stderr durchgereicht (live, an den Parent-Prozess)
//   - Timeout konfigurierbar
//   - 5432 (Dev-DB) wird nicht hart kodiert; DATABASE_URL muss gesetzt sein

import path from "node:path";
import process from "node:process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runPrismaCli } from "./prisma-runtime-tree.mjs";

function fail(msg, code = 1) {
  process.stderr.write(`[migrate-deploy] FAIL: ${msg}\n`);
  process.exit(code);
}

/**
 * Sicherer DB-Target-Label: nur host:port, KEIN Username, KEIN Passwort,
 * KEIN DSN. Einzige Quelle der Wahrheit fuer das Logging in main() und
 * runMigrateDeploy(), damit die beiden Pfade nicht auseinanderlaufen
 * (Review-Fix M1, 07A-2).
 */
export function dbTargetLabel(dbUrl) {
  const m = dbUrl?.match(/^postgresql:\/\/[^@]+@([^:/]+)(?::(\d+))?\//);
  return m ? `${m[1]}:${m[2] || "5432"}` : "(url ok)";
}

function parseArgs(argv) {
  const out = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--schema") { out.schema = argv[++i]; continue; }
    if (a.startsWith("--schema=")) { out.schema = a.slice("--schema=".length); continue; }
    if (a === "--timeout-ms") { out.timeoutMs = parseInt(argv[++i], 10); continue; }
    if (a === "--help" || a === "-h") { out.help = true; continue; }
    out.positional.push(a);
  }
  return out;
}

function help() {
  process.stdout.write(
    [
      "Usage: node scripts/migrate-deploy.mjs [options]",
      "",
      "Options:",
      "  --schema <path>      Override-Schema-Pfad (innerhalb des Trees)",
      "  --timeout-ms <ms>    Timeout in Millisekunden (Default 300000)",
      "  -h, --help           Diese Hilfe",
      "",
      "Environment:",
      "  DATABASE_URL              PFLICHT: Postgres-URL",
      "  HAVEWA_RUNTIME_PRISMA_DIR Override-Pfad (Default: scripts/.runtime/prisma-cli)",
      "",
    ].join("\n") + "\n",
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { help(); return; }

  // DATABASE_URL PFLICHT
  const dbUrl = process.env.DATABASE_URL?.trim();
  if (!dbUrl) fail("DATABASE_URL nicht gesetzt (Pflicht).");

  // Default-Tree-Pfad: relativ zum migrate-deploy.mjs-Skript selbst
  // (nicht zu process.cwd()), damit das Skript auch als Subprocess
  // aus einem anderen Arbeitsverzeichnis funktioniert.
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const treeDir = process.env.HAVEWA_RUNTIME_PRISMA_DIR?.trim()
    || path.resolve(scriptDir, ".runtime", "prisma-cli");

  if (!existsSync(treeDir)) {
    fail(`Prisma-Runtime-Tree fehlt: ${treeDir}. Bitte zuerst 'node scripts/package-runtime.mjs' ausfuehren.`);
  }
  const cliPath = path.join(treeDir, "node_modules", "prisma", "build", "index.js");
  if (!existsSync(cliPath)) {
    fail(`Prisma-CLI fehlt im Tree: ${cliPath}. Tree ist unvollstaendig.`);
  }

  // Schema-Override
  const schemaPath = args.schema
    ? path.resolve(args.schema)
    : path.join(treeDir, "prisma", "schema.prisma");
  if (!existsSync(schemaPath)) {
    fail(`Schema-Datei fehlt: ${schemaPath}`);
  }

  process.stdout.write(`[migrate-deploy] tree:  ${treeDir}\n`);
  process.stdout.write(`[migrate-deploy] schema: ${schemaPath}\n`);
  // DB-URL nur als Host/Port loggen — keine Credentials, keine User-Namen
  // (Review-Fix M1, 07A-2). Quelle: dbTargetLabel().
  process.stdout.write(`[migrate-deploy] db:    ${dbTargetLabel(dbUrl)}\n`);

  // Optional: vorher prisma generate (idempotent, schnell), damit der
  // Client zur mitgebrachten CLI passt. Prisma-CLI macht das in `migrate
  // deploy` zwar on-demand, aber expliziter Aufruf macht Logs klarer.
  const timeoutMs = args.timeoutMs
    || (process.env.HAVEWA_RUNTIME_TIMEOUT_MS ? parseInt(process.env.HAVEWA_RUNTIME_TIMEOUT_MS, 10) : 300_000);

  try {
    process.stdout.write("[migrate-deploy] prisma generate (lokal im Tree) …\n");
    await runPrismaCli(treeDir, ["generate", "--schema", schemaPath], {
      env: { DATABASE_URL: dbUrl },
      inheritStdout: true,
      inheritStderr: true,
      timeoutMs,
    });
  } catch (e) {
    process.stderr.write(`[migrate-deploy] prisma generate fehlgeschlagen: ${e?.message || e}\n`);
    process.exit(1);
  }

  try {
    process.stdout.write("[migrate-deploy] prisma migrate deploy (offline) …\n");
    await runPrismaCli(treeDir, ["migrate", "deploy", "--schema", schemaPath], {
      env: { DATABASE_URL: dbUrl },
      inheritStdout: true,
      inheritStderr: true,
      timeoutMs,
    });
  } catch (e) {
    process.stderr.write(`[migrate-deploy] migrate deploy fehlgeschlagen: ${e?.message || e}\n`);
    process.exit(1);
  }

  process.stdout.write("[migrate-deploy] OK\n");
}

/**
 * Testbare Variante: uebergeb dbUrl, treeDir, schemaPath explizit.
 * Liefert { generate, deploy } Ergebnisse. Wirft bei Fehler.
 */
export async function runMigrateDeploy({
  dbUrl,
  treeDir,
  schemaPath,
  timeoutMs = 300_000,
  runner = runPrismaCli,
  logger,
} = {}) {
  const safeLog = logger ?? { log: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) };
  if (!dbUrl) throw new Error("DATABASE_URL nicht gesetzt (Pflicht).");
  if (!treeDir) throw new Error("treeDir nicht gesetzt.");
  if (!schemaPath) throw new Error("schemaPath nicht gesetzt.");

  safeLog.log(`[migrate-deploy] tree:  ${treeDir}\n`);
  safeLog.log(`[migrate-deploy] schema: ${schemaPath}\n`);
  // DB-URL nur als Host/Port loggen — keine Credentials, kein User-Name.
  // Gemeinsame Quelle: dbTargetLabel() (Review-Fix M1, 07A-2).
  safeLog.log(`[migrate-deploy] db:    ${dbTargetLabel(dbUrl)}\n`);

  safeLog.log("[migrate-deploy] prisma generate (lokal im Tree) …\n");
  await runner(treeDir, ["generate", "--schema", schemaPath], {
    env: { DATABASE_URL: dbUrl },
    inheritStdout: false,
    inheritStderr: false,
    timeoutMs,
  });

  safeLog.log("[migrate-deploy] prisma migrate deploy (offline) …\n");
  await runner(treeDir, ["migrate", "deploy", "--schema", schemaPath], {
    env: { DATABASE_URL: dbUrl },
    inheritStdout: false,
    inheritStderr: false,
    timeoutMs,
  });
  safeLog.log("[migrate-deploy] OK\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => fail(e?.stack || String(e)));
}
