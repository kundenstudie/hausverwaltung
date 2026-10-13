import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { disconnect } from "./db";
import { resetAndSeed, principalFor, ROLES, type Fixtures, type RoleName } from "./fixtures";
import { roleAllows, WRITE_ROLES } from "@/lib/rbac";
import { apiCreate, ApiWriteError } from "@/lib/api-write";
import { runOperation } from "@/lib/api-ops";
import { POST as mcpPost } from "@/app/api/mcp/route";
import { mcpRequest } from "./request";

// Rollen-Matrix (HAVEWA-03, Abschnitt 10): reale, integrierte Permission-Checks
// für alle sieben Rollen (ADMIN, VERWALTER, BUCHHALTUNG, BEIRAT, EIGENTUEMER,
// MIETER, HANDWERKER).

const WRITERS: RoleName[] = ["ADMIN", "VERWALTER", "BUCHHALTUNG"];
const READERS: RoleName[] = ["BEIRAT", "EIGENTUEMER", "MIETER", "HANDWERKER"];

describe("Rollen-Matrix", () => {
  let fx: Fixtures;

  beforeAll(async () => {
    fx = await resetAndSeed();
  });

  afterAll(async () => {
    await disconnect();
  });

  it("roleAllows: nur ADMIN/VERWALTER/BUCHHALTUNG haben Schreibrecht", () => {
    for (const role of ROLES) {
      expect(roleAllows(role, WRITE_ROLES), role).toBe(WRITERS.includes(role));
    }
  });

  it("apiCreate: Nicht-Schreiber werden abgelehnt, Schreiber dürfen", async () => {
    for (const role of READERS) {
      const p = principalFor(fx, "tenantA", role);
      await expect(apiCreate(p, "task", { title: `t-${role}` })).rejects.toSatisfy(
        (e: unknown) => e instanceof ApiWriteError && e.status === 403 && e.message === "Keine Schreibberechtigung",
      );
    }
    for (const role of WRITERS) {
      const p = principalFor(fx, "tenantA", role);
      const r = await apiCreate(p, "task", { title: `t-${role}` });
      expect(r.id).toBeTruthy();
    }
  });

  it("runOperation: adminOnly-Operation ist Nicht-Admins verwehrt", async () => {
    const verwalter = principalFor(fx, "tenantA", "VERWALTER");
    await expect(runOperation(verwalter, "update_ai_config", { provider: "anthropic" })).rejects.toSatisfy(
      (e: unknown) => e instanceof ApiWriteError && e.status === 403 && e.message === "Nur Administratoren",
    );
    const admin = principalFor(fx, "tenantA", "ADMIN");
    await expect(runOperation(admin, "update_ai_config", { provider: "anthropic" })).resolves.toEqual({ ok: true });
  });

  it("MCP-Gate: Nicht-Schreiber (MIETER) wird beim Write-Tool blockiert", async () => {
    const res = await mcpPost(
      mcpRequest(fx.tenantA.tokens.MIETER, "tools/call", { name: "create_record", arguments: { entity: "task", data: { title: "x" } } }),
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("Keine Schreibberechtigung");
  });

  it("MCP-Gate: Schreiber (VERWALTER) darf low-risk Write ausführen", async () => {
    const res = await mcpPost(
      mcpRequest(fx.tenantA.tokens.VERWALTER, "tools/call", { name: "create_record", arguments: { entity: "task", data: { title: "via-mcp" } } }),
    );
    const body = await res.json();
    const text = body.result.content[0].text;
    expect(text).toContain('"id"');
  });

  it("MCP-Gate: admin-only Aktion ist für VERWALTER verboten, für ADMIN nur mit Freigabe", async () => {
    const verwalterRes = await mcpPost(
      mcpRequest(fx.tenantA.tokens.VERWALTER, "tools/call", { name: "run_operation", arguments: { operation: "update_ai_config", args: { provider: "anthropic" } } }),
    );
    const vBody = await verwalterRes.json();
    expect(vBody.result.isError).toBe(true);
    expect(vBody.result.content[0].text).toContain("Nur Administratoren");

    const adminRes = await mcpPost(
      mcpRequest(fx.tenantA.tokens.ADMIN, "tools/call", { name: "run_operation", arguments: { operation: "update_ai_config", args: { provider: "anthropic" } } }),
    );
    const aBody = await adminRes.json();
    expect(aBody.result.content[0].text).toContain("APPROVAL_REQUIRED");
  });
});
