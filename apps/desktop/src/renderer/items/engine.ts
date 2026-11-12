import type { BuildEdit, CommandName, ItemCatalog, CommandParams, CommandResult, StatDelta } from '@pom/protocol';
import { serial } from '../engineBuild';
import type { PowerStat } from './rank';

/** One engine command from the renderer; a failure throws with the engine's message. */
export async function cmd<K extends CommandName>(command: K, params: CommandParams<K>): Promise<CommandResult<K>> {
  const r = await window.pom.sendCommand(command, params);
  if (!r.ok) throw new Error(r.error.message);
  return r.result;
}

export interface EditResult {
  xml: string;
  changed: StatDelta[];
}

/** Applies an edit to the open build in the engine and returns the build's new text with the stats it changed, in the session's queue with every other change to it. */
export function applyEdit(buildId: string, edit: BuildEdit): Promise<EditResult> {
  return serial(buildId, async () => {
    const r = await cmd('edit', { buildId, edit });
    const { buildXml } = await cmd('getBuildXml', { buildId });
    return { xml: buildXml, changed: r.statDiff.changed };
  });
}

export function stepHistory(buildId: string, back: boolean): Promise<EditResult | null> {
  return serial(buildId, async () => {
    const r = await cmd(back ? 'undo' : 'redo', { buildId });
    if (!r.statDiff) return null;
    const { buildXml } = await cmd('getBuildXml', { buildId });
    return { xml: buildXml, changed: r.statDiff.changed };
  });
}

/** The stats an edit would change, without changing the build; with `full` the FullDPS rows are run too. */
export async function previewEdit(buildId: string, edit: BuildEdit, full = false): Promise<StatDelta[]> {
  const r = await cmd('previewEdit', { buildId, edit, ...(full ? { full: true } : {}) });
  return r.statDiff.changed;
}

/** What `b` changes compared with `a`, both previewed against the open build (the change of one edit over another). */
export async function previewPair(buildId: string, a: BuildEdit, b: BuildEdit, stats: Record<string, number | string | boolean | null>): Promise<StatDelta[]> {
  const [ca, cb] = [await previewEdit(buildId, a, true), await previewEdit(buildId, b, true)];
  return pairDeltas(ca, cb, stats);
}

/** `previewPair`'s comparison: each stat's first row in either preview, else the build's own value. */
export function pairDeltas(ca: StatDelta[], cb: StatDelta[], stats: Record<string, number | string | boolean | null>): StatDelta[] {
  const first = (ds: StatDelta[]) => {
    const m = new Map<string, StatDelta>();
    for (const d of ds) if (!m.has(d.statId)) m.set(d.statId, d);
    return m;
  };
  const [ma, mb] = [first(ca), first(cb)];
  const ids = new Set([...ma.keys(), ...mb.keys()]);
  const out: StatDelta[] = [];
  for (const id of ids) {
    const before = ma.get(id)?.after ?? stats[id] ?? null;
    const after = mb.get(id)?.after ?? stats[id] ?? null;
    if (before !== after) out.push({ statId: id, label: id, before, after });
  }
  return out;
}

let catalogOnce: Promise<ItemCatalog> | null = null;

/** The item lists (bases, uniques, rare templates), read once per app run and kept; a failed read is tried again next time. */
export function loadCatalog(): Promise<ItemCatalog> {
  catalogOnce ??= cmd('itemCatalog', {} as Record<string, never>)
    .then((r) => r.catalog)
    .catch((e) => {
      catalogOnce = null;
      throw e;
    });
  return catalogOnce;
}

let powerStatsOnce: Promise<PowerStat[]> | null = null;

/** The stats lists can be sorted by: the same for every build, so read once like the catalog. */
export function loadPowerStats(): Promise<PowerStat[]> {
  powerStatsOnce ??= cmd('powerStats', {} as Record<string, never>)
    .then((r) => r.stats)
    .catch((e) => {
      powerStatsOnce = null;
      throw e;
    });
  return powerStatsOnce;
}
