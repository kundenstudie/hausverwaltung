"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireRole, WRITE_ROLES } from "@/lib/rbac";
import { audit } from "@/lib/audit";
import { executeApproval, claimApproval } from "@/lib/mcp-approval";
import { isAdminOnlyAction } from "@/lib/mcp-risk";
import type { ApiPrincipal } from "@/lib/api-auth";
import type { ActionState } from "@/lib/schemas";

// Server-Actions für die menschliche Freigabe von MCP-Aktionen.
// Die Freigabe läuft ausschließlich über den session-authentifizierten,
// mandanten-gebundenen HaVeWa-Kontext — nie über das MCP-Bearer-Token.

function principalOf(user: Awaited<ReturnType<typeof requireRole>>): ApiPrincipal {
  return { userId: user.id, tenantId: user.tenantId, role: user.role, name: user.name ?? user.email ?? "Freigabe" };
}

/** Mensch erteilt die Freigabe → Aktion wird at-most-once ausgeführt (single-claim, replay-geschützt). */
export async function approveMcpApproval(id: string): Promise<ActionState> {
  const user = await requireRole(WRITE_ROLES);
  const approval = await prisma.mcpApproval.findFirst({
    where: { id, tenantId: user.tenantId },
  });
  if (!approval) return { error: "Freigabe nicht gefunden" };
  if (approval.status !== "PENDING") return { error: "Freigabe wurde bereits entschieden" };

  // Config/Security-Aktionen (Credentials/RBAC) dürfen nur Admins freigeben.
  if (
    isAdminOnlyAction(approval.tool, approval.operationType ?? undefined, approval.entity ?? undefined) &&
    user.role !== "ADMIN"
  ) {
    return { error: "Nur Administratoren dürfen diese Freigabe erteilen" };
  }

  // Atomarer Claim: verhindert Doppel-/Replay-Ausführung unter Nebenläufigkeit.
  const claimed = await claimApproval(approval.id, user.tenantId, user.id, "APPROVED");
  if (!claimed) return { error: "Freigabe wurde bereits entschieden" };

  try {
    const result = await executeApproval(approval, principalOf(user));
    const failed = result && typeof result === "object" && (result as { status?: string }).status === "FEHLER";
    await prisma.mcpApproval.update({
      where: { id: approval.id },
      data: { outcome: failed ? "FEHLER" : "OK", executedAt: new Date() },
    });
    await audit(user, "UPDATE", "McpApproval", approval.id, `Freigabe erteilt (${failed ? "FEHLER" : "OK"}): ${approval.summary}`);
    revalidatePath("/", "layout");
    // Fehlgeschlagene Ausführung darf NICHT als Erfolg dargestellt werden.
    if (failed) return { error: "Aktion fehlgeschlagen (Freigabe wurde nicht erfolgreich ausgeführt)" };
    return { ok: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Ausführung fehlgeschlagen";
    await prisma.mcpApproval.update({
      where: { id: approval.id },
      data: { outcome: "FEHLER", executedAt: new Date() },
    });
    return { error: message };
  }
}

/** Mensch lehnt die Freigabe ab → Aktion wird nie ausgeführt. */
export async function rejectMcpApproval(id: string): Promise<ActionState> {
  const user = await requireRole(WRITE_ROLES);
  const approval = await prisma.mcpApproval.findFirst({
    where: { id, tenantId: user.tenantId },
  });
  if (!approval) return { error: "Freigabe nicht gefunden" };
  if (approval.status !== "PENDING") return { error: "Freigabe wurde bereits entschieden" };

  // Config/Security-Aktionen dürfen nur Admins ablehnen (gleiche Policy wie Freigeben).
  if (
    isAdminOnlyAction(approval.tool, approval.operationType ?? undefined, approval.entity ?? undefined) &&
    user.role !== "ADMIN"
  ) {
    return { error: "Nur Administratoren dürfen diese Freigabe ablehnen" };
  }

  const claimed = await claimApproval(id, user.tenantId, user.id, "REJECTED");
  if (!claimed) return { error: "Freigabe nicht gefunden oder bereits entschieden" };
  await audit(user, "UPDATE", "McpApproval", id, "Freigabe abgelehnt");
  revalidatePath("/", "layout");
  return { ok: true };
}
