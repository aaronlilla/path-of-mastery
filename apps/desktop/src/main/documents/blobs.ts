import { createHash, randomUUID } from 'node:crypto';
import { open, mkdir, readdir, rename, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseId, type Hash } from '@pom/mastery-contracts';

export type FaultPoint = 'blobWrite' | 'blobFlush' | 'blobRename' | 'beforeIndexCommit' | 'afterIndexCommit' | 'draftWrite';
export type FaultProbe = (point: FaultPoint) => void;
export const hashBytes = (bytes: string | Uint8Array): Hash => parseId('hash', createHash('sha256').update(bytes).digest('hex'));

export async function flushDirectory(path: string): Promise<void> {
  // Windows does not expose directory fsync through Node. Each file is flushed before rename.
  if (process.platform === 'win32') return;
  const directory = await open(path, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

export class BlobStore {
  constructor(readonly root: string, private readonly probe: FaultProbe = () => {}) {}

  async init(): Promise<void> { await mkdir(this.root, { recursive: true }); }

  async put(bytes: string): Promise<Hash> {
    const hash = hashBytes(bytes);
    const path = join(this.root, `${hash}.json`);
    try {
      if (await this.read(hash) !== bytes) throw new Error('Blob hash collision.');
      return hash;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const temp = join(this.root, `${hash}.${randomUUID()}.tmp`);
    const file = await open(temp, 'wx');
    try {
      this.probe('blobWrite');
      await file.writeFile(bytes, 'utf8');
      this.probe('blobFlush');
      await file.sync();
    } finally { await file.close(); }
    this.probe('blobRename');
    await rename(temp, path);
    await flushDirectory(this.root);
    return hash;
  }

  async read(hash: Hash): Promise<string> {
    parseId('hash', hash);
    const bytes = await readFile(join(this.root, `${hash}.json`), 'utf8');
    if (hashBytes(bytes) !== hash) throw new Error('Snapshot hash does not match its content.');
    return bytes;
  }

  async scan(): Promise<{ name: string; hash: Hash | null; complete: boolean; bytes: number }[]> {
    const result = [];
    for (const name of await readdir(this.root)) {
      if (!/^[a-f0-9]{64}(\.json|\.[a-f0-9-]+\.tmp)$/.test(name)) continue;
      const bytes = await readFile(join(this.root, name), 'utf8');
      const expected = parseId('hash', name.slice(0, 64));
      result.push({ name, hash: hashBytes(bytes) === expected ? expected : null, complete: name.endsWith('.json'), bytes: (await stat(join(this.root, name))).size });
    }
    return result;
  }
}
