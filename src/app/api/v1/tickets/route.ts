import { authenticateBearer, unauthorized } from "@/lib/api-auth";
import { listTickets, createTicket, LIST_CONFIG } from "@/lib/api-data";
import { listRoute } from "@/lib/api-list";

export const GET = listRoute(listTickets, LIST_CONFIG.tickets);

export async function POST(req: Request) {
  const p = await authenticateBearer(req);
  if (!p) return unauthorized();
  const body = await req.json().catch(() => null);
  if (!body?.title) return Response.json({ error: "title erforderlich" }, { status: 400 });
  return Response.json(await createTicket(p.tenantId, body), { status: 201 });
}
