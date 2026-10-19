// HAVEWA-07B — Ownership / Process-Identity / Stale-State.
//
// Regeln (Auftrag §8, §14):
//   - Wir killen NIEMALS einen postgres.exe-Prozess, der nicht unsere
//     eigene Aufzeichnung trägt.
//   - Portbelegung allein reicht NICHT — wir verifizieren über PID +
//     pgdata + postmaster.pid.
//   - Stale Runtime-State wird sauber erkannt und bereinigt.
//
// Reines ESM (.mjs). Bewusst ohne nativen psutil-/wmic-Call, weil der
// reine `process.kill(pid, 0)` (Node-Way) für unsere Zwecke reicht:
// - Existiert die PID nicht -> ESRCH
// - Gehört uns nicht mehr -> anders begründet (pgdata-Mismatch)
//
// In Tests wird `isPidRunning` über einen injizierten Check ersetzt.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Parst den Inhalt einer postmaster.pid-Datei.
 *
 * Format (siehe Postgres-Doku):
 *   line 1: PID
 *   line 2: data directory (kann leer sein)
 *   line 3: ...
 *   line 4: port (kann leer sein, dann -1 oder leer)
 *
 * Wir sind hier strikt defensiv: alles, was nicht passt, ist null.
 */
export function parsePostmasterPid(content) {
  if (typeof content !== "string") return null;
  const lines = content.split(/\r?\n/);
  const pidRaw = lines[0];
  const pid = Number.parseInt(pidRaw, 10);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  const dataDirLine = (lines[1] || "").trim();
  const portRaw = (lines[3] || "").trim();
  const port = portRaw.length > 0 ? Number.parseInt(portRaw, 10) : undefined;
  return {
    pid,
    dataDirLine: dataDirLine || undefined,
    portLine: Number.isFinite(port) ? port : undefined,
    rawLines: lines,
  };
}

/** Plattform-neutraler Check, ob die PID existiert. Default: process.kill(pid, 0). */
export function defaultIsPidRunning(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH: nicht vorhanden. EPERM: existiert, aber uns verboten
    // (Linux/Mac). Auf Windows kennen wir nur ESRCH/EACCES.
    if (e && (e.code === "EPERM" || e.code === "EACCES")) return true;
    return false;
  }
}

/**
 * Verifiziert, ob ein laufender PID wirklich unsere eigene Instanz ist.
 *
 * Verdict-Logik (siehe Auftrag §8 + §14):
 *   - postmaster.pid fehlt komplett -> "own-stale" (Daten gehören uns,
 *     aber kein PostgreSQL-Prozess mehr da)
 *   - PID im System nicht erreichbar -> "own-stale"
 *   - PID erreichbar, aber stimmt nicht mit unserer Aufzeichnung überein
 *     ODER postmaster.pid.dataDirLine stimmt nicht -> "foreign-pid"
 *   - Alles passt -> "own-running"
 */
export function verifyOwnInstance(input) {
  const { record, currentPid, postmasterPid } = input;

  // 1) postmaster.pid fehlt — sicherer Fail-Closed:
  //    Wenn unsere postmaster.pid fehlt, ist die Instanz NICHT mehr
  //    unsere eigene (jede Postgres-Instanz schreibt postmaster.pid
  //    sofort beim Start). Ein laufender PID ohne postmaster.pid
  //    ist per Definition FREMDE.
  if (!postmasterPid) {
    if (currentPid !== null) {
      return {
        kind: "foreign-pid",
        reason: "postmaster.pid fehlt, aber PID läuft noch (fremde Instanz)",
      };
    }
    return { kind: "own-stale", reason: "postmaster.pid fehlt und kein PID erreichbar" };
  }

  // 2) PID aus postmaster.pid passt nicht zu unserer Aufzeichnung
  if (postmasterPid.pid !== record.pid) {
    return {
      kind: "foreign-pid",
      reason: `postmaster.pid.pid (${postmasterPid.pid}) ≠ record.pid (${record.pid})`,
    };
  }

  // 3) PID existiert im System?
  if (!currentPid) {
    return { kind: "own-stale", reason: "PID aus postmaster.pid läuft nicht mehr" };
  }

  // 4) Data-Directory aus postmaster.pid muss zu unserem pgdata passen
  if (postmasterPid.dataDirLine) {
    const norm = (s) => path.resolve(String(s)).toLowerCase();
    const recPg = norm(record.pgdata);
    const pmPg = norm(postmasterPid.dataDirLine);
    if (recPg !== pmPg) {
      return {
        kind: "foreign-pid",
        reason: `postmaster.pid.dataDir (${pmPg}) ≠ record.pgdata (${recPg})`,
      };
    }
  }

  // 5) Port stimmt (wenn überhaupt gesetzt)
  if (Number.isFinite(postmasterPid.portLine) && postmasterPid.portLine !== record.port) {
    return {
      kind: "foreign-pid",
      reason: `postmaster.pid.port (${postmasterPid.portLine}) ≠ record.port (${record.port})`,
    };
  }

  return { kind: "own-running", runtimeId: record.runtimeId };
}

/**
 * Convenience-Wrapper: prüft eine Aufzeichnung gegen das aktuelle
 * System. `isPidRunning` kann für Tests injiziert werden.
 */
export function verifyOwnInstanceFromFilesystem({
  pgdata,
  record,
  isPidRunning = defaultIsPidRunning,
}) {
  const pmFile = path.join(pgdata, "postmaster.pid");
  let postmasterPid = null;
  if (existsSync(pmFile)) {
    try {
      postmasterPid = parsePostmasterPid(readFileSync(pmFile, "utf8"));
    } catch {
      postmasterPid = null;
    }
  }
  const currentPid = isPidRunning(record.pid) ? record.pid : null;
  return verifyOwnInstance({ record, currentPid, postmasterPid });
}

/** Re-export für Tests (defaultPid-Probe). */
export const __isPidRunning = defaultIsPidRunning;