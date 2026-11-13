import type { SolveGoal, SolveWealth } from '@pom/protocol';
import { CLASSES } from '../../shared/buildXml.js';

// The wizard is asked every time; what the ask's own words state fills it in, never a guess.

/** Whole-build divine cap per tier, engine-data/wealth_tiers.json budgetDivines (mirror has none: only the word picks it). */
const TIER_CAP: Array<[SolveWealth, number]> = [['league-start', 4], ['mid-league', 10], ['rich', 150]];

export interface AskWords {
  wealth?: SolveWealth;
  playMode?: 'mapping' | 'bossing' | 'both';
}

/** The tier and the mode the message says out loud. A tier word beats a divine figure; a figure picks the richest tier it covers. */
export function askWords(text: string): AskWords {
  const t = text.toLowerCase();
  const out: AskWords = {};
  if (/\bmirror[- ]?(tier|budget|level|wealth|rich)\b/.test(t)) out.wealth = 'mirror';
  else if (/\brich\b|\bwealthy\b/.test(t)) out.wealth = 'rich';
  else if (/\bmid[- ]?league\b/.test(t)) out.wealth = 'mid-league';
  else if (/\bleague[- ]?start(er)?\b/.test(t)) out.wealth = 'league-start';
  else {
    const m = /(\d+(?:\.\d+)?)\s*(?:div|divs|divine|divines)\b/.exec(t);
    if (m) out.wealth = TIER_CAP.filter(([, cap]) => Number(m[1]) >= cap).pop()?.[0] ?? 'league-start';
  }
  // "maps, not bosses" names bosses to leave them out
  const asked = t.replace(/\b(not|no|without|never|except)\s+(?:for\s+|the\s+|any\s+)*(?:mapping|mappers?|maps|t1\d|bossers?|bossing|boss|bosses|pinnacle|uber)\b/g, ' ');
  const map = /\b(mapping|mapper|mappers|maps|t1\d)s?\b/.test(asked);
  const boss = /\b(bosser|bossers|bossing|boss|bosses|pinnacle|uber)\b/.test(asked);
  if (map && boss) out.playMode = 'both';
  else if (map) out.playMode = 'mapping';
  else if (boss) out.playMode = 'bossing';
  return out;
}

const BUILD = /\b(build|solve|solver|make me|create|new)\b/i;
const ITEM = /\b(ring|amulet|belt|helm|helmet|gloves|boots|body armou?r|chest|weapon|shield|quiver|jewel|flask|gem|node)\b/i;
const FIX = /\b(upgrade|better|worth|replace|swap|craft|buy|improve)\b/i;

/** False for a one-item or fix ask ("is this ring an upgrade", "fix my resists"): those never open the wizard. */
export function opensWizard(text: string): boolean {
  return BUILD.test(text) || !((ITEM.test(text) && FIX.test(text)) || /\bfix\b/i.test(text));
}

/** The goal with wealth and playMode taken from the ask's words only: a value the model picked on its own is dropped. */
export function prefillFromAsk(request: string, goal: SolveGoal): SolveGoal {
  const w = askWords(request);
  const { wealth: _w, ...rest } = goal;
  const { playMode: _p, ...assume } = goal.assume ?? {};
  return { ...rest, ...(w.wealth ? { wealth: w.wealth } : {}), ...(w.playMode ? { assume: { ...assume, playMode: w.playMode } } : Object.keys(assume).length ? { assume } : {}) };
}

// ---- the wizard first: the build ask read at once, before the router and the AI turn --------------------------------

/** What an ask states about the build, all from the player's own words. */
export interface BuildAsk {
  skill: string;
  level?: number;
  className?: string;
  ascendancy?: string;
  targets: Array<{ name: string; metric: string; value: number }>;
  wealth?: SolveWealth;
  playMode?: 'mapping' | 'bossing' | 'both';
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const UNIT: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, mil: 1e6, million: 1e6, b: 1e9, billion: 1e9 };
const STAT: Record<string, { name: string; metric: string }> = { dps: { name: 'DPS', metric: 'dps' }, ehp: { name: 'EHP', metric: 'ehp' }, life: { name: 'Life', metric: 'life' }, es: { name: 'ES', metric: 'es' } };
const NUM_STAT = /(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k|m|b|thousand|million|mil|billion)?\+?\s*(dps|ehp|life|es)\b/gi;

/** The longest skill name the words contain, whole words only, so "Poisonous Concoction of Bouncing" beats "Poisonous Concoction". */
export function skillIn(text: string, skillNames: string[]): string | undefined {
  const t = text.toLowerCase();
  return skillNames.filter((n) => n.length > 2 && new RegExp(`(?<![a-z0-9'])${esc(n.toLowerCase())}(?![a-z0-9'])`).test(t)).sort((a, b) => b.length - a.length)[0];
}

/**
 * The ask read as a form: a build ask (the words "build", "make me", ...) that names a skill from the gem list and at least one
 * number to reach ("3M DPS", "80k EHP"). Anything less is null: the AI turn handles it as before and the form does not open early.
 */
export function readBuildAsk(text: string, skillNames: string[]): BuildAsk | null {
  if (!BUILD.test(text)) return null;
  const skill = skillIn(text, skillNames);
  if (!skill) return null;
  const targets: BuildAsk['targets'] = [];
  for (const m of text.matchAll(NUM_STAT)) {
    const stat = STAT[m[3]!.toLowerCase()]!;
    const value = Number(m[1]!.replace(/,/g, '')) * (UNIT[(m[2] ?? '').toLowerCase()] ?? 1);
    if (value > 0 && !targets.some((x) => x.metric === stat.metric)) targets.push({ ...stat, value });
  }
  if (!targets.length) return null;
  const level = /\b(?:level|lvl)\s*(\d{1,3})\b/i.exec(text)?.[1];
  const has = (w: string) => new RegExp(`\\b${esc(w)}\\b`, 'i').test(text);
  const asc = CLASSES.flatMap((c) => c.ascendancies.map((a) => ({ a, c: c.name }))).find((x) => has(x.a));
  const cls = asc?.c ?? CLASSES.find((c) => c.name !== 'Scion' && has(c.name))?.name;
  const w = askWords(text);
  return { skill, targets, ...(level && Number(level) <= 100 ? { level: Number(level) } : {}), ...(cls ? { className: cls } : {}), ...(asc ? { ascendancy: asc.a } : {}), ...(w.wealth ? { wealth: w.wealth } : {}), ...(w.playMode ? { playMode: w.playMode } : {}) };
}

/** The ask as the goal the form opens with. */
export function goalOfAsk(a: BuildAsk): SolveGoal {
  return {
    skill: a.skill,
    ...(a.className ? { className: a.className } : {}),
    ...(a.ascendancy ? { ascendancy: a.ascendancy } : {}),
    ...(a.level ? { level: a.level } : {}),
    targets: a.targets,
    ...(a.wealth ? { wealth: a.wealth } : {}),
    ...(a.playMode ? { assume: { playMode: a.playMode } } : {}),
  };
}

/** The same ask worded differently by the AI ("make me a ..." vs the verbatim copy): one of them holds the other. */
export function sameAsk(a: string, b: string): boolean {
  const n = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const x = n(a), y = n(b);
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
}

/**
 * The AI's goal arriving after the form was opened from the ask: the player's answers stay. Whatever the form holds (skill, level,
 * class, ascendancy, targets, budget, focus) beats the AI's value; the AI adds the rest (limits, gems, items, plan).
 */
export function keepAnswers(open: SolveGoal, late: SolveGoal): SolveGoal {
  const out: SolveGoal = { ...late, skill: open.skill };
  for (const k of ['level', 'className', 'ascendancy', 'wealth'] as const) if (open[k] !== undefined) (out as unknown as Record<string, unknown>)[k] = open[k];
  if (open.targets?.length) out.targets = open.targets;
  if (open.assume?.playMode) out.assume = { ...late.assume, playMode: open.assume.playMode };
  return out;
}
