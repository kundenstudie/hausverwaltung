import type { NextConfig } from "next";
import { execSync } from "node:child_process";
import createNextIntlPlugin from "next-intl/plugin";
import pkg from "./package.json";

const withNextIntl = createNextIntlPlugin();

// Version fürs UI. semver aus package.json; Build-Nummer + SHA werden im CI per
// Build-Arg gesetzt (im Docker-Image ist .git nicht verfügbar). Lokal fallen wir
// auf git zurück (Commit-Anzahl als Build-Nummer, steigt mit jedem Commit).
function git(cmd: string): string {
  try {
    return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
}
const build = process.env.APP_BUILD || git("git rev-list --count HEAD") || "dev";
const sha = (process.env.APP_SHA || git("git rev-parse --short HEAD") || "").slice(0, 7);

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_APP_VERSION: pkg.version,
    NEXT_PUBLIC_APP_BUILD: build,
    NEXT_PUBLIC_APP_SHA: sha,
  },
  // Server-Actions-Body-Limit über das App-Upload-Limit (20 MB) heben; Default
  // ist 1 MB, daher schlug der Dokument-Upload >1 MB fehl (Issue #7).
  // Etwas Reserve für Multipart-Overhead.
  experimental: {
    serverActions: { bodySizeLimit: "25mb" },
  },
  // Standalone-Build nur per ENV aktivieren (HAVEWA-07A-1). Default-Verhalten
  // ohne ENV ist unveraendert (kein output-Key).
  ...(process.env.NEXT_OUTPUT_STANDALONE === "1"
    ? {
        output: "standalone" as const,
        // HAVEWA-07D G4: File-Tracing vom Repo-Root ausschliessen.
        //
        // OHNE diese Excludes zieht Next das komplette `src-tauri/`
        // (inkl. ~8 GB `src-tauri/target/debug/`) in `.next/standalone/`,
        // weil die Rust-Quellen Repo-Dateien referenzieren. Der Desktop-Stage
        // braucht davon nichts — die Runtime wird separat als Tauri-Resource
        // gebuendelt (siehe src-tauri/tauri.conf.json).
        //
        // Betroffen sind ausschliesslich Repo-Entwicklungsartefakte; der
        // Anwendungs-Code (src/, app/, messages/, public/) bleibt unberuehrt.
        outputFileTracingExcludes: {
          "/*": [
            "./src-tauri/**/*",
            "./playwright-report/**/*",
            "./test-results/**/*",
            "./release/**/*",
            "./.runtime-cache/**/*",
            "./docs/**/*",
            "./e2e/**/*",
            "./storage/**/*",
            "./pgdata/**/*",
            "./runtime-state/**/*",
            "./.next/cache/**/*",
          ],
        },
      }
    : {}),
};

export default withNextIntl(nextConfig);
