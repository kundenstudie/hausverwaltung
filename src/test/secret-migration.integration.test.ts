import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma, disconnect } from "./db";
import { resetAndSeed, type Fixtures } from "./fixtures";
import { migrateSecretValue } from "@/lib/secret-migration";
import { decryptSecretValue, isEncryptedSecret } from "@/lib/crypto";

// VERBINDLICHER Secret-Migration-DB-Test (HAVEWA-03, Abschnitt 8).
// Testet die Legacy-Plaintext-Migration gegen die echte Test-DB. Die Schleife
// spiegelt scripts/migrate-legacy-secrets.ts (gleiche migrateSecretValue-Logik).

const FIELDS = ["aiApiKey", "smtpPassword", "imapPassword"] as const;

async function migrateTenant(tenantId: string): Promise<Record<string, string>> {
  const t = await prisma.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { aiApiKey: true, smtpPassword: true, imapPassword: true },
  });
  const updates: Record<string, string> = {};
  for (const field of FIELDS) {
    const res = migrateSecretValue(t[field]);
    if (res.status === "migrated") updates[field] = res.value;
  }
  if (Object.keys(updates).length > 0) {
    await prisma.tenant.update({ where: { id: tenantId }, data: updates });
  }
  return updates;
}

describe("Secret-Migration (DB, HAVEWA-03)", () => {
  let fx: Fixtures;

  beforeAll(async () => {
    fx = await resetAndSeed();
  });

  afterAll(async () => {
    await disconnect();
  });

  it("v1: verschlüsselt, kein Plaintext mehr, decrypt-Roundtrip", async () => {
    const updates = await migrateTenant(fx.tenantA.id);
    expect(Object.keys(updates).sort()).toEqual([...FIELDS].sort());

    const t = await prisma.tenant.findUniqueOrThrow({ where: { id: fx.tenantA.id } });
    const expected: Record<(typeof FIELDS)[number], string> = {
      aiApiKey: "sk-ant-legacy-alpha",
      smtpPassword: "smtp-geheim-alpha",
      imapPassword: "imap-geheim-alpha",
    };
    for (const field of FIELDS) {
      const v = t[field];
      expect(isEncryptedSecret(v), `${field} verschlüsselt`).toBe(true);
      expect(v, `${field} enthält keinen Klartext`).not.toContain(expected[field]);
      expect(decryptSecretValue(v), `${field} roundtrip`).toBe(expected[field]);
    }
  });

  it("zweiter Lauf ist no-op (idempotent)", async () => {
    const updates = await migrateTenant(fx.tenantA.id);
    expect(updates).toEqual({});
  });

  it("fremde Felder bleiben unverändert", async () => {
    const t = await prisma.tenant.findUniqueOrThrow({ where: { id: fx.tenantA.id } });
    expect(t.aiProvider).toBe("anthropic");
    expect(t.smtpUser).toBe("mail@alpha.test");
    expect(t.smtpFrom).toBe("mail@alpha.test");
    expect(t.imapUser).toBe("mail@alpha.test");
    expect(t.imapHost).toBe("imap.alpha.test");
  });

  it("malformed ciphertext schlägt fail closed fehl (Feld unverändert)", async () => {
    const broken = "v1:" + Buffer.from("00".repeat(40), "hex").toString("base64");
    await prisma.tenant.update({ where: { id: fx.tenantB.id }, data: { aiApiKey: broken } });

    const res = migrateSecretValue(broken);
    expect(res.status).toBe("failed");
    expect(res.value).toBe(broken);

    const t = await prisma.tenant.findUniqueOrThrow({ where: { id: fx.tenantB.id } });
    expect(t.aiApiKey).toBe(broken); // kein Overwrite, keine Doppelverschlüsselung
  });
});
