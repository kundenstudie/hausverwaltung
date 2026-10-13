import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Integrationstests gegen die dedizierte PostgreSQL-Test-DB (docker-compose.test.yml).
// Voraussetzung: DB läuft (docker compose -f docker-compose.test.yml up -d) und
// Schema ist migriert (npm run test:db:migrate).
//
// fileParallelism=false: Tests laufen sequenziell, damit sich reset/seed der
// gemeinsamen Test-DB nicht gegenseitig stören.
export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.integration.test.ts"],
    setupFiles: ["./src/test/setup-env.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: "forks",
  },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
});
