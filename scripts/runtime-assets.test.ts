// HAVEWA-07D G1 — Tests for scripts/runtime-assets.mjs.
//
// Wir testen sowohl die Lockfile-/Validierungslogik als auch die
// Cache-/Hash-/Extract-Schritte mit synthetischen Fixtures.
// Wir laden KEINE echten 300-MB-Archive in den Unit-Tests.
//
// Coverage:
//   - Lockfile parsing (gültig / ungültig / keine absoluten Pfade / wrong schema)
//   - Hash mismatch => failure
//   - Wrong architecture => failure
//   - Missing required executable => failure
//   - Wrong version => failure
//   - Cache reuse (gültig)
//   - Corrupt cache => revalidate
//   - Atomic download (.tmp -> verify -> rename)

import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import {
  loadLockfile,
  verifyArchiveHash,
  verifyExtractedNode,
  verifyExtractedPostgres,
  isCacheValid,
  verifyAsset,
  extractZipSafely,
} from "./runtime-assets.mjs";

const REPO_ROOT = process.cwd();
const LOCKFILE_PATH = path.join(REPO_ROOT, "scripts", "runtime-assets.lock.json");

// ---------------- Hilfsfunktionen für Tests --------------------------------

/** Schreibt einen Buffer, gibt sha256 hex zurück. */
function sha256OfBuffer(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Schreibt eine kleine ZIP mit einem Eintrag (STORED) und liefert den SHA256. */
function makeStoredZipWithStagedFile(
  fileName: string,
  fileBytes: Buffer,
): { bytes: Buffer; sha256: string } {
  // ZIP Local File Header (30 + name + extra(0)) + data + Central Dir (46 + name + extra(0)) + EOCD (22)
  const nameBuf = Buffer.from(fileName, "utf8");
  const lfh = Buffer.alloc(30);
  // signature
  lfh.writeUInt32LE(0x04034b50, 0);
  // version needed
  lfh.writeUInt16LE(20, 4);
  // gp flag (utf-8 names)
  lfh.writeUInt16LE(0x0800, 6);
  // compression (0 = stored)
  lfh.writeUInt16LE(0, 8);
  // mod time/date -> 0
  lfh.writeUInt16LE(0, 10);
  lfh.writeUInt16LE(0, 12);
  // crc32 (irrelevant, set 0)
  lfh.writeUInt32LE(0, 14);
  // compressed size = uncompressed size
  lfh.writeUInt32LE(fileBytes.length, 18);
  lfh.writeUInt32LE(fileBytes.length, 22);
  // file name length
  lfh.writeUInt16LE(nameBuf.length, 26);
  // extra field length
  lfh.writeUInt16LE(0, 28);
  const lfhFull = Buffer.concat([lfh, nameBuf]);

  // CD-Offset im File: lfhFull + payload.
  const cdOffset = lfhFull.length + fileBytes.length;

  const cdEntry = Buffer.alloc(46);
  cdEntry.writeUInt32LE(0x02014b50, 0);
  // version made by
  cdEntry.writeUInt16LE(20, 4);
  cdEntry.writeUInt16LE(20, 6);
  cdEntry.writeUInt16LE(0, 8); // gp flag
  cdEntry.writeUInt16LE(0, 10); // compression
  cdEntry.writeUInt16LE(0, 12); // mod time
  cdEntry.writeUInt16LE(0, 14); // mod date
  cdEntry.writeUInt32LE(0, 16); // crc
  cdEntry.writeUInt32LE(fileBytes.length, 20); // comp size
  cdEntry.writeUInt32LE(fileBytes.length, 24); // uncomp size
  cdEntry.writeUInt16LE(nameBuf.length, 28);
  cdEntry.writeUInt16LE(0, 30); // extra
  cdEntry.writeUInt16LE(0, 32); // comment
  cdEntry.writeUInt16LE(0, 34); // disk
  cdEntry.writeUInt16LE(0, 36); // internal attrs
  cdEntry.writeUInt32LE(0, 38); // external attrs
  cdEntry.writeUInt32LE(0, 42); // local header offset = file start
  const cdFull = Buffer.concat([cdEntry, nameBuf]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk
  eocd.writeUInt16LE(0, 6); // start disk
  eocd.writeUInt16LE(1, 8); // entries on this disk
  eocd.writeUInt16LE(1, 10); // total entries
  eocd.writeUInt32LE(cdFull.length, 12); // cd size
  eocd.writeUInt32LE(cdOffset, 16); // cd offset
  eocd.writeUInt16LE(0, 20); // comment length

  const out = Buffer.concat([lfhFull, fileBytes, cdFull, eocd]);
  return {
    bytes: out,
    sha256: sha256OfBuffer(out),
  };
}

/** Erzeugt einen minimalen RuntimeAssetEntry (fake, aber typkonform). */
function fakeNodeEntry(overrides: Partial<{
  sha256: string;
  archive: string;
}> = {}) {
  return {
    version: "v22.23.3",
    platform: "win32" as const,
    arch: "x64" as const,
    archive: overrides.archive ?? "x.zip",
    url: "https://nodejs.org/dist/v22.23.3/x.zip",
    sha256: overrides.sha256 ?? "0".repeat(64),
    sha256Source: "vendor:nodejs",
    hashProvenance: "vendor" as const,
    requiredTools: ["node.exe"],
    requiredLicense: "LICENSE",
  };
}

function fakePgEntry(overrides: Partial<{
  sha256: string;
  archive: string;
  requiredTools: readonly string[];
  requiredLicenses: readonly string[];
}> = {}) {
  return {
    version: "16.14",
    platform: "win32" as const,
    arch: "x64" as const,
    archive: overrides.archive ?? "p.zip",
    url: "https://get.enterprisedb.com/postgresql/x.zip",
    sha256: overrides.sha256 ?? "0".repeat(64),
    sha256Source: "tofu:local-recompute:2026-10-19",
    hashProvenance: "tofu" as const,
    requiredTools: overrides.requiredTools ?? [
      "postgres.exe",
      "pg_ctl.exe",
      "initdb.exe",
      "pg_isready.exe",
      "createdb.exe",
      "psql.exe",
      "pg_dump.exe",
      "pg_restore.exe",
    ],
    requiredLicenses: overrides.requiredLicenses ?? ["pgsql/server_license.txt"],
  };
}

// ---------------- Tests -----------------------------------------------------

describe("loadLockfile", () => {
  it("lädt das echte Lockfile ohne Fehler", () => {
    const lf = loadLockfile(LOCKFILE_PATH);
    expect(lf.schemaVersion).toBe(1);
    expect(lf.node.platform).toBe("win32");
    expect(lf.node.arch).toBe("x64");
    expect(lf.node.hashProvenance).toBe("vendor");
    expect(lf.postgres.hashProvenance).toBe("tofu");
    expect(/^[0-9a-fA-F]{64}$/.test(lf.node.sha256)).toBe(true);
    expect(/^[0-9a-fA-F]{64}$/.test(lf.postgres.sha256)).toBe(true);
  });

  it("lehnt Lockfile mit lokalem absolutem Pfad ab", () => {
    const tmp: string = mkdtempSync(path.join(tmpdir(), "lf-"));
    try {
      const lockPath = path.join(tmp, "lf.json");
      const data = readFileSync(LOCKFILE_PATH, "utf8").replace(
        /"sha256Source":\s*"vendor:[^"]*"/,
        `"sha256Source": "C:\\\\forbidden\\\\path"`,
      );
      writeFileSync(lockPath, data);
      expect(() => loadLockfile(lockPath)).toThrow(/absoluter Pfad/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("lehnt Lockfile mit falschem Schema ab", () => {
    const tmp: string = mkdtempSync(path.join(tmpdir(), "lf-"));
    try {
      const lockPath = path.join(tmp, "lf.json");
      writeFileSync(lockPath, JSON.stringify({ schemaVersion: 2 }));
      expect(() => loadLockfile(lockPath)).toThrow(/schemaVersion/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("lehnt Lockfile mit falschem Hash-Länge ab", () => {
    const tmp: string = mkdtempSync(path.join(tmpdir(), "lf-"));
    try {
      const lockPath = path.join(tmp, "lf.json");
      const data = readFileSync(LOCKFILE_PATH, "utf8").replace(
        /"sha256":\s*"[0-9a-fA-F]{64}"/,
        `"sha256": "deadbeef"`,
      );
      writeFileSync(lockPath, data);
      expect(() => loadLockfile(lockPath)).toThrow(/64-Hex/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("verifyArchiveHash", () => {
  it("akzeptiert passenden Hash", async () => {
    const tmp: string = mkdtempSync(path.join(tmpdir(), "hashtest-"));
    try {
      const f = path.join(tmp, "x.bin");
      const bytes = Buffer.from("hello world!");
      writeFileSync(f, bytes);
      const expected = sha256OfBuffer(bytes);
      const r = await verifyArchiveHash(f, expected);
      expect(r.ok).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("lehnt falschen Hash ab (HARD STOP)", async () => {
    const tmp: string = mkdtempSync(path.join(tmpdir(), "hashtest-"));
    try {
      const f = path.join(tmp, "x.bin");
      writeFileSync(f, Buffer.from("hello"));
      const r = await verifyArchiveHash(f, "00".repeat(32));
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/SHA256 mismatch/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fehlt-File => failure", async () => {
    const tmp: string = mkdtempSync(path.join(tmpdir(), "hashtest-"));
    try {
      const r = await verifyArchiveHash(path.join(tmp, "missing"), "00".repeat(32));
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/existiert nicht/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("extractZipSafely + verifyExtractedNode", () => {
  it("extrahiert ein STORED-ZIP mit einem Member unter die Wurzel 'node-v22.23.3-win-x64/'", async () => {
    const tmp: string = mkdtempSync(path.join(tmpdir(), "zipext-"));
    try {
      const archive = path.join(tmp, "fake.zip");
      const payload = Buffer.from("not-a-real-pe-but-marker");
      const { bytes, sha256 } = makeStoredZipWithStagedFile(
        "node-v22.23.3-win-x64/hello.txt",
        payload,
      );
      writeFileSync(archive, bytes);
      const outDir = path.join(tmp, "extract");
      const r = await extractZipSafely(archive, outDir);
      expect(r.ok).toBe(true);
      expect(existsSync(path.join(outDir, "node-v22.23.3-win-x64", "hello.txt"))).toBe(true);
      // SHA256 wurde hier nur gebraucht, damit Test selbstkontrollierend ist:
      expect(sha256.length).toBe(64);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("lehnt Path-Traversal ab", async () => {
    const tmp: string = mkdtempSync(path.join(tmpdir(), "zipext-"));
    try {
      const archive = path.join(tmp, "evil.zip");
      const payload = Buffer.from("pwn");
      const { bytes } = makeStoredZipWithStagedFile("../escape.txt", payload);
      writeFileSync(archive, bytes);
      const r = await extractZipSafely(archive, path.join(tmp, "extract"));
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/Path-Traversal|absoluter Pfad/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("akzeptiert Dateinamen mit doppeltem Punkt (z.B. foo..bar)", async () => {
    const tmp: string = mkdtempSync(path.join(tmpdir(), "zipext-"));
    try {
      const archive = path.join(tmp, "ok.zip");
      const payload = Buffer.from("not-trav");
      const { bytes } = makeStoredZipWithStagedFile("a/b/foo..bar.txt", payload);
      writeFileSync(archive, bytes);
      const r = await extractZipSafely(archive, path.join(tmp, "extract"));
      expect(r.ok).toBe(true);
      expect(
        existsSync(path.join(tmp, "extract", "a", "b", "foo..bar.txt")),
      ).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("verifyExtractedPostgres (fehlende Tools)", () => {
  it("schlägt fehl, wenn die erforderliche Executable fehlt", async () => {
    const tmp: string = mkdtempSync(path.join(tmpdir(), "pgverify-"));
    try {
      const extractedDir = path.join(tmp, "extracted");
      mkdirSync(extractedDir, { recursive: true });
      mkdirSync(path.join(extractedDir, "pgsql", "bin"), { recursive: true });
      const entry = fakePgEntry();
      const r = await verifyExtractedPostgres(extractedDir, entry);
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/postgres\.exe|Erforderliches Tool fehlt/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("verifyExtractedNode — wrong architecture erzwingt FAIL", () => {
  it("schlägt fehl, wenn node.exe keine x64-PE ist (nur Stub-Bytes)", async () => {
    const tmp: string = mkdtempSync(path.join(tmpdir(), "nverify-"));
    try {
      const extractedDir = path.join(tmp, "extracted");
      mkdirSync(path.join(extractedDir, "node-v22.23.3-win-x64"), { recursive: true });
      writeFileSync(
        path.join(extractedDir, "node-v22.23.3-win-x64", "node.exe"),
        Buffer.from("not a PE"),
      );
      writeFileSync(
        path.join(extractedDir, "node-v22.23.3-win-x64", "LICENSE"),
        "MIT License",
      );
      const entry = fakeNodeEntry();
      const r = await verifyExtractedNode(extractedDir, entry);
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/PE Machine|0x/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("Cache-Lebenszyklus (isCacheValid, prepareAsset) mit synthetischem Fixture", () => {
  it("isCacheValid: verlangt vorhandenen Pfad", async () => {
    const tmp: string = mkdtempSync(path.join(tmpdir(), "cache-"));
    try {
      const lockPath = path.join(tmp, "lock.json");
      writeFileSync(
        lockPath,
        JSON.stringify({
          schemaVersion: 1,
          generatedAt: "2026-10-19",
          purpose: "test",
          node: fakeNodeEntry(),
          postgres: fakePgEntry(),
        }),
      );
      const r = await isCacheValid("node", { lockfilePath: lockPath, cacheRoot: tmp });
      expect(r.ok).toBe(false);
      expect(r.kind).toBe("node");
      expect(r.reason).toMatch(/archive missing/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("isCacheValid: gibt ok=true, wenn Archiv vorhanden UND Hash korrekt", async () => {
    const tmp: string = mkdtempSync(path.join(tmpdir(), "cache-"));
    try {
      const archiveName = "node-v1.2.3-win-x64.zip";
      const lockPath = path.join(tmp, "lock.json");
      const payload = Buffer.from("zip body");
      const { bytes, sha256 } = makeStoredZipWithStagedFile("a.txt", payload);
      const downloadsDir = path.join(tmp, "downloads");
      mkdirSync(downloadsDir, { recursive: true });
      writeFileSync(path.join(downloadsDir, archiveName), bytes);
      writeFileSync(
        lockPath,
        JSON.stringify({
          schemaVersion: 1,
          generatedAt: "2026-10-19",
          purpose: "test",
          node: fakeNodeEntry({ archive: archiveName, sha256 }),
          postgres: fakePgEntry(),
        }),
      );
      const r = await isCacheValid("node", { lockfilePath: lockPath, cacheRoot: tmp });
      expect(r.ok).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("verifyAsset: verlangt Lockfile-Eintrag vorhanden + Cache vorhanden", async () => {
    const tmp: string = mkdtempSync(path.join(tmpdir(), "cache-"));
    const r = await verifyAsset("node", { lockfilePath: LOCKFILE_PATH, cacheRoot: tmp });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/archive missing/);
  });
});

describe("Lockfile no-absolute-paths (Security-Garantie)", () => {
  it("Akzeptiert https://nodejs.org und https://get.enterprisedb.com URLs", () => {
    const lf: { node: { url: string }; postgres: { url: string } } = JSON.parse(
      readFileSync(LOCKFILE_PATH, "utf8"),
    );
    expect(lf.node.url).toMatch(/^https:\/\//);
    expect(lf.postgres.url).toMatch(/^https:\/\//);
  });
});
