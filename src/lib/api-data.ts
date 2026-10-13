import { prisma } from "@/lib/prisma";
import type {
  Prisma,
  PropertyType,
  ManagementType,
  UnitType,
  PersonType,
  ChargeType,
  PaymentDirection,
  TicketCategory,
  TicketStatus,
  TicketPriority,
  DocumentCategory,
  MeetingStatus,
  ResolutionResult,
  AppointmentType,
  MeterType,
  AccountType,
  InsuranceType,
} from "@prisma/client";
import {
  buildWhere,
  buildOrderBy,
  paginationMeta,
  type ListQuery,
  type ListConfig,
  type Paginated,
} from "@/lib/api-list";
import {
  toLeaseLegalContextDto,
  toRentAdjustmentListDto,
  type LeaseLegalContextRow,
  type RentAdjustmentRow,
} from "@/lib/api-legal-dto";

// Geteilte, mandanten-gescopte Datenschicht für REST-API und MCP-Server.
// Alle Funktionen erhalten die tenantId aus dem authentifizierten Token.
//
// HAVEWA-04: jede listX()-Funktion hat zwei Überladungen:
//   listX(tenantId)           -> Legacy-Bare-Array (unverändert, MCP/extern)
//   listX(tenantId, query)    -> paginiertes Envelope { data, pagination }

const num = (d: unknown) => (d == null ? null : Number(d as number));
const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const propSel = { property: { select: { name: true } } };

const enumV = <T extends readonly string[]>(values: T) => ({ kind: "enum", values } as const);
const idF = { kind: "id" } as const;
const boolF = { kind: "boolean" } as const;
const intF = { kind: "int" } as const;

// Whitelists je Endpoint (HAVEWA-04, Abschnitte 8/9). Kein generischer
// Prisma-Where nach außen; nur fachlich sinnvolle, tenant-sichere Felder.
export const LIST_CONFIG: Record<string, ListConfig> = {
  properties: {
    filters: { type: enumV(["WOHNEN", "GEWERBE", "GEMISCHT"]), management: enumV(["MIET", "WEG"]) },
    sort: ["createdAt", "name", "city", "type"],
    defaultOrder: "asc",
  },
  units: {
    filters: { type: enumV(["WOHNUNG", "GEWERBE", "STELLPLATZ", "KELLER", "SONSTIGES"]), buildingId: idF },
    sort: ["createdAt", "label", "area"],
    defaultOrder: "asc",
  },
  persons: {
    filters: { type: enumV(["MIETER", "EIGENTUEMER", "INTERESSENT", "HANDWERKER", "MAKLER", "BANK", "SONSTIGE"]) },
    sort: ["lastName", "firstName", "createdAt"],
    defaultOrder: "asc",
  },
  leases: {
    filters: { unitId: idF },
    sort: ["startDate", "rentCold"],
    defaultOrder: "desc",
  },
  tickets: {
    filters: {
      status: enumV(["OFFEN", "IN_ARBEIT", "WARTEND", "ERLEDIGT"]),
      priority: enumV(["NIEDRIG", "MITTEL", "HOCH"]),
      category: enumV(["STOERUNG", "SCHADEN", "WARTUNG", "RECHNUNG", "VERTRAG", "SONSTIGES"]),
      propertyId: idF,
      unitId: idF,
      contractorId: idF,
    },
    sort: ["createdAt", "dueDate", "status", "priority", "title"],
    defaultOrder: "desc",
  },
  charges: {
    filters: { type: enumV(["MIETE", "NEBENKOSTEN", "HAUSGELD", "KAUTION", "SONSTIGES"]), leaseId: idF },
    sort: ["dueDate", "period", "amount"],
    defaultOrder: "desc",
  },
  payments: {
    filters: { direction: enumV(["EINGANG", "AUSGANG"]), accountId: idF, chargeId: idF },
    sort: ["date", "amount"],
    defaultOrder: "desc",
  },
  openItems: {
    filters: { type: enumV(["MIETE", "NEBENKOSTEN", "HAUSGELD", "KAUTION", "SONSTIGES"]) },
    sort: ["dueDate", "amount", "open"],
    defaultOrder: "desc",
  },
  documents: {
    filters: {
      category: enumV(["VERTRAG", "RECHNUNG", "ERECHNUNG", "PROTOKOLL", "ABRECHNUNG", "EMAIL_ANHANG", "SONSTIGES"]),
      propertyId: idF,
      unitId: idF,
      personId: idF,
    },
    sort: ["createdAt", "name"],
    defaultOrder: "desc",
  },
  meetings: {
    filters: { status: enumV(["GEPLANT", "DURCHGEFUEHRT"]), propertyId: idF },
    sort: ["date", "title"],
    defaultOrder: "desc",
  },
  resolutions: {
    filters: { propertyId: idF, result: enumV(["ANGENOMMEN", "ABGELEHNT", "VERTAGT"]) },
    sort: ["number", "date"],
    defaultOrder: "asc",
  },
  economicPlans: {
    filters: { propertyId: idF, year: intF },
    sort: ["year"],
    defaultOrder: "desc",
  },
  reserves: {
    filters: { propertyId: idF },
    sort: ["createdAt", "name"],
    defaultOrder: "asc",
  },
  appointments: {
    filters: { type: enumV(["BESICHTIGUNG", "VERSAMMLUNG", "WARTUNG", "FRIST", "SONSTIGES"]), propertyId: idF },
    sort: ["start", "end"],
    defaultOrder: "asc",
  },
  tasks: {
    filters: { done: boolF },
    sort: ["dueDate", "createdAt", "title"],
    defaultOrder: "asc",
  },
  contractors: {
    filters: {},
    sort: ["name", "trade"],
    defaultOrder: "asc",
  },
  maintenanceContracts: {
    filters: { propertyId: idF, contractorId: idF },
    sort: ["nextDue", "title"],
    defaultOrder: "asc",
  },
  insurances: {
    filters: { type: enumV(["GEBAEUDE", "HAFTPFLICHT", "GLAS", "ELEMENTAR", "RECHTSSCHUTZ", "SONSTIGES"]), propertyId: idF },
    sort: ["createdAt", "startDate"],
    defaultOrder: "asc",
  },
  propertyTaxes: {
    filters: { propertyId: idF },
    sort: [],
    defaultOrder: "asc",
  },
  owners: {
    filters: { unitId: idF, personId: idF },
    sort: ["share"],
    defaultOrder: "asc",
  },
  accounts: {
    filters: { type: enumV(["BANK", "KAUTION", "RUECKLAGE", "SACHKONTO"]) },
    sort: ["createdAt", "name"],
    defaultOrder: "asc",
  },
  meters: {
    filters: { type: enumV(["STROM", "GAS", "WASSER_KALT", "WASSER_WARM", "WAERME"]), unitId: idF },
    sort: ["createdAt", "serialNo"],
    defaultOrder: "asc",
  },
} as const;

export type PropertyListItem = { id: string; name: string; street: string | null; zip: string | null; city: string | null; type: PropertyType; management: ManagementType; units: number };
export type UnitListItem = { id: string; label: string; type: UnitType; area: number | null; rooms: number | null; mea: number | null; property: string; building: string };
export type PersonListItem = { id: string; firstName: string; lastName: string; email: string | null; phone: string | null; type: PersonType };
export type LeaseListItem = { id: string; property: string; unit: string; tenants: string[]; rentCold: number | null; startDate: string; endDate: string | null };
export type TicketListItem = { id: string; title: string; category: TicketCategory; status: TicketStatus; priority: TicketPriority; property: string | null; assignee: string | null; dueDate: string | null };
export type OpenItemListItem = { id: string; type: ChargeType; period: string; dueDate: string; amount: number; open: number; overdue: boolean; property: string | null };
export type OwnerListItem = { id: string; person: string; unit: string; property: string; share: number };
export type MeterListItem = { id: string; type: MeterType; serialNo: string | null; unit: string; property: string; lastReading: { date: string | null; value: number | null } | null };
export type AccountListItem = { id: string; name: string; type: AccountType; iban: string | null; balance: number };
export type ChargeListItem = { id: string; type: ChargeType; period: string | null; dueDate: string | null; amount: number | null; paid: number; unit: string | null };
export type PaymentListItem = { id: string; date: string | null; amount: number | null; direction: PaymentDirection; reference: string | null; account: string | null };
export type DocumentListItem = { id: string; name: string; category: DocumentCategory; mime: string; size: number; eInvoice: boolean; invoiceNo: string | null; invoiceTotal: number | null; property: string | null; createdAt: string | null };
export type MeetingListItem = { id: string; title: string; date: string | null; status: MeetingStatus; location: string | null; property: string; agendaItems: number; resolutions: number };
export type ResolutionListItem = { id: string; number: number; title: string; text: string; date: string | null; result: ResolutionResult; votes: { yes: number; no: number; abstain: number }; property: string; subcommunity: string | null };
export type EconomicPlanListItem = { id: string; property: string; year: number; totalAmount: number | null; monthly: number; note: string | null };
export type ReserveListItem = { id: string; name: string; property: string; subcommunity: string | null; balance: number };
export type AppointmentListItem = { id: string; title: string; type: AppointmentType; start: string; end: string | null; location: string | null; property: string | null };
export type TaskListItem = { id: string; title: string; dueDate: string | null; done: boolean };
export type ContractorListItem = { id: string; name: string; trade: string | null; email: string | null; phone: string | null };
export type MaintenanceListItem = { id: string; title: string; intervalMonths: number; nextDue: string | null; property: string; contractor: string | null };
export type InsuranceListItem = { id: string; type: InsuranceType; insurer: string; policyNo: string | null; premium: number | null; startDate: string | null; endDate: string | null; property: string };
export type PropertyTaxListItem = { id: string; property: string; aktenzeichen: string | null; grundsteuerwert: number | null; messbetrag: number | null; hebesatz: number | null; jahresbetrag: number | null };

export function listProperties(tenantId: string): Promise<PropertyListItem[]>;
export function listProperties(tenantId: string, query: ListQuery): Promise<Paginated<PropertyListItem>>;
export async function listProperties(tenantId: string, query?: ListQuery) {
  const where = { tenantId, ...buildWhere(query, LIST_CONFIG.properties) } as Prisma.PropertyWhereInput;
  const orderBy = buildOrderBy(query, LIST_CONFIG.properties, [{ createdAt: "asc" }]) as Prisma.PropertyOrderByWithRelationInput[];
  const include = { buildings: { include: { _count: { select: { units: true } } } } } as const;
  const [rows, total] = query
    ? await Promise.all([
        prisma.property.findMany({ where, include, orderBy, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
        prisma.property.count({ where }),
      ])
    : [await prisma.property.findMany({ where, include, orderBy }), 0];
  const data: PropertyListItem[] = rows.map((p) => ({
    id: p.id,
    name: p.name,
    street: p.street,
    zip: p.zip,
    city: p.city,
    type: p.type,
    management: p.management,
    units: p.buildings.reduce((a, b) => a + b._count.units, 0),
  }));
  return query ? { data, pagination: paginationMeta(query.page, query.pageSize, total) } : data;
}

export async function getProperty(tenantId: string, id: string) {
  const p = await prisma.property.findFirst({
    where: { id, tenantId },
    include: { buildings: { include: { units: true } } },
  });
  if (!p) return null;
  return {
    id: p.id,
    name: p.name,
    street: p.street,
    zip: p.zip,
    city: p.city,
    type: p.type,
    management: p.management,
    meaTotal: p.meaTotal,
    buildings: p.buildings.map((b) => ({
      id: b.id,
      name: b.name,
      units: b.units.map((u) => ({ id: u.id, label: u.label, type: u.type, area: num(u.area), mea: u.mea })),
    })),
  };
}

export function listUnits(tenantId: string): Promise<UnitListItem[]>;
export function listUnits(tenantId: string, query: ListQuery): Promise<Paginated<UnitListItem>>;
export async function listUnits(tenantId: string, query?: ListQuery) {
  const where = { tenantId, ...buildWhere(query, LIST_CONFIG.units) } as Prisma.UnitWhereInput;
  const orderBy = buildOrderBy(query, LIST_CONFIG.units, [{ createdAt: "asc" }]) as Prisma.UnitOrderByWithRelationInput[];
  const include = { building: { include: { property: { select: { name: true } } } } } as const;
  const [rows, total] = query
    ? await Promise.all([
        prisma.unit.findMany({ where, include, orderBy, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
        prisma.unit.count({ where }),
      ])
    : [await prisma.unit.findMany({ where, include, orderBy }), 0];
  const data: UnitListItem[] = rows.map((u) => ({
    id: u.id,
    label: u.label,
    type: u.type,
    area: num(u.area),
    rooms: num(u.rooms),
    mea: u.mea,
    property: u.building.property.name,
    building: u.building.name,
  }));
  return query ? { data, pagination: paginationMeta(query.page, query.pageSize, total) } : data;
}

export function listPersons(tenantId: string): Promise<PersonListItem[]>;
export function listPersons(tenantId: string, query: ListQuery): Promise<Paginated<PersonListItem>>;
export async function listPersons(tenantId: string, query?: ListQuery) {
  const where = { tenantId, ...buildWhere(query, LIST_CONFIG.persons) } as Prisma.PersonWhereInput;
  const orderBy = buildOrderBy(query, LIST_CONFIG.persons, [{ lastName: "asc" }, { firstName: "asc" }]) as Prisma.PersonOrderByWithRelationInput[];
  const [rows, total] = query
    ? await Promise.all([
        prisma.person.findMany({ where, orderBy, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
        prisma.person.count({ where }),
      ])
    : [await prisma.person.findMany({ where, orderBy }), 0];
  const data: PersonListItem[] = rows.map((p) => ({
    id: p.id,
    firstName: p.firstName,
    lastName: p.lastName,
    email: p.email,
    phone: p.phone,
    type: p.type,
  }));
  return query ? { data, pagination: paginationMeta(query.page, query.pageSize, total) } : data;
}

export function listLeases(tenantId: string): Promise<LeaseListItem[]>;
export function listLeases(tenantId: string, query: ListQuery): Promise<Paginated<LeaseListItem>>;
export async function listLeases(tenantId: string, query?: ListQuery) {
  const where = { tenantId, ...buildWhere(query, LIST_CONFIG.leases) } as Prisma.LeaseWhereInput;
  const orderBy = buildOrderBy(query, LIST_CONFIG.leases, [{ startDate: "desc" }]) as Prisma.LeaseOrderByWithRelationInput[];
  const include = {
    unit: { include: { building: { include: { property: { select: { name: true } } } } } },
    renters: { include: { person: { select: { firstName: true, lastName: true } } } },
  } as const;
  const [rows, total] = query
    ? await Promise.all([
        prisma.lease.findMany({ where, include, orderBy, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
        prisma.lease.count({ where }),
      ])
    : [await prisma.lease.findMany({ where, include, orderBy }), 0];
  const data: LeaseListItem[] = rows.map((l) => ({
    id: l.id,
    property: l.unit.building.property.name,
    unit: l.unit.label,
    tenants: l.renters.map((r) => `${r.person.firstName} ${r.person.lastName}`),
    rentCold: num(l.rentCold),
    startDate: l.startDate.toISOString().slice(0, 10),
    endDate: l.endDate ? l.endDate.toISOString().slice(0, 10) : null,
  }));
  return query ? { data, pagination: paginationMeta(query.page, query.pageSize, total) } : data;
}

export function listTickets(tenantId: string): Promise<TicketListItem[]>;
export function listTickets(tenantId: string, query: ListQuery): Promise<Paginated<TicketListItem>>;
export async function listTickets(tenantId: string, query?: ListQuery) {
  const where = { tenantId, ...buildWhere(query, LIST_CONFIG.tickets) } as Prisma.TicketWhereInput;
  const orderBy = buildOrderBy(query, LIST_CONFIG.tickets, [{ status: "asc" }, { createdAt: "desc" }]) as Prisma.TicketOrderByWithRelationInput[];
  const include = { property: { select: { name: true } }, assignee: { select: { name: true } } } as const;
  const [rows, total] = query
    ? await Promise.all([
        prisma.ticket.findMany({ where, include, orderBy, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
        prisma.ticket.count({ where }),
      ])
    : [await prisma.ticket.findMany({ where, include, orderBy }), 0];
  const data: TicketListItem[] = rows.map((t) => ({
    id: t.id,
    title: t.title,
    category: t.category,
    status: t.status,
    priority: t.priority,
    property: t.property?.name ?? null,
    assignee: t.assignee?.name ?? null,
    dueDate: t.dueDate ? t.dueDate.toISOString().slice(0, 10) : null,
  }));
  return query ? { data, pagination: paginationMeta(query.page, query.pageSize, total) } : data;
}

export function listOpenItems(tenantId: string): Promise<OpenItemListItem[]>;
export function listOpenItems(tenantId: string, query: ListQuery): Promise<Paginated<OpenItemListItem>>;
export async function listOpenItems(tenantId: string, query?: ListQuery) {
  // Offene Posten werden aus Charges + Zahlungen berechnet. Die offen>0-Filterung
  // ist keine reine Prisma-Operation → Berechnung in JS, danach sortieren/slicen.
  const where = { tenantId, ...buildWhere(query, LIST_CONFIG.openItems) } as Prisma.ChargeWhereInput;
  const orderBy = buildOrderBy(query, LIST_CONFIG.openItems, [{ dueDate: "desc" }]) as Prisma.ChargeOrderByWithRelationInput[];
  const charges = await prisma.charge.findMany({
    where,
    include: {
      payments: { select: { amount: true } },
      lease: { include: { unit: { include: { building: { include: { property: { select: { name: true } } } } } } } },
    },
    orderBy,
  });
  const now = new Date();
  const items: OpenItemListItem[] = charges
    .map((c) => {
      const paid = c.payments.reduce((a, p) => a + Number(p.amount), 0);
      const open = Number(c.amount) - paid;
      return {
        id: c.id,
        type: c.type,
        period: c.period.toISOString().slice(0, 10),
        dueDate: c.dueDate.toISOString().slice(0, 10),
        amount: Number(c.amount),
        open: Math.round(open * 100) / 100,
        overdue: open > 0.005 && c.dueDate < now,
        property: c.lease?.unit.building.property.name ?? null,
      };
    })
    .filter((c) => c.open > 0.005);

  if (!query) return items;

  if (query.sort) {
    const dir = query.order === "asc" ? 1 : -1;
    const key = query.sort as "dueDate" | "amount" | "open";
    items.sort((a, b) => {
      if (a[key] === b[key]) return a.id < b.id ? -1 : 1;
      return (a[key] as number) < (b[key] as number) ? -dir : dir;
    });
  }
  const total = items.length;
  const data = items.slice((query.page - 1) * query.pageSize, query.page * query.pageSize);
  return { data, pagination: paginationMeta(query.page, query.pageSize, total) };
}

export async function createTicket(
  tenantId: string,
  data: { title: string; description?: string; propertyId?: string; priority?: string },
) {
  const propertyId =
    data.propertyId &&
    (await prisma.property.findFirst({ where: { id: data.propertyId, tenantId }, select: { id: true } }))
      ? data.propertyId
      : null;
  const created = await prisma.ticket.create({
    data: {
      tenantId,
      title: data.title,
      description: data.description ?? null,
      propertyId,
      priority: (data.priority as "NIEDRIG" | "MITTEL" | "HOCH") ?? "MITTEL",
    },
  });
  return { id: created.id, title: created.title, status: created.status };
}

export async function createPerson(
  tenantId: string,
  data: { firstName: string; lastName: string; email?: string; phone?: string; type?: string },
) {
  const created = await prisma.person.create({
    data: {
      tenantId,
      firstName: data.firstName,
      lastName: data.lastName,
      email: data.email ?? null,
      phone: data.phone ?? null,
      type: (data.type as "MIETER" | "EIGENTUEMER" | "INTERESSENT" | "HANDWERKER" | "MAKLER" | "BANK" | "SONSTIGE") ?? "SONSTIGE",
    },
  });
  return { id: created.id, firstName: created.firstName, lastName: created.lastName };
}

export function listOwners(tenantId: string): Promise<OwnerListItem[]>;
export function listOwners(tenantId: string, query: ListQuery): Promise<Paginated<OwnerListItem>>;
export async function listOwners(tenantId: string, query?: ListQuery) {
  const where = { tenantId, ...buildWhere(query, LIST_CONFIG.owners) } as Prisma.OwnerWhereInput;
  const orderBy = buildOrderBy(query, LIST_CONFIG.owners, []) as Prisma.OwnerOrderByWithRelationInput[];
  const include = {
    person: { select: { firstName: true, lastName: true } },
    unit: { include: { building: { include: { property: { select: { name: true } } } } } },
  } as const;
  const [rows, total] = query
    ? await Promise.all([
        prisma.owner.findMany({ where, include, orderBy, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
        prisma.owner.count({ where }),
      ])
    : [await prisma.owner.findMany({ where, include, orderBy }), 0];
  const data: OwnerListItem[] = rows.map((o) => ({
    id: o.id,
    person: `${o.person.firstName} ${o.person.lastName}`,
    unit: o.unit.label,
    property: o.unit.building.property.name,
    share: o.share,
  }));
  return query ? { data, pagination: paginationMeta(query.page, query.pageSize, total) } : data;
}

export function listMeters(tenantId: string): Promise<MeterListItem[]>;
export function listMeters(tenantId: string, query: ListQuery): Promise<Paginated<MeterListItem>>;
export async function listMeters(tenantId: string, query?: ListQuery) {
  const where = { tenantId, ...buildWhere(query, LIST_CONFIG.meters) } as Prisma.MeterWhereInput;
  const orderBy = buildOrderBy(query, LIST_CONFIG.meters, [{ createdAt: "asc" }]) as Prisma.MeterOrderByWithRelationInput[];
  const include = {
    unit: { include: { building: { include: { property: { select: { name: true } } } } } },
    readings: { orderBy: { date: "desc" }, take: 1 },
  } as const;
  const [rows, total] = query
    ? await Promise.all([
        prisma.meter.findMany({ where, include, orderBy, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
        prisma.meter.count({ where }),
      ])
    : [await prisma.meter.findMany({ where, include, orderBy }), 0];
  const data: MeterListItem[] = rows.map((m) => ({
    id: m.id,
    type: m.type,
    serialNo: m.serialNo,
    unit: m.unit.label,
    property: m.unit.building.property.name,
    lastReading: m.readings[0] ? { date: day(m.readings[0].date), value: num(m.readings[0].value) } : null,
  }));
  return query ? { data, pagination: paginationMeta(query.page, query.pageSize, total) } : data;
}

export function listAccounts(tenantId: string): Promise<AccountListItem[]>;
export function listAccounts(tenantId: string, query: ListQuery): Promise<Paginated<AccountListItem>>;
export async function listAccounts(tenantId: string, query?: ListQuery) {
  const where = { tenantId, ...buildWhere(query, LIST_CONFIG.accounts) } as Prisma.AccountWhereInput;
  const orderBy = buildOrderBy(query, LIST_CONFIG.accounts, [{ createdAt: "asc" }]) as Prisma.AccountOrderByWithRelationInput[];
  const include = { payments: { select: { amount: true, direction: true } } } as const;
  const [rows, total] = query
    ? await Promise.all([
        prisma.account.findMany({ where, include, orderBy, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
        prisma.account.count({ where }),
      ])
    : [await prisma.account.findMany({ where, include, orderBy }), 0];
  const data: AccountListItem[] = rows.map((a) => {
    const balance = a.payments.reduce(
      (s, p) => s + (p.direction === "EINGANG" ? Number(p.amount) : -Number(p.amount)),
      0,
    );
    return { id: a.id, name: a.name, type: a.type, iban: a.iban, balance: Math.round(balance * 100) / 100 };
  });
  return query ? { data, pagination: paginationMeta(query.page, query.pageSize, total) } : data;
}

export function listCharges(tenantId: string): Promise<ChargeListItem[]>;
export function listCharges(tenantId: string, query: ListQuery): Promise<Paginated<ChargeListItem>>;
export async function listCharges(tenantId: string, query?: ListQuery) {
  const where = { tenantId, ...buildWhere(query, LIST_CONFIG.charges) } as Prisma.ChargeWhereInput;
  const orderBy = buildOrderBy(query, LIST_CONFIG.charges, [{ dueDate: "desc" }]) as Prisma.ChargeOrderByWithRelationInput[];
  const include = { payments: { select: { amount: true } }, lease: { include: { unit: { select: { label: true } } } } } as const;
  const [rows, total] = query
    ? await Promise.all([
        prisma.charge.findMany({ where, include, orderBy, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
        prisma.charge.count({ where }),
      ])
    : [await prisma.charge.findMany({ where, include, orderBy }), 0];
  const data: ChargeListItem[] = rows.map((c) => {
    const paid = c.payments.reduce((s, p) => s + Number(p.amount), 0);
    return {
      id: c.id,
      type: c.type,
      period: day(c.period),
      dueDate: day(c.dueDate),
      amount: num(c.amount),
      paid: Math.round(paid * 100) / 100,
      unit: c.lease?.unit.label ?? null,
    };
  });
  return query ? { data, pagination: paginationMeta(query.page, query.pageSize, total) } : data;
}

export function listPayments(tenantId: string): Promise<PaymentListItem[]>;
export function listPayments(tenantId: string, query: ListQuery): Promise<Paginated<PaymentListItem>>;
export async function listPayments(tenantId: string, query?: ListQuery) {
  const where = { tenantId, ...buildWhere(query, LIST_CONFIG.payments) } as Prisma.PaymentWhereInput;
  const orderBy = buildOrderBy(query, LIST_CONFIG.payments, [{ date: "desc" }]) as Prisma.PaymentOrderByWithRelationInput[];
  const include = { account: { select: { name: true } } } as const;
  const [rows, total] = query
    ? await Promise.all([
        prisma.payment.findMany({ where, include, orderBy, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
        prisma.payment.count({ where }),
      ])
    : [await prisma.payment.findMany({ where, include, orderBy }), 0];
  const data: PaymentListItem[] = rows.map((p) => ({
    id: p.id,
    date: day(p.date),
    amount: num(p.amount),
    direction: p.direction,
    reference: p.reference,
    account: p.account?.name ?? null,
  }));
  return query ? { data, pagination: paginationMeta(query.page, query.pageSize, total) } : data;
}

export function listDocuments(tenantId: string): Promise<DocumentListItem[]>;
export function listDocuments(tenantId: string, query: ListQuery): Promise<Paginated<DocumentListItem>>;
export async function listDocuments(tenantId: string, query?: ListQuery) {
  const where = { tenantId, ...buildWhere(query, LIST_CONFIG.documents) } as Prisma.DocumentWhereInput;
  const orderBy = buildOrderBy(query, LIST_CONFIG.documents, [{ createdAt: "desc" }]) as Prisma.DocumentOrderByWithRelationInput[];
  const [rows, total] = query
    ? await Promise.all([
        prisma.document.findMany({ where, include: propSel, orderBy, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
        prisma.document.count({ where }),
      ])
    : [await prisma.document.findMany({ where, include: propSel, orderBy }), 0];
  const data: DocumentListItem[] = rows.map((d) => ({
    id: d.id,
    name: d.name,
    category: d.category,
    mime: d.mime,
    size: d.size,
    eInvoice: d.eInvoice,
    invoiceNo: d.invoiceNo,
    invoiceTotal: num(d.invoiceTotal),
    property: d.property?.name ?? null,
    createdAt: day(d.createdAt),
  }));
  return query ? { data, pagination: paginationMeta(query.page, query.pageSize, total) } : data;
}

export function listMeetings(tenantId: string): Promise<MeetingListItem[]>;
export function listMeetings(tenantId: string, query: ListQuery): Promise<Paginated<MeetingListItem>>;
export async function listMeetings(tenantId: string, query?: ListQuery) {
  const where = { tenantId, ...buildWhere(query, LIST_CONFIG.meetings) } as Prisma.MeetingWhereInput;
  const orderBy = buildOrderBy(query, LIST_CONFIG.meetings, [{ date: "desc" }]) as Prisma.MeetingOrderByWithRelationInput[];
  const include = { ...propSel, _count: { select: { agendaItems: true, resolutions: true } } } as const;
  const [rows, total] = query
    ? await Promise.all([
        prisma.meeting.findMany({ where, include, orderBy, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
        prisma.meeting.count({ where }),
      ])
    : [await prisma.meeting.findMany({ where, include, orderBy }), 0];
  const data: MeetingListItem[] = rows.map((m) => ({
    id: m.id,
    title: m.title,
    date: day(m.date),
    status: m.status,
    location: m.location,
    property: m.property.name,
    agendaItems: m._count.agendaItems,
    resolutions: m._count.resolutions,
  }));
  return query ? { data, pagination: paginationMeta(query.page, query.pageSize, total) } : data;
}

export function listResolutions(tenantId: string): Promise<ResolutionListItem[]>;
export function listResolutions(tenantId: string, query: ListQuery): Promise<Paginated<ResolutionListItem>>;
export async function listResolutions(tenantId: string, query?: ListQuery) {
  const where = { tenantId, ...buildWhere(query, LIST_CONFIG.resolutions) } as Prisma.ResolutionWhereInput;
  const orderBy = buildOrderBy(query, LIST_CONFIG.resolutions, [{ propertyId: "asc" }, { number: "asc" }]) as Prisma.ResolutionOrderByWithRelationInput[];
  const include = { ...propSel, subcommunity: { select: { name: true } } } as const;
  const [rows, total] = query
    ? await Promise.all([
        prisma.resolution.findMany({ where, include, orderBy, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
        prisma.resolution.count({ where }),
      ])
    : [await prisma.resolution.findMany({ where, include, orderBy }), 0];
  const data: ResolutionListItem[] = rows.map((r) => ({
    id: r.id,
    number: r.number,
    title: r.title,
    text: r.text,
    date: day(r.date),
    result: r.result,
    votes: { yes: r.votesYes, no: r.votesNo, abstain: r.votesAbstain },
    property: r.property.name,
    subcommunity: r.subcommunity?.name ?? null,
  }));
  return query ? { data, pagination: paginationMeta(query.page, query.pageSize, total) } : data;
}

export function listEconomicPlans(tenantId: string): Promise<EconomicPlanListItem[]>;
export function listEconomicPlans(tenantId: string, query: ListQuery): Promise<Paginated<EconomicPlanListItem>>;
export async function listEconomicPlans(tenantId: string, query?: ListQuery) {
  const where = { tenantId, ...buildWhere(query, LIST_CONFIG.economicPlans) } as Prisma.EconomicPlanWhereInput;
  const orderBy = buildOrderBy(query, LIST_CONFIG.economicPlans, [{ year: "desc" }]) as Prisma.EconomicPlanOrderByWithRelationInput[];
  const [rows, total] = query
    ? await Promise.all([
        prisma.economicPlan.findMany({ where, include: propSel, orderBy, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
        prisma.economicPlan.count({ where }),
      ])
    : [await prisma.economicPlan.findMany({ where, include: propSel, orderBy }), 0];
  const data: EconomicPlanListItem[] = rows.map((e) => ({
    id: e.id,
    property: e.property.name,
    year: e.year,
    totalAmount: num(e.totalAmount),
    monthly: Math.round((Number(e.totalAmount) / 12) * 100) / 100,
    note: e.note,
  }));
  return query ? { data, pagination: paginationMeta(query.page, query.pageSize, total) } : data;
}

export function listReserves(tenantId: string): Promise<ReserveListItem[]>;
export function listReserves(tenantId: string, query: ListQuery): Promise<Paginated<ReserveListItem>>;
export async function listReserves(tenantId: string, query?: ListQuery) {
  const where = { tenantId, ...buildWhere(query, LIST_CONFIG.reserves) } as Prisma.ReserveWhereInput;
  const orderBy = buildOrderBy(query, LIST_CONFIG.reserves, [{ createdAt: "asc" }]) as Prisma.ReserveOrderByWithRelationInput[];
  const include = { ...propSel, subcommunity: { select: { name: true } }, transactions: { select: { amount: true } } } as const;
  const [rows, total] = query
    ? await Promise.all([
        prisma.reserve.findMany({ where, include, orderBy, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
        prisma.reserve.count({ where }),
      ])
    : [await prisma.reserve.findMany({ where, include, orderBy }), 0];
  const data: ReserveListItem[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    property: r.property.name,
    subcommunity: r.subcommunity?.name ?? null,
    balance: Math.round(r.transactions.reduce((s, t) => s + Number(t.amount), 0) * 100) / 100,
  }));
  return query ? { data, pagination: paginationMeta(query.page, query.pageSize, total) } : data;
}

export function listAppointments(tenantId: string): Promise<AppointmentListItem[]>;
export function listAppointments(tenantId: string, query: ListQuery): Promise<Paginated<AppointmentListItem>>;
export async function listAppointments(tenantId: string, query?: ListQuery) {
  const where = { tenantId, ...buildWhere(query, LIST_CONFIG.appointments) } as Prisma.AppointmentWhereInput;
  const orderBy = buildOrderBy(query, LIST_CONFIG.appointments, [{ start: "asc" }]) as Prisma.AppointmentOrderByWithRelationInput[];
  const [rows, total] = query
    ? await Promise.all([
        prisma.appointment.findMany({ where, include: propSel, orderBy, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
        prisma.appointment.count({ where }),
      ])
    : [await prisma.appointment.findMany({ where, include: propSel, orderBy }), 0];
  const data: AppointmentListItem[] = rows.map((a) => ({
    id: a.id,
    title: a.title,
    type: a.type,
    start: a.start.toISOString(),
    end: a.end ? a.end.toISOString() : null,
    location: a.location,
    property: a.property?.name ?? null,
  }));
  return query ? { data, pagination: paginationMeta(query.page, query.pageSize, total) } : data;
}

export function listTasks(tenantId: string): Promise<TaskListItem[]>;
export function listTasks(tenantId: string, query: ListQuery): Promise<Paginated<TaskListItem>>;
export async function listTasks(tenantId: string, query?: ListQuery) {
  const where = { tenantId, ...buildWhere(query, LIST_CONFIG.tasks) } as Prisma.TaskWhereInput;
  const orderBy = buildOrderBy(query, LIST_CONFIG.tasks, [{ done: "asc" }, { dueDate: "asc" }]) as Prisma.TaskOrderByWithRelationInput[];
  const [rows, total] = query
    ? await Promise.all([
        prisma.task.findMany({ where, orderBy, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
        prisma.task.count({ where }),
      ])
    : [await prisma.task.findMany({ where, orderBy }), 0];
  const data: TaskListItem[] = rows.map((t) => ({ id: t.id, title: t.title, dueDate: day(t.dueDate), done: t.done }));
  return query ? { data, pagination: paginationMeta(query.page, query.pageSize, total) } : data;
}

export function listContractors(tenantId: string): Promise<ContractorListItem[]>;
export function listContractors(tenantId: string, query: ListQuery): Promise<Paginated<ContractorListItem>>;
export async function listContractors(tenantId: string, query?: ListQuery) {
  const where = { tenantId, ...buildWhere(query, LIST_CONFIG.contractors) } as Prisma.ContractorWhereInput;
  const orderBy = buildOrderBy(query, LIST_CONFIG.contractors, [{ name: "asc" }]) as Prisma.ContractorOrderByWithRelationInput[];
  const [rows, total] = query
    ? await Promise.all([
        prisma.contractor.findMany({ where, orderBy, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
        prisma.contractor.count({ where }),
      ])
    : [await prisma.contractor.findMany({ where, orderBy }), 0];
  const data: ContractorListItem[] = rows.map((c) => ({ id: c.id, name: c.name, trade: c.trade, email: c.email, phone: c.phone }));
  return query ? { data, pagination: paginationMeta(query.page, query.pageSize, total) } : data;
}

export function listMaintenanceContracts(tenantId: string): Promise<MaintenanceListItem[]>;
export function listMaintenanceContracts(tenantId: string, query: ListQuery): Promise<Paginated<MaintenanceListItem>>;
export async function listMaintenanceContracts(tenantId: string, query?: ListQuery) {
  const where = { tenantId, ...buildWhere(query, LIST_CONFIG.maintenanceContracts) } as Prisma.MaintenanceContractWhereInput;
  const orderBy = buildOrderBy(query, LIST_CONFIG.maintenanceContracts, [{ nextDue: "asc" }]) as Prisma.MaintenanceContractOrderByWithRelationInput[];
  const include = { ...propSel, contractor: { select: { name: true } } } as const;
  const [rows, total] = query
    ? await Promise.all([
        prisma.maintenanceContract.findMany({ where, include, orderBy, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
        prisma.maintenanceContract.count({ where }),
      ])
    : [await prisma.maintenanceContract.findMany({ where, include, orderBy }), 0];
  const data: MaintenanceListItem[] = rows.map((m) => ({
    id: m.id,
    title: m.title,
    intervalMonths: m.intervalMonths,
    nextDue: day(m.nextDue),
    property: m.property.name,
    contractor: m.contractor?.name ?? null,
  }));
  return query ? { data, pagination: paginationMeta(query.page, query.pageSize, total) } : data;
}

export function listInsurances(tenantId: string): Promise<InsuranceListItem[]>;
export function listInsurances(tenantId: string, query: ListQuery): Promise<Paginated<InsuranceListItem>>;
export async function listInsurances(tenantId: string, query?: ListQuery) {
  const where = { tenantId, ...buildWhere(query, LIST_CONFIG.insurances) } as Prisma.InsuranceWhereInput;
  const orderBy = buildOrderBy(query, LIST_CONFIG.insurances, [{ createdAt: "asc" }]) as Prisma.InsuranceOrderByWithRelationInput[];
  const [rows, total] = query
    ? await Promise.all([
        prisma.insurance.findMany({ where, include: propSel, orderBy, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
        prisma.insurance.count({ where }),
      ])
    : [await prisma.insurance.findMany({ where, include: propSel, orderBy }), 0];
  const data: InsuranceListItem[] = rows.map((i) => ({
    id: i.id,
    type: i.type,
    insurer: i.insurer,
    policyNo: i.policyNo,
    premium: num(i.premium),
    startDate: day(i.startDate),
    endDate: day(i.endDate),
    property: i.property.name,
  }));
  return query ? { data, pagination: paginationMeta(query.page, query.pageSize, total) } : data;
}

export function listPropertyTaxes(tenantId: string): Promise<PropertyTaxListItem[]>;
export function listPropertyTaxes(tenantId: string, query: ListQuery): Promise<Paginated<PropertyTaxListItem>>;
export async function listPropertyTaxes(tenantId: string, query?: ListQuery) {
  const where = { tenantId, ...buildWhere(query, LIST_CONFIG.propertyTaxes) } as Prisma.PropertyTaxWhereInput;
  const orderBy = buildOrderBy(query, LIST_CONFIG.propertyTaxes, []) as Prisma.PropertyTaxOrderByWithRelationInput[];
  const [rows, total] = query
    ? await Promise.all([
        prisma.propertyTax.findMany({ where, include: propSel, orderBy, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
        prisma.propertyTax.count({ where }),
      ])
    : [await prisma.propertyTax.findMany({ where, include: propSel, orderBy }), 0];
  const data: PropertyTaxListItem[] = rows.map((p) => {
    const mess = p.messbetrag == null ? null : Number(p.messbetrag);
    const hebe = p.hebesatz == null ? null : Number(p.hebesatz);
    return {
      id: p.id,
      property: p.property.name,
      aktenzeichen: p.aktenzeichen,
      grundsteuerwert: num(p.grundsteuerwert),
      messbetrag: mess,
      hebesatz: hebe,
      jahresbetrag: mess != null && hebe != null ? Math.round(mess * (hebe / 100) * 100) / 100 : null,
    };
  });
  return query ? { data, pagination: paginationMeta(query.page, query.pageSize, total) } : data;
}

export async function createTask(tenantId: string, data: { title: string; dueDate?: string }) {
  const created = await prisma.task.create({
    data: { tenantId, title: data.title, dueDate: data.dueDate ? new Date(data.dueDate) : null },
  });
  return { id: created.id, title: created.title };
}

/** Portfolio-Kennzahlen (für KI/MCP-Überblick). */
export async function portfolioSummary(tenantId: string) {
  const now = new Date();
  const [propertyCount, units, leases, charges, openTickets] = await Promise.all([
    prisma.property.count({ where: { tenantId } }),
    prisma.unit.findMany({ where: { tenantId }, select: { leases: { select: { startDate: true, endDate: true } } } }),
    prisma.lease.findMany({
      where: { tenantId, startDate: { lte: now }, OR: [{ endDate: null }, { endDate: { gte: now } }] },
      include: { components: { select: { amount: true } } },
    }),
    prisma.charge.findMany({ where: { tenantId }, include: { payments: { select: { amount: true } } } }),
    prisma.ticket.count({ where: { tenantId, status: { not: "ERLEDIGT" } } }),
  ]);
  const occupied = units.filter((u) =>
    u.leases.some((l) => l.startDate <= now && (!l.endDate || l.endDate >= now)),
  ).length;
  const monthlyRent = leases.reduce(
    (a, l) => a + Number(l.rentCold) + l.components.reduce((s, c) => s + Number(c.amount), 0),
    0,
  );
  const totalOpen = charges.reduce((a, c) => {
    const open = Number(c.amount) - c.payments.reduce((s, p) => s + Number(p.amount), 0);
    return a + Math.max(0, open);
  }, 0);
  return {
    properties: propertyCount,
    units: units.length,
    occupied,
    vacant: units.length - occupied,
    monthlyRent: Math.round(monthlyRent * 100) / 100,
    openItemsTotal: Math.round(totalOpen * 100) / 100,
    openTickets,
  };
}

// --- PropertyAI (Stufe 3, D-0038): mandanten-gescopte Legal-Read-Funktionen ---
// Explizites select: es werden ausschließlich die DTO-Felder geladen. Insbesondere
// werden Lease.custom und RentAdjustment.note NIE selektiert (kein PII-Leak).

export async function getLeaseLegalContext(tenantId: string, id: string) {
  const row = await prisma.lease.findFirst({
    where: { id, tenantId },
    select: { id: true, startDate: true, endDate: true, rentCold: true, noticePeriodM: true },
  });
  if (!row) return null;
  return toLeaseLegalContextDto(row as LeaseLegalContextRow);
}

// MRC-04: vollständige, deterministische RentAdjustment-Historie (HAVEWA-04).
// Abwärtskompatibel: `items` + `pagination.count/limit` bleiben erhalten (PropertyAI
// read adapter), zusätzlich liefert `pagination.total` die GESAMTzahl und `offset`
// erlaubt das vollständige Iterieren. limit: Default 50, min 1, max 200.
export async function listLeaseRentAdjustments(tenantId: string, leaseId: string, limit: number, offset = 0) {
  // Erst den Lease strikt tenant-gescoped prüfen: fremder/unbekannter Lease -> null -> 404.
  const lease = await prisma.lease.findFirst({ where: { id: leaseId, tenantId }, select: { id: true } });
  if (!lease) return null;
  // Defense in depth: zusätzlich tenantId auf den Anpassungen filtern.
  const where = { leaseId, tenantId };
  const orderBy: Prisma.RentAdjustmentOrderByWithRelationInput[] = [{ effectiveDate: "desc" }, { id: "asc" }];
  const select = {
    id: true,
    leaseId: true,
    type: true,
    effectiveDate: true,
    newRentCold: true,
    indexBase: true,
    indexNew: true,
    applied: true,
  } as const;
  const [rows, total] = await Promise.all([
    prisma.rentAdjustment.findMany({ where, orderBy, skip: offset, take: limit, select }),
    prisma.rentAdjustment.count({ where }),
  ]);
  return toRentAdjustmentListDto(rows as RentAdjustmentRow[], limit, total, offset);
}
