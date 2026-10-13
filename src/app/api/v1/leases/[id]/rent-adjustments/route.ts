import { authenticateBearer, unauthorized } from "@/lib/api-auth";
import { listLeaseRentAdjustments } from "@/lib/api-data";

// PropertyAI (Stufe 3, D-0038): mandanten-gescopte RentAdjustment-Historie.
// Fremder/unbekannter Lease -> 404. limit: Default 50, min 1, max 200.
// HAVEWA-04 (MRC-04): `offset` erlaubt das vollständige, deterministische
// Iterieren; `pagination.total` liefert die Gesamtzahl.

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

function parseOffset(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return 0;
  if (!/^[0-9]+$/.test(raw.trim())) return null;
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isSafeInteger(n) || n < 0) return null;
  return n;
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const p = await authenticateBearer(req);
  if (!p) return unauthorized();
  const { id } = await params;
  const sp = new URL(req.url).searchParams;
  const limit = parseLimit(sp.get("limit"));
  const offset = parseOffset(sp.get("offset"));
  if (limit === null || offset === null) return Response.json({ error: "Invalid limit or offset" }, { status: 400 });
  const dto = await listLeaseRentAdjustments(p.tenantId, id, limit, offset);
  if (!dto) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(dto);
}
