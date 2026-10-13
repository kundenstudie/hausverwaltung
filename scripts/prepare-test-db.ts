// HAVEWA-03: bereitet die dedizierte Test-DB für Integrationstests vor.
// - liest DATABASE_URL_TEST (Fallback: DATABASE_URL)
// - wendet die Prisma-Migrationen idempotent an (prisma migrate deploy)
// Aufruf: npm run test:db:migrate  (bzw. automatisch vor test:integration)
import { execSync } from "node:child_process";

const url =
  process.env.DATABASE_URL_TEST ||
  process.env.DATABASE_URL ||
  "postgresql://havewa_test:havewa_test@localhost:5433/havewa_test?schema=public";

console.log("[prepare-test-db] Ziel:", url.replace(/:[^:@/]+@/, ":***@"));

try {
  execSync("npx prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "inherit",
  });
  console.log("[prepare-test-db] Migrationen angewendet.");
} catch {
  console.error("[prepare-test-db] migrate deploy fehlgeschlagen. Läuft die Test-DB?");
  console.error("  docker compose -f docker-compose.test.yml up -d");
  process.exit(1);
}
