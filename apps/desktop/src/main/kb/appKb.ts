import { join } from 'node:path';
import { KbStore } from './knowledgeBase.js';
import { ensureWorkingCopy } from './snapshot.js';

/**
 * The app's knowledge base: the shipped snapshot (resources/kb/kb.sqlite.br) inflated into user data on first use,
 * then opened. `ready()` is shared: the first caller pays the inflate, everyone else gets the open store.
 */
export class AppKb {
  private opening: Promise<KbStore> | null = null;
  store: KbStore | null = null;
  readonly path: string;
  readonly snapshot: string;

  constructor(readonly opts: { resourcesDir: string; userDataDir: string; log?: (m: string) => void }) {
    this.path = join(opts.userDataDir, 'kb', 'kb.sqlite');
    this.snapshot = join(opts.resourcesDir, 'kb', 'kb.sqlite.br');
  }

  ready(): Promise<KbStore> {
    this.opening ??= (async () => {
      const r = await ensureWorkingCopy(this.snapshot, this.path, (p) => {
        // the working copy's own build time, so a refreshed copy is never replaced by an older shipped snapshot
        const s = new KbStore(p);
        try {
          s.reload();
          return s.query.meta('built_at');
        } catch {
          return null;
        } finally {
          s.close();
        }
      });
      if (r === 'no-snapshot') throw new Error('no knowledge base snapshot was shipped');
      if (r === 'inflated') this.opts.log?.(`kb: inflated ${this.snapshot}`);
      const store = new KbStore(this.path);
      store.reload();
      this.store = store;
      return store;
    })();
    this.opening.catch(() => {
      this.opening = null;
    });
    return this.opening;
  }

  close(): void {
    this.store?.close();
  }
}
