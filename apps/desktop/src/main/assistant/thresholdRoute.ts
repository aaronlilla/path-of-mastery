// thresholdRoute: the cheapest set of passives that takes a stat over a line the build needs (accuracy above life for Precise
// Technique, an attribute requirement). One node often cannot do it alone (each accuracy notable showed no gain because none
// reaches the line), so the nodes are taken together on a scratch copy, the points are paid for with takeNode's own refund logic
// (payForPath), and the engine measures the result with the threshold met.
import type { BuildEdit } from '@pom/protocol';
import { keyRows, statMap, withScratch, xmlOf, type ToolContext } from './tools.js';
import { guardBreaks, MAX_HITS } from './playerSense.js';
import type { Raw, Threshold } from './thresholds.js';
import { losses, nodeLabel, passiveCost, payForPath, pointBudget, SIDE, type Dropped } from './rankTools.js';

export { ACCURACY_OVER_LIFE, attributeThreshold, type Threshold } from './thresholds.js';

const MAX_POINTS = 24;
const MAX_ROUNDS = 6;

/**
 * null when the line is already met or no set of passives reaches it; else the route with the engine's numbers on the scratch copy.
 * A thin margin gets one more cheap node when that stays inside the cost cap (life and effective HP down at most 5%), costs at most
 * one more point and does not lower damage.
 */
export interface RouteOpts {
  /** Edits the step applies anyway (the plan's fixes): they are on when the nodes are chosen, and not part of the route's own edits. */
  pre?: BuildEdit[];
  /** Cheaper ways to the same line (a gem level): taken before any node, and part of the route's edits. */
  include?: BuildEdit[];
  /** What the include edits are, in words ("Precision level 15 to 20"). */
  includeLabel?: string;
  /** No second search for a safer margin (an anoint route that is only offered never needs one). */
  noCushion?: boolean;
}

export async function thresholdRoute(ctx: ToolContext, buildId: string, t: Threshold, opts: RouteOpts = {}) {
  const a = await route(ctx, buildId, t, false, opts);
  if (!a?.thin || opts.noCushion) return a;
  // one more refund costs about 2% of life: when the route already sits near the 5% cap there is no room, so the second search is skipped
  if (a.changes.some((c) => (c.stat === 'Life' || c.stat === 'TotalEHP') && (c.percent ?? 0) < -2.5)) return a;
  const b = await route(ctx, buildId, t, true, opts);
  const pct = (r: NonNullable<typeof a>, stat: string) => r.changes.find((c) => c.stat === stat)?.percent ?? 0;
  const dps = (r: NonNullable<typeof a>) => pct(r, 'CombinedDPS') + pct(r, 'FullDPS');
  const dear = !!b && ['Life', 'TotalEHP'].some((s) => pct(b, s) < -5);
  return b && !dear && b.pathPoints - a.pathPoints <= 1 && dps(b) >= dps(a) ? b : a;
}

async function route(ctx: ToolContext, buildId: string, t: Threshold, cushion: boolean, opts: RouteOpts) {
  const xml = await xmlOf(ctx, buildId);
  return withScratch(ctx, xml, async (scratch) => {
    const send = ctx.engine.send.bind(ctx.engine);
    const rawOf = async () => (await send('getStats', { buildId: scratch })).stats as Raw;
    const before = await statMap(ctx, scratch);
    for (const e of [...(opts.pre ?? []), ...(opts.include ?? [])]) await send('edit', { buildId: scratch, edit: e });
    if (!opts.include?.length && t.short(await rawOf()) <= 0) return null;
    const { tree } = await send('treeState', { buildId: scratch });
    const all = await ctx.tree.all(tree.treeVersion);
    const start = new Set(tree.allocated);
    let pool = (await ctx.tree.search(tree.treeVersion, t.search, 60)).filter((x) => !start.has(x.id) && (x.type === 'Notable' || x.type === 'Normal') && !x.ascendancy && x.stats.some((s) => t.lines.test(s)));
    const edits: BuildEdit[] = [...(opts.include ?? [])];
    const taken: string[] = [];
    let cushioned = false;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const rawNow = await rawOf();
      const base = t.short(rawNow);
      let need = base;
      // over the line but thinly (a few hundred life from losing it): one more node at one point, when one gives anything
      const thin = cushion && need <= 0 && !cushioned && !!t.cushion && -need < t.cushion(rawNow);
      if (need <= 0 && !thin) break;
      if (thin) { cushioned = true; need = 1; }
      const added = (await send('treeState', { buildId: scratch })).tree.allocated.filter((id) => !start.has(id)).length;
      // each candidate's gain and points from here: edit, read, undo
      const scored: Array<{ id: number; gain: number; points: number }> = [];
      for (const c of pool) {
        const depth = (await send('history', { buildId: scratch })).undo;
        if (!(await send('edit', { buildId: scratch, edit: { kind: 'clickNode', nodeId: c.id } })).blocked) {
          const raw = await rawOf();
          const points = (await send('treeState', { buildId: scratch })).tree.allocated.filter((id) => !start.has(id)).length - added;
          scored.push({ id: c.id, gain: base - t.short(raw), points: Math.max(1, points) });
        }
        for (let h = (await send('history', { buildId: scratch })).undo; h > depth; h--) await send('undo', { buildId: scratch });
      }
      pool = pool.filter((c) => scored.some((s) => s.id === c.id && s.gain > 0));
      const fits = scored.filter((s) => s.gain > 0 && added + s.points <= MAX_POINTS && (!thin || s.points <= 1));
      // one that crosses the line alone wins by its points; else the most accuracy per point
      const crossing = fits.filter((s) => s.gain >= need).sort((a, b) => a.points - b.points || b.gain - a.gain)[0];
      const best = crossing ?? fits.sort((a, b) => b.gain / b.points - a.gain / a.points)[0];
      if (!best) { if (thin) break; return null; }
      const e: BuildEdit = { kind: 'clickNode', nodeId: best.id };
      await send('edit', { buildId: scratch, edit: e });
      edits.push(e);
      taken.push(all.get(best.id)?.name ?? `Node ${best.id}`);
      pool = pool.filter((c) => c.id !== best.id);
    }
    if (t.short(await rawOf()) > 0) return null;
    const mid = (await send('treeState', { buildId: scratch })).tree;
    const path = mid.allocated.filter((id) => !start.has(id));
    const cost = await passiveCost(ctx, tree.treeVersion, path);
    const free = Math.max(0, (await pointBudget(ctx, scratch)).passive.left);
    const short = Math.max(0, cost - free);
    let dropped: Dropped[] = [];
    let alternatives: Awaited<ReturnType<typeof payForPath>>['alternatives'] = [];
    if (short > 0) {
      const paid = await payForPath(ctx, scratch, all, path, short);
      if (paid.dropped.length < short) return null;
      edits.push(...paid.edits);
      dropped = paid.dropped;
      alternatives = paid.alternatives;
    }
    // the drops can take accuracy with them: the line must still be met
    if (t.short(await rawOf()) > 0) return null;
    const after = await statMap(ctx, scratch);
    const end = (await send('treeState', { buildId: scratch })).tree;
    const off = guardBreaks(before, after);
    // "Name (stat; stat)": a small passive is told apart by its stats, never by a bare name
    const label = (id: number) => nodeLabel(all, end, id).replace(/^([^:]+): (.*)$/, '$1 ($2)');
    const nodes = path.map(label);
    const gives = dropped.map((d) => label(d.id));
    const rawEnd = await rawOf();
    const margin = t.margin?.(rawEnd);
    return {
      node: [opts.includeLabel, ...taken].filter(Boolean).join(' + '),
      nodes,
      pathPoints: cost,
      ...(margin ? { margin } : {}),
      thin: !!t.cushion && -t.short(rawEnd) < t.cushion(rawEnd),
      line: `${[opts.includeLabel, nodes.length ? `Take ${nodes.join(' and ')} (${cost} points${gives.length ? `, giving up ${gives.join(' and ')}` : ''})` : ''].filter(Boolean).join(', then ')}`,
      dropped,
      ...(alternatives.length ? { otherSetsToGiveUp: alternatives } : {}),
      changes: keyRows(before, after, SIDE),
      maxHits: keyRows(before, after, MAX_HITS),
      ...(off.length ? { switchedOff: off } : {}),
      bigLoss: losses(before, after, 15).map((id) => `${id} falls more than 15%`),
      edits,
    };
  });
}
