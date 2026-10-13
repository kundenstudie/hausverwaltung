// Risikoklassifikation der MCP-Write-Aktionen (Ziel B, HAVEWA-02).
// Reine Funktion ohne DB-/IO-Bezug, damit sie unit-testbar und seiteneffektfrei ist.
//
// Die Klassifikation ist die alleinige Grundlage für die Frage „Human Approval?“
// und darf NIE aus Client-/Modell-Eingaben (z. B. `approved: true`) abgeleitet
// werden. Sie hängt ausschließlich an serverseitig bekannten Fakten:
// tool-Name, operation-Name und entity-Name.

export type RiskClass =
  | "READ_ONLY"
  | "LOW_RISK_WRITE"
  | "MATERIAL_WRITE"
  | "DESTRUCTIVE_WRITE"
  | "EXTERNAL_COMMUNICATION"
  | "FINANCIAL_OPERATION"
  | "LEGAL_EFFECT_OPERATION"
  | "CONFIG_SECURITY_OPERATION";

// Entitäten, deren Anlage/Änderung finanziell materiell ist → Approval.
const FINANCIAL_ENTITIES = new Set([
  "charge", // Sollstellung/Forderung
  "payment", // Zahlung/Buchung
  "deposit", // Kaution
  "account", // Konto/Saldo
  "cost", // Kostenposition (Betriebskosten)
  "economic-plan", // Wirtschaftsplan (§28 WEG)
  "reserve", // Erhaltungsrücklage
  "reserve-transaction", // Rücklagenbuchung
  "insurance", // Versicherung/Prämie
  "property-tax", // Grundsteuer
  "component", // Miet-Bestandteil
  "adjustment", // Mietanpassung (Staffel/Index)
  "owner", // Eigentumsanteil (MEA → Hausgeld/Stimmrecht)
]);

// Entitäten mit rechtlicher Außenwirkung → Approval.
const LEGAL_ENTITIES = new Set([
  "lease", // Mietvertrag
  "mandate", // SEPA-Lastschriftmandat
  "resolution", // WEG-Beschluss (§24 WEG)
]);

// Sicherheits-/Credential-relevante Entitäten → Approval.
const CONFIG_ENTITIES = new Set([
  "user", // Benutzer/Rollen (Credentials, RBAC)
]);

// Operationen, die Human Approval erfordern, samt Risikoklasse.
const APPROVAL_OPERATIONS: Record<string, RiskClass> = {
  run_charge_generation: "FINANCIAL_OPERATION",
  run_dunning: "FINANCIAL_OPERATION",
  apply_adjustment: "FINANCIAL_OPERATION",
  import_camt: "FINANCIAL_OPERATION",
  send_email: "EXTERNAL_COMMUNICATION",
  upload_document: "MATERIAL_WRITE",
  update_ai_config: "CONFIG_SECURITY_OPERATION",
  update_smtp_config: "CONFIG_SECURITY_OPERATION",
};

// Alle MCP-Tools, die schreibend sind (nicht READ_ONLY).
const WRITE_TOOLS = new Set([
  "create_task",
  "create_ticket",
  "create_person",
  "create_record",
  "update_record",
  "delete_record",
  "run_operation",
]);

/** true, wenn das Tool schreibend ist (Role Authorization erforderlich). */
export function isWriteTool(tool: string): boolean {
  return WRITE_TOOLS.has(tool);
}

/**
 * Klassifiziert eine MCP-Aktion. `operation` nur für run_operation,
 * `entity` nur für create/update/delete_record.
 */
export function classifyMcpAction(tool: string, operation?: string, entity?: string): RiskClass {
  if (tool === "delete_record") return "DESTRUCTIVE_WRITE";

  if (tool === "run_operation") {
    if (!operation) return "LOW_RISK_WRITE";
    return APPROVAL_OPERATIONS[operation] ?? "LOW_RISK_WRITE";
  }

  if (tool === "create_record" || tool === "update_record") {
    if (!entity) return "LOW_RISK_WRITE";
    if (CONFIG_ENTITIES.has(entity)) return "CONFIG_SECURITY_OPERATION";
    if (LEGAL_ENTITIES.has(entity)) return "LEGAL_EFFECT_OPERATION";
    if (FINANCIAL_ENTITIES.has(entity)) return "FINANCIAL_OPERATION";
    return "LOW_RISK_WRITE";
  }

  // create_task / create_ticket / create_person
  if (WRITE_TOOLS.has(tool)) return "LOW_RISK_WRITE";

  return "READ_ONLY";
}

/** true, wenn die Aktion Human Approval benötigt (material/destructive/…). */
export function requiresApproval(tool: string, operation?: string, entity?: string): boolean {
  const c = classifyMcpAction(tool, operation, entity);
  return c !== "READ_ONLY" && c !== "LOW_RISK_WRITE";
}

/** Security-/Config-Aktionen (Credentials/RBAC) sind ausschließlich einem ADMIN vorbehalten. */
export function isAdminOnlyAction(tool: string, operation?: string, entity?: string): boolean {
  return classifyMcpAction(tool, operation, entity) === "CONFIG_SECURITY_OPERATION";
}
