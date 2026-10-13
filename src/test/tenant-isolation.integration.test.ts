import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { disconnect } from "./db";
import { resetAndSeed, principalFor, type Fixtures } from "./fixtures";
import * as data from "@/lib/api-data";
import { apiUpdate, apiDelete, apiCreate, ApiWriteError } from "@/lib/api-write";
import { PATCH as recordsPatch, DELETE as recordsDelete } from "@/app/api/v1/records/[entity]/[id]/route";
import { GET as propertyGet } from "@/app/api/v1/properties/[id]/route";
import { POST as mcpPost } from "@/app/api/mcp/route";
import { bearerRequest, mcpRequest } from "./request";

// Tenant-Isolation (HAVEWA-03, Abschnitt 9): Mandant A darf Mandant B weder
// lesen, ändern noch löschen — über serverseitige Pfade, REST und MCP.

async function expectStatus(p: Promise<Response>, status: number) {
  const r = await p;
  expect(r.status).toBe(status);
  return r;
}

function isApiError(e: unknown, message: string, status: number) {
  return e instanceof ApiWriteError && e.message === message && e.status === status;
}

describe("Tenant-Isolation", () => {
  let fx: Fixtures;

  beforeAll(async () => {
    fx = await resetAndSeed();
  });

  afterAll(async () => {
    await disconnect();
  });

  it("Lesen: List-Endpunkte von Mandant B enthalten keine Datensätze von Mandant A", async () => {
    const checks: Array<[string, (tenantId: string) => Promise<Array<{ id: string }>>, string]> = [
      ["property", data.listProperties, fx.tenantA.propertyId],
      ["unit", data.listUnits, fx.tenantA.unitId],
      ["person", data.listPersons, fx.tenantA.personId],
      ["lease", data.listLeases, fx.tenantA.leaseId],
      ["charge", data.listCharges, fx.tenantA.chargeId],
      ["payment", data.listPayments, fx.tenantA.paymentId],
      ["document", data.listDocuments, fx.tenantA.documentId],
      ["task", data.listTasks, fx.tenantA.taskId],
      ["ticket", data.listTickets, fx.tenantA.ticketId],
    ];
    for (const [name, fn, foreignId] of checks) {
      const rows = await fn(fx.tenantB.id);
      expect(rows.some((r) => r.id === foreignId), `${name}: fremder Datensatz darf nicht sichtbar sein`).toBe(false);
    }
  });

  it("Lesen: getProperty(foreign id) liefert null", async () => {
    expect(await data.getProperty(fx.tenantB.id, fx.tenantA.propertyId)).toBeNull();
  });

  it("Löschen: Mandant B kann Datensätze von Mandant A nicht löschen", async () => {
    const pB = principalFor(fx, "tenantB", "ADMIN");
    const entities: Array<[string, string]> = [
      ["property", fx.tenantA.propertyId],
      ["unit", fx.tenantA.unitId],
      ["person", fx.tenantA.personId],
      ["lease", fx.tenantA.leaseId],
      ["charge", fx.tenantA.chargeId],
      ["payment", fx.tenantA.paymentId],
      ["task", fx.tenantA.taskId],
      ["ticket", fx.tenantA.ticketId],
    ];
    for (const [entity, id] of entities) {
      try {
        await apiDelete(pB, entity, id);
        throw new Error(`${entity}: sollte ApiWriteError werfen`);
      } catch (e) {
        expect(isApiError(e, "Nicht gefunden", 404), `${entity}: fremde ID → 404`).toBe(true);
      }
    }
  });

  it("Ändern: Mandant B kann Datensätze von Mandant A nicht ändern", async () => {
    const pB = principalFor(fx, "tenantB", "ADMIN");
    const attempts: Array<[string, string, Record<string, unknown>]> = [
      ["property", fx.tenantA.propertyId, { name: "x", street: "s", zip: "1", city: "c", type: "WOHNEN", management: "MIET", feeType: "PAUSCHAL" }],
      ["task", fx.tenantA.taskId, { title: "x" }],
      ["ticket", fx.tenantA.ticketId, { title: "x", category: "SONSTIGES", priority: "MITTEL", status: "ERLEDIGT" }],
    ];
    for (const [entity, id, body] of attempts) {
      try {
        await apiUpdate(pB, entity, id, body);
        throw new Error(`${entity}: sollte ApiWriteError werfen`);
      } catch (e) {
        expect(isApiError(e, "Nicht gefunden", 404), `${entity}: fremde ID → 404`).toBe(true);
      }
    }
  });

  it("Anlegen mit fremder Relation wird abgelehnt (checkRelations)", async () => {
    const pB = principalFor(fx, "tenantB", "ADMIN");
    // Datum als ISO-String statt Date-Objekt: apiCreate erhält über REST/MCP
    // JSON-Bodies (Daten sind dort Strings); ein Date-Objekt würde in normalize()
    // via JSON.stringify zu "\"2026-…\"" und damit VOR dem Relation-Check eine
    // andere Validation werfen (verdeckt die Tenant-Isolation-Prüfung).
    try {
      await apiCreate(pB, "charge", { leaseId: fx.tenantA.leaseId, type: "MIETE", period: "2026-01-01", dueDate: "2026-01-05", amount: 100 });
      throw new Error("charge: sollte ApiWriteError werfen");
    } catch (e) {
      expect(isApiError(e, "leaseId: nicht gefunden", 400)).toBe(true);
    }
    try {
      await apiCreate(pB, "payment", { chargeId: fx.tenantA.chargeId, date: "2026-01-05", amount: 100, direction: "EINGANG" });
      throw new Error("payment: sollte ApiWriteError werfen");
    } catch (e) {
      expect(isApiError(e, "chargeId: nicht gefunden", 400)).toBe(true);
    }
  });

  it("REST: fremde ID über PATCH/DELETE/GET → 404", async () => {
    const tokB = fx.tenantB.tokens.ADMIN;
    const patchCtx = { params: Promise.resolve({ entity: "property", id: fx.tenantA.propertyId }) };
    await expectStatus(recordsPatch(bearerRequest(tokB, { method: "PATCH", body: { name: "x", street: "s", zip: "1", city: "c", type: "WOHNEN", management: "MIET", feeType: "PAUSCHAL" } }), patchCtx), 404);
    await expectStatus(recordsDelete(bearerRequest(tokB, { method: "DELETE" }), patchCtx), 404);
    await expectStatus(propertyGet(bearerRequest(tokB), { params: Promise.resolve({ id: fx.tenantA.propertyId }) }), 404);
  });

  it("MCP: list_properties/get_property von Mandant B sehen keine Daten von Mandant A", async () => {
    const tokB = fx.tenantB.tokens.ADMIN;

    const listRes = await mcpPost(mcpRequest(tokB, "tools/call", { name: "list_properties", arguments: {} }));
    const listBody = await listRes.json();
    const listText = listBody.result.content[0].text;
    expect(listText).not.toContain(fx.tenantA.propertyId);

    const getRes = await mcpPost(mcpRequest(tokB, "tools/call", { name: "get_property", arguments: { id: fx.tenantA.propertyId } }));
    const getBody = await getRes.json();
    const getText = getBody.result.content[0].text;
    expect(getText).toBe("null");
  });
});
