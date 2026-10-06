// PropertyAI (Stufe 3): reine, prisma-freie DTO-Schicht für die neuen
// mandanten-gescopten Legal-Read-Routen.
//
// Boundary-Regeln (P4.API/D-0038):
// - explizites Allowlist-Mapping, kein direkter Prisma-Raw-Dump
// - KEIN tenantId, KEIN custom, KEIN note, KEINE Personen-/Kontaktdaten
// - keine abgeleiteten Felder (kein oldRentCold)
// Diese Datei importiert bewusst KEIN Prisma und hat keine Seiteneffekte.

export type AdjustmentTypeValue = "STAFFEL" | "INDEX";

export interface LeaseLegalContextDto {
  readonly leaseId: string;
  readonly startDate: string;
  readonly endDate: string | null;
  readonly rentCold: number;
  readonly noticePeriodMonths: number | null;
}

export interface RentAdjustmentReadDto {
  readonly id: string;
  readonly leaseId: string;
  readonly type: AdjustmentTypeValue;
  readonly effectiveDate: string;
  readonly newRentCold: number;
  readonly indexBase: number | null;
  readonly indexNew: number | null;
  readonly applied: boolean;
}

export interface RentAdjustmentListDto {
  readonly items: readonly RentAdjustmentReadDto[];
  readonly pagination: { readonly count: number; readonly limit: number };
}

/** Structural row shapes (accept Prisma results without importing Prisma types). */
export interface LeaseLegalContextRow {
  readonly id: string;
  readonly startDate: Date;
  readonly endDate: Date | null;
  readonly rentCold: unknown;
  readonly noticePeriodM: number | null;
}

export interface RentAdjustmentRow {
  readonly id: string;
  readonly leaseId: string;
  readonly type: AdjustmentTypeValue;
  readonly effectiveDate: Date;
  readonly newRentCold: unknown;
  readonly indexBase: unknown;
  readonly indexNew: unknown;
  readonly applied: boolean;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function isoDateOrNull(date: Date | null): string | null {
  return date === null ? null : isoDate(date);
}

/** Decimal -> number for a non-nullable Decimal column. */
function decimalToNumber(value: unknown): number {
  return Number(value);
}

/** Decimal -> number | null for a nullable Decimal column. */
function decimalToNumberOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

export function toLeaseLegalContextDto(row: LeaseLegalContextRow): LeaseLegalContextDto {
  return {
    leaseId: row.id,
    startDate: isoDate(row.startDate),
    endDate: isoDateOrNull(row.endDate),
    rentCold: decimalToNumber(row.rentCold),
    noticePeriodMonths: row.noticePeriodM ?? null,
  };
}

export function toRentAdjustmentReadDto(row: RentAdjustmentRow): RentAdjustmentReadDto {
  return {
    id: row.id,
    leaseId: row.leaseId,
    type: row.type,
    effectiveDate: isoDate(row.effectiveDate),
    newRentCold: decimalToNumber(row.newRentCold),
    indexBase: decimalToNumberOrNull(row.indexBase),
    indexNew: decimalToNumberOrNull(row.indexNew),
    applied: row.applied === true,
  };
}

/** Deterministic ordering: effectiveDate DESC, then id ASC. */
export function compareRentAdjustmentsNewestFirst(a: RentAdjustmentReadDto, b: RentAdjustmentReadDto): number {
  if (a.effectiveDate !== b.effectiveDate) return a.effectiveDate < b.effectiveDate ? 1 : -1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

export function toRentAdjustmentListDto(
  rows: readonly RentAdjustmentRow[],
  limit: number,
): RentAdjustmentListDto {
  const items = rows.map(toRentAdjustmentReadDto).sort(compareRentAdjustmentsNewestFirst);
  return { items, pagination: { count: items.length, limit } };
}
