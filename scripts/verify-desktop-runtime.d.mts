// HAVEWA-07D G2 — Type declarations for scripts/verify-desktop-runtime.mjs.

export interface ForbiddenHit {
  readonly file: string;
  readonly reason: string;
}

export interface DevPathHit {
  readonly file: string;
  readonly marker: string;
}

export interface NodeResult {
  readonly errors: readonly string[];
  readonly machine?: number;
  readonly exe?: string;
}

export interface VerifyResults {
  readonly hasErrors: boolean;
  readonly node: NodeResult;
  readonly postgres: { readonly errors: readonly string[] };
  readonly app: { readonly errors: readonly string[] };
  readonly forbidden: readonly ForbiddenHit[];
  readonly devPaths: readonly DevPathHit[];
  readonly prismaEngines: { readonly errors: readonly string[] };
  readonly turbopackAliases: AliasVerifyResult;
  readonly fakeProductionPath: { readonly errors: readonly string[] };
}

export declare function isForbiddenFile(p: string): Promise<string | null>;

export declare function scanForbidden(stageRoot: string): Promise<readonly ForbiddenHit[]>;

export declare function checkAbsenceOfDevPaths(stageRoot: string): Promise<readonly DevPathHit[]>;

export declare function verifyAll(stageRoot: string): Promise<VerifyResults>;

export interface AliasVerifyResult {
  readonly errors: readonly string[];
  readonly aliases: readonly string[];
}

export declare function verifyTurbopackAliases(
  stageRoot: string,
): Promise<AliasVerifyResult>;

export declare function verifyNoFakeProductionPath(
  stageRoot: string,
): Promise<{ readonly errors: readonly string[] }>;

export declare function cli(argv: readonly string[]): Promise<number>;
