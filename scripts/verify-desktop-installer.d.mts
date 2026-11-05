// HAVEWA-07D G7-FIX — Type declarations for scripts/verify-desktop-installer.mjs.

import type { ScannedEngine } from "./prisma-engine-scan.mjs";

export interface PayloadEngineReport {
  readonly total: number;
  readonly linux: number;
  readonly arm64: number;
  readonly windowsOnly: boolean;
  readonly engines: readonly ScannedEngine[];
  readonly violations: readonly ScannedEngine[];
}

/**
 * G7-FIX: Prueft einen Payload-Baum (Stage bzw. installierter Payload)
 * auf native Prisma-Engines und bewertet Windows-x64-only.
 */
export declare function verifyPayloadPrismaEngines(
  root: string,
): Promise<PayloadEngineReport>;
