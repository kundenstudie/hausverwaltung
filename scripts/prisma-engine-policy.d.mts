// HAVEWA-07D G7-FIX — Type declarations for scripts/prisma-engine-policy.mjs.

export const TARGET_OS: "windows";
export const TARGET_ARCH: "x64";

export const PRISMA_ENGINE_FAMILIES: readonly string[];

export const PRISMA_FORBIDDEN_NAME_PATTERNS: readonly string[];

export interface EngineTarget {
  readonly os: string;
  readonly arch: string;
  readonly family: string;
  readonly matched: boolean;
}

export interface EngineClassification {
  readonly isEngine: boolean;
  readonly family: string | null;
  readonly target: EngineTarget;
  readonly allowed: boolean;
  readonly reason: string | null;
}

export declare function detectBinaryFormat(
  head: Uint8Array | Buffer | null,
): "elf" | "pe" | "macho" | "wasm" | null;

export declare function engineFamily(fileName: string): string | null;

export declare function engineTarget(fileName: string): EngineTarget;

export declare function engineTokens(fileName: string): readonly string[];

export declare function classifyPrismaEngine(
  fileName: string,
  head?: Uint8Array | Buffer | null,
): EngineClassification;

export declare function isNativePrismaEngineFile(fileName: string): boolean;

export declare function isNonEngineWasmOrJs(fileName: string): boolean;

export declare function looksLikeNativeEngineFile(fileName: string): boolean;
