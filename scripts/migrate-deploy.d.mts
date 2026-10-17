// Type-Declaration fuer scripts/migrate-deploy.mjs
// Wird gebraucht, weil TypeScript Object-Literal-Properties gegen die
// `=`-Default-Parameter der exportierten Funktion prueft und sonst
// zusaetzliche Felder (dbUrl, treeDir, schemaPath, logger) ablehnt.
export interface MigrateDeployOptions {
  dbUrl: string;
  treeDir: string;
  schemaPath: string;
  timeoutMs?: number;
  runner?: (treeDir: string, args: string[], opts: Record<string, unknown>) => Promise<unknown>;
  logger?: { log: (s: string) => void; err: (s: string) => void };
}
export function runMigrateDeploy(opts: MigrateDeployOptions): Promise<void>;

/**
 * Sicherer DB-Target-Label: nur host:port, KEIN Username, KEIN Passwort,
 * KEIN DSN. Review-Fix M1 (07A-2).
 */
export function dbTargetLabel(dbUrl: string | undefined): string;
