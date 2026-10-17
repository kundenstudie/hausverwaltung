// HAVEWA-07A-2 — GET /api/ready
//
// Readiness-Probe: SELECT 1 gegen die Prisma-DB. Erfolg -> 200, DB-Fehler -> 503.
// Im Fehlerfall werden ABSICHTLICH keine DB-Details (Host, User, Fehlermeldung)
// zurueckgegeben, nur ein generischer Status. Loopback-only Pflicht (nicht ueber
// die Authentifizierung abgesichert, aber im Container nur an 127.0.0.1 gebunden).

import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEADERS = { "Cache-Control": "no-store" } as const;

export async function GET(): Promise<Response> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return Response.json({ status: "ready" }, { status: 200, headers: HEADERS });
  } catch {
    // Bewusst generisch: keine DB-Details, keine Fehlermeldung.
    return Response.json({ status: "not_ready" }, { status: 503, headers: HEADERS });
  }
}
