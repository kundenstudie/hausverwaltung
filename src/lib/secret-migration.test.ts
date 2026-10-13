import { describe, it, expect, beforeAll } from "vitest";
import { migrateSecretValue } from "./secret-migration";
import { encryptSecret, decryptSecretValue, isEncryptedSecret } from "./crypto";

beforeAll(() => {
  process.env.AUTH_SECRET = "test-secret-for-crypto";
});

describe("migrateSecretValue (Legacy-Plaintext-Migration, HAVEWA-02F)", () => {
  it("plaintext aiApiKey wird verschlüsselt (migrated)", () => {
    const res = migrateSecretValue("sk-ant-legacy-ai");
    expect(res.status).toBe("migrated");
    expect(isEncryptedSecret(res.value)).toBe(true);
    expect(decryptSecretValue(res.value)).toBe("sk-ant-legacy-ai");
  });

  it("plaintext smtpPassword wird verschlüsselt (migrated)", () => {
    const res = migrateSecretValue("smtp-geheim");
    expect(res.status).toBe("migrated");
    expect(decryptSecretValue(res.value)).toBe("smtp-geheim");
  });

  it("plaintext imapPassword wird verschlüsselt (migrated)", () => {
    const res = migrateSecretValue("imap-geheim");
    expect(res.status).toBe("migrated");
    expect(decryptSecretValue(res.value)).toBe("imap-geheim");
  });

  it("bereits verschlüsselter Wert bleibt unverändert (alreadyEncrypted)", () => {
    const enc = encryptSecret("bereits-geheim");
    const res = migrateSecretValue(enc);
    expect(res.status).toBe("alreadyEncrypted");
    expect(res.value).toBe(enc); // exakt identisch, keine Neuverschlüsselung
  });

  it("null bleibt null (empty)", () => {
    const res = migrateSecretValue(null);
    expect(res.status).toBe("empty");
    expect(res.value).toBeNull();
  });

  it("undefined und leerer String werden korrekt behandelt (empty)", () => {
    expect(migrateSecretValue(undefined)).toEqual({ status: "empty", value: null });
    const empty = migrateSecretValue("");
    expect(empty.status).toBe("empty");
    expect(empty.value).toBe("");
  });

  it("idempotenter zweiter Lauf: migrierter Wert → alreadyEncrypted", () => {
    const first = migrateSecretValue("nochmal-geheim");
    expect(first.status).toBe("migrated");
    const second = migrateSecretValue(first.value);
    expect(second.status).toBe("alreadyEncrypted");
    expect(second.value).toBe(first.value);
  });

  it("falscher Schlüssel → verschlüsselter Wert fail closed (failed)", () => {
    const enc = encryptSecret("geheim");
    process.env.AUTH_SECRET = "anderer-schluessel";
    try {
      const res = migrateSecretValue(enc);
      expect(res.status).toBe("failed");
      expect(res.value).toBe(enc); // unverändert, kein Overwrite
    } finally {
      process.env.AUTH_SECRET = "test-secret-for-crypto";
    }
  });

  it("malformed v1:-Wert → fail closed (failed)", () => {
    const broken = "v1:" + Buffer.from("00".repeat(40), "hex").toString("base64");
    const res = migrateSecretValue(broken);
    expect(res.status).toBe("failed");
    expect(res.value).toBe(broken); // unverändert, kein Overwrite/keine Doppelverschlüsselung
  });

  it("keine Secret-Ausgabe: Ergebnis enthält nie den Klartext", () => {
    const res = migrateSecretValue("top-secret-value");
    expect(res.status).toBe("migrated");
    expect(res.value).not.toContain("top-secret-value");
    // Status ist ein reiner Marker, kein Wert.
    expect(["empty", "alreadyEncrypted", "migrated", "failed"]).toContain(res.status);
  });

  it("gemischter Fall: verschlüsselt und plaintext unabhängig voneinander", () => {
    const enc = encryptSecret("schon-enc");
    const plain = migrateSecretValue("noch-plain");
    const encRes = migrateSecretValue(enc);

    expect(encRes.status).toBe("alreadyEncrypted");
    expect(plain.status).toBe("migrated");
    expect(encRes.value).toBe(enc); // unberührt
    expect(decryptSecretValue(plain.value)).toBe("noch-plain");
  });

  it("migrateSecretValue ist seiteneffektfrei gegenüber dem Eingabewert", () => {
    const input = "legacy-plain";
    const before = input;
    migrateSecretValue(input);
    expect(input).toBe(before); // kein Mutieren des Eingabestrings
  });
});
