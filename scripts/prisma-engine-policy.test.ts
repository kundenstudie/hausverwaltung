// HAVEWA-07D G7-FIX — Regressionstests: Windows-only Prisma-Packaging.
//
// ROOT CAUSE (G7-Blocker):
//   Der 0.6.0-Installer enthielt die native Prisma-Engine
//     @prisma/engines/schema-engine-linux-arm64-openssl-3.0.x
//   (ELF/aarch64, ~19 MB). Ursache:
//     - Packaging: prunePrismaClientEngines() erkannte NUR die Praefixe
//       `libquery_engine-` / `query_engine-`.
//     - Verifier: verifyPrismaEngines() pruefte nur 5 feste Namensmuster.
//
// Coverage dieser Datei:
//   1) Policy: classifyPrismaEngine() fuer ALLE Engine-FAMILIEN
//   2) REGRESSION: schema-engine-linux-arm64-openssl-3.0.x => FAIL
//   3) Gegenbeispiel: Windows-x64 Engines => PASS
//   4) Scanner: ELF-Magic-Erkennung (Inhalt, nicht nur Name)
//   5) Packaging: prunePrismaClientEngines entfernt non-windows-x64
//   6) Verifier: verifyPrismaEngines meldet die Regression
//   7) Fail-closed: unbekanntes Target wird verworfen
//
// Alle Tests laufen mit synthetischen Fixtures (kein echter Build nötig).

import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  classifyPrismaEngine,
  detectBinaryFormat,
  engineFamily,
  engineTarget,
  isNativePrismaEngineFile,
  PRISMA_ENGINE_FAMILIES,
  PRISMA_FORBIDDEN_NAME_PATTERNS,
} from "./prisma-engine-policy.mjs";

import {
  scanPrismaEngines,
  filterWindowsX64Only,
} from "./prisma-engine-scan.mjs";

import { prunePrismaClientEngines } from "./package-desktop-runtime.mjs";
import { verifyPrismaEngines } from "./verify-desktop-runtime.mjs";

function tmpDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

/** Minimaler ELF-Header (nur Magic + Klassen-Byte). */
function elfBytes(): Buffer {
  const b = Buffer.alloc(64, 0);
  b[0] = 0x7f; b[1] = 0x45; b[2] = 0x4c; b[3] = 0x46;
  b[4] = 0x02; // 64-bit
  b[18] = 0xb7; // EM_AARCH64
  return b;
}

/** Minimaler PE-Header ("MZ" + PE-Signatur an Offset 0x3c). */
function peBytes(): Buffer {
  const b = Buffer.alloc(256, 0);
  b[0] = 0x4d; b[1] = 0x5a;
  b.writeUInt32LE(0x80, 0x3c);
  b[0x80] = 0x50; b[0x81] = 0x45; b[0x82] = 0x00; b[0x83] = 0x00;
  b.writeUInt16LE(0x8664, 0x84); // IMAGE_FILE_MACHINE_AMD64
  return b;
}

// ---------------------------------------------------------------------------
// 1) Policy — Engine-FAMILIEN
// ---------------------------------------------------------------------------

describe("PRISMA_ENGINE_FAMILIES", () => {
  it("deckt alle relevanten Prisma-Engine-Familien ab", () => {
    for (const fam of [
      "query_engine",
      "libquery_engine",
      "schema-engine",
      "migration-engine",
      "introspection-engine",
      "prisma-fmt",
    ]) {
      expect(PRISMA_ENGINE_FAMILIES).toContain(fam);
    }
  });
});

describe("engineFamily", () => {
  it("erkennt schema-engine-* (der G7-Blocker)", () => {
    expect(engineFamily("schema-engine-linux-arm64-openssl-3.0.x")).toBe("schema-engine");
    expect(engineFamily("schema-engine-windows.exe")).toBe("schema-engine");
  });

  it("erkennt query_engine- und libquery_engine-*", () => {
    expect(engineFamily("query_engine-windows.dll.node")).toBe("query_engine");
    expect(engineFamily("libquery_engine-linux-arm64-openssl-3.0.x.so.node"))
      .toBe("libquery_engine");
  });

  it("erkennt migration-/introspection-engine-*", () => {
    expect(engineFamily("migration-engine-debian-openssl-3.0.x")).toBe("migration-engine");
    expect(engineFamily("introspection-engine-linux")).toBe("introspection-engine");
  });

  it("erkennt KEINE Nicht-Engine-Dateien", () => {
    expect(engineFamily("query_engine_bg.postgresql.js")).toBeNull();
    expect(engineFamily("README.md")).toBeNull();
    expect(engineFamily("package.json")).toBeNull();
  });
});

describe("isNativePrismaEngineFile", () => {
  it("true fuer native Engine-Binaries", () => {
    expect(isNativePrismaEngineFile("schema-engine-linux-arm64-openssl-3.0.x")).toBe(true);
    expect(isNativePrismaEngineFile("query_engine-windows.dll.node")).toBe(true);
    expect(isNativePrismaEngineFile("libquery_engine-linux-arm64-openssl-3.0.x.so.node")).toBe(true);
  });

  it("false fuer WASM-/JS-Bindings (keine native Target-Binaries)", () => {
    expect(isNativePrismaEngineFile("query_engine_bg.postgresql.js")).toBe(false);
    expect(isNativePrismaEngineFile("query_engine_bg.postgresql.mjs")).toBe(false);
    expect(isNativePrismaEngineFile("query_engine_bg.postgresql.wasm")).toBe(false);
    expect(isNativePrismaEngineFile("wasm-engine-edge.mjs")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2) REGRESSION: schema-engine-linux-arm64-openssl-3.0.x => FAIL
// ---------------------------------------------------------------------------

describe("REGRESSION schema-engine-linux-arm64-openssl-3.0.x", () => {
  const BLOCKER = "schema-engine-linux-arm64-openssl-3.0.x";

  it("wird als Engine erkannt", () => {
    expect(engineFamily(BLOCKER)).toBe("schema-engine");
  });

  it("ist NICHT windows-x64 => muss entfernt / als Fehler gemeldet werden", () => {
    const cls = classifyPrismaEngine(BLOCKER);
    expect(cls.isEngine).toBe(true);
    expect(cls.allowed).toBe(false);
    expect(cls.reason).toMatch(/nicht windows-x64/);
    expect(cls.target.os).toBe("linux");
    expect(cls.target.arch).toBe("arm64");
  });

  it("wird vom Scanner als Violation erkannt", async () => {
    const tmp = tmpDir("g7-regr-");
    try {
      const dir = path.join(tmp, "node_modules", "@prisma", "engines");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, BLOCKER), elfBytes());
      writeFileSync(path.join(dir, "query_engine-windows.dll.node"), peBytes());

      const { engines, violations } = await scanPrismaEngines(tmp);
      expect(violations.length).toBe(1);
      expect(violations[0].name).toBe(BLOCKER);
      expect(violations[0].target.os).toBe("linux");
      expect(violations[0].target.arch).toBe("arm64");
      expect(violations[0].format).toBe("elf");
      expect(engines.length).toBe(2);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("wird vom Packaging-Filter entfernt", async () => {
    const tmp = tmpDir("g7-regr2-");
    try {
      const dir = path.join(tmp, "@prisma", "engines");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, BLOCKER), elfBytes());
      writeFileSync(path.join(dir, "schema-engine-windows.exe"), peBytes());
      writeFileSync(path.join(dir, "query_engine-windows.dll.node"), peBytes());

      const r = await prunePrismaClientEngines(tmp);
      expect(r.removed).toContain(BLOCKER);
      expect(r.kept).toContain("schema-engine-windows.exe");
      expect(r.kept).toContain("query_engine-windows.dll.node");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("wird vom Verifier als FAIL gemeldet", async () => {
    const tmp = tmpDir("g7-regr3-");
    try {
      const dir = path.join(tmp, "app", "scripts", ".runtime", "prisma-cli",
        "node_modules", "@prisma", "engines");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, BLOCKER), elfBytes());
      writeFileSync(path.join(dir, "schema-engine-windows.exe"), peBytes());
      writeFileSync(path.join(dir, "query_engine-windows.dll.node"), peBytes());

      const r = await verifyPrismaEngines(tmp);
      expect(r.errors.length).toBeGreaterThan(0);
      expect(r.errors.join(" ")).toContain(BLOCKER);
      expect(r.violations.length).toBe(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("taucht in den verbotenen Installer-Namensmustern auf", () => {
    // Der NSIS-Datei-Tabellen-Scan nutzt Klartext-Patterns.
    expect(PRISMA_FORBIDDEN_NAME_PATTERNS).toContain("schema-engine-linux");
    expect(PRISMA_FORBIDDEN_NAME_PATTERNS).toContain("arm64");
  });
});

// ---------------------------------------------------------------------------
// 3) Gegenbeispiel: Windows-x64 => PASS
// ---------------------------------------------------------------------------

describe("Gegenbeispiel: Windows-x64-Engines => PASS", () => {
  const WINDOWS_ENGINES = [
    "query_engine-windows.dll.node",
    "schema-engine-windows.exe",
  ];

  it("sind erlaubt (windows-x64)", () => {
    for (const n of WINDOWS_ENGINES) {
      const cls = classifyPrismaEngine(n);
      expect(cls.isEngine).toBe(true);
      expect(cls.allowed).toBe(true);
      expect(cls.reason).toBeNull();
      expect(cls.target.os).toBe("windows");
      expect(cls.target.arch).toBe("x64");
    }
  });

  it("werden vom Scanner NICHT als Violation gemeldet", async () => {
    const tmp = tmpDir("g7-win-");
    try {
      const dir = path.join(tmp, "node_modules", "@prisma", "engines");
      mkdirSync(dir, { recursive: true });
      for (const n of WINDOWS_ENGINES) {
        writeFileSync(path.join(dir, n), peBytes());
      }
      const { violations } = await scanPrismaEngines(tmp);
      expect(violations.length).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("werden vom Packaging-Filter behalten", async () => {
    const tmp = tmpDir("g7-win2-");
    try {
      const dir = path.join(tmp, "@prisma", "engines");
      mkdirSync(dir, { recursive: true });
      for (const n of WINDOWS_ENGINES) {
        writeFileSync(path.join(dir, n), peBytes());
      }
      const r = await prunePrismaClientEngines(tmp);
      expect(r.removed).toEqual([]);
      expect([...r.kept].sort()).toEqual([...WINDOWS_ENGINES].sort());
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("ergeben im Verifier KEINE Engine-Fehler (nur Pflicht-Engine-Prüfung)", async () => {
    const tmp = tmpDir("g7-win3-");
    try {
      const dir = path.join(tmp, "app", "scripts", ".runtime", "prisma-cli",
        "node_modules", "@prisma", "engines");
      mkdirSync(dir, { recursive: true });
      for (const n of WINDOWS_ENGINES) {
        writeFileSync(path.join(dir, n), peBytes());
      }
      const r = await verifyPrismaEngines(tmp);
      expect(r.violations.length).toBe(0);
      expect(r.errors.length).toBe(0);
      expect(r.engines.length).toBe(2);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 4) Scanner — Magic-Erkennung (Inhalt, nicht nur Name)
// ---------------------------------------------------------------------------

describe("detectBinaryFormat", () => {
  it("erkennt ELF (Linux)", () => {
    expect(detectBinaryFormat(elfBytes())).toBe("elf");
  });

  it("erkennt PE (Windows)", () => {
    expect(detectBinaryFormat(peBytes())).toBe("pe");
  });

  it("erkennt Text nicht als Binary", () => {
    expect(detectBinaryFormat(Buffer.from("hello world"))).toBeNull();
  });

  it("erkennt Mach-O", () => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(0xfeedfacf, 0);
    expect(detectBinaryFormat(b)).toBe("macho");
  });
});

describe("scanPrismaEngines", () => {
  it("meldet KEINE Engine fuer einen leeren Baum", async () => {
    const tmp = tmpDir("g7-empty-");
    try {
      const { engines, violations } = await scanPrismaEngines(tmp);
      expect(engines.length).toBe(0);
      expect(violations.length).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("ignoriert WASM-/JS-Engine-Bindings (keine native Engines)", async () => {
    const tmp = tmpDir("g7-wasm-");
    try {
      const dir = path.join(tmp, "runtime");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "query_engine_bg.postgresql.js"), "module.exports={};");
      writeFileSync(path.join(dir, "query_engine_bg.postgresql.wasm"), Buffer.from([0x00, 0x61, 0x73, 0x6d]));
      writeFileSync(path.join(dir, "wasm-engine-edge.mjs"), "export default 1;");
      const { engines, violations } = await scanPrismaEngines(tmp);
      expect(engines.length).toBe(0);
      expect(violations.length).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("zaehlt Linux- und ARM64-Engines separat", async () => {
    const tmp = tmpDir("g7-count-");
    try {
      const dir = path.join(tmp, "engines");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "schema-engine-linux-arm64-openssl-3.0.x"), elfBytes());
      writeFileSync(path.join(dir, "libquery_engine-linux-arm64-openssl-3.0.x.so.node"), elfBytes());
      writeFileSync(path.join(dir, "query_engine-windows.dll.node"), peBytes());
      writeFileSync(path.join(dir, "schema-engine-windows.exe"), peBytes());

      const { engines, violations } = await scanPrismaEngines(tmp);
      const linux = engines.filter((e) => e.target.os === "linux").length;
      const arm = engines.filter((e) => e.target.arch === "arm64").length;
      expect(linux).toBe(2);
      expect(arm).toBe(2);
      expect(violations.length).toBe(2);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 5) Fail-closed + weitere Familien
// ---------------------------------------------------------------------------

describe("fail-closed Klassifikation", () => {
  it("verwirft Engines ohne erkennbares Target", () => {
    const cls = classifyPrismaEngine("schema-engine-unknown-target");
    expect(cls.isEngine).toBe(true);
    expect(cls.allowed).toBe(false);
    expect(cls.target.matched).toBe(false);
  });

  it("verwirft eine als windows-x64 benannte Datei mit ELF-Inhalt", () => {
    // Gegenprobe ueber den Dateiinhalt: Name sagt "windows", Magic sagt ELF.
    const cls = classifyPrismaEngine("schema-engine-windows.exe", elfBytes());
    expect(cls.allowed).toBe(false);
    expect(cls.reason).toMatch(/elf/i);
  });

  it("erlaubt eine als windows-x64 benannte Datei mit PE-Inhalt", () => {
    const cls = classifyPrismaEngine("query_engine-windows.dll.node", peBytes());
    expect(cls.allowed).toBe(true);
    expect(cls.reason).toBeNull();
  });

  it("verwirft alle Nicht-Windows-Targets", () => {
    const forbidden = [
      "query_engine-linux-musl-openssl-3.0.x.so.node",
      "libquery_engine-debian-openssl-3.0.x.so.node",
      "schema-engine-alpine-openssl-3.0.x",
      "schema-engine-darwin",
      "schema-engine-freebsd",
      "migration-engine-linux",
      "introspection-engine-debian",
      "query_engine-rhel-openssl-3.0.x.so.node",
    ];
    for (const n of forbidden) {
      const cls = classifyPrismaEngine(n);
      expect(cls.allowed, `${n} muss verboten sein`).toBe(false);
    }
  });

  it("behaelt Windows-x64 fuer alle bekannten Familien", () => {
    const allowed = [
      "query_engine-windows.dll.node",
      "libquery_engine-windows.dll.node",
      "schema-engine-windows.exe",
      "migration-engine-windows.exe",
      "introspection-engine-windows.exe",
      "prisma-fmt-windows.exe",
    ];
    for (const n of allowed) {
      const cls = classifyPrismaEngine(n);
      expect(cls.allowed, `${n} muss erlaubt sein`).toBe(true);
    }
  });
});

describe("engineTarget", () => {
  it("leitet arm64/linux korrekt ab", () => {
    const t = engineTarget("schema-engine-linux-arm64-openssl-3.0.x");
    expect(t.os).toBe("linux");
    expect(t.arch).toBe("arm64");
  });

  it("leitet windows/x64 korrekt ab", () => {
    const t = engineTarget("query_engine-windows.dll.node");
    expect(t.os).toBe("windows");
    expect(t.arch).toBe("x64");
  });
});

// ---------------------------------------------------------------------------
// 6) Kopier-Filter (packaging, zentral)
// ---------------------------------------------------------------------------

describe("filterWindowsX64Only", () => {
  it("behaelt Windows-x64 und verwirft Linux/ARM64", async () => {
    const tmp = tmpDir("g7-filter-");
    try {
      mkdirSync(path.join(tmp, "engines"), { recursive: true });
      const files = [
        "query_engine-windows.dll.node",
        "schema-engine-windows.exe",
        "schema-engine-linux-arm64-openssl-3.0.x",
        "libquery_engine-linux-arm64-openssl-3.0.x.so.node",
        "package.json",
      ];
      for (const f of files) {
        writeFileSync(path.join(tmp, "engines", f), f.includes("windows") ? peBytes() : elfBytes());
      }
      const names = files.map((f) => `engines/${f}`);
      const r = await filterWindowsX64Only(tmp, names);
      expect([...r.keep].sort()).toEqual([
        "engines/package.json",
        "engines/query_engine-windows.dll.node",
        "engines/schema-engine-windows.exe",
      ].sort());
      expect([...r.drop].sort()).toEqual([
        "engines/libquery_engine-linux-arm64-openssl-3.0.x.so.node",
        "engines/schema-engine-linux-arm64-openssl-3.0.x",
      ].sort());
      expect(r.droppedDetails.length).toBe(2);
      expect(r.droppedDetails.every((d) => d.format === "elf")).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 7) Packaging: Kopier-Zeit-Filter (kein nachtraegliches Loeschen)
// ---------------------------------------------------------------------------

describe("Packaging-Kopierer (fail-closed, beim Kopieren)", () => {
  it("schreibt non-windows-x64 Engines NIE in den Stage", async () => {
    const tmp = tmpDir("g7-copy-");
    try {
      const src = path.join(tmp, "src", "node_modules", "@prisma", "engines");
      const dst = path.join(tmp, "dst", "node_modules", "@prisma", "engines");
      mkdirSync(src, { recursive: true });
      writeFileSync(path.join(src, "schema-engine-linux-arm64-openssl-3.0.x"), elfBytes());
      writeFileSync(path.join(src, "schema-engine-windows.exe"), peBytes());
      writeFileSync(path.join(src, "query_engine-windows.dll.node"), peBytes());
      writeFileSync(path.join(src, "package.json"), "{}");

      const { copyDirPrismaWindowsX64 } = await import("./prisma-runtime-tree.mjs");
      const dropped = await copyDirPrismaWindowsX64(src, dst);

      expect(dropped).toEqual(["schema-engine-linux-arm64-openssl-3.0.x"]);
      // Die verbotene Engine liegt NICHT im Ziel.
      expect(existsSync(path.join(dst, "schema-engine-linux-arm64-openssl-3.0.x"))).toBe(false);
      // Die Windows-x64 Engines sind kopiert.
      expect(existsSync(path.join(dst, "schema-engine-windows.exe"))).toBe(true);
      expect(existsSync(path.join(dst, "query_engine-windows.dll.node"))).toBe(true);
      expect(existsSync(path.join(dst, "package.json"))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 8) Installer-Verifier (Payload-Pruefung)
// ---------------------------------------------------------------------------

describe("Installer-Verifier: Payload-Pruefung", () => {
  it("meldet FAIL fuer schema-engine-linux-arm64 im Payload", async () => {
    const tmp = tmpDir("g7-inst-");
    try {
      const dir = path.join(tmp, "app", "scripts", ".runtime", "prisma-cli",
        "node_modules", "@prisma", "engines");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "schema-engine-linux-arm64-openssl-3.0.x"), elfBytes());
      writeFileSync(path.join(dir, "schema-engine-windows.exe"), peBytes());

      const { verifyPayloadPrismaEngines } = await import("./verify-desktop-installer.mjs");
      const r = await verifyPayloadPrismaEngines(path.join(tmp, "app"));
      expect(r.violations.length).toBe(1);
      expect(r.violations[0].name).toBe("schema-engine-linux-arm64-openssl-3.0.x");
      expect(r.linux).toBe(1);
      expect(r.arm64).toBe(1);
      expect(r.windowsOnly).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("meldet PASS fuer einen Windows-x64-only Payload", async () => {
    const tmp = tmpDir("g7-inst2-");
    try {
      const dir = path.join(tmp, "app", "scripts", ".runtime", "prisma-cli",
        "node_modules", "@prisma", "engines");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "schema-engine-windows.exe"), peBytes());
      writeFileSync(path.join(dir, "query_engine-windows.dll.node"), peBytes());

      const { verifyPayloadPrismaEngines } = await import("./verify-desktop-installer.mjs");
      const r = await verifyPayloadPrismaEngines(path.join(tmp, "app"));
      expect(r.violations.length).toBe(0);
      expect(r.linux).toBe(0);
      expect(r.arm64).toBe(0);
      expect(r.total).toBe(2);
      expect(r.windowsOnly).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 9) Runtime-Dep-Integritaet: Die Stage-Skripte duerfen keine
//    unaufgeloesten relativen Imports haben.
//
// REGRESSION (vom installierten Smoke gefunden):
//   `prisma-runtime-tree.mjs` importiert `prisma-engine-policy.mjs`.
//   Beide MUSSEN im Stage (`<app>/scripts/`) liegen, sonst bricht der
//   `migrate deploy` zur Laufzeit mit ERR_MODULE_NOT_FOUND ab.
// ---------------------------------------------------------------------------

describe("Stage-Runtime-Dep-Integritaet", () => {
  const RUNTIME_SCRIPTS = [
    "prisma-runtime-tree.mjs",
    "prisma-engine-policy.mjs",
    "prisma-engine-scan.mjs",
  ];

  it("die Repo-Runtime-Skripte importieren nur existierende lokale Module", async () => {
    const repoScripts = path.resolve(__dirname);
    for (const f of RUNTIME_SCRIPTS) {
      const p = path.join(repoScripts, f);
      expect(existsSync(p), `${f} fehlt im Repo`).toBe(true);
      const src = readFileSync(p, "utf8");
      const importRe = /from\s+"(\.\/[^"]+)"/g;
      let m = importRe.exec(src);
      while (m !== null) {
        const dep = path.join(repoScripts, m[1]);
        expect(existsSync(dep), `${f} importiert fehlendes Modul ${m[1]}`).toBe(true);
        m = importRe.exec(src);
      }
    }
  });

  it("der Stage muss die Policy-Module als Pflichtpfade fuehren", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      path.join(path.resolve(__dirname), "package-desktop-runtime.mjs"), "utf8",
    );
    expect(src).toContain("scripts/prisma-engine-policy.mjs");
    expect(src).toContain("scripts/prisma-engine-scan.mjs");
  });
});
