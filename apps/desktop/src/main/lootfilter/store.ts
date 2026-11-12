import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { FilterDoc } from '../../shared/lootfilter/types.js';
import { DEFAULT_SETTINGS, type LootFilterSettings, type LootFilterState } from '../../shared/lootfilter/ipcTypes.js';

/** The player's filters and settings, as one JSON file in userData. Rules live here, not in the generated filter. */

export function newFilterDoc(id: string, name: string, now: number): FilterDoc {
  return {
    id,
    name,
    game: 'poe1',
    setup: { strictness: 2, style: 0, followBuild: true, use: [] },
    rules: [],
    fileName: 'Path of Mastery.filter',
    createdAt: now,
    editedAt: now,
  };
}

export function emptyState(now = Date.now()): LootFilterState {
  const doc = newFilterDoc('f1', 'My filter', now);
  return { version: 1, activeId: doc.id, filters: [doc], settings: { ...DEFAULT_SETTINGS }, ui: {} };
}

function sane(raw: unknown, now: number): LootFilterState {
  const base = emptyState(now);
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Partial<LootFilterState>;
  const filters = Array.isArray(r.filters) ? r.filters.filter((f): f is FilterDoc => !!f && typeof f.id === 'string' && Array.isArray(f.rules) && !!f.setup) : [];
  const settings: LootFilterSettings = { ...DEFAULT_SETTINGS, ...(r.settings ?? {}) };
  if (!filters.length) return { ...base, settings };
  const activeId = filters.some((f) => f.id === r.activeId) ? (r.activeId as string) : filters[0]!.id;
  return { version: 1, activeId, filters, settings, ui: r.ui && typeof r.ui === 'object' ? (r.ui as Record<string, unknown>) : {} };
}

export class LootFilterStore {
  private state: LootFilterState | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private failed: string | null = null;

  constructor(
    readonly file: string,
    private readonly now: () => number = Date.now,
  ) {}

  async load(): Promise<LootFilterState> {
    if (this.state) return this.state;
    let raw: unknown = null;
    try {
      raw = JSON.parse(await readFile(this.file, 'utf8'));
    } catch {
      raw = null;
    }
    this.state = sane(raw, this.now());
    return this.state;
  }

  /** The raw error of the last write when it failed, else null: the state load() returns is then not on disk yet. */
  get saveError(): string | null {
    return this.failed;
  }

  /** Replaces the stored state. Writes are queued so two quick saves cannot interleave. The unsaved state stays in memory
   *  after a failed write (so the edits survive the area closing), but saveError reports it until a write succeeds. */
  async save(next: LootFilterState): Promise<void> {
    this.state = sane(next, this.now());
    const text = JSON.stringify(this.state);
    const run = async (): Promise<void> => {
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      await writeFile(tmp, text, 'utf8');
      await rename(tmp, this.file);
    };
    const done = this.chain.then(run, run);
    this.chain = done;
    try {
      await done;
      this.failed = null;
    } catch (e) {
      this.failed = (e as Error).message;
      throw e;
    }
  }
}
