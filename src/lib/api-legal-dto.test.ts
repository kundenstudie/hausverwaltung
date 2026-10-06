import { describe, expect, it } from "vitest";
import {
  compareRentAdjustmentsNewestFirst,
  toLeaseLegalContextDto,
  toRentAdjustmentListDto,
  toRentAdjustmentReadDto,
  type LeaseLegalContextRow,
  type RentAdjustmentReadDto,
  type RentAdjustmentRow,
} from "@/lib/api-legal-dto";

const leaseRow = (overrides: Partial<LeaseLegalContextRow> = {}): LeaseLegalContextRow => ({
  id: "lease-1",
  startDate: new Date("2024-01-01T00:00:00.000Z"),
  endDate: null,
  rentCold: 1200.5,
  noticePeriodM: 3,
  ...overrides,
});

const adjRow = (overrides: Partial<RentAdjustmentRow> = {}): RentAdjustmentRow => ({
  id: "adj-1",
  leaseId: "lease-1",
  type: "INDEX",
  effectiveDate: new Date("2026-01-01T00:00:00.000Z"),
  newRentCold: 1250.0,
  indexBase: 100.0,
  indexNew: 104.2,
  applied: false,
  ...overrides,
});

describe("P4.API LeaseLegalContextDto", () => {
  it("maps exactly the allow-listed keys (no tenantId/custom/note/PII)", () => {
    const dto = toLeaseLegalContextDto(leaseRow());
    expect(Object.keys(dto).sort()).toEqual(
      ["endDate", "leaseId", "noticePeriodMonths", "rentCold", "startDate"].sort(),
    );
    expect(dto.leaseId).toBe("lease-1");
    expect(dto.startDate).toBe("2024-01-01");
    expect(dto.endDate).toBeNull();
    expect(dto.rentCold).toBe(1200.5);
    expect(dto.noticePeriodMonths).toBe(3);
  });

  it("ignores custom/tenantId/person data even if present on the row", () => {
    const poisoned = {
      ...leaseRow(),
      tenantId: "tenant-secret",
      custom: { tenantEmail: "max@example.com", bankAccount: "DE00", secret: "s3cr3t", index_reference_date: "2020-01-01" },
      renters: [{ firstName: "Max", lastName: "Mustermann" }],
    } as unknown as LeaseLegalContextRow;
    const dto = toLeaseLegalContextDto(poisoned);
    const serialized = JSON.stringify(dto);
    expect(serialized).not.toContain("tenant-secret");
    expect(serialized).not.toContain("max@example.com");
    expect(serialized).not.toContain("Mustermann");
    expect(serialized).not.toContain("s3cr3t");
    expect(serialized).not.toContain("custom");
    expect(dto).not.toHaveProperty("custom");
    expect(dto).not.toHaveProperty("tenantId");
  });

  it("handles null noticePeriodMonths and Date->ISO date", () => {
    const dto = toLeaseLegalContextDto(
      leaseRow({ noticePeriodM: null, endDate: new Date("2025-06-30T00:00:00.000Z"), rentCold: "999.99" }),
    );
    expect(dto.noticePeriodMonths).toBeNull();
    expect(dto.endDate).toBe("2025-06-30");
    expect(dto.rentCold).toBe(999.99);
  });
});

describe("P4.API RentAdjustmentReadDto", () => {
  it("maps exactly the allow-listed keys (no note/tenantId/oldRentCold)", () => {
    const dto = toRentAdjustmentReadDto(adjRow());
    expect(Object.keys(dto).sort()).toEqual(
      ["applied", "effectiveDate", "id", "indexBase", "indexNew", "leaseId", "newRentCold", "type"].sort(),
    );
    expect(dto).not.toHaveProperty("note");
    expect(dto).not.toHaveProperty("tenantId");
    expect(dto).not.toHaveProperty("oldRentCold");
    expect(dto).not.toHaveProperty("createdAt");
  });

  it("never leaks a note/tenantId present on the row", () => {
    const poisoned = {
      ...adjRow(),
      tenantId: "tenant-secret",
      note: "Sensitive tenant information",
    } as unknown as RentAdjustmentRow;
    const dto = toRentAdjustmentReadDto(poisoned);
    const serialized = JSON.stringify(dto);
    expect(serialized).not.toContain("Sensitive tenant information");
    expect(serialized).not.toContain("tenant-secret");
    expect(serialized).not.toContain("note");
  });

  it("keeps indexBase/indexNew nullable and applied boolean", () => {
    const staffel = toRentAdjustmentReadDto(adjRow({ type: "STAFFEL", indexBase: null, indexNew: null, applied: true }));
    expect(staffel.type).toBe("STAFFEL");
    expect(staffel.indexBase).toBeNull();
    expect(staffel.indexNew).toBeNull();
    expect(staffel.applied).toBe(true);
    const falsy = toRentAdjustmentReadDto({ ...adjRow(), applied: 0 as unknown as boolean });
    expect(falsy.applied).toBe(false);
  });
});

describe("P4.API rent adjustment list + ordering", () => {
  it("sorts effectiveDate DESC, then id ASC (deterministic)", () => {
    const older = toRentAdjustmentReadDto(adjRow({ id: "b", effectiveDate: new Date("2024-01-01T00:00:00.000Z") }));
    const newer = toRentAdjustmentReadDto(adjRow({ id: "a", effectiveDate: new Date("2026-01-01T00:00:00.000Z") }));
    const list = [older, newer].sort(compareRentAdjustmentsNewestFirst);
    expect(list.map((x) => x.id)).toEqual(["a", "b"]);

    const sameDateA = toRentAdjustmentReadDto(adjRow({ id: "a", effectiveDate: new Date("2026-01-01T00:00:00.000Z") }));
    const sameDateB = toRentAdjustmentReadDto(adjRow({ id: "b", effectiveDate: new Date("2026-01-01T00:00:00.000Z") }));
    const tie = [sameDateB, sameDateA].sort(compareRentAdjustmentsNewestFirst);
    expect(tie.map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("wraps rows with pagination count/limit and applies ordering", () => {
    const rows: RentAdjustmentRow[] = [
      adjRow({ id: "a", effectiveDate: new Date("2024-01-01T00:00:00.000Z") }),
      adjRow({ id: "b", effectiveDate: new Date("2026-01-01T00:00:00.000Z") }),
    ];
    const dto = toRentAdjustmentListDto(rows, 50);
    expect(dto.pagination).toEqual({ count: 2, limit: 50 });
    expect(dto.items.map((x) => x.id)).toEqual(["b", "a"]);
    expect(Object.keys(dto).sort()).toEqual(["items", "pagination"]);
  });

  it("returns an empty list for no history", () => {
    const dto = toRentAdjustmentListDto([], 50);
    expect(dto.items).toEqual([]);
    expect(dto.pagination).toEqual({ count: 0, limit: 50 });
  });
});

// Reference type to ensure the DTO shape stays stable.
const _typecheck: RentAdjustmentReadDto | null = null;
void _typecheck;
