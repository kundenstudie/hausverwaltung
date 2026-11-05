// HAVEWA-07D G2 — Type declarations for scripts/package-desktop-runtime.mjs.

export const FORBIDDEN_RULES: {
  readonly fileExtensions: readonly string[];
  readonly topDirs: readonly string[];
  readonly names: readonly string[];
};

export function isForbiddenName(name: string): boolean;

export function nodeModulesPredicate(name: string): boolean;

export interface AliasMaterializationResult {
  readonly materialized: readonly string[];
  readonly skipped: readonly string[];
  readonly source: readonly string[];
}

export declare function materializeTurbopackAliases(
  appStage: string,
): Promise<AliasMaterializationResult>;

export interface SanitizeResult {
  readonly changed: boolean;
}

export declare function sanitizeServerJsBuildMetadata(
  serverJsPath: string,
): Promise<SanitizeResult>;

export declare function sanitizeRequiredServerFiles(
  nextDir: string,
): Promise<SanitizeResult>;

export declare function sanitizePrismaSourceMaps(
  dir: string,
): Promise<number>;

export interface PackageArgs {
  skipApp?: boolean;
  cacheRoot?: string;
}

export declare function parseArgs(argv: readonly string[]): PackageArgs;

export declare function validateCache(cacheRoot: string): Promise<unknown>;

export declare function resetStage(): Promise<void>;

export declare function stageNode(lockfile: unknown, cacheRoot: string): Promise<void>;

export declare function stagePostgres(lockfile: unknown, cacheRoot: string): Promise<void>;

export declare function stageApp(opts?: {
  readonly skipApp?: boolean;
}): Promise<void>;

export declare function cli(argv: readonly string[]): Promise<number>;
