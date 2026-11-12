import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { EMPTY_SHARED, mergeShared, parseShared, sameShared, type SharedItems } from '../../shared/sharedItems.js';

/** What the sync needs of the local file (sharedItemsIpc.ts). `writeFromSync` tells the window but does not start another push. */
export interface SharedItemsStore {
  read(): Promise<SharedItems>;
  writeFromSync(next: SharedItems): Promise<void>;
}

export interface SharedItemsApi {
  sharedItemsGet(): Promise<{ rev: number; data: unknown; updated_at: string } | null>;
  sharedItemsPut(baseRev: number, data: unknown, device: string): Promise<{ status: 'ok'; rev: number } | { status: 'conflict'; rev: number; data: unknown }>;
}

interface SyncState {
  userId: string;
  /** The cloud revision this PC last agreed with. */
  rev: number;
  /** The list both sides had at that point; the merge needs it to tell a removal from something never copied. */
  base: SharedItems;
}

/**
 * Keeps this PC's shared items and the signed-in player's cloud copy the same: pull on sign-in, when the cloud says something
 * changed, on a timer (so a missed message still lands within the poll time), and push after every local change.
 * One pass at a time. Signed out, nothing runs and the local file is untouched.
 */
export class SharedItemsSync {
  private store: SharedItemsStore | null = null;
  private userId: string | null = null;
  /** Bumped on every sign-in and sign-out; a pass started under an older one stops at its next step. */
  private gen = 0;
  private chain: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly file: string;

  constructor(private readonly d: { api: SharedItemsApi; dataDir: string; deviceId: string; pollMs: number; onError?: (e: unknown) => void }) {
    this.file = join(d.dataDir, 'sharedItems.sync.json');
  }

  attach(store: SharedItemsStore): void {
    this.store = store;
    if (this.userId) this.sync();
  }

  start(userId: string): void {
    this.userId = userId;
    this.gen++;
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.sync(), this.d.pollMs);
    this.timer.unref?.();
    this.sync();
  }

  stop(): void {
    this.userId = null;
    this.gen++;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Runs one pass after the ones already queued. Never throws: a network error is retried by the next trigger. */
  sync(): Promise<void> {
    this.chain = this.chain.then(() => this.pass()).catch((e) => this.d.onError?.(e));
    return this.chain;
  }

  private async load(userId: string): Promise<SyncState> {
    try {
      const s = JSON.parse(await readFile(this.file, 'utf8')) as Partial<SyncState>;
      if (s.userId === userId && typeof s.rev === 'number') return { userId, rev: s.rev, base: parseShared(JSON.stringify(s.base ?? {})) };
    } catch {
      /* first run on this PC */
    }
    return { userId, rev: 0, base: { ...EMPTY_SHARED } };
  }

  private async save(s: SyncState): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(s), 'utf8');
    await rename(tmp, this.file);
  }

  private async pass(): Promise<void> {
    const store = this.store;
    const userId = this.userId;
    if (!store || !userId) return;
    const gen = this.gen;
    const stale = (): boolean => this.gen !== gen;
    let st = await this.load(userId);
    if (stale()) return;
    for (let attempt = 0; attempt < 4; attempt++) {
      const local = await store.read();
      if (stale()) return;
      const remote = await this.d.api.sharedItemsGet();
      if (stale()) return;
      const remoteData = remote ? parseShared(JSON.stringify(remote.data)) : null;
      const target = !remote || !remoteData ? local : remote.rev === st.rev ? local : mergeShared(local, remoteData, st.base);
      if (!sameShared(target, local)) {
        // A change made while we were reading: start again from the newer file.
        const again = await store.read();
        if (stale()) return;
        if (!sameShared(again, local)) continue;
        await store.writeFromSync(target);
        if (stale()) return;
      }
      if (remote && remoteData && sameShared(target, remoteData)) {
        st = { userId, rev: remote.rev, base: target };
        await this.save(st);
        return;
      }
      if (!remote && target.items.length === 0 && target.sets.length === 0) return; // nothing here, nothing there
      const r = await this.d.api.sharedItemsPut(remote?.rev ?? 0, target, this.d.deviceId);
      if (stale()) return;
      if (r.status === 'ok') {
        st = { userId, rev: r.rev, base: target };
        await this.save(st);
        return;
      }
      // Someone wrote in between: go round again against the newer copy.
      st = { ...st };
    }
  }
}
