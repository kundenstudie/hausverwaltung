import { describe, it, expect } from "vitest";
import { classifyMcpAction, requiresApproval, isWriteTool, isAdminOnlyAction } from "./mcp-risk";

describe("MCP-Risikoklassifikation (HAVEWA-02, Ziel B)", () => {
  it("Read-Tools benötigen keine Freigabe", () => {
    for (const t of ["portfolio_summary", "list_properties", "get_property", "list_entities", "list_operations"]) {
      expect(classifyMcpAction(t)).toBe("READ_ONLY");
      expect(requiresApproval(t)).toBe(false);
    }
  });

  it("delete_record erfordert immer Freigabe (DESTRUCTIVE_WRITE)", () => {
    expect(classifyMcpAction("delete_record", undefined, "person")).toBe("DESTRUCTIVE_WRITE");
    expect(requiresApproval("delete_record", undefined, "person")).toBe(true);
  });

  it("materiale create/update klassifiziert korrekt", () => {
    expect(classifyMcpAction("create_record", undefined, "charge")).toBe("FINANCIAL_OPERATION");
    expect(classifyMcpAction("update_record", undefined, "payment")).toBe("FINANCIAL_OPERATION");
    expect(classifyMcpAction("create_record", undefined, "lease")).toBe("LEGAL_EFFECT_OPERATION");
    expect(classifyMcpAction("create_record", undefined, "resolution")).toBe("LEGAL_EFFECT_OPERATION");
    expect(classifyMcpAction("create_record", undefined, "mandate")).toBe("LEGAL_EFFECT_OPERATION");
    expect(classifyMcpAction("create_record", undefined, "user")).toBe("CONFIG_SECURITY_OPERATION");
    expect(requiresApproval("create_record", undefined, "charge")).toBe(true);
    expect(requiresApproval("update_record", undefined, "user")).toBe(true);
  });

  it("low-risk create/update benötigen keine Freigabe", () => {
    for (const e of ["property", "building", "unit", "person", "task", "ticket", "contractor", "appointment", "template", "custom-field"]) {
      expect(classifyMcpAction("create_record", undefined, e)).toBe("LOW_RISK_WRITE");
      expect(requiresApproval("create_record", undefined, e)).toBe(false);
    }
  });

  it("finanzielle Operationen erfordern Freigabe", () => {
    for (const op of ["run_charge_generation", "run_dunning", "apply_adjustment", "import_camt"]) {
      expect(classifyMcpAction("run_operation", op)).toBe("FINANCIAL_OPERATION");
      expect(requiresApproval("run_operation", op)).toBe(true);
    }
  });

  it("send_email erfordert Freigabe (EXTERNAL_COMMUNICATION)", () => {
    expect(classifyMcpAction("run_operation", "send_email")).toBe("EXTERNAL_COMMUNICATION");
    expect(requiresApproval("run_operation", "send_email")).toBe(true);
  });

  it("config/security-Aktionen erfordern Freigabe (und nur Admin)", () => {
    expect(classifyMcpAction("run_operation", "update_ai_config")).toBe("CONFIG_SECURITY_OPERATION");
    expect(classifyMcpAction("run_operation", "update_smtp_config")).toBe("CONFIG_SECURITY_OPERATION");
    expect(requiresApproval("run_operation", "update_ai_config")).toBe(true);
    expect(isAdminOnlyAction("run_operation", "update_ai_config")).toBe(true);
    expect(isAdminOnlyAction("run_operation", "update_smtp_config")).toBe(true);
    expect(isAdminOnlyAction("run_operation", "run_dunning")).toBe(false);
  });

  it("create/update_record user ist admin-only (Config/Security, konsistent)", () => {
    expect(classifyMcpAction("create_record", undefined, "user")).toBe("CONFIG_SECURITY_OPERATION");
    expect(classifyMcpAction("update_record", undefined, "user")).toBe("CONFIG_SECURITY_OPERATION");
    expect(isAdminOnlyAction("create_record", undefined, "user")).toBe(true);
    expect(isAdminOnlyAction("update_record", undefined, "user")).toBe(true);
    expect(isAdminOnlyAction("create_record", undefined, "person")).toBe(false);
  });

  it("upload_document erfordert Freigabe (MATERIAL_WRITE)", () => {
    expect(classifyMcpAction("run_operation", "upload_document")).toBe("MATERIAL_WRITE");
    expect(requiresApproval("run_operation", "upload_document")).toBe(true);
  });

  it("low-risk Operationen benötigen keine Freigabe", () => {
    for (const op of ["advance_maintenance", "add_ticket_time", "toggle_task"]) {
      expect(classifyMcpAction("run_operation", op)).toBe("LOW_RISK_WRITE");
      expect(requiresApproval("run_operation", op)).toBe(false);
    }
  });

  it("low-risk Write-Tools benötigen keine Freigabe, sind aber schreibend", () => {
    for (const t of ["create_task", "create_ticket", "create_person"]) {
      expect(isWriteTool(t)).toBe(true);
      expect(requiresApproval(t)).toBe(false);
    }
    expect(isWriteTool("portfolio_summary")).toBe(false);
  });

  it("Klassifikation ist deterministisch und hängt nicht an einem Client-Flag", () => {
    // Die Freigabe-Entscheidung leitet sich ausschließlich aus serverseitig
    // bekannten Fakten (tool/operation/entity) ab. Es gibt keinen Parameter für
    // ein model-supplied `approved`/`confirmed` — die Entscheidung ist für
    // materiale Aktionen IMMER `true` und kann nicht umgangen werden.
    expect(requiresApproval("run_operation", "run_dunning")).toBe(true);
    expect(requiresApproval("delete_record")).toBe(true);
    expect(requiresApproval("create_record", undefined, "charge")).toBe(true);
  });
});
