import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma, disconnect } from "./db";
import { resetAndSeed, principalFor, type Fixtures } from "./fixtures";
import { runOperation } from "@/lib/api-ops";
import { listOpenItems, listDocuments, listMeters } from "@/lib/api-data";
import { apiUpdate } from "@/lib/api-write";
import { computeStatement } from "@/server/statements";

// Repräsentative Kern-Fachflüsse (HAVEWA-03, Abschnitt 14), gegen die echte
// Test-DB: Lease→Sollstellung, Charge→Payment→Offener Posten, Mahnung→Stufe/
// Gebühr, Betriebskosten→Berechnung, Zähler→Verbrauch, Dokument→Abruf,
// Aufgabe/Ticket→Statuswechsel.

describe("Core-Integration-Flows", () => {
  let fx: Fixtures;

  beforeAll(async () => {
    fx = await resetAndSeed();
  });

  afterAll(async () => {
    await disconnect();
  });

  const admin = () => principalFor(fx, "tenantA", "ADMIN");

  it("Lease → Sollstellungslauf erzeugt Monats-Sollstellung", async () => {
    const r = await runOperation(admin(), "run_charge_generation", { month: "2026-02" });
    expect((r as { created: number }).created).toBe(1);
    const charge = await prisma.charge.findFirst({
      where: { tenantId: fx.tenantA.id, leaseId: fx.tenantA.leaseId, type: "MIETE", period: new Date(Date.UTC(2026, 1, 1)) },
    });
    expect(charge).not.toBeNull();
  });

  it("Charge → Payment → offener Posten", async () => {
    const items = await listOpenItems(fx.tenantA.id);
    const item = items.find((i) => i.id === fx.tenantA.chargeId);
    expect(item).toBeTruthy();
    // 800 Soll − 400 Zahlung = 400 offen
    expect(item!.open).toBe(400);
  });

  it("Mahnlauf erzeugt Mahnstufe mit Gebühr (Dunning → state/fee)", async () => {
    // Der vorherige Test "Sollstellungslauf" hat für Mandant A eine zweite
    // überfällige Sollstellung (2026-02) erzeugt. run_dunning mahnt ALLE
    // überfälligen offenen Posten → 2 (Seed-Sollstellung + Lauf-Sollstellung).
    const first = await runOperation(admin(), "run_dunning", {});
    expect((first as { dunned: number }).dunned).toBe(2);
    const level1 = await prisma.dunningNotice.findFirst({ where: { tenantId: fx.tenantA.id, chargeId: fx.tenantA.chargeId, level: 1 } });
    expect(level1).not.toBeNull();
    expect(Number(level1!.fee)).toBe(0);

    const second = await runOperation(admin(), "run_dunning", {});
    expect((second as { dunned: number }).dunned).toBe(2);
    const level2 = await prisma.dunningNotice.findFirst({ where: { tenantId: fx.tenantA.id, chargeId: fx.tenantA.chargeId, level: 2 } });
    expect(level2).not.toBeNull();
    expect(Number(level2!.fee)).toBe(5);
  });

  it("Betriebskosten: DB-Inputs → Berechnung (computeStatement)", async () => {
    await prisma.costEntry.create({
      data: { tenantId: fx.tenantA.id, propertyId: fx.tenantA.propertyId, year: 2025, type: "WASSER", amount: 200, method: "AREA" },
    });
    const st = await computeStatement(fx.tenantA.id, fx.tenantA.propertyId, 2025);
    expect(st.property).not.toBeNull();
    expect(st.costs.some((c) => c.type === "WASSER" && Number(c.amount) === 200)).toBe(true);
    expect(st.units.some((u) => u.id === fx.tenantA.unitId)).toBe(true);
    expect(typeof st.totalUmlage).toBe("number");
  });

  it("Zähler → letzter Zählerstand wird zurückgegeben", async () => {
    const meter = await prisma.meter.create({ data: { tenantId: fx.tenantA.id, unitId: fx.tenantA.unitId, type: "STROM", serialNo: "SN-1" } });
    await prisma.meterReading.create({ data: { tenantId: fx.tenantA.id, meterId: meter.id, date: new Date("2026-01-01"), value: 100 } });
    await prisma.meterReading.create({ data: { tenantId: fx.tenantA.id, meterId: meter.id, date: new Date("2026-02-01"), value: 250 } });

    const meters = await listMeters(fx.tenantA.id);
    const m = meters.find((x) => x.id === meter.id);
    expect(m).toBeTruthy();
    expect(m!.lastReading?.value).toBe(250);
  });

  it("Dokument-Metadaten → Abruf", async () => {
    const docs = await listDocuments(fx.tenantA.id);
    const d = docs.find((x) => x.id === fx.tenantA.documentId);
    expect(d).toBeTruthy();
    expect(d!.name).toContain("vertrag-alpha");
    expect(d!.mime).toBe("application/pdf");
  });

  it("Aufgabe/Ticket → Statuswechsel", async () => {
    const toggled = await runOperation(admin(), "toggle_task", { id: fx.tenantA.taskId });
    expect((toggled as { done: boolean }).done).toBe(true);

    const time = await runOperation(admin(), "add_ticket_time", { id: fx.tenantA.ticketId, minutes: 30 });
    expect((time as { added: number }).added).toBe(30);
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: fx.tenantA.ticketId } });
    expect(ticket.timeSpentMin).toBe(30);

    await apiUpdate(admin(), "ticket", fx.tenantA.ticketId, { title: "Ticket alpha", category: "SCHADEN", priority: "MITTEL", status: "ERLEDIGT" });
    const updated = await prisma.ticket.findUniqueOrThrow({ where: { id: fx.tenantA.ticketId } });
    expect(updated.status).toBe("ERLEDIGT");
  });
});
