// HAVEWA-02F (Finding A): explizite, idempotente Migration von Legacy-Plaintext-
// Secrets (Tenant.aiApiKey, .smtpPassword, .imapPassword) in die AES-256-GCM-
// verschlüsselte Form. Server-only, bewusst als einmalig vom Betreiber auszuführenes
// CLI-Skript — KEINE automatische Mutation der Tenant-Tabelle beim App-Start.
//
// Aufruf:
//   npm run db:migrate-secrets            # echte Migration
//   npm run db:migrate-secrets -- --dry-run  # nur Anzeige, keine Schreibzugriffe
//
// Sicherheit:
// - setzt AUTH_SECRET (ENCRYPTION_KEY) voraus, sonst Abbruch (fail closed)
// - tenant-/feldweise, idempotent (mehrfach ausführbar)
// - bereits verschlüsselte Werte werden validiert und übersprungen
// - korrupte/fremde v1:-Werte → fail closed, Feld bleibt unverändert
// - keine Secret-/Ciphertext-Ausgabe (nur Zähler + Status)
// - kein Kopieren von ENV-Secrets in die DB

import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";
import { migrateSecretValue, emptyStats } from "@/lib/secret-migration";

loadEnvConfig(process.cwd());

const DRY_RUN = process.argv.includes("--dry-run");

// Die drei Mandanten-Secrets, die verschlüsselt werden können.
const SECRET_FIELDS = [
  { field: "aiApiKey", label: "aiApiKey" },
  { field: "smtpPassword", label: "smtpPassword" },
  { field: "imapPassword", label: "imapPassword" },
] as const;

async function main() {
  const authSecret = process.env.AUTH_SECRET?.trim();
  if (!authSecret) {
    console.error("[secret-migration] ABBRUCH: AUTH_SECRET (ENCRYPTION_KEY) fehlt. " +
      "Migration nicht ausgeführt, um Secrets nicht mit einem abweichenden Schlüssel zu verschlüsseln.");
    process.exit(2);
  }

  const prisma = new PrismaClient();
  const stats = emptyStats();

  try {
    const tenants = await prisma.tenant.findMany({
      select: { id: true, aiApiKey: true, smtpPassword: true, imapPassword: true },
    });

    for (const tenant of tenants) {
      const updates: { aiApiKey?: string; smtpPassword?: string; imapPassword?: string } = {};

      for (const { field, label } of SECRET_FIELDS) {
        stats.scanned++;
        const res = migrateSecretValue(tenant[field]);

        switch (res.status) {
          case "empty":
            // kein Secret hinterlegt — nichts zu tun
            break;
          case "alreadyEncrypted":
            stats.alreadyEncrypted++;
            break;
          case "migrated":
            stats.migrated++;
            updates[field] = res.value;
            break;
          case "failed":
            stats.failed++;
            // fail closed: Feld bleibt unverändert; kein Wert wird ausgegeben.
            console.warn(
              `[secret-migration] FEHLER tenant=${tenant.id} feld=${label} — ` +
              "verschlüsselter Wert nicht lesbar (falscher Schlüssel oder beschädigt), Feld unverändert.",
            );
            break;
        }
      }

      if (Object.keys(updates).length > 0) {
        if (DRY_RUN) {
          console.log(
            `[secret-migration] (dry-run) tenant=${tenant.id} würde verschlüsseln: ` +
            `${Object.keys(updates).join(", ")}`,
          );
        } else {
          // Einzelnes atomares Update pro Mandant (transaktional auf Zeilenebene).
          await prisma.tenant.update({ where: { id: tenant.id }, data: updates });
        }
      }
    }

    console.log(
      `[secret-migration] ${DRY_RUN ? "(dry-run) " : ""}abgeschlossen: ` +
      `scanned=${stats.scanned} alreadyEncrypted=${stats.alreadyEncrypted} ` +
      `migrated=${stats.migrated} failed=${stats.failed}`,
    );

    if (stats.failed > 0) {
      console.error(
        "[secret-migration] ABBRUCH mit Fehlern: mindestens ein verschlüsselter Wert " +
        "war nicht lesbar. Prüfen Sie AUTH_SECRET und die betroffenen Felder manuell.",
      );
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

main().catch((e) => {
  console.error("[secret-migration] unerwarteter Fehler:", e instanceof Error ? e.message : e);
  process.exit(1);
});
