import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  leaseFindFirst: vi.fn(),
  rentAdjustmentFindMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    lease: { findFirst: mocks.leaseFindFirst },
    rentAdjustment: { findMany: mocks.rentAdjustmentFindMany },
  },
}));

import { getLeaseLegalContext, listLeaseRentAdjustments } from "@/lib/api-data";

beforeEach(() => {
  mocks.leaseFindFirst.mockReset();
  mocks.rentAdjustmentFindMany.mockReset();
});

describe("P4.API getLeaseLegalContext (data layer, tenant-scoped)", () => {
  it("queries by id AND tenantId with an allow-listed select", async () => {
    mocks.leaseFindFirst.mockResolvedValue({
      id: "lease-1",
      startDate: new Date("2024-01-01T00:00:00.000Z"),
      endDate: null,
      rentCold: 1200.5,
      noticePeriodM: 3,
    });
    const dto = await getLeaseLegalContext("tenant-A", "lease-1");
    expect(mocks.leaseFindFirst).toHaveBeenCalledWith({
      where: { id: "lease-1", tenantId: "tenant-A" },
      select: { id: true, startDate: true, endDate: true, rentCold: true, noticePeriodM: true },
    });
    const select = (mocks.leaseFindFirst.mock.calls[0][0] as { select: Record<string, unknown> }).select;
    expect(select).not.toHaveProperty("custom");
    expect(select).not.toHaveProperty("tenantId");
    expect(dto).toEqual({
      leaseId: "lease-1",
      startDate: "2024-01-01",
      endDate: null,
      rentCold: 1200.5,
      noticePeriodMonths: 3,
    });
  });

  it("returns null (=> 404) for an unknown or foreign lease", async () => {
    mocks.leaseFindFirst.mockResolvedValue(null);
    expect(await getLeaseLegalContext("tenant-A", "lease-B")).toBeNull();
    // The lookup is still tenant-scoped (no global id lookup first).
    expect(mocks.leaseFindFirst).toHaveBeenCalledWith({
      where: { id: "lease-B", tenantId: "tenant-A" },
      select: { id: true, startDate: true, endDate: true, rentCold: true, noticePeriodM: true },
    });
  });
});

describe("P4.API listLeaseRentAdjustments (data layer, tenant-scoped, defense in depth)", () => {
  it("returns null and never queries adjustments for a foreign/unknown lease", async () => {
    mocks.leaseFindFirst.mockResolvedValue(null);
    const result = await listLeaseRentAdjustments("tenant-A", "lease-B", 50);
    expect(result).toBeNull();
    expect(mocks.rentAdjustmentFindMany).not.toHaveBeenCalled();
  });

  it("queries adjustments by leaseId AND tenantId with deterministic order and no note select", async () => {
    mocks.leaseFindFirst.mockResolvedValue({ id: "lease-1" });
    mocks.rentAdjustmentFindMany.mockResolvedValue([
      {
        id: "adj-1",
        leaseId: "lease-1",
        type: "INDEX",
        effectiveDate: new Date("2026-01-01T00:00:00.000Z"),
        newRentCold: 1250.0,
        indexBase: 100.0,
        indexNew: 104.2,
        applied: false,
      },
    ]);
    const result = await listLeaseRentAdjustments("tenant-A", "lease-1", 50);

    expect(mocks.rentAdjustmentFindMany).toHaveBeenCalledWith({
      where: { leaseId: "lease-1", tenantId: "tenant-A" },
      orderBy: [{ effectiveDate: "desc" }, { id: "asc" }],
      take: 50,
      select: {
        id: true,
        leaseId: true,
        type: true,
        effectiveDate: true,
        newRentCold: true,
        indexBase: true,
        indexNew: true,
        applied: true,
      },
    });
    const select = (mocks.rentAdjustmentFindMany.mock.calls[0][0] as { select: Record<string, unknown> }).select;
    expect(select).not.toHaveProperty("note");
    expect(select).not.toHaveProperty("tenantId");

    expect(result).toEqual({
      items: [
        {
          id: "adj-1",
          leaseId: "lease-1",
          type: "INDEX",
          effectiveDate: "2026-01-01",
          newRentCold: 1250.0,
          indexBase: 100.0,
          indexNew: 104.2,
          applied: false,
        },
      ],
      pagination: { count: 1, limit: 50 },
    });
  });

  it("returns an empty list for a lease with no history", async () => {
    mocks.leaseFindFirst.mockResolvedValue({ id: "lease-1" });
    mocks.rentAdjustmentFindMany.mockResolvedValue([]);
    const result = await listLeaseRentAdjustments("tenant-A", "lease-1", 50);
    expect(result).toEqual({ items: [], pagination: { count: 0, limit: 50 } });
  });

  it("passes the exact limit through to the query", async () => {
    mocks.leaseFindFirst.mockResolvedValue({ id: "lease-1" });
    mocks.rentAdjustmentFindMany.mockResolvedValue([]);
    await listLeaseRentAdjustments("tenant-A", "lease-1", 1);
    expect((mocks.rentAdjustmentFindMany.mock.calls[0][0] as { take: number }).take).toBe(1);
  });
});
