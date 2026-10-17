// HAVEWA-07A-2 — Tests fuer /api/shutdown.
//
// Wir testen das Verhalten des Endpunkts in Isolation:
//   - GET -> 404 (nur POST)
//   - POST ohne SHUTDOWN_TOKEN -> 404
//   - POST mit Token, aber Remote-Host -> 403
//   - POST mit Token, aber falsches Token -> 401
//   - POST mit Token, valides Token auf Loopback -> 202 + process.exit-Aufruf
//
// process.exit wird via vi.spyOn(process, "exit") als No-Op gemockt, damit
// das setTimeout(..., 100).unref() im Erfolgsfall den Test-Worker NICHT
// beendet (Review-Fix L1, 07A-2).
// `controlledShutdown` wird gemockt, damit kein Prisma-Connect noetig ist.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const controlledShutdown = vi.fn(async () => ({ stopped: ["bankTimer", "inboundTimer"] }));

vi.mock("@/lib/server-lifecycle", () => ({
  controlledShutdown: (...a: unknown[]) => (controlledShutdown as (...b: unknown[]) => unknown)(...a),
}));

import { POST, GET } from "@/app/api/shutdown/route";

function makeReq(opts: { host?: string; token?: string; method?: string } = {}): Request {
  const headers = new Headers();
  if (opts.host !== undefined) headers.set("host", opts.host);
  if (opts.token !== undefined) headers.set("x-shutdown-token", opts.token);
  return new Request("http://localhost/api/shutdown", {
    method: opts.method ?? "POST",
    headers,
  });
}

describe("POST /api/shutdown", () => {
  const ORIGINAL_TOKEN = process.env.SHUTDOWN_TOKEN;
  const ORIGINAL_ALLOW = process.env.HAVEWA_ALLOW_REMOTE_SHUTDOWN;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // L1: process.exit als No-Op mocken, damit der setTimeout(..., 100).unref()
    // im Success-Pfad den Vitest-Worker NICHT beendet.
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => { /* no-op */ }) as never);
    controlledShutdown.mockClear();
    process.env.SHUTDOWN_TOKEN = "test-token-xyz";
  });
  afterEach(() => {
    exitSpy.mockRestore();
    if (ORIGINAL_TOKEN === undefined) delete process.env.SHUTDOWN_TOKEN;
    else process.env.SHUTDOWN_TOKEN = ORIGINAL_TOKEN;
    if (ORIGINAL_ALLOW === undefined) delete process.env.HAVEWA_ALLOW_REMOTE_SHUTDOWN;
    else process.env.HAVEWA_ALLOW_REMOTE_SHUTDOWN = ORIGINAL_ALLOW;
  });

  it("GET -> 404 (POST-only)", async () => {
    const res = await GET();
    expect(res.status).toBe(404);
  });

  it("POST ohne SHUTDOWN_TOKEN: Endpunkt deaktiviert -> 404", async () => {
    delete process.env.SHUTDOWN_TOKEN;
    const res = await POST(makeReq({ host: "127.0.0.1:3000" }));
    expect(res.status).toBe(404);
  });

  it("POST mit Remote-Host (nicht loopback) -> 403", async () => {
    const res = await POST(makeReq({ host: "example.com:443", token: "test-token-xyz" }));
    expect(res.status).toBe(403);
    expect(controlledShutdown).not.toHaveBeenCalled();
  });

  it("POST mit HAVEWA_ALLOW_REMOTE_SHUTDOWN=1 erlaubt Remote + aber falsches Token -> 401", async () => {
    process.env.HAVEWA_ALLOW_REMOTE_SHUTDOWN = "1";
    const res = await POST(makeReq({ host: "example.com:443", token: "WRONG" }));
    expect(res.status).toBe(401);
  });

  it("POST mit fehlendem Token -> 401", async () => {
    const res = await POST(makeReq({ host: "127.0.0.1:3000" }));
    expect(res.status).toBe(401);
  });

  it("POST mit falschem Token -> 401", async () => {
    const res = await POST(makeReq({ host: "127.0.0.1:3000", token: "WRONG" }));
    expect(res.status).toBe(401);
    expect(controlledShutdown).not.toHaveBeenCalled();
  });

  it("POST mit leerem Token -> 401", async () => {
    const res = await POST(makeReq({ host: "127.0.0.1:3000", token: "" }));
    expect(res.status).toBe(401);
  });

  it("POST mit korrektem Token + Loopback -> 202, controlledShutdown wird aufgerufen", async () => {
    const res = await POST(makeReq({ host: "127.0.0.1:3000", token: "test-token-xyz" }));
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toEqual({ status: "shutting_down" });
    // controlledShutdown wurde aufgerufen (Scheduler-Stop + Prisma-Disconnect)
    expect(controlledShutdown).toHaveBeenCalledTimes(1);
  });

  it("POST mit korrektem Token + localhost Host -> 202", async () => {
    const res = await POST(makeReq({ host: "localhost:3000", token: "test-token-xyz" }));
    expect(res.status).toBe(202);
  });

  it("POST Antwort enthaelt KEINE sensitiven Daten", async () => {
    const res = await POST(makeReq({ host: "127.0.0.1:3000", token: "test-token-xyz" }));
    const text = await res.text();
    expect(text).not.toMatch(/test-token-xyz/);
    expect(text).not.toMatch(/SHUTDOWN_TOKEN/);
  });
});
