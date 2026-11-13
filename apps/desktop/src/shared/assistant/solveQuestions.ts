import type { SolveGoal, SolveWealth } from '@pom/protocol';
import { CLASSES } from '../buildXml.js';

// The questions the Solve form asks as one-tap buttons, at most four (PLAN.md section 3, "The questions the app asks").
// Pure data: the panel draws it, the app fills `evidence` from the knowledge pack (without it only the first two show).

export type QuestionId = 'budget' | 'focus' | 'ascendancy' | 'gem';

export interface QuestionOption {
  /** What `answerQuestion` takes. */
  value: string;
  label: string;
  /** The most played one: "most played, 42%". */
  note?: string;
}

export interface Question {
  id: QuestionId;
  text: string;
  options: QuestionOption[];
  /** What the goal holds now (null: not answered). */
  answer: string | null;
  /** The option the evidence recommends, when it differs from `answer`: the panel shows it picked for ascendancy (apply it once with `answerQuestion`), as one tap for the gem. Budget and focus never have one: they are asked every time. */
  suggested?: string;
  /** Run stays disabled until every required question has an answer. */
  required: boolean;
  /** Ascendancy of a named class: the most played ascendancy of the skill when it belongs to another class (shown as information, never picked). */
  elsewhere?: { name: string; share: number };
}

/** A build with no gems, no items and no tree points: only then may the panel pick the most played ascendancy for a goal that names none. */
export const isBlankBuild = (xml: string): boolean => !/<Gem\b|<Item\b/.test(xml) && !/\bnodes="[^"]+"/.test(xml);

/** What the evidence table knows for the skill: ascendancies by share of builds (0..1), and every version of the gem with its build count. */
export interface QuestionEvidence {
  ascendancies?: Array<{ name: string; share: number }>;
  versions?: Array<{ name: string; builds: number }>;
}

const WEALTH: Array<[SolveWealth, string]> = [['league-start', 'League start'], ['mid-league', 'Mid league'], ['rich', 'Rich'], ['mirror', 'Mirror']];
const FOCUS: Array<['mapping' | 'bossing' | 'both', string]> = [['mapping', 'Mapping'], ['bossing', 'Bossing'], ['both', 'Both']];
const pct = (x: number) => `${Math.round(x * 100)}%`;

/** The questions to show for this goal, in order: budget, what for, ascendancy (the words named none), gem version (most players run another). */
export function solveQuestions(goal: SolveGoal | null, ev: QuestionEvidence = {}): Question[] {
  const qs: Question[] = [
    { id: 'budget', text: 'How rich are you?', options: WEALTH.map(([value, label]) => ({ value, label })), answer: goal?.wealth ?? null, required: true },
    { id: 'focus', text: 'What is it for?', options: FOCUS.map(([value, label]) => ({ value, label })), answer: goal?.assume?.playMode ?? null, required: true },
  ];
  const all = [...(ev.ascendancies ?? [])].sort((a, b) => b.share - a.share);
  // A class the player named wins: only its ascendancies are offered and none is picked for them; the most played elsewhere is information only.
  const named = goal?.className ? CLASSES.find((c) => c.name.toLowerCase() === goal.className!.toLowerCase()) : undefined;
  if (goal && !goal.ascendancy && named && all.length) {
    const own = named.ascendancies.map((n) => all.find((a) => a.name === n) ?? { name: n, share: 0 }).sort((a, b) => b.share - a.share);
    const top = all[0]!;
    qs.push({ id: 'ascendancy', text: 'Which ascendancy?', options: own.map((a) => ({ value: a.name, label: a.name })), answer: null, required: false, ...(named.ascendancies.includes(top.name) ? {} : { elsewhere: { name: top.name, share: top.share } }) });
  } else if (goal && !goal.ascendancy && all.length) {
    const asc = all.slice(0, 4);
    qs.push({ id: 'ascendancy', text: 'Which ascendancy?', options: asc.map((a, i) => ({ value: a.name, label: a.name, ...(i === 0 ? { note: `most played, ${pct(a.share)}` } : {}) })), answer: null, suggested: asc[0]!.name, required: false });
  }
  const typed = (goal?.skill ?? '').toLowerCase();
  const top = [...(ev.versions ?? [])].sort((a, b) => b.builds - a.builds)[0];
  const mine = ev.versions?.find((v) => v.name.toLowerCase() === typed)?.builds ?? 0;
  if (goal && top && top.name.toLowerCase() !== typed && top.builds > mine) {
    const total = ev.versions!.reduce((n, v) => n + v.builds, 0);
    qs.push({ id: 'gem', text: 'Which version of the gem?', options: [{ value: goal.skill, label: goal.skill }, { value: top.name, label: top.name, note: `most played, ${pct(top.builds / total)}` }], answer: goal.skill, suggested: top.name, required: false });
  }
  return qs;
}

/** Run is enabled after the budget and the focus. */
export const canRun = (qs: Question[]): boolean => qs.every((q) => !q.required || q.answer !== null);

/** The goal with one tap applied. A new skill drops nothing else; an ascendancy sets its class too. */
export function answerQuestion(goal: SolveGoal, id: QuestionId, value: string): SolveGoal {
  if (id === 'budget') return { ...goal, wealth: value as SolveWealth };
  if (id === 'focus') return { ...goal, assume: { ...goal.assume, playMode: value as 'mapping' | 'bossing' | 'both' } };
  if (id === 'gem') return { ...goal, skill: value };
  const cls = CLASSES.find((c) => c.ascendancies.includes(value))?.name;
  return { ...goal, ascendancy: value, ...(cls ? { className: cls } : {}) };
}

/**
 * The class and ascendancy the form starts with when the goal names neither: the open build's own when it is not blank (an "improve my build" ask never moves class),
 * else, on a blank build, the most played (`suggested`, shown as picked with its one-tap change: `picked`). Null leaves the form as it is.
 */
export function preselect(goal: SolveGoal, open: { className: string; ascendClassName: string; xml: string }, suggested?: string): { className: string; ascendancy: string; picked: boolean } | null {
  if (goal.className || goal.ascendancy) return null;
  if (!isBlankBuild(open.xml)) return open.className ? { className: open.className, ascendancy: open.ascendClassName === 'None' ? '' : open.ascendClassName, picked: false } : null;
  if (!suggested) return null;
  return { className: answerQuestion(goal, 'ascendancy', suggested).className ?? '', ascendancy: suggested, picked: true };
}

/** The level box: what the goal says, else the tier's usual one (league start 85 to 90, every other tier 95), else null and the panel keeps the open build's. Never a question. */
export function usualLevel(goal: SolveGoal | null): number | null {
  if (goal?.level) return goal.level;
  return goal?.wealth ? (goal.wealth === 'league-start' ? 88 : 95) : null;
}

/** The level the form shows: its own once the player, the open build or an earlier goal set it (`own`), else `usualLevel` of the goal. */
export const followLevel = (own: boolean, level: number, goal: SolveGoal): number => (own ? level : usualLevel(goal) ?? level);

// ---- the evidence the questions read, from the shipped real-builds pack (resources/buildpatterns/patterns.json) ----

interface PackSpread { p10: number | null; p50: number | null; p90: number | null; max: number | null }
/** The part of the pack this reads (buildPatterns.ts holds the whole shape). */
export interface PackLike {
  league: string | null;
  collected: string[];
  bySkill: Record<string, { builds: number; ascendancies?: Array<{ name: string; share: number }>; dps?: PackSpread; ehp?: PackSpread }>;
}

/** What the pack knows for the typed skill. `sits` is only there when the skill has at least `MIN_BUILDS` real builds. */
export interface AskEvidence extends QuestionEvidence {
  sits?: { builds: number; league: string | null; collected: string | null; dps?: PackSpread; ehp?: PackSpread };
}

/** A group below this many builds is not a pattern (same floor as buildPatterns MIN_SAMPLE). */
export const MIN_BUILDS = 8;
const baseOf = (name: string) => name.replace(/^Vaal /, '').replace(/ of .*$/, '');

/** Ascendancies, gem versions and the spread of DPS and EHP for `skill`, or null when the pack holds no usable group for it. */
export function evidenceFor(pack: PackLike, skill: string): AskEvidence | null {
  const typed = skill.trim().toLowerCase();
  const own = Object.entries(pack.bySkill).find(([n]) => n.toLowerCase() === typed)?.[1];
  const base = baseOf(skill.trim()).toLowerCase();
  const versions = Object.entries(pack.bySkill).filter(([n]) => !n.startsWith('Vaal ') && baseOf(n).toLowerCase() === base).map(([name, g]) => ({ name, builds: g.builds }));
  const big = own && own.builds >= MIN_BUILDS ? own : undefined;
  if (!big && versions.length < 2) return null;
  return {
    ...(big?.ascendancies?.length ? { ascendancies: big.ascendancies.map((a) => ({ name: a.name, share: a.share })) } : {}),
    ...(versions.length > 1 ? { versions } : {}),
    ...(big ? { sits: { builds: big.builds, league: pack.league, collected: pack.collected.at(-1) ?? null, ...(big.dps ? { dps: big.dps } : {}), ...(big.ehp ? { ehp: big.ehp } : {}) } } : {}),
  };
}

export type Standing = 'all' | 'p90' | 'p50' | 'p10' | 'low';
/** Where one asked number sits among the real builds: above every one, above 9 in 10, above half, above 1 in 10, or below nearly all. */
export function standing(ask: number, s: PackSpread | undefined): Standing | null {
  if (!s || !(ask > 0) || s.p10 === null || s.p50 === null || s.p90 === null) return null;
  return s.max !== null && ask > s.max ? 'all' : ask > s.p90 ? 'p90' : ask > s.p50 ? 'p50' : ask > s.p10 ? 'p10' : 'low';
}
