import { vi } from "vitest";

// Läuft als Vitest setupFile VOR dem Import der App-Module in den Testdateien.
// Setzt deterministische Env-Variablen, damit `@/lib/prisma` die dedizierte
// Test-DB (Port 5433) nutzt und die Krypto-Schlüssel stabil sind.
const testUrl =
  process.env.DATABASE_URL_TEST ||
  process.env.DATABASE_URL ||
  "postgresql://havewa_test:havewa_test@localhost:5433/havewa_test?schema=public";

process.env.DATABASE_URL = testUrl;
process.env.AUTH_SECRET = process.env.AUTH_SECRET || "test-secret-for-crypto";

// Die App-Module (api-write/api-ops/mcp-approval) importieren transitiv rbac.ts,
// das next/navigation, next/headers und @/auth zieht. Im node-Testkontext werden
// diese Module gestubbt, damit die reinen roleAllows/WRITE_ROLES/assignableRoles/
// canDeleteUser-Pfade importier- und testbar bleiben.
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirect() called in test (${url})`);
  },
}));

vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({ get: () => undefined }),
}));

vi.mock("@/auth", () => ({
  auth: () => Promise.resolve(null),
}));

// Server-only-Module (z. B. src/server/statements.ts) tragen den `server-only`
// Marker, der außerhalb von RSC wirft. Für den node-Testkontext neutralisieren.
vi.mock("server-only", () => ({}));
