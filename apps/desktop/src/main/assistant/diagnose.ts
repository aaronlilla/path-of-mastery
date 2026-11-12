import type { StatValue } from '@pom/protocol';
import { z } from 'zod';
import { defenceReport } from './defence.js';
import { AUDIT_NOTE, need, present, statMap, tipText, toBuildEdit, ToolError, withScratch, xmlOf, type Scalar, type ToolContext, type ToolDef, type ToolEdit } from './tools.js';
import { readEquipped, readSkills } from './buildReaders.js';
import { auditBuild, auditForAnswer, measureFixAll } from './audit.js';
import { readItems } from '../../shared/itemsXml.js';
import { skillIdOf } from '../../shared/skillsLogic.js';

/**
 * diagnoseBuild: what the build's numbers rest on, measured. Every number is an engine run on a scratch copy; nothing in
 * here names a skill, an item or a game constant. A stack limit is found by raising the count until the engine stops moving.
 * What the build can keep up (sustain) is read the same way: the words of each setting find the lines in this build that
 * grant it, and the rate and duration come from the build's evaluated numbers. A line that gives no rate is labelled unknown.
 */

/** One fixed small bump per scaling axis, written as a custom modifier line. Which of them matter is the engine's answer, not this table's. */
export const DAMAGE_AXES: Array<{ id: string; group: string; lines: string[] }> = [
  { id: 'moreDamage', group: 'more vs increased', lines: ['10% more Damage'] },
  { id: 'increasedDamage', group: 'more vs increased', lines: ['30% increased Damage'] },
  { id: 'skillLevels', group: 'gem levels', lines: ['+1 to Level of all Skill Gems'] },
  { id: 'minionLevels', group: 'gem levels', lines: ['+1 to Level of all Minion Skill Gems'] },
  ...['Physical', 'Fire', 'Cold', 'Lightning', 'Chaos'].flatMap((t) => [
    { id: `added${t}Attack`, group: 'added damage', lines: [`Adds 10 to 20 ${t} Damage to Attacks`] },
    { id: `added${t}Spell`, group: 'added damage', lines: [`Adds 10 to 20 ${t} Damage to Spells`] },
  ]),
  { id: 'baseCrit', group: 'crit', lines: ['+1% to Critical Strike Chance'] },
  { id: 'increasedCrit', group: 'crit', lines: ['30% increased Critical Strike Chance'] },
  { id: 'critMulti', group: 'crit', lines: ['+30% to Critical Strike Multiplier'] },
  { id: 'attackSpeed', group: 'speed', lines: ['10% increased Attack Speed'] },
  { id: 'castSpeed', group: 'speed', lines: ['10% increased Cast Speed'] },
  { id: 'trapSpeed', group: 'speed', lines: ['10% increased Trap Throwing Speed'] },
  { id: 'mineSpeed', group: 'speed', lines: ['10% increased Mine Throwing Speed'] },
  { id: 'totemSpeed', group: 'speed', lines: ['10% increased Totem Placement speed'] },
  { id: 'duration', group: 'speed', lines: ['20% increased Skill Effect Duration'] },
  ...['Fire', 'Cold', 'Lightning', 'Chaos'].flatMap((t) => [
    { id: `pen${t}`, group: 'penetration and debuffs', lines: [`Damage Penetrates 10% ${t} Resistance`] },
    { id: `enemy${t}Res`, group: 'penetration and debuffs', lines: [`Nearby Enemies have -10% to ${t} Resistance`] },
  ]),
  { id: 'enemyPhysTaken', group: 'penetration and debuffs', lines: ['Nearby Enemies take 10% increased Physical Damage'] },
  { id: 'curseEffect', group: 'penetration and debuffs', lines: ['20% increased Effect of your Curses'] },
  { id: 'extraCurse', group: 'penetration and debuffs', lines: ['You can apply an additional Curse'] },
  { id: 'dotMulti', group: 'damage over time', lines: ['+10% to Damage over Time Multiplier'] },
  { id: 'increasedDot', group: 'damage over time', lines: ['30% increased Damage over Time'] },
  ...['Poison', 'Bleeding', 'Ignite'].flatMap((a) => {
    const word = a === 'Bleeding' ? 'Bleed' : a;
    return [
      { id: `${word.toLowerCase()}Damage`, group: 'ailments', lines: [`30% increased Damage with ${a}`] },
      { id: `${word.toLowerCase()}Chance`, group: 'ailments', lines: [a === 'Bleeding' ? '10% chance to cause Bleeding on Hit' : a === 'Poison' ? '10% chance to Poison on Hit' : '10% chance to Ignite'] },
      { id: `${word.toLowerCase()}Duration`, group: 'ailments', lines: [`20% increased ${word === 'Bleed' ? 'Bleeding' : word} Duration`] },
    ];
  }),
  { id: 'poisonFaster', group: 'ailments', lines: ['Poisons you inflict deal Damage 20% faster'] },
  { id: 'bleedFaster', group: 'ailments', lines: ['Bleeding you inflict deals Damage 20% faster'] },
  { id: 'igniteFaster', group: 'ailments', lines: ['Ignites you inflict deal Damage 20% faster'] },
  ...['Fire', 'Cold', 'Lightning', 'Chaos'].flatMap((t) => [
    { id: `convert${t}`, group: 'conversion', lines: [`25% of Physical Damage Converted to ${t} Damage`] },
    { id: `extra${t}`, group: 'conversion', lines: [`Gain 10% of Physical Damage as Extra ${t} Damage`] },
  ]),
  { id: 'powerCharge', group: 'stacks', lines: ['+1 to Maximum Power Charges'] },
  { id: 'frenzyCharge', group: 'stacks', lines: ['+1 to Maximum Frenzy Charges'] },
  { id: 'enduranceCharge', group: 'stacks', lines: ['+1 to Maximum Endurance Charges'] },
  { id: 'projectile', group: 'stacks', lines: ['Skills fire 1 additional Projectile'] },
  { id: 'totemLimit', group: 'stacks', lines: ['+1 to maximum number of Summoned Totems'] },
  { id: 'minionMore', group: 'minion', lines: ['Minions deal 10% more Damage'] },
  { id: 'minionDamage', group: 'minion', lines: ['Minions deal 30% increased Damage'] },
  { id: 'minionAttackSpeed', group: 'minion', lines: ['Minions have 10% increased Attack Speed'] },
  { id: 'minionCastSpeed', group: 'minion', lines: ['Minions have 10% increased Cast Speed'] },
];

export const DEFENCE_AXES: Array<{ id: string; lines: string[] }> = [
  { id: 'flatLife', lines: ['+100 to maximum Life'] },
  { id: 'increasedLife', lines: ['10% increased maximum Life'] },
  { id: 'flatEnergyShield', lines: ['+200 to maximum Energy Shield'] },
  { id: 'armour', lines: ['+2000 to Armour'] },
  { id: 'evasion', lines: ['+2000 to Evasion Rating'] },
  { id: 'block', lines: ['+5% Chance to Block Attack Damage'] },
  { id: 'spellBlock', lines: ['+5% Chance to Block Spell Damage'] },
  { id: 'suppression', lines: ['+5% chance to Suppress Spell Damage'] },
  { id: 'elementalResists', lines: ['+10% to all Elemental Resistances'] },
  { id: 'chaosResist', lines: ['+20% to Chaos Resistance'] },
];

const LAYERS = ['Life', 'EnergyShield', 'Ward', 'Mana', 'Armour', 'PhysicalDamageReduction', 'Evasion', 'EvadeChance', 'BlockChance', 'SpellBlockChance', 'SpellSuppressionChance', 'AttackDodgeChance', 'SpellDodgeChance', 'NetLifeRegen', 'LifeLeechGainRate', 'TotalEHP'];
/** Sums and per-stack rows: the rest of the engine's *DPS outputs are the build's real damage sources, so a new output shows up by itself. */
const NOT_A_SOURCE = /^(Combined|Full|FullDot|TotalDot|Poison|With\w*|Reservation\w*)DPS$/;
const STACK_STAT = /(Stacks|StackPotential|StacksMax)$/;
const NOISE_FLAGS = new Set(['buffs', 'combat', 'effective', 'notAverage']);
/** Above any count the game has; a stack limit shows as no change between here and twice this. */
const FAR = 4096;
const EPS = 1e-6;
/** A row under this share of the number is not something the number relies on. */
const MIN_PERCENT = 0.5;
const BUDGET_MS = 25_000;

type Raw = Record<string, unknown>;
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const round = (x: number) => Math.round(x * 100) / 100;

/** The number "damage" means for this build: FullDPS when skills are flagged into it, else the bigger of the player's and the minion's total. */
export function damageStat(raw: Raw): 'FullDPS' | 'CombinedDPS' | 'Minion' {
  if (num(raw.FullDPS) > 0) return 'FullDPS';
  return num((raw.Minion as Raw | undefined)?.CombinedDPS) > num(raw.CombinedDPS) ? 'Minion' : 'CombinedDPS';
}
const damageOf = (raw: Raw, stat: ReturnType<typeof damageStat>) => (stat === 'Minion' ? num((raw.Minion as Raw | undefined)?.CombinedDPS) : num(raw[stat]));

/** Damage sources in a stat table, biggest first, each with its share of the table's combined number. */
export function damageSources(raw: Raw): Array<{ id: string; label: string; value: Scalar; shown: string; sharePercent: number }> {
  const total = num(raw.CombinedDPS);
  return Object.keys(raw)
    .filter((k) => (/DPS$/.test(k) && !NOT_A_SOURCE.test(k)) || k === 'TotalDot')
    .filter((k) => num(raw[k]) > 0)
    .sort((a, b) => num(raw[b]) - num(raw[a]))
    .map((k) => {
      const sharePercent = total ? round((num(raw[k]) / total) * 100) : 0;
      // formatted as DPS: the app's stat labels do not know every output. The share rides in shown so "which part does the work" gets a number the reader can weigh
      const dps = present('TotalDPS', raw[k] as Scalar).shown;
      return { ...present(k, raw[k] as Scalar), shown: total ? `${dps} (${Math.round(sharePercent)}% of damage)` : dps, sharePercent };
    });
}

/**
 * The smallest count at which `measure` stops moving, found by search; null when it never settles (no limit up to FAR)
 * and undefined when the count changes nothing at all. shortcut: bisection assumes the number moves one way up to its limit.
 */
export async function findLimit(now: number, measure: (n: number) => Promise<string>): Promise<number | null | undefined> {
  const far = await measure(FAR);
  if (far === (await measure(now))) return undefined;
  if (far !== (await measure(FAR * 2))) return null;
  let lo = Math.max(0, Math.floor(now)), hi = FAR;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await measure(mid)) === far) hi = mid;
    else lo = mid;
  }
  return hi;
}

// ---- sustained vs allowed: what the build keeps up, read from its own text and evaluated numbers

/** English only: past forms the plain stem rule does not reach. */
const IRREGULAR: Record<string, string> = { frozen: 'freez' };
const stem = (w: string) => { const l = w.toLowerCase(); return IRREGULAR[l] ?? l.replace(/(?:ied|ing|ed|es|s)$/, ''); };

/** What a stack or condition setting is about, from its label: "# of Withered Stacks:" is Withered; null when the label names a situation, not a stack. */
export function optionNoun(label: string): string | null {
  const t = label.replace(/\^x[0-9A-Fa-f]{6}|\^\d/g, '').trim();
  if (/recently|in the (?:last|past)|^(?:is|are)\b.*\b(?:on|at|near|in)\b/i.test(t)) return null;
  const m = /^(?:# of|Do you use|Do you have|Is the enemy|Are you)\s+(.+?)(?:\s+stacks?)?(?:\s+on (?:enemy|you))?(?:\s*\(if not maximum\))?\s*[:?]?$/i.exec(t) ?? /^([A-Z]\w+(?: \w+)?)(?:\s+stacks?)?:$/i.exec(t);
  const noun = m?.[1]?.replace(/^(?:an?|the)\s+/i, '').trim();
  return noun && noun.split(/\s+/).length <= 3 ? noun : null;
}

/** Matches the noun and its other forms ("Withered" also finds "Wither" and "Withers"). */
export const nounPattern = (noun: string) => new RegExp(`\\b${noun.split(/\s+/).map(stem).join('\\s+')}\\w*`, 'i');

export interface Grant { chance: number; count: number; cap: number | null; seconds: number | null; event: 'use' | 'hit' | 'crit' | 'period' | 'kill' | 'minion' | 'other'; period: number | null }

const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const amount = (w: string | undefined) => (w === undefined ? null : (WORDS[w.toLowerCase()] ?? (Number.isFinite(Number(w)) ? Number(w) : null)));
export const cleanLine = (l: string) => l.replace(/\{[^}]*\}/g, '').replace(/\(Not supported yet\)/gi, '').trim();
const GRANT_VERB = /\b(?:inflicts?|applies|apply|gains?|grants?|gives?|creates?|causes?|generates?|chance to|always|will be|you have)\b((?:\s+[^\s,]+){0,4})\s*$/i;
/** A word in the gap means the noun is what the line scales on, not what it grants ("damage per Power Charge"). */
const GAP_STOP = /\b(?:per|while|if|when|against|from|of|with|for|on|by|at|buff)\b/i;
/** The grant is the consequence of something else having happened ("as you inflict poisons"). */
const AFTER_CONDITION = /\b(?:as you|when|whenever|while|if you)\b[^,]*$/i;

/** What a text line grants of the noun: its chance, count, duration and what sets it off. Null when the line only mentions the noun. */
export function readGrant(text: string, noun: RegExp): Grant | null {
  const line = cleanLine(text);
  const sentence = line.split(/(?<=\.)\s+/).find((s) => noun.test(s));
  const m = sentence ? noun.exec(sentence) : null;
  if (!sentence || !m) return null;
  const before = sentence.slice(0, m.index);
  const verb = GRANT_VERB.exec(before);
  if (!verb || GAP_STOP.test(verb[1]!) || AFTER_CONDITION.test(before.slice(0, verb.index))) return null;
  const period = /\bevery (?:(\S+) )?seconds?\b/i.exec(sentence);
  // "1 Endurance Charge per 5 Power": the count hangs on something this line does not give
  const perSomething = /\bper (?!second)/i.test(sentence.slice(m.index));
  const event: Grant['event'] = /\bminions?\b|\bsummoned\b/i.test(sentence) ? 'minion'
    : perSomething ? 'other'
    : /\bkill(?:s|ed|ing)?\b/i.test(sentence) ? 'kill'
    : /\bcritical(?:ly)?\b/i.test(sentence) ? 'crit'
    : /\bhits?\b/i.test(sentence) ? 'hit'
    : period ? 'period'
    : /\b(?:when|whenever|after|first time|each time|while|if you)\b/i.test(sentence) ? 'other' : 'use';
  return {
    chance: Number(/(\d+(?:\.\d+)?)\)?% chance/i.exec(sentence)?.[1] ?? 100),
    count: Number(/(\d+)/.exec(verb[1]!)?.[1] ?? 1),
    cap: amount(/(\d+) or fewer/i.exec(sentence)?.[1]),
    seconds: amount(/\bfor (\S+) seconds?\b/i.exec(sentence)?.[1]),
    event,
    period: period ? (amount(period[1]) ?? 1) : null,
  };
}

/** The share of time something with `tries` chances per duration, each landing at `chance` (0..1), is up. */
export function upShare(tries: number, chance: number): number {
  if (tries <= 0) return 0;
  return tries < 1 ? tries * chance : 1 - (1 - Math.min(chance, 1)) ** tries;
}

/**
 * Charges that all share one duration, refreshed by each gain: the expected gains in a row before a gap longer than
 * the duration drops them. Stacks that expire one by one are rate x duration instead.
 */
export const chargesHeld = (ratePerSecond: number, seconds: number) => Math.expm1(ratePerSecond * seconds);

interface Numbers { uses: number; hits: number; crits: number; duration: number; durationMod: number; uptime: number | null; ownCast: boolean }
function numbersOf(raw: Raw, flags: string[], isMain: boolean): Numbers {
  const totems = flags.includes('totem') ? Math.max(1, num(raw.ActiveTotemLimit)) : 1;
  const speed = num(raw.Speed);
  const uses = (speed || (num(raw.Cooldown) ? 1 / num(raw.Cooldown) : 0)) * totems;
  const hits = (speed * totems * (typeof raw.HitChance === 'number' ? raw.HitChance : 100)) / 100;
  return { uses, hits, crits: (hits * num(raw.CritChance)) / 100, duration: num(raw.Duration), durationMod: num(raw.DurationMod) || 1, uptime: typeof raw.DurationUptime === 'number' ? raw.DurationUptime / 100 : null, ownCast: !isMain && speed > 0 && flags.includes('selfCast') };
}

/** The stat of the table named `<noun><suffix>` ("PowerChargesDuration"), so a mechanic the engine reports is found by its name. */
export function nounStat(raw: Raw, noun: string, suffix: string): number | null {
  const re = new RegExp(`^${noun.split(/\s+/).map(stem).join('')}\\w{0,3}${suffix}$`, 'i');
  const key = Object.keys(raw).find((k) => re.test(k) && typeof raw[k] === 'number');
  return key ? (raw[key] as number) : null;
}

type GameLine = { kind: 'support' | 'skill' | 'unique' | 'passive'; name: string; line: string };
let gameLines: Promise<GameLine[]> | null = null;
/** Tests only: the cache is app-wide, so a test that needs a cold read clears it first. */
export function resetGameLines(): void { gameLines = null; }
/** Every line of game data that can grant something: gem tooltips, unique text, passives. Static, read once; a failed or incomplete read is not kept. */
export function allGameLines(ctx: ToolContext, buildId: string, version: string): Promise<GameLine[]> {
  if (gameLines) return gameLines;
  const load = async (): Promise<GameLine[]> => {
    let incomplete = false;
    const out: GameLine[] = [];
    const { gems } = await ctx.engine.send('gemCatalog', {} as Record<string, never>);
    for (const g of gems) {
      if (g.legacy) continue;
      const tip = await ctx.engine.send('gemTip', { buildId, skillId: skillIdOf(g), level: Math.min(20, g.maxLevel) }).then((r) => tipText(r.tip.lines), () => ((incomplete = true), []));
      for (const line of tip.slice(1)) out.push({ kind: g.support ? 'support' : 'skill', name: g.name, line });
    }
    const { catalog } = await ctx.engine.send('itemCatalog', {} as Record<string, never>);
    for (const u of catalog.uniques) for (const line of u.text.split('\n')) out.push({ kind: 'unique', name: u.name, line });
    for (const n of (await ctx.tree.all(version)).values()) {
      for (const line of [...n.stats, ...(n.effects ?? []).flatMap((e) => e.stats)]) out.push({ kind: 'passive', name: n.name, line });
    }
    if (incomplete && gameLines === p) gameLines = null;
    return out;
  };
  const p = load();
  gameLines = p;
  p.catch(() => { if (gameLines === p) gameLines = null; });
  return p;
}

type Source = { kind: 'skill' | 'support' | 'item' | 'passive' | 'mainSkill'; name: string; group?: number; gem?: number; line: string; grant: Grant; lines: string[] };

/** The build's own text: gems of live groups, worn items and jewels, allocated passives and mastery picks. */
export async function buildLines(ctx: ToolContext, scratch: string, xml: string, liveGroups: Set<number>) {
  const out: Array<Omit<Source, 'line' | 'grant'>> = [];
  const { gems } = await ctx.engine.send('gemCatalog', {} as Record<string, never>);
  const tips = new Map<string, string[]>();
  for (const g of readSkills(xml)) {
    if (!g.enabled || !liveGroups.has(g.index)) continue;
    for (const [gi, gem] of g.gems.entries()) {
      const info = gem.enabled ? gems.find((x) => x.name === gem.name) : undefined;
      if (!info) continue;
      const level = Math.min(gem.level ?? 20, info.maxLevel);
      const key = `${info.id}:${level}`;
      if (!tips.has(key)) tips.set(key, await ctx.engine.send('gemTip', { buildId: scratch, skillId: skillIdOf(info), level }).then((r) => tipText(r.tip.lines), () => []));
      out.push({ kind: gem.support ? 'support' : 'skill', name: gem.name, group: g.index, gem: gi + 1, lines: tips.get(key)!.slice(1) });
    }
  }
  for (const i of readEquipped(xml)) if (!/Swap/.test(i.slot)) out.push({ kind: 'item', name: i.name, lines: i.text.split('\n') });
  const { tree } = await ctx.engine.send('treeState', { buildId: scratch });
  const model = readItems(xml);
  for (const [, id] of tree.jewels) {
    const text = model.items.find((i) => i.id === id)?.text;
    if (text) out.push({ kind: 'item', name: text.split('\n')[1]?.trim() ?? 'Jewel', lines: text.split('\n') });
  }
  const allocated = new Set(tree.allocated);
  for (const n of [...(await ctx.tree.nodes(tree.treeVersion, tree.allocated)), ...tree.generated.filter((g) => allocated.has(g.id))]) if (n.stats.length) out.push({ kind: 'passive', name: n.name, lines: n.stats });
  for (const [node, effect] of tree.masteries) {
    const e = (await ctx.tree.node(tree.treeVersion, node))?.effects?.find((x) => x.id === effect);
    if (e) out.push({ kind: 'passive', name: 'Mastery', lines: e.stats });
  }
  return { lines: out, version: tree.treeVersion };
}

const signed = (p: number) => `${p > 0 ? '+' : ''}${p}%`;

export const DIAGNOSE_TOOLS: ToolDef[] = [
  {
    name: 'diagnoseBuild',
    chip: 'Diagnose build',
    description:
      'The first read for any problem with a build ("damage feels low", "why do I die", "what should I scale", "is X worth it"). Runs the engine many times on a scratch copy and returns: damage (what really deals it: hit, ignite, poison, bleed, skill damage over time, minion; the build\'s other skills if they were the main one; stacks), axes (what a fixed small bump of each scaling axis is worth to that number; noEffect lists axes that move nothing; noEffectUnless lists axes that move nothing only while a setting holds, with what they give when it does not: never call those useless, say when they count), config (settings the number relies on and what each does when off or at its limit; limit is found by raising the count until the engine stops moving; fromBuild means a gem, item or passive of this build makes that setting matter), defence (weakest max hits, resistances, top problems, layers and what a bump of each is worth), sustain (for each stack or condition the number leans on: what the build keeps up, not what the engine allows). The build is not changed. Takes a few seconds: call it once per build state. Rows have an id: cite them as {{ref:axes[critMulti].shown}}, {{ref:config.relied[conditionEnemyChilled].lossShown}} (damage lost without it) or {{ref:config.available[x].gainShown}} and {{ref:config.available[x].atLimit.value}}, {{ref:sustain[x].shown}}, {{ref:sustain[x].dpsAtSustained.shown}}, {{ref:sustain[x].dpsAtMax.shown}}, {{ref:sustain[x].vsMaxShown}}.',
    shape: { draftId: z.string().max(20).optional().describe('Diagnose a draft instead of the open build.') },
    async run(args, ctx) {
      const b = need(ctx, args);
      const xml = await xmlOf(ctx, b.buildId);
      const audit = await auditBuild(ctx, b.buildId, xml).catch(() => null);
      const out = await withScratch(ctx, xml, (scratch) => diagnose(ctx, scratch, xml));
      if (!audit) return out;
      // stacks or charges set above what the build keeps up join the one-change fix, at what it keeps up
      let fixAll = audit.fixAll;
      const { state } = await ctx.engine.send('configState', { buildId: b.buildId });
      const have = new Set((fixAll?.edits ?? []).flatMap((e) => (e.kind === 'setConfig' ? [e.key] : [])));
      const rows = (out.sustain as Array<{ id: string; label: string; status: string; sustained?: number; shown?: string | null }>).filter(
        (r) => r.status === 'belowMax' && typeof r.sustained === 'number' && /stacks|charges/.test(r.shown ?? '') && !have.has(r.id) && typeof state.values[r.id] === 'number' && (state.values[r.id] as number) > r.sustained,
      );
      if (rows.length) {
        const edits: ToolEdit[] = [...(fixAll?.edits ?? []), ...rows.map((r): ToolEdit => ({ kind: 'setConfig', key: r.id, value: /charges/.test(r.shown!) ? Math.floor(r.sustained!) : r.sustained! }))];
        const lines = [...(fixAll?.lines ?? []), ...rows.map((r) => `Set "${r.label.replace(/\^x[0-9A-Fa-f]{6}|\^\d/g, '').replace(/:$/, '')}" to ${r.shown}: what the build keeps up`)];
        fixAll = (await measureFixAll(ctx, b.buildId, xml, edits, lines)) ?? fixAll;
      }
      return { audit: { ...auditForAnswer(audit), ...(fixAll ? { fixAll } : {}) }, ...out, note: `${out.note} ${AUDIT_NOTE}` };
    },
  },
];

type Row = { id: string; label: string; section: string; now: unknown; fromBuild: boolean; whenOff?: unknown; whenOn?: unknown; whenZero?: unknown; atLimit?: unknown; noLimit?: unknown; choices?: unknown; damageGain: number; damageLoss: number; ehpPercent: number };

async function diagnose(ctx: ToolContext, scratch: string, xml: string) {
  const started = Date.now();
  const late = () => Date.now() - started > BUDGET_MS;
  const rawBase = Object.fromEntries(((await ctx.engine.send('getStats', { buildId: scratch })).stats as StatValue[]).map((s) => [s.id, s.value])) as Raw;
  const stats = await statMap(ctx, scratch);
  const stat = damageStat(rawBase);
  const full = stat === 'FullDPS';
  const base = damageOf(rawBase, stat);
  if (!base && !num(rawBase.TotalEHP)) throw new ToolError('The engine reports no damage and no effective HP for this build.');

  const run = async (edit: ToolEdit): Promise<Raw | null> => {
    const r = await ctx.engine.send('previewEdit', { buildId: scratch, edit: toBuildEdit(edit), full });
    if (r.blocked) return null;
    const after: Raw = { ...rawBase };
    for (const c of r.statDiff.changed) after[c.statId] = c.after;
    return after;
  };
  const pct = (now: number, was: number) => (was ? round(((now - was) / Math.abs(was)) * 100) : 0);
  const dmgPct = (r: Raw) => pct(damageOf(r, stat), base);
  const ehpPct = (r: Raw) => pct(num(r.TotalEHP), num(rawBase.TotalEHP));
  const sig = (r: Raw | null) => (r ? `${damageOf(r, stat).toPrecision(9)}|${num(r.TotalEHP).toPrecision(9)}` : 'refused');
  const moved = (r: Raw) => Math.abs(damageOf(r, stat) - base) > EPS * Math.abs(base || 1) || Math.abs(num(r.TotalEHP) - num(rawBase.TotalEHP)) > EPS * Math.abs(num(rawBase.TotalEHP) || 1);

  const { state: config } = await ctx.engine.send('configState', { buildId: scratch });
  const { catalog } = await ctx.engine.send('configCatalog', {} as Record<string, never>);
  const customBlocks = config.customMods.map((m) => ({ title: m.title, enabled: m.enabled, text: m.text }));
  const withLines = (lines: string[]): ToolEdit => ({ kind: 'setCustomMods', blocks: [...customBlocks, { title: 'probe', enabled: true, text: lines.join('\n') }] });

  // ---- axes
  const axes: Array<{ id: string; group: string; bump: string; percent: number; shown: string }> = [];
  const noEffect: string[] = [];
  for (const a of DAMAGE_AXES) {
    if (late()) break;
    const r = await run(withLines(a.lines));
    const p = r ? dmgPct(r) : 0;
    if (Math.abs(p) >= 0.01) axes.push({ id: a.id, group: a.group, bump: a.lines.join('; '), percent: p, shown: signed(p) });
    else noEffect.push(a.id);
  }
  axes.sort((x, y) => y.percent - x.percent);

  // ---- config
  // map mods are content the player meets, and enemy stats are the numbers the rest is measured against
  const skippedSections = /^(Custom Modifiers|Enemy Stats|Map Modifiers)/i;
  const rows: Row[] = [];
  const effect = (r: Raw, value: unknown) => ({ value, percent: dmgPct(r), shown: signed(dmgPct(r)), ehpPercent: ehpPct(r), ehpShown: signed(ehpPct(r)) });
  for (const o of catalog.options) {
    if (late()) break;
    // a hidden setting left set still counts in the number, so it stays in
    if (!o.var || o.type === 'label' || (config.shown[o.var] === false && !(o.var in config.values)) || skippedSections.test(o.section)) continue;
    const key = o.var;
    const now = config.values[key] ?? config.defaults[key] ?? null;
    const set = (value: Scalar) => run({ kind: 'setConfig', key, value });
    const row: Row = { id: key, label: o.label.replace(/\^x[0-9A-Fa-f]{6}|\^\d/g, '').replace(/:$/, ''), section: o.section, now, fromBuild: Object.keys(o.conditions).some((k) => k !== 'ifOption'), damageGain: 0, damageLoss: 0, ehpPercent: 0 };
    const note = (r: Raw) => {
      row.damageGain = Math.max(row.damageGain, dmgPct(r));
      row.damageLoss = Math.min(row.damageLoss, dmgPct(r));
      if (Math.abs(ehpPct(r)) > Math.abs(row.ehpPercent)) row.ehpPercent = ehpPct(r);
    };
    if (o.type === 'check') {
      const r = await set(!now);
      if (!r || !moved(r)) continue;
      note(r);
      if (now) row.whenOff = effect(r, false);
      else row.whenOn = effect(r, true);
    } else if (o.type === 'list') {
      const tried: Array<ReturnType<typeof effect> & { label: string }> = [];
      for (const c of (o.list ?? []).slice(0, 8)) {
        if (c.val === now) continue;
        const r = await set(c.val as Scalar);
        if (r && moved(r)) { note(r); tried.push({ ...effect(r, c.val), label: c.label }); }
      }
      if (!tried.length) continue;
      row.choices = tried.sort((x, y) => y.percent - x.percent).slice(0, 4);
    } else {
      const current = num(now);
      const memo = new Map<number, string>();
      const measure = async (n: number) => {
        if (memo.has(n)) return memo.get(n)!;
        const r = await set(n);
        const s = sig(r);
        memo.set(n, s);
        return s;
      };
      const limit = await findLimit(current, measure);
      if (limit === undefined && !current) continue;
      if (current > 0) {
        const r = await set(0);
        if (r && moved(r)) { note(r); row.whenZero = effect(r, 0); }
      }
      if (typeof limit === 'number' && limit !== current) {
        const r = await set(limit);
        if (r) { note(r); row.atLimit = effect(r, limit); }
      } else if (limit === null) {
        const step = Math.max(1, current * 2);
        const r = await set(step);
        if (r) { note(r); row.noLimit = effect(r, step); }
      }
      if (!row.whenZero && !row.atLimit && !row.noLimit) continue;
    }
    rows.push(row);
  }
  // skill stages and mine counts: the same search on the main group's gems, found by trying them, not by a list of skills
  const main = (await ctx.engine.send('skillsState', { buildId: scratch })).state;
  const mainGroup = readSkills(xml).find((g) => g.index === main.mainGroup);
  for (const [i, g] of (mainGroup?.gems ?? []).entries()) {
    if (late() || g.support) continue;
    for (const attr of ['skillStageCount', 'skillMineCount'] as const) {
      const measure = async (n: number) => sig(await run({ kind: 'setGem', group: mainGroup!.index, gem: i + 1, attr, value: n }));
      const limit = await findLimit(1, measure);
      if (typeof limit !== 'number') continue;
      const r = await run({ kind: 'setGem', group: mainGroup!.index, gem: i + 1, attr, value: limit });
      if (r && moved(r)) rows.push({ id: `${attr}:${g.name}`, label: `${g.name}: ${attr === 'skillStageCount' ? 'stages' : 'mines'}`, section: 'Skills', now: null, fromBuild: true, atLimit: effect(r, limit), damageGain: Math.max(0, dmgPct(r)), damageLoss: Math.min(0, dmgPct(r)), ehpPercent: ehpPct(r) });
    }
  }
  // relied: taking it away costs damage. available: damage the setting would add, what the build itself feeds first.
  const relied = rows.filter((r) => r.damageLoss <= -MIN_PERCENT && (r.whenOff || r.whenZero || r.choices)).sort((a, b) => a.damageLoss - b.damageLoss);
  const available = rows.filter((r) => r.damageGain >= MIN_PERCENT).sort((a, b) => Number(b.fromBuild) - Number(a.fromBuild) || b.damageGain - a.damageGain);
  const shownRow = (r: Row) => ({ ...r, gainShown: signed(r.damageGain), lossShown: signed(r.damageLoss), ehpShown: signed(r.ehpPercent) });
  const forDefence = rows.filter((r) => Math.abs(r.ehpPercent) >= MIN_PERCENT).sort((a, b) => Math.abs(b.ehpPercent) - Math.abs(a.ehpPercent));

  // ---- a resistance axis that does nothing only while a setting holds: an RF Chieftain's enemies have no fire resistance
  // against damage over time while stationary, so curses and exposure count only when moving
  const debuff = new Set(DAMAGE_AXES.filter((a) => a.group === 'penetration and debuffs').map((a) => a.id));
  let blocked = noEffect.filter((id) => debuff.has(id));
  const noEffectUnless: Array<{ id: string; countsWhen: string; setting: string; percent: number; shown: string }> = [];
  for (const r of relied.filter((x) => !x.id.includes(':')).slice(0, 3)) {
    if (late() || !blocked.length) break;
    await withScratch(ctx, xml, async (off) => {
      const value = (config.defaults[r.id] ?? (typeof r.now === 'boolean' ? false : 0)) as Scalar;
      await ctx.engine.send('edit', { buildId: off, edit: toBuildEdit({ kind: 'setConfig', key: r.id, value }) });
      const offRaw = Object.fromEntries(((await ctx.engine.send('getStats', { buildId: off })).stats as StatValue[]).map((s) => [s.id, s.value])) as Raw;
      const offBase = damageOf(offRaw, stat);
      for (const id of blocked) {
        const a = DAMAGE_AXES.find((x) => x.id === id)!;
        const p = await ctx.engine.send('previewEdit', { buildId: off, edit: toBuildEdit(withLines(a.lines)), full });
        if (p.blocked) continue;
        const after: Raw = { ...offRaw };
        for (const c of p.statDiff.changed) after[c.statId] = c.after;
        const pc = pct(damageOf(after, stat), offBase);
        if (Math.abs(pc) >= 0.01) noEffectUnless.push({ id, countsWhen: `${r.label} is ${value === false ? 'off' : `set to ${String(value)}`}`, setting: r.id, percent: pc, shown: signed(pc) });
      }
    });
    blocked = blocked.filter((id) => !noEffectUnless.some((n) => n.id === id));
  }

  // ---- other skills as the main skill
  const otherSkills: Array<{ id: string; name: string; dps: number; shown: string; percentOfMain: number }> = [];
  for (const g of main.groups) {
    if (late()) break;
    if (g.synthetic || g.index === main.mainGroup || g.enabled === false) continue;
    const r = await run({ kind: 'setMainGroup', group: g.index });
    if (!r) continue;
    const dps = Math.max(num(r.CombinedDPS), num((r.Minion as Raw | undefined)?.CombinedDPS));
    const mainDps = Math.max(num(rawBase.CombinedDPS), num((rawBase.Minion as Raw | undefined)?.CombinedDPS));
    if (dps > 0 && dps !== mainDps) otherSkills.push({ id: `group${g.index}`, name: g.displayLabel, dps: round(dps), shown: present('CombinedDPS', dps).shown, percentOfMain: mainDps ? round((dps / mainDps) * 100) : 0 });
  }
  otherSkills.sort((a, b) => b.dps - a.dps);

  // ---- defence axes
  const report = defenceReport(stats);
  const weakest = report.maxHitsWeakestFirst[0]?.id;
  const defenceAxes: Array<{ id: string; bump: string; ehpPercent: number; shown: string; weakestMaxHitPercent: number | null }> = [];
  for (const a of DEFENCE_AXES) {
    if (late()) break;
    const r = await run(withLines(a.lines));
    if (!r) continue;
    const mh = weakest ? pct(num(r[weakest]), num(rawBase[weakest])) : null;
    if (Math.abs(ehpPct(r)) >= 0.01 || (mh && Math.abs(mh) >= 0.01)) defenceAxes.push({ id: a.id, bump: a.lines.join('; '), ehpPercent: ehpPct(r), shown: signed(ehpPct(r)), weakestMaxHitPercent: mh });
  }
  defenceAxes.sort((x, y) => y.ehpPercent - x.ehpPercent);

  // ---- what the build keeps up of each stack or condition the number leans on
  const skill = await ctx.engine.send('mainSkill', { buildId: scratch });
  const inNumber = (r: Row) => !!(r.whenOff || r.whenZero);
  const watched = [...new Map([...relied, ...available.filter((r) => r.fromBuild)].map((r) => [r.id, r])).values()]
    .filter((r) => !r.choices)
    .sort((a, b) => Number(inNumber(b)) - Number(inNumber(a)) || Math.max(b.damageGain, -b.damageLoss) - Math.max(a.damageGain, -a.damageLoss))
    .slice(0, 10);
  const dpsShown = (v: number) => present(stat === 'Minion' ? 'CombinedDPS' : stat, v);
  const sustain = late() ? [] : await withScratch(ctx, xml, async (other) => {
    const live = new Set(main.groups.filter((g) => !g.synthetic && g.enabled !== false && !g.displayLabel.startsWith('<')).map((g) => g.index));
    const { lines: ownLines, version } = await buildLines(ctx, scratch, xml, live);
    const mainNumbers = numbersOf(rawBase, skill.flags, true);
    const groups = new Map<number, Numbers>();
    const numbersOfGroup = async (g: number): Promise<Numbers> => {
      if (g === main.mainGroup) return mainNumbers;
      if (!groups.has(g)) {
        // on the second scratch: the first stays on the build's main skill
        await ctx.engine.send('edit', { buildId: other, edit: toBuildEdit({ kind: 'setMainGroup', group: g }) });
        const raw = Object.fromEntries(((await ctx.engine.send('getStats', { buildId: other })).stats as StatValue[]).map((s) => [s.id, s.value])) as Raw;
        groups.set(g, numbersOf(raw, (await ctx.engine.send('mainSkill', { buildId: other })).flags, false));
      }
      return groups.get(g)!;
    };
    const out = [];
    for (const row of watched) {
      if (late()) break;
      const option = catalog.options.find((o) => o.var === row.id);
      const noun = option ? optionNoun(option.label) : null;
      if (!option || !noun) {
        if (inNumber(row)) out.push({ id: row.id, label: row.label, status: 'unknown', inNumber: inNumber(row), why: 'A situation in the fight: no build number says how often it holds.' });
        continue;
      }
      const re = nounPattern(noun);
      const sources: Source[] = [];
      for (const l of ownLines) {
        const hit = l.lines.map((line) => ({ line, grant: readGrant(line, re) })).filter((x) => x.grant).at(-1);
        if (!hit || sources.some((s) => s.name === l.name && s.line === cleanLine(hit.line).slice(0, 140))) continue;
        // gear and passives state a bare chance for what happens on hit ("20% chance to inflict Brittle")
        const grant = l.group === undefined && hit.grant!.event === 'use' && hit.grant!.chance < 100 ? { ...hit.grant!, event: 'hit' as const } : hit.grant!;
        sources.push({ ...l, line: cleanLine(hit.line).slice(0, 140), grant });
      }
      // the main skill's own chance, as the engine reports it, already counts what its supports, items and passives add
      const chance = nounStat(rawBase, noun, 'Chance');
      const named = sources.filter((s) => !(chance && ['hit', 'crit'].includes(s.grant.event) && (s.group === undefined || s.group === main.mainGroup)));
      const inflicts = skill.flags.some((f) => f.toLowerCase().replace(/^inflict/, '').startsWith(noun.split(/\s+/).map(stem).join('')));
      if (chance) named.push({ kind: 'mainSkill', name: skill.name, group: main.mainGroup, line: 'its own chance on hit', grant: { chance, count: 1, cap: null, seconds: null, event: 'hit', period: null }, lines: [] });
      else if (inflicts && !named.length) named.push({ kind: 'mainSkill', name: skill.name, group: main.mainGroup, line: 'it can inflict this', grant: { chance: 100, count: 1, cap: null, seconds: null, event: 'other', period: null }, lines: [] });

      const ownDuration = nounStat(rawBase, noun, 'Duration');
      const read = [];
      for (const s of named.slice(0, 6)) {
        const own = s.group === undefined ? null : await numbersOfGroup(s.group);
        const { event, chance: pct, count, cap, seconds: inLine, period } = s.grant;
        // hits of a buff that throws none are the main skill's: the player's hits carry its chance
        const hitter = own && own.hits > 0 ? own : mainNumbers;
        const raw = event === 'use' ? (own?.uses || null) : event === 'hit' ? hitter.hits : event === 'crit' ? hitter.crits : event === 'period' ? 1 / period! : null;
        const rate = raw !== null && period ? Math.min(raw, 1 / period) : raw; // "no more than once every second"
        const written = inLine ?? amount(s.lines.map((l) => new RegExp(`${re.source}\\s+lasts (\\S+) seconds?`, 'i').exec(l)?.[1]).find(Boolean));
        const seconds = ownDuration ?? (s.kind === 'skill' && own?.duration ? own.duration : null) ?? (written === null ? null : written * (own?.durationMod ?? 1));
        const why = rate === null ? (event === 'kill' ? 'Needs kills: no build number gives a kill rate.' : event === 'minion' ? 'Comes from minions: not read here.' : 'Set off by something no build number gives a rate for.') : seconds === null ? 'Game data gives no duration for it.' : null;
        const perSecond = rate === null ? null : (rate * pct * count) / 100;
        const uptime = event === 'use' && own?.uptime != null ? own.uptime : null;
        read.push({ s, perSecond, seconds, why, cap, ownCast: event === 'use' && !!own?.ownCast, tries: rate === null || seconds === null ? null : uptime ?? rate * seconds, pct });
      }
      const known = read.filter((r) => r.perSecond !== null && r.seconds !== null);
      const twin = option.type === 'check' ? catalog.options.find((o) => (Array.isArray(o.conditions.ifOption) ? o.conditions.ifOption : [o.conditions.ifOption]).includes(row.id) && /count/i.test(o.type) && /^#/.test(o.label)) : undefined;
      const onOff = option.type === 'check' && !twin;
      const max = onOff ? 1 : option.type === 'check' ? nounStat(rawBase, noun, 'Max') : ((row.atLimit as { value: number } | undefined)?.value ?? (row.whenZero ? num(row.now) : null));
      const charges = /\bcharge/i.test(noun);
      const sum = onOff ? 1 - known.reduce((left, r) => left * (1 - upShare(r.tries!, r.pct / 100)), 1)
        : charges ? chargesHeld(known.reduce((a, r) => a + r.perSecond!, 0), Math.max(0, ...known.map((r) => r.seconds!)))
        // a source that stops at a stack count only tops up to there
        : known.filter((r) => r.cap !== null).reduce((total, r) => Math.max(total, Math.min(r.cap!, total + r.perSecond! * r.seconds!)), known.filter((r) => r.cap === null).reduce((a, r) => a + r.perSecond! * r.seconds!, 0));
      const reached = max !== null && sum >= max * 0.995;
      const grants = named.length ? [] : (await allGameLines(ctx, scratch, version)).filter((l) => readGrant(l.line, re));
      const status = !named.length ? (grants.length ? 'noSource' : 'unknown') : known.length < read.length && !reached ? 'unknown' : max === null ? 'noLimit' : reached ? 'atMax' : 'belowMax';
      const value = status === 'noSource' ? 0 : status === 'unknown' ? null : max === null ? sum : Math.min(max, sum);

      const onDps = row.whenOn ? base * (1 + (row.whenOn as { percent: number }).percent / 100) : base;
      const offDps = row.whenOff ? base * (1 + (row.whenOff as { percent: number }).percent / 100) : base;
      const maxDps = onOff || option.type === 'check' ? onDps : base * (1 + num((row.atLimit as { percent: number } | undefined)?.percent) / 100);
      let held: number | null = null;
      if (value !== null) {
        if (onOff) held = offDps + value * (onDps - offDps);
        else {
          // charges count whole: under one held is none
          const r = await run(twin ? (Math.floor(value) ? { kind: 'setConfigs', values: { [row.id]: true, [twin.var!]: Math.floor(value) } } : { kind: 'setConfig', key: row.id, value: false }) : { kind: 'setConfig', key: row.id, value: round(value) });
          held = r ? damageOf(r, stat) : null;
        }
      }
      const vs = held === null ? null : pct(held, maxDps);
      const unit = onOff ? 'of the time' : charges ? 'charges' : 'stacks';
      const shown = value === null ? null : onOff ? `${Math.round(value * 100)}% ${unit}` : `${round(value)}${max !== null ? ` of ${max}` : ''} ${unit}`;
      const grouped = ['support', 'skill', 'unique', 'passive'].flatMap((k) => grants.filter((g) => g.kind === k).slice(0, 3));
      out.push({
        id: row.id,
        label: row.label,
        status,
        inNumber: inNumber(row),
        ...(max !== null && !onOff ? { max } : {}),
        ...(value !== null ? { sustained: round(value), shown } : {}),
        ...(held !== null ? { dpsAtMax: dpsShown(maxDps), dpsAtSustained: dpsShown(held), vsMaxPercent: vs, vsMaxShown: signed(vs!) } : {}),
        ...(read.length ? { sources: read.map((r) => ({ kind: r.s.kind, name: r.s.name, line: r.s.line, ...(r.perSecond !== null ? { perSecond: round(r.perSecond) } : {}), ...(r.seconds !== null ? { seconds: round(r.seconds) } : {}), ...(r.why ? { why: r.why } : {}), ...(r.ownCast ? { takesMainSkillTime: true } : {}) })) } : {}),
        ...(grouped.length ? { grantedBy: grouped.map((g) => ({ kind: g.kind, name: g.name, line: cleanLine(g.line).slice(0, 140) })) } : {}),
        ...(status === 'unknown' && !read.length ? { why: 'No game text found that grants it.' } : {}),
      });
    }
    // A skill part that spends flask charges per use (engine outputs FlaskDrain*, solver_drain.rs): fed only while the
    // worn life flasks hold charges. shortcut: the fallback part is read with the main gem as the group's first gem.
    if (typeof rawBase.FlaskDrainUptime === 'number' && !late()) {
      const u = rawBase.FlaskDrainUptime;
      const fallback = await run({ kind: 'setGem', group: main.mainGroup, gem: 1, attr: 'skillPart', value: 1 });
      const held = fallback ? damageOf(fallback, stat) + u * (base - damageOf(fallback, stat)) : null;
      const vs = held === null ? null : pct(held, base);
      out.push({
        id: 'flaskCharges',
        label: 'Flask charges the main skill spends',
        status: u >= 0.995 ? 'atMax' : 'belowMax',
        inNumber: true,
        sustained: round(u),
        shown: `fed ${Math.round(u * 100)}% of a ${num(rawBase.FlaskDrainFightSecs)} s fight without kills (spends ${round(num(rawBase.FlaskDrainSpent))}/s, worn life flasks gain ${round(num(rawBase.FlaskDrainGained))}/s and hold ${round(num(rawBase.FlaskDrainStored))}); while mapping ${Math.round(num(rawBase.FlaskDrainUptimeMap) * 100)}%`,
        ...(held !== null ? { dpsAtMax: dpsShown(base), dpsAtSustained: dpsShown(held), vsMaxPercent: vs, vsMaxShown: signed(vs!) } : {}),
      });
    }
    return out;
  });

  const minion = rawBase.Minion && typeof rawBase.Minion === 'object' ? (rawBase.Minion as Raw) : null;
  const skillDps = rawBase.SkillDPS && typeof rawBase.SkillDPS === 'object' ? Object.values(rawBase.SkillDPS as Record<string, { name: string; dps: number; count?: number; skillPart?: string }>) : [];
  const stackRows = (t: Raw) => Object.keys(t).filter((k) => STACK_STAT.test(k) && num(t[k]) > 0).map((k) => present(k, t[k] as Scalar));
  // the number in play first: a build whose damage leans on standing still leads with what it does while moving
  const still = relied.find((r) => r.id === 'conditionStationary' || r.id === 'conditionMoving');
  const sid = stat === 'Minion' ? 'CombinedDPS' : stat;
  const leadWith = still ? { shown: `${present(sid, base * (1 + still.damageLoss / 100)).shown} while moving (${signed(still.damageLoss)}); ${present(sid, base).shown} standing still`, rule: 'Lead with leadWith.shown: the moving number first, standing still second.' } : null;
  return {
    untrustedData: true,
    buildChanged: false,
    ...(leadWith ? { leadWith } : {}),
    damage: {
      measuredOn: stat === 'Minion' ? 'minion CombinedDPS' : stat,
      now: present(stat === 'Minion' ? 'CombinedDPS' : stat, base),
      mainSkill: { name: skill.name, flags: skill.flags.filter((f) => !NOISE_FLAGS.has(f)), ...(skill.minion ? { minion: skill.minion.name, minionFlags: skill.minion.flags.filter((f) => !NOISE_FLAGS.has(f)) } : {}) },
      sources: damageSources(rawBase),
      ...(minion ? { minionSources: damageSources(minion) } : {}),
      ...(skillDps.length ? { fullDpsSkills: skillDps.map((s) => ({ id: s.name, name: s.name, ...(s.skillPart ? { part: s.skillPart } : {}), dps: round(s.dps), shown: present('FullDPS', s.dps).shown, count: s.count ?? 1 })) } : {}),
      stacks: [...stackRows(rawBase), ...(minion ? stackRows(minion) : [])],
      ...(otherSkills.length ? { otherSkillsIfMain: otherSkills.slice(0, 6) } : {}),
    },
    axes: axes.slice(0, 16),
    sustain,
    noEffect: noEffect.filter((id) => !noEffectUnless.some((n) => n.id === id)),
    ...(noEffectUnless.length ? { noEffectUnless } : {}),
    config: {
      relied: relied.slice(0, 12).map(shownRow),
      available: available.slice(0, 12).map(shownRow),
      forDefence: forDefence.slice(0, 8).map(shownRow),
    },
    defence: {
      ...report,
      layers: LAYERS.filter((id) => num(stats[id]) !== 0).map((id) => present(id, stats[id] ?? null)),
      axes: defenceAxes,
    },
    ...(late() ? { partial: 'The time budget ran out: the lists above are not complete.' } : {}),
    tookMs: Date.now() - started,
    note: 'Every percent is an engine run on a scratch copy against the build as it stands, with the rest unchanged. A bump is a what-if line, not an item that exists. At-limit rows are what the engine allows; sustain is what this build keeps up, from its own sources, rates and durations, counting one hit on the target per use. status: atMax (it reaches the limit), belowMax, noSource (nothing in this build grants it; grantedBy lists what does in game data), unknown (the data gives no rate or duration; never fill in a number), noLimit. inNumber: the damage number counts this now. When the number leans on a sustain row, say what the build keeps up (shown, and the source) and the damage at that against the damage at the limit (dpsAtSustained, dpsAtMax, vsMaxShown), biggest gap first; never call a limit reached or out of reach without it. unknown: give no figure. noSource: name only what grantedBy lists. takesMainSkillTime: that rate holds only if nothing else is cast.',
  };
}
