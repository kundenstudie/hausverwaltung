import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // HAVEWA-07A-2: Generated output (tsc-Output, Runtime-Tree).
    "scripts/dist/**",
    "scripts/.runtime/**",
    // HAVEWA-07C: Tauri/Cargo-Build-Artefakte (von cargo + tauri-build generiert).
    "src-tauri/target/**",
    "src-tauri/gen/schemas/**",
  ]),
]);

export default eslintConfig;
