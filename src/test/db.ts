import { prisma } from "@/lib/prisma";

export { prisma };

/**
 * Leert alle Tabellen des public-Schemas (außer `_prisma_migrations`) für einen
 * deterministischen Testzustand. FK-sicher über CASCADE. Die App-Module nutzen
 * denselben `prisma`-Client (siehe `@/lib/prisma`), daher ist der Zustand für
 * api-write/api-data/mcp-approval identisch sichtbar.
 */
export async function resetDatabase(): Promise<void> {
  const tables = await prisma.$queryRawUnsafe<{ tablename: string }[]>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`,
  );
  if (tables.length === 0) return;
  const list = tables.map((t) => `"${t.tablename}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

export async function disconnect(): Promise<void> {
  await prisma.$disconnect();
}
