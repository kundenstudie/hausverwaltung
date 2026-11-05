// HAVEWA-07D G1 — Type declarations for scripts/runtime-assets.mjs.
// Pure ESM (.mjs) runtime; .mts is type-only and erased.
// No `any`, no `unknown`-casts at the public API surface.

export interface RuntimeAssetEntry {
  readonly version: string;
  readonly platform: "win32";
  readonly arch: "x64";
  readonly archive: string;
  readonly url: string;
  readonly sha256: string;
  readonly sha256Source: string;
  readonly hashProvenance: "vendor" | "tofu";
  readonly requiredTools: readonly string[];
  readonly requiredLicense?: string;
  readonly requiredLicenses?: readonly string[];
  readonly tofuNote?: string;
}

export interface RuntimeAssetsLockfile {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly purpose: string;
  readonly node: RuntimeAssetEntry;
  readonly postgres: RuntimeAssetEntry;
}

export type AssetKind = "node" | "postgres";

export interface VerifyResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface PrepareResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly cacheReused: boolean;
  readonly extractedDir?: string;
}

export interface VerifyCacheResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly kind: AssetKind;
}

export interface DownloadResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly filePath?: string;
  readonly bytes?: number;
  finalUrl?: string;
  redirects?: readonly string[];
}

export interface ExtractResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly extractedDir?: string;
}

export interface ResolvedPaths {
  readonly cacheRoot: string;
  readonly downloadsDir: string;
  readonly extractedDir: string;
  readonly assetDownloadsFile: string;
}

export interface RuntimeAssetsOptions {
  readonly lockfilePath?: string;
  readonly cacheRoot?: string;
  readonly logger?: Logger;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
  readonly allowedHosts?: readonly string[];
  readonly now?: () => Date;
}

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export declare function loadLockfile(lockfilePath: string): RuntimeAssetsLockfile;

export declare function resolveAssetPaths(
  kind: AssetKind,
  opts: RuntimeAssetsOptions,
): ResolvedPaths;

export declare function downloadAsset(
  entry: RuntimeAssetEntry,
  opts: RuntimeAssetsOptions,
  outFilePath: string,
): Promise<DownloadResult>;

export declare function verifyArchiveHash(
  archivePath: string,
  expectedSha256: string,
): Promise<VerifyResult>;

export declare function verifyPeMachine(
  archivePath: string,
  memberPathWithinZip: string,
  expectedArch: "x64",
): Promise<VerifyResult>;

export declare function extractZipSafely(
  archivePath: string,
  outDir: string,
  opts?: { readonly logger?: Logger },
): Promise<ExtractResult>;

export declare function verifyExtractedNode(
  extractedDir: string,
  expected: RuntimeAssetEntry,
): Promise<VerifyResult>;

export declare function verifyExtractedPostgres(
  extractedDir: string,
  expected: RuntimeAssetEntry,
): Promise<VerifyResult>;

export declare function isCacheValid(
  kind: AssetKind,
  opts: RuntimeAssetsOptions,
): Promise<VerifyCacheResult>;

export declare function prepareAsset(
  kind: AssetKind,
  opts: RuntimeAssetsOptions,
): Promise<PrepareResult>;

export declare function verifyAsset(
  kind: AssetKind,
  opts: RuntimeAssetsOptions,
): Promise<VerifyResult>;

export declare function cli(argv: readonly string[]): Promise<number>;
