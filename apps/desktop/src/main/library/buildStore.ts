import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile, copyFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type { BuildEntry, BuildInfo, FolderEntry, LibraryListing, OpenedBuild, TrashEntry } from '../../shared/library.js';
import { readBuildInfo } from '../../shared/buildXml.js';

export class StoreError extends Error {
  constructor(
    message: string,
    readonly code: 'EEXIST' | 'ENOENT' | 'EINVAL' | 'ENOTEMPTY' | 'EIO',
  ) {
    super(message);
  }
}

const TRASH_DAYS = 30;

/** Makes a safe file or folder name out of whatever the player typed. */
export function sanitizeName(name: string, fallback = 'Unnamed build'): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 120)
    .trim();
  if (!cleaned || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(cleaned)) return cleaned ? `${cleaned} build` : fallback;
  return cleaned;
}

/** True for a name that can safely be a file or folder name here (existing files may be longer than we create). */
export function isSafeName(name: string): boolean {
  // eslint-disable-next-line no-control-regex
  return name.length > 0 && name.length <= 200 && !/[<>:"/\\|?*\u0000-\u001f]/.test(name) && !/^[.\s]|[.\s]$/.test(name);
}

interface InfoCache {
  mtimeMs: number;
  size: number;
  info: BuildInfo;
}

export class BuildStore {
  private readonly infoCache = new Map<string, InfoCache>();

  constructor(
    readonly root: string,
    readonly trashDir: string,
  ) {}

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await mkdir(this.trashDir, { recursive: true });
    await this.purgeExpiredTrash();
  }

  // ---- paths -------------------------------------------------------------------------------

  private folderPath(folder: string): string {
    const parts = folder.split('/').filter((p) => p !== '');
    if (parts.some((p) => !isSafeName(p))) throw new StoreError('That folder name is not allowed.', 'EINVAL');
    const full = resolve(this.root, ...parts);
    if (full !== resolve(this.root) && !full.startsWith(resolve(this.root) + sep)) throw new StoreError('That folder is outside the builds folder.', 'EINVAL');
    return full;
  }

  /** The file a build id names (for showing it in the file manager). */
  pathOf(id: string): string {
    return this.idPath(id);
  }

  private idPath(id: string): string {
    if (!id.toLowerCase().endsWith('.xml')) throw new StoreError('That is not a build file.', 'EINVAL');
    const slash = id.lastIndexOf('/');
    const dir = slash < 0 ? '' : id.slice(0, slash);
    const file = slash < 0 ? id : id.slice(slash + 1);
    if (!file || !isSafeName(file.slice(0, -4))) throw new StoreError('That build name is not allowed.', 'EINVAL');
    return join(this.folderPath(dir), file);
  }

  private static idOf(folder: string, name: string): string {
    return (folder ? folder + '/' : '') + name + '.xml';
  }

  private async exists(p: string): Promise<boolean> {
    try {
      await stat(p);
      return true;
    } catch {
      return false;
    }
  }

  private async uniqueName(folder: string, wanted: string, suffix = ''): Promise<string> {
    const dir = this.folderPath(folder);
    const base = sanitizeName(wanted);
    let candidate = base + suffix;
    for (let n = 2; await this.exists(join(dir, candidate + '.xml')); n++) candidate = `${base}${suffix} (${n})`.slice(0, 120);
    return candidate;
  }

  private async atomicWrite(path: string, data: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await writeFile(tmp, data, 'utf8');
      await rename(tmp, path);
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw new StoreError(`Could not write ${basename(path)}: ${(e as Error).message}`, 'EIO');
    }
  }

  // ---- reading -----------------------------------------------------------------------------

  private async infoOf(path: string, mtimeMs: number, size: number): Promise<BuildInfo> {
    const hit = this.infoCache.get(path);
    if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.info;
    let info: BuildInfo;
    try {
      info = readBuildInfo(await readFile(path, 'utf8'));
    } catch {
      info = { className: '', ascendClassName: '', level: 1, mainSkill: '', treeVersion: '', valid: false };
    }
    this.infoCache.set(path, { mtimeMs, size, info });
    return info;
  }

  async list(): Promise<LibraryListing> {
    const builds: BuildEntry[] = [];
    const folders: FolderEntry[] = [];
    const walk = async (rel: string): Promise<number> => {
      let total = 0;
      let entries;
      try {
        entries = await readdir(this.folderPath(rel), { withFileTypes: true });
      } catch (err) {
        // A sub-folder that vanished mid-walk is skipped; the builds folder itself failing must be reported, not shown as an empty library.
        if (rel === '') throw new StoreError(`The folder cannot be read (${(err as NodeJS.ErrnoException).code ?? 'unknown error'}).`, 'EIO');
        return 0;
      }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        if (e.isDirectory()) {
          const sub = rel ? `${rel}/${e.name}` : e.name;
          if (!isSafeName(e.name)) continue;
          const count = await walk(sub);
          folders.push({ path: sub, name: e.name, count });
          total += count;
        } else if (e.isFile() && e.name.toLowerCase().endsWith('.xml')) {
          const name = e.name.slice(0, -4);
          if (!isSafeName(name)) continue;
          const full = join(this.folderPath(rel), e.name);
          const st = await stat(full);
          const info = await this.infoOf(full, st.mtimeMs, st.size);
          builds.push({ id: BuildStore.idOf(rel, name), name, folder: rel, mtimeMs: st.mtimeMs, size: st.size, info });
          total++;
        }
      }
      return total;
    };
    await walk('');
    folders.sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }));
    const trash = await this.listTrash();
    return { root: this.root, folders, builds, trashCount: trash.length };
  }

  /** The file's identity and write state (file id, size, write and change times): it moves with every write, in place or by rename. */
  async signature(id: string): Promise<string> {
    const st = await stat(this.idPath(id), { bigint: true });
    return `${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
  }

  async read(id: string): Promise<OpenedBuild> {
    const path = this.idPath(id);
    let xml: string;
    try {
      xml = await readFile(path, 'utf8');
    } catch {
      throw new StoreError('That build file is gone.', 'ENOENT');
    }
    const slash = id.lastIndexOf('/');
    return { id, name: basename(path, '.xml'), folder: slash < 0 ? '' : id.slice(0, slash), xml, info: readBuildInfo(xml) };
  }

  // ---- writing -----------------------------------------------------------------------------

  async write(id: string, xml: string): Promise<BuildEntry> {
    const path = this.idPath(id);
    if (!(await this.exists(path))) throw new StoreError('That build file is gone.', 'ENOENT');
    await this.atomicWrite(path, xml);
    return this.entryOf(id);
  }

  async create(folder: string, name: string, xml: string): Promise<BuildEntry> {
    await mkdir(this.folderPath(folder), { recursive: true });
    const unique = await this.uniqueName(folder, name);
    const id = BuildStore.idOf(folder, unique);
    await this.atomicWrite(this.idPath(id), xml);
    return this.entryOf(id);
  }

  private async entryOf(id: string): Promise<BuildEntry> {
    const path = this.idPath(id);
    const st = await stat(path);
    const slash = id.lastIndexOf('/');
    return {
      id,
      name: basename(path, '.xml'),
      folder: slash < 0 ? '' : id.slice(0, slash),
      mtimeMs: st.mtimeMs,
      size: st.size,
      info: await this.infoOf(path, st.mtimeMs, st.size),
    };
  }

  async renameBuild(id: string, newName: string): Promise<BuildEntry> {
    const from = this.idPath(id);
    const slash = id.lastIndexOf('/');
    const folder = slash < 0 ? '' : id.slice(0, slash);
    const name = sanitizeName(newName);
    const newId = BuildStore.idOf(folder, name);
    if (newId === id) return this.entryOf(id);
    const to = this.idPath(newId);
    if (to.toLowerCase() !== from.toLowerCase() && (await this.exists(to))) throw new StoreError(`A build called ${name} is already in ${folder || 'Builds'}.`, 'EEXIST');
    if (!(await this.exists(from))) throw new StoreError('That build file is gone.', 'ENOENT');
    await rename(from, to);
    this.infoCache.delete(from);
    return this.entryOf(newId);
  }

  async duplicate(id: string): Promise<BuildEntry> {
    const from = this.idPath(id);
    const slash = id.lastIndexOf('/');
    const folder = slash < 0 ? '' : id.slice(0, slash);
    const name = await this.uniqueName(folder, basename(from, '.xml'), ' (copy)');
    const newId = BuildStore.idOf(folder, name);
    try {
      await copyFile(from, this.idPath(newId));
    } catch {
      throw new StoreError('That build file is gone.', 'ENOENT');
    }
    return this.entryOf(newId);
  }

  /** Moves a build to another folder. With keepBoth, a name clash gets a numbered name instead of an error. */
  async move(id: string, toFolder: string, keepBoth = false): Promise<BuildEntry> {
    const from = this.idPath(id);
    const name = basename(from, '.xml');
    await mkdir(this.folderPath(toFolder), { recursive: true });
    let finalName = name;
    if (await this.exists(this.idPath(BuildStore.idOf(toFolder, name)))) {
      if (!keepBoth) throw new StoreError(`A build called ${name} is already in ${toFolder || 'Builds'}.`, 'EEXIST');
      finalName = await this.uniqueName(toFolder, name);
    }
    const newId = BuildStore.idOf(toFolder, finalName);
    if (newId === id) return this.entryOf(id);
    if (!(await this.exists(from))) throw new StoreError('That build file is gone.', 'ENOENT');
    await rename(from, this.idPath(newId));
    this.infoCache.delete(from);
    return this.entryOf(newId);
  }

  // ---- folders -----------------------------------------------------------------------------

  async createFolder(parent: string, name: string): Promise<FolderEntry> {
    const clean = sanitizeName(name, '');
    if (!clean) throw new StoreError('Give the folder a name.', 'EINVAL');
    const path = parent ? `${parent}/${clean}` : clean;
    const full = this.folderPath(path);
    if (await this.exists(full)) throw new StoreError(`A folder called ${clean} already exists here.`, 'EEXIST');
    await mkdir(full, { recursive: true });
    return { path, name: clean, count: 0 };
  }

  async renameFolder(path: string, newName: string): Promise<FolderEntry> {
    const clean = sanitizeName(newName, '');
    if (!clean) throw new StoreError('Give the folder a name.', 'EINVAL');
    const slash = path.lastIndexOf('/');
    const parent = slash < 0 ? '' : path.slice(0, slash);
    const newPath = parent ? `${parent}/${clean}` : clean;
    if (newPath === path) return { path, name: clean, count: 0 };
    const to = this.folderPath(newPath);
    if (newPath.toLowerCase() !== path.toLowerCase() && (await this.exists(to))) throw new StoreError(`A folder called ${clean} already exists here.`, 'EEXIST');
    await rename(this.folderPath(path), to);
    this.infoCache.clear();
    return { path: newPath, name: clean, count: 0 };
  }

  /** Builds in a folder and everything under it. */
  async countIn(path: string): Promise<number> {
    const listing = await this.list();
    return listing.builds.filter((b) => b.folder === path || b.folder.startsWith(path + '/')).length;
  }

  /** Deletes a folder. Non-empty folders need force; that removes the builds in them for good. */
  async removeFolder(path: string, force = false): Promise<void> {
    if (!path) throw new StoreError('The builds folder itself cannot be deleted.', 'EINVAL');
    const full = this.folderPath(path);
    if (!force && (await this.countIn(path)) > 0) throw new StoreError('The folder is not empty.', 'ENOTEMPTY');
    await rm(full, { recursive: true, force: true });
    this.infoCache.clear();
  }

  // ---- recently deleted --------------------------------------------------------------------

  /** Moves a build to Recently deleted. The token brings it back. */
  async remove(id: string): Promise<TrashEntry> {
    const path = this.idPath(id);
    const info = await this.entryOf(id).catch(() => {
      throw new StoreError('That build file is gone.', 'ENOENT');
    });
    const token = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
    await mkdir(this.trashDir, { recursive: true });
    const meta = { name: info.name, folder: info.folder, deletedAtMs: Date.now() };
    await writeFile(join(this.trashDir, `${token}.json`), JSON.stringify(meta), 'utf8');
    await rename(path, join(this.trashDir, `${token}.xml`));
    this.infoCache.delete(path);
    return { token, ...meta, info: info.info };
  }

  async listTrash(): Promise<TrashEntry[]> {
    let names: string[];
    try {
      names = await readdir(this.trashDir);
    } catch {
      return [];
    }
    const out: TrashEntry[] = [];
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      const token = n.slice(0, -5);
      try {
        const meta = JSON.parse(await readFile(join(this.trashDir, n), 'utf8')) as { name: string; folder: string; deletedAtMs: number };
        const xml = await readFile(join(this.trashDir, `${token}.xml`), 'utf8');
        out.push({ token, name: meta.name, folder: meta.folder, deletedAtMs: meta.deletedAtMs, info: readBuildInfo(xml) });
      } catch {
        /* a half-written entry: ignore it */
      }
    }
    return out.sort((a, b) => b.deletedAtMs - a.deletedAtMs);
  }

  async restore(token: string): Promise<BuildEntry> {
    if (!/^[a-z0-9-]+$/.test(token)) throw new StoreError('That deleted build is gone.', 'ENOENT');
    const metaPath = join(this.trashDir, `${token}.json`);
    let meta: { name: string; folder: string };
    try {
      meta = JSON.parse(await readFile(metaPath, 'utf8')) as { name: string; folder: string };
    } catch {
      throw new StoreError('That deleted build is gone.', 'ENOENT');
    }
    await mkdir(this.folderPath(meta.folder), { recursive: true });
    const name = await this.uniqueName(meta.folder, meta.name);
    const id = BuildStore.idOf(meta.folder, name);
    await rename(join(this.trashDir, `${token}.xml`), this.idPath(id));
    await rm(metaPath, { force: true });
    return this.entryOf(id);
  }

  async purge(token: string): Promise<void> {
    if (!/^[a-z0-9-]+$/.test(token)) return;
    await rm(join(this.trashDir, `${token}.xml`), { force: true });
    await rm(join(this.trashDir, `${token}.json`), { force: true });
  }

  async purgeExpiredTrash(now = Date.now()): Promise<number> {
    let n = 0;
    for (const t of await this.listTrash()) {
      if (now - t.deletedAtMs > TRASH_DAYS * 86_400_000) {
        await this.purge(t.token);
        n++;
      }
    }
    return n;
  }
}
