import { describe, expect, it } from "vitest";
import {
  parseListQuery,
  paginationMeta,
  buildWhere,
  buildOrderBy,
  ListQueryError,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  type ListConfig,
} from "@/lib/api-list";

const config: ListConfig = {
  filters: {
    status: { kind: "enum", values: ["OFFEN", "ERLEDIGT"] },
    propertyId: { kind: "id" },
    done: { kind: "boolean" },
    year: { kind: "int" },
  },
  sort: ["createdAt", "name"],
  defaultOrder: "desc",
};

const sp = (q: string) => new URLSearchParams(q);

describe("api-list parseListQuery", () => {
  it("returns null when no list params are present (legacy)", () => {
    expect(parseListQuery(sp(""), config)).toBeNull();
    expect(parseListQuery(sp("foo=bar"), config)).toBeNull();
  });

  it("defaults page=1 and pageSize=DEFAULT_PAGE_SIZE", () => {
    const q = parseListQuery(sp("sort=name"), config)!;
    expect(q.page).toBe(1);
    expect(q.pageSize).toBe(DEFAULT_PAGE_SIZE);
    expect(q.sort).toBe("name");
    expect(q.order).toBe("desc"); // defaultOrder
  });

  it("parses explicit page and pageSize", () => {
    const q = parseListQuery(sp("page=3&pageSize=10"), config)!;
    expect(q.page).toBe(3);
    expect(q.pageSize).toBe(10);
  });

  it("rejects pageSize above the hard maximum", () => {
    expect(() => parseListQuery(sp(`pageSize=${MAX_PAGE_SIZE + 1}`), config)).toThrow(ListQueryError);
  });

  it("rejects invalid page values", () => {
    for (const bad of ["page=0", "page=-1", "page=abc", "page=1.5"]) {
      expect(() => parseListQuery(sp(bad), config), bad).toThrow(ListQueryError);
    }
  });

  it("rejects non-positive/invalid pageSize", () => {
    for (const bad of ["pageSize=0", "pageSize=-5", "pageSize=abc"]) {
      expect(() => parseListQuery(sp(bad), config), bad).toThrow(ListQueryError);
    }
  });

  it("rejects unknown sort field", () => {
    expect(() => parseListQuery(sp("sort=nope"), config)).toThrow(ListQueryError);
  });

  it("rejects invalid order", () => {
    expect(() => parseListQuery(sp("order=up"), config)).toThrow(ListQueryError);
  });

  it("rejects invalid enum filter value", () => {
    expect(() => parseListQuery(sp("status=UNBEKANNT"), config)).toThrow(ListQueryError);
  });

  it("rejects invalid boolean filter value", () => {
    expect(() => parseListQuery(sp("done=yes"), config)).toThrow(ListQueryError);
  });

  it("rejects invalid int filter value", () => {
    expect(() => parseListQuery(sp("year=abc"), config)).toThrow(ListQueryError);
  });

  it("rejects empty filter value", () => {
    expect(() => parseListQuery(sp("status="), config)).toThrow(ListQueryError);
  });

  it("accepts valid id/enum/boolean/int filters", () => {
    const q = parseListQuery(sp("status=OFFEN&propertyId=abc123&done=true&year=2026"), config)!;
    expect(q.filters).toEqual({ status: "OFFEN", propertyId: "abc123", done: "true", year: "2026" });
  });
});

describe("api-list paginationMeta", () => {
  it("computes totalPages and flags", () => {
    expect(paginationMeta(1, 50, 0)).toEqual({ page: 1, pageSize: 50, total: 0, totalPages: 1, hasNext: false, hasPrevious: false });
    expect(paginationMeta(1, 50, 100)).toEqual({ page: 1, pageSize: 50, total: 100, totalPages: 2, hasNext: true, hasPrevious: false });
    expect(paginationMeta(2, 50, 100)).toEqual({ page: 2, pageSize: 50, total: 100, totalPages: 2, hasNext: false, hasPrevious: true });
    expect(paginationMeta(3, 50, 100)).toEqual({ page: 3, pageSize: 50, total: 100, totalPages: 2, hasNext: false, hasPrevious: true });
  });
});

describe("api-list buildWhere / buildOrderBy", () => {
  it("buildWhere maps boolean/int/enum/id filters", () => {
    const q = parseListQuery(sp("status=OFFEN&done=true&year=2026&propertyId=xyz"), config)!;
    expect(buildWhere(q, config)).toEqual({ status: "OFFEN", done: true, year: 2026, propertyId: "xyz" });
  });

  it("buildWhere is empty without query", () => {
    expect(buildWhere(undefined, config)).toEqual({});
  });

  it("legacy orderBy is the exact default (no tiebreaker)", () => {
    expect(buildOrderBy(undefined, config, [{ createdAt: "asc" }])).toEqual([{ createdAt: "asc" }]);
  });

  it("paginated orderBy without sort adds id tiebreaker", () => {
    const q = parseListQuery(sp("page=1"), config)!;
    expect(buildOrderBy(q, config, [{ createdAt: "desc" }])).toEqual([{ createdAt: "desc" }, { id: "asc" }]);
  });

  it("paginated orderBy with sort uses field + order + id tiebreaker", () => {
    const q = parseListQuery(sp("sort=name&order=asc"), config)!;
    expect(buildOrderBy(q, config, [{ createdAt: "desc" }])).toEqual([{ name: "asc" }, { id: "asc" }]);
  });
});
