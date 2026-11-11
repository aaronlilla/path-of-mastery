// "Best X" tools: the engine ranks every option and the tool returns its pick with ready edits, so the model never
// compares a shortlist it made itself (a model that tested six belts itself picked the wrong one).
import type { BuildEdit, CommandResult, NodePower, TreeState } from '@pom/protocol';
import { z } from 'zod';
import { heldFirst, keyRows, need, refusal, TOOLS, settleAfter, statMap, ToolError, turnAsk, uniqueText, withScratch, xmlOf, type Scalar, type ToolContext, type ToolDef, type ToolEdit } from './tools.js';
import { gemCatalog, gemReqs, shortGems, type ShortGem } from './gemFit.js';
import { applyEdits, fixOldShortfalls, fixRequirements, flasksOnEdit, guardBreaks, itemSwapLoss, MAX_HITS, pointsOffer, recoveryOf, recoveryRows, RECOVERY, sideEffects, statWarnings, type ReqWay } from './playerSense.js';
import { GemColours } from './treeData.js';
import { buffWorth, COLOUR, GEM_BUFFS, resistCraft, resistMoves, slotGems, slotItemText, socketFit } from './itemFit.js';
import { readBuildMeta, readConfig, readEquipped, readSkills, type ItemRead } from './buildReaders.js';
import { auditBuild, fatalForRanking, mainCount, withScaledCount } from './audit.js';
import { estimateLevel } from '../../renderer/buildSkills.js';
import { formatStat, statMeta } from '../../shared/assistant/statLabels.js';
import { passiveMax } from '../../shared/pointsReadout.js';

const statLabel = (id: string) => statMeta(id).label;
const pctNum = (b: Record<string, Scalar>, a: Record<string, Scalar>, id: string) => (num(b, id) ? ((num(a, id) - num(b, id)) / Math.abs(num(b, id))) * 100 : 0);
const pct = (from: number, to: number) => (from ? `${to >= from ? '+' : '-'}${Math.abs(Math.round(((to - from) / Math.abs(from)) * 1000) / 10)}%` : '');

/**
 * Uniques a player asks about by name for a slot ("why not Mageblood?"): always calculated and named in the comparison.
 * shortcut: a hand list of the well-known ones per catalog group; replace with trade popularity when the app has it.
 */
const FAMOUS: Record<string, string[]> = {
  belt: ['Mageblood', 'Headhunter', 'Darkness Enthroned', 'Stranglegasp'],
  helmet: ["Devoto's Devotion", 'Crown of the Inward Eye', "Starkonja's Head", 'The Devouring Diadem', 'Eye of Malice'],
  body: ["Shavronne's Wrappings", "Kaom's Heart", 'Loreweave', 'Cloak of Defiance', 'The Brass Dome'],
  gloves: ['Tombfist', "Shaper's Touch", 'Command of the Pit', 'Thunderfist'],
  boots: ["Atziri's Step", "Kaom's Roots", 'Seven-League Step', "Ralakesh's Impatience"],
  amulet: ['Badge of the Brotherhood', 'Ashes of the Stars', 'Impresence', "Aul's Uprising"],
  ring: ["Kalandra's Touch", 'Circle of Guilt', "Ventor's Gamble", 'Mark of the Elder', 'Mark of the Shaper'],
};

/** The item text's lines for its selected variant, without the {tags}. */
export function itemLines(text: string, variantNo = 0): string[] {
  const sel = Number(/Selected Variant: (\d+)/.exec(text)?.[1] ?? variantNo);
  return text.split(/\r?\n/).filter((line) => {
    const v = /\{variant:([\d,]+)\}/.exec(line);
    return !(v && sel && !v[1]!.split(',').map(Number).includes(sel));
  }).map((line) => line.replace(/\{[^}]*\}/g, '').trim());
}

/** The roll the numbers use: each range at its middle (the default for a unique from the database), as the engine rounds it. */
export function rollUsed(text: string, variant: string | null, variantNo = 0): string {
  const rolls: string[] = [];
  for (const clean of itemLines(text, variantNo)) {
    if (!/\(-?[\d.]+-[\d.]+\)/.test(clean)) continue;
    const mid = clean.replace(/\((-?[\d.]+)-([\d.]+)\)/g, (_, a: string, b: string) => {
      const [lo, hi] = [Number(a), Number(b)];
      const dec = /\./.test(a + b) ? 1 : 0;
      return String(dec ? Math.round((lo + (hi - lo) / 2) * 10) / 10 : Math.floor(lo + (hi - lo) / 2 + 0.5));
    });
    rolls.push(`${clean} -> ${mid}`);
  }
  return `Middle of each range${variant ? `, ${variant} variant` : ''} (the item database default); your own copy may roll higher or lower${rolls.length ? `: ${rolls.join('; ')}` : ''}`;
}

/** The item and gem databases do not change while the app runs: read once per engine. */
const catalogs = new WeakMap<object, Promise<CommandResult<'itemCatalog'>>>();
const itemCatalog = (ctx: ToolContext) => {
  if (!catalogs.has(ctx.engine)) {
    const p = ctx.engine.send('itemCatalog', {} as Record<string, never>);
    catalogs.set(ctx.engine, p);
    p.catch(() => catalogs.delete(ctx.engine));
  }
  return catalogs.get(ctx.engine)!;
};
/** Reads the item and gem databases before the player asks (the first one took about 1 s inside bestUnique). */
export const warmCatalogs = (ctx: ToolContext) => {
  itemCatalog(ctx).catch(() => undefined);
  gemCatalog(ctx).catch(() => undefined);
};

export const SIDE = ['FullDPS', 'CombinedDPS', 'TotalEHP', 'Life', 'EnergyShield', 'Mana'];
const num = (s: Record<string, Scalar>, id: string) => (typeof s[id] === 'number' ? (s[id] as number) : 0);
const dpsStat = (s: Record<string, Scalar>) => (num(s, 'FullDPS') > 0 ? 'FullDPS' : 'CombinedDPS');

/** Catalog unique groups per item slot. Weapons need `type`: a bow build must not be handed a sword. */
const SLOT_GROUPS: Array<[RegExp, string[]]> = [
  [/^Helmet$/, ['helmet']],
  [/^Body Armour$/, ['body']],
  [/^Gloves$/, ['gloves']],
  [/^Boots$/, ['boots']],
  [/^Belt$/, ['belt']],
  [/^Amulet$/, ['amulet']],
  [/^Ring \d$/, ['ring']],
  [/^Flask \d$/, ['flask']],
];

/** Node Power for one stat on `buildId`: unallocated nodes (gain of the whole path) and allocated ones (change when removed). */
export async function nodePower(ctx: ToolContext, buildId: string, stat: string, maxDepth: number): Promise<Map<number, NodePower>> {
  await ctx.engine.send('nodePowerStart', { buildId, maxDepth, stat });
  const nodes = new Map<number, NodePower>();
  const deadline = Date.now() + 90_000;
  for (let done = false; !done && Date.now() < deadline; ) {
    const step = await ctx.engine.send('nodePowerStep', { buildId, budgetMs: 400 });
    for (const n of step.nodes) nodes.set(n.id, n);
    done = step.done || !step.active;
  }
  return nodes;
}

/** Ascendancy nodes use their own points, not the passive budget. */
export const isAscendancy = (n: { type?: string; ascendancy?: unknown; ascendancyStart?: unknown } | undefined) =>
  !!n && (!!n.ascendancy || !!n.ascendancyStart || n.type === 'AscendClassStart');

/** The edit that takes a ranked node: its best effect for a mastery, else a click (which allocates the path). */
export const takeEdit = (n: NodePower): BuildEdit => {
  const best = n.effects?.length ? n.effects.reduce((a, e) => ((e.pathPower ?? -Infinity) > (a.pathPower ?? -Infinity) ? e : a)) : null;
  return best ? { kind: 'pickMastery', nodeId: n.id, effectId: best.e } : { kind: 'clickNode', nodeId: n.id };
};

/** The mastery effect to take: the asked one, else the one the engine finds best. */
export async function masteryEffectId(ctx: ToolContext, scratch: string, nodeId: number, effects: Array<{ id: number }>, asked?: number): Promise<number> {
  if (asked !== undefined && effects.some((e) => e.id === asked)) return asked;
  const before = await statMap(ctx, scratch);
  const dps = dpsStat(before);
  const rel = (id: string, after: Record<string, Scalar>) => (num(before, id) ? (num(after, id) - num(before, id)) / num(before, id) : 0);
  let best = effects[0]!.id, top = -Infinity;
  for (const e of effects) {
    const r = await ctx.engine.send('previewEdit', { buildId: scratch, edit: { kind: 'pickMastery', nodeId, effectId: e.id }, full: true }).catch(() => null);
    if (!r || r.blocked) continue;
    const after = { ...before };
    for (const c of r.statDiff.changed) if (c.after === null || typeof c.after !== 'object') after[c.statId] = c.after as Scalar;
    const score = rel(dps, after) + rel('TotalEHP', after);
    if (score > top) { top = score; best = e.id; }
  }
  return best;
}

/** Passive points a set of added nodes costs (class and ascendancy starts are free, ascendancy nodes use their own points). */
export async function passiveCost(ctx: ToolContext, version: string, ids: number[]): Promise<number> {
  const all = await ctx.tree.all(version);
  return ids.filter((id) => {
    const n = all.get(id);
    return !(n && (n.type === 'ClassStart' || n.type === 'AscendClassStart' || n.ascendancyStart || n.ascendancy));
  }).length;
}

/** The main minion's total DPS from the engine's Minion stat block, or 0. */
const minionDps = (stats: Array<{ id: string; value: unknown }>): number => {
  const m = stats.find((x) => x.id === 'Minion')?.value;
  const v = m && typeof m === 'object' ? (m as Record<string, unknown>).TotalDPS : 0;
  return typeof v === 'number' ? v : 0;
};

/** Attribute points missing (Req above the character's own), the check behind the sidebar's "You do not meet the Strength requirement". */
const REQS: Array<[string, string]> = [['ReqStr', 'Str'], ['ReqDex', 'Dex'], ['ReqInt', 'Int'], ['ReqOmni', 'Omni']];
const shortBy = (s: Record<string, Scalar>) => REQS.map(([req, have]) => Math.max(0, num(s, req) - num(s, have)));

/** A single-goal ask ("most EHP") keeps the other side's loss at or under this percent; the unconstrained best is offered beside it. */
const TRADE = 15;

/** A key stat that fell by more than `pct` percent. */
export const losses = (before: Record<string, Scalar>, after: Record<string, Scalar>, pct: number) =>
  ['FullDPS', 'CombinedDPS', 'TotalEHP'].filter((id) => num(before, id) > 0 && (num(before, id) - num(after, id)) / num(before, id) > pct / 100);

/** poe.ninja prices from the Wealth price book ("40c", "3.1 div"), by name; empty without a price book or when it takes over 5 s. */
export async function priceOf(ctx: ToolContext, names: string[], level?: (name: string) => number | undefined): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!ctx.prices || !names.length) return out;
  // poe.ninja names a support gem "<name> Support" (Awakened Empower had no price)
  const support = names.map((n) => (/ Support$/.test(n) ? n : `${n} Support`));
  const r = await Promise.race([ctx.prices.lookup([...names, ...support]), new Promise<null>((res) => setTimeout(() => res(null), 5000))]).catch(() => null);
  const div = r?.chaosPerDivine || 0;
  names.forEach((n, i) => {
    const lines = [...(r?.lines[i] ?? []), ...(r?.lines[names.length + i] ?? [])];
    // a gem has a line per variant ("4", "3/20", "5c" corrupted): the uncorrupted one at its level, else its lowest level
    const gems = lines.filter((l) => /Gem$/.test(l.type) && /^\d+$/.test(l.variant ?? '')).sort((a, b) => Number(a.variant) - Number(b.variant));
    const l = gems.length ? gems.find((g) => Number(g.variant) === level?.(n)) ?? gems[0] : lines[0];
    if (l) out.set(n, `${div > 0 && l.chaos >= div ? `${Math.round((l.chaos / div) * 10) / 10} div` : `${Math.round(l.chaos)}c`} (poe.ninja${gems.length ? `, level ${l.variant}` : ''})`);
  });
  return out;
}

type TreeNodes =Awaited<ReturnType<ToolContext['tree']['all']>>;
type TreeNow = Pick<TreeState, 'generated' | 'masteries'>;

/**
 * A passive as a player reads it: notables and keystones by name, small passives with their stat line, a mastery
 * with the effect taken, a cluster-jewel passive (not in the tree file) by its name and stat line from the engine's tree state.
 */
export function nodeLabel(all: TreeNodes, tree: TreeNow, id: number): string {
  const n = all.get(id);
  if (!n) {
    const g = tree.generated?.find((x) => x.id === id);
    if (!g) return `Node ${id}`;
    return /notable|keystone/i.test(g.kind ?? '') || !g.stats.length ? g.name : `${g.name}: ${g.stats.join('; ')}`;
  }
  if (n.type === 'Mastery') {
    const e = n.effects?.find((x) => x.id === tree.masteries?.find(([m]) => m === id)?.[1]);
    return e ? `${n.name}: ${e.stats.join('; ')}` : n.name;
  }
  // a keystone's downside is part of what was taken (Arrow Dancing's less evasion never said)
  return (n.type === 'Normal' || n.type === 'Keystone') && n.stats.length ? `${n.name}: ${n.stats.join('; ')}` : n.name;
}

/** Life and energy shield recovered per second (regen, leech, recharge while it applies). */
const recoveryTotal = (s: Record<string, Scalar>) => RECOVERY.filter(([id]) => !id.startsWith('Mana')).reduce((a, [id]) => a + Math.max(0, recoveryOf(s, id)), 0);

export interface EndNodeCost { warnings: string[]; core: boolean }

/**
 * The allocated end nodes of `scratch` (removing one takes nothing else) outside `keep`, cheapest first. Cost is the engine's loss
 * in percent of damage (the minion's on a minion build), effective HP, life and ES recovery per second and unreserved mana, and a
 * warning the removal would raise counts as a heavy penalty (refunding Eldritch Battery and Reservation Mastery
 * broke mana, then two auras went off). Keystones and masteries go last: the build is built around them. Run it in the tree that
 * already has a new path, so the node it hangs on is not one.
 */
export async function cheapestEndNodes(ctx: ToolContext, scratch: string, all: TreeNodes, keep: number[]): Promise<Array<[number, Record<string, number>, EndNodeCost]>> {
  // a node a timeless jewel changed is never refunded: the jewel's version (Supreme Ostentation in the Agnostic slot) is what the build runs on
  // the engine lists them under `changed` (reading `generated` matched nothing, and Slum Lord, Divine Judgement conquered, was refunded)
  const conquered = new Set((await ctx.engine.send('treeState', { buildId: scratch })).tree.changed.filter((g) => g.conquered && g.conqueredBy === 'timeless').map((g) => g.id));
  const leaves = [...(await nodePower(ctx, scratch, 'TotalEHP', 1)).values()].filter((p) => {
    const node = all.get(p.id);
    return p.allocated && !conquered.has(p.id) && p.dist === 1 && !keep.includes(p.id) && node && !(node.type === 'ClassStart' || node.type === 'AscendClassStart' || node.ascendancy || node.ascendancyStart);
  });
  // Damage is the player's, or the minion's for a minion build (Node Power has no minion stat), so each removal is calculated.
  const withPath = await statMap(ctx, scratch);
  const [{ stats: rawNow }, skill] = await Promise.all([ctx.engine.send('getStats', { buildId: scratch }), ctx.engine.send('mainSkill', { buildId: scratch })]);
  const base = Object.fromEntries(rawNow.map((s) => [s.id, s.value])) as Record<string, unknown>;
  const warnBase = new Set(statWarnings(base, skill));
  const minionNow = minionDps(rawNow);
  const dps = num(withPath, dpsStat(withPath)) > 0 ? dpsStat(withPath) : minionNow > 0 ? 'MinionDPS' : null;
  const pct = (now: number, then: number) => (now > 0 ? Math.round(((now - then) / now) * 10000) / 100 : 0);
  const out: Array<[number, Record<string, number>, EndNodeCost]> = [];
  for (const p of leaves) {
    let after: Record<string, unknown>;
    if (dps === 'MinionDPS') {
      // previewEdit leaves the Minion block out of its diff: edit, read, undo.
      const depth = (await ctx.engine.send('history', { buildId: scratch })).undo;
      if ((await ctx.engine.send('edit', { buildId: scratch, edit: { kind: 'clickNode', nodeId: p.id } })).blocked) continue;
      after = Object.fromEntries((await ctx.engine.send('getStats', { buildId: scratch })).stats.map((s) => [s.id, s.value]));
      for (let h = (await ctx.engine.send('history', { buildId: scratch })).undo; h > depth; h--) await ctx.engine.send('undo', { buildId: scratch });
    } else {
      const pr = await ctx.engine.send('previewEdit', { buildId: scratch, edit: { kind: 'clickNode', nodeId: p.id }, full: true }).catch(() => null);
      if (!pr || pr.blocked) continue;
      after = { ...base };
      for (const c of pr.statDiff.changed) after[c.statId] = c.after;
    }
    const a = after as Record<string, Scalar>;
    const row: Record<string, number> = { TotalEHP: pct(num(withPath, 'TotalEHP'), num(a, 'TotalEHP')) };
    if (dps === 'MinionDPS') row.MinionDPS = pct(minionNow, minionDps(Object.entries(after).map(([id, value]) => ({ id, value }))));
    else if (dps) row[dps] = pct(num(withPath, dps), num(a, dps));
    const rec = pct(recoveryTotal(withPath), recoveryTotal(a));
    if (rec) row.Recovery = rec;
    const mana = Math.round(((num(withPath, 'ManaUnreserved') - num(a, 'ManaUnreserved')) / Math.max(1, num(withPath, 'Mana'))) * 10000) / 100;
    if (mana) row.UnreservedMana = mana;
    const type = all.get(p.id)?.type ?? 'Normal';
    out.push([p.id, row, { warnings: statWarnings(after, skill).filter((w) => !warnBase.has(w)), core: type === 'Keystone' || type === 'Mastery' }]);
  }
  // Ties (nothing measured moves) go to plain small nodes before notables, masteries and keystones.
  const typeRank = (id: number) => ({ Normal: 0, Notable: 1, Mastery: 2, Keystone: 3 })[all.get(id)?.type ?? 'Normal'] ?? 1;
  // A player drops dead-end small passives before notables (four notables went while smalls were the
  // usual first refund), so smalls rank first unless one raises a warning, among nodes that cost about the same (2% bands): a small
  // worth 5% of the damage is not given up before a notable worth nothing (Attack Speed and Poison Duration went
  // before Wisdom of the Glade, and the Str swap cost 9.7% Full DPS).
  const band = (x: (typeof out)[number]) => Math.floor(endScore(x) / 2);
  return out.sort((x, y) => Number(x[2].warnings.length > 0) - Number(y[2].warnings.length > 0) || Number(x[2].core) - Number(y[2].core) || band(x) - band(y) || Number(typeRank(x[0]) > 0) - Number(typeRank(y[0]) > 0) || endScore(x) - endScore(y) || typeRank(x[0]) - typeRank(y[0]));
}

export interface Dropped { id: number; name: string; kind: string; gave: string; lossPercent: Record<string, number>; newWarnings?: string[] }

/**
 * Gives up `short` allocated end nodes in `scratch` (which already holds the new `path`) to pay for it: greedy, cheapest first; a
 * drop that raises a warning together with the earlier ones is put back and the next one is tried (never fix a warning this
 * change made by turning off auras afterwards). Returns the clicks that give them up, and 1-2 other sets the player could give up.
 */
export async function payForPath(ctx: ToolContext, scratch: string, all: TreeNodes, path: number[], short: number): Promise<{ edits: BuildEdit[]; dropped: Dropped[]; alternatives: Array<{ givesUp: string[]; lossPercent: Record<string, number>; line: string }> }> {
  // a cluster jewel node is in no tree file: it is named by its stat, never its id
  const now = (await ctx.engine.send('treeState', { buildId: scratch })).tree;
  const name = (id: number) => all.get(id)?.name ?? nodeLabel(all, now, id);
  const edits: BuildEdit[] = [];
  const dropped: Dropped[] = [];
  const ranked = await cheapestEndNodes(ctx, scratch, all, path);
  const skill = await ctx.engine.send('mainSkill', { buildId: scratch });
  const warnings = async () => statWarnings(Object.fromEntries((await ctx.engine.send('getStats', { buildId: scratch })).stats.map((s) => [s.id, s.value])), skill);
  const base = new Set(await warnings());
  for (const [i, c] of ranked.entries()) {
    if (dropped.length === short) break;
    const depth = (await ctx.engine.send('history', { buildId: scratch })).undo;
    const e: BuildEdit = { kind: 'clickNode', nodeId: c[0] };
    if ((await ctx.engine.send('edit', { buildId: scratch, edit: e })).blocked) continue;
    const fresh = (await warnings()).filter((w) => !base.has(w));
    if (fresh.length && ranked.length - i - 1 >= short - dropped.length) {
      for (let h = (await ctx.engine.send('history', { buildId: scratch })).undo; h > depth; h--) await ctx.engine.send('undo', { buildId: scratch });
      continue;
    }
    edits.push(e);
    dropped.push({ id: c[0], name: name(c[0]), kind: all.get(c[0])?.type === 'Normal' ? 'small passive' : (all.get(c[0])?.type ?? 'passive').toLowerCase(), gave: ((id) => { const n = all.get(id); return n?.type === 'Notable' && n.stats.length ? `${n.name}: ${n.stats.join('; ')}` : nodeLabel(all, now, id); })(c[0]), lossPercent: c[1], ...(fresh.length ? { newWarnings: fresh } : {}) });
  }
  // 1-2 other sets the player could give up instead, priced by each node's own loss
  const rest = ranked.filter((c) => !dropped.some((d) => d.id === c[0]));
  const sum = (cs: Array<[number, Record<string, number>, EndNodeCost]>) => cs.reduce<Record<string, number>>((acc, c) => { for (const [k, v] of Object.entries(c[1])) acc[k] = Math.round(((acc[k] ?? 0) + v) * 100) / 100; return acc; }, {});
  const pick = (ids: number[]) => ranked.filter((c) => ids.includes(c[0]));
  const sets = [rest[0] ? [...dropped.slice(0, -1).map((d) => d.id), rest[0][0]] : null, short > 1 && rest.length >= short ? rest.slice(0, short).map((c) => c[0]) : null].filter((x): x is number[] => !!x);
  const taken = sum(pick(dropped.map((d) => d.id)));
  return { edits, dropped, alternatives: sets
    .map((ids) => ({ givesUp: ids.map(name), lossPercent: sum(pick(ids)), line: otherSetLine(ids.map(name), sum(pick(ids)), taken) }))
    // a set that costs at least as much of every stat as the one taken is no alternative
    .filter((a) => ![...new Set([...Object.keys(a.lossPercent), ...Object.keys(taken)])].every((k) => (a.lossPercent[k] ?? 0) >= (taken[k] ?? 0))) };
}

/**
 * Energy shield that can no longer refill (Ghost Reaver with no leech): the nearest "Regenerate X% of Energy Shield per second"
 * mastery by its shortest path, paid for like takeNode (one ES recovery fix as a card). Edits `scratch`, which holds the change.
 */
async function esRegenFix(ctx: ToolContext, scratch: string, all: TreeNodes): Promise<{ edits: BuildEdit[]; line: string } | null> {
  const start = new Set((await ctx.engine.send('treeState', { buildId: scratch })).tree.allocated);
  const depth = (await ctx.engine.send('history', { buildId: scratch })).undo;
  const back = async () => { for (let h = (await ctx.engine.send('history', { buildId: scratch })).undo; h > depth; h--) await ctx.engine.send('undo', { buildId: scratch }); };
  let best: { edit: BuildEdit; path: number[] } | null = null;
  for (const n of all.values()) {
    const e = n.type === 'Mastery' && !start.has(n.id) ? n.effects?.find((x) => x.stats.some((l) => /^Regenerate \d+% of Energy Shield per second$/.test(l))) : undefined;
    if (!e) continue;
    const edit: BuildEdit = { kind: 'pickMastery', nodeId: n.id, effectId: e.id };
    if (!(await ctx.engine.send('edit', { buildId: scratch, edit })).blocked) {
      const path = (await ctx.engine.send('treeState', { buildId: scratch })).tree.allocated.filter((id) => !start.has(id));
      if (!best || path.length < best.path.length) best = { edit, path };
    }
    await back();
  }
  if (!best) return null;
  const s0 = await statMap(ctx, scratch);
  const m0 = minionDps((await ctx.engine.send('getStats', { buildId: scratch })).stats);
  const short = best.path.length - Math.max(0, (await pointBudget(ctx, scratch)).passive.left);
  await ctx.engine.send('edit', { buildId: scratch, edit: best.edit });
  const paid = short > 0 ? await payForPath(ctx, scratch, all, best.path, short) : { edits: [], dropped: [] as Dropped[] };
  if (paid.dropped.length < short) return null;
  const s1 = await statMap(ctx, scratch);
  const m1 = minionDps((await ctx.engine.send('getStats', { buildId: scratch })).stats);
  const node = all.get((best.edit as { nodeId: number }).nodeId)!;
  const costs = [...(m0 > 0 && m1 < m0 ? [`minion damage ${Math.round((m1 / m0 - 1) * 1000) / 10}%`] : []), ...['TotalEHP', dpsStat(s0)].filter((k) => num(s0, k) > 0 && num(s1, k) < num(s0, k) * 0.995).map((k) => `${statMeta(k).label} ${Math.round((num(s1, k) / num(s0, k) - 1) * 1000) / 10}%`)];
  return {
    edits: [best.edit, ...paid.edits],
    line: `${node.name} (${node.effects!.find((x) => x.id === (best!.edit as { effectId: number }).effectId)!.stats.join('; ')}) by its ${best.path.length}-point path: Energy shield regeneration ${formatStat('EnergyShieldRegenRecovery', recoveryOf(s0, 'EnergyShieldRegenRecovery'))}/s -> ${formatStat('EnergyShieldRegenRecovery', recoveryOf(s1, 'EnergyShieldRegenRecovery'))}/s${paid.dropped.length ? `; gives up ${paid.dropped.map((d) => d.name).join(', ')}` : ''}${costs.length ? ` (${costs.join(', ')})` : ''}`,
  };
}

/**
 * A passive-points ask the app answered itself (the model's spendPoints then proposeEdit put the picks on screen at
 * 25.6 s): the app runs spendPoints and applies the picks live once the build facts are in, and the model's own spendPoints call
 * gets that result instead of spending again. Keyed by build; cleared at each new turn.
 */
const autoSpend = new Map<string, Promise<Record<string, unknown> | null>>();
let appSpendCall = false;
export const setAutoSpend = (buildKey: string, result: Promise<Record<string, unknown> | null>): void => { autoSpend.set(buildKey, result); };
export const clearAutoSpend = (): void => autoSpend.clear();
/** A spendPoints run for `stat` that never reuses the result the app made earlier in the turn (it may be for another stat, and already applied). */
export const spendFresh = (ctx: ToolContext, stat: string) => (markAppSpendCall(), RANK_TOOLS.find((t) => t.name === 'spendPoints')!.run({ stat }, ctx));
/** The next spendPoints call is the app's own (it must not wait for the result it is about to make). */
export const markAppSpendCall = (): void => { appSpendCall = true; };

/**
 * The cheapest fix for the elemental resists under their caps in the open build, after the points went in (a bench craft that takes
 * no other resist under its cap, else passive points, never refunding `keep`, the picks just taken: a card once gave back the
 * Life node the EHP ask had bought), made into a one-tap card. Null when every resist is capped or nothing fits.
 */
/** The line the panel shows the moment the app's own spend is in: the points, the picks and the asked stat before and after. '' when the result has none. */
export function spendShown(r: Record<string, unknown>): { line: string; data: { points: number; nodes: string; before: string; after: string }; panel: (ref: string) => string } | null {
  const row = r.stat as { label?: string; beforeShown?: string; afterShown?: string } | undefined;
  // every node that went in, path nodes too ("Bloodless" only, the 6% life node on its path was left out)
  const nodes = Array.isArray(r.allocates) ? (r.allocates as unknown[]).filter((x): x is string => typeof x === 'string' && !!x) : [];
  const points = Number(r.pointsUsed);
  if (!row?.label || !row.beforeShown || !row.afterShown || !nodes.length || !(points > 0)) return null;
  const word = points === 1 ? 'point' : 'points';
  // two nodes with the same stat line read as one name with its count, as the card shows them ("Life: 6% increased maximum Life ×2")
  const counts = new Map<string, number>();
  for (const n of nodes) counts.set(n, (counts.get(n) ?? 0) + 1);
  const data = { points, nodes: [...counts].map(([n, k]) => (k > 1 ? `${n} ×${k}` : n)).join('; '), before: row.beforeShown, after: row.afterShown };
  return {
    line: `Spent ${points} passive ${word} on ${row.label}: ${data.nodes}. ${row.label} ${data.before} -> ${data.after}.`,
    data,
    // the panel draws a number the model could have typed as a dash: every number is read from a stored result ("Spent – passive points")
    panel: (ref) => `Spent {{${ref}:points}} passive ${word} on ${row.label}: {{${ref}:nodes}}. ${row.label} {{${ref}:before}} -> {{${ref}:after}}.`,
  };
}

export async function resistCapCard(ctx: ToolContext, keep: number[]): Promise<{ edits: BuildEdit[]; line: string; short?: string } | null> {
  const { buildId } = need(ctx);
  const xml = await xmlOf(ctx, buildId);
  const now = await statMap(ctx, buildId);
  const short = ['Fire', 'Cold', 'Lightning'].filter((e) => num(now, `${e}Resist`) < (num(now, `${e}ResistMax`) || 75));
  if (!short.length) return null;
  const fix: { edits: BuildEdit[]; line: string; short?: string } | null = await withScratch(ctx, xml, async (s) => {
    const bench = await resistCraft(ctx, s, xml, now).catch(() => null);
    if (bench) return { line: bench.line, edits: [bench.edit] as BuildEdit[] };
    return resistPointsFix(ctx, s, await ctx.tree.all((await ctx.engine.send('treeState', { buildId: s })).tree.treeVersion), now, keep).catch(() => null);
  }).catch(() => null);
  const propose = TOOLS.find((t) => t.name === 'proposeEdit');
  if (fix && propose) await Promise.resolve(propose.run({ title: `Cap ${short.map((e) => e.toLowerCase()).join(' and ')} resistance`, edits: fix.edits, offer: true, summary: (fix.short ?? fix.line).slice(0, 300) }, ctx)).catch(() => null);
  return fix;
}

/**
 * Passive points toward the resist furthest under its cap, for when no bench craft gets there without taking another resist under
 * its own (cold 33% under on an EHP ask, no card): Node Power's best picks per point for that resist, up to 8 points,
 * each paid for by the cheapest end nodes like takeNode. Edits `scratch`, which holds the change.
 */
async function resistPointsFix(ctx: ToolContext, scratch: string, all: TreeNodes, after: Record<string, Scalar>, keep: number[] = []): Promise<{ edits: BuildEdit[]; line: string; short: string } | null> {
  const capOf = (e: string) => num(after, `${e}ResistMax`) || 75;
  const gap = (e: string) => capOf(e) - num(after, `${e}Resist`);
  const el = ['Fire', 'Cold', 'Lightning'].filter((e) => gap(e) > 0).sort((a, c) => gap(c) - gap(a))[0];
  if (!el) return null;
  const id = `${el}Resist`;
  const edits: BuildEdit[] = [];
  const dropped: Dropped[] = [];
  const names: string[] = [];
  let points = 0;
  let now = after;
  while (num(now, id) < capOf(el) && points < 8) {
    const room = 8 - points;
    const cand = [...(await nodePower(ctx, scratch, id, room)).values()]
      .filter((n) => !n.allocated && n.pathPower !== null && n.pathPower > 0 && n.dist > 0 && n.dist <= room && !isAscendancy(all.get(n.id)))
      .sort((x, y) => y.pathPower! / y.dist - x.pathPower! / x.dist || y.pathPower! - x.pathPower!)[0];
    if (!cand) break;
    const start = new Set((await ctx.engine.send('treeState', { buildId: scratch })).tree.allocated);
    const edit = takeEdit(cand);
    if ((await ctx.engine.send('edit', { buildId: scratch, edit })).blocked) break;
    const tree = (await ctx.engine.send('treeState', { buildId: scratch })).tree;
    const path = tree.allocated.filter((n) => !start.has(n));
    const owed = path.length - Math.max(0, (await pointBudget(ctx, scratch)).passive.left);
    const paid = owed > 0 ? await payForPath(ctx, scratch, all, [...path, ...keep], owed) : { edits: [], dropped: [] as Dropped[] };
    if (paid.dropped.length < owed) break;
    edits.push(edit, ...paid.edits);
    dropped.push(...paid.dropped);
    // every node on the path, with its stats: the resist can sit on the way to the ranked node, or come from a timeless jewel
    // (la-deadeye: Dire Torment's +20% cold resistance is the Brutal Restraint's)
    const changed = new Map(tree.changed.map((g) => [g.id, g]));
    names.push(...path.map((n) => (changed.has(n) ? `${changed.get(n)!.name}: ${changed.get(n)!.stats.filter((l) => l.trim()).join('; ')}` : nodeLabel(all, tree, n))));
    points += path.length;
    now = await statMap(ctx, scratch);
  }
  if (!edits.length) return null;
  const costs = ['TotalEHP', dpsStat(after)].filter((k) => num(after, k) > 0 && num(now, k) < num(after, k) * 0.995).map((k) => `${statMeta(k).label} ${Math.round((num(now, k) / num(after, k) - 1) * 1000) / 10}%`);
  return {
    edits,
    // the card summary takes 300 characters: the resist and max hit first, the nodes in the card's own rows
    short: `${resistMoves([el], after, now, capOf).join(', ')}${num(now, id) < capOf(el) ? `, still ${capOf(el) - num(now, id)}% under` : ''}, for ${points} passive ${points === 1 ? 'point' : 'points'}${dropped.length ? ` (gives up ${dropped.length} end ${dropped.length === 1 ? 'node' : 'nodes'})` : ''}`,
    line: `${names.join(', ')} (${points} passive ${points === 1 ? 'point' : 'points'}): ${resistMoves([el], after, now, capOf).join(', ')}${num(now, id) < capOf(el) ? `, still ${capOf(el) - num(now, id)}% under` : ''}${dropped.length ? `; gives up ${dropped.map((d) => d.name).join(', ')}` : ''}${costs.length ? ` (${costs.join(', ')})` : ''}`,
  };
}

const lossWord = (id: string) => (id === 'MinionDPS' ? 'minion damage' : id === 'TotalEHP' ? 'effective HP' : /DPS$/.test(id) ? 'damage' : statMeta(id).label);
const lossText = (loss: Record<string, number>) => Object.entries(loss).filter(([, v]) => v > 0).map(([k, v]) => `${lossWord(k)} down ${v}%`).join(', ') || 'no loss the engine counts';

/** Another set the player could give up, labelled by what it costs against the set taken ("Cheaper alternatives" that cost more). */
export function otherSetLine(givesUp: string[], loss: Record<string, number>, taken: Record<string, number>): string {
  const total = (l: Record<string, number>) => Object.values(l).reduce((a, v) => a + Math.max(0, v), 0);
  const d = total(loss) - total(taken);
  const names = givesUp.length > 1 ? `${givesUp.slice(0, -1).join(', ')} and ${givesUp.at(-1)}` : givesUp.join('');
  const vs = Math.abs(d) < 0.01 ? 'the same cost as the set taken' : `costs ${d > 0 ? 'more' : 'less'} than the set taken (${lossText(taken)})`;
  return `Give up ${names} instead: ${lossText(loss)}, ${vs}`;
}

/** The most gems linked together in an item's sockets ("R-G-B-B-G-R" is 6); a group in no item counts 6, the most an item links. */
export const linkCount = (sockets?: string): number => (sockets ? Math.max(...sockets.split(/\s+/).map((s) => s.split('-').length)) : 6);

/** One end node's cost: its losses in percent plus 100 per warning it raises. */
// a minion build's damage is the minion's: it weighs 3x (Righteous Army, -1.85% minion / -7.67% recovery, goes before Redemption, -4.77% minion)
export const endScore = (x: [number, Record<string, number>, EndNodeCost]) => Object.entries(x[1]).reduce((a, [k, v]) => a + (k === 'MinionDPS' ? 3 : 1) * Math.max(0, v), 0) + 100 * x[2].warnings.length;

export interface Budget {
  passive: { used: number; available: number; left: number; leftAt100: number };
  ascendancy: { used: number; available: number; left: number };
  level: number;
  levelNeeded: number;
  warnings: string[];
}

/** Passive and ascendancy points used and available, as the Tree tab counts them. */
export async function pointBudget(ctx: ToolContext, buildId: string): Promise<Budget> {
  const [{ tree }, xml, stats] = await Promise.all([ctx.engine.send('treeState', { buildId }), xmlOf(ctx, buildId), statMap(ctx, buildId)]);
  const meta = readBuildMeta(xml);
  const all = await ctx.tree.all(tree.treeVersion || meta.treeVersion);
  let used = 0;
  let asc = 0;
  for (const id of tree.allocated) {
    const n = all.get(id);
    if (n && (n.type === 'ClassStart' || n.type === 'AscendClassStart' || n.ascendancyStart)) continue;
    if (n?.ascendancy) {
      if (!n.multipleChoiceOption) asc++;
    } else used++; // cluster jewel nodes are not in the tree file and cost a point each
  }
  const extra = typeof stats.ExtraPoints === 'number' ? stats.ExtraPoints : 0;
  // points the character has at its level (a level 97 has 2 to spend, not the 5 a level 100 would); an auto level follows the points spent, so the level 100 total
  const auto = /<Build[^>]*characterLevelAutoMode="true"/.test(xml);
  const available = passiveMax(extra, auto ? null : meta.level || 100);
  const warnings: string[] = [];
  if (used > 99 + 23 + extra) warnings.push('You have too many passive points allocated');
  if (asc > 8) warnings.push('You have too many ascendancy points allocated');
  return {
    passive: { used, available, left: available - used, leftAt100: passiveMax(extra, null) - used },
    ascendancy: { used: asc, available: 8, left: 8 - asc },
    level: meta.level,
    levelNeeded: estimateLevel(used, extra).level,
    warnings,
  };
}

const round = (v: number) => Math.round(v * 10) / 10;

/**
 * One line per check a player makes after an item change, engine numbers on a copy of `xml` with `edits`:
 * attributes against the highest requirement, resistances with the config's custom lines off (typed in, not
 * worn), and for a build that burns its own life (Righteous Fire) life regen minus the burn.
 */
async function afterChecks(ctx: ToolContext, xml: string, edits: ToolEdit[], before: Record<string, Scalar>, fullDps: boolean): Promise<string[]> {
  return withScratch(ctx, xml, async (copy) => {
    const { state } = await ctx.engine.send('configState', { buildId: copy });
    const custom = state.customMods.some((m) => m.enabled && m.lineOk.some(Boolean));
    const off: ToolEdit = { kind: 'setCustomMods', blocks: state.customMods.map((m) => ({ title: m.title, enabled: false, text: m.text })) };
    const RES = ['Fire', 'Cold', 'Lightning', 'Chaos'];
    const realBefore = custom ? await withScratch(ctx, xml, async (c) => { await applyEdits(ctx, c, [off], fullDps); return statMap(ctx, c); }) : null;
    await applyEdits(ctx, copy, edits, fullDps);
    const after = await statMap(ctx, copy);
    const out = [`Attributes after: ${REQS.slice(0, 3).map(([q, h]) => `${h} ${num(after, h)} (highest requirement ${num(after, q)}${num(after, q) > num(after, h) ? `, ${num(after, q) - num(after, h)} short` : ''})`).join(', ')}`];
    if (realBefore) {
      await applyEdits(ctx, copy, [off], fullDps);
      const real = await statMap(ctx, copy);
      out.push(`Resistances without the custom config lines: ${RES.map((e) => `${e.toLowerCase()} ${num(real, `${e}Resist`)}% (was ${num(realBefore, `${e}Resist`)}%)`).join(', ')}`);
    }
    if (num(after, 'TotalBuildDegen') > 0) out.push(`Life regen ${round(num(after, 'LifeRegenRecovery')).toLocaleString('en-US')}/s minus your own burn ${round(num(after, 'TotalBuildDegen')).toLocaleString('en-US')}/s: net life regen ${round(num(after, 'NetLifeRegen')).toLocaleString('en-US')}/s (was ${round(num(before, 'NetLifeRegen')).toLocaleString('en-US')}/s)`);
    return out;
  }).catch(() => []);
}

/** `text` with a Sockets line linking the slot's gems in their colours (str red, dex green, int blue): a unique from the database has none. */
function withSockets(text: string, colours: string[]): string {
  if (!colours.length) return text;
  const line = `Sockets: ${colours.join('-')}`;
  if (/^Sockets: .*$/m.test(text)) return text.replace(/^Sockets: .*$/m, line);
  const lines = text.split('\n');
  const at = lines.findIndex((l) => /^Implicits:/.test(l));
  lines.splice(at >= 0 ? at : Math.min(3, lines.length), 0, line);
  return lines.join('\n');
}

/**
 * What the current item in `slot` gains at no cost to the other side (no helmet keeps the damage within
 * TRADE, so Woe Corona stays): quality 20 on an armour piece, and the best defensive bench craft (in the free craft slot, or in
 * place of its own crafted mod on the same side). Every option is calculated by the engine on `xml`; the edits are empty when nothing gains.
 */
async function freeGains(ctx: ToolContext, xml: string, slot: string, cur: ItemRead, stat: string, before: Record<string, Scalar>, other: string[]): Promise<{ line: string; edits: ToolEdit[] }> {
  const kept = `Kept your ${cur.name}`;
  const lines = cur.text.split(/\r?\n/).map((l) => l.trim()); // the build file indents the first line
  const text = lines.join('\n');
  if (!/^Rarity: (RARE|MAGIC|NORMAL)$/im.test(text)) return { line: `${kept}; it takes no bench craft`, edits: [] };
  const q = Number(/^Quality: (\d+)/m.exec(text)?.[1] ?? 0);
  // shortcut: an item without a Quality line gets none added; add one if such items show up
  const quality = /^(Helmet|Gloves|Boots|Body Armour|Weapon 2)$/.test(slot) && q < 20 ? (t: string) => t.replace(/^Quality: \d+/m, 'Quality: 20') : null;
  const pool = await ctx.engine.send('modPool', { base: cur.base, itemLevel: Number(/^Item Level: (\d+)/m.exec(text)?.[1] ?? 84) }).then((r) => r.pool).catch(() => null);
  const maxRoll = (t: string) => t.replace(/\((-?[\d.]+)-([\d.]+)\)/g, (_, _a: string, b: string) => b);
  const bench = (side: 'prefix' | 'suffix') => (pool ? (side === 'prefix' ? pool.prefixes : pool.suffixes) : []).filter((m) => m.source === 'bench' && m.stats.length && m.stats.every((x) => /Resistance|maximum Life|maximum Energy Shield|Armour|Evasion/.test(x.text)));
  const best = (side: 'prefix' | 'suffix') => [...new Map(bench(side).sort((x, y) => y.tier - x.tier).map((m) => [m.group, m])).values()];
  // the crafted mod the item has, and its side, matched against the bench templates
  const craftedAt = lines.findIndex((l) => /^\{crafted\}/.test(l));
  const crafted = craftedAt >= 0 ? lines[craftedAt]!.replace(/^\{crafted\}/, '') : null;
  const template = (t: string) => new RegExp(`^${t.split(/\(-?[\d.]+-[\d.]+\)/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('-?[\\d.]+')}$`);
  const sideOf = (l: string) => (['prefix', 'suffix'] as const).find((sd) => (pool ? (sd === 'prefix' ? pool.prefixes : pool.suffixes) : []).some((m) => m.source === 'bench' && m.stats.some((x) => template(x.text).test(l))));
  const craftSide = crafted ? sideOf(crafted) : undefined;
  type Opt = { text: string; what: string[] };
  const opts: Opt[] = [];
  // a craft on the other side than the item's own crafted mod needs an open affix there: said in its line, not checked
  for (const m of [...best('prefix'), ...best('suffix')]) {
    const add = m.stats.map((x) => `{crafted}${maxRoll(x.text)}`);
    if (crafted && add.length === 1 && add[0] === `{crafted}${crafted}`) continue; // the item already has this craft
    const withCraft = crafted ? [...lines.slice(0, craftedAt), ...add, ...lines.slice(craftedAt + 1)].join('\n') : [...lines, ...add].join('\n');
    const side = pool?.prefixes.includes(m) ? 'prefix' : 'suffix';
    const what = `bench craft ${add.map((a) => a.replace('{crafted}', '')).join(', ')}${crafted ? ` in place of its crafted ${crafted}` : ''}${!crafted || side !== craftSide ? ` (needs an open ${side})` : ''}`;
    opts.push({ text: withCraft, what: [what] });
    if (quality) opts.push({ text: quality(withCraft), what:['quality 20 (Armourer\'s Scraps)', what] });
  }
  if (quality) opts.push({ text: quality(text), what: ['quality 20 (Armourer\'s Scraps)'] });
  if (!opts.length) return { line: `${kept}; nothing on it gains ${statMeta(stat).label} for free`, edits: [] };
  const { results } = await withScratch(ctx, xml, (s) => ctx.engine.send('previewEdits', { buildId: s, edits: opts.map((o) => ({ kind: 'setItem', slot, itemText: o.text })), full: true }));
  const scored = opts.flatMap((o, i) => {
    const r = results[i];
    if (!r || 'error' in r || r.blocked) return [];
    const after = { ...before };
    for (const c of r.statDiff.changed) if (c.after === null || typeof c.after !== 'object') after[c.statId] = c.after as Scalar;
    // no cost to the other side, and no attribute it gave lost
    if (other.some((id) => num(after, id) < num(before, id) - Math.abs(num(before, id)) * 0.0005) || shortBy(after).some((n, k) => n > shortBy(before)[k]!)) return [];
    // a build that burns its own life (Righteous Fire) keeps its life regen above the burn
    if (num(before, 'TotalBuildDegen') > 0 && num(after, 'NetLifeRegen') < Math.min(0, num(before, 'NetLifeRegen'))) return [];
    return num(after, stat) > num(before, stat) ? [{ o, after }] : [];
  }).sort((x, y) => num(y.after, stat) - num(x.after, stat));
  const top = scored[0];
  if (!top) return { line: `${kept}; nothing on it (quality or a bench craft) gains ${statMeta(stat).label} without a cost`, edits: [] };
  const change = [stat, ...other].map((id) => `${statMeta(id).label} ${pct(num(before, id), num(top.after, id)) || '+0%'}`).join(', ');
  return { line: `${kept} and gave it ${top.o.what.join(' and ')}: ${change}`, edits: [{ kind: 'setItem', slot, itemText: top.o.text }] };
}

export const RANK_TOOLS: ToolDef[] = [
  {
    name: 'bestUnique',
    chip: 'Rank uniques',
    description:
      'The best unique for one item slot, ranked by the calculation engine: every unique of that slot\'s type in the item database, each of its variants, is put in the slot on a scratch copy and ranked by one stat. Returns the top ones with the stat and the side effects on damage, effective HP and life, and edits that equip the winner (pass them to proposeEdit unchanged). Use this for any "best unique for X" request instead of picking candidates yourself. Nothing is changed.',
    shape: {
      slot: z.string().min(1).max(40).describe('Slot name: "Helmet", "Body Armour", "Gloves", "Boots", "Belt", "Amulet", "Ring 1", "Flask 1", "Weapon 1"...'),
      stat: z.string().max(40).optional().describe('Stat id to maximise, for example "FullDPS", "CombinedDPS", "TotalEHP", "Life". Default: FullDPS, or CombinedDPS when the build has no FullDPS.'),
      type: z.string().max(20).optional().describe('Item database type, needed for weapon slots: axe, bow, claw, dagger, mace, staff, sword, wand, shield, quiver.'),
      limit: z.number().int().min(1).max(15).optional(),
    },
    async run(args, ctx) {
      const b = need(ctx);
      const slot = String(args.slot);
      const groups = typeof args.type === 'string' ? [args.type.toLowerCase()] : SLOT_GROUPS.find(([re]) => re.test(slot))?.[1];
      if (!groups) throw new ToolError(`Give type for ${slot}: one of axe, bow, claw, dagger, mace, staff, sword, wand, shield, quiver.`);
      const { catalog } = await itemCatalog(ctx);
      const uniques = catalog.uniques.filter((u) => groups.includes(u.group));
      if (!uniques.length) throw new ToolError(`The item database has no uniques of type ${groups.join(', ')}.`);
      const open = await statMap(ctx, b.buildId);
      const [openXml, budget] = await Promise.all([xmlOf(ctx, b.buildId), pointBudget(ctx, b.buildId)]);
      const fatal = fatalForRanking(ctx, b.buildId, openXml, (f) => f.kind === 'damageSkill' && !!f.edits?.length);
      // The audit's "which skill" finding: the selected skill is not the build's only damage (Fire Trap selected on a Righteous
      // Fire build). Damage is then ranked as Full DPS with every damage skill counted, on the copy only.
      const dmg = (await auditBuild(ctx, b.buildId, openXml).catch(() => null))?.findings.find((f) => f.kind === 'damageSkill' && f.edits?.length);
      const stat = typeof args.stat === 'string' ? args.stat : dmg ? 'FullDPS' : dpsStat(open);
      if (!(stat in open)) throw new ToolError(`There is no stat "${stat}". Use an id from getStats.`);
      const freePoints = budget.passive.left;
      const level = readBuildMeta(openXml).level;
      const fullDps = num(open, 'FullDPS') > 0 || !!dmg;
      const flasksOn = flasksOnEdit(openXml);
      // shortcut: alt variants (a second variant line, e.g. Screams of the Desiccated) stay at their default; try their pairs if a request needs them.
      const tries = uniques.flatMap((u) => (u.variants.length ? u.variants.map((v, i) => ({ u, variant: v, text: uniqueText(u.text).replace(/Selected Variant: \d+/, `Selected Variant: ${i + 1}`) })) : [{ u, variant: null as string | null, text: uniqueText(u.text) }]));
      /** The build with `text` in the slot and its broken gem requirements fixed (lowered gems, or also attribute passives with `tree`). */
      const withItem = (xml: string, text: string, alreadyUnmet: Set<string>, tree: boolean, swapPoints?: number) => withScratch(ctx, xml, async (copy) => {
        await applyEdits(ctx, copy, [{ kind: 'setItem', slot, itemText: text }], fullDps);
        return fixRequirements(ctx, copy, alreadyUnmet, { tree, pointsLast: true, ...(swapPoints === undefined ? {} : { swapPoints }) }); // as proposeEdit makes an item change
      }).catch(() => null);
      const limit = typeof args.limit === 'number' ? args.limit : 5;
      const famous = FAMOUS[groups[0]!] ?? [];
      /** `base` with what `previewEdit` of the item in the slot changes on `buildId`, or null when the engine refuses it. */
      const preview = async (buildId: string, text: string, base: Record<string, Scalar>) => {
        const r = await ctx.engine.send('previewEdit', { buildId, edit: { kind: 'setItem', slot, itemText: text }, full: true }).catch(() => null);
        if (!r || r.blocked) return null;
        const after = { ...base };
        for (const c of r.statDiff.changed) if (c.after === null || typeof c.after !== 'object') after[c.statId] = c.after as Scalar;
        return after;
      };
      const { before, xml, alreadyUnmet, reqs, rows } = await withScratch(ctx, openXml, async (scratch) => {
        // Ranked with the build's active flasks seen by the engine: a "no flasks" buff is not damage this build keeps.
        const setup = [...(flasksOn ? [flasksOn] : []), ...(dmg?.edits ?? [])];
        if (setup.length) await applyEdits(ctx, scratch, setup, fullDps);
        const before = setup.length ? await statMap(ctx, scratch) : open;
        const xml = setup.length ? await xmlOf(ctx, scratch) : openXml;
        const reqs = await gemReqs(ctx, scratch);
        const alreadyUnmet = new Set(shortGems(reqs, before).map((g) => g.key));
        const out = [];
        const wear = tries.filter((t) => t.u.level <= level); // never equip what the character cannot wear
        // one engine call for every candidate (200+ previews one by one cost a round trip each)
        const { results } = await ctx.engine.send('previewEdits', { buildId: scratch, edits: wear.map((t) => ({ kind: 'setItem', slot, itemText: t.text })), full: true });
        for (const [i, t] of wear.entries()) {
          const r = results[i];
          if (!r || 'error' in r || r.blocked) continue;
          const raw = { ...before };
          for (const c of r.statDiff.changed) if (c.after === null || typeof c.after !== 'object') raw[c.statId] = c.after as Scalar;
          const newShort = shortGems(reqs, raw).filter((g) => !alreadyUnmet.has(g.key));
          out.push({ ...t, raw, after: raw, newShort, unfixable: newShort.filter((g) => !g.fit).map((g) => `${g.name} needs ${g.level1Need} ${g.attr.name} even at level 1`), gemFix: [] as string[], lowered: [] as ShortGem[], fixEdits: undefined as ToolEdit[] | undefined, fixedBy: undefined as ReqWay[] | undefined, chosen: undefined as string | undefined, estimated: false });
        }
        return { before, xml, alreadyUnmet, reqs, rows: out };
      });
      // Counted against a candidate, as a player would: a resist that falls off its cap, or the other side (damage for a defence ask,
      // effective HP for a damage ask) losing more than TRADE percent (The Broken Crown cost 73% of the damage).
      const other = ['FullDPS', 'CombinedDPS'].includes(stat) ? ['TotalEHP'] : stat === 'TotalEHP' ? [dpsStat(before)] : ['TotalEHP', dpsStat(before)];
      const cutsOf = (s: Record<string, Scalar>) => losses(before, s, TRADE).filter((id) => other.includes(id));
      const hardOf = (s: Record<string, Scalar>) => sideEffects(before, s).hard.length > 0 || cutsOf(s).length > 0;
      const wasShort = shortBy(before);
      // Lowering gems only takes away, so an item whose raw numbers already lose a cap or more than TRADE of the other side, or sit under the
      // 'limit'-th item that needs no fix, keeps its raw numbers (it cannot make the list); the well-known ones are always calculated.
      const exact = rows.filter((r) => !r.newShort.length && !hardOf(r.raw) && !shortBy(r.raw).some((n, i) => n > 0 && !wasShort[i])).map((r) => num(r.raw, stat)).sort((x, y) => y - x);
      const bar = exact[limit - 1] ?? -Infinity;
      // A player lowers the gem levels that no longer fit. Items that need the same lowered levels share one copy with those levels
      // set: one item of each group is calculated on it and the rest are scaled by the same change; the rows that can make the
      // answer are then calculated exactly (below, once `order` exists). A copy per belt took most of the 35 s.
      type Plan = { fix: ShortGem[]; rows: typeof rows; copy?: string; lowered?: Record<string, Scalar> };
      const plans = new Map<string, Plan>();
      for (const r of rows) {
        if ((hardOf(r.raw) || num(r.raw, stat) <= bar) && !famous.includes(r.u.name)) continue;
        const fix = r.newShort.filter((g) => g.fit > 0);
        const key = fix.map((g) => `${g.key}=${g.fit}`).sort().join(',');
        if (key) plans.set(key, { fix, rows: [...(plans.get(key)?.rows ?? []), r] });
      }
      const fixLine = (fix: ShortGem[], r: (typeof rows)[number], after: Record<string, Scalar>) => {
        const cost = [['TotalEHP', 'EHP'], [dpsStat(before), 'DPS']].map(([id, l]) => [Math.round(num(after, id!) - num(r.raw, id!)), l] as const).filter(([d]) => d !== 0).map(([d, l]) => `${d < 0 ? '-' : '+'}${Math.abs(d).toLocaleString('en-US')} ${l}`);
        const what = fix.map((g) => `${g.name} lowered from ${g.level} to ${g.fit} to fit ${num(r.raw, g.attr.name)} ${g.attr.name}`).join('; ');
        return cost.length ? `${what}: ${cost.join(', ')}` : what;
      };
      const planOf = new Map<(typeof rows)[number], Plan>();
      /** The exact numbers of `r` with its plan's gem levels; false when the engine refuses it (the row keeps what it had). */
      const lowerOn = async (plan: Plan, r: (typeof rows)[number]) => {
        r.estimated = false;
        const after = await preview(plan.copy!, r.text, plan.lowered!);
        if (!after) return false;
        r.after = after;
        r.gemFix = [fixLine(plan.fix, r, after)];
        r.lowered = plan.fix;
        return true;
      };
      /** Runs `fn` with a copy that has the plan's gem levels; one copy at a time (the engine keeps 6 builds and evicts the oldest). */
      const onPlan = (plan: Plan, fn: () => Promise<unknown>) => withScratch(ctx, xml, async (copy) => {
        await applyEdits(ctx, copy, plan.fix.map((g) => ({ kind: 'setGem', group: g.group, gem: g.gem, attr: 'level', value: g.fit })), fullDps);
        plan.lowered = await statMap(ctx, copy);
        plan.copy = copy;
        try { await fn(); } finally { plan.copy = undefined; }
      }).catch(() => undefined);
      for (const plan of plans.values()) {
        const [rep, ...rest] = plan.rows;
        let ok = false;
        if (rep) await onPlan(plan, async () => { ok = await lowerOn(plan, rep); });
        if (!rep || !ok) continue;
        for (const r of rest) {
          // the representative's change, as a ratio for big numbers (damage, life, effective HP) and as a difference for the rest
          const after = { ...r.raw };
          for (const [id, v] of Object.entries(rep.after)) {
            const was = rep.raw[id];
            if (typeof v !== 'number' || typeof was !== 'number' || v === was || typeof r.raw[id] !== 'number') continue;
            after[id] = Math.abs(was) >= 1000 ? (r.raw[id] as number) * (v / was) : (r.raw[id] as number) + (v - was);
          }
          r.after = after;
          r.gemFix = [fixLine(plan.fix, r, after)];
          r.lowered = plan.fix;
          r.estimated = true;
          planOf.set(r, plan);
        }
      }
      type Row = (typeof rows)[number];
      // Buy-only: the unique no longer drops, or this is an old variant ("Pre 3.16.0") that drops only in its current form.
      const legacy = (r: Row) => r.u.source === 'No longer obtainable' || /^Pre \d/.test(r.variant ?? '');
      // Broken by the item: a gem that no longer fits even at level 1, or an attribute that met every requirement before and now falls short.
      // shortcut: an attribute already short before (Wither's Int) is not checked again for gear; add per-item requirements if that bites.
      const unmet = (r: Row) => r.unfixable.length > 0 || shortBy(r.after).some((n, i) => n > 0 && !wasShort[i]);
      const cuts = (r: Row) => cutsOf(r.after);
      const hard = (r: Row) => hardOf(r.after);
      // an item that does not raise the ranked stat is never the pick for it, however clean its side effects (Crest of Desire, -2.8% EHP)
      const worse = (r: Row) => num(r.after, stat) <= num(before, stat);
      const lossOf = (r: Row) => Math.max(...other.map((id) => (num(before, id) > 0 ? (num(before, id) - num(r.after, id)) / num(before, id) : 0)));
      // within 1% of the stat a player takes the one that costs less of the other side (Torrent's Reclamation +5% for -7% EHP vs Cyclopean Coil +4.8%)
      const more = (x: Row, y: Row) => (Math.abs(num(y.after, stat) - num(x.after, stat)) <= 0.01 * Math.max(Math.abs(num(x.after, stat)), Math.abs(num(y.after, stat))) ? lossOf(x) - lossOf(y) || num(y.after, stat) - num(x.after, stat) : num(y.after, stat) - num(x.after, stat));
      const order = () => {
        const ranked = [...rows];
        ranked.sort((x, y) => Number(unmet(x)) - Number(unmet(y)) || Number(worse(x)) - Number(worse(y)) || Number(hard(x)) - Number(hard(y)) || more(x, y));
        // A buy-only (legacy) unique stays ahead of the best obtainable one only when it clearly beats it (over 10% more of the stat).
        const obt = ranked.find((r) => !legacy(r) && !unmet(r) && !worse(r) && !hard(r)) ?? ranked.find((r) => !legacy(r) && !unmet(r));
        const demoted = (r: Row) => !!obt && legacy(r) && num(r.after, stat) <= 1.1 * num(obt.after, stat);
        ranked.sort((x, y) => Number(unmet(x)) - Number(unmet(y)) || Number(worse(x)) - Number(worse(y)) || Number(hard(x)) - Number(hard(y)) || Number(demoted(x)) - Number(demoted(y)) || more(x, y));
        return { ranked, demoted };
      };
      // the estimated rows that can show (the list, the comparison, the well-known ones) are calculated exactly, until none is left
      for (let pass = 0; pass < 4; pass++) {
        const est = order().ranked;
        const want = [...est.filter((r) => !unmet(r)).slice(0, limit + 3), ...rows.filter((r) => famous.includes(r.u.name))].filter((r) => r.estimated);
        if (!want.length) break;
        for (const plan of new Set(want.map((r) => planOf.get(r)!))) {
          await onPlan(plan, async () => { for (const r of want.filter((x) => planOf.get(x) === plan)) await lowerOn(plan, r); });
          for (const r of want) if (planOf.get(r) === plan) r.estimated = false; // a refused copy keeps the estimate, never loops
        }
      }
      let { ranked, demoted } = order();
      // Swapping out the current item can drop the attributes it gave (a Strength belt) and so leave other gear unwearable. That
      // pushes every candidate to the unmet side on some builds (a Strength belt): rank wearable ones, and only when none is, fall back to the rest, flagged.
      const wearable = () => (ranked.some((r) => !unmet(r)) ? ranked.filter((r) => !unmet(r)) : ranked);
      // An item change spends no passive points unless lowering gems cannot fit them (a gem short even at level 1) or costs over 5% of
      // effective HP, damage or life: only those rows are rechecked with attribute passives, as proposeEdit makes them.
      // shortcut: at most 3 rechecks, highest raw stat first, only while one could still beat the leader.
      const lowerCost = (r: Row) => (r.lowered.length ? Math.max(...['TotalEHP', dpsStat(before), 'Life'].map((id) => (num(r.raw, id) > 0 ? ((num(r.raw, id) - num(r.after, id)) / num(r.raw, id)) * 100 : 0))) : 0);
      const rechecked = new Set<Row>();
      const recheck = async (r: Row, swapPoints?: number) => {
        const fit = await withItem(xml, r.text, alreadyUnmet, true, swapPoints);
        if (!fit?.chosen) return;
        r.after = { ...r.raw, ...fit.after };
        r.gemFix = fit.lines;
        r.fixEdits = fit.edits;
        r.fixedBy = fit.options;
        r.chosen = fit.chosen;
        r.unfixable = fit.unfixed;
        if (fit.chosen !== 'lower the gem levels') r.lowered = [];
        ({ ranked, demoted } = order());
      };
      for (let n = 0; n < 3; n++) {
        const lead = wearable().find((r) => !unmet(r));
        const next = rows
          .filter((r) => (r.unfixable.length || lowerCost(r) > 5) && !rechecked.has(r) && !hardOf(r.raw) && (!lead || r === lead || num(r.raw, stat) > num(lead.after, stat) * (legacy(r) ? 1.1 : 0.99)))
          .sort((x, y) => num(y.raw, stat) - num(x.raw, stat))[0];
        if (!next) break;
        rechecked.add(next);
        await recheck(next);
      }
      const list = wearable();
      // What a "no flasks" item would show if the flasks were off: the player asks "why not that one?", so say it and why.
      let notCounted: Record<string, unknown> | undefined;
      const noFlask = flasksOn ? tries.filter((t) => t.u.level <= level && /while affected by no Flasks/i.test(t.text)) : [];
      if (noFlask.length && list[0]) {
        const raw = await withScratch(ctx, openXml, async (s) => {
          const out: Array<{ t: (typeof noFlask)[number]; v: number }> = [];
          for (const t of noFlask) {
            const r = await ctx.engine.send('previewEdit', { buildId: s, edit: { kind: 'setItem', slot, itemText: t.text }, full: true }).catch(() => null);
            const v = r && !r.blocked ? r.statDiff.changed.find((c) => c.statId === stat)?.after : undefined;
            if (typeof v === 'number') out.push({ t, v });
          }
          return out.sort((x, y) => y.v - x.v)[0];
        }).catch(() => undefined);
        if (raw && raw.v > num(list[0].after, stat)) {
          const counted = rows.find((r) => r.text === raw.t.text);
          notCounted = { name: raw.t.u.name, ...(raw.t.variant ? { variant: raw.t.variant } : {}), withNoFlaskUp: formatStat(stat, raw.v), ...(counted ? { withYourFlasks: formatStat(stat, num(counted.after, stat)) } : {}), why: 'its bonus works only while no flask is active, and this build keeps its flasks active', ...(raw.t.u.source === 'No longer obtainable' ? { buyOnly: true } : {}) };
        }
      }
      const shown = list.slice(0, limit);
      const named = rows.filter((r) => famous.includes(r.u.name));
      const gain = (r: Row, id = stat) => pct(num(before, id), num(r.after, id));
      const best = list[0];
      // "Current" is the database's name for today's version, not a variant a player would say ("Meginord's Girdle (Current)")
      const label = (r: Row) => `${r.u.name}${r.variant && !/^Current$/i.test(r.variant) ? ` (${r.variant.replace(/ \(Current\)$/i, '')})` : ''}`;
      const costOf = (r: Row) => other.map((id) => `${statLabel(id)} ${gain(r, id) || '+0%'}`).join(', ');
      // The trade-off rule: the pick keeps the other side's loss under TRADE; the most of the stat regardless is offered beside it.
      const candidates = list.filter((r) => !unmet(r) && !worse(r) && !sideEffects(before, r.after).hard.length);
      const alt = [...candidates].sort((x, y) => Number(demoted(x)) - Number(demoted(y)) || num(y.after, stat) - num(x.after, stat))[0];
      const least = [...candidates].sort((x, y) => lossOf(x) - lossOf(y))[0];
      // a rare that was never named reads "New Item": the player knows it by its base ("Kept your New Item")
      const cur = ((c) => (c && /^New Item$/i.test(c.name) && c.base ? { ...c, name: c.base } : c))(readEquipped(openXml).find((i) => i.slot === slot));
      // Nothing keeps the other side within TRADE: the current item stays with what it gains at no cost, and the most of the stat is a card
      // a pick that gains less of the stat (in percent) than it costs the other side is no upgrade either: the current item stays and
      // the most of the stat is the card (Meginord's Girdle +0.9% Full DPS for -4.4% effective HP was put on).
      // "Put it on" names the act, not the item: the pick is still the assistant's and is held to the same rule.
      const smallTrade = !!(best && cur && !cuts(best).length && pctNum(before, best.after, stat) <= lossOf(best) * 100);
      const keep = !!(best && cuts(best).length && least && cur) || smallTrade;
      const alternative0 = smallTrade ? (alt ?? best) : keep ? best : best && alt && alt !== best && num(alt.after, stat) > num(best.after, stat) && !cuts(best).length ? alt : undefined;
      // a card that loses the asked stat is no option (Hyperboreus offered at Full DPS -3.1%, effective HP -11.5%)
      const alternative = alternative0 && num(alternative0.after, stat) > num(before, stat) ? alternative0 : undefined;
      // the answer names belts that beat the pick but rank after it (buy-only, or the pick is the obtainable one): the best of them
      // inside the cap is a one-tap card too, so the answer never names more damage it does not offer (Headhunter +1.1%)
      const richer = best ? candidates.filter((r) => r !== best && r !== alternative && r.u.name !== best.u.name && !cuts(r).length && num(r.after, stat) > num(best.after, stat)).sort((x, y) => num(y.after, stat) - num(x.after, stat))[0] : undefined;
      const keepCurrent = keep ? await freeGains(ctx, xml, slot, cur!, stat, before, other) : undefined;
      // the selected skill is not all the damage (RF beside Fire Trap): said first in every line the answer quotes, and the change puts
      // every damage skill in Full DPS (the audit's fix, display only) so the cards made after it show the same Full DPS
      const fullDpsLead = dmg ? `${dmg.shown}; this change puts them all in Full DPS, so the numbers count every damage skill. ` : '';
      // after the item: the app opens and highlights the first edit's tab (it once opened Skills instead of the helmet)
      const withFullDps = (l: ToolEdit[]) => [...l, ...(dmg?.edits ?? [])];
      const tradeOff = smallTrade
        ? `${fullDpsLead}${label(best!)} is the top pick within ${TRADE}% of ${other.map(statLabel).join(' or ')}, but it gains less than it costs (${statLabel(stat)} ${gain(best!)}, ${costOf(best!)}). Kept your ${cur!.name}${cur!.base && cur!.base !== cur!.name ? `, ${cur!.base}` : ''}${alternative ? `; ${label(alternative)} (${statLabel(stat)} ${gain(alternative)}, ${costOf(alternative)}) is offered as a card` : ''}.`
        : keep
        ? `${fullDpsLead}Every unique ${slot} that raises ${statLabel(stat)} costs over ${TRADE}% of ${other.map(statLabel).join(' or ')}; the smallest cost is ${label(least!)} (${statLabel(stat)} ${gain(least!)}, ${costOf(least!)}). Kept your ${cur!.name}; ${label(best!)} (${statLabel(stat)} ${gain(best!)}, ${costOf(best!)}) is offered as a card.`
        : undefined;
      // gems the new item supports through "Socketed Gems are Supported by" lines: a trigger support (Cast on Death) takes the skill out of the player's hands
      const { gems: gemList } = await gemCatalog(ctx);
      const inSlot = readSkills(openXml).filter((g) => g.slot === slot && g.enabled);
      const socketed = (r: Row) => {
        const actives = inSlot.flatMap((g) => g.gems.filter((x) => !x.support && x.enabled).map((x) => `${x.name}${g.isMain ? ' (your main skill)' : ''}`));
        if (!actives.length) return [];
        return [...itemLines(r.text, r.variant ? r.u.variants.indexOf(r.variant) + 1 : 0).join('\n').matchAll(/Socketed Gems are Supported by Level (\d+) ([^\n]+)/gi)].map(([, lv, name]) => {
          const info = gemList.find((g) => g.support && g.name.toLowerCase() === name!.trim().toLowerCase());
          return info?.tags.some((t) => /trigger/i.test(t))
            ? `${name!.trim()} (level ${lv}) supports the gems socketed in this ${slot}: ${actives.join(', ')} would be cast only by its trigger, not by you, and the damage shown still counts those casts`
            : `${name!.trim()} (level ${lv}) supports the gems socketed in this ${slot}: ${actives.join(', ')}`;
        });
      };
      // "Cannot be Frozen if Dexterity is higher than Intelligence" (Cyclopean Coil): read against the attributes after the change
      const ATTR: Record<string, string> = { Strength: 'Str', Dexterity: 'Dex', Intelligence: 'Int' };
      const conditions = (r: Row) => itemLines(r.text, r.variant ? r.u.variants.indexOf(r.variant) + 1 : 0).flatMap((l) => {
        const m = /^(.+) if (Strength|Dexterity|Intelligence) is higher than (Strength|Dexterity|Intelligence)$/.exec(l);
        if (!m) return [];
        const [a, b] = [num(r.after, ATTR[m[2]!]!), num(r.after, ATTR[m[3]!]!)];
        return [`${m[1]}: ${a > b ? 'yes' : 'no'} (${m[2]} ${a} vs ${m[3]} ${b})`];
      });
      // the roll and the attribute conditions in one line the answer always carries (both were left out)
      const mustSay = (r: Row) => {
        const rolls = rollUsed(r.text, r.variant, r.variant ? r.u.variants.indexOf(r.variant) + 1 : 0).split('; ').map((x) => x.split(' -> ')[1]).filter(Boolean);
        return [`${label(r)}${rolls.length ? `, numbers at the middle roll: ${rolls.join(', ')}` : ''}`, ...conditions(r)].join('; ');
      };
      // the gems the slot carries now and the sockets a new item must give them (a unique from the database has no rolled sockets)
      const MAX_SOCKETS: Record<string, number> = { Helmet: 4, Gloves: 4, Boots: 4, 'Body Armour': 6 };
      const sockets = (r: Row) => {
        const gems = inSlot.flatMap((g) => g.gems.filter((x) => x.enabled));
        const max = MAX_SOCKETS[slot];
        if (!gems.length || !max) return undefined;
        const colour = (n: string) => gemList.find((g) => g.name.toLowerCase() === n.toLowerCase())?.colour;
        const count = (c: string) => gems.filter((x) => colour(x.name) === c).length;
        const fixed = /Has (\d+) Sockets?/i.exec(itemLines(r.text).join('\n'));
        const room = fixed ? Number(fixed[1]) : max;
        const now = /^Sockets: (.+)$/m.exec(cur?.text ?? '')?.[1];
        const whites = (now?.match(/W/g) ?? []).length;
        return `${slot} carries ${gems.length} gems (${gems.map((x) => x.name).join(', ')})${now ? ` in ${cur!.name}'s ${now} sockets${whites ? ` (${whites} white, any colour)` : ''}` : ''}; ${r.u.name} can have ${room} linked sockets and needs ${[['str', 'red'], ['dex', 'green'], ['int', 'blue']].map(([c, n]) => `${count(c!)} ${n}`).join(', ')}${gems.length > room ? `: only ${room} of the gems fit` : ': recolour with Chromatic Orbs and link with Fusings'}`;
      };
      // Free points are a separate offer: what they buy back after the pick lowered gems (and gems short from before).
      let offer: Awaited<ReturnType<typeof pointsOffer>> = null;
      if (best && !keep && !unmet(best) && freePoints > 0 && (best.lowered.length || alreadyUnmet.size)) {
        offer = await withScratch(ctx, xml, async (c) => {
          await applyEdits(ctx, c, [{ kind: 'setItem', slot, itemText: best.text }, ...best.lowered.map((g): ToolEdit => ({ kind: 'setGem', group: g.group, gem: g.gem, attr: 'level', value: g.fit }))], fullDps);
          const old = await fixOldShortfalls(ctx, c, alreadyUnmet, fullDps, false); // as proposeEdit makes the item change
          const was = (e: ToolEdit) => reqs.find((g) => e.kind === 'setGem' && g.group === e.group && g.gem === e.gem);
          const oldLowered = old.edits.flatMap((e) => { const g = was(e); return g && e.kind === 'setGem' && typeof e.value === 'number' ? [{ ...g, fit: e.value }] : []; });
          return pointsOffer(ctx, c, [...best.lowered, ...oldLowered].map((g) => ({ group: g.group, gem: g.gem, name: g.name, level: g.level, now: g.fit })), fullDps);
        }).catch(() => null);
      }
      // the pick is a buy too: it says its price, or "price unknown", never nothing
      const prices = await priceOf(ctx, [...new Set([...shown, ...named].filter((r, i) => legacy(r) || (i === 0 && r === shown[0])).map((r) => r.u.name))]);
      /** The one reason a candidate lost to the pick, in a few words. */
      const whyLost = (r: Row) => {
        if (unmet(r)) return `leaves ${REQS.filter(([q, h]) => num(r.after, q) > num(r.after, h)).map(([, h]) => h).join('/')} short for your gear`;
        if (worse(r)) return `lowers ${statLabel(stat)}`;
        if (hard(r) && !(best && hard(best))) return [...sideEffects(before, r.after).hard.map((h) => h.replace(/ \(cap.*$/, '')), ...cuts(r).map((id) => `${statLabel(id)} ${gain(r, id)}`)].join(', ') + (r.gemFix.length && !hardOf(r.raw) ? ' once gems are lowered to fit its attributes' : '');
        if (legacy(r) && demoted(r)) return `buy-only${prices.get(r.u.name) ? ` (${prices.get(r.u.name)})` : ''}, not clearly better`;
        return `less ${statLabel(stat)}`;
      };
      // one entry per unique (its best-ranked variant): the next three, then the well-known ones the player asks about
      const runnersUp = [...list.slice(1, 4), ...ranked.filter((r) => famous.includes(r.u.name))].filter((r, i, all) => r.u.name !== best?.u.name && all.findIndex((x) => x.u.name === r.u.name) === i);
      const unwearable = famous.filter((f) => !rows.some((r) => r.u.name === f) && uniques.some((u) => u.name === f && u.level > level)).map((f) => `${f}: needs level ${uniques.find((u) => u.name === f)!.level}`);
      // the dismissed no-flask item with its numbers, as the player asks "why not Screams?"
      const nc = notCounted as { name: string; variant?: string; withNoFlaskUp: string; buyOnly?: boolean } | undefined;
      const counted = nc ? rows.find((r) => r.u.name === nc.name && (r.variant ?? undefined) === nc.variant) : undefined;
      const dismissed = nc ? [`${nc.name}${nc.variant ? ` (${nc.variant})` : ''} ${counted ? gain(counted) || '+0%' : ''} with your flasks up (${nc.withNoFlaskUp} ${statLabel(stat)} only with no flask active${nc.buyOnly ? ', buy-only' : ''})`] : [];
      const compared = best ? [`${label(best)} ${gain(best)} (${smallTrade ? `gains less than it costs: ${costOf(best)}` : keep ? `most ${statLabel(stat)}, offered as a card: ${costOf(best)}` : 'picked'})`, ...runnersUp.filter((r) => r !== alternative).map((r) => `${label(r)} ${gain(r)} (${whyLost(r)})`), ...(alternative && alternative !== best ? [`${label(alternative)} ${gain(alternative)} (most ${statLabel(stat)}, but ${costOf(alternative)})`] : []), ...dismissed, ...unwearable].join(' | ') : '';
      // what the item alone is worth, apart from the gem levels lowered to fit its attributes (the points are offered apart)
      const split = (r: Row) => {
        const raw = pct(num(before, stat), num(r.raw, stat)) || '+0%';
        if (!r.gemFix.length) return `${slot} alone ${raw} ${statLabel(stat)}, ${costOf(r)}; no gem levels or points needed`;
        const short = REQS.filter(([q, h]) => num(r.raw, q) > num(r.raw, h)).map(([q, h]) => `${h} ${num(r.raw, h)} under the ${num(r.raw, q)} your gear and gems need`).join(', ');
        const delta = (id: string) => { const d = (num(r.after, id) - num(r.raw, id)) / Math.abs(num(before, id) || 1); return `${statLabel(id)} ${d >= 0 ? '+' : '-'}${Math.abs(Math.round(d * 1000) / 10)}%`; };
        return `${slot} alone ${raw} ${statLabel(stat)}${short ? ` (with ${short})` : ''}; ${r.chosen && r.chosen !== 'lower the gem levels' ? `${/passive/.test(r.chosen) ? 'attribute passives' : 'a bench craft'} (${r.chosen}${r.gemFix.some((l) => /over 5%/.test(l)) ? ': lowering the gems would cost over 5%' : ', the only way: a gem fits no level'})` : 'lowering the gems to fit'} ${[stat, ...other].map(delta).join(', ')}; total ${statLabel(stat)} ${gain(r) || '+0%'}, ${costOf(r)}`;
      };
      // the slot's gems in their socket colours, for the Sockets line of the item text the edits equip
      const slotColours = inSlot.flatMap((g) => g.gems.filter((x) => x.enabled)).map((x) => ({ str: 'R', dex: 'G', int: 'B' } as Record<string, string>)[gemList.find((y) => y.name.toLowerCase() === x.name.toLowerCase())?.colour ?? ''] ?? 'W').slice(0, MAX_SOCKETS[slot] ?? (slot === 'Weapon 2' ? 3 : 6));
      const pickChecks = best && !keep ? await afterChecks(ctx, xml, [{ kind: 'setItem', slot, itemText: best.text }, ...(best.fixEdits ?? best.lowered.map((g): ToolEdit => ({ kind: 'setGem', group: g.group, gem: g.gem, attr: 'level', value: g.fit })))], before, fullDps) : [];
      const top = shown.map((r, i) => ({
        name: r.u.name,
        ...(r.variant && !/^Current$/i.test(r.variant) ? { variant: r.variant.replace(/ \(Current\)$/i, '') } : {}),
        level: r.u.level,
        ...(r.u.source ? { source: r.u.source } : {}),
        ...(legacy(r) ? { buyOnly: true, price: prices.get(r.u.name) ?? 'unknown' } : {}),
        ...(i === 0 && !legacy(r) ? { price: prices.get(r.u.name) ?? 'unknown' } : {}),
        ...(i === 0 ? { gainSplit: split(r), roll: rollUsed(r.text, r.variant, r.variant ? r.u.variants.indexOf(r.variant) + 1 : 0), mustSay: mustSay(r), ...(!keep ? { checks: pickChecks } : {}) } : {}),
        ...(i === 0 && socketed(r).length ? { socketedGems: socketed(r) } : {}),
        ...(i === 0 && conditions(r).length ? { conditions: conditions(r) } : {}),
        ...(i === 0 && sockets(r) ? { sockets: sockets(r) } : {}),
        ...(r.gemFix.length ? { gemLevelFixes: r.gemFix } : {}),
        ...(r.chosen ? { requirementFix: { chosen: r.chosen, options: r.fixedBy } } : {}),
        ...(unmet(r) ? { unmetRequirements: REQS.filter(([q, h]) => num(r.after, q) > num(r.after, h)).map(([q, h]) => `${h} ${num(r.after, h)} of ${num(r.after, q)} needed by other gear`) } : {}),
        stat: keyRows(before, r.after, [stat])[0],
        side: keyRows(before, r.after, SIDE.filter((id) => id !== stat)),
        sideEffects: sideEffects(before, r.after).lines,
        ...(hard(r) ? { rankedLower: [...sideEffects(before, r.after).hard, ...cuts(r).map((id) => `${statMeta(id).label} falls by more than ${TRADE}%`)] } : {}),
      }));
      // the current item stays: the app's first line says so plainly, with the most-stat pick's gain and cost, and the app makes
      // that pick's one-tap card itself (a run kept the belt and the answer never said so)
      const altEdits: ToolEdit[] | null = alternative ? [{ kind: 'setItem', slot, itemText: withSockets(alternative.text, slotColours) }, ...(alternative.fixEdits ?? alternative.lowered.map((g): ToolEdit => ({ kind: 'setGem', group: g.group, gem: g.gem, attr: 'level', value: g.fit })))] : null;
      const kept = keep && cur ? (alternative ?? best) : undefined;
      const respec = altEdits ? respecNote(alternative!.gemFix) : '';
      // the first line and the card are the panel's: an outside client gets neither, so it says the keep and offers alternative.edits itself
      const panel = ctx.origin === 'panel';
      if (panel && kept && !heldFirst.length) heldFirst.push(`Best ${/^\w+$/.test(slot) ? slot.toLowerCase() : slot} for ${statLabel(stat)} is ${label(kept)}: ${statLabel(stat)} ${gain(kept)} but ${costOf(kept)}, so I left your ${cur!.name} on.${altEdits ? ' Tap the card to equip it.' : ''}${respec ? ` ${respec}` : ''}`);
      if (panel && kept && altEdits) { const { runViaApp } = await import('./planTools.js'); void runViaApp(ctx, 'proposeEdit', { title: `Equip ${label(alternative!)} in ${slot}`.slice(0, 80), summary: `Equip ${label(alternative!)} in ${slot}: ${statLabel(stat)} ${gain(alternative!)}${respec ? `. ${respec}` : ''}`.slice(0, 300), edits: withFullDps(altEdits), offer: true, lead: stat }).catch(() => null); }
      return {
        untrustedData: true,
        buildChanged: false,
        slot,
        rankedBy: stat,
        ...(panel && kept ? { firstLine: 'written by the app, first in the answer: the current item stays, with the pick, its gain and its cost; never restate it, tradeOff or keepCurrent.line', ...(altEdits ? { alternativeCard: 'made by the app: never make it again' } : {}) } : {}),
        ...(dmg ? { damage: `${dmg.shown}. Damage here is Full DPS with every damage skill counted together; edits puts them in Full DPS in your build too` } : {}),
        now: num(before, stat),
        checked: rows.length,
        uniques: uniques.length,
        ...(flasksOn ? { countedWith: 'the build\'s active flasks: a "while affected by no Flasks" bonus counts for nothing' } : {}),
        top,
        ...(compared ? { compared } : {}),
        ...(best ? { replaces: itemSwapLoss(openXml, slot, best.text) } : {}),
        ...(notCounted ? { notCounted } : {}),
        ...(keepCurrent ? { keepCurrent: { line: `${fullDpsLead}${keepCurrent.line}`, checks: await afterChecks(ctx, xml, keepCurrent.edits, before, fullDps) }, edits: withFullDps(keepCurrent.edits) } : best ? { edits: withFullDps([{ kind: 'setItem', slot, itemText: withSockets(best.text, slotColours) }]) } : {}),
        ...(tradeOff ? { tradeOff } : {}),
        ...(alternative ? { alternative: { name: alternative.u.name, ...(alternative.variant && !/^Current$/i.test(alternative.variant) ? { variant: alternative.variant.replace(/ \(Current\)$/i, '') } : {}), line: `${label(alternative)}: ${statLabel(stat)} ${gain(alternative)} (vs ${gain(best!)}), but ${costOf(alternative)}`, ...(socketed(alternative).length ? { socketedGems: socketed(alternative) } : {}), ...(sockets(alternative) ? { sockets: sockets(alternative) } : {}), ...(conditions(alternative).length ? { conditions: conditions(alternative) } : {}), edits: [{ kind: 'setItem', slot, itemText: withSockets(alternative.text, slotColours) }, ...(alternative.fixEdits ?? alternative.lowered.map((g): ToolEdit => ({ kind: 'setGem', group: g.group, gem: g.gem, attr: 'level', value: g.fit })))] } } : {}),
        ...(offer ? { pointsOffer: { line: offer.lines[0], details: offer.lines.slice(1), edits: offer.edits } } : {}),
        ...(richer ? { richerCard: { name: richer.u.name, line: `${label(richer)}${legacy(richer) ? `, buy-only${prices.get(richer.u.name) ? ` (${prices.get(richer.u.name)})` : ''}` : ''}: ${statLabel(stat)} ${gain(richer)} (vs ${gain(best!)}), ${costOf(richer)}`, edits: [{ kind: 'setItem', slot, itemText: withSockets(richer.text, slotColours) }, ...(richer.fixEdits ?? richer.lowered.map((g): ToolEdit => ({ kind: 'setGem', group: g.group, gem: g.gem, attr: 'level', value: g.fit })))] } } : {}),
        ...(await fatal),
        ...(best && unmet(best) ? { warning: 'Every unique of this type leaves an attribute requirement of other gear unmet once it replaces the current item (see unmetRequirements). Say so when you recommend one.' } : {}),
        note: `${dmg ? 'Open the answer with {{ref:damage}} (the selected skill is not all the damage), before the pick. ' : ''}Every unique of this type and each variant was calculated by the engine on a scratch copy, counting only damage the build keeps in play (Full DPS already leaves out damage over time past the game cap). The pick keeps the other side (damage for a defence ask, effective HP for a damage ask) within ${TRADE}% and spends no passive points unless a gem fits no level or lowering the gems would cost over 5% of effective HP, damage or life (then free points cover the attribute: say so). Obtainable uniques rank first; a buyOnly one leads only when it clearly beats them: say it is buy-only. Say the pick's price once ({{ref:top[0].price}}, which may read unknown: write "its price is {{ref:top[0].price}}"); never call a bought item free. edits equips the pick: pass it to proposeEdit unchanged (proposeEdit fits the gems itself). With keepCurrent (no item keeps the other side within the limit, or the best one gains less than it costs: tradeOff says which), the current item stays even when the player said to put one on: ${panel ? 'the app writes the first line of the answer itself (firstLine), so never restate tradeOff or that line' : 'say first that the current item stays and why (tradeOff)'}, and never apply alternative.edits yourself; edits holds only its free gains (empty: no change; say keepCurrent.line) and alternative is the most of the stat. Then, after that change, make richerCard.edits, pointsOffer.edits and (unless alternativeCard says the app made it) alternative.edits each its own proposeEdit with offer: true (a card the player applies with one tap) and say each in one line: richerCard.line, pointsOffer.line, alternative.line (never one the app's first line already says). With firstLine present, add at most two short lines to it (the price, one caveat), under 40 words. damage says what the damage numbers count: say it with its fatalFirst entry. Say in the answer, in under 80 words: the item named with top[0].mustSay word for word, top[0].gainSplit (the item alone, then what fitting the gems costs), its price, and the one cost that matters most (tradeOff in full when present, else the worst of top[0].checks, sockets or the replaces line); the card and the compared list show the rest, so never list them. Read list entries by stat id, never by position: {{ref:top[0].side[TotalEHP].after}}, {{ref:top[0].sideEffects[Life].shown}}.`,
      };
    },
  },
  {
    name: 'spendPoints',
    chip: 'Spend points',
    description:
      'Spends exactly the free passive points (or `points` of them) for the most of one stat, chosen by the engine: Node Power ranks every reachable passive by gain per point, the best one that fits is taken on a scratch copy, the tree is ranked again, and so on until the points are spent. By default it skips a pick that would drop a per-type max hit, switch off a defence the build has (suppression, block, a capped resist, an immunity, leech or recovery) or cut the other of damage and effective HP by more than 15%, lists what it skipped, and gives the best set without that guard as unguardedBest. Returns the picks, points used vs free, the stat and side effects, and edits to pass to proposeEdit unchanged. Nothing is changed.',
    shape: {
      stat: z.string().max(40).describe('Stat id to maximise, for example "Life", "FullDPS", "CombinedDPS", "TotalEHP", "Armour".'),
      points: z.number().int().min(1).max(20).optional().describe('How many points to spend. Default: all free points. When the player says they have more unspent points than the build has free, pass that number: the build level is raised to match (up to 100) in the same Undo step.'),
      exclude: z.array(z.number().int().min(0)).max(40).optional().describe('Node ids never to take.'),
      allowLosses: z.boolean().optional().describe('true: take a pick even when it cuts damage or effective HP.'),
      raiseLevel: z.boolean().optional().describe('true only when the player says the character is a higher level than the build shows (it levelled up): the build level goes up to give the points. A plain count of free points never raises the level: the free points the build shows are spent.'),
    },
    async run(args, ctx) {
      const b = need(ctx);
      // the app spent the points itself for this turn: hand its result over instead of spending again
      const fromApp = appSpendCall;
      appSpendCall = false;
      const mine = fromApp ? undefined : autoSpend.get(b.buildKey);
      if (mine) {
        const done = await mine;
        if (done) return done;
      }
      const budget = await pointBudget(ctx, b.buildId);
      const free = budget.passive.left;
      const xml0 = await xmlOf(ctx, b.buildId);
      // the player has more points in game than the build ("I have 5 unspent" at 118 of 118, level 95): the build's level
      // goes up to match, in the same Undo step as the picks, instead of handing the job back
      const asked = typeof args.points === 'number' ? args.points : free;
      const auto = /<Build[^>]*characterLevelAutoMode="true"/.test(xml0);
      const level = budget.level || 100;
      const raise = args.raiseLevel === true && playerSaysLevel(turnAsk.text) && asked > free && !auto ? Math.min(asked - Math.max(0, free), 100 - level) : 0;
      const levelEdit: BuildEdit | null = raise > 0 ? { kind: 'setLevel', level: level + raise } : null;
      const want = Math.min(asked, Math.max(0, free) + raise); // never more than the points the character can have
      // the player counts more free points than the build has: spend what it has and say so, never move the character's level on its own (a level 97 character went to 100)
      const levelShort = asked > free && !auto && !levelEdit && level < 100 ? `The build is level ${level} and shows ${Math.max(0, free)} free ${Math.max(0, free) === 1 ? 'point' : 'points'}, not ${asked}: only those were spent and the level was not changed. If the character really is a higher level, the player says so and then spendPoints is asked again with raiseLevel.` : null;
      if (want <= 0) throw new ToolError(auto
        ? 'The tree has no free passive points and the build level follows the points spent. To take a node anyway, use takeNode: it frees the cheapest points.'
        // it said "already level 95, the most" at 95, and the model raised the level to 100 through a draft to make points
        : level < 100
          ? `The build is level ${level} and has no free passive points: a level ${level} character has spent them all. Say so in the first line and change nothing; never raise the build's level yourself (no setLevel edit). Only when the player says the character is a higher level, call spendPoints again with raiseLevel true. To take a node anyway, use takeNode: it frees the cheapest points.`
          : `The tree has no free passive points and the build is already level ${level}, the most. To take a node anyway, use takeNode: it frees the cheapest points.`);
      const stat = String(args.stat);
      const exclude = new Set(Array.isArray(args.exclude) ? (args.exclude as number[]) : []);
      const xml = levelEdit ? await withScratch(ctx, xml0, async (s) => { await applyEdits(ctx, s, [levelEdit], false); return xmlOf(ctx, s); }) : xml0;
      const before = await statMap(ctx, b.buildId);
      if (!(stat in before)) throw new ToolError(`There is no stat "${stat}". Use an id from getStats.`);
      // The turn is killed after 120 s without output, and every pick is a whole-tree ranking: stop when the next one may not fit.
      const t0 = Date.now();
      const timeBudget = ctx.spendBudgetMs ?? 60_000;
      const unguarded = args.allowLosses === true;
      /**
       * Greedy picks on a fresh copy. With `guard`, a pick is skipped when it would drop a per-type max hit, switch off a defence
       * layer the build has (suppression, block, a capped resist, an ailment immunity, a leech or recovery source), or leave
       * damage or effective HP (whichever is not asked) more than 15% under where it started.
       */
      // A single-goal ask spends on that goal (an EHP ask put 3 of 5 points into Dire Torment and
      // two crit nodes, whose crit kept a flask up). A pick that raises the other side by more percent than the asked stat is
      // taken only when no on-goal pick in the next ONGOAL_TRIES fits.
      const ONGOAL_TRIES = 10;
      const other = stat === 'FullDPS' || stat === 'CombinedDPS' ? 'TotalEHP' : dpsStat(before);
      const pct = (a: Record<string, Scalar>, b: Record<string, Scalar>, id: string) => (num(a, id) > 0 ? (num(b, id) - num(a, id)) / num(a, id) : 0);
      const greedy = (guard: boolean, fixes: boolean) => withScratch(ctx, xml, async (scratch) => {
        const all = await ctx.tree.all((await ctx.engine.send('treeState', { buildId: scratch })).tree.treeVersion);
        // a pick that raises a sidebar warning is no pick (Supreme Ego left unreserved mana negative)
        const skill = await ctx.engine.send('mainSkill', { buildId: scratch });
        const warnBase = new Set(statWarnings(before, skill));
        const picks: Array<{ id: number; name: string; points: number; gain: number; nodes: number[]; own: Map<number, number>; changed: string[] }> = [];
        const skipped: Array<{ id: number; name: string; why: string; gain: number }> = [];
        const edits: BuildEdit[] = [];
        let left = want;
        let now = before;
        let lastPass = 0;
        let outOfTime = false;
        let firstRank: NodePower[] | null = null;
        while (left > 0) {
          if (picks.length && Date.now() - t0 + lastPass > timeBudget) {
            outOfTime = true;
            break;
          }
          const t1 = Date.now();
          const power = await nodePower(ctx, scratch, stat, left);
          // An effective HP ask also weighs the weakest per-type max hit, twice the EHP percent: that hit is what kills (for example
          // both points went to projectile evasion while physical max hit sat at 14.8k). Ranked by percent gain of each, summed.
          const weak = stat === 'TotalEHP' ? MAX_HITS.filter((id) => num(now, id) > 0).sort((a, c) => num(now, a) - num(now, c))[0] : undefined;
          const weakPower = weak ? await nodePower(ctx, scratch, weak, left) : null;
          lastPass = Date.now() - t1;
          const val = (n: NodePower) => (weak && weakPower ? (n.pathPower ?? 0) / Math.max(1, num(now, stat)) + (2 * Math.max(0, weakPower.get(n.id)?.pathPower ?? 0)) / Math.max(1, num(now, weak)) : n.pathPower ?? 0);
          const ranked = [...power.values()]
            .filter((n) => !n.allocated && n.pathPower !== null && val(n) > 0 && n.dist > 0 && n.dist <= left && !exclude.has(n.id) && !isAscendancy(all.get(n.id)) && !skipped.some((s) => s.id === n.id))
            .sort((x, y) => val(y) / y.dist - val(x) / x.dist || val(y) - val(x));
          firstRank ??= ranked;
          // Picks from one ranking until one gains under 80% of what the ranking said per point (an earlier pick changed it):
          // then the tree is ranked again. Each Node Power pass is ~2.5 s, and four of them cost 10 s in one answer.
          let took = 0;
          let offGoal: NodePower | null = null;
          let tries = 0;
          const queue = [...ranked];
          const startLeft = left;
          while (left > 0 && (queue.length || offGoal)) {
            if (took && Date.now() - t0 > timeBudget) {
              outOfTime = true;
              break;
            }
            // the last few points look one pick ahead on the ranking's own numbers: two points go to a two-node path worth more
            // than the best two singles (la-deadeye life: +193 path over +97 and +81)
            if (left <= 3 && queue.length) {
              const fill = (n: NodePower) => val(n) + Math.max(0, ...queue.filter((o) => o !== n && o.dist <= left - n.dist).map((o) => val(o)));
              const order = queue.filter((n) => n.dist <= left).map((n) => [n, fill(n)] as const).sort((x, y) => y[1] - x[1]).map((x) => x[0]);
              queue.splice(0, queue.length, ...order);
            }
            // no on-goal pick fits: take the best off-goal one (an EHP ask with only damage nodes left still spends its points)
            const last: boolean = !queue.length || (!!offGoal && tries >= ONGOAL_TRIES);
            if (last && took) break; // rank again before falling back to an off-goal pick
            const cand: NodePower = last ? offGoal! : queue.shift()!;
            if (offGoal) tries++;
            const was = new Set((await ctx.engine.send('treeState', { buildId: scratch })).tree.allocated);
            if (took && (cand.dist > left || was.has(cand.id))) continue;
            const edit = takeEdit(cand);
            const depth = (await ctx.engine.send('history', { buildId: scratch })).undo;
            const r = await ctx.engine.send('edit', { buildId: scratch, edit });
            if (r.blocked) { if (last) break; continue; }
            const after = await statMap(ctx, scratch);
            const cut = losses(before, after, 15).filter((id) => id !== stat).map((id) => keyRows(before, after, [id])[0]!).map((k) => `${statLabel(k.stat)} ${formatStat(k.stat, k.before)} to ${formatStat(k.stat, k.after)}`);
            // less evasion against melee is a defence lost even when projectile evasion lifts effective HP (Arrow Dancing)
            const melee = stat === 'TotalEHP' && num(after, 'MeleeEvadeChance') < num(now, 'MeleeEvadeChance') ? [`chance to evade melee hits ${num(now, 'MeleeEvadeChance')}% to ${num(after, 'MeleeEvadeChance')}%`] : [];
            const hurt = guard ? [...cut, ...guardBreaks(now, after), ...melee, ...statWarnings(after, skill).filter((w) => !warnBase.has(w)).map((w) => `new warning: ${w}`)] : [];
            const undo = async () => { for (let h = (await ctx.engine.send('history', { buildId: scratch })).undo; h > depth; h--) await ctx.engine.send('undo', { buildId: scratch }); };
            if (hurt.length) {
              skipped.push({ id: cand.id, name: all.get(cand.id)?.name ?? `Node ${cand.id}`, why: hurt.join('; '), gain: Math.round((num(after, stat) - num(now, stat)) * 100) / 100 });
              await undo();
              if (last) break;
              continue;
            }
            if (!last && pct(now, after, other) > pct(now, after, stat)) {
              offGoal ??= cand;
              await undo();
              continue;
            }
            const nodes = (await ctx.engine.send('treeState', { buildId: scratch })).tree.allocated.filter((id) => !was.has(id));
            if (took && !weak && (num(after, stat) - num(now, stat)) / Math.max(1, nodes.length) < (0.8 * cand.pathPower!) / cand.dist) {
              await undo();
              break;
            }
            // each node's own change of the asked stat, from the same Node Power pass (a mastery's is the whole pick)
            const own = new Map(nodes.map((id) => [id, nodes.length === 1 ? num(after, stat) - num(now, stat) : power.get(id)?.single ?? 0]));
            const changed = keyRows(now, after, [stat, other, 'FireResist', 'ColdResist', 'LightningResist', 'ChaosResist', 'Mana', 'Evasion', 'Armour', 'SpellSuppressionChance'])
              .filter((k) => k.before !== k.after).map((k) => `${statLabel(k.stat)} ${formatStat(k.stat, k.before)} to ${formatStat(k.stat, k.after)}`);
            picks.push({ id: cand.id, name: all.get(cand.id)?.name ?? `Node ${cand.id}`, points: nodes.length, gain: Math.round((num(after, stat) - num(now, stat)) * 100) / 100, nodes, own, changed });
            edits.push(edit);
            left -= nodes.length;
            now = after;
            took++;
            // the last few points get a fresh ranking (paths an earlier pick shortened read wrong in this one)
            if (startLeft > 3 && left <= 3) break;
          }
          if (!took || outOfTime) break;
        }
        const tree = (await ctx.engine.send('treeState', { buildId: scratch })).tree;
        const named = picks.map(({ own, ...p }) => ({ ...p, name: all.has(p.id) ? p.name : nodeLabel(all, tree, p.id).replace(/ \(.*$/, ''), nodes: p.nodes.map((id) => nodeLabel(all, tree, id)), perNode: p.nodes.map((id) => `${nodeLabel(all, tree, id)}: ${statLabel(stat)} ${own.get(id)! >= 0 ? '+' : ''}${formatStat(stat, Math.round(own.get(id)! * 100) / 100)} on its own`) }));
        const resists = ['Fire', 'Cold', 'Lightning'].filter((e) => num(now, `${e}Resist`) < num(now, `${e}ResistMax`)).map((e) => `${e} resistance ${num(now, `${e}Resist`)}% after this change, ${num(now, `${e}ResistMax`) - num(now, `${e}Resist`)}% under its ${num(now, `${e}ResistMax`)}% cap`);
        // Mind Over Matter takes part of each hit from mana, so mana nodes are effective HP here: the best one is in the same ranking,
        // and one line says what it gives per point against the picks ("mana% nodes are EHP on this build")
        const startTree = (await ctx.engine.send('treeState', { buildId: scratch })).tree;
        const mom = stat === 'TotalEHP' && (startTree.allocated.some((id) => all.get(id)?.name === 'Mind Over Matter') || /^\s*Mind Over Matter\s*$/m.test(xml)); // the keystone on the tree or granted by an item (la-deadeye: the helmet)
        const mana = mom ? (firstRank ?? []).find((n) => (all.get(n.id)?.stats ?? []).some((l) => /maximum Mana/i.test(l))) : undefined;
        const spent = picks.reduce((a, p) => a + p.points, 0);
        const perPoint = spent ? Math.round((num(now, stat) - num(before, stat)) / spent) : 0;
        const manaLine = mom
          ? mana
            ? picks.some((p) => p.nodes.includes(mana.id))
              ? `Mind Over Matter makes mana effective HP here: ${all.get(mana.id)!.name} is one of the picks.`
              : `Mind Over Matter makes mana effective HP here, so mana nodes were ranked too: the best, ${all.get(mana.id)!.name} (${mana.dist} ${mana.dist === 1 ? 'point' : 'points'}), gives +${Math.round(mana.pathPower! / mana.dist).toLocaleString('en-US')} effective HP per point; the picks gave +${perPoint.toLocaleString('en-US')} per point.`
            : 'Mind Over Matter makes mana effective HP here, so mana nodes were ranked too: none within reach of these points gains effective HP.'
          : undefined;
        return { picks: named, skipped, edits, left, now, outOfTime, resists, pickIds: picks.map((p) => p.nodes), manaLine };
      });
      const run = await greedy(!unguarded, true);
      // The cap fix for a resist left under its cap is worked out after the picks are in the build, off the answer's path
      // (searching crafts and passive paths first put the first answer at 28 s), and goes on its own one-tap card.
      // The best set without the guard, offered in one line so the player can switch (only when the guard held something back).
      const alt = !unguarded && run.skipped.length && Date.now() - t0 < timeBudget / 2 ? await greedy(false, false) : null;
      const better = alt && num(alt.now, stat) > num(run.now, stat) ? alt : null;
      // The offered set is made after the picks are applied live (one Undo step), so its card works on top of them: give up the picks
      // it does not share, then take the ones it adds (the card was built from the original tree and over-allocated).
      const shared = better ? new Set(better.pickIds.flat()) : null;
      const kept = new Set(run.pickIds.flat().filter((id) => shared?.has(id)));
      const onTop: BuildEdit[] = better
        ? [
            // the picked node first (it is the far end of its path), the path nodes behind it, the last pick first
            ...run.pickIds.map((ids, i) => [...ids].sort((a, c) => Number(c === run.picks[i]!.id) - Number(a === run.picks[i]!.id))).reverse().flat().filter((id) => !shared!.has(id)).map((nodeId) => ({ kind: 'clickNode', nodeId }) as BuildEdit),
            ...better.edits.filter((_, i) => !better.pickIds[i]!.every((id) => kept.has(id))),
          ]
        : [];
      const hitsAsked = stat === 'TotalEHP' || stat === 'Life' || stat === 'EnergyShield';
      const used = want - run.left;
      return {
        untrustedData: true,
        buildChanged: false,
        rankedBy: stat,
        pointsFree: free,
        pointsAsked: want,
        pointsUsed: used,
        ...(run.left > 0 ? { pointsLeft: run.left, why: run.outOfTime ? 'stopped to stay inside the time limit; call spendPoints again after these picks are applied to spend the rest' : 'no reachable passive within the points left raises this stat without breaking a defence the build has' } : {}),
        picks: run.picks,
        allocates: run.picks.flatMap((p) => p.nodes),
        ...(run.skipped.length ? { skipped: run.skipped } : {}),
        stat: keyRows(before, run.now, [stat])[0],
        side: keyRows(before, run.now, SIDE.filter((id) => id !== stat)),
        ...(hitsAsked ? { maxHits: keyRows(before, run.now, MAX_HITS) } : {}),
        ...(run.resists.length ? { resistsUnderCap: run.resists } : {}),
        ...(run.manaLine ? { manaNodes: run.manaLine } : {}),
        ...(run.resists.length && run.edits.length ? { pickIds: run.pickIds.flat() } : {}),
        ...(levelShort ? { levelNote: levelShort } : {}),
        ...(levelEdit ? { levelRaised: `Build level ${level} -> ${level + raise}: ${raise} more passive ${raise === 1 ? 'point' : 'points'} to match the character in game${raise < asked - Math.max(0, free) ? `; level 100 is the most, so ${asked - Math.max(0, free) - raise} of the points asked do not fit` : ''}` } : {}),
        ...(run.edits.length ? { edits: levelEdit ? [levelEdit, ...run.edits] : run.edits } : {}),
        ...(better
          ? {
              unguardedBest: {
                allocates: better.picks.flatMap((p) => p.nodes),
                stat: keyRows(before, better.now, [stat])[0],
                side: keyRows(before, better.now, SIDE.filter((id) => id !== stat)),
                maxHits: keyRows(before, better.now, MAX_HITS),
                breaks: guardBreaks(before, better.now),
                // the card's one sentence: what it adds and what it costs (Acrobatics was applied, not offered)
                line: `${better.picks.map((p) => p.name).join(', ')} would take ${statLabel(stat)} from ${formatStat(stat, num(before, stat))} to ${formatStat(stat, num(better.now, stat))} but costs: ${guardBreaks(before, better.now).join('; ') || 'nothing the engine counts'}${num(better.now, 'SpellDodgeChance') > num(before, 'SpellDodgeChance') ? '. Its effective HP counts the extra chance to dodge spell hits as avoidance, a coin flip: judge it by the max hits and the suppression above' : ''}`,
                edits: better.edits,
                // the same set as one card on top of the picks above, once they are applied
                editsOnTopOfPicks: onTop,
              },
            }
          : {}),
        note: `Engine numbers on a scratch copy. Pass edits to proposeEdit unchanged and say the points used as pointsUsed gives them. When levelRaised is present, say it first: edits raise the build's level in the same Undo step, because the player has those points in game. Name every node in allocates by its name (path nodes too, masteries with their effect), never "a nearby node".${hitsAsked ? ' Give the per-type max hits from maxHits: effective HP counts avoidance, max hit is what one hit the player survives.' : ''} The picks keep every per-type max hit and defence layer the build has, and keep the other of damage and effective HP within 15%. Each pick spends on the asked stat; one that mostly raised the other side is taken only when nothing on-goal fits. Name the nodes in one sentence; give one picks[].perNode line as it is, only for the pick that moved the stat most, and a picks[].changed only when it is a cost (a resist off its cap): the card lists every node and its gain, so never write a line per node (five per-node lines made 200-word answers). Say manaNodes in one line when present. State every resistsUnderCap line; when resistFix is present, say in one line that a card with the cheapest fix to cap it follows: the app makes that card itself, never make one or give its numbers. When alreadyApplied is present the app has already put these picks into the build as one Undo step: never pass edits to proposeEdit again; word the answer from this result. When unguardedBest is present, make unguardedBest.editsOnTopOfPicks its own proposeEdit with offer: true after the picks are applied (one tap, not applied; unguardedBest.edits only when the picks are not applied) and end with unguardedBest.line, so the player can take it instead; never apply it yourself.`,
      };
    },
  },
  {
    name: 'takeNode',
    chip: 'Take node',
    description:
      'Takes one passive node by its shortest path. When the tree has too few free points it also picks the allocated points to give up: the end nodes whose loss of damage and effective HP the engine finds smallest (never one the path needs). Returns the path, the points it costs, what it drops with the engine\'s loss for each, the stat changes, and edits to pass to proposeEdit unchanged (one Undo step). Nothing is changed. To get a stat that taking a node would give ("how much life if I took X"), use previewEdit with a clickNode edit: its number is the answer; call this tool in the same step for the path, its points and the nodes to give up (the paid-for drops here change the number).',
    shape: { nodeId: z.number().int().min(0), effectId: z.number().int().min(0).optional().describe('A mastery: the effect id to take. Default: the effect the engine finds best.') },
    async run(args, ctx) {
      const b = need(ctx);
      const target = args.nodeId as number;
      const budget = await pointBudget(ctx, b.buildId);
      const xml = await xmlOf(ctx, b.buildId);
      const before = await statMap(ctx, b.buildId);
      const minionBefore = minionDps((await ctx.engine.send('getStats', { buildId: b.buildId })).stats);
      return await withScratch(ctx, xml, async (scratch) => {
        const { tree } = await ctx.engine.send('treeState', { buildId: scratch });
        const all = await ctx.tree.all(tree.treeVersion);
        const name = (id: number) => all.get(id)?.name ?? `Node ${id}`;
        if (tree.allocated.includes(target)) throw new ToolError(`${name(target)} is already allocated.`);
        const n = all.get(target);
        const edit: BuildEdit = n?.effects?.length ? { kind: 'pickMastery', nodeId: target, effectId: await masteryEffectId(ctx, scratch, target, n.effects, args.effectId as number | undefined) } : { kind: 'clickNode', nodeId: target };
        const r = await ctx.engine.send('edit', { buildId: scratch, edit });
        if (r.blocked) throw new ToolError(`The engine refused it: ${refusal(r.blocked)}.`);
        const start = new Set(tree.allocated);
        const path = (await ctx.engine.send('treeState', { buildId: scratch })).tree.allocated.filter((id) => !start.has(id));
        const cost = await passiveCost(ctx, tree.treeVersion, path);
        const short = Math.max(0, cost - Math.max(0, budget.passive.left));
        const edits: BuildEdit[] = [edit];
        const dropped: Dropped[] = [];
        let alternatives: Array<{ givesUp: string[]; lossPercent: Record<string, number>; line: string }> = [];
        if (short > 0) {
          const paid = await payForPath(ctx, scratch, all, path, short);
          edits.push(...paid.edits);
          dropped.push(...paid.dropped);
          alternatives = paid.alternatives;
          if (dropped.length < short) throw new ToolError(`It needs ${cost} points and only ${Math.max(0, budget.passive.left)} are free, and there are not enough end nodes to give up.`);
        }
        const after = await statMap(ctx, scratch);
        const minionAfter = minionDps((await ctx.engine.send('getStats', { buildId: scratch })).stats);
        const endTree = (await ctx.engine.send('treeState', { buildId: scratch })).tree;
        const left = (await pointBudget(ctx, scratch)).passive.left;
        const off = guardBreaks(before, after);
        const up = (a: number, b: number) => b > a * 1.005 && b - a > 0.01;
        const dps = dpsStat(before);
        const gains = [up(num(before, dps), num(after, dps)), up(minionBefore, minionAfter), up(num(before, 'TotalEHP'), num(after, 'TotalEHP')), ...MAX_HITS.map((id) => up(num(before, id), num(after, id))), up(recoveryTotal(before), recoveryTotal(after))].some(Boolean);
        const esNoRefill = recoveryOf(before, 'EnergyShieldRecharge') > 0 && recoveryOf(after, 'EnergyShieldRecharge') === 0 && num(after, 'EnergyShield') > 0 && num(after, 'EnergyShieldRegenRecovery') <= 0 && num(after, 'EnergyShieldLeechRate') <= 0;
        const bigLoss = losses(before, after, 15);
        // the player asked for it, so it is taken, but a keystone that adds nothing and switches off a recovery source is warned about first, with the leech that makes it work
        const hold = n?.type === 'Keystone' && !gains && (esNoRefill || recoveryTotal(after) < recoveryTotal(before));
        let leech = '';
        if (hold) {
          const { state: cfg } = await ctx.engine.send('configState', { buildId: scratch });
          const line = '2% of Damage Leeched as Life';
          const p = await ctx.engine.send('previewEdit', { buildId: scratch, edit: { kind: 'setCustomMods', blocks: [...cfg.customMods.map((x) => ({ title: x.title, enabled: x.enabled, text: x.text })), { title: 'leech check', enabled: true, text: line }] } as BuildEdit });
          const rate = num(Object.fromEntries((p.blocked ? [] : p.statDiff.changed).map((c) => [c.statId, c.after])) as Record<string, Scalar>, 'EnergyShieldLeechRate');
          leech = rate > 0
            ? `Life leech makes it work: with "${line}" (on gear or a support) the engine leeches ${formatStat('EnergyShieldLeechRate', rate)} energy shield per second`
            : `Life leech would not make it work here: with "${line}" the engine shows no leech for this build's damage, so leech on gear would not refill it`;
        }
        const keystone = n?.type === 'Keystone'
          ? {
              name: n.name,
              text: n.stats,
              recovery: recoveryRows(before, after),
              ...(gains ? {} : { pureDownside: `${n.name} is a net loss for this build: no gain the engine counts (damage, minion damage, effective HP, max hits and recovery do not rise)${[['effective HP', num(before, 'TotalEHP'), num(after, 'TotalEHP')], ['minion damage', minionBefore, minionAfter], ['damage', num(before, dps), num(after, dps)]].filter(([, a, z]) => (a as number) > 0 && (z as number) < (a as number) * 0.995).map(([w, a, z]) => ` and costs ${w} ${Math.round(((z as number) / (a as number) - 1) * 1000) / 10}% (with the nodes given up)`).join('')}${off.length ? ` and it switches off: ${off.join('; ')}` : ''}` }),
              ...(esNoRefill ? { esNoRefill: `Energy shield ${formatStat('EnergyShield', num(after, 'EnergyShield'))} can no longer refill (no recharge, regeneration or leech in the engine's numbers), so the effective HP number counts a pool that does not come back` } : {}),
            }
          : undefined;
        // last: it edits the scratch copy everything above was measured on
        const esFix = esNoRefill ? await esRegenFix(ctx, scratch, all).catch(() => null) : null;
        return {
          untrustedData: true,
          buildChanged: false,
          node: { id: target, name: name(target) },
          path: path.map((id) => ({ id, name: nodeLabel(all, endTree, id) })),
          pathPoints: cost,
          pointsFreeBefore: budget.passive.left,
          // the order it gives points up in is how it picks, not something the player reads
          ...(dropped.length ? { dropped } : {}),
          ...(alternatives.length ? { otherSetsToGiveUp: alternatives } : {}),
          pointsFreeAfter: left,
          changes: [...keyRows(before, after, SIDE), ...(minionBefore || minionAfter ? [{ stat: 'MinionDPS', before: Math.round(minionBefore), after: Math.round(minionAfter), change: Math.round(minionAfter - minionBefore), percent: minionBefore ? Math.round(((minionAfter - minionBefore) / minionBefore) * 10000) / 100 : null }] : [])],
          maxHits: keyRows(before, after, MAX_HITS),
          ...(off.length ? { switchedOff: off } : {}),
          ...(bigLoss.length ? { bigLoss: bigLoss.map((id) => `${id} falls more than 15%`) } : {}),
          ...(keystone ? { keystone } : {}),
          edits,
          ...(esFix ? { esFix } : {}),
          ...(hold ? { warnFirst: `${keystone!.pureDownside}${esNoRefill ? `; ${keystone!.esNoRefill}` : ''}`, leech } : {}),
          note: 'Engine numbers on a scratch copy. Pass edits to proposeEdit unchanged: it takes the path and gives up the dropped nodes as one Undo step. Name every dropped node by gave (what it gave: the effect of a mastery, the stats of a notable) with its lossPercent, and say each otherSetsToGiveUp line as written, never calling them cheaper (the player can ask for one instead). For a keystone, say each recovery row whole ({{ref:keystone.recovery[0].shown}}: it names the stat itself) or as from {{ref:keystone.recovery[0].before}} to {{ref:keystone.recovery[0].after}} after your own words for the stat, never both, and switchedOff; when pureDownside or esNoRefill is present, lead with it and do not headline effective HP. Never turn off an aura or gem to fix a warning this change made: say what that would cost and ask. When warnFirst is present, the answer opens with it in one line and its recovery numbers (per second, before and after), then the leech line. When pureDownside, esNoRefill, switchedOff or bigLoss is present, the player still asked for it: apply it, then offer the cheapest fix one tap away: with pointsFreeAfter above 0 call spendPoints for TotalEHP with those points and make its edits a proposeEdit with offer: true; for esNoRefill name a leech source to add (Ghost Reaver turns life leech into energy shield leech), and when esFix is present make esFix.edits a proposeEdit with offer: true after the change is applied and say esFix.line. Say each defence that falls with its number before and after (maxHits, switchedOff), not only effective HP.',
        };
      });
    },
  },
  {
    name: 'bestSupport',
    chip: 'Rank supports',
    description:
      'The best support gem swap for one socket group, ranked by the calculation engine: every support gem in the game is ranked in place of each support of the group, the strongest swaps are calculated on a scratch copy, and the single best one comes back with edits (pass them to proposeEdit unchanged). It also says which support it replaces and what the best replacement for each support would do. Use this for any "replace my weakest support" or "best support for X" request instead of testing gems yourself. Nothing is changed.',
    shape: {
      skill: z.string().max(60).optional().describe('The active skill whose group to improve, for example "Boneshatter". Default: the main skill.'),
      group: z.number().int().min(1).optional().describe('Or the socket group number, as getSkills lists them.'),
      stat: z.string().max(40).optional().describe('Stat id to maximise, for example "CombinedDPS", "FullDPS", "TotalEHP". Default: FullDPS, or CombinedDPS when the build has no FullDPS.'),
    },
    async run(args, ctx) {
      const b = need(ctx);
      const [xml, { state }, { gems: catalog }, before] = await Promise.all([xmlOf(ctx, b.buildId), ctx.engine.send('skillsState', { buildId: b.buildId }), ctx.engine.send('gemCatalog', {} as Record<string, never>), statMap(ctx, b.buildId)]);
      const fatal = fatalForRanking(ctx, b.buildId, xml);
      const groups = readSkills(xml).map((g) => ({ ...g, gems: g.gems.map((gem, i) => ({ ...gem, gemId: state.groups.find((x) => x.index === g.index && !x.synthetic)?.gems[i]?.gemId ?? null })) }));
      const skill = typeof args.skill === 'string' ? args.skill.toLowerCase() : null;
      const g = typeof args.group === 'number' ? groups.find((x) => x.index === args.group)
        : skill ? groups.find((x) => x.gems.some((y) => !y.support && y.name.toLowerCase() === skill)) ?? groups.find((x) => x.gems.some((y) => !y.support && y.name.toLowerCase().includes(skill)))
        : groups.find((x) => x.index === state.mainGroup) ?? groups.find((x) => x.isMain);
      if (!g) throw new ToolError(skill ? `No socket group has the skill "${args.skill}". getSkills lists them.` : 'Give the skill or group to improve.');
      const supports = g.gems.filter((x) => x.support && x.enabled);
      // the count the player sees on screen: every support gem in the group, the turned-off ones named ("five" against six)
      const all = g.gems.filter((x) => x.support);
      const off = all.filter((x) => !x.enabled).map((x) => { const n = all.filter((y) => y.name === x.name).length; return n > 1 ? `one of the ${n === 2 ? 'two' : n} ${x.name}` : x.name; });
      const supportsLine = `${all.length} support gems in this group, ${supports.length} turned on${off.length ? ` (${off.join(', ')} ${off.length > 1 ? 'are' : 'is'} turned off)` : ''}: the turned-on ones are ranked`;
      if (!supports.length) throw new ToolError(`Socket group ${g.index} has no enabled support gem to replace.`);
      const stat = typeof args.stat === 'string' ? args.stat : dpsStat(before);
      if (!(stat in before)) throw new ToolError(`There is no stat "${stat}". Use an id from getStats.`);
      // The gem picker's ranking reads FullDPS near zero, so it shortlists on CombinedDPS; the shortlist is then calculated on the real stat.
      const field = GEM_POWER_FIELDS.has(stat) && stat !== 'FullDPS' ? stat : 'CombinedDPS';
      const have = new Set(g.gems.map((x) => x.gemId).filter(Boolean));
      const pool = catalog.filter((x) => x.support && !x.legacy && !have.has(x.id));
      // a build whose damage is partly ailments always has the ailment supports calculated: the hit-based shortlist left
      // Swift Affliction and the Awakened ailment gems out
      const ailing = ['TotalPoisonDPS', 'IgniteDPS', 'BleedDPS'].some((id) => num(before, id) > 0);
      const always = (x: (typeof pool)[number]) => /^(Awakened )?Empower\b/.test(x.name) || (ailing && /^(Awakened )?(Deadly Ailments|Unbound Ailments|Swift Affliction)$/.test(x.name));
      // their Awakened versions are legacy (Standard league only, as the Skills tab tags them): named, never picked
      const legacy = catalog.filter((x) => x.support && x.legacy && x.plusVersion && !have.has(x.id) && always(x)).map((x) => x.name);
      const legacyNotTested = legacy.length ? `${legacy.join(', ')}: legacy gems (Standard league only), so not tested` : undefined;
      const shortlist: Array<{ from: (typeof supports)[number]; to: (typeof pool)[number]; power: number }> = [];
      // The first slot ranks the whole pool; the other slots calculate only its best PRUNE_TO (the same gems lead in every slot of one
      // group: that cut one ask from 55 engine batches to 23 with the same picks), so the matrix of slots costs a third of a full ranking.
      let candidates = pool;
      for (const p of supports) {
        const power: Record<string, number | null> = {};
        for (let i = 0; i < candidates.length; i += 20) Object.assign(power, (await ctx.engine.send('gemPower', { buildId: b.buildId, group: g.index, field, gemIds: candidates.slice(i, i + 20).map((x) => x.id), gem: p.index })).power);
        if (candidates === pool) candidates = pool.filter((x) => typeof power[x.id] === 'number').sort((x, y) => power[y.id]! - power[x.id]!).slice(0, PRUNE_TO);
        const ranked = pool.filter((x) => typeof power[x.id] === 'number').sort((x, y) => power[y.id]! - power[x.id]!).slice(0, 6);
        // supports that add gem levels (Empower) are always calculated: the picker's ranking can miss them
        for (const c of [...ranked, ...pool.filter((x) => always(x) && !ranked.includes(x))]) shortlist.push({ from: p, to: c, power: power[c.id] ?? 0 });
      }
      // A defence support's layer the engine counts only through a config row (Fortify: "Are you Fortified?") is counted while it
      // is in the group and taken away with it, so cutting it shows its effective HP cost.
      // shortcut: Fortify only; add other config-counted defence supports here when they show up.
      const { state: cfg } = await ctx.engine.send('configState', { buildId: b.buildId });
      const fortify = supports.find((x) => /^Fortify$/i.test(x.name));
      const { base, rows } = await withScratch(ctx, xml, async (scratch) => {
        if (fortify && !cfg.values.buffFortification) await applyEdits(ctx, scratch, [{ kind: 'setConfig', key: 'buffFortification', value: true }], num(before, 'FullDPS') > 0);
        const base = fortify ? await statMap(ctx, scratch) : before;
        const out = [];
        for (const s of shortlist) {
          const edit: BuildEdit = { kind: 'setGemSkill', group: g.index, gem: s.from.index, gemId: s.to.id };
          let after: Record<string, Scalar> | null = null;
          if (s.from === fortify) {
            const depth = (await ctx.engine.send('history', { buildId: scratch })).undo;
            await applyEdits(ctx, scratch, [edit, { kind: 'setConfig', key: 'buffFortification', value: false }], num(before, 'FullDPS') > 0).catch(() => undefined);
            after = await statMap(ctx, scratch);
            for (let h = (await ctx.engine.send('history', { buildId: scratch })).undo; h > depth; h--) await ctx.engine.send('undo', { buildId: scratch });
          } else {
            const r = await ctx.engine.send('previewEdit', { buildId: scratch, edit, full: true }).catch(() => null);
            if (!r || r.blocked) continue;
            after = { ...base };
            for (const c of r.statDiff.changed) if (c.after === null || typeof c.after !== 'object') after[c.statId] = c.after as Scalar;
          }
          out.push({ ...s, edit, after });
        }
        return { base, rows: out };
      });
      // a count in Full DPS that stood for projectiles follows them, as proposeEdit will set it
      const count = mainCount(state);
      for (const r of rows) r.after = withScaledCount(before, r.after, count);
      // a turned-off support's socket is a free socket: the best support put there and turned on (a 7-link ran 5 supports)
      // only while the group has a link to spare: a turned-off seventh gem in an unsocketed group is a spare, not a free link
      const links = linkCount(g.slot ? slotItemText(xml, g.slot)?.split(String.fromCharCode(10)).find((l) => l.startsWith('Sockets: '))?.slice(9).trim() : undefined);
      const slotOff = g.gems.filter((x) => x.enabled).length < links ? all.find((x) => !x.enabled) : undefined;
      const fill = slotOff ? await withScratch(ctx, xml, async (scratch) => {
        await applyEdits(ctx, scratch, [{ kind: 'setGem', group: g.index, gem: slotOff.index, attr: 'enabled', value: true }], num(before, 'FullDPS') > 0);
        const base = await statMap(ctx, scratch);
        let top: { to: (typeof pool)[number]; after: Record<string, Scalar> } | null = null;
        for (const to of new Map(shortlist.map((s) => [s.to.id, s.to])).values()) {
          const r = await ctx.engine.send('previewEdit', { buildId: scratch, edit: { kind: 'setGemSkill', group: g.index, gem: slotOff.index, gemId: to.id }, full: true }).catch(() => null);
          if (!r || r.blocked) continue;
          const after = { ...base };
          for (const c of r.statDiff.changed) if (c.after === null || typeof c.after !== 'object') after[c.statId] = c.after as Scalar;
          if (!top || num(after, stat) > num(top.after, stat)) top = { to, after: withScaledCount(before, after, count) };
        }
        return top;
      }).catch(() => null) : null;
      const fillRow = fill && slotOff ? keyRows(before, fill.after, [stat])[0] : undefined;
      const fillTurnedOff = fill && slotOff && fillRow && num(fill.after, stat) > num(before, stat)
        ? { slot: slotOff.name, with: fill.to.name, stat: fillRow, line: `${fill.to.name} in the socket of the turned-off ${slotOff.name}: ${fillRow.label} ${fillRow.beforeShown} -> ${fillRow.afterShown} (+${fillRow.percent ?? 0}%)`, edits: [{ kind: 'setGemSkill', group: g.index, gem: slotOff.index, gemId: fill.to.id }, { kind: 'setGem', group: g.index, gem: slotOff.index, attr: 'enabled', value: true }] }
        : undefined;
      // A support that is the build's only source of a buff the engine counts from config alone (Fortify's Fortification)
      // takes the buff with it: its worth comes off the swap's numbers, and a swap that drops a max hit is held back.
      const config = readConfig(xml);
      const lose = new Map<string, { buff: string; worth: Array<{ statId: string; without: number; with: number }> }>();
      for (const p of supports) {
        const b = GEM_BUFFS.find((x) => x.gem.test(p.name));
        if (!b || groups.filter((x) => x.enabled).flatMap((x) => x.gems).filter((x) => x.enabled && b.gem.test(x.name)).length > 1) continue;
        const ticked = config.some((c) => c.name === b.key && c.value === true);
        const worth = ticked
          ? await buffWorth(ctx, need(ctx).buildId, b.key, false)
          : await buffWorth(ctx, need(ctx).buildId, b.key);
        if (worth.length) lose.set(p.name, { buff: b.buff, worth });
      }
      const held = (r: (typeof rows)[number]) => (lose.get(r.from.name)?.worth ?? []).filter((w) => /MaximumHitTaken$/.test(w.statId) && w.without < w.with * 0.995);
      // only the ranked stat is corrected (an Onslaught source costs damage); defence losses are said and guarded, not netted
      for (const r of rows) if (r.from !== fortify) for (const w of lose.get(r.from.name)?.worth ?? []) if (w.statId === stat) r.after[w.statId] = num(r.after, w.statId) - (w.with - w.without);
      // a swap that costs over TRADE percent of effective HP ranks last; within 5% of the stat the one that costs less effective HP
      // wins, so a pure-damage support is the one cut when the damage is close
      const ehpLoss = (r: (typeof rows)[number]) => (num(base, 'TotalEHP') > 0 ? (num(base, 'TotalEHP') - num(r.after, 'TotalEHP')) / num(base, 'TotalEHP') : 0);
      const close = (x: (typeof rows)[number], y: (typeof rows)[number]) => Math.abs(num(y.after, stat) - num(x.after, stat)) <= 0.05 * Math.max(Math.abs(num(x.after, stat)), Math.abs(num(y.after, stat)));
      rows.sort((x, y) => Number(ehpLoss(x) > TRADE / 100) - Number(ehpLoss(y) > TRADE / 100) || (close(x, y) && Math.abs(ehpLoss(x) - ehpLoss(y)) > 0.005 ? ehpLoss(x) - ehpLoss(y) : num(y.after, stat) - num(x.after, stat)));
      const top = rows[0];
      const best = rows.find((r) => !held(r).length) ?? top;
      if (!best || !top) throw new ToolError(`The engine found no support that can go in group ${g.index}.`);
      const buffNote = (r: (typeof rows)[number]) => { const l = lose.get(r.from.name); return l ? `${r.from.name} is the build's only source of ${l.buff}: ${l.worth.map((w) => `${statLabel(w.statId)} ${formatStat(w.statId, w.with)} to ${formatStat(w.statId, w.without)}`).join(', ')}` : null; };
      // the winner's colour against the item's sockets (green Momentum into a red Brass Dome socket): say the recolour,
      // and the best swap that fits the sockets as they are
      const sockets = g.slot ? slotItemText(xml, g.slot)?.split(String.fromCharCode(10)).find((l) => l.startsWith('Sockets: '))?.slice(9).trim() : undefined;
      let socketColours: Record<string, unknown> | undefined;
      let fitRow: (typeof rows)[number] | undefined;
      if (sockets) {
        const colours = ctx.gems ?? new GemColours();
        const inSlot = (await slotGems(ctx, xml, g.slot)).map((x) => x.colour);
        const fitsWith = async (r: (typeof rows)[number]) => {
          const need = [...inSlot];
          const at = need.indexOf(COLOUR[await colours.of(r.from.name)]);
          if (at >= 0) need.splice(at, 1);
          return socketFit(sockets, [...need, COLOUR[await colours.of(r.to.name)]]);
        };
        const fit = await fitsWith(best);
        if (!fit.fits) {
          let same: (typeof rows)[number] | undefined;
          for (const r of rows) if ((await fitsWith(r)).fits) { same = r; break; }
          fitRow = same;
          socketColours = {
            recolour: `${best.to.name} needs a ${{ R: 'red', G: 'green', B: 'blue' }[fit.missing[0] as 'R'] ?? fit.missing[0]} socket: ${g.slot} ${sockets} -> ${fit.sockets} in game (Chromatic Orbs or the crafting bench)`,
            ...(same ? { bestWithoutRecolour: { replace: same.from.name, with: same.to.name, stat: keyRows(before, same.after, [stat])[0], edits: [same.edit] } } : {}),
          };
        }
      }
      // the row with the most of the stat when the guards ranked it behind the pick (Additional Accuracy for Fortify, +15.6%): said and
      // offered with why, never left for the answer to call a weaker card the next-strongest
      // a row that puts in the gem the swap puts in (Momentum for Fortify after Momentum for Close Combat) is no option: one copy counts
      const made = socketColours && fitRow ? fitRow : best;
      const goesIn = made.to.name;
      const byStat = rows.filter((r) => r.to.name !== goesIn).sort((x, y) => num(y.after, stat) - num(x.after, stat))[0];
      const heldTop = top !== best && top.to.name !== goesIn ? top : byStat && byStat !== best && num(byStat.after, stat) > num(made.after, stat) ? byStat : undefined;
      const bySupport = supports.map((p) => {
        const r0 = rows.find((x) => x.from === p);
        // a slot whose best calculated replacement does not gain names none: the table never shows a loser as "the best replacement"
        const r = r0 && num(r0.after, stat) > num(base, stat) ? r0 : undefined;
        return { support: p.name, gem: p.index, ...(r ? { bestReplacement: r.to.name, stat: keyRows(base, r.after, [stat])[0], effectiveHP: `Effective HP ${pct(num(base, 'TotalEHP'), num(r.after, 'TotalEHP')) || '+0%'}${p === fortify ? ' (its fortification counted)' : ''}` } : { bestReplacement: null, note: 'nothing calculated beats it here' }) };
      });
      // the new gem's attribute requirement at its level against the character's, with the swap made
      const reqOf = (row: (typeof rows)[number]) => withScratch(ctx, xml, async (c) => {
        await applyEdits(ctx, c, [row.edit], num(before, 'FullDPS') > 0);
        const [reqs, s] = await Promise.all([gemReqs(ctx, c), statMap(ctx, c)]);
        const q = reqs.find((x) => x.group === g.index && x.gem === row.from.index);
        if (!q) return undefined;
        const need = q.reqAt(q.level).map((v, i) => [['Str', 'Dex', 'Int'][i]!, v] as const).filter(([, v]) => v > 0);
        return `${row.to.name} level ${q.level} needs ${need.length ? need.map(([a, v]) => `${a} ${v} of ${num(s, a)}${v > num(s, a) ? ` (${v - num(s, a)} short)` : ''}`).join(', ') : 'no attributes'}`;
      }).catch(() => undefined);
      const requirement = await reqOf(best);
      // each level-adding gem in its best slot, with its number, so the answer shows why it won or lost (Awakened Empower)
      const levelRows = [...new Set(rows.filter((r) => /^(Awakened )?Empower\b/.test(r.to.name)).map((r) => r.to.name))].map((n) => rows.filter((r) => r.to.name === n).sort((x, y) => num(y.after, stat) - num(x.after, stat))[0]!);
      const reqs = new Map(await Promise.all([best, ...levelRows].map(async (r) => [r.to.name, r === best ? requirement : await reqOf(r)] as const)));
      const prices = await priceOf(ctx, [...reqs.keys()].filter((n) => /^(Awakened|Exceptional)|Empower|Enlighten|Enhance/.test(n)), (n) => Number(/ level (\d+) needs/.exec(reqs.get(n) ?? '')?.[1]) || undefined);
      const price = prices.get(best.to.name);
      const levelGems = await Promise.all(levelRows.map(async (r) => {
        const row = keyRows(base, r.after, [stat])[0]!;
        const req = reqs.get(r.to.name);
        const p = prices.get(r.to.name);
        return { gem: r.to.name, inPlaceOf: r.from.name, stat: row, ...(r === best ? { applied: true } : {}), requirement: req, ...(p ? { price: p } : {}), line: `${r.to.name} in place of ${r.from.name}: ${row.label} ${row.beforeShown} -> ${row.afterShown} (${row.percent ?? 0}%)${req ? `; ${req}` : ''}${p ? `; price ${p}` : ''}`, ...(r === best || !((row.percent ?? 0) > 0) ? {} : { edits: [r.edit] }) };
      }));
      // a fatal problem whose measured fix beats the swap (Precise Technique off for low accuracy) leads the answer
      const fat = await fatal;
      const swapPct = keyRows(base, best.after, [stat])[0]?.percent ?? 0;
      const lead = (('fatalFirst' in fat ? fat.fatalFirst : undefined) ?? []).findIndex((f) => (f.gainPct ?? 0) > swapPct);
      // each level-adding gem not picked that gains is offered as its own card, so its engine numbers show whatever the answer
      // says; a swap that loses gets no card (two losing Empower cards, none for the best)
      const propose = TOOLS.find((t) => t.name === 'proposeEdit');
      // the best swap that fits the sockets as they are comes first (Pierce +27% was behind a weak Awakened Empower card), then the level gems by gain
      const fitSwap = (socketColours as { bestWithoutRecolour?: { replace: string; with: string; stat: { label: string; beforeShown: string; afterShown: string; percent: number | null }; edits: ToolEdit[]; card?: string } } | undefined)?.bestWithoutRecolour;
      // the same guards' inputs for the fitting swap, so the app can make it when the top pick needs a recolour
      if (fitSwap && fitRow) {
        const fr = fitRow;
        const req = fr === best ? requirement : await reqOf(fr);
        const pr = (await priceOf(ctx, /^(Awakened|Exceptional)|Empower|Enlighten|Enhance/.test(fr.to.name) ? [fr.to.name] : [], () => Number(/ level (\d+) needs/.exec(req ?? '')?.[1]) || undefined)).get(fr.to.name);
        Object.assign(fitSwap, { replaceGem: fr.from.index, requirement: req, side: keyRows(base, fr.after, SIDE.filter((id) => id !== stat)), ...(buffNote(fr) ? { losesBuff: buffNote(fr) } : {}), ...(pr ? { price: pr } : {}) });
      }
      if (fitSwap && propose && (fitSwap.stat.percent ?? 0) > 0) {
        const line = `${fitSwap.with} in place of ${fitSwap.replace}, fits your sockets as they are: ${fitSwap.stat.label} ${fitSwap.stat.beforeShown} -> ${fitSwap.stat.afterShown} (+${fitSwap.stat.percent}%)`;
        const card = await propose.run({ title: `${fitSwap.with} in place of ${fitSwap.replace}`, summary: line, edits: fitSwap.edits, offer: true }, ctx).catch(() => null) as { proposalId?: string } | null;
        if (card?.proposalId) fitSwap.card = 'offered as a card (one tap)';
      }
      levelGems.sort((x, y) => (y.stat.percent ?? 0) - (x.stat.percent ?? 0));
      for (const x of levelGems) {
        // a level gem that gains less than the swap already offered (and costs 100+ div) is no card: each one is ~4 s of the turn
        if (!('edits' in x) || !x.edits || !propose || !((x.stat.percent ?? 0) > Math.max(0, fitSwap?.stat.percent ?? 0))) continue;
        // a level gem in the socket of the held top pick (Awakened Empower for Fortify) loses the same buff for less: the held pick's card is the app's
        if (heldTop && x.inPlaceOf === heldTop.from.name && (x.stat.percent ?? 0) <= (keyRows(base, heldTop.after, [stat])[0]?.percent ?? 0)) continue;
        const card = await propose.run({ title: `${x.gem} in place of ${x.inPlaceOf}`, summary: x.line, edits: x.edits, offer: true }, ctx).catch(() => null) as { proposalId?: string } | null;
        if (card?.proposalId) Object.assign(x, { card: 'offered as a card (one tap)' });
      }
      // one line per turned-on support, each with its best replacement and the stat it gives: the answer can show that every slot was tried
      const matrix = bySupport.map((x) => (x.bestReplacement ? `${x.support} -> ${x.bestReplacement}: ${(x as { stat: { label: string; beforeShown: string; afterShown: string; percent: number | null } }).stat.label} ${(x as { stat: { beforeShown: string } }).stat.beforeShown} -> ${(x as { stat: { afterShown: string } }).stat.afterShown} (${(x as { stat: { percent: number | null } }).stat.percent ?? 0}%)` : `${x.support}: nothing calculated beats it here`));
      // No swap gains: the next best lever for the same stat, as a one-tap card with its own engine number.
      // shortcut: free passive points and the main skill gem's level and quality only; add other levers here as they get tools.
      let nextBest: { line: string; stat: ReturnType<typeof keyRows>[number]; card?: string } | undefined;
      let noNextBest: string | undefined;
      if (swapPct <= 0 && propose) {
        const options: Array<{ what: string; edits: BuildEdit[]; after: Record<string, Scalar> }> = [];
        const sp = await spendFresh(ctx, stat).catch(() => null) as { edits?: BuildEdit[]; pointsUsed?: number } | null;
        if (sp?.edits?.length) {
          const after = await withScratch(ctx, xml, async (c) => { await applyEdits(ctx, c, sp.edits as unknown as ToolEdit[], num(before, 'FullDPS') > 0); return statMap(ctx, c); }).catch(() => null);
          if (after) options.push({ what: `Spend the ${sp.pointsUsed} free passive point${sp.pointsUsed === 1 ? '' : 's'}`, edits: sp.edits, after });
        }
        const active = g.gems.find((x) => !x.support && x.enabled);
        if (active) {
          const edits: BuildEdit[] = [
            ...((active.quality ?? 0) < 20 ? [{ kind: 'setGem', group: g.index, gem: active.index, attr: 'quality', value: 20 } as BuildEdit] : []),
            ...((active.level ?? 0) < 21 ? [{ kind: 'setGem', group: g.index, gem: active.index, attr: 'level', value: (active.level ?? 20) + 1 } as BuildEdit] : []),
          ];
          if (edits.length) {
            const after = await withScratch(ctx, xml, async (c) => { await applyEdits(ctx, c, edits as unknown as ToolEdit[], num(before, 'FullDPS') > 0); return statMap(ctx, c); }).catch(() => null);
            if (after) options.push({ what: `${active.name} to ${(active.quality ?? 0) < 20 ? 'quality 20' : ''}${(active.quality ?? 0) < 20 && (active.level ?? 0) < 21 ? ' and ' : ''}${(active.level ?? 0) < 21 ? `level ${(active.level ?? 20) + 1} (a Vaal Orb or +level gear, not free)` : ''}`, edits, after });
          }
        }
        const top = options.filter((o) => num(o.after, stat) > num(before, stat)).sort((x, y) => num(y.after, stat) - num(x.after, stat))[0];
        if (top) {
          const row = keyRows(before, top.after, [stat])[0]!;
          const line = `${top.what}: ${row.label} ${row.beforeShown} -> ${row.afterShown} (+${row.percent ?? 0}%)`;
          const card = await propose.run({ title: top.what, summary: line, edits: top.edits, offer: true }, ctx).catch(() => null) as { proposalId?: string } | null;
          nextBest = { line, stat: row, ...(card?.proposalId ? { card: 'offered as a card (one tap)' } : {}) };
        } else {
          const act = g.gems.find((x) => !x.support && x.enabled);
          noNextBest = `No swap gains ${statLabel(stat)} and nothing else the engine can try does: ${sp?.edits?.length ? 'the free passive points add none' : 'there are no free passive points'}, and ${act ? `${act.name} is already at level ${act.level ?? 20}${(act.quality ?? 0) >= 20 ? ' with quality 20' : ''}` : 'the main skill gem has no level to add'}. Say so plainly.`;
        }
      }
      return {
        buildChanged: false,
        group: g.index,
        skill: g.gems.find((x) => !x.support)?.name ?? null,
        rankedBy: stat,
        now: num(before, stat),
        supportsRanked: pool.length,
        calculated: rows.length,
        replace: { name: best.from.name, gem: best.from.index },
        with: { name: best.to.name, gemId: best.to.id, ...(price ? { price } : {}) },
        stat: keyRows(base, best.after, [stat])[0],
        side: keyRows(base, best.after, SIDE.filter((id) => id !== stat)),
        bySupport,
        matrix,
        ...(nextBest ? { nextBest } : {}),
        ...(noNextBest ? { noNextBest } : {}),
        tested: [...new Set(rows.map((r) => r.to.name))],
        supportsLine,
        ...(legacyNotTested ? { legacyNotTested } : {}),
        ...(fillTurnedOff ? { fillTurnedOff } : {}),
        ...(levelGems.length ? { levelGems } : {}),
        ...(requirement ? { requirement } : {}),
        ...(fortify ? { defence: `Fortify stays counted: its fortification is in effective HP while it is in the group${cfg.values.buffFortification ? '' : ' (counted as if "Are you Fortified?" were on, which Fortify supplies on melee hits)'}` } : {}),
        ...(socketColours ? { socketColours } : {}),
        ...(buffNote(best) ? { losesBuff: buffNote(best) } : {}),
        ...(heldTop ? { unguardedBest: { replace: heldTop.from.name, with: heldTop.to.name, stat: keyRows(before, heldTop.after, [stat])[0], loses: buffNote(heldTop) ?? (ehpLoss(heldTop) > TRADE / 100 ? `it costs Effective HP ${pct(num(base, 'TotalEHP'), num(heldTop.after, 'TotalEHP'))}` : null), edits: [heldTop.edit] } } : {}),
        edits: [best.edit],
        ...fat,
        note: `${lead >= 0 ? `Open the answer with fatalFirst[${lead}] and its fix: it adds more damage (its gainPct) than the best swap (stat.percent), so it comes before the swap. ` : ''}The engine ranked every support gem for each support of the group and calculated the strongest swaps on a scratch copy. Say every matrix line (one per support: its best replacement and the stat it gives), so the player sees each slot was tried, and when no swap gains, say nextBest.line as the next best way (already on screen as a one-tap card) or, when there is none, noNextBest. Right after the best swap, say each levelGems line word for word ({{ref:levelGems[0].line}}): the level-adding gems the player will ask about, with their numbers. An entry with card is already on screen as a one-tap card with its engine numbers: say so in a few words, never make it again. edits makes the best swap: pass it to proposeEdit unchanged. replace is the support it gives up, the weakest for this stat. When socketColours is present, say the recolour the swap needs in game, and bestWithoutRecolour (the best swap that fits the sockets as they are; with card it is already on screen as the first one-tap card: say so) in one line. Say requirement (the new gem\'s attributes against yours) and with.price when present, and that tested lists every gem calculated. Count the group's supports only with supportsLine, word for word ({{ref:supportsLine}}). Say legacyNotTested in one line when present. fillTurnedOff puts the best support in the socket of a turned-off support (a socket the group already has, doing nothing) and turns it on: when present, apply its edits with proposeEdit first (it adds damage without giving up a support) and say its line; the best swap then counts only if it still gains. A defence support (Fortify) is ranked with its effective HP counted: never call it the weakest on damage alone. Say defence in one line: the defence support was kept for its effective HP even when it adds the least damage. losesBuff is a buff the replaced support was the only source of, already counted in the numbers: say it. unguardedBest is a stronger swap held back because it gives up a buff that keeps a max hit up: offer it in one line with what it loses, never apply it yourself.`,
      };
    },
  },
];

/** Gems the other slots calculate after the first slot ranked the whole pool. */
const PRUNE_TO = 60;
const GEM_POWER_FIELDS = new Set(['FullDPS', 'CombinedDPS', 'TotalDPS', 'AverageDamage', 'TotalDot', 'BleedDPS', 'IgniteDPS', 'TotalPoisonDPS', 'TotalEHP']);

/** Whether the player's own words talk about their character's level (it levelled up): the only reason the build's level may move. */
export function playerSaysLevel(text: string): boolean {
  return /\b(level|levels|lvl|levell?ed|leveled|levelling|leveling)\b/i.test(text);
}
/**
 * The passives an item card respecs to fit its attributes, from the fit's own "Took ..., gave up ...: ..." line (the Perseverance
 * card removed Swift Venoms and two more, and the answer never said so). Empty when the card changes no passive.
 */
export function respecNote(lines: string[] | undefined): string {
  const took = (lines ?? []).find((l) => /^Took /.test(l));
  if (!took) return '';
  return `The card also respecs passives: it ${took.replace(/^Took /, 'takes ').replace(', gave up ', ' and gives up ').replace(/: [^:]*$/, '')}.`;
}
