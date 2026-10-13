import { prisma } from "@/lib/prisma";
import { roleAllows, WRITE_ROLES } from "@/lib/rbac";
import { encryptSecret, decryptSecret } from "@/lib/crypto";
import type { ApiPrincipal } from "@/lib/api-auth";
import { ApiWriteError } from "@/lib/api-write";
import { runOperation } from "@/lib/api-ops";
import { apiCreate, apiUpdate, apiDelete } from "@/lib/api-write";
import { requiresApproval, isWriteTool, isAdminOnlyAction } from "@/lib/mcp-risk";
import type { McpApproval } from "@prisma/client";

// MCP-Human-Approval-Boundary (Ziel B, HAVEWA-02).
// Server-seitig gebundene Freigabe: externe Agent-Aktionen werden klassifiziert;
// materielle/destruktive Aktionen werden NICHT ausgeführt, sondern erzeugen einen
// PENDING-Zustand, der erst von einem Menschen im vertrauenswürdigen HaVeWa-Kontext
// freigegeben wird. Die Freigabe ist niemals vom Modell/Request behauptbar.

export type ApprovalGateResult =
  | { kind: "allowed" }
  | { kind: "forbidden"; message: string }
  | { kind: "approval_required"; approvalId: string; tool: string; summary: string };

const truncate = (v: string, n: number) => (v.length > n ? v.slice(0, n) + "…" : v);

/** Sanitized Kurzbeschreibung ohne Secret-Inhalte (für Anzeige + Audit). */
function summarize(tool: string, args: Record<string, unknown>): string {
  const opArgs = (args.args ?? {}) as Record<string, unknown>;
  switch (tool) {
    case "delete_record":
      return `delete_record ${String(args.entity ?? "?")} (id=${truncate(String(args.id ?? "?"), 40)})`;
    case "create_record":
      return `create_record ${String(args.entity ?? "?")}`;
    case "update_record":
      return `update_record ${String(args.entity ?? "?")} (id=${truncate(String(args.id ?? "?"), 40)})`;
    case "run_operation": {
      const op = String(args.operation ?? "?");
      if (op === "send_email") {
        return `send_email (to=${truncate(String(opArgs.toAddress ?? "?"), 60)})`;
      }
      if (op === "update_ai_config") {
        return `update_ai_config (provider=${String(opArgs.provider ?? "?")}, apiKey=${opArgs.apiKey ? "[neu gesetzt]" : "[unverändert]"})`;
      }
      if (op === "update_smtp_config") {
        return `update_smtp_config (host=${String(opArgs.host ?? "?")}, password=${opArgs.password ? "[neu gesetzt]" : "[unverändert]"})`;
      }
      return op;
    }
    default:
      return tool;
  }
}

/** Fire-and-forget-tolerantes Audit-Schreiben für MCP-Freigaben (kein Secret-Inhalt). */
export async function auditMcpApproval(
  principal: ApiPrincipal,
  action: "CREATE" | "UPDATE",
  entityId: string,
  summary: string,
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        tenantId: principal.tenantId,
        userId: principal.userId,
        userName: principal.name,
        action,
        entity: "McpApproval",
        entityId,
        summary,
      },
    });
  } catch {
    // Logging-Fehler dürfen die eigentliche Aktion nicht scheitern lassen.
  }
}

function principalArgs(args: Record<string, unknown>) {
  const operation = args.operation != null ? String(args.operation) : undefined;
  const entity =
    args.entity != null && args.entity !== "" ? String(args.entity) : undefined;
  return { operation, entity };
}

/**
 * Klassifiziert eine anstehende MCP-Aktion und entscheidet:
 *  - Role Authorization (notwendig, aber nicht hinreichend)
 *  - Human Approval erforderlich → PENDING anlegen (NICHT ausführen)
 *  - sonst → ausführen lassen.
 */
export async function gateMcpTool(
  principal: ApiPrincipal,
  tool: string,
  args: Record<string, unknown>,
): Promise<ApprovalGateResult> {
  if (!isWriteTool(tool)) return { kind: "allowed" };

  // 1) Role Authorization (Berechtigung bleibt notwendig, Approval ersetzt sie nicht).
  if (!roleAllows(principal.role, WRITE_ROLES)) {
    return { kind: "forbidden", message: "Keine Schreibberechtigung" };
  }

  const { operation, entity } = principalArgs(args);

  // adminOnly-Aktionen (Config/Security, inkl. create/update_record → user)
  // erfordern bereits beim Request ADMIN — konsistent für Anfordern und Freigeben.
  if (isAdminOnlyAction(tool, operation, entity) && principal.role !== "ADMIN") {
    return { kind: "forbidden", message: "Nur Administratoren" };
  }

  if (!requiresApproval(tool, operation, entity)) return { kind: "allowed" };

  const summary = summarize(tool, args);
  const approval = await prisma.mcpApproval.create({
    data: {
      tenantId: principal.tenantId,
      requestedById: principal.userId,
      requesterName: principal.name,
      tool,
      operationType: operation ?? null,
      entity: entity ?? null,
      targetId:
        tool === "update_record" || tool === "delete_record"
          ? args.id != null
            ? String(args.id)
            : null
          : null,
      summary,
      // Args (ggf. mit Credentials) verschlüsselt at-rest ablegen (AES-256-GCM).
      argsEnc: encryptSecret(JSON.stringify(args)),
    },
  });
  await auditMcpApproval(principal, "CREATE", approval.id, `Freigabe angefordert: ${summary}`);
  return { kind: "approval_required", approvalId: approval.id, tool, summary };
}

/**
 * Atomarer single-claim Zustandsübergang PENDING → `status` (APPROVED|REJECTED).
 * Gibt `false` zurück, wenn die Freigabe nicht (mehr) PENDING ist → Replay- und
 * Doppel-Ausführung sind damit blockiert. Kern der AT-MOST-ONCE-Garantie.
 */
export async function claimApproval(
  id: string,
  tenantId: string,
  decidedById: string,
  status: "APPROVED" | "REJECTED",
): Promise<boolean> {
  const res = await prisma.mcpApproval.updateMany({
    where: { id, tenantId, status: "PENDING" },
    data: { status, decidedById, decidedAt: new Date() },
  });
  return res.count > 0;
}

/**
 * Führt eine freigegebene Aktion aus. Garantie ist AT-MOST-ONCE (single-claim,
 * replay-geschützt), NICHT exactly-once: Wird ausschließlich vom Approve-Pfad
 * (nach atomarem Claim) aufgerufen — nie direkt vom MCP-Request. Ein Crash/Fehler
 * nach dem Claim kann die Aktion verlieren; es gibt keinen automatischen Retry.
 */
export async function executeApproval(
  approval: McpApproval,
  principal: ApiPrincipal,
): Promise<unknown> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(decryptSecret(approval.argsEnc)) as Record<string, unknown>;
  } catch {
    throw new ApiWriteError("Freigabe konnte nicht entschlüsselt werden", 500);
  }

  switch (approval.tool) {
    case "run_operation":
      return runOperation(principal, approval.operationType!, (args.args as Record<string, unknown>) ?? {});
    case "create_record":
      return apiCreate(principal, approval.entity!, (args.data as Record<string, unknown>) ?? {});
    case "update_record":
      return apiUpdate(
        principal,
        approval.entity!,
        approval.targetId!,
        (args.data as Record<string, unknown>) ?? {},
      );
    case "delete_record":
      return apiDelete(principal, approval.entity!, approval.targetId!);
    default:
      throw new ApiWriteError("Unbekanntes Tool für Freigabe", 400);
  }
}
