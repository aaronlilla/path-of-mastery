// The one check every build change passes before it goes live. It reads only numbers the scratch trial already
// computed, so it is a pure function: each rule below is a named row with its own test.
//
// Who chose the change decides what a failed row does. A change the player named exactly still goes in, with its
// cost said first and the better option one tap away. A change the assistant chose goes in only when it breaks
// nothing and gains more than it costs; otherwise a nearby variant that passes goes in instead, or it stays a card.
import { formatStat, statMeta } from '../../shared/assistant/statLabels.js';
import { planApply } from './askShape.js';
import { guardBreaks, MAX_HITS } from './playerSense.js';
import type { Scalar } from './tools.js';

type Stats = Record<string, Scalar>;

export type GateRule =
  | 'uncapped' // an elemental resist that sat at its cap falls under it
  | 'layer' // a defence layer the build paid for drops: suppression, block, an ailment immunity, a recovery source
  | 'maxHit' // a per-type max hit falls by more than MAX_HIT_DROP
  | 'chaos' // chaos resistance falls and takes the chaos max hit down with it
  | 'warning' // the engine shows a warning it did not show before
  | 'unmet' // a requirement no fixer could repair
  | 'sockets' // a gem that does not fit its item's socket colours
  | 'mana' // the main skill stops paying its own mana
  | 'movement' // movement speed falls
  | 'level' // the character level moves without the player saying the character levelled
  | 'trade' // the asked stat gains less, in percent, than the other side loses
  | 'limit' // the other side loses more than TRADE_LIMIT
  | 'honest' // one of the rows above, read with typed custom modifiers off
  | 'unchecked' // a check that could not run
  | 'question'; // the player only asked a question

export interface GateRow { rule: GateRule; shown: string }

export interface GateInput {
  before: Stats;
  after: Stats;
  /** The engine's own before when `before` was adjusted (old debt left out): every number shown reads it, the pass/fail tests do not. */
  shownBefore?: Stats;
  warnBefore: string[];
  warnAfter: string[];
  /** Requirements the fixers could not repair. */
  unfixed: string[];
  /** The trial's item lines; a socket colour misfit is one of them. */
  itemLines: string[];
  /** Effective HP without a guard skill counted as always up. */
  guard?: { name: string; before: number; after: number } | null;
  /** The same before and after with enabled typed custom modifiers off. Null when that reading could not run; left out when the build types none. */
  honest?: { before: Stats; after: Stats } | null;
  /** The stat id the player asked about. */
  stat?: string;
  /** Every edit only sets what the calculation assumes (config, the main skill): a lower number is the build read honestly, not a cost. */
  configOnly?: boolean;
  /** The character level before and after, when the change sets it. */
  level?: { before: number; after: number };
}

export interface GateAsk {
  /** Every thing the change sets is named, by its game name, in the player's message. */
  named: boolean;
  /** The message is only a question. */
  question: boolean;
  /** The player said in words that spell suppression may go. */
  suppressionWaived: boolean;
  /** The player said the character is a higher level than the build. */
  levelAsked?: boolean;
}

export interface GateVerdict {
  /** apply: nothing failed. applyWithCost: the player named it, it goes in with `reason` said first. variant: the variant goes in, the asked change is a card. card: nothing goes in. */
  outcome: 'apply' | 'applyWithCost' | 'variant' | 'card';
  rows: GateRow[];
  /** Every failed row in one line, for the card and the answer. */
  reason: string;
  /** The variant given passes the gate. */
  variantPasses: boolean;
}

/** How much the side the player did not ask about may lose. */
export const TRADE_LIMIT = 0.15;
/** How far a per-type max hit may fall before it counts as a break, on a damage ask (the trade rows weigh the rest). */
export const MAX_HIT_DROP = 0.05;
/** Movement speed (EffectiveMovementSpeedMod, 1 = base) moves smaller than this are rounding. */
const MOVE_NOISE = 0.005;
const AILMENTS = ['Freeze', 'Chill', 'Shock', 'Ignite', 'Poison', 'Bleed', 'Stun'];
/** Moves smaller than this are engine noise, not a cost. */
const NOISE = 0.005;

const num = (s: Stats, id: string) => (typeof s[id] === 'number' ? (s[id] as number) : 0);
const rel = (b: number, a: number) => (b > 0 ? (a - b) / b : 0);
const pctText = (d: number) => `${d >= 0 ? '+' : '-'}${Math.abs(Math.round(d * 1000) / 10)}%`;
const moveText = (id: string, b: number, a: number, label = statMeta(id).label) => `${label} ${formatStat(id, b)} -> ${formatStat(id, a)} (${pctText(rel(b, a))})`;
/** Damage means single target: Full DPS when the build tracks it, else the main skill's, else the minions' (a minion build's own DPS reads 0). */
const damageId = (s: Stats) => (num(s, 'FullDPS') > 0 ? 'FullDPS' : num(s, 'CombinedDPS') <= 0 && num(s, 'MinionTotalDPS') > 0 ? 'MinionTotalDPS' : 'CombinedDPS');
const manaGap = (s: Stats) => num(s, 'ManaPerSecondCost') - num(s, 'ManaRegenRecovery') - num(s, 'ManaLeechRate');
const ignoredWarning = (w: string) => /Dot DPS exceeds in game limit/i.test(w);

/** An ailment the build was not immune to before and is after (the stat class: every <Ailment>AvoidChance reaching 100). */
const gainsImmunity = (before: Stats, after: Stats) => AILMENTS.some((a) => num(before, `${a}AvoidChance`) < 100 && num(after, `${a}AvoidChance`) >= 100);

/** The change clears something that was broken: a warning, a resist brought to its cap, a skill that pays its mana again. */
function fixesSomething(i: GateInput): boolean {
  if (i.warnBefore.some((w) => !ignoredWarning(w) && !i.warnAfter.includes(w))) return true;
  if (['Fire', 'Cold', 'Lightning'].some((e) => num(i.before, `${e}Resist`) < num(i.before, `${e}ResistMax`) && num(i.after, `${e}Resist`) >= num(i.after, `${e}ResistMax`) && num(i.after, `${e}ResistMax`) > 0)) return true;
  if (AILMENTS.some((a) => num(i.before, `${a}AvoidChance`) < 100 && num(i.after, `${a}AvoidChance`) >= 100)) return true;
  return manaGap(i.before) > 0 && manaGap(i.after) <= 0;
}

/**
 * The trade rows. The goal is the asked stat; with none asked, the key stat that gained most. The other side is
 * damage or effective HP, effective HP read both with and without a guard skill. A fix with no damage or effective HP
 * asked is held to the limit only, since clearing a break is worth a small cost.
 */
function tradeRows(before: Stats, after: Stats, i: GateInput): GateRow[] {
  // the numbers shown are the engine's own before; an adjusted before only decides pass or fail
  const shown = before === i.before && i.shownBefore ? i.shownBefore : before;
  const dmg = damageId(before);
  const keys = [dmg, 'TotalEHP'];
  const asked = i.stat === 'CombinedDPS' || i.stat === 'FullDPS' ? dmg : i.stat;
  const sides = [
    { id: dmg, b: num(before, dmg), sb: num(shown, dmg), a: num(after, dmg), label: statMeta(dmg).label },
    { id: 'TotalEHP', b: num(before, 'TotalEHP'), sb: num(shown, 'TotalEHP'), a: num(after, 'TotalEHP'), label: statMeta('TotalEHP').label },
    ...(i.guard ? [{ id: 'TotalEHP', b: i.guard.before, sb: i.guard.before, a: i.guard.after, label: `Effective HP without ${i.guard.name}` }] : []),
  ].filter((s) => s.b > 0);
  const goal = asked && (typeof before[asked] === 'number' || typeof after[asked] === 'number') ? asked : [...sides].filter((s) => rel(s.b, s.a) > NOISE).sort((x, y) => rel(y.b, y.a) - rel(x.b, x.a))[0]?.id;
  const goalSides = sides.filter((s) => s.id === goal);
  // the goal's own move: its weakest reading when it has two (effective HP with and without the guard)
  const gain = goalSides.length ? Math.min(...goalSides.map((s) => rel(s.b, s.a))) : goal ? rel(num(before, goal), num(after, goal)) : 0;
  const shownGain = goalSides.length ? Math.min(...goalSides.map((s) => rel(s.sb, s.a))) : goal ? rel(num(shown, goal), num(after, goal)) : 0;
  const losses = sides.filter((s) => s.id !== goal && rel(s.b, s.a) < -NOISE);
  const rows: GateRow[] = losses.filter((s) => -rel(s.b, s.a) > TRADE_LIMIT).map((s) => ({ rule: 'limit', shown: `${moveText(s.id, s.sb, s.a, s.label)}, more than the ${TRADE_LIMIT * 100}% the other side may lose` }));
  // an ailment immunity the build lacked (freeze 20% -> 100%) is worth a modest defence loss: up to 5% effective HP, the
  // damage limit as usual (Penguin held for -2.2% EHP; a player takes that trade every time)
  if (gainsImmunity(before, after)) return sides.filter((s) => -rel(s.b, s.a) > (s.id === 'TotalEHP' ? MAX_HIT_DROP : TRADE_LIMIT)).map((s) => ({ rule: 'limit', shown: `${moveText(s.id, s.sb, s.a, s.label)}, more than a new ailment immunity is worth` }));
  if (fixesSomething(i) && !(asked && keys.includes(asked))) return rows;
  const worst = losses.sort((x, y) => rel(x.b, x.a) - rel(y.b, y.a))[0];
  const goalLabel = goal ? statMeta(goal).label : '';
  if (goal && gain < -NOISE) rows.push({ rule: 'trade', shown: `${moveText(goal, num(shown, goal), num(after, goal), goalLabel)}: the asked stat falls` });
  else if (worst && gain < -rel(worst.b, worst.a)) rows.push({ rule: 'trade', shown: `${goal ? `${goalLabel} ${pctText(shownGain)}` : 'Nothing gains'} for ${moveText(worst.id, worst.sb, worst.a, worst.label)}: it gains less than it costs` });
  return rows;
}

/** Every row the change fails on one reading of the numbers. */
function readingRows(before: Stats, after: Stats, i: GateInput, suppressionWaived: boolean): GateRow[] {
  const rows: GateRow[] = [];
  for (const line of guardBreaks(before, after, false)) {
    if (/resistance/.test(line)) rows.push({ rule: 'uncapped', shown: line });
    else if (!(suppressionWaived && /suppression/i.test(line))) rows.push({ rule: 'layer', shown: line });
  }
  // a change that is not a damage trade and fixes nothing ("better boots") may not lower what one hit the build survives
  const fix = fixesSomething({ ...i, before, after });
  const drop = i.stat && /DPS$/.test(i.stat) || fix ? MAX_HIT_DROP : NOISE;
  for (const id of MAX_HITS) {
    const [b, a] = [num(before, id), num(after, id)];
    if (b <= 0 || a >= b * (1 - drop)) continue;
    const chaos = id === 'ChaosMaximumHitTaken' && num(after, 'ChaosResist') < num(before, 'ChaosResist');
    rows.push(chaos
      ? { rule: 'chaos', shown: `Chaos resistance ${formatStat('ChaosResist', num(before, 'ChaosResist'))} -> ${formatStat('ChaosResist', num(after, 'ChaosResist'))} takes ${moveText(id, b, a)}` }
      : { rule: 'maxHit', shown: moveText(id, b, a) });
  }
  const [mb, ma] = [num(before, 'EffectiveMovementSpeedMod'), num(after, 'EffectiveMovementSpeedMod')];
  // a fix may not cost movement speed either: the freeze fix took the Quicksilver's speed
  if (mb > 0 && ma < mb - MOVE_NOISE) rows.push({ rule: 'movement', shown: `Movement speed ${pctText(ma / mb - 1)}` });
  if (num(after, 'ManaPerSecondCost') > 0 && manaGap(after) > 0 && manaGap(before) <= 0) {
    const r = (v: number) => `${Math.round(v * 10) / 10}/s`;
    rows.push({ rule: 'mana', shown: `The skill costs ${r(num(after, 'ManaPerSecondCost'))} mana against ${r(num(after, 'ManaRegenRecovery') + num(after, 'ManaLeechRate'))} coming back: short by ${r(manaGap(after))}` });
  }
  return i.configOnly ? rows : [...rows, ...tradeRows(before, after, i)];
}

/** Every row the change fails, on the numbers as they stand and on the honest reading. */
function gateRows(i: GateInput, suppressionWaived: boolean): GateRow[] {
  const rows = readingRows(i.before, i.after, i, suppressionWaived);
  // a requirement warning is said once, by the unmet row that names the gem
  for (const w of i.warnAfter) if (!i.warnBefore.includes(w) && !ignoredWarning(w) && !(i.unfixed.length && /do not meet/i.test(w))) rows.push({ rule: 'warning', shown: `New warning: ${w}` });
  for (const u of i.unfixed) rows.push({ rule: 'unmet', shown: u });
  for (const l of i.itemLines) if (/^Socket colours:/.test(l)) rows.push({ rule: 'sockets', shown: l });
  // the only source of a defence buff goes (Fortify's Fortification): nothing defensive is removed without a tap, ticked in config or not
  else if (/^Loses Fortification \(its only source/.test(l)) rows.push({ rule: 'layer', shown: l });
  if (i.honest === null) rows.push({ rule: 'unchecked', shown: 'The numbers with your typed custom modifiers off could not be read' });
  else if (i.honest) {
    const seen = new Set(rows.map((r) => r.rule));
    for (const r of readingRows(i.honest.before, i.honest.after, { ...i, guard: null }, suppressionWaived)) if (!seen.has(r.rule)) rows.push({ rule: 'honest', shown: `${r.shown} (with your typed custom modifiers off)` });
  }
  return rows;
}

/**
 * The verdict on one change, and on its variant when the change fails. The variant is the same change without the
 * part that broke something; it is judged as a change the assistant chose.
 */
export function checkChange(asked: GateInput, ask: GateAsk, variant?: GateInput | null): GateVerdict {
  const rows = gateRows(asked, ask.suppressionWaived);
  // the level is the character's: the app never moves it on its own reading of "I have 5 points" (95 went to 100)
  const level = asked.level && asked.level.after !== asked.level.before && !ask.levelAsked ? { rule: 'level' as const, shown: `Character level ${asked.level.before} -> ${asked.level.after}: the level is your character's, and you did not say it levelled` } : null;
  if (level) rows.unshift(level);
  const reason = rows.map((r) => r.shown).join('; ');
  const variantPasses = !!variant && !gateRows(variant, ask.suppressionWaived).length;
  if (ask.question) return { outcome: 'card', rows: [{ rule: 'question', shown: 'You asked a question, so the build stays as it is' }, ...rows], reason: ['You asked a question, so the build stays as it is', ...(reason ? [reason] : [])].join('; '), variantPasses };
  if (!rows.length) return { outcome: 'apply', rows, reason, variantPasses };
  if (ask.named && !level) return { outcome: 'applyWithCost', rows, reason, variantPasses };
  return { outcome: variantPasses ? 'variant' : 'card', rows, reason, variantPasses };
}

/**
 * The first line of an answer whose change the gate held as a card: what it is, its gain and its cost in numbers, that the
 * build stays as it was, and that the card is one tap away ("Best belt for Full DPS is Perseverance: Full DPS +2.2% but
 * Effective HP without Molten Shell -4.7%, so I left your belt on. Tap the card to equip it.").
 */
export function heldLine(i: GateInput, v: GateVerdict, what: { name: string; slot?: string; ranked: boolean }): string {
  const dmg = damageId(i.before);
  // the line shows the engine's own before, never one adjusted for the gate
  i = { ...i, before: i.shownBefore ?? i.before };
  const goal = !i.stat || i.stat === 'CombinedDPS' || i.stat === 'FullDPS' ? dmg : i.stat;
  const label = statMeta(goal).label;
  const gain = rel(num(i.before, goal), num(i.after, goal));
  const losses = [
    { label: statMeta('TotalEHP').label, b: num(i.before, 'TotalEHP'), a: num(i.after, 'TotalEHP') },
    ...(i.guard ? [{ label: `Effective HP without ${i.guard.name}`, b: i.guard.before, a: i.guard.after }] : []),
    { label: statMeta(dmg).label, b: num(i.before, dmg), a: num(i.after, dmg) },
  ].filter((s) => s.label !== label && s.b > 0 && rel(s.b, s.a) < -NOISE).sort((x, y) => rel(x.b, x.a) - rel(y.b, y.a));
  // a held change whose cost is not a trade (a resist off its cap, a max hit) names that row
  // the row over the trade limit is what held it (armour -15.5% on a flask swap), so it names the cost first
  const limit = v.rows.find((r) => r.rule === 'limit')?.shown.replace(/, more than .*$/, '');
  const cost = limit ?? (losses[0] ? `${losses[0].label} ${pctText(rel(losses[0].b, losses[0].a))}` : v.rows.find((r) => r.rule !== 'trade' && r.rule !== 'question')?.shown ?? v.reason);
  const word = what.slot && /^\w+$/.test(what.slot) ? what.slot.toLowerCase() : '';
  const left = word ? `your ${word} on` : what.slot ? `${what.slot} as it was` : 'the build as it was';
  const verb = what.slot ? 'equip' : 'apply';
  // no rise in the asked stat (a flask picked for freeze): never print a 0% "gain"; say the immunity it gives and its worst defence loss
  if (gain <= NOISE) {
    const immune = AILMENTS.filter((a) => num(i.before, `${a}AvoidChance`) < 100 && num(i.after, `${a}AvoidChance`) >= 100).map((a) => a.toLowerCase());
    const worst = ['Armour', 'Evasion', 'EnergyShield', 'Life', 'TotalEHP', 'PhysicalMaximumHitTaken']
      .map((id) => ({ id, d: rel(num(i.before, id), num(i.after, id)) })).filter((x) => x.d < -NOISE).sort((x, y) => x.d - y.d)[0];
    const lost = limit ?? (worst ? `${statMeta(worst.id).label} ${pctText(worst.d)}` : cost);
    return `${what.name}${immune.length ? ` makes you immune to ${immune.join(' and ')} but` : ''} costs ${lost}, so I left ${left}. Tap the card to ${verb} it.`;
  }
  const head = what.ranked ? `Best ${word ? `${word} ` : ''}for ${label} is ${what.name}` : what.name;
  return `${head}: ${label} ${pctText(gain)}${cost ? ` but ${cost}` : ''}, so I left ${left}. Tap the card to ${verb} it.`;
}

const norm = (s: string) => ` ${s.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()} `;

/**
 * The player named the change exactly: each thing it sets (a node, an item, a gem) is in the message by one of its
 * game names. "Put it on" names only the act, so the pick stays the assistant's.
 */
export function namedByPlayer(message: string, things: string[][]): boolean {
  const m = norm(message);
  return things.length > 0 && things.every((names) => names.some((n) => norm(n).trim().length >= 3 && m.includes(norm(n))));
}

const ADVICE = /\b(should|recommend|suggest|upgrade|improve|fix|best|better|optimi[sz]e|help)\b/i;
const CHANGE = /\b(put|equip|wear|take|allocate|spend|swap|replace|switch|change|make|add|remove|drop|craft|set|respec|buy|apply|enable|disable)\b|\bturn (it |them )?(on|off)\b|\b(go ahead|do it|get me)\b/i;

/** Every sentence is a question, with no advice word and no change verb: the answer is a number or a fact, never a change. */
export function isPureQuestion(message: string): boolean {
  const sentences = message.split(/(?<=[.?!])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  // an upgrade ask the app's plan puts changes in for ("What's next?") is never a question that holds them ("Which is my weakest resistance?" still is)
  return sentences.length > 0 && sentences.every((s) => s.endsWith('?')) && !ADVICE.test(message) && !CHANGE.test(message) && !planApply(message);
}

/** The player gave up spell suppression in words about suppression ("keep my suppression" is the opposite). */
export function waivesSuppression(message: string): boolean {
  return /\b(lose|losing|lost|drop|dropping|give up|giving up|trade|trading|sacrifice|without|(do not|don'?t|doesn'?t) (care|need|matter)( about)?|no need for|fine to lose|ok to lose|okay to lose)\b[^.?!]{0,30}\b(spell )?(suppress\w*|dodge)/i.test(message)
    || /\b(suppress\w*|dodge)\b[^.?!]{0,30}\b(does ?n'?o?t matter|is fine to lose|can go|is optional|not needed|(do not|don'?t) care)\b/i.test(message);
}
