// The build audit: what in the build's own setup makes its numbers not hold in game (for example
// Withered stacks from a Wither the character can't cast, Onslaught with no source, a "+200% resistances" custom line, Full DPS
// counting one skill nine times, Fire Trap's number on a Righteous Fire build, a triggered guard counted as always up).
// Runs before every answer (getBuildSummary, read into every turn's facts; diagnoseBuild) and around every change (trial).
// Everything is read from the engine: its warnings, config catalog, gem tags and tooltips, item and passive text, and runs on
// a scratch copy. No skill, item or game constant is named here.
import type { StatValue } from '@pom/protocol';
import { formatStat, statMeta } from '../../shared/assistant/statLabels.js';
import { readSkills, xmlHash } from './buildReaders.js';
import { buildLines, cleanLine, damageStat, nounPattern, nounStat, optionNoun, readGrant } from './diagnose.js';
import { unmetGems } from './gemFit.js';
import { applyEdits, buildWarnings } from './playerSense.js';
import { emptyGear, tipText, toBuildEdit, TOOLS, withScratch, type Scalar, type ToolContext, type ToolEdit } from './tools.js';
import { skillIdOf } from '../../shared/skillsLogic.js';
import { pointBudget } from './rankTools.js';
import { readItems } from '../../shared/itemsXml.js';
import { immunityFlasks, resistCraft } from './itemFit.js';

type Raw = Record<string, unknown>;
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const strip = (s: string) => s.replace(/\^x[0-9A-Fa-f]{6}|\^\d/g, '').replace(/:$/, '').trim();

export interface Finding {
  id: string;
  kind: 'requirement' | 'warning' | 'config' | 'count' | 'custom' | 'damageSkill' | 'conditionalDefence' | 'hole';
  /** The shown damage or defence does not hold in game until this is fixed: say it first. */
  fatal: boolean;
  shown: string;
  fix?: string;
  /** The edits behind `fix` (or that make the number honest), for proposeEdit. */
  edits?: ToolEdit[];
  /** damageSkill: Full DPS with every damage skill counted, and their names. */
  together?: { value: number; skills: string[] };
  /** damageSkill: each damage skill's own Combined DPS, the number the Skills tab shows when that skill is selected. */
  perSkill?: Array<{ name: string; dps: number }>;
  /** What the fix adds to the damage, in percent, when measured (a ranker leads with it when it beats its own pick). */
  gainPct?: number;
  /** config: where the game data says the setting's subject comes from, as one sentence the app writes itself. */
  sourceLine?: string;
  /** The gems a finding is about: an answer or card that names every one has covered it, so the app does not add it again. */
  names?: string[];
  /** conditionalDefence: the skill counted as always up and effective HP without it. */
  without?: { name: string; ehp: number };
}

export interface FixAll { edits: ToolEdit[]; lines: string[]; shown: string }

/** fixAll measured on a scratch copy: every edit applied together, damage and Effective HP before and after. */
export async function measureFixAll(ctx: ToolContext, buildId: string, xml: string, edits: ToolEdit[], lines: string[]): Promise<FixAll | null> {
  if (!edits.length) return null;
  const before = await rawOf(ctx, buildId);
  const stat = damageStat(before);
  const full = stat === 'FullDPS';
  const after = await withScratch(ctx, xml, async (s) => { await applyEdits(ctx, s, edits, full); return rawOf(ctx, s); }).catch(() => null);
  if (!after) return null;
  const sid = statId(stat);
  const dmg = (r: Raw) => (stat === 'Minion' ? num((r.Minion as Raw | undefined)?.CombinedDPS) : num(r[stat]));
  const moved = [moveText(sid, dmg(before), dmg(after)), moveText('TotalEHP', num(before.TotalEHP), num(after.TotalEHP))].filter((t, i) => (i ? movedEnough(num(before.TotalEHP), num(after.TotalEHP), 0.001) : movedEnough(dmg(before), dmg(after), 0)) && t);
  return { edits, lines, shown: moved.join(', ') || 'no change to damage or Effective HP' };
}

const ENLIGHTEN = 'Metadata/Items/Gems/SkillGemSupportEnlighten';

/** Orders the ways to fix an over-reserved pool, best first. */
export function sortReservationWays<T extends { name: string; loss: number }>(ways: T[]): T[] {
  // the engine's measured cost decides; on a tie, keeping every aura on goes first
  const off = (w: T) => Number(w.name.startsWith('Turn off'));
  return ways.sort((a, c) => a.loss - c.loss || off(a) - off(c));
}

export interface ReservationFit { off: string[]; edits: ToolEdit[]; raw: Raw }

/** On `b` (a scratch, changed in place): the reservation skills to turn off so `pool` is no longer over-reserved, losing the
 *  least damage and effective HP; null when it already fits or turning every one off still does not (Blood Magic: 135% of life reserved). */
export async function fitReservation(ctx: ToolContext, b: string, pool: 'Life' | 'Mana'): Promise<ReservationFit | null> {
  const start = await rawOf(ctx, b);
  if (num(start[`${pool}Unreserved`]) >= 0) return null;
  const stat = damageStat(start);
  const full = stat === 'FullDPS';
  const base = damageOf(start, stat), ehp = num(start.TotalEHP);
  const lossOf = (r: Raw) => (base ? (base - damageOf(r, stat)) / base : 0) + (ehp ? (ehp - num(r.TotalEHP)) / ehp : 0);
  const { state } = await ctx.engine.send('skillsState', { buildId: b });
  const offEdit = (g: number, x: number, value: boolean): ToolEdit => ({ kind: 'setGem', group: g, gem: x, attr: 'enabled', value });
  const peek = async (edit: ToolEdit, now: Raw): Promise<Raw | null> => {
    const r = await ctx.engine.send('previewEdit', { buildId: b, edit: toBuildEdit(edit), full });
    if (r.blocked) return null;
    const out: Raw = { ...now };
    for (const c of r.statDiff.changed) out[c.statId] = c.after;
    return out;
  };
  // a reservation skill is one whose turning off lowers what the pool reserves
  let cands: Array<{ name: string; g: number; x: number }> = [];
  for (const g of state.groups) {
    if (!g.enabled || g.slotInactive) continue;
    for (const x of g.gems) {
      if (!x.enabled || x.support) continue;
      const r = await peek(offEdit(g.index, x.index, false), start);
      if (r && num(r[`${pool}Reserved`]) < num(start[`${pool}Reserved`])) cands.push({ name: x.nameSpec, g: g.index, x: x.index });
    }
  }
  const off: typeof cands = [];
  let now = start;
  while (num(now[`${pool}Unreserved`]) < 0 && cands.length) {
    const tried = (await Promise.all(cands.map(async (c) => ({ c, r: await peek(offEdit(c.g, c.x, false), now) })))).filter((t): t is { c: typeof cands[number]; r: Raw } => !!t.r);
    if (!tried.length) break;
    const fit = tried.filter((t) => num(t.r[`${pool}Unreserved`]) >= 0).sort((a, c) => lossOf(a.r) - lossOf(c.r))[0];
    // none fits alone: drop the one that frees the most per point of loss, then look again
    const freed = (t: { r: Raw }) => (num(t.r[`${pool}Unreserved`]) - num(now[`${pool}Unreserved`])) / (Math.max(0, lossOf(t.r) - lossOf(now)) + 0.01);
    const pick = fit ?? tried.sort((a, c) => freed(c) - freed(a))[0]!;
    await ctx.engine.send('edit', { buildId: b, edit: toBuildEdit(offEdit(pick.c.g, pick.c.x, false)) });
    off.push(pick.c);
    cands = cands.filter((c) => c !== pick.c);
    now = await rawOf(ctx, b);
  }
  if (num(now[`${pool}Unreserved`]) < 0) return null;
  // put back any that still fit once the others are off
  for (const c of [...off]) {
    const r = await peek(offEdit(c.g, c.x, true), now);
    if (r && num(r[`${pool}Unreserved`]) >= 0 && lossOf(r) < lossOf(now)) {
      await ctx.engine.send('edit', { buildId: b, edit: toBuildEdit(offEdit(c.g, c.x, true)) });
      off.splice(off.indexOf(c), 1);
      now = await rawOf(ctx, b);
    }
  }
  return { off: off.map((c) => c.name), edits: off.map((c) => offEdit(c.g, c.x, false)), raw: now };
}

/** `viaFix`: usable sources that only work once their gem level is lowered to fit (the requirement fix, done in the same step). */
export interface ConfigSource { value: Scalar; usable: string[]; unusable: string[]; viaFix: string[]; cap: number | null }

export interface Audit {
  findings: Finding[];
  damage: { stat: string; skill: string; shown: string };
  enemy: { shown: string; note?: string };
  /** The numbers with every finding that inflates them taken out: what the build reaches in game as it stands. */
  honest?: { edits: ToolEdit[]; shown: string; damage: { before: string; after: string }; ehp: { before: string; after: string } };
  /** The fixes with one right answer (gem levels that fit, config the build cannot keep up, typed-in mods), together: one change, one Undo. */
  fixAll?: FixAll;
  /** The damage while moving when the number leans on standing still: the app writes it first. */
  moving?: { shown: string };
  /** Per set config var whose subject the build must supply: where it comes from. trial() compares it after a change. */
  configSources: Record<string, ConfigSource>;
  /** Lines of the build's gems, items and passives the engine marks "Not supported": it does not count them. */
  unsupported: Array<{ name: string; line: string }>;
  tookMs: number;
}

const rawOf = async (ctx: ToolContext, buildId: string): Promise<Raw> =>
  Object.fromEntries(((await ctx.engine.send('getStats', { buildId })).stats as StatValue[]).map((s) => [s.id, s.value]));

const damageOf = (raw: Raw, stat: ReturnType<typeof damageStat>) => (stat === 'Minion' ? num((raw.Minion as Raw | undefined)?.CombinedDPS) : num(raw[stat]));
const statId = (stat: ReturnType<typeof damageStat>) => (stat === 'Minion' ? 'CombinedDPS' : stat);
const pctText = (from: number, to: number) => (from ? ` (${to >= from ? '+' : '-'}${Math.abs(Math.round(((to - from) / Math.abs(from)) * 1000) / 10)}%)` : '');
// a resistance moves in points, never as a relative percent ("43% -> 76% (+76.7%)" read wrong to players)
const moveText = (id: string, from: number, to: number) => `${statMeta(id).label} ${formatStat(id, from)} -> ${formatStat(id, to)}${/Resist$/.test(id) ? '' : pctText(from, to)}`;
const movedEnough = (from: number, to: number, share = 0.01) => Math.abs(to - from) > share * Math.abs(from || 1);

/** A Full DPS count that stood for the projectiles a skill fired, scaled to what it fires now (never below 1). */
export const scaledCount = (count: number, projBefore: number, projAfter: number) => Math.max(1, Math.round((count * projAfter) / projBefore));

/** The main skill's count in Full DPS when it is above 1 (several copies counted at once), else 1. */
export function mainCount(state: { mainGroup: number; groups: Array<{ index: number; enabled?: boolean; includeInFullDPS?: boolean; gems: Array<{ support: boolean; enabled: boolean; count: number }> }> }): number {
  const g = state.groups.find((x) => x.index === state.mainGroup);
  return g?.includeInFullDPS ? Math.max(1, ...g.gems.filter((x) => !x.support && x.enabled).map((x) => x.count || 1)) : 1;
}

/**
 * Stats after a what-if with the main skill's Full DPS count scaled to the projectiles it fires after it, as the change
 * itself will set it (auditChange): a swap that cuts projectiles must not rank on copies that no longer fly.
 * Full DPS counts the main skill's Combined DPS once per copy, so dropping copies takes that many Combined DPS off.
 */
export function withScaledCount(before: Record<string, Scalar>, after: Record<string, Scalar>, count: number): Record<string, Scalar> {
  const pb = num(before.ProjectileCount), pa = num(after.ProjectileCount);
  if (!(count > 1) || !(pb > 0) || !(pa > 0) || pa === pb || !(num(after.FullDPS) > 0)) return after;
  const to = scaledCount(count, pb, pa);
  return to === count ? after : { ...after, FullDPS: num(after.FullDPS) - (count - to) * num(after.CombinedDPS) };
}

/** The groups and gems a player can really use: enabled, in the active weapon set, requirement met. */
async function usableGems(ctx: ToolContext, buildId: string) {
  const { state } = await ctx.engine.send('skillsState', { buildId });
  const unmet = await unmetGems(ctx, buildId);
  // a gem that fits at a lower level still works: the change lowers it in the same step (fitGemLevels)
  const bad = new Set(unmet.filter((g) => !(g.fit > 0)).map((g) => g.key));
  const fixable = new Set(unmet.filter((g) => g.fit > 0).map((g) => g.key));
  // a support only works through the skills it supports: a group whose every active gem is unusable gives nothing
  for (const g of state.groups) {
    const actives = g.gems.filter((x) => !x.support && x.enabled);
    if (actives.length && actives.every((x) => bad.has(`${g.index}:${x.index}`))) for (const x of g.gems) bad.add(`${g.index}:${x.index}`);
  }
  return { state, unmet, bad, fixable };
}

const ENCOUNTER_VARS = new Set(['multiplierNearbyEnemies', 'multiplierNearbyRareOrUniqueEnemies', 'multiplierWarcryPower']);

/** Where each set config row's subject (Onslaught, Withered, Shocked) comes from in this build, by the build's own text. */
export async function configSources(ctx: ToolContext, buildId: string, xml: string): Promise<{ sources: Record<string, ConfigSource>; unsupported: Array<{ name: string; line: string }>; tips: Map<string, string[]> }> {
  const [{ state: config }, { catalog }, skill, raw, gems] = await Promise.all([
    ctx.engine.send('configState', { buildId }),
    ctx.engine.send('configCatalog', {} as Record<string, never>),
    ctx.engine.send('mainSkill', { buildId }),
    rawOf(ctx, buildId),
    usableGems(ctx, buildId),
  ]);
  const live = new Set(gems.state.groups.filter((g) => !g.synthetic && g.enabled !== false && !g.slotInactive).map((g) => g.index));
  const { lines } = await buildLines(ctx, buildId, xml, live);
  const sources: Record<string, ConfigSource> = {};
  for (const [key, value] of Object.entries(config.values)) {
    const o = catalog.options.find((x) => x.var === key);
    if (!o || !['check', 'count', 'countAllowZero'].includes(o.type) || !value || value === config.defaults[key]) continue;
    if (/^(Custom Modifiers|Enemy Stats|Map Modifiers)/i.test(o.section)) continue;
    // set by the fight, not granted by the build (upstream ConfigOptions.lua:743 Warcry Power from nearby enemies, :1234 # of nearby Enemies)
    if (ENCOUNTER_VARS.has(key)) continue;
    const noun = optionNoun(o.label);
    if (!noun) continue;
    // the enemies supply it, not the build ("# of nearby Enemies"; Warcry Power "is based on the total strength of nearby enemies")
    if (/\benem(?:y|ies)\b/i.test(noun) || /\bbased on\b[^.]*\benem(?:y|ies)\b/i.test(o.tooltip ?? '')) continue;
    const re = nounPattern(noun);
    const usable: string[] = [], unusable: string[] = [], viaFix: string[] = [];
    let cap: number | null = null, uncapped = false;
    for (const l of lines) {
      const hit = l.lines.map((line) => readGrant(line, re)).filter(Boolean).at(-1);
      if (!hit) continue;
      const label = `${l.name}${l.kind === 'passive' ? ' (passive)' : ''}`;
      if (l.group !== undefined && gems.bad.has(`${l.group}:${l.gem}`)) { unusable.push(label); continue; }
      if (l.group !== undefined && gems.fixable.has(`${l.group}:${l.gem}`)) viaFix.push(label);
      usable.push(label);
      if (hit.cap === null) uncapped = true;
      else cap = Math.max(cap ?? 0, hit.cap);
    }
    // the main skill's own flags and chance count as a source ("inflictShock", ShockChance)
    // (a chance stat, when the engine has one, wins over the flag: every hit carries "can ignite", a 0% chance does not)
    const flag = noun.split(/\s+/).map((w) => w.toLowerCase().replace(/(?:ed|es|s)$/, '')).join('');
    const chance = nounStat(raw, noun, 'Chance');
    if (chance !== null ? chance > 0 : skill.flags.some((f) => f.toLowerCase().replace(/^inflict/, '').startsWith(flag))) { usable.push(skill.name); uncapped = true; }
    sources[key] = { value: value as Scalar, usable: [...new Set(usable)], unusable: [...new Set(unusable)], viaFix: [...new Set(viaFix)], cap: uncapped ? null : cap };
  }
  const unsupported = lines.flatMap((l) => l.lines.filter((x) => /\(Not supported yet\)/i.test(x)).map((x) => ({ name: l.name, line: cleanLine(x) })));
  const tips = new Map(lines.filter((l) => l.group !== undefined).map((l) => [`${l.group}:${l.gem}`, l.lines]));
  return { sources, unsupported, tips };
}

/** The edit that takes a config row back to what the build supplies: off, or down to the most its capped sources keep up. */
export function honestConfigEdit(key: string, s: ConfigSource): { edit: ToolEdit; to: Scalar } | null {
  if (s.usable.length && s.cap === null) return null;
  if (typeof s.value === 'number') {
    const to = s.usable.length ? Math.min(s.value, s.cap ?? s.value) : 0;
    return to === s.value ? null : { edit: { kind: 'setConfig', key, value: to }, to };
  }
  return s.usable.length ? null : { edit: { kind: 'setConfig', key, value: false }, to: false };
}

const cache = new Map<string, Promise<Audit>>();

/** The audit of `buildId` as it stands, cached by the build text (an unchanged build is audited once). */
/** The fix for a custom modifier that carries the resistances: the action, then how far each element is below its cap without it. */
export function resistFixText(after: Record<string, Scalar>): string {
  const short = ['Fire', 'Cold', 'Lightning'].flatMap((e) => {
    const cap = num(after[`${e}ResistMax`]) || 75;
    const miss = cap - num(after[`${e}Resist`]);
    return miss > 0 ? [`${e.toLowerCase()} resistance ${formatStat(`${e}Resist`, miss)}`] : [];
  });
  return `Turn the custom modifier off (Configuration tab, Custom Modifiers) and get the resistances from gear${short.length ? `: still to find ${short.join(', ')}` : ''}`;
}

/** The accuracy a keystone that compares it with maximum life asks for: the number to reach and how far the build is from it. */
export function accuracyTarget(accuracy: number, life: number, vsLife = true): string {
  if (!vsLife || !(life > 0)) return 'Raise your Accuracy Rating';
  const need = Math.floor(life) + 1;
  // the engine keeps accuracy per hand: an unread (0) value is left out rather than shown as "from 0"
  if (!(accuracy > 0)) return `Raise your Accuracy Rating to at least ${need.toLocaleString('en-US')}`;
  return `Raise your Accuracy Rating from ${Math.round(accuracy).toLocaleString('en-US')} to at least ${need.toLocaleString('en-US')} (${Math.max(0, need - Math.round(accuracy)).toLocaleString('en-US')} more)`;
}

/** Why a config setting adds nothing: the build's own source supplies it already. Hatchet Master's Onslaught is on kill only. */
export function alreadyGetsNote(usable: string[]): string {
  const kill = usable.some((u) => /Hatchet Master/i.test(u)) ? ", but Hatchet Master's Onslaught is on kill only, so it may drop against a single boss" : '';
  return `your build already gets it from ${usable.join(', ')} and the numbers count it, so the setting adds nothing on top${kill}`;
}

/** The word a config option's subject is searched by: "Is the enemy Intimidated?" gives "intimidat". */
export function sourceStem(label: string): string {
  const w = label.replace(/\?/g, '').split(/\s+/).filter((x) => x.length > 4 && !/^(enemy|build|always|enemies)$/i.test(x)).pop() ?? '';
  return w.toLowerCase().replace(/(ed|ing|e|s)$/i, '');
}

/** Real ways to get what a setting assumes, from the game data: gems and passives by that word. Empty when the data names none. */
export function sourceHintLine(gems: string[], passives: string[]): string {
  const parts = [...gems.slice(0, 1).map((g) => `the gem ${g}`), ...passives.slice(0, 1).map((n) => `the passive ${n}`)];
  return parts.length ? ` (sources in the game data: ${parts.join('; ')})` : '';
}

/** The in-game damage when the config assumes a source the build lacks, worded forwards: what the player keeps, and what the shown number needs. */
export function honestDamageLine(label: string, keep: string, shown: string): string {
  return `As the build stands in game you keep ${label} ${keep}; the ${shown} shown needs a source for the setting`;
}

/** The sentence that names a source: "To get it in game: Intimidating Cry (gem) or Cleaving (passive)." Empty when none. */
export function sourceSentence(gems: string[], passives: string[]): string {
  const parts = [...gems.slice(0, 1).map((g) => `${g} (gem)`), ...passives.slice(0, 1).map((n) => `${n} (passive)`)];
  return parts.length ? `To get it in game: ${parts.join(' or ')}.` : '';
}

/** Gems and passives whose name or text carries the setting's word, minus what the build already has. A passive that only works with one weapon type is left out: the build's weapon is not known here. */
export async function configSourceHint(ctx: ToolContext, buildId: string, optionLabel: string): Promise<{ suffix: string; sentence: string }> {
  const none = { suffix: '', sentence: '' };
  const stem = sourceStem(optionLabel);
  if (stem.length < 4) return none;
  try {
    const { gems } = await ctx.engine.send('gemCatalog', {} as Record<string, never>);
    const gemNames = gems.filter((g) => !g.legacy && !g.vaal && g.name.toLowerCase().includes(stem)).map((g) => g.name);
    const { tree } = await ctx.engine.send('treeState', { buildId });
    const have = new Set(tree.allocated);
    const nodes = await ctx.tree.search(tree.treeVersion, stem, 8).catch(() => []);
    const weapon = /\b(axes?|maces?|swords?|daggers?|claws?|staves|staff|wands?|bows?|sceptres?)\b/i;
    const passives = nodes.filter((n) => !have.has(n.id) && !n.ascendancy && (n.type === 'Notable' || n.type === 'Normal') && n.stats.some((l) => l.toLowerCase().includes(stem)) && !n.stats.some((l) => weapon.test(l))).map((n) => n.name);
    return { suffix: sourceHintLine(gemNames, passives), sentence: sourceSentence(gemNames, passives) };
  } catch {
    return none;
  }
}

export function auditBuild(ctx: ToolContext, buildId: string, xml: string): Promise<Audit> {
  const key = xmlHash(xml);
  const hit = cache.get(key);
  if (hit) return hit;
  const p = withScratch(ctx, xml, (scratch) => runAudit(ctx, scratch, xml));
  cache.set(key, p);
  p.catch(() => cache.delete(key));
  while (cache.size > 6) cache.delete(cache.keys().next().value!);
  return p;
}

async function runAudit(ctx: ToolContext, b: string, xml: string): Promise<Audit> {
  const started = Date.now();
  const raw = await rawOf(ctx, b);
  const stat = damageStat(raw);
  const sid = statId(stat);
  const full = stat === 'FullDPS';
  const base = damageOf(raw, stat);
  const ehp = num(raw.TotalEHP);
  const after = async (edit: ToolEdit): Promise<Raw | null> => {
    const r = await ctx.engine.send('previewEdit', { buildId: b, edit: toBuildEdit(edit), full });
    if (r.blocked) return null;
    const out: Raw = { ...raw };
    for (const c of r.statDiff.changed) out[c.statId] = c.after;
    return out;
  };
  const effect = (r: Raw) => [movedEnough(base, damageOf(r, stat), 0) ? moveText(sid, base, damageOf(r, stat)) : '', movedEnough(ehp, num(r.TotalEHP), 0.001) ? moveText('TotalEHP', ehp, num(r.TotalEHP)) : ''].filter(Boolean).join(', ');
  const measureAll = (edits: ToolEdit[]) => withScratch(ctx, xml, async (s) => { await applyEdits(ctx, s, edits, full); return rawOf(ctx, s); }).catch(() => null);
  const matters = (r: Raw | null) => !!r && (movedEnough(base, damageOf(r, stat)) || movedEnough(ehp, num(r.TotalEHP)));

  const [{ state: config }, { catalog }, warnings, skill, gems, src] = await Promise.all([
    ctx.engine.send('configState', { buildId: b }),
    ctx.engine.send('configCatalog', {} as Record<string, never>),
    buildWarnings(ctx, b),
    ctx.engine.send('mainSkill', { buildId: b }),
    usableGems(ctx, b),
    configSources(ctx, b, xml),
  ]);
  const findings: Finding[] = [];
  const honest: ToolEdit[] = [];
  const manaFixes: ToolEdit[] = [];
  const label = (key: string) => strip(catalog.options.find((o) => o.var === key)?.label ?? key);

  // ---- unmet requirements: the gem does nothing in game, the engine still counts it
  const reliedOn = new Set(Object.values(src.sources).flatMap((s) => [...s.unusable, ...s.viaFix]).map((n) => n.replace(/ \(passive\)$/, '')));
  if (gems.unmet.length) {
    const fixable = gems.unmet.filter((g) => g.fit > 0);
    const edits: ToolEdit[] = fixable.map((g) => ({ kind: 'setGem', group: g.group, gem: g.gem, attr: 'level', value: g.fit }));
    let fixed = '';
    if (edits.length) {
      const r = await measureAll(edits);
      if (r) fixed = effect(r);
      honest.push(...edits);
    }
    const main = gems.state.groups.find((g) => g.index === gems.state.mainGroup);
    const fullGroups = new Set(gems.state.groups.filter((g) => g.includeInFullDPS || g.index === main?.index).map((g) => g.index));
    // a lowered gem outside the damage number: the number cannot show its cost, the gem's own tooltip at both levels can
    const uncounted = fixable.filter((g) => !fullGroups.has(g.group));
    const { gems: catalog } = uncounted.length ? await ctx.engine.send('gemCatalog', {} as Record<string, never>) : { gems: [] };
    const tipAt = async (name: string, level: number) => {
      const info = catalog.find((x) => x.name === name);
      return info ? ctx.engine.send('gemTip', { buildId: b, skillId: skillIdOf(info), level }).then((r) => tipText(r.tip.lines), () => [] as string[]) : [];
    };
    const template = (l: string) => l.replace(/\d+(?:\.\d+)?/g, '#');
    const costs = (await Promise.all(uncounted.map(async (g) => {
      const [now, low] = await Promise.all([tipAt(g.name, g.level), tipAt(g.name, g.fit)]);
      const moved = now.flatMap((l, i) => (low[i] !== undefined && low[i] !== l && template(low[i]!) === template(l) ? [`"${l}" -> "${low[i]}"`] : [])).slice(0, 2);
      return moved.length ? `${g.name} ${moved.join(', ')}` : '';
    }))).filter(Boolean);
    const notCounted = uncounted.length
      ? `. ${statMeta(sid).label} does not count ${uncounted.map((g) => g.name).join(', ')}, so it cannot show what the lower level costs${costs.length ? `: ${costs.join('; ')}` : ''}`
      : '';
    findings.push({
      id: 'requirements',
      kind: 'requirement',
      names: [...new Set(gems.unmet.map((g) => g.name))],
      fatal: gems.unmet.some((g) => reliedOn.has(g.name) || fullGroups.has(g.group)),
      shown: gems.unmet.map((g) => `${g.name} needs ${g.attr.need} ${statMeta(g.attr.name).label} and you have ${g.attr.have}`).join('; ') + `: in game those gems do not work at their current level, but the numbers still count them${fixable.length ? `; at ${fixable.map((g) => `${g.name} level ${g.fit}`).join(', ')} ${fixable.length > 1 ? 'they fit and work' : 'it fits and works'} again` : ''}`,
      ...(edits.length ? {
        fix: `${fixable.map((g) => `${g.name} level ${g.level} to ${g.fit}`).join(', ')} makes them fit your attributes${fixed ? `: ${fixed}` : uncounted.length ? '' : ', with no change to damage or Effective HP'}${notCounted}${gems.unmet.some((g) => !g.fit) ? `; ${gems.unmet.filter((g) => !g.fit).map((g) => g.name).join(', ')} needs more ${gems.unmet.find((g) => !g.fit)!.attr.name} even at level 1` : ''}`,
        edits,
      } : { fix: `Raise ${gems.unmet[0]!.attr.name}: even level 1 of ${gems.unmet.map((g) => g.name).join(', ')} needs more than you have` }),
    });
  }

  // ---- negative unreserved mana or life: not every aura can be on
  for (const pool of ['Mana', 'Life'] as const) {
    const left = num(raw[`${pool}Unreserved`]);
    if (!(typeof raw[`${pool}Unreserved`] === 'number' && left < 0)) continue;
    const reserves = new RegExp(`^Reservation: .*${pool}`);
    const auras = gems.state.groups.flatMap((g) => g.enabled && !g.slotInactive ? g.gems.filter((x) => x.enabled && !x.support && (src.tips.get(`${g.index}:${x.index}`) ?? []).some((l) => reserves.test(l))).map((x) => ({ g, x })) : []);
    const ways: Array<{ name: string; edit: ToolEdit; edits?: ToolEdit[]; r: Raw; loss: number }> = [];
    const fits = (r: Raw | null): r is Raw => !!r && num(r[`${pool}Unreserved`]) >= 0;
    const lossOf = (r: Raw) => (base ? (base - damageOf(r, stat)) / base : 0) + (ehp ? (ehp - num(r.TotalEHP)) / ehp : 0);
    for (const { g, x } of auras) {
      const edit: ToolEdit = { kind: 'setGem', group: g.index, gem: x.index, attr: 'enabled', value: false };
      const r = await after(edit);
      if (fits(r)) ways.push({ name: `Turn off ${x.nameSpec}`, edit, r, loss: lossOf(r) });
      // a flat-cost aura reserves less at a lower level: the highest level that fits keeps most of it
      if (x.level > 1) {
        const at = (level: number) => after({ kind: 'setGem', group: g.index, gem: x.index, attr: 'level', value: level });
        if (fits(await at(1))) {
          let lo = 1, hi = x.level - 1;
          while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (fits(await at(mid))) lo = mid; else hi = mid - 1; }
          const r2 = (await at(lo))!;
          ways.push({ name: `Lower ${x.nameSpec} from level ${x.level} to ${lo}`, edit: { kind: 'setGem', group: g.index, gem: x.index, attr: 'level', value: lo }, r: r2, loss: lossOf(r2) });
        }
      }
    }
    // Enlighten (bought) in place of a support of an aura group keeps every aura on (the only fix was Determination off)
    for (const g of pool === 'Mana' ? [...new Set(auras.map((a) => a.g))] : []) {
      for (const sup of g.gems.filter((x) => x.support && x.enabled && !/Enlighten/i.test(x.nameSpec))) {
        const edits: ToolEdit[] = [{ kind: 'setGemSkill', group: g.index, gem: sup.index, gemId: ENLIGHTEN }, { kind: 'setGem', group: g.index, gem: sup.index, attr: 'level', value: 3 }];
        const r = await measureAll(edits);
        if (fits(r)) ways.push({ name: `Enlighten level 3 (bought) in place of ${sup.nameSpec}`, edit: edits[0]!, edits, r, loss: lossOf(r) });
      }
    }
    // no single skill frees enough: the set to turn off together
    if (!ways.length) {
      const set = await withScratch(ctx, xml, (s) => fitReservation(ctx, s, pool)).catch(() => null);
      if (set) ways.push({ name: `Turn off ${set.off.join(' and ')}`, edit: set.edits[0]!, edits: set.edits, r: set.raw, loss: lossOf(set.raw) });
    }
    sortReservationWays(ways);
    const best = ways[0];
    // a bought gem says its price at the level put in (Enlighten with no price)
    if (best?.name.startsWith('Enlighten')) {
      const lookup = TOOLS.find((t) => t.name === 'lookupPrice');
      type Priced = { prices?: Array<{ found?: boolean; gemLevel?: number; corrupted?: boolean; shown?: string }>; source?: { priced?: string } };
      const r = lookup && ctx.prices ? ((await lookup.run({ names: ['Enlighten Support'], gemLevel: 3 }, ctx).catch(() => null)) as Priced | null) : null;
      const line = r?.prices?.find((p) => p.found && p.gemLevel === 3 && !p.corrupted) ?? r?.prices?.find((p) => p.found && p.gemLevel === 3);
      best.name += line?.shown ? `, ${line.shown}${r?.source?.priced ? `, priced ${r.source.priced}` : ''}` : ', price unknown';
    }
    findings.push({
      id: `${pool.toLowerCase()}Unreserved`,
      kind: 'warning',
      fatal: true,
      shown: `Unreserved ${pool.toLowerCase()} is ${formatStat(`${pool}Unreserved`, left)}: in game not every reservation can be on at once, but the numbers count them all`,
      ...(best ? { fix: `${best.name}: unreserved ${pool.toLowerCase()} ${formatStat(`${pool}Unreserved`, left)} -> ${formatStat(`${pool}Unreserved`, num(best.r[`${pool}Unreserved`]))}${effect(best.r) ? `, ${effect(best.r)}` : ''}${ways.length > 1 ? `; next cheapest: ${ways[1]!.name}${effect(ways[1]!.r) ? ` (${effect(ways[1]!.r)})` : ''}` : ''}`, edits: best.edits ?? [best.edit] } : { fix: 'Turning off every reservation skill still does not fit: lower reservation or raise the pool' }),
    });
    if (best) { const es = best.edits ?? [best.edit]; honest.push(...es); manaFixes.push(...es); }
  }
  // "not enough Accuracy for <keystone>": quote the keystone's own condition and measure what meeting it gives
  async function accuracyFix(w: string): Promise<Pick<Finding, 'fix' | 'gainPct'>> {
    const name = /enough Accuracy for (.+?)\.?$/i.exec(w)?.[1];
    if (!name) return {};
    const { tree } = await ctx.engine.send('treeState', { buildId: b });
    const node = (await ctx.tree.search(tree.treeVersion, name, 5).catch(() => [])).find((n) => n.name.toLowerCase() === name.toLowerCase());
    const rule = node?.stats.find((l) => /accuracy/i.test(l));
    const r = await after({ kind: 'setCustomMods', blocks: [...config.customMods.map((x) => ({ title: x.title, enabled: x.enabled, text: x.text })), { title: 'accuracy check', enabled: true, text: `+${Math.ceil(num(raw.Life) || 1000)} to Accuracy Rating` }] });
    const gain = r ? effect(r) : '';
    const hand = (await ctx.engine.send('getStats', { buildId: b })).stats.find((x: { id: string }) => x.id === 'MainHand')?.value as { Accuracy?: number } | null | undefined;
    return { fix: `${accuracyTarget(num(hand?.Accuracy ?? raw.Accuracy), num(raw.Life), !rule || /life/i.test(rule))}. ${name}${rule ? `: ${rule}` : ''}. Get it from accuracy on gear, Dexterity or accuracy passives${gain ? `. With enough accuracy ${gain}` : ''}`, ...(r && base > 0 ? { gainPct: Math.round(((damageOf(r, stat) - base) / base) * 1000) / 10 } : {}) };
  }
  for (const w of warnings) {
    if (/requirement|unreserved|enough (?:Unreserved )?(?:Mana|Life)|exceeds in game limit/i.test(w)) continue;
    findings.push({ id: `warning${findings.length}`, kind: 'warning', fatal: !/data is not installed/i.test(w), shown: w, ...(await accuracyFix(w)) });
  }

  // ---- config rows whose subject nothing usable in the build supplies
  for (const [key, s] of Object.entries(src.sources)) {
    const h = honestConfigEdit(key, s);
    if (!h) continue;
    const r = await after(h.edit);
    if (!matters(r)) continue;
    const hint = s.unusable.length || s.usable.length ? { suffix: '', sentence: '' } : await configSourceHint(ctx, b, label(key));
    const why = s.unusable.length
      ? `its source ${s.unusable.join(', ')} can't be used now (see the requirement above)${s.usable.length ? ` and ${s.usable.join(', ')} keeps up at most ${h.to}` : ''}`
      : `nothing in your gems, items or passives grants it${s.usable.length ? ` beyond ${h.to} (${s.usable.join(', ')})` : ''}${hint.suffix}`;
    findings.push({
      id: `config:${key}`,
      kind: 'config',
      fatal: true,
      shown: `Config "${label(key)}" is ${typeof s.value === 'boolean' ? 'on' : s.value}, but ${why}: at ${typeof h.to === 'boolean' ? 'off' : h.to}, ${effect(r!)}`,
      fix: `Set "${label(key)}" to ${typeof h.to === 'boolean' ? 'off' : h.to}, or add a source in game`,
      ...(hint.sentence ? { sourceLine: hint.sentence } : {}),
      edits: [h.edit],
    });
    honest.push(h.edit);
  }

  // ---- custom modifier lines: typed into config, not from gear
  for (const [i, m] of config.customMods.entries()) {
    const real = m.text.split('\n').filter((_, j) => m.lineOk[j]).map((l) => l.trim()).filter(Boolean);
    if (!m.enabled || !real.length) continue;
    const edit: ToolEdit = { kind: 'setCustomMods', blocks: config.customMods.map((x, j) => ({ title: x.title, enabled: j === i ? false : x.enabled, text: x.text })) };
    const r = await after(edit);
    if (!matters(r)) continue;
    const resists = ['Fire', 'Cold', 'Lightning', 'Chaos'].map((e) => `${e}Resist`).filter((id) => num(r![id]) !== num(raw[id])).map((id) => `${statMeta(id).label.toLowerCase()} ${formatStat(id, num(raw[id]))} -> ${formatStat(id, num(r![id]))}`);
    findings.push({
      id: `custom:${i + 1}`,
      kind: 'custom',
      fatal: true,
      // every number in the answer counts the typed-in mod: said once here so none reads as gear (Effective HP 45k on +200% resists)
      shown: `Config custom modifier ${real.map((l) => `"${l}"`).join(', ')} is typed into the config, not on your gear, and every number above counts it: without it ${[...resists, effect(r!)].filter(Boolean).join(', ')}`,
      fix: resistFixText(r as Record<string, Scalar>),
      // no edits: turning the line off only shows the in-game number, the fix is gear (a bare "Apply change" card read as wrecking the resistances)
    });
    honest.push(edit);
  }

  // ---- Full DPS counting a skill more than once
  for (const g of gems.state.groups) {
    if (!g.enabled || !g.includeInFullDPS) continue;
    for (const x of g.gems) {
      if (x.support || !x.enabled || !(x.count > 1)) continue;
      const edit: ToolEdit = { kind: 'setGem', group: g.index, gem: x.index, attr: 'count', value: 1 };
      const r = await after(edit);
      // a count up to the projectiles the skill fires can be a fair guess (shotgunning); above it, nothing in the build backs it
      const proj = g.index === gems.state.mainGroup ? num(raw.ProjectileCount) : 0;
      findings.push({
        id: `count:${x.nameSpec}`,
        kind: 'count',
        fatal: x.count > Math.max(1, proj),
        shown: `Full DPS counts ${x.nameSpec} ${x.count} times (its count in Full DPS is ${x.count}), an assumption that ${x.count} ${proj > 1 ? `of its ${proj} projectiles` : 'copies'} hit the target at once${r ? `: one copy is ${formatStat('FullDPS', num(r.FullDPS))}` : ''}`,
        fix: `Set the count to 1 to see one copy, or keep it if ${x.count} copies really hit together`,
        edits: [edit],
      });
    }
  }

  // ---- the skill behind the damage number
  const mainGroup = gems.state.groups.find((g) => g.index === gems.state.mainGroup);
  const fullNames = gems.state.groups.filter((g) => g.enabled && g.includeInFullDPS).map((g) => g.displayLabel);
  let damage = { stat: sid, skill: full ? fullNames.join(', ') : skill.name, shown: full ? `Full DPS adds up ${fullNames.join(', ')}` : `The damage numbers are ${skill.name} alone (the selected skill); no skill is in Full DPS` };
  if (!full && stat !== 'Minion') {
    const others: Array<{ g: (typeof gems.state.groups)[number]; dps: number }> = [];
    for (const g of gems.state.groups) {
      if (g.synthetic || !g.enabled || g.slotInactive || g.index === gems.state.mainGroup || g.displayLabel.startsWith('<')) continue;
      const r = await after({ kind: 'setMainGroup', group: g.index });
      const dps = r ? Math.max(num(r.CombinedDPS), num((r.Minion as Raw | undefined)?.CombinedDPS)) : 0;
      if (dps > 0.25 * base) others.push({ g, dps });
    }
    others.sort((a, c) => c.dps - a.dps);
    if (others.length) {
      const top = others[0]!;
      const edits: ToolEdit[] = [mainGroup, ...others.map((o) => o.g)].filter(Boolean).map((g) => ({ kind: 'setGroup', group: g!.index, attr: 'includeInFullDPS', value: true }));
      const r = await withScratch(ctx, xml, async (s) => { await applyEdits(ctx, s, edits, true); return rawOf(ctx, s); }).catch(() => null);
      const together = r && num(r.FullDPS) > 0 ? num(r.FullDPS) : 0;
      findings.push({
        id: 'damageSkill',
        kind: 'damageSkill',
        fatal: top.dps > base,
        shown: `The damage numbers are ${skill.name} alone (the selected skill, ${formatStat('CombinedDPS', base)}); ${others.slice(0, 3).map((o) => `${o.g.displayLabel} deals ${formatStat('CombinedDPS', o.dps)} on its own`).join(', ')}, and no skill is in Full DPS`,
        ...(together ? { fix: `Put ${[skill.name, ...others.map((o) => o.g.displayLabel)].join(' and ')} in Full DPS to count them together: ${formatStat('FullDPS', together)}`, edits, together: { value: together, skills: [skill.name, ...others.map((o) => o.g.displayLabel)] } } : {}),
        perSkill: [{ name: skill.name, dps: base }, ...others.map((o) => ({ name: o.g.displayLabel, dps: o.dps }))],
      });
      damage = { stat: sid, skill: skill.name, shown: findings.at(-1)!.shown };
    }
  }

  // ---- defence a cooldown or triggered buff gives, counted as always up
  const hitIds = Object.keys(raw).filter((k) => /MaximumHitTaken$/.test(k) && num(raw[k]) > 0);
  for (const g of gems.state.groups) {
    if (!g.enabled || g.slotInactive || g.index === gems.state.mainGroup) continue;
    const tags = (x: { index: number }) => src.tips.get(`${g.index}:${x.index}`)?.[0] ?? '';
    const triggered = g.gems.some((x) => x.support && /\bTrigger\b/.test(tags(x)));
    // one gem at a time: an aura in the same group is up all the time and stays on
    for (const x of g.gems) {
      const t = tags(x);
      if (x.support || !x.enabled || /\bAura\b/.test(t) || !(triggered || /\b(?:Guard|Vaal|Duration|Trigger)\b/.test(t))) continue;
      const r = await after({ kind: 'setGem', group: g.index, gem: x.index, attr: 'enabled', value: false });
      if (!r) continue;
      const lost = hitIds.filter((k) => num(r[k]) < num(raw[k]) * 0.95);
      if (!movedEnough(ehp, num(r.TotalEHP), 0.05) && !lost.length) continue;
      findings.push({
        id: `buff:${x.nameSpec}`,
        kind: 'conditionalDefence',
        fatal: false,
        without: { name: x.nameSpec, ehp: num(r.TotalEHP) },
        shown: `Effective HP and max hits count ${x.nameSpec} as always up, but it is ${/\bVaal\b/.test(t) ? 'a Vaal skill' : triggered ? 'triggered' : 'a timed buff'}: without it ${[movedEnough(ehp, num(r.TotalEHP), 0.001) ? moveText('TotalEHP', ehp, num(r.TotalEHP)) : '', ...lost.slice(0, 3).map((k) => moveText(k, num(raw[k]), num(r[k])))].filter(Boolean).join(', ')}`,
      });
    }
  }

  // ---- an empty gear slot while the build owns an item that fits it (no gloves, Soul Talons in the item list)
  const items = readItems(xml);
  const gear = emptyGear(items, items.sets.find((x) => x.id === items.activeSet) ?? items.sets[0]);
  if (gear.emptySlots && gear.notEquipped) {
    const owned = items.items.filter((i) => gear.notEquipped!.some((n) => n.id === i.id));
    // itemInfo one by one: the app's AI gate refuses itemsInfo (otherwise the whole audit threw in the app)
    const info = await Promise.all(owned.map(async (i) => (await ctx.engine.send('itemInfo', { itemText: i.text }).catch(() => null))?.item ?? null));
    const side = ['Life', 'Mana', 'ManaUnreserved', 'EnergyShield', 'FireResist', 'ColdResist', 'LightningResist', 'ChaosResist'];
    for (const slot of gear.emptySlots) {
      const kind = slot.replace(/ \d$/, '');
      const fits = owned.map((i, j) => ({ i, f: info[j] })).filter(({ f }) => f?.valid && (kind === 'Weapon' ? f.isWeapon : f.type === kind));
      const groups = gems.state.groups.filter((g) => g.slot === slot && g.enabled && !g.source && !g.synthetic).map((g) => g.displayLabel);
      // a group label lists its gems ("Storm Rain, Flame Dash"): named one by one so the sentence reads right
      const gemNames = groups.flatMap((l) => l.split(', '));
      if (!fits.length) continue;
      const tries: Array<{ name: string; edit: ToolEdit; r: Raw; gain: number }> = [];
      for (const { i, f } of fits) {
        const edit: ToolEdit = { kind: 'setSlotItem', slot, itemId: i.id };
        const r = await after(edit);
        if (r) tries.push({ name: f!.title || f!.name, edit, r, gain: (base ? (damageOf(r, stat) - base) / base : 0) + (ehp ? (num(r.TotalEHP) - ehp) / ehp : 0) });
      }
      tries.sort((a, c) => c.gain - a.gain);
      const best = tries[0];
      if (!best) continue;
      const moved = [effect(best.r), ...side.filter((id) => typeof raw[id] === 'number' && movedEnough(num(raw[id]), num(best.r[id]), 0.01)).map((id) => moveText(id, num(raw[id]), num(best.r[id])))].filter(Boolean).join(', ');
      // a pool the build pays its skills with that drops is said in the finding itself (Soul Talons' 30% reduced mana on a mana-cost build)
      const losses = (['Mana', 'Life'] as const).filter((id) => num(best.r[id]) < num(raw[id]) && num(raw[`${id}Cost`]) > 0).map((id) => `it lowers ${moveText(id, num(raw[id]), num(best.r[id]))} and your main skill costs ${formatStat(`${id}Cost`, num(raw[`${id}Cost`]))} ${id.toLowerCase()} per use`);
      findings.push({
        id: `emptySlot:${slot}`,
        kind: 'hole',
        // gems in a slot with no item can't be socketed in game, yet the numbers count them
        fatal: groups.length > 0,
        shown: `${slot} is empty${gemNames.length ? ` and ${gemNames.length > 1 ? `${gemNames.slice(0, -1).join(', ')} and ${gemNames.at(-1)} sit` : `${gemNames[0]} sits`} in it, so those gems can't be socketed in game` : ''}; you own ${fits.map(({ f }) => f!.title || f!.name).join(', ')}, which fits${losses.length ? `; ${losses.join('; ')}` : ''}`,
        // the app writes this line into the answer as is: no words to the model in it (the player once saw "Say every loss here")
        fix: `Equip ${best.name} in ${slot}${moved ? `: ${moved}` : ''}`,
        edits: [best.edit],
      });
    }
  }

  // ---- freeze and bleed immunity flasks, and the major pantheon: cheap fixes with ready edits
  for (const f of await immunityFlasks(ctx, b, xml).catch(() => [])) {
    findings.push({ id: `flaskImmunity:${f.need}`, kind: 'hole', fatal: false, shown: `No flask gives ${f.need} immunity`, fix: `${f.line}: immune to ${f.need} while that flask is up${f.gap ? `. ${f.gap}` : ""}`, edits: [f.edit] });
  }
  // one bench craft for the resistances under their caps, chaos included: ready for a "what kills me" answer's first change
  const craft = await withScratch(ctx, xml, (s) => resistCraft(ctx, s, xml, raw as Record<string, Scalar>, true)).catch(() => null);
  if (craft) findings.push({ id: 'resistCraft', kind: 'hole', fatal: false, shown: `Resistances under their caps: ${['Fire', 'Cold', 'Lightning', 'Chaos'].filter((e) => num(raw[`${e}Resist`]) < (num(raw[`${e}ResistMax`]) || 75)).map((e) => `${e.toLowerCase()} ${num(raw[`${e}Resist`])}%`).join(', ')}`, fix: craft.line, edits: [craft.edit] });
  const major = String(config.values.pantheonMajorGod ?? config.defaults.pantheonMajorGod ?? 'None');
  const gods = catalog.options.find((o) => o.var === 'pantheonMajorGod')?.list?.filter((l) => l.val !== 'None') ?? [];
  // a major god whose souls avoid the ailment a flask is missing: free, so it comes before the flask suffix (Penguin cost
  // 15.5% armour while the pantheon was never offered). Which god does it is read from the engine's game data, no god named here.
  const AILMENT_STAT: Record<string, string> = { freeze: 'Freeze', bleeding: 'Bleed' };
  for (const need of findings.flatMap((f) => (f.id.startsWith('flaskImmunity:') ? [f.id.slice('flaskImmunity:'.length)] : []))) {
    const stat = AILMENT_STAT[need];
    if (!stat) continue;
    for (const g of gods) {
      if (g.val === major) continue;
      const edit: ToolEdit = { kind: 'setConfig', key: 'pantheonMajorGod', value: g.val as string };
      const r = await after(edit).catch(() => null);
      if (!r || num(r[`${stat}AvoidChance`]) < 100) continue;
      const godLabel = strip(g.label);
      const was = gods.find((x) => x.val === major);
      const moved = effect(r);
      // what the flask covers and the god does not (the flask's "Freeze and Chill"): said with the fix, so nobody reads it as full cover
      const open = need === 'freeze' && num(r.ChillAvoidChance) < 100 ? 'chill is not covered: only the flask stops chill too' : '';
      const fix = `Set ${godLabel} as your major pantheon god: immune to ${need}, no currency${was ? `, in place of ${strip(was.label)}` : ''}${moved ? ` (${moved})` : ''}${open ? `. Still open: ${open}` : ''}`;
      findings.splice(findings.findIndex((f) => f.id === `flaskImmunity:${need}`), 0, { id: `${was ? 'pantheonSwap' : 'pantheonImmunity'}:${need}`, kind: 'hole', fatal: false, shown: `Nothing makes you immune to ${need}`, fix, edits: [edit] });
      break;
    }
  }
  if (major === 'None' && gods.length) {
    // the god the engine rates for the most effective HP; The Brine King's freeze and stun protection is not in the numbers
    const tries: Array<{ label: string; edit: ToolEdit; r: Raw }> = [];
    for (const g of gods) {
      const edit: ToolEdit = { kind: 'setConfig', key: 'pantheonMajorGod', value: g.val as string };
      const r = await after(edit).catch(() => null);
      if (r) tries.push({ label: strip(g.label), edit, r });
    }
    tries.sort((x, y) => num(y.r.TotalEHP) - num(x.r.TotalEHP));
    const best = tries[0];
    if (best) findings.push({ id: 'pantheon', kind: 'hole', fatal: false, shown: 'No major pantheon god is set', fix: `Set ${best.label}${effect(best.r) ? `: ${effect(best.r)}` : ''}; The Brine King instead when freeze or stun is what kills you (its protection is not in the numbers)`, edits: [best.edit] });
  }

  // ---- unspent points: free power before any buy
  const pts = await pointBudget(ctx, b).catch(() => null);
  if (pts) {
    const level = Math.min(100, pts.level || 100);
    const passive = pts.passive.left;
    const asc = level >= 75 ? pts.ascendancy.left : 0;
    if (passive > 0 || asc > 0) findings.push({
      id: 'unspentPoints',
      kind: 'hole',
      fatal: false,
      shown: `${[passive > 0 ? `${passive} passive point${passive > 1 ? 's' : ''}` : '', asc > 0 ? `${asc} ascendancy point${asc > 1 ? 's' : ''}` : ''].filter(Boolean).join(' and ')} unspent at level ${level}`,
      fix: 'Spend them on the best nodes before any buy',
    });
  }

  // ---- the damage in play: a number that leans on standing still is said moving first (577k standing, -40% moving)
  let moving: Audit['moving'];
  if (config.values.conditionStationary !== undefined && base > 0) {
    const r = await after({ kind: 'setConfig', key: 'conditionStationary', value: (config.defaults.conditionStationary ?? 0) as Scalar }).catch(() => null);
    const m = r ? damageOf(r, stat) : base;
    if (m < base * 0.95) moving = { shown: `${formatStat(sid, m)} while moving${pctText(base, m)}, ${formatStat(sid, base)} standing still (${damage.skill})` };
  }

  // ---- the enemy the numbers are measured against
  const bossOpt = catalog.options.find((o) => o.var === 'enemyIsBoss');
  const bossVal = config.values.enemyIsBoss ?? config.defaults.enemyIsBoss;
  const bossLabel = bossOpt?.list?.find((l) => l.val === bossVal)?.label ?? String(bossVal ?? '');
  const tip = bossOpt?.tooltip ? strip(bossOpt.tooltip).split(/\n\s*\n/).find((p) => p.toLowerCase().startsWith(bossLabel.toLowerCase().replace(/\//g, ' / ').split(' ')[0]!) && /adds the following/i.test(p)) : undefined;
  const enemy = { shown: `Enemy: ${bossLabel}${'enemyIsBoss' in config.values ? '' : ' (the default, not set in this build)'}`, ...(tip && /Damage taken/i.test(tip) ? { note: `${tip.split('\n').map((l) => strip(l)).filter((l) => /Damage taken/i.test(l)).join('; ')}: the engine's stand-in for this boss's larger life pool, so compare its damage only with other numbers against the same boss` } : {}) };

  // ---- everything that inflates the numbers taken out at once
  let honestOut: Audit['honest'];
  if (honest.length) {
    const r = await measureAll(honest);
    if (r) honestOut = {
      edits: honest,
      shown: damageOf(r, stat) < base ? `${honestDamageLine(statMeta(sid).label, formatStat(sid, damageOf(r, stat)), formatStat(sid, base))}${movedEnough(ehp, num(r.TotalEHP), 0.001) ? `; ${moveText('TotalEHP', ehp, num(r.TotalEHP))}` : ''}` : `As the build stands in game: ${effect(r) || 'no change to damage or Effective HP'}`,
      damage: { before: formatStat(sid, base), after: formatStat(sid, damageOf(r, stat)) },
      ehp: { before: formatStat('TotalEHP', ehp), after: formatStat('TotalEHP', num(r.TotalEHP)) },
    };
  }
  // everything but the mana fix (that one is a choice of which aura to give up) and a typed-in mod (its fix is gear): one change the player can take whole
  const sure = honest.filter((e) => !manaFixes.includes(e) && e.kind !== 'setCustomMods');
  const fixAll = await measureFixAll(ctx, b, xml, sure, findings.filter((f) => f.fix && f.edits?.some((e) => sure.includes(e))).map((f) => f.fix!));
  findings.sort((a, c) => Number(c.fatal) - Number(a.fatal));
  return { findings, damage, enemy, ...(moving ? { moving } : {}), ...(honestOut ? { honest: honestOut } : {}), ...(fixAll ? { fixAll } : {}), configSources: src.sources, unsupported: src.unsupported, tookMs: Date.now() - started };
}

/** The audit as a tool result part: what the answer must lead with. */
export function auditForAnswer(a: Audit) {
  return {
    // `line` is the finding as the player reads it: what is wrong, its numbers and the fix, one sentence to quote whole
    findings: a.findings.map((f) => ({ ...f, line: `${f.shown}${f.fix ? `. ${f.fix}` : ''}` })),
    damage: a.damage,
    enemy: a.enemy,
    ...(a.honest ? { honest: { shown: a.honest.shown, damage: a.honest.damage, ehp: a.honest.ehp } } : {}),
    ...(a.fixAll ? { fixAll: a.fixAll } : {}),
    ...(a.moving ? { moving: a.moving } : {}),
  };
}

/**
 * The damage while moving of a skill the question names that is not the main one (a question about Righteous Fire while the audit
 * measures Fire Trap): that skill made main on a scratch copy, then standing still set back to its default. Null when the
 * question names no other skill of the build or its number does not lean on standing still.
 */
export async function movingFor(ctx: ToolContext, xml: string, question: string): Promise<{ skill: string; shown: string } | null> {
  const q = question.toLowerCase();
  const g = readSkills(xml).find((x) => x.enabled && !x.isMain && x.gems.some((m) => m.name.length > 3 && q.includes(m.name.toLowerCase())));
  if (!g) return null;
  const skill = g.gems.find((m) => m.name.length > 3 && q.includes(m.name.toLowerCase()))!.name;
  return withScratch(ctx, xml, async (s) => {
    await ctx.engine.send('edit', { buildId: s, edit: toBuildEdit({ kind: 'setMainGroup', group: g.index }) });
    const { state: config } = await ctx.engine.send('configState', { buildId: s });
    if (config.values.conditionStationary === undefined) return null;
    const raw = await rawOf(ctx, s);
    const stat = damageStat(raw);
    const base = damageOf(raw, stat);
    if (!base) return null;
    await ctx.engine.send('edit', { buildId: s, edit: toBuildEdit({ kind: 'setConfig', key: 'conditionStationary', value: (config.defaults.conditionStationary ?? 0) as Scalar }) });
    const m = damageOf(await rawOf(ctx, s), stat);
    const sid = statId(stat);
    return m < base * 0.95 ? { skill, shown: `${formatStat(sid, m)} while moving${pctText(base, m)}, ${formatStat(sid, base)} standing still (${skill})` } : null;
  });
}

/** For a ranking or compare result: the fatal findings that void its numbers in game (the audit is cached per build text). */
export async function fatalForRanking(ctx: ToolContext, buildId: string, xml: string, counted?: (f: Finding) => boolean) {
  const a = await auditBuild(ctx, buildId, xml).catch(() => null);
  // `counted`: findings whose fix the ranking already applies on its copy (RF beside a selected Fire Trap); they lead too
  const isCounted = (f: Finding) => !!counted?.(f);
  const fatal = (a?.findings.filter((f) => f.fatal || isCounted(f)) ?? []).sort((x, y) => Number(isCounted(y)) - Number(isCounted(x)));
  if (!fatal.length) return {};
  const done = fatal.filter(isCounted).map((f) => f.id);
  return {
    fatalFirst: fatal.map((f) => ({ id: f.id, shown: f.shown, ...(f.fix ? { fix: f.fix } : {}), ...(f.edits ? { edits: f.edits } : {}), ...(f.gainPct !== undefined ? { gainPct: f.gainPct } : {}) })),
    fatalNote: `fatalFirst: problems that keep these ranked numbers from holding in game. Lead the answer with each one and its fix, and say the ranked numbers are as the build stands before that fix. Offer each fix (its edits) as its own proposeEdit with offer: true.${done.length ? ` Except ${done.join(', ')}: the ranked numbers already count its fix (on a copy), so say that instead.` : ''}`,
  };
}

const configKeys = (edits: ToolEdit[]) => edits.flatMap((e) => (e.kind === 'setConfig' ? [e.key] : e.kind === 'setConfigs' ? Object.keys(e.values) : []));

/**
 * Around a change (trial): what the change does to the audit. A config row whose only source the change removed is put back
 * to what the build supplies, and a Full DPS count is scaled with the projectiles it stood for (both in the same change,
 * counted in its numbers); a config the player asked for that moves no number is diagnosed instead of reported as done.
 * `scratch` holds the build after the change; `before` is the audit of the build before it.
 */
export async function auditChange(ctx: ToolContext, scratch: string, asked: ToolEdit[], before: Audit, beforeStats: Record<string, Scalar>, beforeConfig: { values: Record<string, Scalar>; defaults: Record<string, Scalar> }, fullDps: boolean) {
  const { catalog } = await ctx.engine.send('configCatalog', {} as Record<string, never>);
  const opt = (key: string) => catalog.options.find((o) => o.var === key);
  const label = (key: string) => strip(opt(key)?.label ?? key);
  const shownValue = (key: string, v: Scalar | undefined) => (v === undefined || v === null ? 'unset' : typeof v === 'boolean' ? (v ? 'on' : 'off') : opt(key)?.list?.find((l) => l.val === v)?.label ?? String(v));
  const askedKeys = new Set(configKeys(asked));
  const edits: ToolEdit[] = [];
  const lines: string[] = [];
  const notes: Array<{ stat: string; shown: string }> = [];
  const xmlNow = async () => (await ctx.engine.send('getBuildXml', { buildId: scratch })).buildXml;
  let audit = await auditBuild(ctx, scratch, await xmlNow());

  // a config row whose source this change took away
  for (const [key, s] of Object.entries(audit.configSources)) {
    const was = before.configSources[key];
    const h = honestConfigEdit(key, s);
    if (!h || !was || askedKeys.has(key) || honestConfigEdit(key, was)) continue;
    edits.push(h.edit);
    const gone = was.usable.filter((n) => !s.usable.includes(n));
    lines.push(`"${label(key)}" set to ${shownValue(key, h.to)}: ${gone.length ? `what gave it (${gone.join(', ')}) no longer does after this change` : 'nothing in the build grants it after this change'}`);
  }
  // a count in Full DPS that stood for the projectiles the skill fired
  const projBefore = num(beforeStats.ProjectileCount);
  const projAfter = num((await rawOf(ctx, scratch)).ProjectileCount);
  if (projBefore > 0 && projAfter > 0 && projBefore !== projAfter) {
    const { state } = await ctx.engine.send('skillsState', { buildId: scratch });
    const main = state.groups.find((g) => g.index === state.mainGroup);
    for (const x of main?.includeInFullDPS ? main.gems : []) {
      if (x.support || !x.enabled || !(x.count > 1)) continue;
      const to = scaledCount(x.count, projBefore, projAfter);
      if (to === x.count) continue;
      edits.push({ kind: 'setGem', group: main!.index, gem: x.index, attr: 'count', value: to });
      lines.push(`${x.nameSpec}'s count in Full DPS ${x.count} -> ${to}: it was set for ${projBefore} projectiles and the skill now fires ${projAfter}`);
    }
  }
  if (edits.length) {
    await applyEdits(ctx, scratch, edits, fullDps);
    audit = await auditBuild(ctx, scratch, await xmlNow());
  }

  // what each config the player asked for does, against its real previous value
  const { state: cfgAfter } = await ctx.engine.send('configState', { buildId: scratch });
  for (const key of askedKeys) {
    const o = opt(key);
    if (!o) continue;
    const was = beforeConfig.values[key];
    const now = cfgAfter.values[key];
    if (was === now || (was === undefined && now === beforeConfig.defaults[key])) {
      notes.push({ stat: `Config:${key}`, shown: `"${label(key)}" was already ${shownValue(key, now ?? beforeConfig.defaults[key])}: nothing changed` });
      continue;
    }
    if (o.type === 'list') {
      const from = was === undefined ? beforeConfig.defaults[key] : was;
      notes.push({ stat: `Config:${key}`, shown: `"${label(key)}" ${shownValue(key, from)}${was === undefined ? ' (the default)' : ''} -> ${shownValue(key, now)}${key === 'enemyIsBoss' && audit.enemy.note ? `. ${audit.enemy.note}` : ''}` });
    }
    const r = await ctx.engine.send('previewEdit', { buildId: scratch, edit: toBuildEdit({ kind: 'setConfig', key, value: was === undefined ? null : was }), full: fullDps });
    const ids = ['FullDPS', 'CombinedDPS', 'TotalEHP', 'Speed'];
    if (r.blocked || r.statDiff.changed.some((c) => ids.includes(c.statId) && c.before !== c.after)) continue;
    const empty = catalog.options.filter((c) => c.var && [c.conditions.ifOption].flat().includes(key) && ['count', 'countAllowZero', 'float', 'integer'].includes(c.type) && !cfgAfter.values[c.var]);
    // an empty magnitude ("Effect of Shock") is filled with what the build's own hits apply (the engine's CurrentShock), in the same change
    const ailment = empty.length ? /Effect of (\w+)/.exec(strip(empty[0]!.label))?.[1] : undefined;
    const own = ailment ? Math.round(num((await rawOf(ctx, scratch))[`Current${ailment}`])) : 0;
    const fill: ToolEdit | null = own > 0 ? { kind: 'setConfig', key: empty[0]!.var!, value: own } : null;
    // the build's own ailment is already in the numbers: filling the same magnitude moves nothing (RF already shocks for 17%)
    const fillMoves = fill && (await ctx.engine.send('previewEdit', { buildId: scratch, edit: toBuildEdit(fill), full: fullDps })).statDiff.changed.some((c) => ids.includes(c.statId) && c.before !== c.after);
    if (fill && !fillMoves) {
      notes.push({ stat: `NoEffect:${key}`, shown: `"${label(key)}" ${shownValue(key, now)} changed no damage or defence number: the numbers already count the ${own}% ${ailment!.toLowerCase()} your own hits apply` });
      continue;
    }
    if (fill) {
      await applyEdits(ctx, scratch, [fill], fullDps);
      edits.push(fill);
      lines.push(`"${strip(empty[0]!.label)}" set to ${own}%: the ${ailment!.toLowerCase()} your own hits apply, so "${label(key)}" counts`);
      continue;
    }
    const src = audit.configSources[key];
    const tip = o.tooltip ? strip(o.tooltip).replace(/\s*\n\s*/g, ' ') : '';
    const why = empty.length ? `"${strip(empty[0]!.label)}" is empty, so it adds nothing; it needs the effect your source gives`
      : src?.usable.length ? alreadyGetsNote(src.usable)
      : `${src ? 'nothing in your gems, items or passives grants it, and' : ''} the engine shows no difference with it on${tip ? ` though its tooltip says "${tip.slice(0, 160)}", so the numbers leave that out` : ''}`.trim();
    notes.push({ stat: `NoEffect:${key}`, shown: `"${label(key)}" ${shownValue(key, now)} changed no damage or defence number: ${why}` });
  }
  // the selected skill is not the build's only damage: the change with every damage skill counted too (Fire Trap alone on a Righteous Fire build)
  // Each skill's own Combined DPS, the number the Skills tab shows when it is selected (a Full DPS total of both skills is
  // a number the sidebar never shows, it reads 0); the biggest skill first, so a Righteous Fire build leads with Righteous Fire.
  const was = before.findings.find((f) => f.kind === 'damageSkill')?.perSkill;
  const now = audit.findings.find((f) => f.kind === 'damageSkill')?.perSkill;
  if (was && now) {
    const rows = was.map((w) => ({ name: w.name, from: w.dps, to: now.find((n) => n.name === w.name)?.dps })).filter((r): r is { name: string; from: number; to: number } => typeof r.to === 'number').sort((x, y) => y.from - x.from);
    if (rows.length > 1) notes.push({ stat: 'AllDamage', shown: `Damage by skill (Combined DPS, as the Skills tab shows each one when it is selected): ${rows.map((r) => `${r.name} ${formatStat('CombinedDPS', r.from)} -> ${formatStat('CombinedDPS', r.to)}${pctText(r.from, r.to)}`).join('; ')}` });
  }
  // a resistance left under its cap after the change (cold left at 63% with no word)
  const rawAfter = await rawOf(ctx, scratch);
  const under = ['Fire', 'Cold', 'Lightning'].filter((e) => num(rawAfter[`Missing${e}Resist`]) > 0)
    .map((e) => `${e} resistance ${formatStat(`${e}Resist`, num(rawAfter[`${e}Resist`]))} is ${num(rawAfter[`Missing${e}Resist`])}% under its ${num(rawAfter[`${e}Resist`]) + num(rawAfter[`Missing${e}Resist`])}% cap`);
  if (under.length) notes.push({ stat: 'UnderCap', shown: `${under.join('; ')}: elemental hits of that type hurt more until it is capped` });
  // what the change took away that no number counts
  const has = new Set(audit.unsupported.map((u) => `${u.name}|${u.line}`));
  for (const u of before.unsupported.filter((x, i, all) => !has.has(`${x.name}|${x.line}`) && all.findIndex((y) => y.line === x.line) === i).slice(0, 3)) {
    notes.push({ stat: `Uncounted:${u.name}`, shown: `Lost with this change and not counted in any number: ${u.name}, "${u.line}"` });
  }
  // a build that burns its own life (Righteous Fire): life regen after the change against that burn (the Amethyst flask's regen suffix went)
  if (num(rawAfter.TotalBuildDegen) > 0 && movedEnough(num(beforeStats.LifeRegenRecovery), num(rawAfter.LifeRegenRecovery), 0.001)) {
    const net = num(rawAfter.NetLifeRegen);
    notes.push({ stat: 'NetLifeRegen', shown: `Life regen ${formatStat('LifeRegenRecovery', num(beforeStats.LifeRegenRecovery))} -> ${formatStat('LifeRegenRecovery', num(rawAfter.LifeRegenRecovery))} against your own burn of ${formatStat('LifeRegenRecovery', num(rawAfter.TotalBuildDegen))}: net ${formatStat('LifeRegenRecovery', num(beforeStats.NetLifeRegen))} -> ${formatStat('LifeRegenRecovery', net)}${net < 0 ? ', so you lose life while the burn is on' : ', still above the burn'}` });
  }
  // defence a Vaal skill, guard or triggered buff gives, counted as always up: the numbers after the change without it
  for (const f of audit.findings.filter((x) => x.kind === 'conditionalDefence')) notes.push({ stat: `WithoutBuff:${f.id.slice(5)}`, shown: f.shown });
  const fixed = new Set(edits.flatMap((e) => (e.kind === 'setConfig' ? [`config:${e.key}`] : [])));
  return { edits, lines, notes, audit: { ...audit, findings: audit.findings.filter((f) => !fixed.has(f.id)) } };
}
