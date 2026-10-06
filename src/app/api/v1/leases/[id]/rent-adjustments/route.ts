import { authenticateBearer, unauthorized } from "@/lib/api-auth";
import { listLeaseRentAdjustments } from "@/lib/api-data";

// PropertyAI (Stufe 3, D-0038): mandanten-gescopte RentAdjustment-Historie.
// Fremder/unbekannter Lease -> 404. limit: Default 50, min 1, max 200.

const DEFAULT_LIMIT = 50;
const MIN_LIMIT = 1;
const MAX_LIMIT = 200;

function parseLimit(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return DEFAULT_LIMIT;
  if (!/^[0-9]+$/.test(raw.trim())) return null;
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isSafeInteger(n) || n < MIN_LIMIT || n > MAX_LIMIT) return null;
  return n;
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const p = await authenticateBearer(req);
  if (!p) return unauthorized();
  const { id } = await params;
  const limit = parseLimit(new URL(req.url).searchParams.get("limit"));
  if (limit === null) return Response.json({ error: "Invalid limit" }, { status: 400 });
  const dto = await listLeaseRentAdjustments(p.tenantId, id, limit);
  if (!dto) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(dto);
}
