// OpenAPI 3.1 Beschreibung der HaVeWa REST-API. Öffentlich (keine Geheimnisse),
// dient Scalar/Swagger als Referenz.
//
// HAVEWA-04: List-Parameter (page/pageSize/sort/order/Filter) und das
// Pagination-Envelope werden direkt aus LIST_CONFIG generiert, damit die
// Dokumentation dem realen Contract entspricht (keine Dokumentationslüge).

import { LIST_CONFIG } from "@/lib/api-data";
import type { ListConfig, FilterSpec } from "@/lib/api-list";

function filterParamSchema(spec: FilterSpec): { type: string; enum?: string[] } {
  if (spec.kind === "boolean") return { type: "string", enum: ["true", "false"] };
  if (spec.kind === "int") return { type: "integer" };
  if (spec.kind === "enum") return { type: "string", enum: [...spec.values] };
  return { type: "string" };
}

function listParameters(config: ListConfig) {
  return [
    { name: "page", in: "query", required: false, schema: { type: "integer", minimum: 1, default: 1 }, description: "Seite (1-basiert). Wird nur bei gesetzten List-Parametern paginiert." },
    { name: "pageSize", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 200, default: 50 }, description: "Seitengröße (hartes Maximum 200)." },
    { name: "sort", in: "query", required: false, schema: { type: "string", enum: [...config.sort] }, description: "Sortierfeld (Whitelist)." },
    { name: "order", in: "query", required: false, schema: { type: "string", enum: ["asc", "desc"] }, description: "Sortierrichtung." },
    ...Object.entries(config.filters).map(([name, spec]) => ({
      name,
      in: "query",
      required: false,
      schema: filterParamSchema(spec),
      description: "Filter (fachlich, tenant-sicher).",
    })),
  ] as const;
}

const listOp = (tag: string, summary: string, config: ListConfig) => ({
  tags: [tag],
  summary,
  description:
    "Ohne List-Parameter: Legacy-Array (vollständige Liste, unverändert). " +
    "Mit mindestens einem List-Parameter: { data: [...], pagination: { page, pageSize, total, totalPages, hasNext, hasPrevious } }.",
  security: [{ bearerAuth: [] }],
  parameters: listParameters(config),
  responses: {
    "200": { description: "OK — Array (legacy) oder paginiertes Envelope" },
    "400": { description: "Ungültige Pagination/Filter/Sort" },
    "401": { description: "Unauthorized" },
  },
});

const spec = {
  openapi: "3.1.0",
  info: {
    title: "HaVeWa API",
    version: "1.0.0",
    description:
      "REST-API der Hausverwaltungssoftware HaVeWa. Authentifizierung per Bearer-Token " +
      "(persönlicher Zugangstoken aus den Einstellungen). Alle Daten sind auf den Mandanten des Tokens beschränkt.",
  },
  servers: [{ url: "/" }],
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", description: "Persönlicher API-Token (Einstellungen → API- & MCP-Zugänge)" },
    },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    "/api/v1/me": {
      get: { tags: ["Allgemein"], summary: "Eigene Info + Portfolio-Kennzahlen", security: [{ bearerAuth: [] }], responses: { "200": { description: "OK" }, "401": { description: "Unauthorized" } } },
    },
    "/api/v1/properties": { get: listOp("Objekte", "Objekte auflisten", LIST_CONFIG.properties) },
    "/api/v1/properties/{id}": {
      get: {
        tags: ["Objekte"],
        summary: "Objekt mit Gebäuden & Einheiten",
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "OK" }, "404": { description: "Not found" } },
      },
    },
    "/api/v1/units": { get: listOp("Einheiten", "Einheiten auflisten", LIST_CONFIG.units) },
    "/api/v1/meters": { get: listOp("Einheiten", "Zähler + letzter Stand auflisten", LIST_CONFIG.meters) },
    "/api/v1/owners": { get: listOp("Einheiten", "Eigentümer-Zuordnungen auflisten", LIST_CONFIG.owners) },
    "/api/v1/leases": { get: listOp("Verträge", "Mietverträge auflisten", LIST_CONFIG.leases) },
    "/api/v1/open-items": { get: listOp("Finanzen", "Offene Posten auflisten", LIST_CONFIG.openItems) },
    "/api/v1/accounts": { get: listOp("Finanzen", "Konten + Saldo auflisten", LIST_CONFIG.accounts) },
    "/api/v1/charges": { get: listOp("Finanzen", "Sollstellungen auflisten", LIST_CONFIG.charges) },
    "/api/v1/payments": { get: listOp("Finanzen", "Zahlungen auflisten", LIST_CONFIG.payments) },
    "/api/v1/documents": { get: listOp("Dokumente", "Dokumente auflisten", LIST_CONFIG.documents) },
    "/api/v1/meetings": { get: listOp("Versammlung", "Eigentümerversammlungen auflisten", LIST_CONFIG.meetings) },
    "/api/v1/resolutions": { get: listOp("Versammlung", "Beschlusssammlung auflisten", LIST_CONFIG.resolutions) },
    "/api/v1/economic-plans": { get: listOp("WEG", "Wirtschaftspläne auflisten", LIST_CONFIG.economicPlans) },
    "/api/v1/reserves": { get: listOp("WEG", "Erhaltungsrücklagen + Saldo auflisten", LIST_CONFIG.reserves) },
    "/api/v1/appointments": { get: listOp("Kalender", "Termine auflisten", LIST_CONFIG.appointments) },
    "/api/v1/contractors": { get: listOp("Instandhaltung", "Handwerker/Dienstleister auflisten", LIST_CONFIG.contractors) },
    "/api/v1/maintenance-contracts": { get: listOp("Instandhaltung", "Wartungsverträge auflisten", LIST_CONFIG.maintenanceContracts) },
    "/api/v1/insurances": { get: listOp("Weitere", "Versicherungen auflisten", LIST_CONFIG.insurances) },
    "/api/v1/property-taxes": { get: listOp("Weitere", "Grundsteuer auflisten", LIST_CONFIG.propertyTaxes) },
    "/api/v1/operations": {
      get: {
        tags: ["Operationen"],
        summary: "Verfügbare Operationen (kein reines CRUD)",
        description:
          "Sollstellungslauf, Mahnlauf, Mietanpassung anwenden, Wartung fortschreiben, Zeiterfassung, " +
          "Bank-Import (camt.053), E-Mail senden, Dokument-Upload, KI-/SMTP-Konfiguration. " +
          "Ausführen: POST /api/v1/operations/{name} mit den Parametern im Body.",
        security: [{ bearerAuth: [] }],
        responses: { "200": { description: "OK" }, "401": { description: "Unauthorized" } },
      },
    },
    "/api/v1/operations/{name}": {
      post: {
        tags: ["Operationen"],
        summary: "Operation ausführen",
        description: "name z. B. run_charge_generation, run_dunning, apply_adjustment, send_email, import_camt, upload_document …",
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }],
        requestBody: { content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
        responses: { "200": { description: "OK" }, "400": { description: "Bad request" }, "403": { description: "Forbidden" }, "404": { description: "Not found" } },
      },
    },
    "/api/v1/records": {
      get: {
        tags: ["Schreiben"],
        summary: "Schema-Discovery: schreibbare Entitäten + Felder",
        description:
          "Generische Schreibschicht. Liefert alle Entitäten mit Feldnamen und Relationen. " +
          "Anlegen: POST /api/v1/records/{entity}. Ändern: PATCH /api/v1/records/{entity}/{id}. Löschen: DELETE …",
        security: [{ bearerAuth: [] }],
        responses: { "200": { description: "OK" }, "401": { description: "Unauthorized" } },
      },
    },
    "/api/v1/records/{entity}": {
      post: {
        tags: ["Schreiben"],
        summary: "Datensatz anlegen (generisch)",
        description: "entity z. B. property, unit, person, lease, charge, payment, meeting, resolution, insurance, user …",
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "entity", in: "path", required: true, schema: { type: "string" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
        responses: { "201": { description: "Created" }, "400": { description: "Bad request" }, "403": { description: "Forbidden" } },
      },
    },
    "/api/v1/records/{entity}/{id}": {
      patch: {
        tags: ["Schreiben"],
        summary: "Datensatz ändern (generisch)",
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "entity", in: "path", required: true, schema: { type: "string" } },
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
        responses: { "200": { description: "OK" }, "404": { description: "Not found" }, "405": { description: "Nicht aktualisierbar" } },
      },
      delete: {
        tags: ["Schreiben"],
        summary: "Datensatz löschen (generisch)",
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "entity", in: "path", required: true, schema: { type: "string" } },
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: { "200": { description: "OK" }, "404": { description: "Not found" } },
      },
    },
    "/api/v1/tasks": {
      get: listOp("Aufgaben", "Aufgaben auflisten", LIST_CONFIG.tasks),
      post: {
        tags: ["Aufgaben"],
        summary: "Aufgabe anlegen",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["title"],
                properties: { title: { type: "string" }, dueDate: { type: "string", format: "date" } },
              },
            },
          },
        },
        responses: { "201": { description: "Created" }, "400": { description: "Bad request" } },
      },
    },
    "/api/v1/persons": {
      get: listOp("Personen", "Personen auflisten", LIST_CONFIG.persons),
      post: {
        tags: ["Personen"],
        summary: "Person anlegen",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["firstName", "lastName"],
                properties: {
                  firstName: { type: "string" },
                  lastName: { type: "string" },
                  email: { type: "string" },
                  phone: { type: "string" },
                  type: { type: "string", enum: ["MIETER", "EIGENTUEMER", "INTERESSENT", "HANDWERKER", "MAKLER", "BANK", "SONSTIGE"] },
                },
              },
            },
          },
        },
        responses: { "201": { description: "Created" }, "400": { description: "Bad request" } },
      },
    },
    "/api/v1/tickets": {
      get: listOp("Instandhaltung", "Tickets auflisten", LIST_CONFIG.tickets),
      post: {
        tags: ["Instandhaltung"],
        summary: "Ticket anlegen",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["title"],
                properties: {
                  title: { type: "string" },
                  description: { type: "string" },
                  propertyId: { type: "string" },
                  priority: { type: "string", enum: ["NIEDRIG", "MITTEL", "HOCH"] },
                },
              },
            },
          },
        },
        responses: { "201": { description: "Created" }, "400": { description: "Bad request" } },
      },
    },
    "/api/v1/leases/{id}": {
      get: {
        tags: ["Verträge"],
        summary: "Lease Legal-Kontext (read-only, mandanten-gescoped)",
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  additionalProperties: false,
                  required: ["leaseId", "startDate", "endDate", "rentCold", "noticePeriodMonths"],
                  properties: {
                    leaseId: { type: "string" },
                    startDate: { type: "string", format: "date" },
                    endDate: { type: ["string", "null"], format: "date" },
                    rentCold: { type: "number" },
                    noticePeriodMonths: { type: ["integer", "null"] },
                  },
                },
              },
            },
          },
          "401": { description: "Unauthorized" },
          "404": { description: "Not found" },
        },
      },
    },
    "/api/v1/leases/{id}/rent-adjustments": {
      get: {
        tags: ["Verträge"],
        summary: "Mietanpassungs-Historie (read-only, mandanten-gescoped)",
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
          { name: "offset", in: "query", required: false, schema: { type: "integer", minimum: 0, default: 0 } },
        ],
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  additionalProperties: false,
                  required: ["items", "pagination"],
                  properties: {
                    items: {
                      type: "array",
                      items: {
                        type: "object",
                        additionalProperties: false,
                        required: ["id", "leaseId", "type", "effectiveDate", "newRentCold", "indexBase", "indexNew", "applied"],
                        properties: {
                          id: { type: "string" },
                          leaseId: { type: "string" },
                          type: { type: "string", enum: ["STAFFEL", "INDEX"] },
                          effectiveDate: { type: "string", format: "date" },
                          newRentCold: { type: "number" },
                          indexBase: { type: ["number", "null"] },
                          indexNew: { type: ["number", "null"] },
                          applied: { type: "boolean" },
                        },
                      },
                    },
                    pagination: {
                      type: "object",
                      additionalProperties: false,
                      required: ["count", "limit", "total", "offset"],
                      properties: {
                        count: { type: "integer", description: "Gelieferte Items dieser Seite." },
                        limit: { type: "integer", description: "Angeforderte Seitengröße." },
                        total: { type: "integer", description: "Gesamtzahl der Anpassungen (vollständige Historie beweisbar)." },
                        offset: { type: "integer", description: "Verwendeter Offset." },
                      },
                    },
                  },
                },
              },
            },
          },
          "400": { description: "Bad request" },
          "401": { description: "Unauthorized" },
          "404": { description: "Not found" },
        },
      },
    },
  },
};

export function GET() {
  return Response.json(spec);
}
