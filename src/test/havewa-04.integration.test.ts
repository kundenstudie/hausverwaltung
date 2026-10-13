import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma, disconnect } from "./db";
import { resetAndSeed, type Fixtures } from "./fixtures";
import { bearerRequest } from "./request";
import { listCharges, listTasks, listTickets, listLeaseRentAdjustments } from "@/lib/api-data";
import { GET as propertiesGet } from "@/app/api/v1/properties/route";
import { GET as ticketsGet } from "@/app/api/v1/tickets/route";
import { isValidIanaTimezone } from "@/lib/timezone";

// HAVEWA-04: Pagination-/Filter-/Sort-Contract, MRC-04 (RentAdjustment-Historie)
// und Tenant-Timezone. Route-Handler werden direkt aufgerufen (kein Server),
// Auth/Mandantenscope bleiben vollständig aktiv.

async function createCharges(tenantId: string, n: number, fromMonth = 2) {
  for (let i = 0; i < n; i++) {
    await prisma.charge.create({
      data: {
        tenantId,
        type: "MIETE",
        period: new Date(Date.UTC(2026, fromMonth + i, 1)),
        dueDate: new Date(Date.UTC(2026, fromMonth + i, 15)),
        amount: 100 + i,
      },
    });
  }
}

describe("HAVEWA-04 Pagination/Filter/Sort", () => {
  let fx: Fixtures;

  beforeAll(async () => {
    fx = await resetAndSeed();
  });

  afterAll(async () => {
    await disconnect();
  });

  it("Legacy-Kompatibilität: ohne Parameter bleibt die Antwort ein Array", async () => {
    const res = await propertiesGet(bearerRequest(fx.tenantA.tokens.ADMIN, { url: "http://test.local/api/v1/properties" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.some((p: { id: string }) => p.id === fx.tenantA.propertyId)).toBe(true);
  });

  it("mit page-Parameter liefert die Route ein Envelope { data, pagination }", async () => {
    const res = await propertiesGet(bearerRequest(fx.tenantA.tokens.ADMIN, { url: "http://test.local/api/v1/properties?page=1" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; pagination: Record<string, unknown> };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.pagination).toMatchObject({ page: 1, pageSize: 50, total: 1, totalPages: 1, hasNext: false, hasPrevious: false });
  });

  it("invalid page → 400", async () => {
    for (const q of ["page=0", "page=-1", "page=abc"]) {
      const res = await propertiesGet(bearerRequest(fx.tenantA.tokens.ADMIN, { url: `http://test.local/api/v1/properties?${q}` }));
      expect(res.status, q).toBe(400);
    }
  });

  it("too-large pageSize → 400 (hartes Maximum)", async () => {
    const res = await propertiesGet(bearerRequest(fx.tenantA.tokens.ADMIN, { url: "http://test.local/api/v1/properties?pageSize=201" }));
    expect(res.status).toBe(400);
  });

  it("invalid sort → 400; valid sort akzeptiert", async () => {
    const bad = await propertiesGet(bearerRequest(fx.tenantA.tokens.ADMIN, { url: "http://test.local/api/v1/properties?sort=nope" }));
    expect(bad.status).toBe(400);
    const ok = await propertiesGet(bearerRequest(fx.tenantA.tokens.ADMIN, { url: "http://test.local/api/v1/properties?sort=name" }));
    expect(ok.status).toBe(200);
  });

  it("total count, page, pageSize, letzte/leere Seite und deterministische Ordnung", async () => {
    await createCharges(fx.tenantA.id, 9); // + Seed = 10 Sollstellungen
    const total = await prisma.charge.count({ where: { tenantId: fx.tenantA.id } });
    expect(total).toBe(10);

    const page1 = await listCharges(fx.tenantA.id, { page: 1, pageSize: 3, sort: "dueDate", order: "asc", filters: {} });
    expect(page1.data.length).toBe(3);
    expect(page1.pagination.total).toBe(total);
    expect(page1.pagination.totalPages).toBe(4);
    expect(page1.pagination.hasNext).toBe(true);
    expect(page1.pagination.hasPrevious).toBe(false);

    const page4 = await listCharges(fx.tenantA.id, { page: 4, pageSize: 3, sort: "dueDate", order: "asc", filters: {} });
    expect(page4.data.length).toBe(1);
    expect(page4.pagination.hasNext).toBe(false);
    expect(page4.pagination.hasPrevious).toBe(true);

    const page5 = await listCharges(fx.tenantA.id, { page: 5, pageSize: 3, sort: "dueDate", order: "asc", filters: {} });
    expect(page5.data.length).toBe(0);

    // Deterministische Ordnung: aufsteigend nach dueDate.
    const allAsc = await listCharges(fx.tenantA.id, { page: 1, pageSize: 100, sort: "dueDate", order: "asc", filters: {} });
    const dates = allAsc.data.map((c) => c.dueDate!);
    expect([...dates].sort()).toEqual(dates);

    // desc: absteigend.
    const allDesc = await listCharges(fx.tenantA.id, { page: 1, pageSize: 100, sort: "dueDate", order: "desc", filters: {} });
    const datesDesc = allDesc.data.map((c) => c.dueDate!);
    expect([...datesDesc].sort().reverse()).toEqual(datesDesc);
  });

  it("erlaubter Filter wirkt; ungültiger Filter → 400 (Route)", async () => {
    const filtered = await listTickets(fx.tenantA.id, { page: 1, pageSize: 50, sort: "createdAt", order: "desc", filters: { status: "OFFEN" } });
    expect(filtered.data.every((t) => t.status === "OFFEN")).toBe(true);

    const bad = await ticketsGet(bearerRequest(fx.tenantA.tokens.ADMIN, { url: "http://test.local/api/v1/tickets?status=UNBEKANNT" }));
    expect(bad.status).toBe(400);
  });

  it("Cross-Tenant-Filter liefert leer (kein Existenz-Leak)", async () => {
    // propertyId von Mandant B darf für Mandant A nichts liefern (Ticket-Filter).
    const res = await listTickets(fx.tenantA.id, { page: 1, pageSize: 50, sort: "createdAt", order: "desc", filters: { propertyId: fx.tenantB.propertyId } });
    expect(res.data.length).toBe(0);
    expect(res.pagination.total).toBe(0);
  });

  it("boolean-Filter (tasks.done) funktioniert", async () => {
    await prisma.task.create({ data: { tenantId: fx.tenantA.id, title: "erledigt", done: true } });
    const done = await listTasks(fx.tenantA.id, { page: 1, pageSize: 50, sort: "createdAt", order: "asc", filters: { done: "true" } });
    expect(done.data.length).toBeGreaterThan(0);
    expect(done.data.every((t) => t.done === true)).toBe(true);
  });
});

describe("HAVEWA-04 MRC-04 (RentAdjustment-Historie)", () => {
  let fx: Fixtures;

  beforeAll(async () => {
    fx = await resetAndSeed();
  });

  afterAll(async () => {
    await disconnect();
  });

  it("mehr als Default-pageSize: vollständig + deterministisch iterierbar", async () => {
    const N = 75;
    for (let i = 0; i < N; i++) {
      await prisma.rentAdjustment.create({
        data: {
          tenantId: fx.tenantA.id,
          leaseId: fx.tenantA.leaseId,
          type: i % 2 === 0 ? "STAFFEL" : "INDEX",
          effectiveDate: new Date(Date.UTC(2025, 0, 1 + (i % 28))),
          newRentCold: 800 + i,
          applied: false,
        },
      });
    }

    const collected: string[] = [];
    let offset = 0;
    let total = -1;
    const limit = 20;
    for (;;) {
      const page = await listLeaseRentAdjustments(fx.tenantA.id, fx.tenantA.leaseId, limit, offset);
      expect(page).not.toBeNull();
      const p = page!;
      if (total === -1) total = p.pagination.total;
      expect(p.pagination.total).toBe(N); // vollständige Gesamtzahl (kein stilles Abschneiden)
      expect(p.pagination.count).toBe(p.items.length);
      collected.push(...p.items.map((x) => x.id));
      if (p.items.length < limit) break;
      offset += limit;
    }

    expect(total).toBe(N);
    // keine Duplikate → deterministisch, vollständig.
    expect(new Set(collected).size).toBe(N);
    expect(collected.length).toBe(N);
  });

  it("fremder Lease → null (404 auf Route-Ebene)", async () => {
    expect(await listLeaseRentAdjustments(fx.tenantA.id, fx.tenantB.leaseId, 50, 0)).toBeNull();
  });
});

describe("HAVEWA-04 Tenant Timezone", () => {
  let fx: Fixtures;

  beforeAll(async () => {
    fx = await resetAndSeed();
  });

  afterAll(async () => {
    await disconnect();
  });

  it("bestehende Tenants defaulten auf Europe/Berlin", async () => {
    const t = await prisma.tenant.findUniqueOrThrow({ where: { id: fx.tenantA.id } });
    expect(t.timeZone).toBe("Europe/Berlin");
  });

  it("Mandant A kann eine andere Zeitzone als Mandant B haben", async () => {
    await prisma.tenant.update({ where: { id: fx.tenantA.id }, data: { timeZone: "Europe/Vienna" } });
    const a = await prisma.tenant.findUniqueOrThrow({ where: { id: fx.tenantA.id } });
    const b = await prisma.tenant.findUniqueOrThrow({ where: { id: fx.tenantB.id } });
    expect(a.timeZone).toBe("Europe/Vienna");
    expect(b.timeZone).toBe("Europe/Berlin");
    expect(a.timeZone).not.toBe(b.timeZone);
  });

  it("nur gültige IANA-Zeitzonen sind erlaubt", () => {
    expect(isValidIanaTimezone("Europe/Vienna")).toBe(true);
    expect(isValidIanaTimezone("Europe/Berlin")).toBe(true);
    expect(isValidIanaTimezone("Invalid/Zone")).toBe(false);
  });

  it("Zeitzone ändert die UTC-Persistenz nicht (absolute Timestamps bleiben)", async () => {
    const before = await prisma.charge.findUniqueOrThrow({ where: { id: fx.tenantA.chargeId } });
    const dueBefore = before.dueDate.getTime();
    await prisma.tenant.update({ where: { id: fx.tenantA.id }, data: { timeZone: "America/New_York" } });
    const after = await prisma.charge.findUniqueOrThrow({ where: { id: fx.tenantA.chargeId } });
    expect(after.dueDate.getTime()).toBe(dueBefore);
  });
});
