/**
 * Sorting by a stat (`ItemDBControl`'s "Sort by", `getSortValue` in the modifier pickers): each candidate is put in the
 * build by the engine and the stat it gives decides the order. Candidates go to the engine in small batches so the
 * window keeps drawing between them, and a batch that finishes after the picker closed is dropped.
 */

export interface PowerStat {
  stat: string;
  label: string;
  negate: boolean;
  items: boolean;
}

export interface RankCandidate {
  key: string;
  text: string;
  slots: string[];
  flask?: boolean;
  /** The build as it is now: the value gains are measured from. */
  base?: boolean;
}

export type RankBatch = Array<{ text: string; slots: string[]; flask?: boolean; base?: boolean }>;
export type RankRunner = (stat: string, batch: RankBatch) => Promise<Array<number | null>>;

export const BASE_KEY = '__base__';

/** How many candidates go to the engine at once; the FullDPS rows make each one slower. */
export function batchSize(stat: string): number {
  // The engine shares each batch out over its worker threads (crates/napi item_rank), so a batch is a few of its rounds.
  return stat === 'FullDPS' ? 16 : 32;
}

/** The value a candidate ranks by: the stat's value as upstream reads it (`GetFromOutput`), negated for "taken" stats. */
export function rankValue(raw: number | null | undefined, negate: boolean): number {
  if (raw === null || raw === undefined || !Number.isFinite(raw)) return -Infinity;
  return negate ? -raw : raw;
}

/** Candidates a run is ranking right now, per cache: another run for the same build waits for them instead of asking again. */
const RUNNING = new WeakMap<Map<string, number>, Map<string, Promise<void>>>();

/**
 * Runs the candidates through `run` in batches and returns the value of each by key. `onProgress` gets 0 to 1 after every
 * batch; `alive` is asked before each batch and stops the run (the result is then null). Candidates another run is
 * already ranking into the same cache (the background pre-ranking, when the Items tab opens during it) are waited for,
 * not asked again; any that run stops before reaching are ranked here.
 */
export async function rankAll(
  stat: string,
  negate: boolean,
  cands: RankCandidate[],
  run: RankRunner,
  cache: Map<string, number>,
  onProgress: (done: number) => void,
  alive: () => boolean,
  size = batchSize(stat),
): Promise<Map<string, number> | null> {
  let running = RUNNING.get(cache);
  if (!running) RUNNING.set(cache, (running = new Map()));
  const out = new Map<string, number>();
  const report = () => onProgress(cands.length ? out.size / cands.length : 1);
  for (;;) {
    const todo: RankCandidate[] = [];
    const waits: Array<Promise<void>> = [];
    for (const c of cands) {
      if (out.has(c.key)) continue;
      const k = `${stat}|${c.key}`;
      const hit = cache.get(k);
      if (hit !== undefined) out.set(c.key, hit);
      else if (running.has(k))
        waits.push(
          running.get(k)!.then(() => {
            const v = cache.get(k);
            if (v === undefined || !alive()) return;
            out.set(c.key, v);
            report();
          }),
        );
      else todo.push(c);
    }
    report();
    if (!todo.length && !waits.length) return out;
    // Claim this run's candidates, one promise per batch, so a second run can wait for them.
    const batches: Array<{ list: RankCandidate[]; p: Promise<void>; done: () => void }> = [];
    for (let i = 0; i < todo.length; i += size) {
      let done!: () => void;
      const p = new Promise<void>((res) => (done = res));
      const list = todo.slice(i, i + size);
      for (const c of list) running.set(`${stat}|${c.key}`, p);
      batches.push({ list, p, done });
    }
    const release = (b: (typeof batches)[number]) => {
      for (const c of b.list) if (running.get(`${stat}|${c.key}`) === b.p) running.delete(`${stat}|${c.key}`);
      b.done();
    };
    try {
      for (const b of batches) {
        if (!alive()) return null;
        const values = await run(
          stat,
          b.list.map((c) => ({ text: c.text, slots: c.slots, ...(c.flask ? { flask: true } : {}), ...(c.base ? { base: true } : {}) })),
        );
        if (!alive()) return null;
        b.list.forEach((c, j) => {
          const v = rankValue(values[j], negate);
          cache.set(`${stat}|${c.key}`, v);
          out.set(c.key, v);
        });
        release(b);
        report();
      }
    } finally {
      batches.forEach(release);
    }
    await Promise.all(waits);
    if (!alive()) return null;
    // Anything the other run stopped before is picked up on the next pass.
  }
}

/**
 * When to rank a build in the background: `set` is told the build (its id and text, or null when it is closed or has no
 * engine) on every change; each change stops the run in progress (its `alive` turns false) and starts a new one after
 * `quietMs` without changes, so a burst of tree clicks costs one run, not one per click.
 */
export class RankScheduler<T> {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private token = 0;
  private key: T | null = null;

  constructor(
    /** Resolves true when the run was stopped by the app (an edit the build text does not show yet): it is tried again. */
    private readonly start: (key: T, alive: () => boolean) => Promise<boolean>,
    private readonly quietMs: number,
  ) {}

  set(key: T | null): void {
    if (key === this.key && this.timer) return;
    this.key = key;
    this.token++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (key === null) return;
    const mine = this.token;
    this.timer = setTimeout(() => {
      this.timer = null;
      const alive = () => mine === this.token;
      void this.start(key, alive).then(
        (again) => {
          if (again && alive()) this.set(key);
        },
        () => undefined,
      );
    }, this.quietMs);
  }
}

/** Order by value, best first; ties by the name with a leading "The " dropped (upstream's name order). */
export function sortByValue<T>(items: T[], value: (t: T) => number, name: (t: T) => string): T[] {
  const plain = (s: string) => s.replace(/^The /, '');
  return [...items].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    if (va !== vb) return vb > va ? 1 : -1;
    return plain(name(a)).localeCompare(plain(name(b)));
  });
}

/**
 * The stat the unique list is sorted by before the player chooses one: Full DPS with a build open (the design's
 * default and upstream's item list), or the next damage row the build really has (a build with a single skill
 * has no Full DPS row), or the name when no build is open or the build deals no damage.
 */
export function defaultItemSort(hasBuild: boolean, stats: Record<string, unknown>, powerStats: ReadonlyArray<{ stat: string; items: boolean }> | null): string {
  if (!hasBuild) return 'Name';
  return ['FullDPS', 'CombinedDPS', 'TotalDPS'].find((k) => typeof stats[k] === 'number' && (stats[k] as number) > 0 && powerStats?.some((s) => s.stat === k && s.items)) ?? 'Name';
}

/** A gain over the build's current value, as the list rows show it ("+1,234", "-12.5"). */
export function gainText(gain: number): string {
  if (!Number.isFinite(gain)) return '';
  const abs = Math.abs(gain);
  if (abs < 0.005) return '0';
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  let s = abs.toFixed(digits);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  s = s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (gain < 0 ? '-' : '+') + s;
}
