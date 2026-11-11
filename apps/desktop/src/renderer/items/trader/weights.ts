import { batchSize, type RankBatch } from '../rank.js';
import { weightedRatio, type Candidate, type StatValues, type StatWeight, type Weighted } from './model.js';

export type Rank = (stat: string, batch: RankBatch) => Promise<Array<number | null>>;

export interface Probe {
  text: string;
  /** Where in the build to put it. */
  slots: string[];
  flask?: boolean;
}

/** The test item the weight pass puts a modifier on (`StartQuery`'s "Stat Tester"). */
export function testItemText(base: string, line?: string | string[]): string {
  const lines = line === undefined ? [] : Array.isArray(line) ? line : [line];
  return ['Rarity: RARE', 'Stat Tester', base, ...(lines.length ? ['Implicits: 0', ...lines.map((l) => `{custom}${l}`)] : [])].join('\n');
}

/** The value of each weighted stat for a build with the probe in place (`base` for the build as it is now). */
export async function valuesFor(rank: Rank, weights: StatWeight[], probes: Array<Probe | 'base'>, alive: () => boolean, onStep?: () => void): Promise<StatValues[] | null> {
  const out: StatValues[] = probes.map(() => ({}));
  for (const w of weights) {
    const size = batchSize(w.stat);
    for (let i = 0; i < probes.length; i += size) {
      if (!alive()) return null;
      const chunk = probes.slice(i, i + size);
      const values = await rank(
        w.stat,
        chunk.map((p) => (p === 'base' ? { text: '', slots: [], base: true } : { text: p.text, slots: p.slots, ...(p.flask ? { flask: true } : {}) })),
      );
      if (!alive()) return null;
      chunk.forEach((_, j) => (out[i + j]![w.stat] = values[j] ?? null));
      onStep?.();
    }
  }
  return out;
}

export interface WeightRun {
  list: Weighted[];
  /** How good the current item is, measured the way each tested mod is (half of it is the search's minimum). */
  currentDiff: number;
  tested: number;
}

/**
 * `GenerateModWeights` and the start of `FinishQuery`: each candidate mod is put on a blank item in the slot and the build's stats
 * compared with the same slot's blank item; the larger the gain per point of roll, the more the mod weighs in the search.
 */
export async function generateWeights(o: {
  rank: Rank;
  weights: StatWeight[];
  candidates: Candidate[];
  base: string;
  slot: string;
  flask: boolean;
  /** The mods of the item in the slot now, as one test item. */
  current?: string;
  alive: () => boolean;
  onProgress: (done: number) => void;
}): Promise<WeightRun | null> {
  const where = { slots: [o.slot], ...(o.flask ? { flask: true } : {}) };
  const probes: Array<Probe | 'base'> = ['base', { text: testItemText(o.base), ...where }];
  if (o.current) probes.push({ text: o.current, ...where });
  const head = await valuesFor(o.rank, o.weights, probes, o.alive);
  if (!head) return null;
  const [baseV, blankV, currentV] = head as [StatValues, StatValues, StatValues | undefined];
  const baseStat = weightedRatio(baseV, blankV, o.weights) * 1000;
  const total = o.candidates.length;
  const list: Weighted[] = [];
  const size = 24;
  let done = 0;
  for (let i = 0; i < total; i += size) {
    const chunk = o.candidates.slice(i, i + size);
    const vals = await valuesFor(
      o.rank,
      o.weights,
      chunk.map((c) => ({ text: testItemText(o.base, c.line), ...where })),
      o.alive,
    );
    if (!vals) return null;
    chunk.forEach((c, j) => {
      const diff = weightedRatio(baseV, vals[j]!, o.weights) * 1000 - baseStat;
      if (diff > 0.01) list.push({ tradeModId: c.tradeId, weight: diff / c.value, meanStatDiff: diff, invert: c.invert });
    });
    done += chunk.length;
    o.onProgress(total ? done / total : 1);
  }
  const currentDiff = currentV ? weightedRatio(baseV, currentV, o.weights) * 1000 - baseStat : 0;
  return { list, currentDiff, tested: total };
}

/** The weighted gain of each fetched item over the build as it is (`GetResultEvaluation`). */
export async function evaluateTexts(o: { rank: Rank; weights: StatWeight[]; texts: string[]; slot: string; flask: boolean; alive: () => boolean }): Promise<number[] | null> {
  const where = { slots: [o.slot], ...(o.flask ? { flask: true } : {}) };
  const vals = await valuesFor(o.rank, o.weights, ['base', ...o.texts.map((t) => ({ text: t, ...where }))], o.alive);
  if (!vals) return null;
  const [baseV, ...rest] = vals;
  return rest.map((v) => weightedRatio(baseV!, v, o.weights));
}
