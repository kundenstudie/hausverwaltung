// HAVEWA-07B — Unit-Tests für postgres-state.mjs.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  buildPostgresRecord, writePostgresState, readPostgresState, removePostgresState,
  generateRuntimeId, __STATE_FILE, __SCHEMA_VERSION,
} from "./postgres-state.mjs";

describe("postgres-state", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pg-state-"));
  });
  afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

  it("generateRuntimeId liefert eindeutige UUIDs", () => {
    const a = generateRuntimeId();
    const b = generateRuntimeId();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(20);
  });

  it("buildPostgresRecord setzt Pflichtfelder", () => {
    const r = buildPostgresRecord({
      pid: 12345, pgdata: "C:\\pg\\data", host: "127.0.0.1", port: 5433,
    });
    expect(r.pid).toBe(12345);
    expect(r.host).toBe("127.0.0.1");
    expect(r.port).toBe(5433);
    expect(r.loopbackHost).toBe("127.0.0.1");
    expect(r.runtimeId.length).toBeGreaterThan(20);
    expect(r.startedAt.length).toBeGreaterThan(10);
  });

  it("write+read round-trip", async () => {
    const record = buildPostgresRecord({
      pid: 999, pgdata: "C:\\pg\\data", host: "127.0.0.1", port: 5433,
    });
    await writePostgresState(tmp, { schemaVersion: __SCHEMA_VERSION, record });
    const back = readPostgresState(tmp);
    expect(back).not.toBeNull();
    expect(back!.schemaVersion).toBe(__SCHEMA_VERSION);
    expect(back!.record.pid).toBe(999);
  });

  it("read bei fehlendem file → null", () => {
    expect(readPostgresState(tmp)).toBeNull();
  });

  it("read bei kaputtem JSON → null", async () => {
    await fs.writeFile(path.join(tmp, __STATE_FILE), "nope", "utf8");
    expect(readPostgresState(tmp)).toBeNull();
  });

  it("removePostgresState ist idempotent", async () => {
    await removePostgresState(tmp);
    await removePostgresState(tmp);
    // Kein Fehler.
  });

  it("removePostgresState entfernt existierende Datei", async () => {
    await writePostgresState(tmp, {
      schemaVersion: 1,
      record: buildPostgresRecord({ pid: 1, pgdata: "x", host: "127.0.0.1", port: 5433 }),
    });
    expect(readPostgresState(tmp)).not.toBeNull();
    await removePostgresState(tmp);
    expect(readPostgresState(tmp)).toBeNull();
  });
});