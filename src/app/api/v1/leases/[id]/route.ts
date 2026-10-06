import { authenticateBearer, unauthorized } from "@/lib/api-auth";
import { getLeaseLegalContext } from "@/lib/api-data";

// PropertyAI (Stufe 3, D-0038): mandanten-gescopter Lease-Legal-Read.
// Fremder/unbekannter Lease -> 404 (identisch zu "nicht vorhanden", kein Tenant-Leak).
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const p = await authenticateBearer(req);
  if (!p) return unauthorized();
  const { id } = await params;
  const dto = await getLeaseLegalContext(p.tenantId, id);
  if (!dto) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(dto);
}
