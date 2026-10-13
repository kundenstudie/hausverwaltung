import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ authenticateBearer: vi.fn() }));
const data = vi.hoisted(() => ({
  getLeaseLegalContext: vi.fn(),
  listLeaseRentAdjustments: vi.fn(),
}));

vi.mock("@/lib/api-auth", () => ({
  authenticateBearer: auth.authenticateBearer,
  unauthorized: () =>
    new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    }),
}));

vi.mock("@/lib/api-data", () => ({
  getLeaseLegalContext: data.getLeaseLegalContext,
  listLeaseRentAdjustments: data.listLeaseRentAdjustments,
}));

import { GET as getLeaseLegal } from "@/app/api/v1/leases/[id]/route";
import { GET as getRentAdjustments } from "@/app/api/v1/leases/[id]/rent-adjustments/route";

const principal = { userId: "u1", tenantId: "tenant-A", role: "VERWALTER", name: "Admin" };

function leaseReq(id: string): Request {
  return new Request(`http://localhost/api/v1/leases/${id}`, { headers: { authorization: "Bearer test" } });
}
function adjustmentsReq(id: string, query = ""): Request {
  return new Request(`http://localhost/api/v1/leases/${id}/rent-adjustments${query}`, {
    headers: { authorization: "Bearer test" },
  });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  auth.authenticateBearer.mockReset();
  data.getLeaseLegalContext.mockReset();
  data.listLeaseRentAdjustments.mockReset();
});

describe("P4.API route GET /api/v1/leases/[id]", () => {
  it("401 without valid bearer", async () => {
    auth.authenticateBearer.mockResolvedValue(null);
    const res = await getLeaseLegal(new Request("http://localhost/api/v1/leases/lease-1"), ctx("lease-1"));
    expect(res.status).toBe(401);
    expect(data.getLeaseLegalContext).not.toHaveBeenCalled();
  });

  it("200 with the explicit DTO for an own lease", async () => {
    auth.authenticateBearer.mockResolvedValue(principal);
    data.getLeaseLegalContext.mockResolvedValue({
      leaseId: "lease-1",
      startDate: "2024-01-01",
      endDate: null,
      rentCold: 1200.5,
      noticePeriodMonths: 3,
    });
    const res = await getLeaseLegal(leaseReq("lease-1"), ctx("lease-1"));
    expect(res.status).toBe(200);
    expect(data.getLeaseLegalContext).toHaveBeenCalledWith("tenant-A", "lease-1");
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["endDate", "leaseId", "noticePeriodMonths", "rentCold", "startDate"].sort());
  });

  it("404 for unknown or foreign lease (identical semantics)", async () => {
    auth.authenticateBearer.mockResolvedValue(principal);
    data.getLeaseLegalContext.mockResolvedValue(null);
    const res = await getLeaseLegal(leaseReq("lease-B"), ctx("lease-B"));
    expect(res.status).toBe(404);
  });
});

describe("P4.API route GET /api/v1/leases/[id]/rent-adjustments", () => {
  it("401 without valid bearer", async () => {
    auth.authenticateBearer.mockResolvedValue(null);
    const res = await getRentAdjustments(new Request("http://localhost/api/v1/leases/lease-1/rent-adjustments"), ctx("lease-1"));
    expect(res.status).toBe(401);
  });

  it("400 for invalid limit (0, 201, non-numeric)", async () => {
    auth.authenticateBearer.mockResolvedValue(principal);
    for (const q of ["?limit=0", "?limit=201", "?limit=abc", "?limit=-1"]) {
      const res = await getRentAdjustments(adjustmentsReq("lease-1", q), ctx("lease-1"));
      expect(res.status, q).toBe(400);
    }
    expect(data.listLeaseRentAdjustments).not.toHaveBeenCalled();
  });

  it("defaults limit to 50 and passes limit + offset through", async () => {
    auth.authenticateBearer.mockResolvedValue(principal);
    data.listLeaseRentAdjustments.mockResolvedValue({ items: [], pagination: { count: 0, limit: 50, total: 0, offset: 0 } });
    const resDefault = await getRentAdjustments(adjustmentsReq("lease-1"), ctx("lease-1"));
    expect(resDefault.status).toBe(200);
    expect(data.listLeaseRentAdjustments).toHaveBeenLastCalledWith("tenant-A", "lease-1", 50, 0);

    data.listLeaseRentAdjustments.mockResolvedValue({ items: [], pagination: { count: 0, limit: 200, total: 0, offset: 100 } });
    const resMax = await getRentAdjustments(adjustmentsReq("lease-1", "?limit=200&offset=100"), ctx("lease-1"));
    expect(resMax.status).toBe(200);
    expect(data.listLeaseRentAdjustments).toHaveBeenLastCalledWith("tenant-A", "lease-1", 200, 100);
  });

  it("400 for invalid offset", async () => {
    auth.authenticateBearer.mockResolvedValue(principal);
    for (const q of ["?offset=-1", "?offset=abc"]) {
      const res = await getRentAdjustments(adjustmentsReq("lease-1", q), ctx("lease-1"));
      expect(res.status, q).toBe(400);
    }
    expect(data.listLeaseRentAdjustments).not.toHaveBeenCalled();
  });

  it("404 for unknown or foreign lease", async () => {
    auth.authenticateBearer.mockResolvedValue(principal);
    data.listLeaseRentAdjustments.mockResolvedValue(null);
    const res = await getRentAdjustments(adjustmentsReq("lease-B"), ctx("lease-B"));
    expect(res.status).toBe(404);
  });

  it("200 with items[] and pagination for an own lease", async () => {
    auth.authenticateBearer.mockResolvedValue(principal);
    data.listLeaseRentAdjustments.mockResolvedValue({
      items: [
        {
          id: "adj-1",
          leaseId: "lease-1",
          type: "INDEX",
          effectiveDate: "2026-01-01",
          newRentCold: 1250,
          indexBase: 100,
          indexNew: 104.2,
          applied: false,
        },
      ],
      pagination: { count: 1, limit: 50 },
    });
    const res = await getRentAdjustments(adjustmentsReq("lease-1"), ctx("lease-1"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<Record<string, unknown>> };
    expect(body.items[0]).toBeDefined();
    expect(Object.keys(body.items[0] ?? {}).sort()).toEqual(
      ["applied", "effectiveDate", "id", "indexBase", "indexNew", "leaseId", "newRentCold", "type"].sort(),
    );
  });
});
