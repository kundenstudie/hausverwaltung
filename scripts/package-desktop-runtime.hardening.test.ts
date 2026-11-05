// HAVEWA-07D G2-Hardening — Tests fuer die neuen Staging-/Verify-Funktionen.
//
// Coverage:
//   - sanitizeServerJsBuildMetadata: entfernt outputFileTracingRoot +
//     turbopack.root, erzeugt KEINEN Fake-Produktionspfad
//   - sanitizeRequiredServerFiles: appDir -> ".", kein Dev-Pfad
//   - sanitizePrismaSourceMaps: entfernt Source-Map-Build-Pfade
//   - nodeModulesPredicate: entfernt docs/test/examples, behält Runtime
//   - verifyTurbopackAliases: findet Aliase, meldet fehlende
//   - verifyNoFakeProductionPath: meldet "C:\HaVeWa"
//
// Alle Tests laufen mit synthetischen Fixtures (kein echter Build nötig).

import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  sanitizeServerJsBuildMetadata,
  sanitizeRequiredServerFiles,
  sanitizePrismaSourceMaps,
  nodeModulesPredicate,
} from "./package-desktop-runtime.mjs";

import {
  verifyTurbopackAliases,
  verifyNoFakeProductionPath,
} from "./verify-desktop-runtime.mjs";

function tmpDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// sanitizeServerJsBuildMetadata
// ---------------------------------------------------------------------------

describe("sanitizeServerJsBuildMetadata", () => {
  it("setzt outputFileTracingRoot auf '' und entfernt turbopack.root", async () => {
    const tmp = tmpDir("srvjs-");
    try {
      const f = path.join(tmp, "server.js");
      writeFileSync(f, [
        "const path = require('path')",
        'const nextConfig = {"outputFileTracingRoot":"C:\\\\Projekte\\\\PropertyAI\\\\foundation\\\\havewa",',
        '"turbopack":{"resolveAlias":{"next-intl/config":"./src/i18n/request.ts"},"root":"C:\\\\Projekte\\\\PropertyAI\\\\foundation\\\\havewa"},',
        '"distDirRoot":".next"}',
        "process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(nextConfig)",
      ].join("\n"));

      const r = await sanitizeServerJsBuildMetadata(f);
      expect(r.changed).toBe(true);
      const out = readFileSync(f, "utf8");
      expect(out).toContain('"outputFileTracingRoot":""');
      expect(out).not.toContain("PropertyAI");
      expect(out).not.toContain("HaVeWa");
      // resolveAlias bleibt erhalten (Default-Config kennt es weiterhin).
      expect(out).toContain("resolveAlias");
      // distDirRoot bleibt (relativ, nicht Dev-Pfad).
      expect(out).toContain('"distDirRoot":".next"');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("erzeugt KEINEN Fake-Produktionspfad", async () => {
    const tmp = tmpDir("srvjs2-");
    try {
      const f = path.join(tmp, "server.js");
      writeFileSync(f, 'const nextConfig = {"outputFileTracingRoot":"C:\\\\Dev\\\\Build","turbopack":{"root":"C:\\\\Dev\\\\Build"}}');
      await sanitizeServerJsBuildMetadata(f);
      const out = readFileSync(f, "utf8");
      expect(out).not.toMatch(/HaVeWa/i);
      expect(out).not.toContain("Dev\\\\Build");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("ist idempotent (zweiter Lauf aendert nichts)", async () => {
    const tmp = tmpDir("srvjs3-");
    try {
      const f = path.join(tmp, "server.js");
      writeFileSync(f, 'const nextConfig = {"outputFileTracingRoot":"C:\\\\Dev\\\\Build"}');
      const r1 = await sanitizeServerJsBuildMetadata(f);
      expect(r1.changed).toBe(true);
      const after1 = readFileSync(f, "utf8");
      const r2 = await sanitizeServerJsBuildMetadata(f);
      expect(r2.changed).toBe(false);
      expect(readFileSync(f, "utf8")).toBe(after1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("ignoriert eine Datei ohne nextConfig-Konstante", async () => {
    const tmp = tmpDir("srvjs4-");
    try {
      const f = path.join(tmp, "server.js");
      writeFileSync(f, "console.log('hello')");
      const r = await sanitizeServerJsBuildMetadata(f);
      expect(r.changed).toBe(false);
      expect(readFileSync(f, "utf8")).toBe("console.log('hello')");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// sanitizeRequiredServerFiles
// ---------------------------------------------------------------------------

describe("sanitizeRequiredServerFiles", () => {
  it("setzt appDir auf '.' und entfernt die Config-Pfade", async () => {
    const tmp = tmpDir("rsf-");
    try {
      const nextDir = path.join(tmp, ".next");
      mkdirSync(nextDir, { recursive: true });
      const f = path.join(nextDir, "required-server-files.json");
      writeFileSync(f, JSON.stringify({
        version: 1,
        config: {
          outputFileTracingRoot: "C:\\Projekte\\PropertyAI\\foundation\\havewa",
          turbopack: { resolveAlias: { "next-intl/config": "./src/i18n/request.ts" }, root: "C:\\Projekte\\PropertyAI\\foundation\\havewa" },
        },
        appDir: "C:\\Projekte\\PropertyAI\\foundation\\havewa",
        relativeAppDir: "",
      }, null, 2));

      const r = await sanitizeRequiredServerFiles(nextDir);
      expect(r.changed).toBe(true);
      const raw = readFileSync(f, "utf8");
      expect(raw).not.toContain("PropertyAI");
      const j = JSON.parse(raw);
      expect(j.appDir).toBe(".");
      expect(j.config.outputFileTracingRoot).toBe("");
      expect(j.config.turbopack.root).toBeUndefined();
      expect(j.config.turbopack.resolveAlias).toBeDefined();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("ignoriert ungueltiges JSON ohne Absturz", async () => {
    const tmp = tmpDir("rsf2-");
    try {
      const nextDir = path.join(tmp, ".next");
      mkdirSync(nextDir, { recursive: true });
      writeFileSync(path.join(nextDir, "required-server-files.json"), "{ not json");
      const r = await sanitizeRequiredServerFiles(nextDir);
      expect(r.changed).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// sanitizePrismaSourceMaps
// ---------------------------------------------------------------------------

describe("sanitizePrismaSourceMaps", () => {
  it("entfernt Source-Map-Build-Pfade aus dem Prisma-Client", async () => {
    const tmp = tmpDir("smaps-");
    try {
      const clientDir = path.join(tmp, "client");
      mkdirSync(clientDir, { recursive: true });
      writeFileSync(path.join(clientDir, "index.js"), [
        "const x = 1;",
        "//# sourceMappingURL=index.js.map",
        'const m = {"sources":["/mnt/c/Projekte/PropertyAI/foundation/havewa/prisma/schema.prisma"]};',
        "const n = {\"v\":\"C:\\\\Projekte\\\\PropertyAI\\\\foundation\\\\havewa\\\\x.js\"};",
      ].join("\n"));

      const n = await sanitizePrismaSourceMaps(clientDir);
      expect(n).toBe(1);
      const out = readFileSync(path.join(clientDir, "index.js"), "utf8");
      expect(out).not.toContain("PropertyAI");
      expect(out).not.toContain("sourceMappingURL");
      // Der eigentliche Code bleibt erhalten.
      expect(out).toContain("const x = 1;");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("ist bei Dateien ohne Build-Pfade ein No-op", async () => {
    const tmp = tmpDir("smaps2-");
    try {
      const clientDir = path.join(tmp, "client");
      mkdirSync(clientDir, { recursive: true });
      const orig = "const y = 2;";
      writeFileSync(path.join(clientDir, "index.js"), orig);
      const n = await sanitizePrismaSourceMaps(clientDir);
      expect(n).toBe(0);
      expect(readFileSync(path.join(clientDir, "index.js"), "utf8")).toBe(orig);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// nodeModulesPredicate
// ---------------------------------------------------------------------------

describe("nodeModulesPredicate", () => {
  it("entfernt Dokumentation, Tests und Beispiele", () => {
    for (const d of ["docs", "doc", "test", "tests", "example", "examples", "benchmark", "benchmarks"]) {
      expect(nodeModulesPredicate(d)).toBe(false);
    }
  });

  it("behaelt Runtime-Dateien und -Verzeichnisse", () => {
    for (const f of ["lib", "index.js", "pino.js", "package.json", "LICENSE", "README.md", "bin.js"]) {
      expect(nodeModulesPredicate(f)).toBe(true);
    }
  });

  it("entfernt Dev-Konfigurationsdateien", () => {
    for (const f of ["tsconfig.json", "eslint.config.js", ".prettierignore", "favicon.ico", "index.html", "CNAME", ".nojekyll"]) {
      expect(nodeModulesPredicate(f)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// verifyTurbopackAliases / verifyNoFakeProductionPath
// ---------------------------------------------------------------------------

describe("verifyTurbopackAliases", () => {
  it("meldet fehlende Aliase als Fehler", async () => {
    const tmp = tmpDir("alias-");
    try {
      mkdirSync(path.join(tmp, "app", "node_modules"), { recursive: true });
      const r = await verifyTurbopackAliases(tmp);
      expect(r.errors.length).toBeGreaterThan(0);
      expect(r.aliases.length).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("erkennt materialisierte Aliase", async () => {
    const tmp = tmpDir("alias2-");
    try {
      const nm = path.join(tmp, "app", "node_modules");
      mkdirSync(path.join(nm, "@prisma", "client-2c3a283f134fdcb6"), { recursive: true });
      mkdirSync(path.join(nm, "pino-28069d5257187539"), { recursive: true });
      const r = await verifyTurbopackAliases(tmp);
      expect(r.errors.length).toBe(0);
      expect(r.aliases).toContain("@prisma/client-2c3a283f134fdcb6");
      expect(r.aliases).toContain("pino-28069d5257187539");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("verifyNoFakeProductionPath", () => {
  it("meldet den Fake-Marker 'HaVeWa' in server.js", async () => {
    const tmp = tmpDir("fake-");
    try {
      const appDir = path.join(tmp, "app");
      mkdirSync(appDir, { recursive: true });
      writeFileSync(path.join(appDir, "server.js"),
        'const nextConfig = {"outputFileTracingRoot":"C:\\\\HaVeWa"}');
      const r = await verifyNoFakeProductionPath(tmp);
      expect(r.errors.length).toBeGreaterThan(0);
      expect(r.errors.join(" ")).toMatch(/HaVeWa/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("akzeptiert einen neutralen Stage", async () => {
    const tmp = tmpDir("fake2-");
    try {
      const appDir = path.join(tmp, "app");
      mkdirSync(path.join(appDir, ".next"), { recursive: true });
      writeFileSync(path.join(appDir, "server.js"),
        'const nextConfig = {"outputFileTracingRoot":"","turbopack":{"resolveAlias":{}}}');
      writeFileSync(path.join(appDir, ".next", "required-server-files.json"),
        JSON.stringify({ version: 1, appDir: ".", config: { outputFileTracingRoot: "", turbopack: {} } }));
      const r = await verifyNoFakeProductionPath(tmp);
      expect(r.errors.length).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("meldet nicht neutralisierten appDir", async () => {
    const tmp = tmpDir("fake3-");
    try {
      const appDir = path.join(tmp, "app");
      mkdirSync(path.join(appDir, ".next"), { recursive: true });
      writeFileSync(path.join(appDir, ".next", "required-server-files.json"),
        JSON.stringify({ version: 1, appDir: "C:\\Dev\\Build", config: {} }));
      const r = await verifyNoFakeProductionPath(tmp);
      expect(r.errors.length).toBeGreaterThan(0);
      expect(r.errors.join(" ")).toMatch(/appDir/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
