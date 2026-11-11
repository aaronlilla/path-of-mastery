import { createHash } from 'node:crypto';
import {
  CloudNetworkError,
  type CloudApi,
  type CloudBuildFull,
  type CloudBuildRow,
  type CloudListing,
  type CloudVersionRow,
  type DeleteResult,
  type PushInput,
  type PushResult,
  type SharedRow,
  type ShareInput,
  type ShareRow,
} from '../src/main/accounts/cloudApi.js';
import type { BaseCache, LocalBuildRef, LocalLibrary, StateStore, SyncState } from '../src/main/accounts/syncEngine.js';
import { readBuildInfo } from '../src/shared/buildXml.js';

export const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

export const bxml = (tag = 'one', level = 90, extra = ''): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<PathOfBuilding>\n\t<Build level="${level}" className="Witch" ascendClassName="Elementalist" mainSocketGroup="1"/>\n\t<Tree activeSpec="1">\n\t\t<Spec nodes="1,2,3" classId="3" ascendClassId="2" treeVersion="3_29"/>\n\t</Tree>\n\t<Notes>${tag}</Notes>\n${extra}</PathOfBuilding>\n`;

interface FakeVersion {
  rev: number;
  name: string;
  xml: string;
  deviceId: string;
  deviceName: string;
  note: string;
  at: number;
}
interface FakeBuild {
  row: CloudBuildRow;
  versions: FakeVersion[];
  share: ShareRow | null;
}

/** The cloud as the SQL functions behave, in memory. The real SQL is tested separately (supabase/tests). */
export class FakeCloud implements CloudApi {
  builds = new Map<string, FakeBuild>();
  folders = new Set<string>();
  offline = false;
  calls: string[] = [];
  clock = 1_000_000;
  shares = new Map<string, SharedRow>();

  private gate(name: string): void {
    this.calls.push(name);
    if (this.offline) throw new CloudNetworkError('offline');
  }
  private iso(): string {
    return new Date(this.clock).toISOString();
  }
  tick(ms = 60_000): void {
    this.clock += ms;
  }

  async list(): Promise<CloudListing> {
    this.gate('list');
    return { server_time: this.iso(), builds: [...this.builds.values()].map((b) => ({ ...b.row })), folders: [...this.folders] };
  }
  async get(id: string, rev?: number): Promise<CloudBuildFull | null> {
    this.gate('get');
    const b = this.builds.get(id);
    if (!b) return null;
    const v = rev === undefined ? b.versions[b.versions.length - 1]! : b.versions.find((x) => x.rev === rev);
    if (!v) return null;
    return { id, name: b.row.name, folder: b.row.folder, rev: b.row.rev, sha: sha(v.xml), xml: v.xml, device_name: b.row.device_name, updated_at: b.row.updated_at, deleted_at: b.row.deleted_at };
  }
  async push(i: PushInput): Promise<PushResult> {
    this.gate('push');
    if (!i.xml.includes('<PathOfBuilding')) throw new Error('That is not a build file.');
    const s = sha(i.xml);
    let b = this.builds.get(i.id);
    const info = readBuildInfo(i.xml);
    if (!b) {
      const row: CloudBuildRow = { id: i.id, name: i.name, folder: i.folder, rev: 1, sha: s, class_name: info.className, ascend_class_name: info.ascendClassName, level: info.level, main_skill: '', tree_version: '', size: i.xml.length, device_name: i.deviceName, updated_at: this.iso(), deleted_at: null };
      b = { row, versions: [{ rev: 1, name: i.name, xml: i.xml, deviceId: i.deviceId, deviceName: i.deviceName, note: i.note, at: this.clock }], share: null };
      this.builds.set(i.id, b);
      return { status: 'ok', rev: 1, sha: s, updated_at: row.updated_at };
    }
    const last = b.versions[b.versions.length - 1]!;
    if (sha(last.xml) === s && b.row.name === i.name && b.row.folder === i.folder && !b.row.deleted_at) return { status: 'ok', rev: b.row.rev, sha: s, updated_at: b.row.updated_at };
    if (b.row.rev !== i.baseRev && !i.force) {
      return { status: 'conflict', rev: b.row.rev, sha: sha(last.xml), deleted: !!b.row.deleted_at, name: b.row.name, device_name: b.row.device_name, updated_at: b.row.updated_at };
    }
    const rev = b.row.rev + 1;
    Object.assign(b.row, { name: i.name, folder: i.folder, rev, sha: s, deleted_at: null, device_name: i.deviceName, updated_at: this.iso(), class_name: info.className, ascend_class_name: info.ascendClassName, level: info.level });
    if (sha(last.xml) === s) {
      last.rev = rev;
      last.name = i.name;
    } else if ((i.coalesceMinutes ?? 5) > 0 && last.deviceId === i.deviceId && this.clock - last.at < (i.coalesceMinutes ?? 5) * 60_000 && last.rev > 1) {
      Object.assign(last, { rev, name: i.name, xml: i.xml, note: i.note, deviceName: i.deviceName, at: this.clock });
    } else {
      b.versions.push({ rev, name: i.name, xml: i.xml, deviceId: i.deviceId, deviceName: i.deviceName, note: i.note, at: this.clock });
    }
    return { status: 'ok', rev, sha: s, updated_at: b.row.updated_at };
  }
  async remove(id: string, baseRev: number, force = false): Promise<DeleteResult> {
    this.gate('remove');
    const b = this.builds.get(id);
    if (!b) return { status: 'ok', rev: 0 };
    if (b.row.deleted_at) return { status: 'ok', rev: b.row.rev };
    if (b.row.rev !== baseRev && !force) return { status: 'conflict', rev: b.row.rev, name: b.row.name, device_name: b.row.device_name, updated_at: b.row.updated_at };
    b.row.rev++;
    b.row.deleted_at = this.iso();
    return { status: 'ok', rev: b.row.rev };
  }
  async purge(): Promise<void> {
    this.gate('purge');
  }
  async versions(id: string): Promise<CloudVersionRow[]> {
    this.gate('versions');
    const b = this.builds.get(id);
    if (!b) return [];
    return [...b.versions].reverse().map((v) => ({ rev: v.rev, name: v.name, sha: sha(v.xml), size: v.xml.length, device_id: v.deviceId, device_name: v.deviceName, note: v.note, created_at: new Date(v.at).toISOString(), updated_at: new Date(v.at).toISOString() }));
  }
  async folderPut(path: string): Promise<void> {
    this.gate('folderPut');
    this.folders.add(path);
  }
  async folderDelete(path: string): Promise<void> {
    this.gate('folderDelete');
    this.folders.delete(path);
  }
  async shareUpsert(i: ShareInput): Promise<ShareRow> {
    this.gate('shareUpsert');
    const b = this.builds.get(i.buildId);
    if (!b) throw new Error('That build is not in your cloud library.');
    const token = b.share?.token ?? `tok${this.shares.size}${i.buildId.slice(0, 8)}`.padEnd(16, 'x');
    b.share = { token, access: i.access, include_notes: i.includeNotes, include_loadouts: i.includeLoadouts, allow_duplicate: i.allowDuplicate, updated_at: this.iso() };
    this.shares.set(token, { name: i.name, class_name: i.className, ascend_class_name: i.ascendClassName, level: i.level, main_skill: i.mainSkill, xml: i.xml, include_notes: i.includeNotes, include_loadouts: i.includeLoadouts, allow_duplicate: i.allowDuplicate, updated_at: this.iso() });
    return b.share;
  }
  async shareGet(buildId: string): Promise<ShareRow | null> {
    this.gate('shareGet');
    return this.builds.get(buildId)?.share ?? null;
  }
  async shareRevoke(buildId: string): Promise<void> {
    this.gate('shareRevoke');
    const b = this.builds.get(buildId);
    if (b?.share) {
      this.shares.delete(b.share.token);
      b.share = null;
    }
  }
  async sharedBuild(token: string): Promise<SharedRow | null> {
    this.gate('sharedBuild');
    return this.shares.get(token) ?? null;
  }
}

/** The player's builds folder, in memory. */
export class FakeLib implements LocalLibrary {
  files = new Map<string, { xml: string; mtimeMs: number }>();
  dirs = new Set<string>();
  trash: string[] = [];
  clock = 5_000_000;

  private static idOf(folder: string, name: string): string {
    return (folder ? folder + '/' : '') + name + '.xml';
  }
  private static parts(id: string): { name: string; folder: string } {
    const i = id.lastIndexOf('/');
    return { name: id.slice(i + 1).replace(/\.xml$/, ''), folder: i < 0 ? '' : id.slice(0, i) };
  }
  private touch(id: string, xml: string): void {
    this.files.set(id, { xml, mtimeMs: ++this.clock });
  }
  private unique(folder: string, name: string): string {
    let n = name;
    for (let k = 2; this.files.has(FakeLib.idOf(folder, n)); k++) n = `${name} (${k})`;
    return n;
  }
  add(folder: string, name: string, xml: string): string {
    const id = FakeLib.idOf(folder, name);
    this.touch(id, xml);
    if (folder) this.mkdirs(folder);
    return id;
  }
  edit(id: string, xml: string): void {
    this.touch(id, xml);
  }
  private mkdirs(path: string): void {
    const p = path.split('/');
    for (let i = 1; i <= p.length; i++) this.dirs.add(p.slice(0, i).join('/'));
  }
  async list(): Promise<LocalBuildRef[]> {
    return [...this.files.entries()].map(([id, f]) => ({ id, ...FakeLib.parts(id), mtimeMs: f.mtimeMs, size: f.xml.length }));
  }
  async folders(): Promise<string[]> {
    return [...this.dirs].sort();
  }
  async read(id: string): Promise<string | null> {
    return this.files.get(id)?.xml ?? null;
  }
  async write(id: string, xml: string): Promise<void> {
    if (!this.files.has(id)) throw new Error('gone');
    this.touch(id, xml);
  }
  async create(folder: string, name: string, xml: string): Promise<LocalBuildRef> {
    const n = this.unique(folder, name);
    const id = this.add(folder, n, xml);
    return { id, name: n, folder, mtimeMs: this.files.get(id)!.mtimeMs, size: xml.length };
  }
  async remove(id: string): Promise<void> {
    this.files.delete(id);
    this.trash.push(id);
  }
  async place(id: string, folder: string, name: string): Promise<LocalBuildRef> {
    const f = this.files.get(id);
    if (!f) throw new Error('gone');
    const target = FakeLib.idOf(folder, name);
    if (target === id) return { id, name, folder, mtimeMs: f.mtimeMs, size: f.xml.length };
    const n = this.files.has(target) ? this.unique(folder, name) : name;
    const nid = FakeLib.idOf(folder, n);
    this.files.delete(id);
    this.files.set(nid, f);
    if (folder) this.mkdirs(folder);
    return { id: nid, name: n, folder, mtimeMs: f.mtimeMs, size: f.xml.length };
  }
  async createFolder(path: string): Promise<void> {
    this.mkdirs(path);
  }
  async removeFolderIfEmpty(path: string): Promise<boolean> {
    if ([...this.files.keys()].some((id) => id.startsWith(path + '/'))) return false;
    this.dirs.delete(path);
    return true;
  }
  /** What the player does: rename a file outside the app's hooks. */
  renameQuietly(from: string, folder: string, name: string): string {
    const f = this.files.get(from)!;
    this.files.delete(from);
    const id = FakeLib.idOf(folder, name);
    this.files.set(id, f);
    return id;
  }
}

export class MemState implements StateStore {
  saved = new Map<string, SyncState>();
  async load(userId: string): Promise<SyncState | null> {
    const s = this.saved.get(userId);
    return s ? (JSON.parse(JSON.stringify(s)) as SyncState) : null;
  }
  async save(s: SyncState): Promise<void> {
    this.saved.set(s.userId, JSON.parse(JSON.stringify(s)) as SyncState);
  }
}

export class MemBase implements BaseCache {
  m = new Map<string, string>();
  async get(id: string): Promise<string | null> {
    return this.m.get(id) ?? null;
  }
  async put(id: string, xml: string): Promise<void> {
    this.m.set(id, xml);
  }
  async delete(id: string): Promise<void> {
    this.m.delete(id);
  }
}

/** Timers that only run when the test says so. */
export class ManualTimers {
  queue: { fn: () => void; ms: number; h: number }[] = [];
  private n = 0;
  set = (fn: () => void, ms: number): unknown => {
    const h = ++this.n;
    this.queue.push({ fn, ms, h });
    return h;
  };
  clear = (h: unknown): void => {
    this.queue = this.queue.filter((t) => t.h !== h);
  };
  get delays(): number[] {
    return this.queue.map((t) => t.ms);
  }
}
