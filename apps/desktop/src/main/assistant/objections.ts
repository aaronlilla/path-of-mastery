// What a player faults in a finished build at a glance, as checks a program runs (PLAN.md "Builder O" and slice 4; the floor is
// the player checks list). Checks 1 to 9 are the nine of the plan table, 10 to 19 the rest of the floor. Each failing check is
// one line in player words. The assessment reads the list for its verdict: a check with `blocks` (5, 6, 17) means "not ready"
// (cannot be made or used in game), any other means "objections" (needs fixes, still applicable).
import { auditBuild } from './audit.js';
import { readItems } from '../../shared/itemsXml.js';
import { recoveryOf } from './playerSense.js';
import { gemCatalog } from './gemFit.js';
import { readEquipped } from './buildReaders.js';
import { socketMisfits, statMap, toBuildEdit, withScratch, type Scalar, type ToolContext, type ToolEdit } from './tools.js';

export interface Objection {
  /** The check, 1 to 19 (1 to 9: PLAN.md table; 10 to 19: the rest of the floor). */
  n: number;
  /** One line in player words. */
  text: string;
  /** The build cannot be made or used in game: the verdict is "not ready". */
  blocks: boolean;
}

export interface ObjectionResult {
  found: Objection[];
  /** Checks that threw (engine gone, data missing): never read as passed. */
  failed: number[];
}

const num = (s: Record<string, Scalar>, k: string): number => (typeof s[k] === 'number' ? (s[k] as number) : 0);
const pct = (x: number): string => `${Math.round(x * 100)}%`;
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;
/** A modifier line's shape: tags and numbers out ("58% increased Energy Shield" and "(56-74)% increased Energy Shield" match). */
const shape = (s: string): string => s.replace(/\{[^}]*\}/g, '').replace(/\(\d+(\.\d+)?-\d+(\.\d+)?\)|\d+(\.\d+)?/g, '#').trim();

/** DoT damage this much of the total makes Malevolence the aura a player expects. */
const DOT_SHARE = 0.5;
/** A boss fight this far from fully up is a flask a player would not run (FlaskDrainUptime is 1 when the charges last the fight). */
const FLASK_UP = 0.9;
/** Movement skills that put you on the target (the only list this check has; shortcut: Bodyswap is the one the game data tags that way, add a name when a second one shows up). */
const LANDS_ON_TARGET = new Set(['Bodyswap']);
/** Supports that deliver a curse without a hand: Hextouch and Blasphemy by their effect, Spell Totem (a Wither totem is the common case). */
const CURSE_DELIVERY = new Set(['Hextouch', 'Blasphemy', 'Spell Totem']);
/** Ascendancy notables re-scored (the plan's cap: about 10). */
const MAX_ASC_RESCORES = 10;

interface Gem { name: string; tags: string[]; support: boolean; group: number; source: boolean; slot: string; enabled: boolean }

/** Every enabled gem of the build (item-granted skills included) with its game tags. */
async function gemsOf(ctx: ToolContext, buildId: string): Promise<Gem[]> {
  const [{ state }, { gems: catalog }] = await Promise.all([ctx.engine.send('skillsState', { buildId }), gemCatalog(ctx)]);
  const byId = new Map(catalog.map((g) => [g.id, g]));
  return state.groups
    .filter((g) => g.enabled && !g.slotInactive)
    .flatMap((g) => g.gems.filter((x) => x.enabled).map((x) => ({ name: x.nameSpec, tags: (x.gemId ? byId.get(x.gemId)?.tags : undefined) ?? [], support: x.support, group: g.index, source: !!g.source, slot: g.slot ?? '', enabled: true })));
}

// 1. A damage-over-time build with no Malevolence.
function noMalevolence(stats: Record<string, Scalar>, gems: Gem[]): Objection[] {
  const total = num(stats, 'FullDPS') || num(stats, 'CombinedDPS') || num(stats, 'TotalDPS');
  const dot = num(stats, 'FullDotDPS') || num(stats, 'TotalDotDPS');
  if (!total || dot / total < DOT_SHARE || gems.some((g) => g.name === 'Malevolence')) return [];
  return [{ n: 1, blocks: false, text: `${pct(dot / total)} of the damage is damage over time and the build has no Malevolence, the standard aura for it.` }];
}

const LIFE_FLASK = /\bLife Flask\b/;
const flasksOf = (xml: string) => readEquipped(xml).filter((i) => /^Flask \d$/.test(i.slot));

// 2. More than two life flasks.
function lifeFlasks(xml: string): Objection[] {
  const flasks = flasksOf(xml);
  const life = flasks.filter((i) => LIFE_FLASK.test(`${i.name}\n${i.base}`));
  if (life.length <= 2) return [];
  const utility = flasks.filter((i) => !/\b(Life|Mana|Hybrid) Flask\b/.test(`${i.name}\n${i.base}`)).length;
  return [{ n: 2, blocks: false, text: `${plural(life.length, 'life flask')} and ${utility ? plural(utility, 'utility flask') : 'no utility flasks'}: more than two life flasks leaves no room for the utility flasks (movement, armour, evasion, damage) a player runs.` }];
}

// 3. A flask enchant that stops a flask gaining charges; a main skill that spends charges faster than the flasks gain them.
function flaskCharges(xml: string, stats: Record<string, Scalar>): Objection[] {
  const out: Objection[] = [];
  const stuck = flasksOf(xml).filter((i) => /Gains no Charges during Effect/i.test(i.text));
  if (stuck.length) out.push({ n: 3, blocks: false, text: `${plural(stuck.length, 'flask')} (${stuck.map((i) => i.slot).join(', ')}) carry the enchant "Gains no Charges during Effect": they do not refill while they work.` });
  const up = Math.min(num(stats, 'FlaskDrainUptime') || 1, num(stats, 'FlaskDrainUptimeMap') || 1);
  if (num(stats, 'FlaskDrainSpent') > num(stats, 'FlaskDrainGained') && up < FLASK_UP) out.push({ n: 3, blocks: false, text: `The main skill spends flask charges faster than the flasks gain them: the flasks are up ${pct(up)} of a fight.` });
  return out;
}

// 4. An allocated ascendancy notable or keystone that changes nothing: take it off (with what hangs off it) and score again,
// against taking off only what hangs off it. The same result means the node itself gives the build nothing.
async function idleAscendancy(ctx: ToolContext, buildId: string, xml: string): Promise<Objection[]> {
  const { tree } = await ctx.engine.send('treeState', { buildId });
  const picks: Array<{ id: number; name: string }> = [];
  // the engine counts Withered only from the config's stack count, so a notable that inflicts it always reads as idle (Nature's Reprisal): not judged
  for (const id of tree.allocated) {
    const n = await ctx.tree.node(tree.treeVersion, id);
    if (n?.ascendancy && !n.ascendancyStart && (n.type === 'Notable' || n.type === 'Keystone') && !n.stats.some((t) => /Withered/.test(t))) picks.push({ id, name: n.name });
  }
  const set = (ids: number[]): ToolEdit => ({ kind: 'setNodes', nodeIds: ids });
  const idle: string[] = [];
  for (const p of picks.slice(0, MAX_ASC_RESCORES)) {
    // what hangs off the node: the allocation after clicking it off, on a throw-away copy
    const left = await withScratch(ctx, xml, async (b) => {
      await ctx.engine.send('edit', { buildId: b, edit: toBuildEdit({ kind: 'clickNode', nodeId: p.id }) });
      return new Set((await ctx.engine.send('treeState', { buildId: b })).tree.allocated);
    });
    const gone = tree.allocated.filter((x) => !left.has(x));
    const keepNode = tree.allocated.filter((x) => x === p.id || left.has(x));
    const { results } = await ctx.engine.send('previewEdits', { buildId, edits: [toBuildEdit(set(tree.allocated.filter((x) => !gone.includes(x)))), toBuildEdit(set(keepNode))], full: true });
    const [withoutIt, withIt] = results;
    if (!withoutIt || !withIt || 'error' in withoutIt || 'error' in withIt) continue;
    const moved = (r: typeof withoutIt) => new Map(r.statDiff.changed.map((c) => [c.statId, c.after]));
    const a = moved(withoutIt);
    const b = moved(withIt);
    const same = a.size === b.size && [...a].every(([k, v]) => b.has(k) && (typeof v === 'number' && typeof b.get(k) === 'number' ? Math.abs(v - (b.get(k) as number)) <= 1e-9 * Math.max(1, Math.abs(v)) : v === b.get(k)));
    if (same) idle.push(p.name);
  }
  return idle.length ? [{ n: 4, blocks: false, text: `${idle.join(', ')} ${idle.length === 1 ? 'does' : 'do'} nothing for this build: take ${idle.length === 1 ? 'it' : 'them'} off and nothing changes.` }] : [];
}

// 5. Socket colours that cannot hold the gems in the item.
async function socketColours(ctx: ToolContext, xml: string): Promise<Objection[]> {
  const slots = readEquipped(xml).filter((i) => !/^Flask/.test(i.slot) && /^Sockets: /m.test(i.text)).map((i) => i.slot);
  return (await socketMisfits(ctx, xml, slots)).map((text) => ({ n: 5, blocks: true, text }));
}

// 6. A crafted mod that is not legal on the base: not in the mod pool of the base, or a defence the base does not have.
const DEFENCE = { Armour: 'Armour', Evasion: 'Evasion', 'Energy Shield': 'EnergyShield' } as const;
async function illegalCrafts(ctx: ToolContext, xml: string): Promise<Objection[]> {
  const out: Objection[] = [];
  for (const it of readEquipped(xml)) {
    if (/^Flask|^Charm/.test(it.slot)) continue;
    const rows = it.text.split('\n');
    const at = rows.findIndex((l) => l.startsWith('Implicits: '));
    const from = at >= 0 ? at + 1 + (parseInt(rows[at]!.slice(11), 10) || 0) : 0;
    const crafts = rows.slice(from).filter((l) => /\{crafted\}/.test(l) && !/\{enchant\}|unveiled_mod/.test(l));
    if (!crafts.length) continue;
    const info = (await ctx.engine.send('itemInfo', { itemText: it.text })).item;
    if (!info.valid || !info.baseName) continue;
    const { pool } = await ctx.engine.send('modPool', { base: info.baseName, itemLevel: info.itemLevel ?? 84 });
    const legal = new Set([...pool.prefixes, ...pool.suffixes].flatMap((m) => m.stats.map((s) => shape(s.text))));
    for (const line of crafts) {
      const plain = line.replace(/\{[^}]*\}/g, '').trim();
      if (/^Can have up to/.test(plain)) continue;
      const defs = /increased ((?:Armour|Evasion|Energy Shield)(?:,? (?:and )?(?:Armour|Evasion|Energy Shield))*)$/.exec(plain)?.[1]?.split(/,\s*|\s+and\s+/).filter(Boolean) ?? [];
      const missing = defs.filter((d) => !((info.defences?.[DEFENCE[d as keyof typeof DEFENCE]] ?? 0) > 0));
      if (!legal.has(shape(plain)) || missing.length) out.push({ n: 6, blocks: true, text: `${it.slot}: "${plain}" is not a craft the bench can put on ${info.baseName}${missing.length ? ` (it has no ${missing.join(' or ')})` : ''}.` });
    }
  }
  return out;
}

// 7. A movement skill that lands on the target (no other movement skill beside it).
function landsOnTarget(gems: Gem[]): Objection[] {
  const moves = gems.filter((g) => !g.support && g.tags.includes('movement'));
  const bad = moves.filter((g) => LANDS_ON_TARGET.has(g.name));
  if (!bad.length || moves.length > bad.length) return [];
  return [{ n: 7, blocks: false, text: `${bad[0]!.name} is the movement skill: it puts you on the enemy, and against a boss that is on top of it. A player takes a blink or a dash.` }];
}

// 8. A curse with no delivery: no Hextouch, Blasphemy or totem in its group, and no item that curses on hit.
function handCastCurses(gems: Gem[]): Objection[] {
  const bySource = new Set(gems.filter((g) => g.source).map((g) => g.name));
  const out: Objection[] = [];
  for (const g of gems) {
    // a mark is cast by hand by design
    if (g.support || g.source || !g.tags.includes('curse') || g.tags.includes('mark') || bySource.has(g.name)) continue;
    if (gems.some((s) => s.support && s.group === g.group && CURSE_DELIVERY.has(s.name))) continue;
    out.push({ n: 8, blocks: false, text: `${g.name} is cast by hand: nothing puts it on enemies (no Hextouch, Blasphemy, totem or curse-on-hit item).` });
  }
  return out;
}

// 9. A number that leans on a config switch the build cannot reach: the audit's config findings, and Blind switched on
// against a build that blinds only some hits (shortcut: the chance is read from item text, not from the engine; add a stat when the engine has one).
async function leansOnConfig(ctx: ToolContext, buildId: string, xml: string, gems: Gem[]): Promise<Objection[]> {
  const audit = await auditBuild(ctx, buildId, xml);
  const out: Objection[] = audit.findings.filter((f) => f.kind === 'config').map((f) => ({ n: 9, blocks: false, text: f.shown }));
  const { state } = await ctx.engine.send('configState', { buildId });
  if (state.values.conditionEnemyBlinded === true && !gems.some((g) => g.support && g.name === 'Blind')) {
    const chance = readEquipped(xml).reduce((s, i) => s + [...i.text.matchAll(/(\d+)% (?:Global )?chance to Blind Enemies on [Hh]it/g)].reduce((t, m) => t + Number(m[1]), 0), 0);
    if (chance < 100) out.push({ n: 9, blocks: false, text: `Enemy Blinded is switched on, but the build blinds only ${chance}% of hits.` });
  }
  return out;
}

// ---- Checks 10 to 19: the rest of the floor (PLAYER-CHECKS.md top 15, sections A and F, and the per-type ones). Thresholds are picks, marked.

/** Below this hit chance an attack build misses often enough that a player adds accuracy (pick; Precise Technique and Resolute Technique read 100). */
const HIT_CHANCE_FLOOR = 90;
/** A resist this many points under its cap is a hole a player crafts shut (pick: a point or two under is how real characters play). */
const RESIST_GAP = 5;
/** Chaos resistance below this is more than the "keep it positive" a player settles for (pick: the Vault guide calls deeply negative tolerable). */
const CHAOS_FLOOR = -60;
/** Life plus energy shield coming back each second under this share of the pool, with no life flask: nothing recovers the build (pick). */
const RECOVERY_FLOOR = 0.02;
/** A triggered main skill that fires less often than this a second (pick: 1 a second). */
const TRIGGER_FLOOR = 1;
/** A mana or life cost this far over what comes back each second is a skill the player cannot keep casting (pick). */
const SUSTAIN_SLACK = 0.05;

interface Skill { name: string; flags: string[]; disableReason: string | null; minion?: unknown }
const ELEMENTS = ['Fire', 'Cold', 'Lightning'] as const;

// 10. Reservation that does not fit the pool.
function reservationFit(s: Record<string, Scalar>): Objection[] {
  const out: Objection[] = [];
  if (typeof s.ManaUnreserved === 'number' && s.ManaUnreserved < 0) out.push({ n: 10, blocks: false, text: `Reservations take ${Math.round(-s.ManaUnreserved)} more mana than the build has: not every aura can be on at once.` });
  if (typeof s.LifeUnreserved === 'number' && s.LifeUnreserved < 1) out.push({ n: 10, blocks: false, text: 'Reservations take all of the life: the build has no life left to play with.' });
  return out;
}

// 11. The main skill costs more mana or life than comes back, or more than reservations leave.
function sustain(s: Record<string, Scalar>): Objection[] {
  const out: Objection[] = [];
  const manaIn = num(s, 'ManaRegenRecovery') + num(s, 'ManaLeechRate');
  const manaOut = num(s, 'ManaPerSecondCost');
  if (manaOut > 0 && manaOut - manaIn > manaOut * SUSTAIN_SLACK) out.push({ n: 11, blocks: false, text: `The main skill costs ${Math.round(manaOut)} mana a second and only ${Math.round(manaIn)} comes back: it runs dry.` });
  if (typeof s.ManaUnreserved === 'number' && s.ManaUnreserved >= 0 && num(s, 'ManaCost') > s.ManaUnreserved) out.push({ n: 11, blocks: false, text: `One use of the main skill costs ${Math.round(num(s, 'ManaCost'))} mana and reservations leave ${Math.round(s.ManaUnreserved)}.` });
  const lifeIn = num(s, 'LifeRegenRecovery') + num(s, 'LifeLeechRate');
  const lifeOut = num(s, 'LifePerSecondCost');
  if (lifeOut > 0 && lifeOut - lifeIn > lifeOut * SUSTAIN_SLACK) out.push({ n: 11, blocks: false, text: `The main skill costs ${Math.round(lifeOut)} life a second and only ${Math.round(lifeIn)} comes back.` });
  return out;
}

// 12. Nothing gives life or energy shield back (no regeneration, leech, recharge or life flask worth the name).
function recovery(s: Record<string, Scalar>, xml: string): Objection[] {
  const pool = num(s, 'Life') + num(s, 'EnergyShield');
  if (!pool || s.ChaosInoculation === true) return [];
  const back = ['LifeRegenRecovery', 'LifeLeechRate', 'EnergyShieldRegenRecovery', 'EnergyShieldLeechRate', 'EnergyShieldRecharge'].reduce((t, id) => t + recoveryOf(s, id), 0);
  if (back / pool >= RECOVERY_FLOOR || flasksOf(xml).some((i) => LIFE_FLASK.test(`${i.name}\n${i.base}`))) return [];
  return [{ n: 12, blocks: false, text: `Nothing gives life back: ${Math.round(back)} a second against a pool of ${Math.round(pool)}, and no life flask.` }];
}

// 13. An attack that misses too often.
function accuracy(s: Record<string, Scalar>, skill: Skill): Objection[] {
  if (!skill.flags.includes('attack') || typeof s.HitChance !== 'number' || s.HitChance >= HIT_CHANCE_FLOOR) return [];
  return [{ n: 13, blocks: false, text: `${skill.name} hits ${Math.round(s.HitChance)}% of the time: add accuracy.` }];
}

// 14. Resistances under their caps (chaos only when far below zero).
function resistCaps(s: Record<string, Scalar>): Objection[] {
  const low = ELEMENTS.filter((e) => num(s, `Missing${e}Resist`) >= RESIST_GAP);
  const out: Objection[] = low.length ? [{ n: 14, blocks: false, text: `${low.map((e) => `${e.toLowerCase()} ${Math.round(num(s, `${e}Resist`))}%`).join(', ')} under the ${Math.round(num(s, `${low[0]}ResistMax`)) || 75}% cap.` }] : [];
  if (typeof s.ChaosResist === 'number' && s.ChaosResist < CHAOS_FLOOR && s.ChaosInoculation !== true) out.push({ n: 14, blocks: false, text: `Chaos resistance is ${Math.round(s.ChaosResist)}%.` });
  return out;
}

// 15. Jewel sockets: the build uses none, or took some and left them empty. Reads the item text and the allocated nodes of the active tree (shortcut: the price budget is not
// known here, jewels are read as cheap).
async function jewels(ctx: ToolContext, buildId: string, xml: string): Promise<Objection[]> {
  const { tree } = await ctx.engine.send('treeState', { buildId });
  const taken = new Set(tree.allocated);
  const model = readItems(xml);
  const items = new Map(model.items.map((i) => [i.id, i.text]));
  const placed = new Map([...(model.specs[model.activeSpec - 1]?.sockets ?? [])].filter(([node]) => taken.has(node)).map(([node, id]) => [node, id ? items.get(id) : undefined]));
  // a jewel with no modifier line (an empty base, the placeholder a solver leaves) does nothing
  const works = (t: string | undefined) => { const r = (t ?? '').split('\n'); const at = r.findIndex((l) => l.startsWith('Implicits: ')); return at >= 0 && r.length > at + 1; };
  const empty = [...placed.values()].filter((t) => !works(t)).length;
  if (!placed.size) return [{ n: 15, blocks: false, text: 'No jewel socket on the tree is taken: the build runs no jewels, which are a cheap source of damage and life.' }];
  return empty ? [{ n: 15, blocks: false, text: `${plural(empty, 'jewel socket')} taken on the tree and left empty.` }] : [];
}

// 16. An amulet with no anoint (the usual planner rule: any amulet except a talisman; a corrupted one cannot be anointed).
function missingAnoint(xml: string): Objection[] {
  const a = readEquipped(xml).find((i) => i.slot === 'Amulet');
  if (!a || /Talisman/.test(`${a.base}\n${a.name}`) || /^Corrupted$/m.test(a.text) || /Allocates /.test(a.text)) return [];
  return [{ n: 16, blocks: false, text: `${a.name || 'The amulet'} has no anoint: a free notable is left unused.` }];
}

// 17. A main skill the weapons or the reservations disable (the engine's own reason: wrong weapon type, a shield with a two-hander, a skill that needs mana reserved).
function weaponLegal(skill: Skill): Objection[] {
  return skill.disableReason ? [{ n: 17, blocks: true, text: `${skill.name} is switched off in game: ${skill.disableReason}.` }] : [];
}

// 18. A triggered main skill that fires rarely.
function triggerRate(s: Record<string, Scalar>, skill: Skill): Objection[] {
  const rate = num(s, 'SkillTriggerRate');
  return rate > 0 && rate < TRIGGER_FLOOR ? [{ n: 18, blocks: false, text: `${skill.name} is triggered only ${rate.toFixed(2)} times a second.` }] : [];
}

// 19. A minion build whose minions are under their resist caps.
async function minionSurvival(ctx: ToolContext, buildId: string, skill: Skill): Promise<Objection[]> {
  if (!skill.minion) return [];
  const m = ((await ctx.engine.send('getStats', { buildId })).stats as Array<{ id: string; value: unknown }>).find((x) => x.id === 'Minion')?.value as Record<string, unknown> | undefined;
  const low = ELEMENTS.filter((e) => typeof m?.[`Missing${e}Resist`] === 'number' && (m[`Missing${e}Resist`] as number) >= RESIST_GAP);
  return low.length ? [{ n: 19, blocks: false, text: `The minions are under their resist cap: ${low.map((e) => `${e.toLowerCase()} ${Math.round(m![`${e}Resist`] as number)}%`).join(', ')}.` }] : [];
}

/** Runs the nineteen checks on one build (an engine build id and its text). A check that throws is listed in `failed`, never counted as passed. */
export async function playerObjections(ctx: ToolContext, buildId: string, xml: string): Promise<ObjectionResult> {
  const found: Objection[] = [];
  const failed: number[] = [];
  const run = async (n: number, f: () => Objection[] | Promise<Objection[]>) => {
    try { found.push(...(await f())); } catch { failed.push(n); }
  };
  let stats: Record<string, Scalar> = {};
  let gems: Gem[] = [];
  let skill: Skill | undefined;
  try { [stats, gems] = await Promise.all([statMap(ctx, buildId), gemsOf(ctx, buildId)]); } catch { failed.push(1, 3, 7, 8, 9, 10, 11, 12, 13, 14, 18); }
  try { skill = (await ctx.engine.send('mainSkill', { buildId })) as Skill; } catch { failed.push(13, 17, 18, 19); }
  if (!failed.includes(1)) await run(1, () => noMalevolence(stats, gems));
  await run(2, () => lifeFlasks(xml));
  if (!failed.includes(3)) await run(3, () => flaskCharges(xml, stats));
  await run(4, () => idleAscendancy(ctx, buildId, xml));
  await run(5, () => socketColours(ctx, xml));
  await run(6, () => illegalCrafts(ctx, xml));
  if (!failed.includes(7)) await run(7, () => landsOnTarget(gems));
  if (!failed.includes(8)) await run(8, () => handCastCurses(gems));
  if (!failed.includes(9)) await run(9, () => leansOnConfig(ctx, buildId, xml, gems));
  if (!failed.includes(10)) await run(10, () => reservationFit(stats));
  if (!failed.includes(11)) await run(11, () => sustain(stats));
  if (!failed.includes(12)) await run(12, () => recovery(stats, xml));
  if (!failed.includes(13) && skill) await run(13, () => accuracy(stats, skill!));
  if (!failed.includes(14)) await run(14, () => resistCaps(stats));
  await run(15, () => jewels(ctx, buildId, xml));
  await run(16, () => missingAnoint(xml));
  if (!failed.includes(17) && skill) await run(17, () => weaponLegal(skill!));
  if (!failed.includes(18) && skill) await run(18, () => triggerRate(stats, skill!));
  if (!failed.includes(19) && skill) await run(19, () => minionSurvival(ctx, buildId, skill!));
  return { found: found.sort((a, b) => a.n - b.n), failed };
}
