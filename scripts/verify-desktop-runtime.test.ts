// HAVEWA-07D G2 — Tests for scripts/verify-desktop-runtime.mjs.
//
// Coverage:
//   - isForbiddenFile (Dateipfad-basiert)
//   - scanForbidden (rekursiv)
//   - Forbidden-Detection für .env, test.spec, docs/, e2e/, pgdata/

import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  isForbiddenFile,
  scanForbidden,
  checkAbsenceOfDevPaths,
  verifyAll,
} from "./verify-desktop-runtime.mjs";

describe("isForbiddenFile", () => {
  it("flaggt .env", async () => {
    expect(await isForbiddenFile(".env")).toBe(".env");
    expect(await isForbiddenFile(".env.prod")).toBe(".env.prod");
    expect(await isForbiddenFile("/some/where/.env.local")).toBe(".env.local");
  });

  it("akzeptiert .env.example", async () => {
    expect(await isForbiddenFile(".env.example")).toBeNull();
  });

  it("flaggt secrets.json", async () => {
    expect(await isForbiddenFile("secrets.json")).toBe("secrets.json");
  });

  it("flaggt *.test.ts und *.spec.ts", async () => {
    expect(await isForbiddenFile("/x/y/foo.test.ts")).toMatch(/test\/spec/);
    expect(await isForbiddenFile("/x/y/foo.spec.ts")).toMatch(/test\/spec/);
  });

  it("flaggt /docs/, /e2e/, /playwright-report/, /test-results/ Pfade", async () => {
    expect(await isForbiddenFile("/x/docs/index.md")).toBe("/docs/");
    expect(await isForbiddenFile("/x/e2e/foo.ts")).toBe("/e2e/");
    expect(await isForbiddenFile("/x/playwright-report/index.html")).toBe("/playwright-report/");
    expect(await isForbiddenFile("/x/test-results/x.json")).toBe("/test-results/");
  });
});

describe("scanForbidden + checkAbsenceOfDevPaths (mit synthetischem Stage)", () => {
  it("rekursiver Scan findet .env und tests, ignoriert saubere Files", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "scan-"));
    try {
      mkdirSync(path.join(tmp, "docs"), { recursive: true });
      writeFileSync(path.join(tmp, "docs", "x.md"), "# hi");
      mkdirSync(path.join(tmp, "public"), { recursive: true });
      writeFileSync(path.join(tmp, "public", "ok.js"), "// ok");
      writeFileSync(path.join(tmp, ".env"), "PG=secret");
      writeFileSync(path.join(tmp, "foo.test.ts"), "x");
      const hits = await scanForbidden(tmp);
      const reasons = hits.map((h) => h.reason).sort();
      expect(reasons).toContain(".env");
      expect(reasons).toContain("/docs/");
      expect(reasons).toContain("test/spec file");
      // sauber
      const publicHit = hits.find((h) => h.file.endsWith("ok.js"));
      expect(publicHit).toBeUndefined();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("Dev-Pfad-Scan erkennt hartkodierten Pfad im .js-File", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "devpath-"));
    try {
      const js = path.join(tmp, "evil.js");
      writeFileSync(js, "const p = 'C:\\\\Projekte\\\\PropertyAI';");
      const hits = await checkAbsenceOfDevPaths(tmp);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0].file).toBe(js);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("sauberer Stage ohne Dev-Pfade => leere Hit-Liste", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "clean-"));
    try {
      writeFileSync(path.join(tmp, "clean.js"), "const p = '/usr/bin';");
      const hits = await checkAbsenceOfDevPaths(tmp);
      expect(hits.length).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("verifyAll (Happy-Path minimaler Mock-Stage)", () => {
  it("fehlende Pfade werden korrekt gemeldet", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "stage-"));
    try {
      // Wir erzeugen nur node/ und postgres/bin/postgres.exe ohne Pflicht-Symbole.
      mkdirSync(path.join(tmp, "node"), { recursive: true });
      mkdirSync(path.join(tmp, "postgres", "bin"), { recursive: true });
      mkdirSync(path.join(tmp, "postgres", "lib"), { recursive: true });
      mkdirSync(path.join(tmp, "postgres", "share"), { recursive: true });
      mkdirSync(path.join(tmp, "postgres", "licenses"), { recursive: true });
      // Pflicht-Tools als leere Dateien:
      const PG_TOOLS = [
        "postgres.exe", "pg_ctl.exe", "initdb.exe", "pg_isready.exe",
        "createdb.exe", "psql.exe", "pg_dump.exe", "pg_restore.exe",
      ];
      for (const t of PG_TOOLS) {
        writeFileSync(path.join(tmp, "postgres", "bin", t), "");
      }
      // node.exe als Stub (PE-Maschine ist nicht 0x8664) — also node fehlt.
      writeFileSync(path.join(tmp, "node", "node.exe"), "no-PE-stub");
      writeFileSync(path.join(tmp, "node", "LICENSE"), "MIT");

      const r = await verifyAll(tmp);
      // expected:
      // - node fehlt (no PE)
      // - app fehlt
      expect(r.node.errors.length).toBeGreaterThan(0);
      expect(r.app.errors.length).toBeGreaterThan(0);
      // forbidden evtl. leer (je nach Pfad) — egal
      expect(r.hasErrors).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
