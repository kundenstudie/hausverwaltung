import { test, expect, type Page } from "playwright/test";

// Minimale Smoke-Suite (HAVEWA-03): Login → zentrale Seiten → Logout.
// Annahmen: deutsches Default-Locale (/de/...), Demo-Admin admin@havewa.app/admin.
// Keine sleeps — ausschließlich Auto-Waiting.

const EMAIL = "admin@havewa.app";
const PASSWORD = "admin";

async function login(page: Page) {
  await page.goto("/de/login");
  await page.locator("#email").fill(EMAIL);
  await page.locator("#password").fill(PASSWORD);
  await page.locator("button[type=submit]").click();
  // Nach erfolgreichem Login verlässt die App die Login-Seite.
  await expect(page).not.toHaveURL(/login/, { timeout: 15_000 });
}

async function expectHeading(page: Page, text: string) {
  // Auto-Waiting mit erhöhtem Budget: die server-gerenderte Dashboard-Seite
  // (10 Prisma-Queries + Charts) kann auf langsameren Hosts (z. B. WSL/aarch64)
  // beim ersten Aufruf über dem Playwright-Standard (5s) liegen.
  await expect(page.getByRole("heading", { level: 1 })).toContainText(text, { timeout: 20_000 });
}

test.beforeEach(async ({ page }) => {
  await login(page);
});

test("Login und Dashboard", async ({ page }) => {
  await expectHeading(page, "Dashboard");
});

test("Objekte", async ({ page }) => {
  await page.goto("/de/properties");
  await expectHeading(page, "Objekte");
});

test("Mietverträge", async ({ page }) => {
  await page.goto("/de/leases");
  await expectHeading(page, "Mietverträge");
});

test("Finanzen", async ({ page }) => {
  await page.goto("/de/finances");
  await expectHeading(page, "Finanzen");
});

test("Dokumente", async ({ page }) => {
  await page.goto("/de/documents");
  await expectHeading(page, "Dokumente");
});

test("Einstellungen (inkl. MCP-Freigaben-Bereich)", async ({ page }) => {
  await page.goto("/de/settings");
  await expectHeading(page, "Einstellungen");
});

test("Einstellungen: Zeitzone sichtbar, änderbar und bleibt nach Reload erhalten (HAVEWA-04)", async ({ page }) => {
  await page.goto("/de/settings");
  await expectHeading(page, "Einstellungen");
  const select = page.locator("#timeZone");
  await expect(select).toBeVisible();
  await select.selectOption("Europe/Vienna");
  const form = page.locator("form", { has: select });
  await form.getByRole("button", { name: "Speichern" }).click();
  // Warten, bis die Server-Action abgeschlossen ist ("Gespeichert"-Bestätigung),
  // bevor neu geladen wird — sonst rennt page.reload() dem Save voraus.
  await expect(form.getByText("Gespeichert")).toBeVisible({ timeout: 15_000 });
  await page.reload();
  await expect(page.locator("#timeZone")).toHaveValue("Europe/Vienna");
});

test("Logout", async ({ page }) => {
  // Avatar-Menü öffnen (runder Button im Header) und „Abmelden" wählen.
  await page.locator("button.rounded-full").first().click();
  await page.getByRole("menuitem", { name: "Abmelden" }).click();
  await expect(page).toHaveURL(/login/, { timeout: 15_000 });
});
