// HAVEWA-07D G7-FIX — Type declarations for scripts/prisma-engine-scan.mjs.

import type {
  EngineClassification,
  EngineTarget,
} from "./prisma-engine-policy.mjs";

export interface ScannedEngine {
  readonly file: string;
  readonly name: string;
  readonly family: string | null;
  readonly target: EngineTarget;
  readonly allowed: boolean;
  readonly reason: string | null;
  readonly format: "elf" | "pe" | "macho" | "wasm" | null;
  readonly magicKnown: boolean;
  readonly size: number | null;
  readonly verdict: "allowed" | "forbidden" | "unverified";
}

export interface EngineScanResult {
  readonly engines: readonly ScannedEngine[];
  readonly violations: readonly ScannedEngine[];
}

export interface DroppedEngine {
  readonly file: string;
  readonly family: string | null;
  readonly target: string;
  readonly format: "elf" | "pe" | "macho" | "wasm" | null;
  readonly size: number | null;
}

export interface FilterResult {
  readonly keep: readonly string[];
  readonly drop: readonly string[];
  readonly droppedDetails: readonly DroppedEngine[];
}

export declare function walkFiles(root: string): AsyncGenerator<string>;

export declare function scanPrismaEngines(
  root: string,
  opts?: { readonly includeFormat?: boolean },
): Promise<EngineScanResult>;

export declare function findPrismaEngineViolations(
  root: string,
): Promise<readonly ScannedEngine[]>;

export declare function filterWindowsX64Only(
  root: string,
  relativeNames: readonly string[],
): Promise<FilterResult>;

export declare function formatEngineInventory(
  engines: readonly ScannedEngine[],
): string;

export {
  classifyPrismaEngine,
  detectBinaryFormat,
  engineFamily,
  engineTarget,
  isNativePrismaEngineFile,
} from "./prisma-engine-policy.mjs";

export type { EngineClassification, EngineTarget };
