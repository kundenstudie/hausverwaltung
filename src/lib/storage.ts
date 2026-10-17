import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { storageDocumentsDir } from "@/lib/data-dir";

// Lokaler Datei-Speicher. ponytail: lokale Platte reicht; S3/Blob-Adapter,
// wenn Multi-Node oder Objektspeicher gebraucht wird.
// HAVEWA-07A-2: Basisverzeichnis folgt HAVEWA_DATA_DIR (sonst process.cwd()).
// App-Assets (.next/static, public, messages) bleiben unveraendert im Build-Tree.
function baseDir(): string {
  return storageDocumentsDir();
}

export async function saveFile(buffer: Buffer, originalName: string): Promise<string> {
  const base = baseDir();
  await fs.mkdir(base, { recursive: true });
  const ext = path.extname(originalName).slice(0, 12);
  const key = `${crypto.randomUUID()}${ext}`;
  await fs.writeFile(path.join(base, key), buffer);
  return key;
}

export async function readFile(key: string): Promise<Buffer> {
  // Path-Traversal verhindern: nur Basename zulassen.
  const safe = path.basename(key);
  return fs.readFile(path.join(baseDir(), safe));
}

export async function deleteFile(key: string): Promise<void> {
  const safe = path.basename(key);
  await fs.rm(path.join(baseDir(), safe), { force: true });
}
