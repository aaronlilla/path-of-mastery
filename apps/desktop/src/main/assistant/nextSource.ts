// Where the next accuracy comes from once the build is over the line: the best passive still free and a higher Precision quality,
// each measured by the engine on the build as it ends up, so the answer can say what to take when life grows past the margin.
import type { BuildEdit } from '@pom/protocol';
import type { ToolContext } from './tools.js';
import { readSkills } from './buildReaders.js';
import type { Threshold } from './thresholds.js';

/** One sentence, or null when neither a node nor a gem quality moves the stat. */
export async function nextSource(ctx: ToolContext, scratch: string, t: Threshold): Promise<string | null> {
  const send = ctx.engine.send.bind(ctx.engine);
  const short0 = t.short((await send('getStats', { buildId: scratch })).stats);
  const gainOf = async (edit: BuildEdit) => {
    const depth = (await send('history', { buildId: scratch })).undo;
    let gain = 0;
    if (!(await send('edit', { buildId: scratch, edit })).blocked) gain = short0 - t.short((await send('getStats', { buildId: scratch })).stats);
    for (let h = (await send('history', { buildId: scratch })).undo; h > depth; h--) await send('undo', { buildId: scratch });
    return gain;
  };
  const { tree } = await send('treeState', { buildId: scratch });
  const have = new Set(tree.allocated);
  const found: Array<{ gain: number; text: string }> = [];
  // a passive: gain per point decides, the engine measures each (the path's own nodes count); the first five search hits (notables first) keep the answer's first seconds short
  for (const c of (await ctx.tree.search(tree.treeVersion, t.search, 40)).filter((x) => !have.has(x.id) && (x.type === 'Notable' || x.type === 'Normal') && !x.ascendancy && x.stats.some((s) => t.lines.test(s))).slice(0, 5)) {
    const depth = (await send('history', { buildId: scratch })).undo;
    let gain = 0;
    let points = 1;
    if (!(await send('edit', { buildId: scratch, edit: { kind: 'clickNode', nodeId: c.id } })).blocked) {
      gain = short0 - t.short((await send('getStats', { buildId: scratch })).stats);
      points = Math.max(1, (await send('treeState', { buildId: scratch })).tree.allocated.filter((id) => !have.has(id)).length);
    }
    for (let h = (await send('history', { buildId: scratch })).undo; h > depth; h--) await send('undo', { buildId: scratch });
    // the far notables give the most, but a point is a point: by accuracy per point
    if (gain > 0) found.push({ gain: gain / points, text: `${c.name} (${c.stats.join('; ')}) for ${points} passive point${points === 1 ? '' : 's'}, about +${Math.round(gain)} accuracy` });
  }
  // Precision quality (no point spent): the engine says what it gives
  const xml = (await send('getBuildXml', { buildId: scratch })).buildXml;
  for (const g of readSkills(xml)) {
    for (const x of g.enabled ? g.gems : []) {
      if (!/^Precision$/i.test(x.name) || !x.enabled || (x.quality ?? 0) >= 20) continue;
      const gain = await gainOf({ kind: 'setGem', group: g.index, gem: x.index, attr: 'quality', value: 20 } as BuildEdit);
      if (gain > 0) found.push({ gain: gain * 1000, text: `Precision quality ${x.quality ?? 0} to 20, about +${Math.round(gain)} accuracy with no point spent` });
    }
  }
  const best = found.sort((a, b) => b.gain - a.gain)[0];
  return best ? `When life grows past that, the next source is ${best.text} (an accuracy bench craft fits once an item has an open suffix)` : null;
}
