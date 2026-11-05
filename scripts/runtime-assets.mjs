// HAVEWA-07D G1 — Runtime Asset Acquisition.
//
// Ziel:
//   - Reproduzierbar die zwei Runtimes beschaffen, die später in den
//     Desktop-Installer gebündelt werden:
//       * Node.js v22.23.3 (Windows x64)
//       * PostgreSQL 16.14 (Windows x64, EDB Windows-Binaries)
//   - Herkunft, Version, Hash und Architektur gegen das Lockfile
//     `scripts/runtime-assets.lock.json` verifizieren.
//   - Lokalen Build-Cache `.runtime-cache/` aufbauen.
//
// Regeln:
//   - Fail-Closed: Hash-Mismatch, falsche Architektur, fehlende Tools
//     oder fehlende Lizenzen sind HARD STOP.
//   - Atomare Downloads: `.tmp` -> Verify -> rename.
//   - ZIP-Extraktion: keine absolute Pfade, keine `..`-Escapes.
//   - Keine latest-URLs, keine ungeprüften Mirrors, kein HTTP.
//   - Cache liegt unter `<repo>/.runtime-cache/`, ist gitignored.
//   - Keine stillen Hash-Aktualisierungen. TOFU-Pin bleibt TOFU.
//
// CLI:
//   node scripts/runtime-assets.mjs verify
//   node scripts/runtime-assets.mjs prepare
//
// Vor jedem späteren Build laufen die Hashes gegen den Lockfile-Eintrag.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";

// ---------------------------------------------------------------------------
// Lockfile
// ---------------------------------------------------------------------------

const DEFAULT_LOCKFILE_NAME = "runtime-assets.lock.json";

const REQUIRED_ASSET_KIND_FIELDS = Object.freeze([
  "version",
  "platform",
  "arch",
  "archive",
  "url",
  "sha256",
  "sha256Source",
  "hashProvenance",
  "requiredTools",
]);

const LOCKFILE_TOP_LEVEL_KEYS = Object.freeze([
  "schemaVersion",
  "generatedAt",
  "purpose",
  "node",
  "postgres",
]);

const FAILURE = (reason) => ({ ok: false, reason });

/** Kleine, absichtlich ehrliche Fehlerausgabe. */
function defaultLogger() {
  return {
    info: (m) => process.stdout.write(`[runtime-assets] ${m}\n`),
    warn: (m) => process.stderr.write(`[runtime-assets] WARN ${m}\n`),
    error: (m) => process.stderr.write(`[runtime-assets] ERROR ${m}\n`),
  };
}

/**
 * Liest und validiert das Lockfile. Hard-Fail bei Schema-Mismatch, ungültigem
 * Hash-Provenance, fehlenden Pflicht-Feldern oder absoluten lokalen Pfaden.
 *
 * Absoluter Lokalpfad-Heuristik:
 *   - Windows: `C:\\...`, `C:/...`, `\\\\server\\...`
 *   - UNC-Pfade (`\\...`) werden abgelehnt.
 *   - Unix absolut: `/...`
 *
 * Lockfile darf keine absoluten Pfade enthalten — weder zur Cache-Wurzel,
 * noch zu Archiv-Kopie, noch zu System-Locations.
 */
export function loadLockfile(lockfilePath) {
  if (!existsSync(lockfilePath)) {
    throw new Error(`Lockfile nicht gefunden: ${lockfilePath}`);
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(lockfilePath, "utf8"));
  } catch (err) {
    throw new Error(`Lockfile ist kein gültiges JSON: ${err.message}`);
  }
  if (raw?.schemaVersion !== 1) {
    throw new Error(`Lockfile schemaVersion !== 1 (got: ${raw?.schemaVersion})`);
  }
  const top = new Set(Object.keys(raw));
  for (const k of LOCKFILE_TOP_LEVEL_KEYS) {
    if (!top.has(k)) throw new Error(`Lockfile fehlt Top-Level-Feld: ${k}`);
  }
  for (const kind of ["node", "postgres"]) {
    const entry = raw[kind];
    if (!entry || typeof entry !== "object") {
      throw new Error(`Lockfile fehlt Asset-Eintrag: ${kind}`);
    }
    for (const f of REQUIRED_ASSET_KIND_FIELDS) {
      if (!(f in entry)) {
        throw new Error(`Lockfile fehlt Feld ${kind}.${f}`);
      }
    }
    if (entry.platform !== "win32") {
      throw new Error(`Lockfile ${kind}.platform !== win32 (got: ${entry.platform})`);
    }
    if (entry.arch !== "x64") {
      throw new Error(`Lockfile ${kind}.arch !== x64 (got: ${entry.arch})`);
    }
    if (entry.hashProvenance !== "vendor" && entry.hashProvenance !== "tofu") {
      throw new Error(
        `Lockfile ${kind}.hashProvenance muss "vendor" oder "tofu" sein (got: ${entry.hashProvenance})`,
      );
    }
    if (!/^[0-9a-fA-F]{64}$/.test(entry.sha256)) {
      throw new Error(`Lockfile ${kind}.sha256 ist kein 64-Hex-String`);
    }
    if (typeof entry.url !== "string" || !/^https:\/\//i.test(entry.url)) {
      throw new Error(`Lockfile ${kind}.url muss https:// sein`);
    }
    if (typeof entry.archive !== "string" || entry.archive.length === 0) {
      throw new Error(`Lockfile ${kind}.archive muss nicht-leerer String sein`);
    }
    if (!Array.isArray(entry.requiredTools) || entry.requiredTools.length === 0) {
      throw new Error(`Lockfile ${kind}.requiredTools muss nicht-leeres Array sein`);
    }
    // Harte Garantie: keine absoluten Pfade im Lockfile.
    assertNoAbsolutePaths(`${kind}.url`, entry.url);
    assertNoAbsolutePaths(`${kind}.archive`, entry.archive);
    assertNoAbsolutePaths(`${kind}.sha256Source`, entry.sha256Source);
    if (entry.tofuNote) assertNoAbsolutePaths(`${kind}.tofuNote`, entry.tofuNote);
  }
  return raw;
}

function assertNoAbsolutePaths(label, value) {
  if (typeof value !== "string") return;
  // Windows-Laufwerk: C:\, C:/
  if (/^[A-Za-z]:[\\/]/.test(value)) {
    throw new Error(`Lockfile: absoluter Pfad in ${label} verboten: ${value}`);
  }
  // UNC: \\server\share oder \\?\ oder //server
  if (/^\\\\/.test(value) || /^\/\//.test(value)) {
    throw new Error(`Lockfile: UNC/Network-Pfad in ${label} verboten: ${value}`);
  }
  // Unix absolut: /foo
  if (value.startsWith("/")) {
    throw new Error(`Lockfile: absoluter Unix-Pfad in ${label} verboten: ${value}`);
  }
}

// ---------------------------------------------------------------------------
// Pfade / Cache
// ---------------------------------------------------------------------------

/**
 * Pfade unter `<repo>/.runtime-cache/`:
 *   downloads/<archive-name>
 *   extracted/<kind>-<version>-win-x64/
 *
 * Niemals ein Verzeichnis außerhalb des Repo-Cache berühren.
 */
export function resolveAssetPaths(kind, opts = {}) {
  const cacheRoot = opts.cacheRoot ?? path.join(process.cwd(), ".runtime-cache");
  const downloadsDir = path.join(cacheRoot, "downloads");
  const extractedDir = path.join(
    cacheRoot,
    "extracted",
    `${kind}-${stripVPrefix(kind === "node" ? opts._nodeVersion : opts._pgVersion)}-win-x64`,
  );
  return {
    cacheRoot,
    downloadsDir,
    extractedDir,
    assetDownloadsFile: path.join(downloadsDir, ""), // wird mit archive gefüllt
  };
}

function stripVPrefix(v) {
  return typeof v === "string" && v.startsWith("v") ? v.slice(1) : v;
}

// ---------------------------------------------------------------------------
// Atomare Pfad-Operationen
// ---------------------------------------------------------------------------

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function ensureCacheRoot(opts) {
  const cacheRoot = opts.cacheRoot ?? path.join(process.cwd(), ".runtime-cache");
  ensureDir(cacheRoot);
  ensureDir(path.join(cacheRoot, "downloads"));
  ensureDir(path.join(cacheRoot, "extracted"));
  return cacheRoot;
}

function safeArchivePath(entry, opts) {
  const cacheRoot = opts.cacheRoot ?? path.join(process.cwd(), ".runtime-cache");
  ensureDir(path.join(cacheRoot, "downloads"));
  // entry.archive ist vom Lockfile geprüft: kein absoluter Pfad, keine Slashes
  // relativ zur Wurzel.
  if (/[\\/]/.test(entry.archive)) {
    throw new Error(`entry.archive enthält Pfad-Trenner: ${entry.archive}`);
  }
  if (entry.archive.includes("..")) {
    throw new Error(`entry.archive enthält '..': ${entry.archive}`);
  }
  return path.join(cacheRoot, "downloads", entry.archive);
}

function atomicRename(tmpPath, finalPath) {
  // Auf Windows kann renameSync auf eine existierende Datei fehlschlagen,
  // wir löschen daher vorher (atomar genug für ein Build-Skript).
  if (existsSync(finalPath)) {
    const stat = statSync(finalPath);
    if (!stat.isFile()) {
      throw new Error(`Kann ${finalPath} nicht überschreiben (kein File)`);
    }
    unlinkSync(finalPath);
  }
  renameSync(tmpPath, finalPath);
}

function cleanupTmp(tmpPath) {
  try {
    if (existsSync(tmpPath)) unlinkSync(tmpPath);
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// SHA256 einer Datei (Streaming; Archive sind gross)
// ---------------------------------------------------------------------------

function sha256OfFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

export async function verifyArchiveHash(archivePath, expectedSha256) {
  if (!existsSync(archivePath)) {
    return FAILURE(`Archiv existiert nicht: ${archivePath}`);
  }
  const actual = await sha256OfFile(archivePath);
  if (actual.toLowerCase() !== expectedSha256.toLowerCase()) {
    return FAILURE(
      `SHA256 mismatch: expected=${expectedSha256} actual=${actual}`,
    );
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Download mit Redirect-Whitelist + Timeout
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_REDIRECTS = 5;

/**
 * Prüft, ob ein Host in der Allowlist ist. Standard-Defaults decken
 *   - nodejs.org und Subdomains
 *   - get.enterprisedb.com
 * ab. Mirrors Dritter werden NICHT akzeptiert.
 */
function makeHostAllowlist(extra = []) {
  const seeds = [
    /^nodejs\.org$/i,
    /^nodejs\.org$/i,
    /^(?:.*\.)?nodejs\.org$/i,
    /^get\.enterprisedb\.com$/i,
  ];
  for (const e of extra) {
    if (e instanceof RegExp) seeds.push(e);
    else if (typeof e === "string") seeds.push(new RegExp(`^${e.replace(/\./g, "\\.")}$`, "i"));
  }
  return seeds;
}

function hostMatches(host, allowlist) {
  return allowlist.some((rx) => rx.test(host));
}

export async function downloadAsset(entry, opts = {}, outFilePath = "") {
  const logger = opts.logger ?? defaultLogger();
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const allowlist = makeHostAllowlist(opts.allowedHosts ?? []);
  const target = outFilePath && outFilePath.length > 0
    ? outFilePath
    : safeArchivePath(entry, opts);

  ensureDir(path.dirname(target));

  // Wir verfolgen Redirects explizit (fetch in Node folgt Redirects per Default,
  // aber wir wollen Dokumentation + explizite Host-Prüfung).
  let currentUrl = entry.url;
  let redirects = [];
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const u = new URL(currentUrl);
    if (u.protocol !== "https:") {
      return FAILURE(`nicht-HTTPS Download: ${currentUrl}`);
    }
    if (!hostMatches(u.hostname, allowlist)) {
      return FAILURE(
        `Host nicht in Allowlist (${u.hostname}). URL: ${currentUrl}`,
      );
    }
    let response;
    try {
      response = await fetchImpl(currentUrl, { redirect: "manual" });
    } catch (err) {
      return FAILURE(`fetch fehlgeschlagen: ${err.message}`);
    }
    if (
      response.status >= 300 &&
      response.status < 400 &&
      response.headers.get("location")
    ) {
      const next = new URL(response.headers.get("location"), currentUrl);
      redirects.push(next.toString());
      if (redirects.length > maxRedirects) {
        return FAILURE(`zu viele Redirects (>${maxRedirects})`);
      }
      currentUrl = next.toString();
      // Body nicht lesen, Body nach Redirect abbrechen.
      try { response.body?.cancel?.(); } catch { /* noop */ }
      continue;
    }
    if (!response.ok) {
      return FAILURE(`HTTP ${response.status} für ${currentUrl}`);
    }

    // Atomarer Download: .tmp -> verify -> rename.
    const tmpPath = `${target}.tmp`;
    try {
      const body = response.body;
      if (!body) {
        return FAILURE(`Response ohne Body für ${currentUrl}`);
      }
      const fileStream = await openWriteStream(tmpPath);
      try {
        const reader = body.getReader();
        while (true) {
          // Timeout per Read-Iteration.
          const { value, done } = await withTimeout(
            reader.read(),
            timeoutMs,
            `download timeout ${currentUrl}`,
          );
          if (done) break;
          if (value && value.byteLength > 0) {
            // Buffer an File-Stream weiterreichen (async, sequentiell)
            const chunk = Buffer.from(value);
            await writeWithBackpressure(fileStream, chunk);
          }
        }
      } finally {
        await closeWriteStream(fileStream);
      }

      // Hash VOR Verwendung prüfen.
      const verify = await verifyArchiveHash(tmpPath, entry.sha256);
      if (!verify.ok) {
        cleanupTmp(tmpPath);
        return FAILURE(`verify nach Download fehlgeschlagen: ${verify.reason}`);
      }
      atomicRename(tmpPath, target);
      const len = statSync(target).size;
      logger.info(`downloaded ${target} (${len} bytes, hops=${redirects.length})`);
      return { ok: true, filePath: target, bytes: len, finalUrl: currentUrl, redirects };
    } catch (err) {
      cleanupTmp(tmpPath);
      return FAILURE(`Download-Fehler: ${err.message}`);
    }
  }
  return FAILURE(`Redirect-Loop oder kein 2xx von ${entry.url}`);
}

function openWriteStream(tmpPath) {
  // Wir nutzen fs.createWriteStream via dynamic import, um CommonJS-spezifische
  // Bundles zu vermeiden — minimaler Helfer ohne extra dependencies.
  // Node 22 hat stabilen fs.promises.
  // Wir kapseln in ein einfaches write/close-Pair.
  const handle = (async () => {
    const fsp = await import("node:fs/promises");
    const fh = await fsp.open(tmpPath, "w");
    return fh;
  })();
  return handle;
}

async function writeWithBackpressure(fileHandlePromise, chunk) {
  const fh = await fileHandlePromise;
  await fh.write(chunk);
}

async function closeWriteStream(fileHandlePromise) {
  const fh = await fileHandlePromise;
  await fh.sync().catch(() => {});
  await fh.close();
}

function withTimeout(promise, ms, reason) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(reason)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

// ---------------------------------------------------------------------------
// ZIP-Extraktion (Node 22 hat eingebauten unzipper via stream.zip, aber wir
// bleiben sicher und nutzen ein handgerolltes Minimal-Modul mit Path-Traversal-
// Schutz. Wir nutzen NICHT die CommonJS `unzipper` Dependencies, weil wir
// keine neuen Runtime-Dependencies einführen wollen.
// ---------------------------------------------------------------------------

/**
 * Liest einen ZIP Local File Header. Liefert Signatur-Position oder -1.
 * Format eines Local File Headers:
 *   0x04034b50 (4) signature
 *   2 (2) version needed
 *   2 (2) gp flag
 *   2 (2) compression method (0=stored, 8=deflated)
 *   2 (2) last mod time
 *   2 (2) last mod date
 *   4 (4) crc32
 *   4 (4) compressed size
 *   4 (4) uncompressed size
 *   2 (2) file name length
 *   2 (2) extra field length
 *   N (n) file name
 *   M (m) extra
 */
function readUInt16LE(buf, off) {
  return buf[off] | (buf[off + 1] << 8);
}

function readUInt32LE(buf, off) {
  // >>> 0 erzwingt unsigned.
  return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0;
}

/**
 * Wir lesen die ZIP-Central-Directory, um die Entries zu enumerieren. Wir
 * extrahieren nur Entries mit Compression Method 0 (stored) oder 8 (deflated).
 * Pfad-Traversal wird zentral erkannt.
 *
 * Diese Implementation ist absichtlich minimal: sie unterstützt STORED und
 * DEFLATE, was für die offiziellen Node.js und EDB-PostgreSQL-ZIPs ausreicht.
 * Verschlüsselte ZIPs sind unsupported (Hard-Fail).
 */
export async function extractZipSafely(archivePath, outDir, opts = {}) {
  const logger = opts.logger ?? defaultLogger();
  if (!existsSync(archivePath)) {
    return FAILURE(`Archiv fehlt: ${archivePath}`);
  }
  ensureDir(outDir);

  const fileStat = statSync(archivePath);
  // ZIP-Ends bei "End Of Central Directory" (EOCD) Record (Signature 0x06054b50).
  // Max comment size = 65535, also genug Platz zum Scannen der letzten ~64KB.
  const tailSize = Math.min(64 * 1024, fileStat.size);
  const fsp = await import("node:fs/promises");
  const fh = await fsp.open(archivePath, "r");
  const tailBuf = Buffer.alloc(tailSize);
  await fh.read(tailBuf, 0, tailSize, fileStat.size - tailSize);
  await fh.close();

  // Finde EOCD (Signature 0x06054b50) — wir suchen rückwärts.
  let eocdOffset = -1;
  for (let i = tailBuf.length - 22; i >= 0; i--) {
    if (
      tailBuf[i] === 0x50 &&
      tailBuf[i + 1] === 0x4b &&
      tailBuf[i + 2] === 0x05 &&
      tailBuf[i + 3] === 0x06
    ) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    return FAILURE(`EOCD-Signature nicht gefunden (kein ZIP?)`);
  }
  const cdSize = readUInt32LE(tailBuf, eocdOffset + 12);
  const cdOffset = readUInt32LE(tailBuf, eocdOffset + 16);
  // Wenn der CD-Bereich im tailBuf liegt, subarray'en; sonst neu laden.
  let cdBuf;
  const tailFileOffset = fileStat.size - tailSize;
  if (cdOffset >= tailFileOffset && cdOffset + cdSize <= fileStat.size) {
    const startInTail = cdOffset - tailFileOffset;
    cdBuf = tailBuf.subarray(startInTail, startInTail + cdSize);
  } else {
    const fh2 = await fsp.open(archivePath, "r");
    cdBuf = Buffer.alloc(cdSize);
    await fh2.read(cdBuf, 0, cdSize, cdOffset);
    await fh2.close();
  }

  // Wir enumerieren alle Central-Directory-Einträge.
  const entrySpecs = [];
  let p = 0;
  while (p < cdBuf.length - 46) {
    if (
      cdBuf[p] === 0x50 &&
      cdBuf[p + 1] === 0x4b &&
      cdBuf[p + 2] === 0x01 &&
      cdBuf[p + 3] === 0x02
    ) {
      const compMethod = readUInt16LE(cdBuf, p + 10);
      const compSize = readUInt32LE(cdBuf, p + 20);
      const uncompSize = readUInt32LE(cdBuf, p + 24);
      const fnameLen = readUInt16LE(cdBuf, p + 28);
      const extraLen = readUInt16LE(cdBuf, p + 30);
      const commentLen = readUInt16LE(cdBuf, p + 32);
      const localHeaderOffset = readUInt32LE(cdBuf, p + 42);
      const name = cdBuf.subarray(p + 46, p + 46 + fnameLen).toString("utf8");
      entrySpecs.push({
        name,
        compMethod,
        compSize,
        uncompSize,
        localHeaderOffset,
      });
      p += 46 + fnameLen + extraLen + commentLen;
    } else {
      break;
    }
  }
  if (entrySpecs.length === 0) {
    return FAILURE(`Central Directory leer`);
  }

  // Path-Traversal / absolute Pfade Pre-Check.
  for (const e of entrySpecs) {
    if (e.name.length === 0) continue;
    if (path.isAbsolute(e.name) || /^[A-Za-z]:[\\/]/.test(e.name)) {
      return FAILURE(`ZIP enthält absoluten Pfad: ${e.name}`);
    }
    // Eine `..`-Komponente (Pfad-Segment) ist gefährlich; `..` mitten im
    // Dateinamen (z.B. `foo..bar`) ist harmlos.
    const segments = e.name.split(/[\\/]+/);
    if (segments.some((s) => s === ".." || s === ".")) {
      return FAILURE(`ZIP enthält Path-Traversal: ${e.name}`);
    }
  }

  // Wir laden die Archive-Daten ein zweites Mal und schreiben die Entries.
  const fh3 = await fsp.open(archivePath, "r");
  // Pre-allocate einen grossen Read-Buffer pro Entry.
  try {
    for (const e of entrySpecs) {
      // Local File Header konsumieren.
      const lfhBuf = Buffer.alloc(30);
      await fh3.read(lfhBuf, 0, 30, e.localHeaderOffset);
      const sigOk =
        lfhBuf[0] === 0x50 &&
        lfhBuf[1] === 0x4b &&
        lfhBuf[2] === 0x03 &&
        lfhBuf[3] === 0x04;
      if (!sigOk) {
        return FAILURE(`Local Header für ${e.name} nicht gefunden`);
      }
      const lfnameLen = readUInt16LE(lfhBuf, 26);
      const lextraLen = readUInt16LE(lfhBuf, 28);
      const dataOffset = e.localHeaderOffset + 30 + lfnameLen + lextraLen;
      // Verzeichnis-Entry.
      const targetPath = path.join(outDir, e.name);
      // Normalisiere und stelle sicher, dass `..` nicht nach outDir flieht.
      const rel = path.relative(outDir, targetPath);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        return FAILURE(`Path-Traversal bei ${e.name} -> ${rel}`);
      }
      if (e.name.endsWith("/") || e.name.endsWith("\\")) {
        ensureDir(targetPath);
        continue;
      }
      ensureDir(path.dirname(targetPath));
      if (e.compMethod === 0) {
        // STORED.
        if (e.uncompSize === 0) {
          // leere Datei
          await fsp.writeFile(targetPath, Buffer.alloc(0));
          continue;
        }
        const dataBuf = Buffer.alloc(e.uncompSize);
        await fh3.read(dataBuf, 0, e.uncompSize, dataOffset);
        await fsp.writeFile(targetPath, dataBuf);
      } else if (e.compMethod === 8) {
        // DEFLATE.
        if (e.uncompSize === 0) {
          await fsp.writeFile(targetPath, Buffer.alloc(0));
          continue;
        }
        const compressedBuf = Buffer.alloc(e.compSize);
        await fh3.read(compressedBuf, 0, e.compSize, dataOffset);
        const zlib = await import("node:zlib");
        const inflated = await new Promise((resolve, reject) => {
          zlib.inflateRaw(compressedBuf, (err, buf) => {
            if (err) reject(err);
            else resolve(buf);
          });
        });
        await fsp.writeFile(targetPath, inflated);
      } else {
        return FAILURE(`Nicht unterstützte Kompression (${e.compMethod}) für ${e.name}`);
      }
    }
    logger.info(`extracted ${entrySpecs.length} entries -> ${outDir}`);
    return { ok: true, extractedDir: outDir };
  } finally {
    await fh3.close();
  }
}

// ---------------------------------------------------------------------------
// Verifikation der extrahierten Binaries
// ---------------------------------------------------------------------------

function readPeMachineOfFile(filePath) {
  const buf = readFileSync(filePath);
  // DOS MZ -> e_lfanew at 0x3C
  if (buf.length < 64) return -1;
  const peOffset = buf.readUInt32LE(0x3c);
  if (peOffset <= 0 || peOffset + 4 > buf.length) return -1;
  if (
    buf[peOffset] !== 0x50 ||
    buf[peOffset + 1] !== 0x45 ||
    buf[peOffset + 2] !== 0 ||
    buf[peOffset + 3] !== 0
  ) {
    return -1;
  }
  return buf.readUInt16LE(peOffset + 4);
}

/**
 * Liest die im Archiv hinterlegten Central Directory Einträge MIT
 * berechnetem dataOffset (Local Header + 30 + fname + extra).
 */
async function readCdEntries(archivePath) {
  const fsp = await import("node:fs/promises");
  const stat = statSync(archivePath);
  const tailSize = Math.min(64 * 1024, stat.size);
  const fh = await fsp.open(archivePath, "r");
  const tailBuf = Buffer.alloc(tailSize);
  await fh.read(tailBuf, 0, tailSize, stat.size - tailSize);
  await fh.close();
  let eocdOffset = -1;
  for (let i = tailBuf.length - 22; i >= 0; i--) {
    if (
      tailBuf[i] === 0x50 &&
      tailBuf[i + 1] === 0x4b &&
      tailBuf[i + 2] === 0x05 &&
      tailBuf[i + 3] === 0x06
    ) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error(`EOCD nicht gefunden in ${archivePath}`);
  const cdSize = readUInt32LE(tailBuf, eocdOffset + 12);
  const cdOffset = readUInt32LE(tailBuf, eocdOffset + 16);
  const tailFileOffset = stat.size - tailSize;
  let cdBuf;
  if (cdOffset >= tailFileOffset && cdOffset + cdSize <= stat.size) {
    const startInTail = cdOffset - tailFileOffset;
    cdBuf = tailBuf.subarray(startInTail, startInTail + cdSize);
  } else {
    const fh2 = await fsp.open(archivePath, "r");
    cdBuf = Buffer.alloc(cdSize);
    await fh2.read(cdBuf, 0, cdSize, cdOffset);
    await fh2.close();
  }
  const out = [];
  let p = 0;
  while (p < cdBuf.length - 46) {
    if (
      cdBuf[p] === 0x50 &&
      cdBuf[p + 1] === 0x4b &&
      cdBuf[p + 2] === 0x01 &&
      cdBuf[p + 3] === 0x02
    ) {
      const compMethod = readUInt16LE(cdBuf, p + 10);
      const compSize = readUInt32LE(cdBuf, p + 20);
      const uncompSize = readUInt32LE(cdBuf, p + 24);
      const fnameLen = readUInt16LE(cdBuf, p + 28);
      const extraLen = readUInt16LE(cdBuf, p + 30);
      const commentLen = readUInt16LE(cdBuf, p + 32);
      const localHeaderOffset = readUInt32LE(cdBuf, p + 42);
      const name = cdBuf.subarray(p + 46, p + 46 + fnameLen).toString("utf8");
      // Local Header parsen (nur das Notwendige), um dataOffset zu bestimmen.
      const lfhBuf = Buffer.alloc(30);
      const fh3 = await fsp.open(archivePath, "r");
      await fh3.read(lfhBuf, 0, 30, localHeaderOffset);
      await fh3.close();
      const sigOk =
        lfhBuf[0] === 0x50 &&
        lfhBuf[1] === 0x4b &&
        lfhBuf[2] === 0x03 &&
        lfhBuf[3] === 0x04;
      if (!sigOk) {
        throw new Error(`LFH-Signatur fehlt für ${name}`);
      }
      const lFnameLen = readUInt16LE(lfhBuf, 26);
      const lExtraLen = readUInt16LE(lfhBuf, 28);
      const dataOffset = localHeaderOffset + 30 + lFnameLen + lExtraLen;
      out.push({
        name,
        compMethod,
        compSize,
        uncompSize,
        localHeaderOffset,
        dataOffset,
        lfnameLen,
        lextraLen,
      });
      p += 46 + fnameLen + extraLen + commentLen;
    } else {
      break;
    }
  }
  return out;
}

export async function verifyPeMachine(
  archivePath,
  memberPathWithinZip,
  expectedArch = "x64",
) {
  // Wir lesen den Member direkt aus dem ZIP (CD -> Local Header -> data).
  const wanted = normalizeZipPath(memberPathWithinZip);
  const entryList = await readCdEntries(archivePath);
  const spec = entryList.find((e) => normalizeZipPath(e.name) === wanted);
  if (!spec) return FAILURE(`Member im Archiv fehlt: ${memberPathWithinZip}`);
  if (spec.compSize === 0) {
    return FAILURE(`Member ist leer: ${memberPathWithinZip}`);
  }
  const fsp = await import("node:fs/promises");
  const fh = await fsp.open(archivePath, "r");
  try {
    const compBuf = Buffer.alloc(spec.compSize);
    await fh.read(compBuf, 0, spec.compSize, spec.dataOffset);
    let binBuf;
    if (spec.compMethod === 0) {
      binBuf = compBuf;
    } else if (spec.compMethod === 8) {
      const zlib = await import("node:zlib");
      binBuf = await new Promise((resolve, reject) => {
        zlib.inflateRaw(compBuf, (err, b) => (err ? reject(err) : resolve(b)));
      });
    } else {
      return FAILURE(`Nicht unterstützte Kompression (${spec.compMethod})`);
    }
    const tmpDir = path.join(process.cwd(), ".runtime-cache");
    ensureDir(tmpDir);
    const tmpPath = path.join(tmpDir, ".peprobe.tmp");
    await fsp.writeFile(tmpPath, binBuf);
    try {
      chmodSync(tmpPath, 0o644);
    } catch {
      // chmod auf Windows ist optional.
    }
    const machine = readPeMachineOfFile(tmpPath);
    try {
      unlinkSync(tmpPath);
    } catch {
      /* noop */
    }
    const expectedHex =
      expectedArch === "x64" ? 0x8664 : expectedArch === "x86" ? 0x014c : 0;
    if (machine !== expectedHex) {
      return FAILURE(
        `PE Machine mismatch für ${memberPathWithinZip}: expected=0x${expectedHex.toString(16)} actual=0x${(machine >>> 0).toString(16)}`,
      );
    }
    return {
      ok: true,
      details: { machineHex: (machine >>> 0).toString(16), member: memberPathWithinZip },
    };
  } finally {
    await fh.close();
  }
}

function normalizeZipPath(p) {
  return String(p).replace(/\\/g, "/").replace(/^\/+/, "");
}

/**
 * Stellt sicher, dass alle geforderten Tools (Binaries) vorhanden sind und
 * dass jedes ein x64-PE ist.
 */
export async function verifyExtractedNode(extractedDir, expected) {
  return verifyExtractedGeneric(extractedDir, expected, {
    archiveRoot: "node-v22.23.3-win-x64",
    probes: [
      {
        relativePath: "node.exe",
        kind: "binary",
      },
    ],
    licenses: expected.requiredLicense ? [expected.requiredLicense] : [],
    licenseBase: "node-v22.23.3-win-x64",
  });
}

export async function verifyExtractedPostgres(extractedDir, expected) {
  // EDB legt das Layout als "pgsql/bin/<tool>.exe" ab. Wir prüfen sowohl die
  // Binaries als auch die Lizenztexte.
  const probes = expected.requiredTools.map((tool) => ({
    relativePath: path.posix.join("pgsql", "bin", tool),
    kind: "binary",
  }));
  return verifyExtractedGeneric(extractedDir, expected, {
    probes,
    licenses: expected.requiredLicenses || [],
  });
}

async function verifyExtractedGeneric(extractedDir, expected, cfg) {
  if (!existsSync(extractedDir)) {
    return FAILURE(`Extrahiertes Verzeichnis fehlt: ${extractedDir}`);
  }
  if (cfg.archiveRoot) {
    const rootPath = path.join(extractedDir, cfg.archiveRoot);
    if (!existsSync(rootPath)) {
      return FAILURE(`Erwartete Archiv-Wurzel fehlt: ${cfg.archiveRoot}`);
    }
  }
  // Probe-Pfad: archiveRoot + relativePath, sonst nur relativePath.
  // (licenseBase wird hier NICHT mehr als Präfix verwendet.)
  const probeRoot = cfg.archiveRoot ?? null;
  for (const probe of cfg.probes || []) {
    if (probe.kind !== "binary") {
      return FAILURE(`Unbekannter Probe-Typ: ${probe.kind}`);
    }
    const fullPath = probeRoot
      ? path.join(extractedDir, probeRoot, probe.relativePath)
      : path.join(extractedDir, probe.relativePath);
    if (!existsSync(fullPath)) {
      return FAILURE(`Erforderliches Tool fehlt: ${probe.relativePath}`);
    }
    const machine = readPeMachineOfFile(fullPath);
    if (machine !== 0x8664) {
      return FAILURE(
        `Tool ${probe.relativePath} ist nicht x64 (PE Machine=0x${(machine >>> 0).toString(16)})`,
      );
    }
  }
  if (cfg.licenses && cfg.licenses.length > 0) {
    for (const lic of cfg.licenses) {
      // Lizenz-Pfade werden mit licenseBase ergänzt (PG: keine, Node: archiveRoot).
      const base = probeRoot ?? cfg.licenseBase ?? null;
      const p = base ? path.join(extractedDir, base, lic) : path.join(extractedDir, lic);
      if (!existsSync(p)) {
        return FAILURE(`Lizenz fehlt: ${lic} (erwartet in ${p})`);
      }
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Cache-Lebenszyklus
// ---------------------------------------------------------------------------

/**
 * Prüft, ob ein vorhandener Cache-Eintrag valide ist (Hash gegen Lockfile).
 * Wenn valide, kann `prepare` ihn ohne Re-Download wiederverwenden.
 */
export async function isCacheValid(kind, opts = {}) {
  const lockfile = loadLockfile(opts.lockfilePath ?? path.join(process.cwd(), "scripts", DEFAULT_LOCKFILE_NAME));
  const entry = lockfile[kind];
  const cacheRoot = opts.cacheRoot ?? path.join(process.cwd(), ".runtime-cache");
  const archivePath = path.join(cacheRoot, "downloads", entry.archive);
  if (!existsSync(archivePath)) {
    return { ok: false, reason: `archive missing in cache: ${archivePath}`, kind };
  }
  const verify = await verifyArchiveHash(archivePath, entry.sha256);
  if (!verify.ok) {
    return { ok: false, reason: verify.reason, kind };
  }
  return { ok: true, kind };
}

/**
 * Vollständiger Prepare-Pfad: lade (oder reuse cache), verifiziere, extrahiere.
 */
export async function prepareAsset(kind, opts = {}) {
  const logger = opts.logger ?? defaultLogger();
  const lockfilePath = opts.lockfilePath ?? path.join(process.cwd(), "scripts", DEFAULT_LOCKFILE_NAME);
  const lockfile = loadLockfile(lockfilePath);
  const entry = lockfile[kind];
  ensureCacheRoot(opts);
  const cacheRoot = opts.cacheRoot ?? path.join(process.cwd(), ".runtime-cache");
  const archivePath = safeArchivePath(entry, { cacheRoot });

  // 1) Cache-Validierung.
  const cacheReuse = archivePath && existsSync(archivePath);
  let cacheOk = false;
  if (cacheReuse) {
    const verify = await verifyArchiveHash(archivePath, entry.sha256);
    if (verify.ok) {
      cacheOk = true;
      logger.info(`cache reuse: ${archivePath}`);
    } else {
      logger.warn(`cache invalid (${verify.reason}) -> re-download`);
      try { unlinkSync(archivePath); } catch { /* noop */ }
    }
  }

  // 2) Download falls Cache nicht ok.
  if (!cacheOk) {
    const download = await downloadAsset(entry, { ...opts, cacheRoot }, archivePath);
    if (!download.ok) return { ok: false, reason: download.reason, cacheReused: false };
  }

  // 3) Hash erneut prüfen.
  const verify = await verifyArchiveHash(archivePath, entry.sha256);
  if (!verify.ok) {
    return { ok: false, reason: verify.reason, cacheReused: cacheOk };
  }

  // 4) Extrahieren.
  const extractedDir = path.join(
    cacheRoot,
    "extracted",
    `${kind}-${stripVPrefix(entry.version)}-win-x64`,
  );
  // Wenn bereits vollständig extrahiert + verifiziert, skip.
  const already = await verifyExtracted(kind, { ...opts, cacheRoot });
  if (already.ok) {
    return { ok: true, cacheReused: cacheOk, extractedDir };
  }
  // Re-Extract: Verzeichnis neu aufbauen.
  if (existsSync(extractedDir)) {
    const fsp = await import("node:fs/promises");
    await fsp.rm(extractedDir, { recursive: true, force: true });
  }
  const extract = await extractZipSafely(archivePath, extractedDir, { logger });
  if (!extract.ok) {
    return { ok: false, reason: extract.reason, cacheReused: cacheOk };
  }
  const verified = await verifyExtracted(kind, { ...opts, cacheRoot });
  if (!verified.ok) {
    return { ok: false, reason: verified.reason, cacheReused: cacheOk };
  }
  return { ok: true, cacheReused: cacheOk, extractedDir };
}

/**
 * Read-only Verify gegen Lockfile + Cache.
 */
export async function verifyAsset(kind, opts = {}) {
  const lockfilePath = opts.lockfilePath ?? path.join(process.cwd(), "scripts", DEFAULT_LOCKFILE_NAME);
  const lockfile = loadLockfile(lockfilePath);
  const entry = lockfile[kind];
  const cacheRoot = opts.cacheRoot ?? path.join(process.cwd(), ".runtime-cache");
  const archivePath = path.join(cacheRoot, "downloads", entry.archive);
  if (!existsSync(archivePath)) {
    return FAILURE(`archive missing: ${archivePath}`);
  }
  const v = await verifyArchiveHash(archivePath, entry.sha256);
  if (!v.ok) return v;
  // Anschließend verifikation der extrahierten Inhalte.
  return verifyExtracted(kind, { ...opts, cacheRoot });
}

async function verifyExtracted(kind, opts) {
  const lockfilePath = opts.lockfilePath ?? path.join(process.cwd(), "scripts", DEFAULT_LOCKFILE_NAME);
  const lockfile = loadLockfile(lockfilePath);
  const entry = lockfile[kind];
  const cacheRoot = opts.cacheRoot ?? path.join(process.cwd(), ".runtime-cache");
  const extractedDir = path.join(
    cacheRoot,
    "extracted",
    `${kind}-${stripVPrefix(entry.version)}-win-x64`,
  );
  if (kind === "node") {
    return verifyExtractedNode(extractedDir, entry);
  }
  if (kind === "postgres") {
    return verifyExtractedPostgres(extractedDir, entry);
  }
  return FAILURE(`Unbekannter Asset-Kind: ${kind}`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function cli(argv) {
  const cmd = argv[2];
  if (cmd === "verify") {
    const lockfilePath = path.join(process.cwd(), "scripts", DEFAULT_LOCKFILE_NAME);
    try {
      loadLockfile(lockfilePath);
    } catch (err) {
      process.stderr.write(`[runtime-assets] ERROR lockfile: ${err.message}\n`);
      return 2;
    }
    let rc = 0;
    for (const kind of ["node", "postgres"]) {
      const r = await verifyAsset(kind, { lockfilePath });
      if (!r.ok) {
        process.stderr.write(`[runtime-assets] verify ${kind}: FAIL (${r.reason})\n`);
        rc = 1;
      } else {
        process.stdout.write(`[runtime-assets] verify ${kind}: OK\n`);
      }
    }
    return rc;
  }
  if (cmd === "prepare") {
    const lockfilePath = path.join(process.cwd(), "scripts", DEFAULT_LOCKFILE_NAME);
    try {
      loadLockfile(lockfilePath);
    } catch (err) {
      process.stderr.write(`[runtime-assets] ERROR lockfile: ${err.message}\n`);
      return 2;
    }
    let rc = 0;
    for (const kind of ["node", "postgres"]) {
      const r = await prepareAsset(kind, { lockfilePath });
      if (!r.ok) {
        process.stderr.write(`[runtime-assets] prepare ${kind}: FAIL (${r.reason})\n`);
        rc = 1;
      } else {
        process.stdout.write(
          `[runtime-assets] prepare ${kind}: OK (cacheReused=${r.cacheReused})\n`,
        );
      }
    }
    return rc;
  }
  process.stderr.write(
    `Usage: node scripts/runtime-assets.mjs <verify|prepare>\n`,
  );
  return 2;
}

// Wir exportieren `cli` nur, wenn das Skript direkt ausgeführt wird (nicht
// bei `import` aus Tests).
const invokedDirectly = (() => {
  try {
    if (!process.argv[1]) return false;
    const invokedPath = path.resolve(process.argv[1]);
    const here = path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
    return invokedPath.toLowerCase() === here.toLowerCase();
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  cli(process.argv).then(
    (code) => {
      process.exit(code);
    },
    (err) => {
      process.stderr.write(`[runtime-assets] FATAL ${err?.stack ?? err}\n`);
      process.exit(2);
    },
  );
}
