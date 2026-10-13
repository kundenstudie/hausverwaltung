import { encryptSecret, decryptSecret, isEncryptedSecret } from "@/lib/crypto";

// Kontrollierte Überführung von Legacy-Plaintext-Secrets in die verschlüsselte
// Form (HAVEWA-02F, Finding A). Rein server-seitig, ohne DB-Zugriff (unit-testbar).
// Die eigentliche DB-Schleife liegt im CLI-Skript scripts/migrate-legacy-secrets.ts.
//
// Grundsätze:
// - tenant-/feldweise, explizit und idempotent
// - bereits verschlüsselte Werte (v1:…) werden validiert und übersprungen
// - echte Legacy-Plaintext-Werte werden verschlüsselt (keine Doppelverschlüsselung)
// - korrupte/ mit fremdem Schlüssel erzeugte v1:-Werte → fail closed (unverändert)
// - keine Secret-/Ciphertext-Ausgabe (nur Status)

export type SecretMigrationResult =
  | { status: "empty"; value: string | null }
  | { status: "alreadyEncrypted"; value: string }
  | { status: "migrated"; value: string }
  | { status: "failed"; value: string };

/**
 * Entscheidet pro Feld, ob/wie ein Secret migriert werden muss.
 *
 * - `empty`           : null/undefined/"" → unverändert lassen (kein Secret).
 * - `alreadyEncrypted`: gültiges v1:… → überspringen (idempotent, keine
 *                       Doppelverschlüsselung).
 * - `failed`          : v1:…, aber nicht entschlüsselbar (falscher Schlüssel oder
 *                       korrupte Daten) → fail closed, Wert bleibt unverändert.
 * - `migrated`        : echter Legacy-Plaintext → verschlüsselt zurückgeben.
 */
export function migrateSecretValue(value: string | null | undefined): SecretMigrationResult {
  if (value == null || value === "") return { status: "empty", value: value ?? null };

  if (isEncryptedSecret(value)) {
    try {
      decryptSecret(value);
      return { status: "alreadyEncrypted", value };
    } catch {
      return { status: "failed", value };
    }
  }

  return { status: "migrated", value: encryptSecret(value) };
}

/** Aggregierte Zähler für den Migrationslauf (nur Counts, nie Werte). */
export interface SecretMigrationStats {
  scanned: number;
  alreadyEncrypted: number;
  migrated: number;
  failed: number;
}

export function emptyStats(): SecretMigrationStats {
  return { scanned: 0, alreadyEncrypted: 0, migrated: 0, failed: 0 };
}
