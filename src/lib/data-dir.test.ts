// HAVEWA-07A-2 — Tests fuer HAVEWA_DATA_DIR-Semantik.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import { dataDir, dataPath, storageDocumentsDir, runtimeStateDir } from "@/lib/data-dir";

describe("data-dir (HAVEWA-07A-2)", () => {
  const ORIGINAL = process.env.HAVEWA_DATA_DIR;
  const ORIGINAL_CWD = process.cwd();

  beforeEach(() => {
    delete process.env.HAVEWA_DATA_DIR;
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.HAVEWA_DATA_DIR;
    else process.env.HAVEWA_DATA_DIR = ORIGINAL;
    process.chdir(ORIGINAL_CWD);
  });

  it("dataDir: ohne HAVEWA_DATA_DIR -> process.cwd()", () => {
    expect(dataDir()).toBe(process.cwd());
  });

  it("dataDir: mit HAVEWA_DATA_DIR -> exakt dieser Pfad (kein Trailing-Slash-Transform)", () => {
    process.env.HAVEWA_DATA_DIR = "C:/some/explicit/path";
    expect(dataDir()).toBe("C:/some/explicit/path");
  });

  it("dataPath: setzt Subdir + Rest korrekt zusammen", () => {
    process.env.HAVEWA_DATA_DIR = "X:/havewa-data";
    expect(dataPath("storage", "documents")).toBe(path.join("X:/havewa-data", "storage", "documents"));
    expect(dataPath("runtime-state")).toBe(path.join("X:/havewa-data", "runtime-state"));
    expect(dataPath("logs")).toBe(path.join("X:/havewa-data", "logs"));
  });

  it("storageDocumentsDir: <dataDir>/storage/documents", () => {
    process.env.HAVEWA_DATA_DIR = "Y:/data";
    expect(storageDocumentsDir()).toBe(path.join("Y:/data", "storage", "documents"));
  });

  it("runtimeStateDir: <dataDir>/runtime-state", () => {
    process.env.HAVEWA_DATA_DIR = "Z:/data";
    expect(runtimeStateDir()).toBe(path.join("Z:/data", "runtime-state"));
  });

  it("Fallback ohne Env: storageDocumentsDir == <cwd>/storage/documents (Bestehendes Verhalten)", () => {
    expect(storageDocumentsDir()).toBe(path.join(process.cwd(), "storage", "documents"));
  });

  it("Whitespace-Env wird wie nicht-gesetzt behandelt (trim)", () => {
    process.env.HAVEWA_DATA_DIR = "   ";
    expect(dataDir()).toBe(process.cwd());
  });
});
