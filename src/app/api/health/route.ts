// HAVEWA-07A-2 — GET /api/health
//
// Liveness-Probe: reine "der Prozess antwortet"-Antwort. KEIN DB-Zugriff,
// KEINE Auth, KEINE sensitiven Daten. Antwort ist bewusst klein und
// deterministisch. Lokal oeffentlich zulaessig (loopback erwartet im Prod-Setup).

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(): Response {
  return Response.json(
    { status: "ok" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
