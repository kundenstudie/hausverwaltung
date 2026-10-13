import { defineConfig, devices } from "playwright/test";

// Minimale Playwright-Smoke-Suite (HAVEWA-03, Abschnitt 15).
//
// Voraussetzungen (lokal):
//   1. npm run db:up && npm run db:migrate && npm run db:seed   # Demo-Admin anlegen
//   2. npx playwright install chromium                            # Browser einmalig
//   3. npm run test:e2e
//
// Die Smoke-Suite läuft gegen die laufende App (npm run dev) mit dem Demo-Login
// admin@havewa.app / admin. Es werden keine flakigen sleeps verwendet — nur
// Auto-Waiting (expect + waitForURL).
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
