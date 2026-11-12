import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';

/**
 * The interface layer's archive: gzip of one JSON document listing EVERY file
 * of the renderer bundle with its sha256 and size, plus the bytes of the files that changed since the base bundle the
 * release was made against. The archive's sha256 is signed in the manifest, so the list is signed too; a file that is not
 * in the archive is taken from a bundle already on this PC only when its sha256 matches the list. A UI fix therefore
 * downloads only what changed (usually a few MB of scripts) and still yields a complete, fully verified bundle.
 */
export const BUNDLE_FORMAT = 'pom-interface-bundle/1';

export interface BundleFile {
  path: string;
  sha256: string;
  size: number;
}

export interface InterfaceBundle {
  format: typeof BUNDLE_FORMAT;
  version: string;
  files: BundleFile[];
  /** base64 bytes of the files the archive carries, by path. */
  blobs: Record<string, string>;
}

const SAFE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._@+\-/ ()[\]~,=']+$/;

/** A bundle-relative POSIX path that cannot leave the bundle folder. */
export function safeBundlePath(p: string): boolean {
  return typeof p === 'string' && p.length > 0 && p.length < 400 && !p.includes('\\') && !p.includes(':') && !p.includes('//') && SAFE.test(p);
}

export function readBundle(archive: Buffer): InterfaceBundle {
  let doc: unknown;
  try {
    doc = JSON.parse(gunzipSync(archive).toString('utf8'));
  } catch (e) {
    throw new Error(`the interface archive is not readable: ${e instanceof Error ? e.message : String(e)}`);
  }
  const b = doc as Partial<InterfaceBundle>;
  if (!b || b.format !== BUNDLE_FORMAT || !Array.isArray(b.files) || typeof b.blobs !== 'object' || b.blobs === null) {
    throw new Error('the interface archive is not a pom-interface-bundle/1');
  }
  const seen = new Set<string>();
  for (const f of b.files) {
    if (!f || !safeBundlePath(f.path) || !/^[a-f0-9]{64}$/.test(f.sha256) || !Number.isInteger(f.size) || f.size < 0) {
      throw new Error(`the interface archive lists an invalid file: ${JSON.stringify(f?.path)}`);
    }
    const key = f.path.toLowerCase();
    if (seen.has(key)) throw new Error(`the interface archive lists ${f.path} twice`);
    seen.add(key);
  }
  if (!seen.has('index.html')) throw new Error('the interface archive has no index.html');
  for (const p of Object.keys(b.blobs)) {
    if (!seen.has(p.toLowerCase())) throw new Error(`the interface archive carries ${p}, which is not in its file list`);
  }
  return b as InterfaceBundle;
}

const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

function sha256File(p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(p).on('error', reject).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex')));
  });
}

/**
 * Writes the complete bundle into `destDir` (emptied first): every listed file, from the archive or from one of
 * `baseDirs`, each checked against its listed sha256 and size. Throws (leaving nothing usable behind) when any file is
 * missing or does not match. Returns the bundle's index.html path.
 */
export async function buildBundleDir(archivePath: string, destDir: string, baseDirs: string[]): Promise<{ indexPath: string; bundle: InterfaceBundle }> {
  const bundle = readBundle(await readFile(archivePath));
  await rm(destDir, { recursive: true, force: true });
  try {
    for (const f of bundle.files) {
      let bytes: Buffer | null = null;
      const blob = bundle.blobs[f.path];
      if (blob !== undefined) {
        bytes = Buffer.from(blob, 'base64');
        if (bytes.length !== f.size || sha256(bytes) !== f.sha256) throw new Error(`${f.path} in the interface archive does not match its signed hash`);
      } else {
        for (const base of baseDirs) {
          const candidate = join(base, ...f.path.split('/'));
          const s = await stat(candidate).catch(() => null);
          if (!s || !s.isFile() || s.size !== f.size) continue;
          const buf = await readFile(candidate);
          if (sha256(buf) === f.sha256) {
            bytes = buf;
            break;
          }
        }
        if (!bytes) throw new Error(`${f.path} is neither in the interface archive nor on this PC with the signed hash`);
      }
      const out = join(destDir, ...f.path.split('/'));
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, bytes);
    }
  } catch (e) {
    await rm(destDir, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
  return { indexPath: join(destDir, 'index.html'), bundle };
}

const CODE = /\.(html|js|mjs|cjs|css|json|wasm)$/i;

/**
 * Checks a built bundle folder before it is loaded at start-up: every listed file is present with its listed size, and
 * every code file (html, js, css, json, wasm) has its listed sha256. Art is size-checked only (it cannot run).
 */
export async function verifyBundleDir(dir: string, files: BundleFile[]): Promise<boolean> {
  for (const f of files) {
    const p = join(dir, ...f.path.split('/'));
    const s = await stat(p).catch(() => null);
    if (!s || !s.isFile() || s.size !== f.size) return false;
    if (CODE.test(f.path) && (await sha256File(p)) !== f.sha256) return false;
  }
  return true;
}
