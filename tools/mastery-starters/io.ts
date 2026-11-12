import { link, mkdir, open, readFile, realpath, stat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Hash } from '@pom/mastery-contracts';
import { contentHash, canonicalJson } from '../../apps/desktop/src/shared/timelines/adapters/common.js';
import { hashBytes } from './pack.js';
import { requireValue } from './schema.js';
import type { BlobReader, PackPolicy, StarterPack } from './types.js';

export async function readJson(file: string, maxBytes: number): Promise<unknown> {
  const info = await stat(file);
  requireValue(info.isFile() && info.size <= maxBytes, 'The input file exceeds its configured byte limit.', 'LIMIT_EXCEEDED');
  const bytes = await readFile(file);
  requireValue(bytes.byteLength <= maxBytes, 'The input file grew beyond its configured byte limit.', 'LIMIT_EXCEEDED');
  return JSON.parse(bytes.toString('utf8'));
}
export function directoryBlobReader(directory: string, policy: PackPolicy): BlobReader {
  return async (hash: Hash) => {
    const root = await realpath(directory), target = await realpath(join(root, hash));
    const child = relative(root, target);
    requireValue(child === hash && !isAbsolute(child), 'Pinned blobs must stay inside their resource directory.');
    const info = await stat(target);
    requireValue(info.isFile() && info.size <= policy.maxBlobBytes, 'A pinned blob exceeds its configured byte limit.', 'LIMIT_EXCEEDED');
    const bytes = await readFile(target);
    requireValue(bytes.length <= policy.maxBlobBytes, 'A pinned blob grew beyond its configured byte limit.', 'LIMIT_EXCEEDED');
    return bytes;
  };
}
export async function writeImmutable(file: string, bytes: Uint8Array | string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = file + '.' + randomUUID() + '.tmp';
  const handle = await open(temporary, 'wx');
  try {
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    try { await link(temporary, file); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const before = await readFile(file);
      requireValue(hashBytes(before) === hashBytes(bytes), 'An immutable resource already exists with different bytes.', 'HASH_MISMATCH');
    }
  } finally { await unlink(temporary); }
}
export async function writePack(pack: StarterPack, blobs: ReadonlyMap<Hash, Uint8Array>, directory: string) {
  const hash = await contentHash(pack), file = resolve(directory, 'packs', `${hash}.json`);
  for (const digest of pack.blobs) {
    const bytes = blobs.get(digest);
    requireValue(bytes && hashBytes(bytes) === digest, 'A pinned resource is missing or changed.', 'INCOMPLETE');
    await writeImmutable(resolve(directory, 'blobs', digest), bytes);
  }
  await writeImmutable(file, canonicalJson(pack) + '\n');
  return { hash, file };
}
