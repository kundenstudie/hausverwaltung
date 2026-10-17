// HAVEWA-07A-2 — Unit-Tests fuer den Runtime-Packaging-Schritt.
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { buildPrismaTree, STATIC_ENTRIES, ROOT } from "./prisma-runtime-tree.mjs";

describe("prisma-runtime-tree.buildPrismaTree", () => {
  const TARGET = path.join(ROOT, "scripts", ".runtime", "prisma-cli-test");

  beforeEach(async () => {
    await fs.rm(TARGET, { recursive: true, force: true });
  });
  afterEach(async () => {
    await fs.rm(TARGET, { recursive: true, force: true });
  });

  it("legt den Zielbaum an und enthaelt schema.prisma", async () => {
    const copied = await buildPrismaTree(TARGET);
    expect(copied.length).toBeGreaterThan(0);
    const schema = path.join(TARGET, "prisma", "schema.prisma");
    await expect(fs.access(schema)).resolves.toBeUndefined();
  });

  it("enthaelt migration_lock.toml im migrations/-Verzeichnis", async () => {
    await buildPrismaTree(TARGET);
    const lock = path.join(TARGET, "prisma", "migrations", "migration_lock.toml");
    await expect(fs.access(lock)).resolves.toBeUndefined();
  });

  it("enthaelt die Prisma-CLI (build/index.js)", async () => {
    await buildPrismaTree(TARGET);
    const cli = path.join(TARGET, "node_modules", "prisma", "build", "index.js");
    await expect(fs.access(cli)).resolves.toBeUndefined();
  });

  it("enthaelt mindestens ein @prisma/-Paket (z. B. engines)", async () => {
    await buildPrismaTree(TARGET);
    const engines = path.join(TARGET, "node_modules", "@prisma", "engines");
    await expect(fs.access(engines)).resolves.toBeUndefined();
  });

  it("idempotent: zweiter Aufruf ueberschreibt sauber", async () => {
    const first = await buildPrismaTree(TARGET);
    const second = await buildPrismaTree(TARGET);
    expect(second.length).toBe(first.length);
    // Schema ist immer noch da
    const schema = path.join(TARGET, "prisma", "schema.prisma");
    await expect(fs.access(schema)).resolves.toBeUndefined();
  });

  it("STATIC_ENTRIES enthaelt alle Pflicht-Pfade", () => {
    const rels = STATIC_ENTRIES.map(([s]) => s);
    expect(rels).toContain("prisma/schema.prisma");
    expect(rels).toContain("prisma/migrations");
    expect(rels).toContain("prisma/migrations/migration_lock.toml");
    expect(rels).toContain("node_modules/prisma");
    expect(rels).toContain("node_modules/@prisma");
  });
});
