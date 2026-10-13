import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma, disconnect } from "./db";
import { resetAndSeed, type Fixtures } from "./fixtures";
import { POST as mcpPost } from "@/app/api/mcp/route";
import { claimApproval, executeApproval } from "@/lib/mcp-approval";
import { isEncryptedSecret } from "@/lib/crypto";
import { mcpRequest } from "./request";

// MCP-Integration (HAVEWA-03, Abschnitt 12): vollständiger Pfad
// MCP-Request → Approval-Persistenz → Approval-Aktion → Ausführung.

interface McpResult {
  isError?: boolean;
  text: string;
  json?: unknown;
}

async function call(rawToken: string, name: string, args: unknown): Promise<McpResult> {
  const res = await mcpPost(mcpRequest(rawToken, "tools/call", { name, arguments: args }));
  const body = await res.json();
  const content = body.result?.content?.[0];
  const text = content?.text ?? "";
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { isError: body.result?.isError, text, json };
}

function approvalIdOf(r: McpResult): string {
  return String((r.json as { approvalId: string }).approvalId);
}

describe("MCP-Integration", () => {
  let fx: Fixtures;

  beforeAll(async () => {
    fx = await resetAndSeed();
  });

  afterAll(async () => {
    await disconnect();
  });

  it("tools/list liefert die Tool-Liste", async () => {
    const res = await mcpPost(mcpRequest(fx.tenantA.tokens.ADMIN, "tools/list"));
    const body = await res.json();
    const names = body.result.tools.map((t: { name: string }) => t.name);
    for (const n of ["portfolio_summary", "list_properties", "create_record", "run_operation", "delete_record"]) {
      expect(names).toContain(n);
    }
  });

  it("read tool liefert Bestandsdaten", async () => {
    const r = await call(fx.tenantA.tokens.ADMIN, "portfolio_summary", {});
    expect(r.isError).toBeFalsy();
    expect((r.json as { properties: number }).properties).toBeGreaterThan(0);
  });

  it("low-risk write (create_task) wird sofort ausgeführt", async () => {
    const r = await call(fx.tenantA.tokens.VERWALTER, "create_task", { title: "MCP-Task" });
    expect(r.isError).toBeFalsy();
    expect((r.json as { id: string }).id).toBeTruthy();
  });

  it("material write (delete_record) → APPROVAL_REQUIRED, Aktion NICHT ausgeführt", async () => {
    const r = await call(fx.tenantA.tokens.ADMIN, "delete_record", { entity: "task", id: fx.tenantA.taskId });
    expect(r.isError).toBeFalsy();
    expect((r.json as { status: string }).status).toBe("APPROVAL_REQUIRED");

    const approvalId = approvalIdOf(r);
    // Persistiert, PENDING, args verschlüsselt at-rest.
    const row = await prisma.mcpApproval.findUniqueOrThrow({ where: { id: approvalId } });
    expect(row.status).toBe("PENDING");
    expect(isEncryptedSecret(row.argsEnc)).toBe(true);

    // Aktion wurde NICHT ausgeführt.
    expect(await prisma.task.findUnique({ where: { id: fx.tenantA.taskId } })).not.toBeNull();
  });

  it("voller Pfad: Freigabe → Ausführung löscht den Datensatz", async () => {
    const task = await prisma.task.create({ data: { tenantId: fx.tenantA.id, title: "delete-me" } });
    const r = await call(fx.tenantA.tokens.ADMIN, "delete_record", { entity: "task", id: task.id });
    const approvalId = approvalIdOf(r);

    const claimed = await claimApproval(approvalId, fx.tenantA.id, fx.tenantA.users.ADMIN, "APPROVED");
    expect(claimed).toBe(true);

    const approval = await prisma.mcpApproval.findUniqueOrThrow({ where: { id: approvalId } });
    const result = await executeApproval(approval, { userId: fx.tenantA.users.ADMIN, tenantId: fx.tenantA.id, role: "ADMIN", name: "ADMIN alpha" });
    expect(result).toEqual({ id: task.id, deleted: 1 });

    await prisma.mcpApproval.update({ where: { id: approvalId }, data: { outcome: "OK", executedAt: new Date() } });

    expect(await prisma.task.findUnique({ where: { id: task.id } })).toBeNull();
    const after = await prisma.mcpApproval.findUniqueOrThrow({ where: { id: approvalId } });
    expect(after.outcome).toBe("OK");
    expect(after.executedAt).not.toBeNull();
  });

  it("reject: abgelehnte Freigabe führt die Aktion nie aus", async () => {
    const r = await call(fx.tenantA.tokens.ADMIN, "delete_record", { entity: "task", id: fx.tenantA.taskId });
    const approvalId = approvalIdOf(r);
    const claimed = await claimApproval(approvalId, fx.tenantA.id, fx.tenantA.users.ADMIN, "REJECTED");
    expect(claimed).toBe(true);
    expect(await prisma.task.findUnique({ where: { id: fx.tenantA.taskId } })).not.toBeNull();
  });

  it("wrong tenant: Mandant B kann Freigabe von Mandant A nicht claimen", async () => {
    const r = await call(fx.tenantA.tokens.ADMIN, "delete_record", { entity: "task", id: fx.tenantA.taskId });
    const approvalId = approvalIdOf(r);
    const claimed = await claimApproval(approvalId, fx.tenantB.id, fx.tenantB.users.ADMIN, "APPROVED");
    expect(claimed).toBe(false);
    const row = await prisma.mcpApproval.findUniqueOrThrow({ where: { id: approvalId } });
    expect(row.status).toBe("PENDING");
  });

  it("wrong role: MIETER wird beim Write-Tool blockiert", async () => {
    const r = await call(fx.tenantA.tokens.MIETER, "create_record", { entity: "task", data: { title: "x" } });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Keine Schreibberechtigung");
  });

  it("admin-only: VERWALTER darf update_ai_config nicht ausführen", async () => {
    const r = await call(fx.tenantA.tokens.VERWALTER, "run_operation", { operation: "update_ai_config", args: { provider: "anthropic" } });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Nur Administratoren");
  });

  it("replay: bereits entschiedene Freigabe kann nicht erneut geclaimt werden", async () => {
    const r = await call(fx.tenantA.tokens.ADMIN, "delete_record", { entity: "task", id: fx.tenantA.taskId });
    const approvalId = approvalIdOf(r);
    expect(await claimApproval(approvalId, fx.tenantA.id, fx.tenantA.users.ADMIN, "APPROVED")).toBe(true);
    expect(await claimApproval(approvalId, fx.tenantA.id, fx.tenantA.users.ADMIN, "APPROVED")).toBe(false);
  });

  it("execution failure: Ausführung einer freigegebenen, aber ungültigen Aktion schlägt fehl", async () => {
    const r = await call(fx.tenantA.tokens.ADMIN, "delete_record", { entity: "task", id: "nonexistent" });
    const approvalId = approvalIdOf(r);
    expect(await claimApproval(approvalId, fx.tenantA.id, fx.tenantA.users.ADMIN, "APPROVED")).toBe(true);
    const approval = await prisma.mcpApproval.findUniqueOrThrow({ where: { id: approvalId } });
    await expect(
      executeApproval(approval, { userId: fx.tenantA.users.ADMIN, tenantId: fx.tenantA.id, role: "ADMIN", name: "ADMIN alpha" }),
    ).rejects.toThrow();
  });
});
