// HAVEWA-07A-2 — Tests fuer /api/ready.
//
// Strategie: wir mocken @/lib/prisma so, dass $queryRaw entweder resolved
// oder rejected. Damit testen wir beide Pfade, ohne eine echte DB zu
// brauchen, und ohne dass die vorbestehende Windows-Prisma-DLL-Limitation
// diese Tests beruehrt.

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

const queryRaw = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: { $queryRaw: (...a: unknown[]) => queryRaw(...a) },
}));

// Modul erst NACH dem mock laden.
import { GET } from "@/app/api/ready/route";

describe("GET /api/ready", () => {
  beforeEach(() => {
    queryRaw.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("DB ok: 200, status=ready", async () => {
    queryRaw.mockResolvedValueOnce([{ "?column?": 1 }]);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ready" });
  });

  it("DB nicht erreichbar: 503, status=not_ready", async () => {
    queryRaw.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ status: "not_ready" });
  });

  it("DB-Fehler enthaelt KEINE DB-Details (kein DSN-Leak)", async () => {
    queryRaw.mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:5432 havewa@havewa"));
    const res = await GET();
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).not.toMatch(/127\.0\.0\.1/);
    expect(text).not.toMatch(/havewa@/);
    expect(text).not.toMatch(/5432/);
  });

  it("sendet Cache-Control: no-store", async () => {
    queryRaw.mockResolvedValueOnce([{ "?column?": 1 }]);
    const res = await GET();
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
