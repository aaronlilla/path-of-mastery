// Gems whose attribute requirement a change leaves unmet: a player lowers the gem level to the highest one the new attributes
// support (the belt swap dropped Str below Determination's requirement and the assistant only warned).
// Shared by every change path (trial -> proposeEdit / previewItem, bestUnique ranking), so the numbers it reports include the fix.
import type { CommandResult } from '@pom/protocol';
import { settleAfter, statMap, toBuildEdit, type Scalar, type ToolContext, type ToolEdit } from './tools.js';

const ATTRS = [['Str', 'reqStr'], ['Dex', 'reqDex'], ['Int', 'reqInt']] as const;

/** Lua `getGemStatRequirement` as the engine computes it (crates/calc/src/tools.rs get_gem_stat_requirement). */
const gemAttrReq = (levelReq: number, support: boolean, base: number): number => {
  if (base === 0) return 0;
  const r = Math.floor((20 + (levelReq - 3) * 3) * Math.pow(base / 100, 0.9) * (support ? 0.5 : 0.7) + 0.5);
  return r < 14 ? 0 : r;
};

export interface ShortGem {
  key: string;
  group: number;
  gem: number;
  name: string;
  level: number;
  /** Highest level that fits every attribute, 0 when even level 1 does not. */
  fit: number;
  /** The attribute that is short at the current level (name, needed, have). */
  attr: { name: string; need: number; have: number };
  /** What level 1 needs, for the "still flagged" line. */
  level1Need: number;
}

/** The gem database does not change while the app runs: read once per engine (unmetGems runs once per ranked item). */
const gemCatalogs = new WeakMap<object, Promise<CommandResult<'gemCatalog'>>>();
export const gemCatalog = (ctx: ToolContext) => {
  if (!gemCatalogs.has(ctx.engine)) {
    const p = ctx.engine.send('gemCatalog', {} as Record<string, never>);
    gemCatalogs.set(ctx.engine, p);
    p.catch(() => gemCatalogs.delete(ctx.engine));
  }
  return gemCatalogs.get(ctx.engine)!;
};

const num = (s: Record<string, Scalar>, id: string) => (typeof s[id] === 'number' ? (s[id] as number) : 0);

/** One enabled gem and its Str/Dex/Int requirement at any level. */
export interface GemReq { key: string; group: number; gem: number; name: string; level: number; reqAt: (lv: number) => number[] }

/** The enabled gems of `buildId` with their requirement per level (read once, then checked against any stats). */
export async function gemReqs(ctx: ToolContext, buildId: string): Promise<GemReq[]> {
  const [{ state }, { gems: catalog }] = await Promise.all([ctx.engine.send('skillsState', { buildId }), gemCatalog(ctx)]);
  const byId = new Map(catalog.map((g) => [g.id, g]));
  const out: GemReq[] = [];
  for (const grp of state.groups) {
    if (!grp.enabled || grp.slotInactive || grp.source) continue;
    for (const g of grp.gems) {
      const info = g.enabled && g.known && g.gemId ? byId.get(g.gemId) : undefined;
      if (!info) continue;
      const reqAt = (lv: number) => ATTRS.map(([, k]) => gemAttrReq(info.levelReq[Math.min(lv, info.levelReq.length) - 1] ?? 1, info.support, info[k]));
      out.push({ key: `${grp.index}:${g.index}`, group: grp.index, gem: g.index, name: info.name, level: g.level, reqAt });
    }
  }
  return out;
}

/** The gems of `reqs` whose requirement is above Str, Dex or Int in `stats`, with the level that would fit (no engine call). */
export function shortGems(reqs: GemReq[], stats: Record<string, Scalar>): ShortGem[] {
  const out: ShortGem[] = [];
  for (const g of reqs) {
    const short = (lv: number) => g.reqAt(lv).findIndex((r, i) => r > num(stats, ATTRS[i]![0]));
    const at = short(g.level);
    if (at < 0) continue;
    let fit = g.level - 1;
    while (fit >= 1 && short(fit) >= 0) fit--;
    out.push({ key: g.key, group: g.group, gem: g.gem, name: g.name, level: g.level, fit: Math.max(0, fit), attr: { name: ATTRS[at]![0], need: g.reqAt(g.level)[at]!, have: num(stats, ATTRS[at]![0]) }, level1Need: g.reqAt(1)[at]! });
  }
  return out;
}

/** Enabled gems whose own requirement is above the build's Str, Dex or Int, with the level that would fit. */
export async function unmetGems(ctx: ToolContext, buildId: string): Promise<ShortGem[]> {
  const stats = await statMap(ctx, buildId);
  if (!ATTRS.some(([a]) => num(stats, `Req${a}`) > num(stats, a))) return [];
  return shortGems(await gemReqs(ctx, buildId), stats);
}

export interface GemFit {
  edits: ToolEdit[];
  /** One plain line per change, with what it cost. */
  lines: string[];
  /** Gems that stay unmet even at level 1. */
  unfixed: string[];
  after: Record<string, Scalar>;
}

/**
 * Lowers every gem that is newly unmet on `buildId` (not in `ignore`, the keys that were already unmet before the change) to
 * the highest level its attribute requirement allows. The scratch build is edited; the returned edits repeat that on the real build.
 */
export async function fitGemLevels(ctx: ToolContext, buildId: string, ignore: Set<string> = new Set()): Promise<GemFit> {
  const before = await statMap(ctx, buildId);
  const short = (await unmetGems(ctx, buildId)).filter((g) => !ignore.has(g.key));
  const fixable = short.filter((g) => g.fit > 0);
  const edits: ToolEdit[] = fixable.map((g) => ({ kind: 'setGem', group: g.group, gem: g.gem, attr: 'level', value: g.fit }));
  const unfixed = short.filter((g) => !g.fit).map((g) => `${g.name} needs ${g.level1Need} ${g.attr.name} even at level 1 (you have ${g.attr.have}), so it stays unmet`);
  if (!edits.length) return { edits, lines: [], unfixed, after: before };
  const startedFullDps = num(before, 'FullDPS') > 0;
  let settled: () => Promise<void> = async () => {};
  for (const e of edits) {
    settled = settleAfter(ctx, buildId, startedFullDps);
    await ctx.engine.send('edit', { buildId, edit: toBuildEdit(e) });
  }
  await settled();
  const after = await statMap(ctx, buildId);
  const cost = [['TotalEHP', 'EHP'], [startedFullDps ? 'FullDPS' : 'CombinedDPS', 'DPS']]
    .map(([id, label]) => [Math.round(num(after, id!) - num(before, id!)), label] as const)
    .filter(([d]) => d !== 0)
    .map(([d, label]) => `${d < 0 ? '-' : '+'}${Math.abs(d).toLocaleString('en-US')} ${label}`);
  const what = fixable.map((g) => `${g.name} lowered from ${g.level} to ${g.fit} to fit ${g.attr.have} ${g.attr.name}`).join('; ');
  return { edits, lines: [cost.length ? `${what}: ${cost.join(', ')}` : what], unfixed, after };
}
