import type { BuildEdit } from '@pom/protocol';
import { toOut, type Out } from '../../shared/displayStats.js';
import { impactOf, POWER_STATS, type PowerStat, type PowerTask } from '../../shared/comparePower.js';

/** The stat values of an engine reply as the display rows read them. */
export async function fetchOut(engineId: string): Promise<Out | null> {
  const r = await window.pom.sendCommand('getStats', { buildId: engineId });
  if (!r.ok) return null;
  return toOut(Object.fromEntries(r.result.stats.map((s) => [s.id, s.value])));
}

/** The stat a power report measures: Full DPS falls back to Combined DPS when the build has no Full DPS skills, as upstream does. */
export function effectiveStat(stat: PowerStat, a: Out | null): PowerStat {
  if (stat.stat === 'FullDPS' && !(typeof a?.FullDPS === 'number' && a.FullDPS > 0)) return POWER_STATS.find((s) => s.stat === 'CombinedDPS')!;
  return stat;
}

/** Runs the tries through the engine one at a time. `onProgress` gets 0 to 100; returns null when cancelled. A try with
 * alternatives (a jewel in each socket) keeps the best result and says when an alternative won. */
export async function measure(engineId: string, tasks: PowerTask[], stat: PowerStat, isLive: () => boolean, onProgress?: (p: number) => void): Promise<{ v: number | null; note: string }[] | null> {
  const cache = new Map<string, number | null>();
  const out: { v: number | null; note: string }[] = [];
  let last = 0;
  // Progress counts every preview, so a jewel tried in each socket moves the bar as it goes.
  const total = tasks.reduce((n, t) => n + 1 + (t.alternatives?.length ?? 0), 0) || 1;
  let done = 0;
  const tick = () => {
    done++;
    const now = performance.now();
    if (onProgress && now - last > 90) {
      last = now;
      onProgress(Math.min(99, Math.round((done / total) * 100)));
    }
  };
  const one = async (edit: BuildEdit): Promise<number | null> => {
    const r = await window.pom.sendCommand('previewEdit', { buildId: engineId, edit, ...(stat.stat === 'FullDPS' ? { full: true } : {}) });
    tick();
    return r.ok && !r.result.blocked ? impactOf(stat, r.result.statDiff.changed) : null;
  };
  for (let i = 0; i < tasks.length; i++) {
    if (!isLive()) return null;
    const t = tasks[i]!;
    let v: number | null;
    let note = '';
    if (t.cacheKey && cache.has(t.cacheKey)) v = cache.get(t.cacheKey)!;
    else {
      v = await one(t.edit);
      for (const alt of t.alternatives ?? []) {
        if (!isLive()) return null;
        const w = await one(alt);
        if (w !== null && (v === null || w > v)) {
          v = w;
          note = t.bestNote ?? '';
        }
      }
      if (t.cacheKey) cache.set(t.cacheKey, v);
    }
    out.push({ v, note });
  }
  return out;
}

