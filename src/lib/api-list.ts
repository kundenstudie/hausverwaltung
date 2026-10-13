import { authenticateBearer, unauthorized } from "@/lib/api-auth";

// Gemeinsame, abwärtskompatible List-Query-Schicht (HAVEWA-04).
//
// Vertrag (REST /api/v1):
// - OHNE List-Parameter (page/pageSize/sort/order/Filter) liefert eine Route
//   weiterhin das LEGACY-Bare-Array (vollständig, unverändert) → bestehende
//   MCP-/PropertyAI-/externe Clients brechen nicht.
// - MIT mindestens einem List-Parameter liefert sie ein Envelope:
//     { data: [...], pagination: { page, pageSize, total, totalPages, hasNext, hasPrevious } }
// - page ist 1-basiert, pageSize hart begrenzt (Default 50, max 200).
// - Filter und Sortierung sind strikt whitelisted (keine generische Prisma-Where-API).
// - Jede paginierte Query hat einen deterministischen id-Tiebreaker.

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export type Order = "asc" | "desc";

export class ListQueryError extends Error {}

export interface ListQuery {
  page: number;
  pageSize: number;
  sort?: string;
  order: Order;
  filters: Record<string, string>;
}

export interface PaginationMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrevious: boolean;
}

export interface Paginated<T> {
  data: T[];
  pagination: PaginationMeta;
}

export type FilterSpec =
  | { kind: "enum"; values: readonly string[] }
  | { kind: "id" } // beliebige nicht-leere Zeichenkette (Relation-ID)
  | { kind: "boolean" } // "true" | "false"
  | { kind: "int" }; // ganzzahlig (z. B. Jahr)

export interface ListConfig {
  filters: Record<string, FilterSpec>;
  sort: readonly string[];
  defaultOrder: Order;
}

const POSITIVE_INT = /^[1-9][0-9]*$/;
const INT = /^-?[0-9]+$/;

function invalid(message: string): never {
  throw new ListQueryError(message);
}

/**
 * Parst die List-Query-Parameter. Liefert `null`, wenn KEIN List-Parameter
 * gesetzt ist (→ Legacy-Bare-Array). Wirft ListQueryError (→ 400) bei ungültigen
 * Eingaben (negative/0 page, zu großes pageSize, unbekannte Filter/Sort, etc.).
 */
export function parseListQuery(sp: URLSearchParams, config: ListConfig): ListQuery | null {
  const pageRaw = sp.get("page");
  const sizeRaw = sp.get("pageSize");
  const sortRaw = sp.get("sort");
  const orderRaw = sp.get("order");

  const filters: Record<string, string> = {};
  for (const field of Object.keys(config.filters)) {
    const v = sp.get(field);
    if (v !== null) filters[field] = v;
  }

  const hasAny =
    pageRaw !== null || sizeRaw !== null || sortRaw !== null || orderRaw !== null || Object.keys(filters).length > 0;
  if (!hasAny) return null;

  let page = 1;
  if (pageRaw !== null) {
    if (!POSITIVE_INT.test(pageRaw.trim())) invalid("page muss eine positive Ganzzahl sein");
    page = Number.parseInt(pageRaw.trim(), 10);
    if (!Number.isSafeInteger(page)) invalid("page ist zu groß");
  }

  let pageSize = DEFAULT_PAGE_SIZE;
  if (sizeRaw !== null) {
    if (!POSITIVE_INT.test(sizeRaw.trim())) invalid("pageSize muss eine positive Ganzzahl sein");
    pageSize = Number.parseInt(sizeRaw.trim(), 10);
    if (!Number.isSafeInteger(pageSize)) invalid("pageSize ist zu groß");
    if (pageSize > MAX_PAGE_SIZE) invalid(`pageSize darf höchstens ${MAX_PAGE_SIZE} sein`);
  }

  let sort: string | undefined;
  if (sortRaw !== null) {
    if (!config.sort.includes(sortRaw)) {
      invalid(`sort muss eines von ${config.sort.join(", ")} sein`);
    }
    sort = sortRaw;
  }

  let order: Order = config.defaultOrder;
  if (orderRaw !== null) {
    if (orderRaw !== "asc" && orderRaw !== "desc") invalid("order muss asc oder desc sein");
    order = orderRaw;
  }

  for (const [field, raw] of Object.entries(filters)) {
    const spec = config.filters[field];
    const value = raw;
    if (value === "") invalid(`Filter ${field} darf nicht leer sein`);
    if (spec.kind === "enum") {
      if (!spec.values.includes(value)) invalid(`Filter ${field}: ungültiger Wert`);
    } else if (spec.kind === "boolean") {
      if (value !== "true" && value !== "false") invalid(`Filter ${field} muss true oder false sein`);
    } else if (spec.kind === "int") {
      if (!INT.test(value)) invalid(`Filter ${field} muss eine Ganzzahl sein`);
    }
    // kind "id": beliebige nicht-leere Zeichenkette ist zulässig.
  }

  return { page, pageSize, sort, order, filters };
}

export function paginationMeta(page: number, pageSize: number, total: number): PaginationMeta {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return {
    page,
    pageSize,
    total,
    totalPages,
    hasNext: page < totalPages,
    hasPrevious: page > 1,
  };
}

/** Baut den Prisma-Where-Anteil (Filter + id-Tiebreaker-Ordnung bleiben außen vor). */
export function buildWhere(query: ListQuery | undefined, config: ListConfig): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  if (!query) return where;
  for (const [field, raw] of Object.entries(query.filters)) {
    const spec = config.filters[field];
    if (!spec) continue; // defense in depth (parseListQuery hat bereits whitelisted)
    if (spec.kind === "boolean") where[field] = raw === "true";
    else if (spec.kind === "int") where[field] = Number.parseInt(raw, 10);
    else where[field] = raw;
  }
  return where;
}

/**
 * Baut die orderBy-Liste.
 * - Ohne Query (Legacy-Bare-Array): exakt die bisherige Default-Order (unverändert).
 * - Mit Query, ohne sort: Default-Order + id-Tiebreaker (deterministisch).
 * - Mit sort: whitelisted Feld + order + id-Tiebreaker.
 */
export function buildOrderBy(
  query: ListQuery | undefined,
  config: ListConfig,
  defaultOrderBy: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  if (!query) return [...defaultOrderBy];
  if (!query.sort) return [...defaultOrderBy, { id: "asc" }];
  return [{ [query.sort]: query.order }, { id: "asc" }];
}

/** Baut den standardisierten GET-Handler einer List-Route (Auth + Parsing + Response). */
export function listRoute(
  listFn: (tenantId: string, query?: ListQuery) => Promise<unknown>,
  config: ListConfig,
): (req: Request) => Promise<Response> {
  return async function GET(req: Request): Promise<Response> {
    const p = await authenticateBearer(req);
    if (!p) return unauthorized();
    let query: ListQuery | null;
    try {
      query = parseListQuery(new URL(req.url).searchParams, config);
    } catch (e) {
      if (e instanceof ListQueryError) return Response.json({ error: e.message }, { status: 400 });
      throw e;
    }
    const result = await listFn(p.tenantId, query ?? undefined);
    return Response.json(result);
  };
}
