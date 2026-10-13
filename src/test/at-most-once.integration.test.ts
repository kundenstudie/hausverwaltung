import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma, disconnect } from "./db";
import { resetAndSeed, principalFor, type Fixtures } from "./fixtures";
import { gateMcpTool, claimApproval } from "@/lib/mcp-approval";

// At-most-once (HAVEWA-03, Abschnitt 13). KEINE exactly-once-Behauptung: die
// Garantie ist single-claim (Replay-/Doppel-Ausführung blockiert), ein Crash
// nach dem Claim darf die Aktion verlieren (EXECUTION_UNKNOWN, kein Retry).

describe("At-most-once", () => {
  let fx: Fixtures;

  beforeAll(async () => {
    fx = await resetAndSeed();
  });

  afterAll(async () => {
    await disconnect();
  });

  async function createApproval() {
    const p = principalFor(fx, "tenantA", "ADMIN");
    const gate = await gateMcpTool(p, "delete_record", { entity: "task", id: fx.tenantA.taskId });
    if (gate.kind !== "approval_required") throw new Error("erwartete approval_required");
    return gate.approvalId;
  }

  it("concurrent approvals: genau ein Claim gewinnt", async () => {
    const approvalId = await createApproval();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => claimApproval(approvalId, fx.tenantA.id, fx.tenantA.users.ADMIN, "APPROVED")),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    const row = await prisma.mcpApproval.findUniqueOrThrow({ where: { id: approvalId } });
    expect(row.status).toBe("APPROVED");
  });

  it("replay blockiert: zweiter Claim nach APPROVED schlägt fehl", async () => {
    const approvalId = await createApproval();
    expect(await claimApproval(approvalId, fx.tenantA.id, fx.tenantA.users.ADMIN, "APPROVED")).toBe(true);
    expect(await claimApproval(approvalId, fx.tenantA.id, fx.tenantA.users.ADMIN, "APPROVED")).toBe(false);
    expect(await claimApproval(approvalId, fx.tenantA.id, fx.tenantA.users.ADMIN, "REJECTED")).toBe(false);
  });

  it("reject blockiert: nach REJECTED ist kein APPROVED-Claim mehr möglich", async () => {
    const approvalId = await createApproval();
    expect(await claimApproval(approvalId, fx.tenantA.id, fx.tenantA.users.ADMIN, "REJECTED")).toBe(true);
    expect(await claimApproval(approvalId, fx.tenantA.id, fx.tenantA.users.ADMIN, "APPROVED")).toBe(false);
    const row = await prisma.mcpApproval.findUniqueOrThrow({ where: { id: approvalId } });
    expect(row.status).toBe("REJECTED");
  });

  it("failure != success: FEHLER-Outcome ist von OK unterscheidbar", async () => {
    const approvalId = await createApproval();
    expect(await claimApproval(approvalId, fx.tenantA.id, fx.tenantA.users.ADMIN, "APPROVED")).toBe(true);

    await prisma.mcpApproval.update({ where: { id: approvalId }, data: { outcome: "FEHLER", executedAt: new Date() } });
    const failed = await prisma.mcpApproval.findUniqueOrThrow({ where: { id: approvalId } });
    expect(failed.outcome).toBe("FEHLER");
    expect(failed.outcome).not.toBe("OK");

    // Ein Erfolg ist explizit als OK + executedAt markiert.
    const approvalId2 = await createApproval();
    await claimApproval(approvalId2, fx.tenantA.id, fx.tenantA.users.ADMIN, "APPROVED");
    await prisma.mcpApproval.update({ where: { id: approvalId2 }, data: { outcome: "OK", executedAt: new Date() } });
    const ok = await prisma.mcpApproval.findUniqueOrThrow({ where: { id: approvalId2 } });
    expect(ok.outcome).toBe("OK");
    expect(ok.outcome).not.toBe("FEHLER");
  });

  it("execution unknown: APPROVED ohne outcome/executedAt ist unterscheidbar", async () => {
    const approvalId = await createApproval();
    expect(await claimApproval(approvalId, fx.tenantA.id, fx.tenantA.users.ADMIN, "APPROVED")).toBe(true);
    // Kein executeApproval, kein outcome-Finalize → Zustand nach Crash nach Claim.
    const row = await prisma.mcpApproval.findUniqueOrThrow({ where: { id: approvalId } });
    expect(row.status).toBe("APPROVED");
    expect(row.outcome).toBeNull();
    expect(row.executedAt).toBeNull();
  });
});
