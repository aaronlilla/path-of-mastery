import { createHash } from 'node:crypto';
import { KbMissing, type KbTable, type KbTableName, type KnowledgeBase } from '../../shared/journey/kb.js';
import { KbQuery, type KbStatus } from './query.js';

/**
 * The KB as the app's main process sees it. Implements the Journey interface (journey DESIGN 0.4) exactly:
 * `table(name)` returns `{patch, livePatch, checkedAt, behind, data}` and throws KbMissing for a table the KB has never
 * had; `onChange` fires per table when a refresh lands. The same object hands the assistant its KbQuery.
 */

// The interface is Journey's own (shared/journey/kb.ts), so Journey switches from its seed with no rework.
export { KbMissing, type KbTable, type KbTableName, type KnowledgeBase } from '../../shared/journey/kb.js';

/** True when `livePatch` is newer than data stamped `patch` ("3.29" covers every 3.29.x; "3.29.3.3" only itself). */
export function isBehind(patch: string, livePatch: string | null): boolean {
  if (!livePatch || !patch) return false;
  return !(livePatch === patch || livePatch.startsWith(`${patch}.`));
}

export interface LiveState {
  livePatch: string | null;
  /** ms since epoch of the last live check (0 = never). */
  checkedAt: number;
  newestThread?: { id: number; title: string } | null;
}

/** The open KB file plus what the last live check saw. `reload()` after a refresh swaps the file in. */
export class KbStore implements KnowledgeBase {
  private q: KbQuery | null = null;
  private listeners = new Set<(name: KbTableName) => void>();
  private statusListeners = new Set<(s: KbStatus) => void>();
  private hashes = new Map<string, string>();
  live: LiveState = { livePatch: null, checkedAt: 0 };

  constructor(readonly path: string) {}

  /** Opens (or reopens) the file; fires onChange for each named table whose contents changed. */
  reload(): void {
    const old = this.q;
    this.q = KbQuery.open(this.path);
    old?.close();
    const fresh = new Map<string, string>();
    for (const n of this.q.tableNames()) {
      const r = this.q.db.get<{ data: string; patch: string }>(`SELECT data, patch FROM kb_table WHERE name = ?`, [n]);
      fresh.set(n, createHash('sha1').update(`${r?.patch}\u0001${r?.data}`).digest('hex'));
    }
    const first = this.hashes.size === 0;
    const changed = [...fresh].filter(([n, h]) => this.hashes.get(n) !== h).map(([n]) => n);
    this.hashes = fresh;
    if (!this.live.livePatch) {
      const lp = this.q.meta('live_patch');
      const at = Date.parse(this.q.meta('live_checked_at') ?? '');
      if (lp) this.live = { livePatch: lp, checkedAt: Number.isFinite(at) ? at : 0 };
    }
    if (!first) for (const n of changed) this.emit(n as KbTableName);
    this.emitStatus();
  }

  get query(): KbQuery {
    if (!this.q) this.reload();
    return this.q!;
  }

  close(): void {
    this.q?.close();
    this.q = null;
  }

  async table<T>(name: KbTableName): Promise<KbTable<T>> {
    const t = this.query.table<T>(name);
    if (!t) throw new KbMissing(name);
    return { patch: t.cite.patch, livePatch: this.live.livePatch, checkedAt: this.live.checkedAt, behind: isBehind(t.cite.patch, this.live.livePatch), data: t.data };
  }

  onChange(cb: (name: KbTableName) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  onStatus(cb: (s: KbStatus) => void): () => void {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  status(): KbStatus {
    return this.query.status({
      livePatch: this.live.livePatch,
      checkedAt: this.live.checkedAt ? new Date(this.live.checkedAt).toISOString() : null,
      newestThread: this.live.newestThread ?? null,
    });
  }

  /** Record a live check (latest.txt and the patch-notes list). */
  setLive(live: LiveState): void {
    this.live = live;
    this.emitStatus();
  }

  private emit(name: KbTableName): void {
    for (const cb of this.listeners) {
      try {
        cb(name);
      } catch {
        /* a listener's error is its own */
      }
    }
  }

  private emitStatus(): void {
    if (!this.statusListeners.size || !this.q) return;
    const s = this.status();
    for (const cb of this.statusListeners) {
      try {
        cb(s);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * `primary` (the KB) first; a table it does not have yet comes from `fallback` (Journey's seed), so a feature never turns
 * off just because a table has not landed in the KB. onChange relays both.
 */
export function withFallback(primary: KnowledgeBase, fallback: KnowledgeBase): KnowledgeBase {
  return {
    async table<T>(name: KbTableName): Promise<KbTable<T>> {
      try {
        return await primary.table<T>(name);
      } catch (e) {
        if (e instanceof KbMissing || (e as Error)?.name === 'KbMissing') return fallback.table<T>(name);
        throw e;
      }
    },
    onChange(cb) {
      const a = primary.onChange(cb);
      const b = fallback.onChange(cb);
      return () => {
        a();
        b();
      };
    },
  };
}
