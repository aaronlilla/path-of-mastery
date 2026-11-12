// What a seasoned player checks after a build change: only damage the build
// keeps in play counts, a broken attribute requirement is fixed the cheapest way, and every side effect is said with numbers.
// Shared by trial() (proposeEdit, previewEquip) and bestUnique.
import type { StatValue } from '@pom/protocol';
import { formatStat, statMeta } from '../../shared/assistant/statLabels.js';
import { activeSetOf, readItems, slotItemId } from '../../shared/itemsXml.js';
import { buildSidebar, DEFAULT_NUMBER_FORMAT, minionDisplayStats, normaliseOutput } from '../../renderer/displayStats.js';
import { readConfig, readEquipped } from './buildReaders.js';
import { fitGemLevels, gemCatalog, unmetGems } from './gemFit.js';
import { benchCraftRows, benchSuffixes, manaCrafts, openSuffixes, slotItemText } from './itemFit.js';
import { cheapestEndNodes, isAscendancy, nodePower, pointBudget, takeEdit } from './rankTools.js';
import { settleAfter, statMap, toBuildEdit, withScratch, xmlOf, type Scalar, type ToolContext, type ToolEdit } from './tools.js';

const num = (s: Record<string, Scalar>, id: string) => (typeof s[id] === 'number' ? (s[id] as number) : 0);
const dpsOf = (s: Record<string, Scalar>) => (num(s, 'FullDPS') > 0 ? 'FullDPS' : 'CombinedDPS');
const show = (id: string, v: number) => formatStat(id, v);
const pct = (from: number, to: number) => (from ? `${to >= from ? '+' : '-'}${Math.abs(Math.round(((to - from) / Math.abs(from)) * 1000) / 10)}%` : '');

/**
 * The build counts its flasks as active (the Items tab switches), but the engine reads "while affected by no Flasks" before it
 * applies them, so a Screams of the Desiccated shrine buff showed +24M Full DPS on a five-flask build. the config's own
 * "Do you have a Flask active?" option makes the engine see it: this is that edit, or null when no flask is on or it is set.
 */
export function flasksOnEdit(xml: string): ToolEdit | null {
  const flasks = [...activeSetOf(readItems(xml)).slots.values()].filter((s) => /^Flask \d$/.test(s.name) && s.itemId && s.active);
  if (!flasks.length || readConfig(xml).some((c) => c.name === 'conditionUsingFlask' && c.value === true)) return null;
  return { kind: 'setConfig', key: 'conditionUsingFlask', value: true };
}

/** Puts `edit` on `buildId` and waits for its Full DPS. */
export async function applyEdits(ctx: ToolContext, buildId: string, edits: ToolEdit[], fullDps: boolean): Promise<void> {
  for (const e of edits) {
    const settled = settleAfter(ctx, buildId, fullDps);
    // no FullDPS event follows an edit the engine finished in its reply: waiting for one only ran out the clock
    if ((await ctx.engine.send('edit', { buildId, edit: toBuildEdit(e) })).fullDpsPending ?? true) await settled();
  }
}

/** The warnings printed under the stats (the getWarnings tool reads the same list). */
export async function buildWarnings(ctx: ToolContext, buildId: string): Promise<string[]> {
  const [{ stats }, skill, budget] = await Promise.all([ctx.engine.send('getStats', { buildId }), ctx.engine.send('mainSkill', { buildId }), pointBudget(ctx, buildId)]);
  const raw = Object.fromEntries(stats.map((s: StatValue) => [s.id, s.value])) as Record<string, unknown>;
  return [...budget.warnings, ...statWarnings(raw, skill)].filter((w, i, all) => all.indexOf(w) === i);
}

/** The sidebar warnings of one getStats result (the Minion block included), without the point budget ones. */
export function statWarnings(raw: Record<string, unknown>, skill: { flags: string[]; minion?: { flags: string[] } | null }): string[] {
  const player = buildSidebar(normaliseOutput(raw), new Set(skill.flags), DEFAULT_NUMBER_FORMAT).warnings;
  const minionOut = raw.Minion;
  const minion = minionOut && typeof minionOut === 'object' ? buildSidebar(normaliseOutput(minionOut as Record<string, unknown>), new Set(skill.minion?.flags ?? []), DEFAULT_NUMBER_FORMAT, minionDisplayStats, 'minion').warnings : [];
  return [...minion, ...player];
}

/** Per-type max hit: EHP counts avoidance, these say what one hit you survive (+48.7% EHP while every max hit fell 20%). */
export const MAX_HITS = ['Physical', 'Fire', 'Cold', 'Lightning', 'Chaos'].map((t) => `${t}MaximumHitTaken`);
const pctOf = (v: number) => `${Math.round(v)}%`;
/** Recovery per second, ES recharge only while it still applies (Ghost Reaver: "Cannot Recharge Energy Shield"). */
export const RECOVERY: Array<[string, string]> = [
  ['LifeRegenRecovery', 'Life regeneration'], ['LifeLeechRate', 'Life leech'], ['EnergyShieldRegenRecovery', 'Energy shield regeneration'],
  ['EnergyShieldLeechRate', 'Energy shield leech'], ['EnergyShieldRecharge', 'Energy shield recharge'], ['ManaRegenRecovery', 'Mana regeneration'], ['ManaLeechRate', 'Mana leech'],
];
export const recoveryOf = (s: Record<string, Scalar>, id: string) => (id === 'EnergyShieldRecharge' && (s.EnergyShieldRechargeAppliesToEnergyShield === false || !num(s, 'EnergyShield')) ? 0 : num(s, id));
/** "Life leech 119/s -> 0/s" for every recovery source either side has. */
export const recoveryRows = (before: Record<string, Scalar>, after: Record<string, Scalar>) =>
  RECOVERY.filter(([id]) => recoveryOf(before, id) || recoveryOf(after, id)).map(([id, label]) => {
    // before and after apart, so a sentence that names the stat itself does not say it twice ("drops from Energy shield recharge 223/s -> 0/s")
    const [b, a] = [`${Math.round(recoveryOf(before, id))}/s`, `${Math.round(recoveryOf(after, id))}/s`];
    return { stat: id, shown: `${label} ${b} -> ${a}`, before: b, after: a };
  });
const LAYERS: Array<[string, string]> = [['SpellSuppressionChance', 'Spell suppression'], ['BlockChance', 'Block'], ['SpellBlockChance', 'Spell block'], ...RECOVERY.filter(([id]) => !id.startsWith('Mana'))];
const AILMENTS = ['Freeze', 'Chill', 'Shock', 'Ignite', 'Poison', 'Bleed', 'Stun'];

/**
 * What a change switches off that the build already had: an existing defence layer (suppression, block,
 * a capped resist, an ailment immunity, a leech or recovery source) losing over half its value, and with `maxHits` any
 * per-type max hit that drops. One plain line each; empty when nothing breaks.
 */
export function guardBreaks(before: Record<string, Scalar>, after: Record<string, Scalar>, maxHits = true): string[] {
  const out: string[] = [];
  for (const [id, label] of LAYERS) {
    const b = id === 'EnergyShieldRecharge' ? recoveryOf(before, id) : num(before, id);
    const a = id === 'EnergyShieldRecharge' ? recoveryOf(after, id) : num(after, id);
    // spell suppression is a layer the build paid for: five points lost already counts, not only half
    if (b <= 0 || (a >= b * 0.5 && !(id === 'SpellSuppressionChance' && b - a >= 5))) continue;
    const fmt = RECOVERY.some(([r]) => r === id) ? (v: number) => `${Math.round(v)}/s` : pctOf;
    const dodge = id === 'SpellSuppressionChance' && num(after, 'SpellDodgeChance') > num(before, 'SpellDodgeChance') ? ` (chance to dodge spell hits ${pctOf(num(before, 'SpellDodgeChance'))} -> ${pctOf(num(after, 'SpellDodgeChance'))} instead, as the keystone words it: a dodged-or-not coin flip, not less damage from every spell)` : '';
    out.push(`${label} ${fmt(b)} -> ${fmt(a)}${dodge}`);
  }
  for (const e of ['Fire', 'Cold', 'Lightning']) {
    const id = `${e}Resist`;
    if (num(before, id) >= num(before, `${id}Max`) && num(before, id) > 0 && num(after, id) < num(after, `${id}Max`)) out.push(`${e} resistance ${pctOf(num(before, id))} -> ${pctOf(num(after, id))} (under its ${pctOf(num(after, `${id}Max`))} cap)`);
  }
  for (const a of AILMENTS) if (num(before, `${a}AvoidChance`) >= 100 && num(after, `${a}AvoidChance`) < 100) out.push(`${a} immunity lost (avoid ${pctOf(num(before, `${a}AvoidChance`))} -> ${pctOf(num(after, `${a}AvoidChance`))})`);
  if (maxHits) for (const id of MAX_HITS) if (num(before, id) > 0 && num(after, id) < num(before, id) * 0.995) out.push(`${statMeta(id).label} ${show(id, num(before, id))} -> ${show(id, num(after, id))} (${pct(num(before, id), num(after, id))})`);
  return out;
}

/** "Max hit taken: physical 15.4k -> 12.3k (-20.3%), fire ..." for the rows that moved, or null. */
export function maxHitLine(before: Record<string, Scalar>, after: Record<string, Scalar>): string | null {
  const moved = MAX_HITS.filter((id) => typeof after[id] === 'number' && num(after, id) !== num(before, id));
  if (!moved.length) return null;
  return `Max hit taken: ${MAX_HITS.filter((id) => typeof after[id] === 'number').map((id) => `${id.replace('MaximumHitTaken', '').toLowerCase()} ${show(id, num(before, id))} -> ${show(id, num(after, id))}${moved.includes(id) ? ` (${pct(num(before, id), num(after, id))})` : ''}`).join(', ')}`;
}

const POOLS = ['Life', 'EnergyShield', 'Mana', 'TotalEHP'];
const RESISTS = ['Fire', 'Cold', 'Lightning', 'Chaos'];
const DEFENCE = ['SpellSuppressionChance', 'BlockChance', 'SpellBlockChance', 'EffectiveMovementSpeedMod'];
/** One checked change, read in an answer by its stat id: {{ref:sideEffects[Life].shown}}. */
export interface SideEffect { stat: string; shown: string; before?: string; after?: string }

/**
 * The player's checks on `before` vs `after`, one plain line per change with both numbers. `hard` is anything that breaks the
 * build in game: a new warning (unmet requirement, unpayable cost, over-reservation, too many points) or an elemental resist
 * that sat at its cap falling under it. Warnings are only compared when both lists are given.
 */
/** The main skill's mana per second against mana regen and leech, before and after (Enlighten in place of Lifetap, a ring with less mana cost reduction). */
export function manaSustainLine(before: Record<string, Scalar>, after: Record<string, Scalar>): string {
  const side = (s: Record<string, Scalar>) => ({ cost: num(s, 'ManaPerSecondCost'), back: num(s, 'ManaRegenRecovery') + num(s, 'ManaLeechRate') });
  const [b, a] = [side(before), side(after)];
  const r = (v: number) => `${Math.round(v * 10) / 10}/s`;
  // no "Mana:" heading of its own: the answer puts the line under its own (it once printed "Mana: ... Mana: the skill costs")
  const pair = (x: number, y: number) => (r(x) === r(y) ? r(y) : `${r(x)} -> ${r(y)}`);
  const old = b.cost > b.back && a.cost > a.back;
  return `The skill costs ${pair(b.cost, a.cost)} mana against regeneration and leech ${pair(b.back, a.back)}, ${a.cost <= a.back ? 'still covered' : old ? `already short by ${r(b.cost - b.back)} before this change and now ${r(a.cost - a.back)}: more mana leech, regeneration or a lower mana cost would pay it` : `short by ${r(a.cost - a.back)}, so the skill drains mana while you use it`}`;
}

export function sideEffects(before: Record<string, Scalar>, after: Record<string, Scalar>, warnBefore?: string[], warnAfter?: string[]): { lines: SideEffect[]; hard: string[] } {
  const lines: SideEffect[] = [];
  // a stat line also carries both values alone, so an answer can write "from {{before}} to {{after}}"
  const add = (stat: string, shown: string) => lines.push({ stat, shown, ...(typeof after[stat] === 'number' ? { before: show(stat, num(before, stat)), after: show(stat, num(after, stat)) } : {}) });
  const hard: string[] = [];
  const dps = dpsOf(before);
  const moved = (id: string) => typeof after[id] === 'number' && num(after, id) !== num(before, id);
  // a change that moves the skill's mana cost or the mana coming back says whether the skill stays castable
  // a skill that already drained mana before the change and still does, by about the same amount, is not the change's cost
  const gapOf = (x: Record<string, Scalar>) => num(x, 'ManaPerSecondCost') - (num(x, 'ManaRegenRecovery') + num(x, 'ManaLeechRate'));
  // one that gets shorter is said, by however little: deepening an old shortfall unsaid is a break
  const alreadyShort = gapOf(before) > 0 && gapOf(after) > 0 && gapOf(after) <= gapOf(before) + 0.5;
  if (num(after, 'ManaPerSecondCost') > 0 && !alreadyShort && ['ManaPerSecondCost', 'ManaRegenRecovery', 'ManaLeechRate'].some(moved)) lines.push({ stat: 'ManaSustain', shown: manaSustainLine(before, after) });
  for (const id of [dps, ...POOLS]) {
    if (!moved(id) || !(num(before, id) || num(after, id))) continue;
    const big = Math.abs(num(before, id)) >= 1000;
    add(id, `${statMeta(id).label} ${show(id, num(before, id))} -> ${show(id, num(after, id))} (${big ? pct(num(before, id), num(after, id)) : `${num(after, id) >= num(before, id) ? '+' : ''}${Math.round(num(after, id) - num(before, id))}`})`);
  }
  for (const e of RESISTS) {
    const id = `${e}Resist`;
    // a capped resist that stays capped can still lose its buffer over the cap (Woe Corona's fire resistance)
    if (!moved(id) && moved(`${id}OverCap`)) add(`${id}OverCap`, `${statMeta(id).label} stays ${show(id, num(after, id))}; over the cap ${Math.round(num(before, `${id}OverCap`))}% -> ${Math.round(num(after, `${id}OverCap`))}%`);
    if (!moved(id)) continue;
    const cap = num(after, `${id}Max`) || 75;
    const line = `${statMeta(id).label} ${show(id, num(before, id))} -> ${show(id, num(after, id))} (cap ${cap}%)`;
    add(id, line);
    if (e !== 'Chaos' && num(before, id) >= num(before, `${id}Max`) && num(after, id) < cap) hard.push(line);
  }
  if (!RESISTS.some((e) => moved(`${e}Resist`))) add('Resists', `Resistances unchanged: ${RESISTS.map((e) => `${e.toLowerCase()} ${show(`${e}Resist`, num(after, `${e}Resist`))}`).join(', ')}`);
  for (const a of ['Str', 'Dex', 'Int']) {
    if (!moved(a)) continue;
    const req = num(after, `Req${a}`);
    add(a, `${statMeta(a).label} ${num(before, a)} -> ${num(after, a)}${req ? ` (gear and gems need ${req})` : ''}`);
  }
  // an effective HP or life change always says what one hit the build survives, and what defence it switched off
  const off = guardBreaks(before, after, false).filter((b) => !/resistance/.test(b));
  for (const id of DEFENCE) if (moved(id) && num(after, id) < num(before, id) && !off.some((b) => b.startsWith(statMeta(id).label.replace(/ chance$/i, '')))) add(id, `${statMeta(id).label} ${show(id, num(before, id))} -> ${show(id, num(after, id))}`);
  // evade chance by hit type: a keystone that trades one for the other says both (Arrow Dancing's less evasion against melee)
  if (moved('MeleeEvadeChance') || moved('ProjectileEvadeChance')) {
    const ev = (id: string) => `${Math.round(num(before, id))}% -> ${Math.round(num(after, id))}%`;
    lines.push({ stat: 'EvadeChance', shown: `Chance to evade melee hits ${ev('MeleeEvadeChance')}, projectiles ${ev('ProjectileEvadeChance')}` });
  }
  const hits = moved('TotalEHP') || moved('Life') ? maxHitLine(before, after) : null;
  if (hits) lines.push({ stat: 'MaxHits', shown: hits });
  // a layer that keeps some of itself dropped, it did not stop ("Switched off: Life leech 929/s -> 251/s")
  for (const [i, b] of off.entries()) lines.push({ stat: `LayerLost${i}`, shown: `${/-> 0(?:\/s|%)?(?: |$)/.test(b) ? 'Switched off' : 'Dropped by over half'}: ${b}` });
  for (const b of off) if (/suppression/i.test(b)) hard.push(`${b}: a defence layer lost`);
  const cap = num(after, 'DotDpsCap');
  if (cap && num(after, 'FullDotDPS') >= cap && num(before, 'FullDotDPS') < cap) add('FullDotDPS', `Damage over time reaches the game's cap of ${show('FullDPS', cap)} per second: the engine already leaves out what goes past it`);
  if (warnBefore && warnAfter) {
    for (const w of warnAfter.filter((x) => !warnBefore.includes(x) && !/Dot DPS exceeds in game limit/i.test(x))) { add(`NewWarning${lines.length}`, `New warning: ${w}`); hard.push(w); }
    // said as what is met now, so it reads after "That fixes" ("That fixes Fixed warning: You do not meet ...")
    for (const w of warnBefore.filter((x) => !warnAfter.includes(x))) { const m = /^You do not meet the (.+)$/.exec(w); add(`FixedWarning${lines.length}`, m ? `Meets the ${m[1]} now` : `Clears the warning "${w}"`); }
    for (const w of warnAfter.filter((x) => warnBefore.includes(x) && !/Dot DPS exceeds/i.test(x))) add(`OldWarning${lines.length}`, `Still there from before: ${w}`);
  }
  return { lines, hard };
}

export interface ReqWay { way: string; dpsPct: number; ehpPct: number; score: number }
export interface ReqFix {
  edits: ToolEdit[];
  lines: string[];
  unfixed: string[];
  after: Record<string, Scalar>;
  /** The ways a player has, each calculated on a copy; `chosen` keeps the most damage plus effective HP. */
  chosen?: string;
  options: ReqWay[];
}

/** The end nodes to give up for `drop` owed points, cheapest first, never an attribute node; null when there are too few. */
export function refundNodes(ranked: number[], drop: number, isAttr: (id: number) => boolean): number[] | null {
  const give = ranked.filter((id) => !isAttr(id)).slice(0, drop);
  return give.length < drop ? null : give;
}

/** Attribute from the passive tree for the gems that lost it: free points first, then up to `swapPoints` bought by giving up the end nodes that cost the least. */
async function attributeFromTree(ctx: ToolContext, copy: string, short: Array<{ attr: { name: string; need: number } }>, ignore: Set<string>, fullDps: boolean, swapPoints: number) {
  const target = new Map<string, number>();
  for (const g of short) target.set(g.attr.name, Math.max(target.get(g.attr.name) ?? 0, g.attr.need));
  const all = await ctx.tree.all((await ctx.engine.send('treeState', { buildId: copy })).tree.treeVersion);
  const name = (id: number) => all.get(id)?.name ?? `node ${id}`;
  const start = await statMap(ctx, copy);
  let now = start;
  let free = Math.max(0, (await pointBudget(ctx, copy)).passive.left);
  const usedFree = free;
  let swap = swapPoints;
  const edits: ToolEdit[] = [];
  const took: string[] = [];
  const gave: string[] = [];
  const compared: string[] = [];
  for (let guard = 0; guard < 8; guard++) {
    const lack = [...target].find(([a, need]) => num(now, a) < need);
    if (!lack) break;
    const [attr, need] = lack;
    const room = free + swap;
    if (room <= 0) break;
    const ranked = [...(await nodePower(ctx, copy, attr, room)).values()]
      .filter((n) => !n.allocated && n.pathPower !== null && n.pathPower > 0 && n.dist > 0 && n.dist <= room && !isAscendancy(all.get(n.id)));
    // Every path (each mastery effect apart) is calculated by the engine and the one that covers the shortfall with the most
    // damage plus effective HP wins, free points before swapped ones: a Cyclopean Coil scales with the lowest attribute, so
    // the first path that reaches the number is not the best one. No path covers it: the most attribute per point.
    const opts = ranked
      .flatMap((n) => (n.effects?.length ? n.effects.filter((x) => (x.pathPower ?? 0) > 0).map((x) => ({ n, gain: x.pathPower!, edit: { kind: 'pickMastery', nodeId: n.id, effectId: x.e } as ToolEdit })) : [{ n, gain: n.pathPower!, edit: takeEdit(n) as ToolEdit }]))
      .sort((x, y) => y.gain / y.n.dist - x.gain / x.n.dist || y.gain - x.gain)
      .slice(0, 12);
    const dps = dpsOf(now);
    const scored: Array<(typeof opts)[number] & { after: Record<string, Scalar>; score: number }> = [];
    for (const o of opts) {
      const r = await ctx.engine.send('previewEdit', { buildId: copy, edit: toBuildEdit(o.edit), full: true }).catch(() => null);
      if (!r || r.blocked) continue;
      const after = { ...now };
      for (const c of r.statDiff.changed) if (c.after === null || typeof c.after !== 'object') after[c.statId] = c.after as Scalar;
      const rel = (id: string) => (num(now, id) ? ((num(after, id) - num(now, id)) / num(now, id)) * 100 : 0);
      scored.push({ ...o, after, score: rel(dps) + rel('TotalEHP') });
    }
    const covering = (maxDist: number) => scored.filter((o) => o.n.dist <= maxDist && num(o.after, attr) >= need).sort((x, y) => Math.max(0, x.n.dist - free) - Math.max(0, y.n.dist - free) || y.score - x.score || x.n.dist - y.n.dist)[0]; // a swapped path's score leaves out the end nodes it gives up: fewest swapped points first
    const pick = covering(free) ?? covering(room) ?? scored[0];
    if (!pick) break;
    const others = scored.filter((o) => o !== pick).sort((x, y) => y.score - x.score).slice(0, 3);
    const label = (o: (typeof scored)[number]) => `${name(o.n.id)} (${o.n.dist} point${o.n.dist === 1 ? '' : 's'}${o.n.dist > free ? `, ${o.n.dist - free} by giving up end nodes` : ''}: ${attr} ${num(o.after, attr)}${['Str', 'Dex', 'Int'].filter((a) => a !== attr && num(o.after, a) !== num(now, a)).map((a) => `, ${a} ${num(o.after, a)}`).join('')}, ${statMeta(dps).label} ${pct(num(now, dps), num(o.after, dps)) || '+0%'}, Effective HP ${pct(num(now, 'TotalEHP'), num(o.after, 'TotalEHP')) || '+0%'}${num(o.after, attr) < need ? `, ${attr} stays under ${need}` : ''})`;
    compared.push(`Compared ${scored.length} ${/^(Str|Dex|Int)$/.test(attr) ? 'attribute' : statMeta(attr).label} paths by ${statMeta(dps).label} and Effective HP: took ${label(pick)}${others.length ? `; next best ${others.map(label).join('; ')}` : ''}`);
    const was = new Set((await ctx.engine.send('treeState', { buildId: copy })).tree.allocated);
    const e = pick.edit;
    const depth = (await ctx.engine.send('history', { buildId: copy })).undo;
    const settled = settleAfter(ctx, copy, fullDps);
    if ((await ctx.engine.send('edit', { buildId: copy, edit: toBuildEdit(e) })).blocked) break;
    await settled();
    edits.push(e);
    took.push(`${name(pick.n.id)} (+${Math.round(pick.gain)} ${attr}, ${pick.n.dist} point${pick.n.dist === 1 ? '' : 's'})`);
    const fromFree = Math.min(free, pick.n.dist);
    free -= fromFree;
    const drop = pick.n.dist - fromFree;
    if (drop > 0) {
      swap -= drop;
      const path = (await ctx.engine.send('treeState', { buildId: copy })).tree.allocated.filter((id) => !was.has(id));
      // never give up an attribute node while fixing attributes (it gave back Int the build already lacked)
      const attrNode = (id: number) => (all.get(id)?.stats ?? []).some((s) => /Strength|Dexterity|Intelligence|Attributes/.test(s));
      const refund = refundNodes((await cheapestEndNodes(ctx, copy, all, path)).map(([id]) => id), drop, attrNode);
      if (!refund) {
        // the path cannot be paid for: take it back out so the tree stays inside the point budget
        for (let h = (await ctx.engine.send('history', { buildId: copy })).undo; h > depth; h--) await ctx.engine.send('undo', { buildId: copy });
        edits.pop();
        took.pop();
        free += fromFree;
        swap += drop;
        break;
      }
      for (const id of refund) {
        const d: ToolEdit = { kind: 'clickNode', nodeId: id };
        await applyEdits(ctx, copy, [d], fullDps);
        edits.push(d);
        gave.push(name(id));
      }
    }
    now = await statMap(ctx, copy);
  }
  if (!edits.length) return null;
  const fit = await fitGemLevels(ctx, copy, ignore);
  const attrs = [...target.keys()].map((a) => `${a} ${num(start, a)} -> ${num(now, a)}`).join(', ');
  const spent = usedFree - free;
  return {
    way: gave.length ? 'take attribute passives, giving up end nodes' : 'take attribute passives with free points',
    swapped: gave.length > 0,
    edits: [...edits, ...fit.edits],
    lines: [`Took ${took.join(', ')}${spent ? ` with ${spent} free point${spent === 1 ? '' : 's'}` : ''}${gave.length ? `, gave up ${gave.join(', ')}` : ''}: ${attrs}`, ...compared, ...fit.lines],
    freeLeft: free,
    took,
    gave,
    spent,
    unfixed: fit.unfixed,
    after: await statMap(ctx, copy),
  };
}

/**
 * Gem level edits on gems the damage number does not count (outside the main group and Full DPS) that drop over 5% of the
 * level: the number shows no cost, the gem still loses it (Wither 20 -> 11 called free). `buildId` holds the old levels.
 */
async function unmeasuredDrops(ctx: ToolContext, buildId: string, edits: ToolEdit[], fullDps: boolean) {
  const lowered = edits.filter((e): e is Extract<ToolEdit, { kind: 'setGem' }> => e.kind === 'setGem' && e.attr === 'level' && typeof e.value === 'number');
  if (!lowered.length) return [];
  const { state } = await ctx.engine.send('skillsState', { buildId });
  const counted = (i: number) => i === state.mainGroup || (fullDps && !!state.groups.find((g) => g.index === i)?.includeInFullDPS);
  return lowered.flatMap((e) => {
    const gem = state.groups.find((g) => g.index === e.group)?.gems.find((x) => x.index === e.gem);
    const drop = gem ? (gem.level - (e.value as number)) / gem.level : 0;
    return gem && !counted(e.group) && drop > 0.05 ? [{ name: gem.nameSpec, from: gem.level, to: e.value as number, drop }] : [];
  });
}

/**
 * Gems that were already short of Str/Dex/Int before the change (`before`, their keys) and still are on `buildId` (Wither's Int):
 * fixed in the same change when the engine finds it cheap (free points, or a lower gem level that costs
 * at most 1% of damage and of effective HP), else stated with what the fix would cost.
 */
export async function fixOldShortfalls(ctx: ToolContext, buildId: string, before: Set<string>, fullDps: boolean, points = true): Promise<{ edits: ToolEdit[]; lines: string[] }> {
  const still = (await unmetGems(ctx, buildId)).filter((g) => before.has(g.key));
  if (!still.length) return { edits: [], lines: [] };
  const base = await statMap(ctx, buildId);
  const dps = dpsOf(base);
  const xml = await xmlOf(ctx, buildId);
  const lower = await withScratch(ctx, xml, async (c) => ({ way: 'lowered', ...(await fitGemLevels(ctx, c, new Set())) }));
  // a lowered gem the damage number does not count still loses its level: over 5% of it, a point or a craft buys the attribute
  // instead when one does at no more than 5% (Wither 20 -> 11)
  const hidden = await unmeasuredDrops(ctx, buildId, lower.edits, fullDps);
  const ways: Array<{ way: string; edits: ToolEdit[]; lines: string[]; unfixed: string[]; after: Record<string, Scalar> }> = [lower];
  const free = (await pointBudget(ctx, buildId)).passive.left;
  // an item change (`points` false) takes free points only, and only to spare such a gem (Wither 20 -> 10, Increased AoE 20 -> 12)
  if (points ? free > 0 || hidden.length : free > 0 && hidden.length) {
    // free points only: refunding end nodes for an old shortfall was a silent respec that cost 14% Combined DPS and still left Wither
    // short; the gem goes to the level the build can use instead
    const swap = 0;
    const tree = await withScratch(ctx, xml, (c) => attributeFromTree(ctx, c, still, new Set(), fullDps, swap)).catch(() => null);
    if (tree) ways.push({ ...tree, way: 'passives' });
    // the whole shortfall too dear: points for the gems that need less (one Int node fits Faster Casting), the rest lowered less
    const needs = [...new Set(still.map((g) => g.attr.need))].sort((a, b) => a - b).slice(0, -1);
    for (const n of hidden.length ? needs : []) {
      const part = await withScratch(ctx, xml, (c) => attributeFromTree(ctx, c, still.filter((g) => g.attr.need <= n), new Set(), fullDps, swap)).catch(() => null);
      if (part) ways.push({ ...part, way: 'passives' });
    }
  }
  if (hidden.length) {
    const craft = await attributeCraft(ctx, xml, still, new Set(), fullDps, true);
    if (craft) ways.push(craft);
  }
  const drops = new Map<object, Awaited<ReturnType<typeof unmeasuredDrops>>>([[lower, hidden]]);
  for (const w of ways.slice(1)) drops.set(w, await unmeasuredDrops(ctx, buildId, w.edits, fullDps));
  const dropSum = (w: (typeof ways)[number]) => (drops.get(w) ?? []).reduce((t, d) => t + d.drop, 0);
  const loss = (w: (typeof ways)[number], id: string) => (num(base, id) ? ((num(base, id) - num(w.after, id)) / num(base, id)) * 100 : 0);
  // a minion build's damage is its minions': Combined DPS does not see the minion nodes a swap gives up (739k -> 682k)
  const measured = [dps, 'TotalEHP', ...(num(base, 'MinionTotalDPS') > 0 ? ['MinionTotalDPS'] : [])];
  const lossSum = (w: (typeof ways)[number]) => measured.reduce((t, id) => t + loss(w, id), 0);
  const cost = (w: (typeof ways)[number]) => measured.map((id) => `${statMeta(id).label} ${pct(num(base, id), num(w.after, id)) || '+0%'}`).join(', ');
  const cap = (w: (typeof ways)[number]) => (w === lower || !hidden.length ? 1 : 5);
  const cheap = ways
    .filter((w) => w.edits.length && !w.unfixed.length && measured.every((id) => loss(w, id) <= cap(w)) && (w === lower || !hidden.length || dropSum(w) < dropSum(lower)))
    .sort((x, y) => dropSum(x) - dropSum(y) || lossSum(x) - lossSum(y))[0];
  const short = still.map((g) => `${g.name} needs ${g.attr.need} ${g.attr.name} (you have ${g.attr.have})`).join('; ');
  const hiddenLine = (d: typeof hidden) => `${statMeta(dps).label} does not count ${d.map((x) => x.name).join(', ')}, so it cannot show what ${d.map((x) => `${x.from} -> ${x.to}`).join(', ')} costs (${d.map((x) => `${Math.round(x.drop * 100)}% of ${x.name}'s level`).join(', ')})`;
  if (cheap) {
    await applyEdits(ctx, buildId, cheap.edits, fullDps);
    const why = hidden.length && cheap !== lower ? `Lowering would cost over 5%: ${hiddenLine(hidden)}, so ${cheap.way === 'passives' ? 'passive points cover' : 'a bench craft covers'} ${drops.get(cheap)?.length ? 'part of ' : ''}the ${[...new Set(still.map((g) => g.attr.name))].join(' and ')} instead. ` : '';
    const tried = ways.slice(1).filter((w) => w !== cheap && dropSum(w) < dropSum(cheap)).map((w) => `${w.lines[0] ?? w.way} (${cost(w)}${w.unfixed.length ? ', does not cover it' : ''})`).join('; ');
    const left = drops.get(cheap)?.length ? ` ${hiddenLine(drops.get(cheap)!)}; ${tried ? `covering more costs over 5%: ${tried}` : 'no free point, swapped end node or bench craft covers more'}.` : '';
    return { edits: cheap.edits, lines: [`Also fixed from before the change: ${short}. ${why}${cheap.lines.join('; ')} (${cost(cheap)}).${left}`] };
  }
  if (lower.edits.length && !lower.unfixed.length) {
    // nothing buys the attribute cheaply: the gem works in game only at the lower level, so it still goes in, its cost said
    // (a short gem left at its level for the player to lower was a player's reject)
    const tried = ways.slice(1).map((w) => `${w.way} (${cost(w)})`).join('; ');
    await applyEdits(ctx, buildId, lower.edits, fullDps);
    return { edits: lower.edits, lines: [`Also fixed from before the change: ${short}. ${lower.lines.join('; ')} (${cost(lower)}: the engine counted the gem at a level you cannot use). ${hidden.length ? `${hiddenLine(hidden)}; ` : ''}${tried ? `the other ways cost more: ${tried}` : 'no free point or bench craft covers it'}.`] };
  }
  const why = lower.edits.length ? `lowering the gem would cost ${cost(lower)} (${lower.lines.join('; ')}), more than 1%, so it was left for you` : `even level 1 does not fit${lower.unfixed.length ? ` (${lower.unfixed.join('; ')})` : ''}`;
  return { edits: [], lines: [`Still unmet from before the change: ${short}; ${why}`] };
}

/** A player's max-hit ask. A "Solve update" is the app's own message: its limit names say "maximum hit", and the facts would describe the open build, not the lead. */
export const asksMaxHit = (question: string): boolean => !/^\s*Solve update/i.test(question) && /\bmax(imum)? hits?\b/i.test(question);

export interface MaxHitFacts { hit: string; guard?: string; rank: string; cap?: string; card?: { title: string; line: string; why?: string; edits: ToolEdit[] } }

/**
 * A max-hit ask: the asked type's max hit (else the lowest), the hit with a guard or Vaal skill down
 * (the numbers count it always up), its rank against the other types, the hit at the resistance cap and the bench craft that
 * moves it most as a one-tap card, all from the engine. Each string stays under 200 characters (the answer cites them by ref).
 */
export async function maxHitFacts(ctx: ToolContext, buildId: string, question: string): Promise<MaxHitFacts | null> {
  const s = await statMap(ctx, buildId);
  const types = ['Physical', 'Fire', 'Cold', 'Lightning', 'Chaos'].filter((t) => num(s, `${t}MaximumHitTaken`) > 0);
  if (!types.length) return null;
  const hitOf = (m: Record<string, Scalar>, t: string) => num(m, `${t}MaximumHitTaken`);
  const sorted = [...types].sort((a, b) => hitOf(s, a) - hitOf(s, b));
  const t = types.find((x) => new RegExp(`\\b${x}\\b`, 'i').test(question)) ?? sorted[0]!;
  const id = `${t}MaximumHitTaken`;
  const show = (v: number) => formatStat(id, v);
  const low = t.toLowerCase();
  const out: MaxHitFacts = {
    hit: `Your ${low} max hit is ${show(hitOf(s, t))}`,
    rank: sorted[0] === t
      ? `It is your lowest max hit; next is ${sorted[1] ? `${sorted[1].toLowerCase()} ${show(hitOf(s, sorted[1]))}` : 'none'}`
      : `${sorted[0]} ${show(hitOf(s, sorted[0]!))} is the lowest; ${low} is number ${sorted.indexOf(t) + 1} of ${sorted.length} from the bottom`,
  };
  const preview = async (edit: ToolEdit) => {
    const r = await ctx.engine.send('previewEdit', { buildId, edit: toBuildEdit(edit), full: true }).catch(() => null);
    if (!r || r.blocked) return null;
    const after = { ...s };
    for (const c of r.statDiff.changed) if (c.after === null || typeof c.after !== 'object') after[c.statId] = c.after as Scalar;
    return after;
  };
  // a guard or Vaal skill outside the main group: the hit between its casts
  const [{ state }, { gems: catalog }] = await Promise.all([ctx.engine.send('skillsState', { buildId }), gemCatalog(ctx)]);
  const tags = new Map(catalog.map((g) => [g.id, g.tags]));
  let guard: { name: string; v: number } | null = null;
  for (const g of state.groups) {
    if (!g.enabled || g.slotInactive || g.index === state.mainGroup) continue;
    for (const x of g.gems) {
      const tg = (x.gemId && tags.get(x.gemId)) || [];
      if (x.support || !x.enabled || tg.some((k) => /^aura$/i.test(k)) || !tg.some((k) => /^(guard|vaal)$/i.test(k))) continue;
      const a = await preview({ kind: 'setGem', group: g.index, gem: x.index, attr: 'enabled', value: false });
      if (a && hitOf(a, t) < hitOf(s, t) * 0.95 && (!guard || hitOf(a, t) < guard.v)) guard = { name: x.nameSpec, v: hitOf(a, t) };
    }
  }
  if (guard) out.guard = `The numbers count ${guard.name} as always up; between its casts your ${low} max hit is ${show(guard.v)}`;
  if (t === 'Physical') return out;
  const res = num(s, `${t}Resist`);
  const cap = num(s, `${t}ResistMax`) || 75;
  if (res < cap) {
    const { state: config } = await ctx.engine.send('configState', { buildId });
    const blocks = [...config.customMods.map((m) => ({ title: m.title, enabled: m.enabled, text: m.text })), { title: 'cap check', enabled: true, text: `+${cap - res}% to ${t} Resistance` }];
    const a = await preview({ kind: 'setCustomMods', blocks });
    if (a) out.cap = `At the ${cap}% ${low} resistance cap (${res}% now) it would be ${show(hitOf(a, t))}`;
  }
  // the bench craft that moves it most: what it replaces and what it costs elsewhere are said; no currency price (the data has none)
  const xml = await xmlOf(ctx, buildId);
  const re = new RegExp(`\\b${t} Resistances?$|${t === 'Chaos' ? '^$' : 'all Elemental Resistances$'}`);
  let best: { how: string; replaced: string; slot: string; edit: ToolEdit; a: Record<string, Scalar>; itemLevel?: number; next?: { text: string; level: number } } | null = null;
  for (const slot of activeSetOf(readItems(xml)).slots.keys()) {
    const old = /Jewel|Swap|Flask/.test(slot) ? null : slotItemText(xml, slot);
    if (!old) continue;
    for (const c of await benchSuffixes(ctx, slot, old, re).catch(() => [])) {
      const a = await preview(c.edit);
      if (a && hitOf(a, t) > (best ? hitOf(best.a, t) : hitOf(s, t))) best = { how: c.how, replaced: c.replaced, slot, edit: c.edit, a, ...(c.itemLevel ? { itemLevel: c.itemLevel } : {}), ...(c.next ? { next: c.next } : {}) };
    }
  }
  if (best) {
    const lost = ['TotalEHP', 'Life', dpsOf(s)].filter((k) => num(best!.a, k) < num(s, k) - 0.5).map((k) => `${statMeta(k).label} ${formatStat(k, num(s, k))} -> ${formatStat(k, num(best!.a, k))}`);
    // every other resistance the craft moves, by its total before the cap, and whether it stays capped (+16% Cold and Lightning replaced, neither shown)
    const moved = ['Fire', 'Cold', 'Lightning', 'Chaos'].filter((e) => e !== t && num(best!.a, `${e}ResistTotal`) !== num(s, `${e}ResistTotal`)).map((e) => {
      const c = num(best!.a, `${e}ResistMax`) || 75;
      const [was, now] = [num(s, `${e}ResistTotal`), num(best!.a, `${e}ResistTotal`)];
      return `${e.toLowerCase()} resistance ${was}% -> ${now}% (${now >= c ? `still capped at ${c}%` : `below the ${c}% cap: ${num(best!.a, `${e}Resist`)}%`})`;
    });
    const stop = num(best.a, `${t}Resist`);
    const why = stop < cap ? `the best bench craft stops at ${stop}%, ${cap - stop}% short of the ${cap}% cap: ${best.next ? `${best.slot} is item level ${best.itemLevel}, and the ${best.next.text} tier needs item level ${best.next.level}` : 'it is the bench\'s top tier'}; no other item's craft gets closer` : '';
    out.card = {
      ...(why ? { why: `${why[0]!.toUpperCase()}${why.slice(1)}` } : {}),
      // what the item gives up is on the card itself, and a craft that stops short of the cap says so
      // the card rows carry the max hit; the title (90 characters at most) names what the item gives up
      title: `${t} res craft on ${best.slot}${best.replaced ? `, replaces ${best.replaced}` : `: ${low} max hit ${show(hitOf(s, t))} -> ${show(hitOf(best.a, t))}`}`,
      line: `${best.how[0]!.toUpperCase()}${best.how.slice(1)}: ${low} resistance ${res}% -> ${num(best.a, `${t}Resist`)}%, ${low} max hit ${show(hitOf(s, t))} -> ${show(hitOf(best.a, t))}${why ? `; ${why}` : ''}${moved.length ? `; ${moved.join(', ')}` : ''}${lost.length ? `; costs ${lost.join(', ')}` : ''}`,
      edits: [best.edit],
    };
  }
  return out;
}

/**
 * The main skill costing more mana per second than regeneration and leech give back, fixed the cheap way in the same change:
 * in order a bench craft or flask suffix for mana, the skill gem's level, mana regeneration passives; each applied only within
 * 5% of damage and effective HP. Dearer: the cheapest that pays comes back as a one-tap offer; none: a line says so (short
 * 5.8/s after Enlighten took Lifetap's place; Burning Arrow short 1435.8/s under Soul Talons).
 */
export async function fixManaShortfall(ctx: ToolContext, buildId: string, fullDps: boolean): Promise<{ edits: ToolEdit[]; lines: string[]; offer?: { edits: ToolEdit[]; line: string } }> {
  const none = { edits: [] as ToolEdit[], lines: [] as string[] };
  const back = (m: Record<string, Scalar>) => num(m, 'ManaRegenRecovery') + num(m, 'ManaLeechRate');
  const s = await statMap(ctx, buildId);
  if (!(num(s, 'ManaPerSecondCost') > back(s))) return none;
  const dps = dpsOf(s);
  const lost = (a: Record<string, Scalar>, k: string) => (num(s, k) ? (num(s, k) - num(a, k)) / num(s, k) : 0);
  // no resist newly under its cap, at most 5% of damage or effective HP
  const tooDear = (a: Record<string, Scalar>) => ['Fire', 'Cold', 'Lightning'].some((e) => num(a, `${e}Resist`) < num(s, `${e}Resist`) && num(a, `${e}Resist`) < (num(a, `${e}ResistMax`) || 75)) || lost(a, dps) > 0.05 || lost(a, 'TotalEHP') > 0.05;
  const costsOf = (a: Record<string, Scalar>) => { const c = [dps, 'TotalEHP'].filter((k) => num(a, k) < num(s, k)).map((k) => `${statMeta(k).label} ${pct(num(s, k), num(a, k))}`); return c.length ? ` (${c.join(', ')})` : ''; };
  type Way = { edits: ToolEdit[]; line: string; a: Record<string, Scalar>; extra?: string[] };
  const pays = (a: Record<string, Scalar>) => num(a, 'ManaPerSecondCost') <= back(a);
  // a fix that pays the mana but costs more than 5% (or a capped resist) waits as the one-tap card, the cheapest of them
  const dear: Way[] = [];
  const take = async (w: Way) => {
    await applyEdits(ctx, buildId, w.edits, fullDps);
    return { edits: w.edits, lines: [`Mana fixed in the same change: ${w.line}`, ...(w.extra ?? [])] };
  };
  // 1. a bench craft or a flask suffix for mana
  let craft: Way | null = null;
  for (const c of await manaCrafts(ctx, await xmlOf(ctx, buildId)).catch(() => [])) {
    const r = await ctx.engine.send('previewEdit', { buildId, edit: c.edit, full: fullDps }).catch(() => null);
    if (!r || r.blocked) continue;
    const a = { ...s, ...Object.fromEntries(r.statDiff.changed.map((x) => [x.statId, x.after as Scalar])) };
    if (!pays(a)) continue;
    const w: Way = { edits: [c.edit], line: `${c.how}: ${manaSustainLine(s, a)}${costsOf(a)}`, a };
    // the old craft or suffix it replaces may carry a resist or life
    if (tooDear(a)) dear.push(w);
    else if (!craft || num(a, dps) > num(craft.a, dps)) craft = w;
  }
  if (craft) return take(craft);
  // 2. the main skill gem's level: the highest level that pays its mana
  const { state } = await ctx.engine.send('skillsState', { buildId });
  const g = state.groups.find((x) => x.index === state.mainGroup && !x.synthetic);
  const act = g?.activeSkills[(g.mainActiveSkill || 1) - 1];
  const gem = g?.gems.find((x) => x.index === act?.gem);
  if (g && gem && !gem.support && gem.level > 1) {
    const found = await withScratch(ctx, await xmlOf(ctx, buildId), async (c) => {
      for (let lv = gem.level - 1; lv >= 1; lv--) {
        const e: ToolEdit = { kind: 'setGem', group: g.index, gem: gem.index, attr: 'level', value: lv };
        await applyEdits(ctx, c, [e], fullDps);
        const a = await statMap(ctx, c);
        if (pays(a)) return { lv, a, e };
      }
      return null;
    }).catch(() => null);
    if (found) {
      const w: Way = { edits: [found.e], line: `${gem.nameSpec} lowered from level ${gem.level} to ${found.lv} so it pays its own mana: ${manaSustainLine(s, found.a)} (${statMeta(dps).label} ${pct(num(s, dps), num(found.a, dps)) || '+0%'})`, a: found.a };
      if (!tooDear(found.a)) return take(w);
      dear.push(w);
    }
  }
  // 3. passives for mana regeneration: the regeneration the skill needs on top of its leech (free points, then up to 3 given up end nodes)
  const tree = await withScratch(ctx, await xmlOf(ctx, buildId), async (c) => {
    const t = await attributeFromTree(ctx, c, [{ attr: { name: 'ManaRegenRecovery', need: num(s, 'ManaPerSecondCost') - num(s, 'ManaLeechRate') } }], new Set(), fullDps, 3);
    return t && pays(t.after) ? t : null;
  }).catch(() => null);
  if (tree) {
    const regret = tree.gave.length ? `, gave up ${tree.gave.join(', ')} (${tree.gave.length} Orb${tree.gave.length === 1 ? '' : 's'} of Regret)` : '';
    const w: Way = { edits: tree.edits, line: `took ${tree.took.map((t) => t.replace(/ \(\+[^,]*, /, ' (')).join(', ')}${tree.spent ? ` with ${tree.spent} free point${tree.spent === 1 ? '' : 's'}` : ''}${regret}: ${manaSustainLine(s, tree.after)}${costsOf(tree.after)}`, a: tree.after, extra: tree.lines.filter((l) => !/^(Took|Compared) /.test(l)) };
    if (!tooDear(tree.after)) return take(w);
    dear.push(w);
  }
  // 4. a support of the main skill swapped for one that pays or cuts its mana (Lifetap pays in life, Inspiration, Mana Leech),
  //    and a mana flask in place of a utility flask; each costed by the engine on one scratch copy, undone after each try
  const swaps: Array<{ edits: ToolEdit[]; undo: ToolEdit[]; what: string }> = [];
  for (const x of g && gem ? g.gems.filter((y) => y.support && y.enabled && y.gemId && !MANA_SUPPORTS.some(([id]) => id === y.gemId)) : []) {
    for (const [id, name] of MANA_SUPPORTS) swaps.push({ edits: [{ kind: 'setGemSkill', group: g!.index, gem: x.index, gemId: id }, { kind: 'setGem', group: g!.index, gem: x.index, attr: 'level', value: 20 }], undo: [{ kind: 'setGemSkill', group: g!.index, gem: x.index, gemId: x.gemId! }, { kind: 'setGem', group: g!.index, gem: x.index, attr: 'level', value: x.level }], what: `${name} in place of ${x.nameSpec} in the ${gem!.nameSpec} group` });
  }
  const xmlNow = await xmlOf(ctx, buildId);
  for (const slot of activeSetOf(readItems(xmlNow)).slots.keys()) {
    const old = /^Flask \d$/.test(slot) ? slotItemText(xmlNow, slot) : null;
    if (!old || /Life Flask|Mana Flask|Hybrid Flask/.test(old)) continue;
    swaps.push({ edits: [{ kind: 'setItem', slot, itemText: 'Rarity: NORMAL\nDivine Mana Flask\nItem Level: 84' }], undo: [{ kind: 'setItem', slot, itemText: old }], what: `a Divine Mana Flask in place of ${old.split('\n').map((l) => l.trim()).filter(Boolean)[1] ?? slot} (${slot})` });
  }
  const tried = await withScratch(ctx, xmlNow, async (c) => {
    const out: Way[] = [];
    for (const sw of swaps.slice(0, 18)) {
      try {
        await applyEdits(ctx, c, sw.edits, fullDps);
        const a = await statMap(ctx, c);
        // Lifetap moves the cost to life: it must not cost more life a second than regen and leech give back (12.7k life/s)
        const lifeCost = num(a, 'LifePerSecondCost');
        const lifeOk = lifeCost <= num(s, 'LifePerSecondCost') || lifeCost <= num(a, 'LifeRegenRecovery') + num(a, 'LifeLeechRate');
        if (pays(a) && lifeOk) out.push({ edits: sw.edits, line: `${sw.what}: ${manaSustainLine(s, a)}${lifeCost > 0 ? `; it costs ${Math.round(lifeCost * 10) / 10} life a second instead` : ''}${costsOf(a)}`, a });
      } catch { /* the engine refuses this one: next */ }
      await applyEdits(ctx, c, sw.undo, fullDps).catch(() => undefined);
    }
    return out;
  }).catch(() => [] as Way[]);
  const cheapSwap = tried.filter((w) => !tooDear(w.a)).sort((x, y) => num(y.a, dps) - num(x.a, dps))[0];
  if (cheapSwap) return take(cheapSwap);
  dear.push(...tried);
  // 5. nothing cheap: the cheapest fix that pays it, one tap away
  const lossSum = (a: Record<string, Scalar>) => lost(a, dps) + lost(a, 'TotalEHP');
  const card = dear.sort((x, y) => lossSum(x.a) - lossSum(y.a))[0];
  if (card) return { ...none, offer: { edits: card.edits, line: card.line } };
  return { ...none, lines: [`Mana still short: ${manaSustainLine(s, s)}. No bench craft, flask suffix, mana regeneration passives (up to 3 points given up), ${gem ? `lower ${gem.nameSpec} level, ` : ''}Lifetap, Inspiration or Mana Leech support, or mana flask pays it`] };
}

const MANA_SUPPORTS: Array<[string, string]> = [['Metadata/Items/Gems/SkillGemSupportLifetap', 'Lifetap'], ['Metadata/Items/Gems/SkillGemSupportInspiration', 'Inspiration'], ['Metadata/Items/Gems/SkillGemSupportManaLeech', 'Mana Leech']];

/** "Name, Base: mod, mod" of an item text without the {tags} and header lines. */
function itemSummary(text: string): { name: string; mods: string[] } {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const r = lines.findIndex((l) => /^Rarity:/i.test(l));
  const rare = /RARE|UNIQUE/i.test(lines[r] ?? '');
  // a rare that was never named reads "New Item": its base alone ("Takes out New Item, Stygian Vise")
  const name = lines.slice(r + 1, r + (rare ? 3 : 2)).filter((l, i) => !(rare && i === 0 && /^New Item$/i.test(l))).join(', ');
  const mods = lines.slice(r + (rare ? 3 : 2))
    // base properties and header fields ("Armour: 199", "ArmourBasePercentile: 0.5") are not mods the player loses
    .filter((l) => !/^(Corrupted|Selected Variant|Has Alt Variant|Elder Item|Shaper Item|Requires)|^[A-Za-z ]+:/i.test(l))
    .map((l) => l.replace(/\{[^}]*\}/g, ''));
  return { name, mods };
}
const abyssCount = (text: string) => (/^Sockets:\s*(.+)$/m.exec(text)?.[1] ?? '').split('').filter((c) => c === 'A').length || Number(/Has (\d+) Abyssal Sockets?/i.exec(text)?.[1] ?? (/Has an Abyssal Socket/i.test(text) ? 1 : 0));
const gemSockets = (text: string) => (/^Sockets:\s*(.+)$/m.exec(text)?.[1] ?? '').replace(/A[- ]?/g, '').trim();

/**
 * What a player loses by taking the item out of `slot` for `newText`: the old item's own mods (implicits, attributes, life),
 * and each abyssal jewel or socket the new item has no room for. Empty when the slot was empty.
 */
export function itemSwapLoss(xml: string, slot: string, newText: string | null): string[] {
  const m = readItems(xml);
  const set = activeSetOf(m);
  const oldText = m.items.find((i) => i.id === slotItemId(set, slot))?.text;
  if (!oldText) return [];
  const old = itemSummary(oldText);
  const lines = [`Takes out ${old.name}: ${old.mods.join(', ') || 'no mods'}`];
  const keep = newText ? abyssCount(newText) : 0;
  for (let i = keep + 1; i <= abyssCount(oldText); i++) {
    const jewel = m.items.find((x) => x.id === slotItemId(set, `${slot} Abyssal Socket ${i}`))?.text;
    if (jewel) {
      const j = itemSummary(jewel);
      lines.push(`Loses abyssal socket ${i} and its jewel ${j.name}: ${j.mods.join(', ')}`);
    } else lines.push(`Loses abyssal socket ${i} (empty now)`);
  }
  const [was, now] = [gemSockets(oldText), newText ? gemSockets(newText) : ''];
  // the database's uniques carry no sockets line: compared only when the new item says what it has
  if (was && now && was.replace(/[- ]/g, '').length > now.replace(/[- ]/g, '').length) lines.push(`Sockets ${was} -> ${now || 'none'}: gems in this slot lose their sockets or links`);
  return lines;
}

const ATTR_WORD: Record<string, string> = { Str: 'Strength', Dex: 'Dexterity', Int: 'Intelligence' };

/**
 * The short attribute from a bench craft on a rare or magic item that has no crafted mod yet: the item with the craft that
 * covers every shortfall for the most damage plus effective HP, then gems lowered for what is left. Tried before free points
 *. Only items with an open suffix; null when nothing covers.
 */
async function attributeCraft(ctx: ToolContext, xml: string, short: Awaited<ReturnType<typeof unmetGems>>, ignore: Set<string>, fullDps: boolean, partial = false, also: Awaited<ReturnType<typeof unmetGems>> = []) {
  // `also`: gems short from before, competing for the same open suffix; the craft goes where it saves the most gem levels, and
  // null when that is one of them (+30 Int keeps Faster Casting and Increased AoE 20, worth more than Determination 21 -> 19)
  const all = [...short, ...also];
  const need = new Map<string, number>();
  for (const g of all) need.set(g.attr.name, Math.max(need.get(g.attr.name) ?? 0, g.attr.need));
  const maxRoll = (t: string) => t.replace(/\((-?[\d.]+)-([\d.]+)\)/g, (_, _a: string, b: string) => b);
  const opts: Array<{ slot: string; name: string; line: string; text: string }> = [];
  for (const item of readEquipped(xml)) {
    const lines = item.text.split(/\r?\n/).map((l) => l.trim()); // the build file indents the first line
    const text = lines.join('\n');
    if (!/^Rarity: (RARE|MAGIC)$/im.test(text) || benchCraftRows(text).length || /^(Flask|Weapon)/.test(item.slot) || / Socket \d/.test(item.slot)) continue;
    const pool = await ctx.engine.send('modPool', { base: item.base, itemLevel: Number(/^Item Level: (\d+)/m.exec(text)?.[1] ?? 84) }).then((r) => r.pool).catch(() => null);
    // the craft goes in an open suffix: an item with none takes no craft (the line said "needs an open suffix" unchecked)
    const mods = pool ? (await ctx.engine.send('itemInfo', { itemText: text }).catch(() => null))?.item.mods : undefined;
    if (!pool || openSuffixes(pool, mods, /^Rarity: MAGIC$/im.test(text) ? 'MAGIC' : undefined) <= 0) continue;
    const crafts = new Map<string, { tier: number; line: string }>();
    for (const m of pool?.suffixes ?? []) {
      if (m.source !== 'bench' || m.stats.length !== 1 || ![...need.keys()].some((a) => m.stats[0]!.text.includes(ATTR_WORD[a]!) || /all Attributes/.test(m.stats[0]!.text))) continue;
      if (!/to (Strength|Dexterity|Intelligence|all Attributes)/.test(m.stats[0]!.text)) continue;
      const was = crafts.get(m.group);
      if (!was || m.tier < was.tier) crafts.set(m.group, { tier: m.tier, line: maxRoll(m.stats[0]!.text) });
    }
    for (const c of crafts.values()) opts.push({ slot: item.slot, name: item.name, line: c.line, text: `${text}\n{crafted}${c.line}` });
  }
  if (!opts.length) return null;
  return withScratch(ctx, xml, async (copy) => {
    const now = await statMap(ctx, copy);
    const { results } = await ctx.engine.send('previewEdits', { buildId: copy, edits: opts.map((o) => ({ kind: 'setItem', slot: o.slot, itemText: o.text })), full: true });
    const dps = dpsOf(now);
    const rel = (s: Record<string, Scalar>, id: string) => (num(now, id) ? (num(s, id) - num(now, id)) / num(now, id) : 0);
    const covering = opts.flatMap((o, i) => {
      const r = results[i];
      if (!r || 'error' in r || r.blocked) return [];
      const after = { ...now };
      for (const c of r.statDiff.changed) if (c.after === null || typeof c.after !== 'object') after[c.statId] = c.after as Scalar;
      const ok = (g: (typeof all)[number]) => num(after, g.attr.name) >= g.attr.need && num(now, g.attr.name) < g.attr.need;
      const met = short.filter(ok).length;
      const saved = all.filter(ok).reduce((t, g) => t + g.level - g.fit, 0);
      const gain = [...need.keys()].reduce((t, a) => t + num(after, a) - num(now, a), 0);
      return met === short.length || (partial && saved > 0) ? [{ o, met, saved, gain, score: rel(after, dps) + rel(after, 'TotalEHP') }] : [];
    }).sort((x, y) => y.saved - x.saved || y.met - x.met || y.gain - x.gain || y.score - x.score);
    const pick = covering[0];
    if (!pick || !pick.met) return null;
    const edit: ToolEdit = { kind: 'setItem', slot: pick.o.slot, itemText: pick.o.text };
    await applyEdits(ctx, copy, [edit], fullDps);
    const fit = await fitGemLevels(ctx, copy, ignore);
    return {
      way: 'bench craft the attribute',
      edits: [edit, ...fit.edits],
      lines: [`Bench craft ${pick.o.line} on ${pick.o.name} (${pick.o.slot}; needs an open suffix): ${[...need.keys()].map((a) => `${a} ${num(now, a)} -> ${num(fit.after, a)}`).join(', ')}`, ...fit.lines],
      unfixed: fit.unfixed,
      after: fit.after,
    };
  }).catch(() => null);
}

/**
 * Gems the change left short of Str/Dex/Int (not in `ignore`, the ones short before it): every way a player has is calculated
 * on a copy (lower the gems; attribute passives from free points, then by swapping cheap end nodes) and the one that keeps the
 * most damage plus effective HP is applied to `buildId`. `tree: false` only lowers the gems (cheap, for ranking many items).
 */
export async function fixRequirements(ctx: ToolContext, buildId: string, ignore: Set<string>, opts: { tree: boolean; swapPoints?: number; pointsLast?: boolean } = { tree: true }): Promise<ReqFix> {
  const base = await statMap(ctx, buildId);
  const short = (await unmetGems(ctx, buildId)).filter((g) => !ignore.has(g.key));
  if (!short.length) return { edits: [], lines: [], unfixed: [], after: base, options: [] };
  const fullDps = num(base, 'FullDPS') > 0;
  if (!opts.tree) {
    const f = await fitGemLevels(ctx, buildId, ignore);
    return { edits: f.edits, lines: f.lines, unfixed: f.unfixed, after: f.after, options: [] };
  }
  const xml = await xmlOf(ctx, buildId);
  const ways = [
    await withScratch(ctx, xml, async (copy) => {
      const f = await fitGemLevels(ctx, copy, ignore);
      return { way: 'lower the gem levels', edits: f.edits, lines: f.lines, unfixed: f.unfixed, after: f.after };
    }),
  ];
  // An item change spends no passive points unless lowering gems cannot fit them all (points are a separate offer),
  // or lowering costs more than 5% of effective HP, damage or life: then passive points cover the attribute, free ones first, else swapped end nodes (Determination 21 -> 8; 0 free points at level 95).
  const dpsId = dpsOf(base);
  const lossPct = (id: string) => (num(base, id) > 0 ? Math.round(((num(base, id) - num(ways[0]!.after, id)) / num(base, id)) * 1000) / 10 : 0);
  const costly = ['TotalEHP', dpsId, 'Life'].filter((id) => lossPct(id) > 5);
  // a bench craft of the attribute comes before points when it covers it at no more than 5% cost, and
  // before any gem is lowered: gems drop only for what it leaves (Meginord's Str paid by Determination 21 -> 19)
  const old = opts.pointsLast ? (await unmetGems(ctx, buildId)).filter((g) => ignore.has(g.key)) : [];
  const craft = opts.pointsLast && (costly.length || ways[0]!.edits.length) ? await attributeCraft(ctx, xml, short, ignore, fullDps, true, old) : null;
  const craftLoss = (id: string) => (craft && num(base, id) > 0 ? ((num(base, id) - num(craft.after, id)) / num(base, id)) * 100 : 0);
  const craftOk = !!craft && craft.unfixed.length <= ways[0]!.unfixed.length && ['TotalEHP', dpsId, 'Life'].every((id) => craftLoss(id) <= 5);
  if (craft && craftOk) ways.push(craft);
  // attribute passives from the free points only, and from free points plus a few swapped end nodes
  const swaps = craftOk ? [] : !opts.pointsLast ? [...new Set([opts.swapPoints ?? 4, 0])] : ways[0]!.unfixed.length || costly.length ? [...new Set([opts.swapPoints ?? 4, 0])] : [];
  for (const swap of swaps) {
    const tree = await withScratch(ctx, xml, (copy) => attributeFromTree(ctx, copy, short, ignore, fullDps, swap)).catch(() => null);
    if (tree) ways.push(tree);
    if (!tree || !tree.swapped) break; // free points were enough: the free-only way is the same one
  }
  const dps = dpsOf(base);
  const rel = (s: Record<string, Scalar>, id: string) => (num(base, id) ? Math.round(((num(s, id) - num(base, id)) / num(base, id)) * 10000) / 100 : 0);
  const scored = ways.map((w) => ({ ...w, dpsPct: rel(w.after, dps), ehpPct: rel(w.after, 'TotalEHP'), unmet: w.unfixed.length }));
  // a way that leaves a gem unmet loses to one that fits them all; then the most damage plus effective HP
  scored.sort((x, y) => x.unmet - y.unmet || y.dpsPct + y.ehpPct - (x.dpsPct + x.ehpPct) || x.edits.length - y.edits.length);
  const best = scored[0]!;
  await applyEdits(ctx, buildId, best.edits, fullDps);
  const after = await statMap(ctx, buildId);
  const label = (w: (typeof scored)[number]) => `${w.way}: ${statMeta(dps).label} ${w.dpsPct >= 0 ? '+' : ''}${w.dpsPct}%, Effective HP ${w.ehpPct >= 0 ? '+' : ''}${w.ehpPct}%`;
  const others = scored.slice(1);
  const why = costly.length && best.way !== ways[0]!.way ? [`Lowering the gems to fit would cost ${costly.map((id) => `${statMeta(id).label} -${lossPct(id)}%`).join(', ')} (over 5%), so ${best.way === craft?.way ? 'a bench craft' : 'passive points'} cover${best.way === craft?.way ? 's' : ''} ${[...new Set(short.map((g) => g.attr.name))].join(' and ')} instead`] : [];
  return {
    edits: best.edits,
    lines: [...why, ...best.lines, ...(others.length ? [`Chose to ${label(best)}; the other way, ${others.map(label).join('; ')}`] : [])],
    unfixed: best.unfixed,
    after,
    chosen: best.way,
    options: scored.map((w) => ({ way: w.way, dpsPct: w.dpsPct, ehpPct: w.ehpPct, score: Math.round((w.dpsPct + w.ehpPct - w.unmet * 1000) * 100) / 100 })),
  };
}

export interface PointsOffer { edits: ToolEdit[]; lines: string[]; points: number; dpsPct: number; ehpPct: number }

/**
 * What the free passive points buy back after a change that lowered gems to fit (`restore`: each gem and the level it had):
 * the gems at their old levels again, with the attribute path the engine scores best (attributeFromTree). A separate offer
 * from the item change. Edits `buildId` (a scratch copy holding the change); null when nothing is gained.
 */
export async function pointsOffer(ctx: ToolContext, buildId: string, restore: Array<{ group: number; gem: number; name: string; level: number; now: number }>, fullDps: boolean): Promise<PointsOffer | null> {
  const free = (await pointBudget(ctx, buildId)).passive.left;
  if (free <= 0 || !restore.length) return null;
  const base = await statMap(ctx, buildId);
  const back: ToolEdit[] = restore.map((g) => ({ kind: 'setGem', group: g.group, gem: g.gem, attr: 'level', value: g.level }));
  await applyEdits(ctx, buildId, back, fullDps);
  const short = await unmetGems(ctx, buildId);
  const tree = short.length ? await attributeFromTree(ctx, buildId, short, new Set(), fullDps, 0) : null;
  if (!tree) return null;
  const dps = dpsOf(base);
  const rel = (id: string) => (num(base, id) ? Math.round(((num(tree.after, id) - num(base, id)) / num(base, id)) * 10000) / 100 : 0);
  if (rel(dps) + rel('TotalEHP') <= 0) return null;
  const points = free - tree.freeLeft;
  // each gem's level once the path's own fit has lowered what it could not cover; only real changes become edits (proposeEdit takes 12)
  const level = new Map(restore.map((g) => [`${g.group}:${g.gem}`, g.level]));
  for (const e of tree.edits) if (e.kind === 'setGem' && e.attr === 'level' && typeof e.value === 'number') level.set(`${e.group}:${e.gem}`, e.value);
  const gemEdits = restore.filter((g) => level.get(`${g.group}:${g.gem}`) !== g.now).map((g): ToolEdit => ({ kind: 'setGem', group: g.group, gem: g.gem, attr: 'level', value: level.get(`${g.group}:${g.gem}`)! }));
  const raised = restore.filter((g) => level.get(`${g.group}:${g.gem}`) !== g.now).map((g) => `${g.name} ${g.now} -> ${level.get(`${g.group}:${g.gem}`)}`);
  const head = `Spend ${points} free point${points === 1 ? '' : 's'}${raised.length ? ` (${raised.join(', ')})` : ''}: ${statMeta(dps).label} ${rel(dps) >= 0 ? '+' : ''}${rel(dps)}%, Effective HP ${rel('TotalEHP') >= 0 ? '+' : ''}${rel('TotalEHP')}% on top of the item change`;
  return { edits: [...tree.edits.filter((e) => e.kind !== 'setGem'), ...gemEdits], lines: [head, ...tree.lines], points, dpsPct: rel(dps), ehpPct: rel('TotalEHP') };
}
