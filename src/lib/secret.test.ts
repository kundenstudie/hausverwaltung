import { describe, it, expect, beforeAll } from "vitest";
import {
  encryptSecret,
  decryptSecretValue,
  isEncryptedSecret,
  SecretDecryptionError,
} from "./crypto";

beforeAll(() => {
  process.env.AUTH_SECRET = "test-secret-for-crypto";
});

describe("decryptSecretValue (at-rest Lese-Boundary, HAVEWA-02)", () => {
  it("leer/null → undefined (ENV-Fallback bleibt möglich)", () => {
    expect(decryptSecretValue(undefined)).toBeUndefined();
    expect(decryptSecretValue(null)).toBeUndefined();
    expect(decryptSecretValue("")).toBeUndefined();
  });

  it("Roundtrip verschlüsselt → Klartext", () => {
    const enc = encryptSecret("sk-ant-geheim");
    expect(isEncryptedSecret(enc)).toBe(true);
    expect(decryptSecretValue(enc)).toBe("sk-ant-geheim");
  });

  it("Legacy-Plaintext wird für die Übergangszeit unverändert durchgereicht", () => {
    expect(decryptSecretValue("legacy-plain")).toBe("legacy-plain");
    expect(isEncryptedSecret("legacy-plain")).toBe(false);
  });

  it("malformed ciphertext schlägt fail-closed fehl", () => {
    const broken = "v1:" + Buffer.from("00".repeat(40), "hex").toString("base64");
    expect(() => decryptSecretValue(broken)).toThrow(SecretDecryptionError);
  });

  it("falscher Schlüssel schlägt fail-closed fehl", () => {
    const enc = encryptSecret("geheim");
    process.env.AUTH_SECRET = "anderer-schluessel";
    try {
      expect(() => decryptSecretValue(enc)).toThrow(SecretDecryptionError);
    } finally {
      process.env.AUTH_SECRET = "test-secret-for-crypto";
    }
  });

  it("keine Doppelverschlüsselung: einmal entschlüsselt → Klartext", () => {
    const enc = encryptSecret("geheim");
    expect(isEncryptedSecret(enc)).toBe(true);
    expect(decryptSecretValue(enc)).toBe("geheim");
    expect(isEncryptedSecret(decryptSecretValue(enc)!)).toBe(false);
  });

  it("Fehlermeldung leakt weder Secret noch Ciphertext", () => {
    const enc = encryptSecret("top-secret-value");
    process.env.AUTH_SECRET = "anderer-schluessel";
    try {
      decryptSecretValue(enc);
      throw new Error("sollte werfen");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      expect(msg).not.toContain("top-secret-value");
      expect(msg).not.toContain(enc.slice(3, 24));
    } finally {
      process.env.AUTH_SECRET = "test-secret-for-crypto";
    }
  });

  it("dedizierter Auth-Tag-Tampering-Test: manipuliertes Tag wirft SecretDecryptionError", () => {
    const enc = encryptSecret("geheim");
    // Layout: v1: + base64(iv[12] | tag[16] | ciphertext)
    const raw = Buffer.from(enc.slice(3), "base64");
    // Auth-Tag (Bytes 12..27) gezielt verändern.
    const tamperedTag = Buffer.from(raw);
    tamperedTag[20] ^= 0xff;
    const brokenTag = "v1:" + tamperedTag.toString("base64");
    expect(() => decryptSecretValue(brokenTag)).toThrow(SecretDecryptionError);
  });

  it("dedizierter Ciphertext-Tampering-Test: manipulierter Ciphertext wirft SecretDecryptionError", () => {
    const enc = encryptSecret("geheim");
    const raw = Buffer.from(enc.slice(3), "base64");
    // Ciphertext (Bytes 28..) gezielt verändern.
    const tamperedCt = Buffer.from(raw);
    const last = tamperedCt.length - 1;
    tamperedCt[last] ^= 0xff;
    const brokenCt = "v1:" + tamperedCt.toString("base64");
    expect(() => decryptSecretValue(brokenCt)).toThrow(SecretDecryptionError);
  });
});
