// HAVEWA-07D G7-FIX — Type declarations for scripts/prisma-runtime-tree.mjs.

export const ROOT: string;

export const STATIC_ENTRIES: readonly (readonly [string, string])[];

export declare function exists(p: string): Promise<boolean>;

export declare function copyDir(src: string, dst: string): Promise<void>;

/**
 * G7-FIX: Kopierer mit zentraler Prisma-Engine-Policy (Windows-x64-only).
 * Gibt die nicht kopierten (non-windows-x64) Dateien relativ zum
 * Quellbaum zurueck.
 */
export declare function copyDirPrismaWindowsX64(
  src: string,
  dst: string,
): Promise<string[]>;

export declare function resolveTransitiveDeps(
  roots: Iterable<string>,
): Promise<Set<string>>;

/**
 * Baut den Prisma-CLI-Runtime-Tree. Wirft, wenn danach noch eine
 * native non-windows-x64 Engine im Tree liegt (fail-closed).
 */
export declare function buildPrismaTree(targetDir: string): Promise<string[]>;

export declare function runPrismaCli(
  treeDir: string,
  args: readonly string[],
  opts?: {
    readonly env?: Record<string, string>;
    readonly timeoutMs?: number;
    readonly inheritStdout?: boolean;
    readonly inheritStderr?: boolean;
  },
): Promise<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}>;
