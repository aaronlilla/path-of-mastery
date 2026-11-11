import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { constants, createBrotliCompress, createBrotliDecompress } from 'node:zlib';

/**
 * The KB ships as a Brotli-compressed snapshot (resources/kb/kb.sqlite.br, with kb-manifest.json beside it). The app
 * and the dev CLI inflate it to a working copy the first time, and again whenever the shipped snapshot is newer than
 * the working copy's build.
 */

export interface KbManifest {
  builtAt: string;
  livePatch: string;
  dataPatch: string | null;
  bytes: number;
  sources: Array<{ id: string; type: string; status: string; rows: number; patch: string | null; url: string | null }>;
  validation?: unknown;
}

export async function packSnapshot(dbPath: string, brPath: string, manifest: KbManifest): Promise<number> {
  await mkdir(dirname(brPath), { recursive: true });
  const tmp = `${brPath}.tmp`;
  await pipeline(
    createReadStream(dbPath),
    createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: 9, [constants.BROTLI_PARAM_LGWIN]: 24, [constants.BROTLI_PARAM_SIZE_HINT]: manifest.bytes } }),
    createWriteStream(tmp),
  );
  await rename(tmp, brPath);
  await writeFile(manifestPathOf(brPath), JSON.stringify(manifest, null, 2) + '\n');
  return (await stat(brPath)).size;
}

export const manifestPathOf = (brPath: string): string => `${dirname(brPath)}/kb-manifest.json`;

export async function readManifest(brPath: string): Promise<KbManifest | null> {
  try {
    return JSON.parse(await readFile(manifestPathOf(brPath), 'utf8')) as KbManifest;
  } catch {
    return null;
  }
}

/**
 * Make sure `target` exists and is at least as new as the shipped snapshot. `builtAtOf(target)` reads the working
 * copy's build time (meta.built_at); without it the file's mtime is used. Returns what happened.
 */
export async function ensureWorkingCopy(brPath: string, target: string, builtAtOf?: (path: string) => string | null): Promise<'present' | 'inflated' | 'no-snapshot'> {
  const m = await readManifest(brPath);
  let have: string | null = null;
  try {
    const st = await stat(target);
    // default: the file's write time (a build or an inflate writes it after the build it holds)
    have = builtAtOf ? builtAtOf(target) : st.mtime.toISOString();
  } catch {
    have = null;
  }
  if (have && (!m || have >= m.builtAt)) return 'present';
  try {
    await stat(brPath);
  } catch {
    return have ? 'present' : 'no-snapshot';
  }
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.inflate`;
  await rm(tmp, { force: true });
  await pipeline(createReadStream(brPath), createBrotliDecompress(), createWriteStream(tmp));
  await rm(target, { force: true });
  await rename(tmp, target);
  return 'inflated';
}
