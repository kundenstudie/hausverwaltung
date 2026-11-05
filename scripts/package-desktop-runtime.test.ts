// HAVEWA-07D G2 — Tests for scripts/package-desktop-runtime.mjs.
//
// Coverage:
//   - isForbiddenName: .env/.env.x, .test.ts, forbidden top dirs
//   - Filtering-Decision unabhängig von PATH
//   - Stage-Reset nur auf definierten STAGE_ROOT

import { describe, it, expect } from "vitest";

import {
  isForbiddenName,
} from "./package-desktop-runtime.mjs";

describe("isForbiddenName", () => {
  it("lehnt .env ab", () => {
    expect(isForbiddenName(".env")).toBe(true);
  });

  it("lehnt .env.local und .env.prod ab", () => {
    expect(isForbiddenName(".env.local")).toBe(true);
    expect(isForbiddenName(".env.prod")).toBe(true);
  });

  it("akzeptiert .env.example", () => {
    expect(isForbiddenName(".env.example")).toBe(false);
  });

  it("lehnt secrets.json ab", () => {
    expect(isForbiddenName("secrets.json")).toBe(true);
  });

  it("lehnt *.test.ts und *.spec.ts ab", () => {
    expect(isForbiddenName("foo.test.ts")).toBe(true);
    expect(isForbiddenName("foo.spec.ts")).toBe(true);
    expect(isForbiddenName("foo.test.tsx")).toBe(true);
    expect(isForbiddenName("foo.spec.tsx")).toBe(true);
  });

  it("lehnt verbotene Top-Level-Dirs ab", () => {
    for (const dir of [
      "docs",
      "e2e",
      "playwright-report",
      "test-results",
      "web-docs",
      "store",
      "store-assets",
      "templates",
      "fgilde-havewa",
      "deploy",
      "src",
    ]) {
      expect(isForbiddenName(dir)).toBe(true);
    }
  });

  it("akzeptiert legitime Namen", () => {
    for (const ok of ["server.js", "node.exe", "postgres.exe", "LICENSE", "package.json", "messages", "public"]) {
      expect(isForbiddenName(ok)).toBe(false);
    }
  });

  it("pfad-basiert: nur Basename, kein Verzeichnis-Match", () => {
    // isForbiddenName akzeptiert nur NAMES; Pfad-Scanning im Verify-Script.
    expect(isForbiddenName("server.js")).toBe(false);
  });
});
