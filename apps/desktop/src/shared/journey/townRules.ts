/**
 * Town-visit advice and the death rules. The rules are code; Jev only decides the close calls.
 * No game constants live here: levels, penalties and safe ranges arrive in the facts, read from the knowledge base.
 */
import type { DefenceCheck, TownAdvice } from './types.js';

export type ResistName = 'fire' | 'cold' | 'light' | 'chaos';

export interface TownFacts {
  /** Plan gems that can be picked up now (hand-in zone passed, gem level reached). */
  gemsReady: { name: string; main: boolean; text: string }[];
  /** An inventory item with more links in the right colours than the equipped one. */
  linkUpgrade: string | null;
  /** An inventory flask of a higher tier than the equipped one of the same kind. */
  flaskUpgrade: string | null;
  /** The next zone is past an act penalty and these resists end below the cap. Empty when nothing breaks. */
  resistCliff: { resist: ResistName; after: number; need: number; why: string }[];
  /** A new act town since the last town visit and gear gaps a vendor can fill. */
  vendorScan: string | null;
  /** The character is under the safe range of the next zone's level. */
  levelGap: { under: number; areaLevel: number } | null;
}

export interface TownReason {
  kind: string;
  text: string;
  weight: number;
}

export interface TownRead {
  reasons: TownReason[];
  hard: boolean;
  weight: number;
}

const RESIST_NAME: Record<ResistName, string> = { fire: 'Fire', cold: 'Cold', light: 'Lightning', chaos: 'Chaos' };

export function townReasons(f: TownFacts): TownRead {
  const reasons: TownReason[] = [];
  let hard = false;
  for (const g of f.gemsReady) {
    reasons.push({ kind: 'gem', text: g.text, weight: g.main ? 99 : 2 });
    if (g.main) hard = true;
  }
  if (f.linkUpgrade) {
    reasons.push({ kind: 'links', text: f.linkUpgrade, weight: 99 });
    hard = true;
  }
  for (const r of f.resistCliff) {
    reasons.push({ kind: 'resist', text: `${RESIST_NAME[r.resist]} drops to ${r.after}% ${r.why} (need ${r.need})`, weight: 99 });
    hard = true;
  }
  if (f.flaskUpgrade) reasons.push({ kind: 'flask', text: f.flaskUpgrade, weight: 1 });
  if (f.vendorScan) reasons.push({ kind: 'vendor', text: f.vendorScan, weight: 1 });
  if (f.levelGap) reasons.push({ kind: 'level', text: `Under-levelled by ${f.levelGap.under} for area ${f.levelGap.areaLevel}: level here first`, weight: 1 });
  const weight = reasons.reduce((n, r) => n + (r.weight >= 99 ? 0 : r.weight), 0);
  return { reasons, hard, weight };
}

export type JevNoul = (state: string, question: string) => Promise<number | null>;

/** Hard reasons show at once; weight 0 shows nothing; weight 1-3 asks Jev; no Jev shows it at weight >= 2. */
export async function decideTown(read: TownRead, ctx: { minutesSinceTown: number | null; zonesToWaypoint: number | null; policy: string }, jev: JevNoul | null): Promise<TownAdvice | null> {
  if (read.hard) return { reasons: read.reasons.map(({ kind, text, weight }) => ({ kind, text, weight: weight >= 99 ? 3 : weight })), level: 'hard', decidedBy: 'code' };
  if (read.weight <= 0) return null;
  const shown = read.reasons.map(({ kind, text, weight }) => ({ kind, text, weight }));
  const state = [
    ...read.reasons.map((r) => r.text + '.'),
    ctx.minutesSinceTown === null ? 'No town visit seen yet.' : `Last town visit was ${ctx.minutesSinceTown < 5 ? 'a few' : ctx.minutesSinceTown < 20 ? 'some' : 'many'} minutes ago.`,
    ctx.zonesToWaypoint === null ? '' : ctx.zonesToWaypoint <= 1 ? 'A waypoint is right here.' : 'The next waypoint is several zones away.',
    ctx.policy,
  ]
    .filter(Boolean)
    .join(' ');
  const p = jev ? await jev(state, 'Is a town trip worth it right now for a player following a leveling route?') : null;
  if (p === null) return read.weight >= 2 ? { reasons: shown, level: 'suggested', decidedBy: 'fallback' } : null;
  return p >= 0.6 ? { reasons: shown, level: 'suggested', decidedBy: 'jev' } : null;
}

// ---- deaths ----

export interface DeathMark {
  at: number;
  /** The zone the character died in. */
  zone: string;
}

/** 2 deaths in one zone within 10 min, or 3 within an hour. Returns the deaths counted, or 0. */
export function defenceTrigger(deaths: readonly DeathMark[], now: number): number {
  const hour = deaths.filter((d) => now - d.at <= 3_600_000);
  if (hour.length >= 3) return hour.length;
  const byZone = new Map<string, number>();
  for (const d of deaths) if (now - d.at <= 600_000) byZone.set(d.zone, (byZone.get(d.zone) ?? 0) + 1);
  const worst = Math.max(0, ...byZone.values());
  return worst >= 2 ? worst : 0;
}

export interface DefenceNumbers {
  /** 'sync' numbers are the character's; 'plan' numbers are the checkpoint's. */
  source: 'sync' | 'plan';
  life?: number;
  lifeFloor?: number;
  /** Resistances after the act's penalty. */
  res: Partial<Record<ResistName, number>>;
  resCap: number;
  maxHit?: Partial<Record<string, number>>;
}

export function defenceCheck(deaths: number, n: DefenceNumbers | null): DefenceCheck {
  if (!n) return { deaths, worst: 'unknown', lines: ['No numbers yet: sync the character or build the plan.'] };
  const lines: string[] = [];
  const tag = n.source === 'plan' ? ' (plan, not your character)' : '';
  let worst = 'unknown';
  const hits = Object.entries(n.maxHit ?? {}).filter(([, v]) => typeof v === 'number') as [string, number][];
  if (hits.length) {
    hits.sort((a, b) => a[1] - b[1]);
    worst = hits[0]![0];
    lines.push(`Lowest max hit: ${worst} at ${Math.round(hits[0]![1])}${tag}.`);
  }
  const short = (Object.entries(n.res) as [ResistName, number][]).filter(([, v]) => v < n.resCap).sort((a, b) => a[1] - b[1]);
  for (const [k, v] of short) lines.push(`${RESIST_NAME[k]} resist is ${v}% after the penalty, cap ${n.resCap}${tag}.`);
  if (worst === 'unknown' && short.length) worst = RESIST_NAME[short[0]![0]!].toLowerCase();
  if (n.life !== undefined && n.lifeFloor !== undefined) lines.push(n.life < n.lifeFloor ? `Life ${Math.round(n.life)} is under the ${Math.round(n.lifeFloor)} floor${tag}.` : `Life ${Math.round(n.life)} meets the ${Math.round(n.lifeFloor)} floor${tag}.`);
  if (!lines.length) lines.push(`Resists and life look fine${tag}.`);
  return { deaths, worst, lines };
}
