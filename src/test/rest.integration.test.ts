import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma, disconnect } from "./db";
import { resetAndSeed, type Fixtures } from "./fixtures";
import { POST as recordsPost } from "@/app/api/v1/records/[entity]/route";
import { PATCH as recordsPatch, DELETE as recordsDelete } from "@/app/api/v1/records/[entity]/[id]/route";
import { GET as propertiesGet } from "@/app/api/v1/properties/route";
import { GET as propertyGet } from "@/app/api/v1/properties/[id]/route";
import { GET as meGet } from "@/app/api/v1/me/route";
import { POST as operationsPost } from "@/app/api/v1/operations/[op]/route";
import { bearerRequest } from "./request";

// REST-Integration (HAVEWA-03, Abschnitt 11). Route-Handler werden direkt
// aufgerufen (kein laufender Server) — Auth, Routing und Mandantenscope bleiben
// vollständig aktiv.

const ctx = (entity: string, id: string) => ({ params: Promise.resolve({ entity, id }) });
const entityCtx = (entity: string) => ({ params: Promise.resolve({ entity }) });
const opCtx = (op: string) => ({ params: Promise.resolve({ op }) });

describe("REST-Integration", () => {
  let fx: Fixtures;

  beforeAll(async () => {
    fx = await resetAndSeed();
  });

  afterAll(async () => {
    await disconnect();
  });

  it("invalid token → 401", async () => {
    for (const res of [
      await meGet(bearerRequest(null)),
      await meGet(bearerRequest("hvw_invalid_token")),
    ]) {
      expect(res.status).toBe(401);
    }
  });

  it("valid token → 200 (me)", async () => {
    const res = await meGet(bearerRequest(fx.tenantA.tokens.ADMIN));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.role).toBe("ADMIN");
    expect(body.summary).toBeTruthy();
  });

  it("read: Liste + Einzeldatensatz", async () => {
    const list = await propertiesGet(bearerRequest(fx.tenantA.tokens.ADMIN));
    expect(list.status).toBe(200);
    const listBody = await list.json();
    expect(Array.isArray(listBody)).toBe(true);
    expect(listBody.some((p: { id: string }) => p.id === fx.tenantA.propertyId)).toBe(true);

    const one = await propertyGet(bearerRequest(fx.tenantA.tokens.ADMIN), { params: Promise.resolve({ id: fx.tenantA.propertyId }) });
    expect(one.status).toBe(200);
    const oneBody = await one.json();
    expect(oneBody.id).toBe(fx.tenantA.propertyId);
  });

  it("foreign id → 404", async () => {
    const res = await propertyGet(bearerRequest(fx.tenantA.tokens.ADMIN), { params: Promise.resolve({ id: fx.tenantB.propertyId }) });
    expect(res.status).toBe(404);
  });

  it("create → 201", async () => {
    const res = await recordsPost(
      bearerRequest(fx.tenantA.tokens.ADMIN, { method: "POST", body: { title: "REST-Aufgabe" } }),
      entityCtx("task"),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBeTruthy();
  });

  it("update → 200", async () => {
    const res = await recordsPatch(
      bearerRequest(fx.tenantA.tokens.ADMIN, { method: "PATCH", body: { title: "geändert" } }),
      ctx("task", fx.tenantA.taskId),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.updated).toBe(1);
  });

  it("delete → 200", async () => {
    const created = await prisma.task.create({ data: { tenantId: fx.tenantA.id, title: "zu löschen" } });
    const res = await recordsDelete(bearerRequest(fx.tenantA.tokens.ADMIN, { method: "DELETE" }), ctx("task", created.id));
    expect(res.status).toBe(200);
    expect(await prisma.task.findUnique({ where: { id: created.id } })).toBeNull();
  });

  it("validation error → 400", async () => {
    const res = await recordsPost(bearerRequest(fx.tenantA.tokens.ADMIN, { method: "POST", body: {} }), entityCtx("task"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  it("not found → 404", async () => {
    const res = await recordsPatch(
      bearerRequest(fx.tenantA.tokens.ADMIN, { method: "PATCH", body: { title: "x" } }),
      ctx("task", "nonexistent-id"),
    );
    expect(res.status).toBe(404);
  });

  it("operation: low-risk Operation wird ausgeführt", async () => {
    const res = await operationsPost(
      bearerRequest(fx.tenantA.tokens.ADMIN, { method: "POST", body: { id: fx.tenantA.taskId } }),
      opCtx("toggle_task"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.done).toBe(true);
  });
});
