// HAVEWA-07A-2 — Tests fuer /api/health (keine DB).
import { describe, it, expect } from "vitest";
import { GET } from "@/app/api/health/route";

describe("GET /api/health", () => {
  it("antwortet 200 mit status=ok", async () => {
    const res = GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ok" });
  });

  it("sendet Cache-Control: no-store", () => {
    const res = GET();
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("kein DB-Zugriff: auch wenn DATABASE_URL kaputt ist, antwortet health 200", () => {
    const before = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://invalid:invalid@127.0.0.1:1/nowhere?schema=public";
    try {
      const res = GET();
      expect(res.status).toBe(200);
    } finally {
      if (before === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = before;
    }
  });
});
