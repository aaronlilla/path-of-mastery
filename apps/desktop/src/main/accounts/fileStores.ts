import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BuildStore } from '../library/buildStore.js';
import type { BaseCache, LocalBuildRef, LocalLibrary, StateStore, SyncState } from './syncEngine.js';

async function atomicWrite(path: string, data: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, data, 'utf8');
  await rename(tmp, path);
}

/** One JSON file per account under <userData>/sync. Holds ids and hashes, never a token. */
export class FileStateStore implements StateStore {
  constructor(private readonly dir: string) {}

  private path(userId: string): string {
    return join(this.dir, `state-${userId.replace(/[^A-Za-z0-9-]/g, '')}.json`);
  }

  async load(userId: string): Promise<SyncState | null> {
    try {
      const s = JSON.parse(await readFile(this.path(userId), 'utf8')) as SyncState;
      return s && s.version === 1 && s.userId === userId ? s : null;
    } catch {
      return null;
    }
  }

  async save(s: SyncState): Promise<void> {
    await atomicWrite(this.path(s.userId), JSON.stringify(s));
  }
}

/** The last text that matched the cloud, one file per cloud build. */
export class FileBaseCache implements BaseCache {
  constructor(private readonly dir: string) {}

  private path(id: string): string {
    return join(this.dir, `${id.replace(/[^A-Za-z0-9-]/g, '')}.xml`);
  }
  async get(id: string): Promise<string | null> {
    try {
      return await readFile(this.path(id), 'utf8');
    } catch {
      return null;
    }
  }
  async put(id: string, xml: string): Promise<void> {
    await atomicWrite(this.path(id), xml);
  }
  async delete(id: string): Promise<void> {
    await rm(this.path(id), { force: true });
  }
}

/** The sync's view of the Library: the same BuildStore the Library uses. */
export class StoreLibrary implements LocalLibrary {
  constructor(private readonly store: BuildStore) {}

  async list(): Promise<LocalBuildRef[]> {
    const l = await this.store.list();
    return l.builds.map((b) => ({ id: b.id, name: b.name, folder: b.folder, mtimeMs: b.mtimeMs, size: b.size }));
  }
  async folders(): Promise<string[]> {
    return (await this.store.list()).folders.map((f) => f.path);
  }
  async read(id: string): Promise<string | null> {
    try {
      return (await this.store.read(id)).xml;
    } catch {
      return null;
    }
  }
  async write(id: string, xml: string): Promise<void> {
    await this.store.write(id, xml);
  }
  async create(folder: string, name: string, xml: string): Promise<LocalBuildRef> {
    const e = await this.store.create(folder, name, xml);
    return { id: e.id, name: e.name, folder: e.folder, mtimeMs: e.mtimeMs, size: e.size };
  }
  async remove(id: string): Promise<void> {
    await this.store.remove(id);
  }
  async place(id: string, folder: string, name: string): Promise<LocalBuildRef> {
    let e = await this.store.list().then((l) => l.builds.find((b) => b.id === id));
    if (!e) throw new Error('That build file is gone.');
    if (e.folder !== folder) e = await this.store.move(id, folder, true);
    if (e.name !== name) {
      try {
        e = await this.store.renameBuild(e.id, name);
      } catch {
        /* the name is taken here: keep the numbered one */
      }
    }
    return { id: e.id, name: e.name, folder: e.folder, mtimeMs: e.mtimeMs, size: e.size };
  }
  async createFolder(path: string): Promise<void> {
    const parts = path.split('/').filter(Boolean);
    let parent = '';
    for (const p of parts) {
      try {
        await this.store.createFolder(parent, p);
      } catch {
        /* exists */
      }
      parent = parent ? `${parent}/${p}` : p;
    }
  }
  async removeFolderIfEmpty(path: string): Promise<boolean> {
    if ((await this.store.countIn(path)) > 0) return false;
    try {
      await this.store.removeFolder(path, false);
      return true;
    } catch {
      return false;
    }
  }
}
