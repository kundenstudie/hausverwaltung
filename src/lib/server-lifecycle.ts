// HAVEWA-07A-2 — Server-Lifecycle (Scheduler-Stop, Prisma-Disconnect).
//
// Vorbereitung fuer Desktop-Lifecycle. NICHT fuer HTTP in-flight drain
// beworben — der ueberwiegende Teil der Requests ist in <1s durch, aber
// es wird kein Drain-Garantie-Versprechen gegeben.
//
// Bestehende Scheduler (Bank / Inbound) wurden unveraendert gelassen —
// ihre Timer beenden sich beim Prozess-Exit ohnehin. Hier nur ein
// expliziter Stop, falls spaeter aus dem Shutdown-Endpunkt heraus ein
// kontrollierter Shutdown noetig wird.

import { prisma } from "@/lib/prisma";

type Timer = ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>;

// globalThis-Keys aus den existierenden Schedulern — absichtlich gleich, damit
// sie auch dann aufgeloest werden, wenn die Scheduler selbst nicht importiert
// sind (Standalone-Boot mit HAVEWA_DISABLE_SCHEDULER=1).
const GLOBAL_KEYS = {
  bankTimer: "__havewaBankTimer",
  inboundTimer: "__havewaInboundTimer",
} as const;

/** Stoppt die registrierten Hintergrund-Scheduler (best-effort). */
export function stopSchedulers(): { stopped: string[] } {
  const g = globalThis as unknown as Record<string, Timer | undefined>;
  const stopped: string[] = [];
  for (const [label, key] of Object.entries(GLOBAL_KEYS)) {
    const t = g[key];
    if (t) {
      try {
        clearInterval(t as Timer);
        stopped.push(label);
      } catch { /* ignore */ }
      g[key] = undefined;
    }
  }
  return { stopped };
}

/** Disconnect vom Prisma-Client (idempotent, swallow von Folgefehlern). */
export async function disconnectPrisma(): Promise<void> {
  try {
    await prisma.$disconnect();
  } catch { /* ignore */ }
}

/** Vollstaendiger kontrollierter Shutdown: Scheduler stoppen, Prisma trennen,
 *  Exitcode setzen. Im Shutdown-Endpoint typischerweise gefolgt von process.exit(0). */
export async function controlledShutdown(reason: string): Promise<{ stopped: string[] }> {
  console.log(`[shutdown] ${reason}`);
  const { stopped } = stopSchedulers();
  await disconnectPrisma();
  return { stopped };
}
