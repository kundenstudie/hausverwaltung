import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Unit-Tests (kein DB-Zugriff). Integrationstests laufen getrennt über
// vitest.integration.config.ts gegen die dedizierte Test-DB (Port 5433).
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["**/*.integration.test.ts", "e2e/**", "**/node_modules/**"],
  },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
});
