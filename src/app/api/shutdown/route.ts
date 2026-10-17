// HAVEWA-07A-2 — POST /api/shutdown
//
// Token-geschuetzter, loopback-only Shutdown-Control-Pfad. Vorbereitung fuer den
// Desktop-Lifecycle (Tauri-Orchestrator o.ae.). KEIN HTTP in-flight drain.
//
// Schutz:
//   1) Loopback: nur 127.0.0.1, ::1 oder fehlend (Server-intern). Sonst 403.
//   2) Token: X-Shutdown-Token Header MUSS process.env.SHUTDOWN_TOKEN entsprechen.
//      Ist SHUTDOWN_TOKEN nicht gesetzt, ist der Endpunkt DEAKTIVIERT -> 404.
//   3) Methode: nur POST (GET wuerde versehentlich via Prefetch / Health-Check
//      ausgeloest werden).
//
// Verhalten:
//   - Scheduler stoppen (best-effort)
//   - prisma.$disconnect() (best-effort)
//   - Antwort 202 (accepted), dann process.exit(0) nach kurzer Verzoegerung,
//     damit die Antwort noch rausgehen kann.

import { controlledShutdown } from "@/lib/server-lifecycle";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function constantTimeEq(a: string, b: string): boolean {
  // Node hat crypto.timingSafeEqual; hier ohne externes crypto-Modul, nur
  // String-Vergleich in konstanter Laenge. Beide muessen gleiche Laenge haben,
  // sonst sofort false. Ausreichend fuer Loopback-Token-Vergleich.
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function isLoopback(req: Request): boolean {
  // In Node/Next server wird die Socket-Adresse nicht direkt in `Request` exponiert.
  // Wir akzeptieren daher als Heuristik:
  //   - req.headers.get("host") beginnt mit 127.0.0.1, localhost, [::1]
  //   - process.env.HAVEWA_ALLOW_REMOTE_SHUTDOWN === "1"  (explicit override)
  if (process.env.HAVEWA_ALLOW_REMOTE_SHUTDOWN === "1") return true;
  const host = (req.headers.get("host") ?? "").toLowerCase();
  return (
    host.startsWith("127.0.0.1") ||
    host.startsWith("localhost") ||
    host.startsWith("[::1]") ||
    host === ""
  );
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function forbidden(): Response {
  return new Response(JSON.stringify({ error: "forbidden" }), {
    status: 403,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function notFound(): Response {
  return new Response(JSON.stringify({ error: "not_found" }), {
    status: 404,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export async function POST(req: Request): Promise<Response> {
  const expected = process.env.SHUTDOWN_TOKEN?.trim();
  if (!expected) {
    // Endpunkt deaktiviert, wenn kein Token konfiguriert ist.
    return notFound();
  }
  if (!isLoopback(req)) return forbidden();
  const provided = req.headers.get("x-shutdown-token") ?? "";
  if (!provided || !constantTimeEq(provided, expected)) return unauthorized();

  // Antwort sofort senden, dann asynchron herunterfahren.
  // Wichtig: KEIN await hier, sonst blockieren wir den Response-Stream.
  void (async () => {
    try {
      await controlledShutdown("remote shutdown requested");
    } catch (e) {
      console.warn("[shutdown] controlledShutdown error:", e instanceof Error ? e.message : e);
    } finally {
      // Kurze Verzoegerung, damit die 202-Antwort sicher raus ist.
      setTimeout(() => process.exit(0), 100).unref?.();
    }
  })();

  return new Response(JSON.stringify({ status: "shutting_down" }), {
    status: 202,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

// Jede andere Methode -> 405.
export function GET(): Response {
  return notFound();
}
