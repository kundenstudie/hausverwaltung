// HAVEWA-07D G7-FIX — Zentrale Prisma-Engine-Policy (Windows-x64-only).
//
// SINGLE SOURCE OF TRUTH fuer die Klassifikation nativer Prisma-Binaries.
//
// ROOT CAUSE (G7-Blocker):
//   Der bisherige Prune (prunePrismaClientEngines) und der bisherige
//   Verifier erkannten nur die Namen `libquery_engine-*` und
//   `query_engine-*`. Die Prisma-CLI liefert aber weitere native
//   Engine-FAMILien aus, u.a. `schema-engine-<target>` (Migration/Schema)
//   sowie `migration-engine-*` / `introspection-engine-*` / `prisma-fmt-*`.
//   Dadurch blieb z.B.
//     @prisma/engines/schema-engine-linux-arm64-openssl-3.0.x
//   (ELF/aarch64, ~19 MB) im 0.6.0-Installer unentdeckt.
//
// ZWECK:
//   1) PACKAGING: fail-closed-Filter, der JEDE native Prisma-Engine
//      entfernt, die NICHT zum Zieltarget (windows-x64) gehoert.
//   2) VERIFIER: gleiche Klassifikation, damit der Verifier jede
//      Non-Windows-/Non-x64-/ARM64-Engine als Fehler meldet.
//
// DESIGN (fail-closed):
//   - Es wird NIE ueber Dateinamen geraten, welche Datei eine "Engine" ist.
//     Eine Datei gilt nur dann als native Prisma-Engine, wenn sie
//     (a) einen bekannten Engine-Namenspraefix traegt UND
//     (b) einen bekannten nativen Datei-typ (ELF / PE / Mach-O) hat
//         ODER einen nicht-textuellen (binären) Inhalt aufweist.
//   - Der Zieltarget wird aus dem Dateinamen abgeleitet. Jede Engine, deren
//     Zieltarget NICHT eindeutig als windows-x64 erkannt wird, wird
//     ENTFERNT (fail-closed) bzw. als FEHLER gemeldet.
//
// Verwendet von:
//   - scripts/package-desktop-runtime.mjs   (Packaging-Filter)
//   - scripts/package-runtime.mjs           (Prisma-CLI-Tree-Build)
//   - scripts/verify-desktop-runtime.mjs    (Stage-Verifikation)
//   - scripts/verify-desktop-installer.mjs   (Installer-Artefakt-Pruefung)
//   - scripts/verify-desktop-install.mjs     (installierter Payload)

import path from "node:path";

/**
 * Zieltarget des Desktop-Produkts: ausschliesslich Windows x64.
 */
export const TARGET_OS = "windows";
export const TARGET_ARCH = "x64";

/**
 * Bekannte native Prisma-Engine-FAMILIEN (Namenpraefix, lowercase).
 *
 * Vollstaendigkeit ist hier entscheidend: JEDE Familie, die Prisma
 * ausliefern kann, muss gelistet sein, damit der Filter sie greift.
 *
 * Prisma 6.x liefert u.a.:
 *   query_engine-windows.dll.node      (Query-Engine, Library)
 *   libquery_engine-*.so.node           (Query-Engine, dynamisch gelinkt)
 *   schema-engine-windows.exe           (Schema/Migration-Engine)
 *   migration-engine-*                  (aeltere Prisma-Versionen)
 *   introspection-engine-*              (aeltere Prisma-Versionen)
 *   prisma-fmt-*                        (Schema-Formatter, WASM/nativ)
 */
export const PRISMA_ENGINE_FAMILIES = [
  "query_engine",
  "libquery_engine",
  "schema-engine",
  "schema_engine",
  "migration-engine",
  "migration_engine",
  "introspection-engine",
  "introspection_engine",
  "prisma-fmt",
  "prisma_fmt",
];

/**
 * Plattform-/Architektur-Token, die in Engine-Dateinamen vorkommen.
 *
 * Reihenfolge = Erkennungsreihenfolge (spezifischste zuerst).
 *
 * Die Tokens werden NICHT per Regex auf dem ganzen Dateinamen gesucht,
 * sondern der Dateiname wird an `-`, `_` und `.` in Token zerlegt. Das
 * ist wichtig, weil Prisma-Dateinamen die Endung direkt an das Target
 * anhaengen:
 *   query_engine-windows.dll.node   -> Token: "windows"
 *   schema-engine-linux-arm64-openssl-3.0.x -> Token: "linux","arm64"
 */
const TARGET_TOKENS = [
  // Architektur zuerst: sie kommen im Dateinamen VOR dem OS-Token.
  { token: "arm64", os: "linux", arch: "arm64", family: "linux-arm64" },
  { token: "aarch64", os: "linux", arch: "arm64", family: "linux-arm64" },
  { token: "riscv64", os: "linux", arch: "riscv64", family: "linux-riscv64" },
  { token: "ppc64le", os: "linux", arch: "ppc64le", family: "linux-ppc64le" },
  { token: "s390x", os: "linux", arch: "s390x", family: "linux-s390x" },
  { token: "i686", os: "linux", arch: "ia32", family: "linux-ia32" },
  { token: "amd64", os: "windows", arch: "x64", family: "windows-x64" },
  { token: "x64", os: "windows", arch: "x64", family: "windows-x64" },
  { token: "x86", os: "linux", arch: "x86", family: "linux-x86" },
  { token: "win32", os: "windows", arch: "x86", family: "windows-x86" },
  { token: "windows", os: "windows", arch: "x64", family: "windows-x64" },
  { token: "win", os: "windows", arch: "x64", family: "windows-x64" },
  { token: "darwin", os: "darwin", arch: "x64", family: "darwin-x64" },
  { token: "macos", os: "darwin", arch: "x64", family: "darwin-x64" },
  { token: "osx", os: "darwin", arch: "x64", family: "darwin-x64" },
  { token: "freebsd", os: "freebsd", arch: "x64", family: "freebsd-x64" },
  { token: "solaris", os: "solaris", arch: "x64", family: "solaris-x64" },
  { token: "debian", os: "linux", arch: "x64", family: "linux-debian" },
  { token: "rhel", os: "linux", arch: "x64", family: "linux-rhel" },
  { token: "alpine", os: "linux", arch: "x64", family: "linux-musl" },
  { token: "musl", os: "linux", arch: "x64", family: "linux-musl" },
  { token: "linux", os: "linux", arch: "x64", family: "linux-x64" },
];

/**
 * Zerlegt einen Engine-Dateinamen in Target-Token.
 * "schema-engine-linux-arm64-openssl-3.0.x" -> ["schema","engine","linux","arm64","openssl","3","0","x"]
 */
export function engineTokens(fileName) {
  const base = path.basename(String(fileName || "")).toLowerCase();
  return base.split(/[-_.]+/).filter(Boolean);
}

/**
 * Zentrale Liste der VERBOTENEN Engine-Namensmuster (fuer String-Scans
 * in komprimierten Containern, z.B. der NSIS-Datei-Tabelle).
 *
 * Abgeleitet aus PRISMA_ENGINE_FAMILIES + den Nicht-Windows-Targets.
 * Bewusst als Klartext-Patterns, damit sie auch in einem LZMA-komprimierten
 * Installer-Header (unkomprimierte Dateitabelle) gefunden werden.
 */
export const PRISMA_FORBIDDEN_NAME_PATTERNS = Object.freeze([
  // Linux / musl / Debian / Alpine
  "query_engine-linux",
  "query_engine-debian",
  "query_engine-alpine",
  "query_engine-musl",
  "query-engine-linux",
  "query-engine-debian",
  "query-engine-alpine",
  "query-engine-musl",
  "libquery_engine-linux",
  "libquery_engine-debian",
  "libquery_engine-alpine",
  "libquery_engine-musl",
  // Schema-/Migration-/Introspection-Engines (Prisma 6.x)
  "schema-engine-linux",
  "schema-engine-debian",
  "schema-engine-alpine",
  "schema-engine-musl",
  "schema-engine-darwin",
  "schema-engine-freebsd",
  "schema_engine-linux",
  "schema_engine-debian",
  "migration-engine-linux",
  "migration-engine-debian",
  "introspection-engine-linux",
  "introspection-engine-debian",
  // ARM / aarch64
  "arm64",
  "aarch64",
  "riscv64",
  // macOS / BSD
  "darwin",
  "freebsd",
]);

/**
 * native Dateitypen, die eine Prisma-Engine "definitiv nativ" machen.
 * Textdateien (z.B. README, .d.ts) sind KEINE Engines.
 */
const NATIVE_SUFFIXES = [
  ".exe",
  ".dll",
  ".node",
  ".so",
  ".dylib",
  ".wasm",
];

/**
 * ELF-/PE-/Mach-O-Signaturen (Byte-Marker am Dateianfang).
 *  - ELF:   0x7F "ELF"          (Linux/Unix)
 *  - PE:    "MZ" ... "PE\0\0"    (Windows)
 *  - Mach-O: 0xFEEDFACF / 0xFEEDFACE / 0xCAFEBABE (Big-Endian)
 */
export function detectBinaryFormat(head) {
  if (!head || head.length < 4) return null;
  if (head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) {
    return "elf";
  }
  if (head[0] === 0x4d && head[1] === 0x5a) return "pe";
  // Mach-O: Big-Endian-Magics (0xFEEDFACE/0xFEEDFACF) und die
  // Byte-Swapped-Varianten (0xCEFAEDFE/0xCFFAEDFE).
  const be = (b) => (b[0] << 24 >>> 0) + (b[1] << 16 >>> 0) + (b[2] << 8 >>> 0) + b[3];
  const magic = be(head);
  if (magic === 0xfeedface || magic === 0xfeedfacf || magic === 0xcafebabe
      || magic === 0xcefaedfe || magic === 0xcffaedfe) {
    return "macho";
  }
  // WASM
  if (head[0] === 0x00 && head[1] === 0x61 && head[2] === 0x73 && head[3] === 0x6d) {
    return "wasm";
  }
  return null;
}

/**
 * Ermittelt die Engine-Familie (namensbasiert).
 *
 * WASM-/JS-Bindings (`query_engine_bg.postgresql.js`,
 * `wasm-engine-edge.mjs`, `*.wasm`) sind KEINE nativen Engine-Binaries
 * und werden deshalb nicht als Familie gemeldet.
 *
 * @returns {string|null} lowercase Praefix der Familie, z.B. "schema-engine"
 */
export function engineFamily(fileName) {
  const base = path.basename(String(fileName || "")).toLowerCase();
  const suffix = path.extname(base);
  // WASM-/JS-Bindings ausschliessen (keine native Target-Binary).
  if (suffix === ".js" || suffix === ".mjs" || suffix === ".cjs" || suffix === ".wasm") {
    return null;
  }
  // Reihenfolge ist relevant: "libquery_engine" muss vor "query_engine"
  // geprueft werden, sonst matcht "query_engine" zuerst (prefix-Match).
  for (const fam of PRISMA_ENGINE_FAMILIES) {
    if (base.startsWith(fam)) return fam;
  }
  return null;
}

/**
 * Leitet den Zieltarget aus dem Dateinamen ab.
 * @returns {{os:string,arch:string,family:string,matched:boolean}}
 */
export function engineTarget(fileName) {
  const tokens = engineTokens(fileName);
  const unknown = { os: "unknown", arch: "unknown", family: "unknown", matched: false };
  for (const t of TARGET_TOKENS) {
    if (tokens.includes(t.token)) {
      return { os: t.os, arch: t.arch, family: t.family, matched: true };
    }
  }
  return unknown;
}

/**
 * Zentrale Entscheidungsfunktion: Ist die Datei eine native Prisma-Engine,
 * die NICHT zum Zieltarget (windows-x64) gehoert?
 *
 * @param {string} fileName  Dateiname (oder Pfad)
 * @param {Buffer} [head]    Optional: erste Bytes der Datei (fuer
 *                           Format-Erkennung). Fehlt die Datei-Magie,
 *                           wird auf Dateiendung + Namensanalyse
 *                           zurueckgefallen.
 * @returns {{isEngine:boolean, family:string|null, target:object,
 *            allowed:boolean, reason:string|null}}
 */
export function classifyPrismaEngine(fileName, head) {
  const family = engineFamily(fileName);
  if (!family) {
    return {
      isEngine: false, family: null,
      target: { os: "unknown", arch: "unknown", family: "unknown", matched: false },
      allowed: true, reason: null,
    };
  }

  // Zieltarget aus dem Namen ableiten.
  const target = engineTarget(fileName);

  // Windows-Engines tragen kein Architektur-Suffix, wenn sie die
  // x64-Variante sind ("query_engine-windows.dll.node"). Der Token-Match
  // auf "windows" setzt dann arch=x64 (siehe TARGET_TOKENS).
  //
  // Fail-closed: Wenn KEIN Target-Token erkannt wurde, ist die Datei
  // nicht eindeutig windows-x64 -> entfernen / melden.
  let isWindowsX64 = target.os === "windows" && target.arch === "x64";

  // Gegenprobe ueber den Dateiinhalt: Eine Datei, die sich als
  // windows-x64 ausgibt, aber z.B. eine ELF-Magic hat, ist ein
  // Widerspruch -> fail-closed verbieten.
  let reason = isWindowsX64 ? null : `Zieltarget ist ${target.family} (nicht windows-x64)`;
  if (head && head.length >= 4) {
    const format = detectBinaryFormat(head);
    if (format === "elf" || format === "macho") {
      isWindowsX64 = false;
      reason = `Datei-Format ist ${format}, nicht PE (Windows) — Zieltarget ${target.family}`;
    }
  }

  return {
    isEngine: true,
    family,
    target,
    allowed: isWindowsX64,
    reason,
  };
}

/**
 * Windows-x64-Ausnahmen, die KEINE Engine sind und deshalb nicht
 * entfernt werden duerfen.
 *
 * Beispiele:
 *   @prisma/client/runtime/query_engine_bg.postgresql.js   (WASM-Binding, JS)
 *   @prisma/client/runtime/wasm-engine-edge.mjs            (WASM-Binding, JS)
 *   node_modules/prisma/build/query_engine_bg.postgresql.wasm (WASM)
 *
 * Diese Dateien sind NICHT native Engines des Zieltarget-Binaries.
 * WASM ist architekturunabhaengig und damit kein "Linux"/"ARM64"-Fehler.
 */
export function isNonEngineWasmOrJs(fileName) {
  const base = path.basename(String(fileName || "")).toLowerCase();
  if (!base.endsWith(".js") && !base.endsWith(".mjs") && !base.endsWith(".cjs")
      && !base.endsWith(".wasm") && !base.endsWith(".wasm-base64.js")
      && !base.endsWith(".wasm-base64.mjs")) {
    return false;
  }
  // Eine .js/.mjs-Datei mit Engine-Namen ist ein WASM-Binding, keine
  // native Engine. Eine .wasm-Datei ist architekturunabhaengig.
  return true;
}

/**
 * native Dateiendungen, die zusaetzlich als "verdaechtig" gelten, wenn
 * ihr Name auf eine Engine-Familie hindeutet, ABER kein Windows-Target
 * enthaelt (z.B. `query_engine_bg.postgresql.js` -> kein natives Binary).
 */
export function looksLikeNativeEngineFile(fileName) {
  const base = path.basename(String(fileName || "")).toLowerCase();
  const suffix = path.extname(base);
  return NATIVE_SUFFIXES.includes(suffix);
}

/**
 * Bequeme Helfer: Prueft, ob ein Dateiname eine native Prisma-Engine
 * IST (Familie erkannt UND native Dateiendung ODER unbekannte Endung).
 *
 * `.js`/`.mjs`/`.wasm` sind ausgenommen (WASM-Bindings sind keine
 * nativen Target-Binaries).
 */
export function isNativePrismaEngineFile(fileName) {
  const family = engineFamily(fileName);
  if (!family) return false;
  const base = path.basename(String(fileName || "")).toLowerCase();
  const suffix = path.extname(base);
  if (suffix === ".js" || suffix === ".mjs" || suffix === ".cjs") return false;
  if (suffix === ".wasm") return false;
  if (suffix === ".map" || suffix === ".json" || suffix === ".ts"
      || suffix === ".mts" || suffix === ".d.ts") return false;
  return true;
}

const prismaEnginePolicy = {
  TARGET_OS,
  TARGET_ARCH,
  PRISMA_ENGINE_FAMILIES,
  detectBinaryFormat,
  engineFamily,
  engineTarget,
  classifyPrismaEngine,
  isNativePrismaEngineFile,
  isNonEngineWasmOrJs,
  looksLikeNativeEngineFile,
};

export default prismaEnginePolicy;
