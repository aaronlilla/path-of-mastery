// What the Fight tab draws, read from a `fightSim` result: the lanes under the chart, the "what changed when" rows and the histogram bins.
import type { FightResult } from '@pom/protocol';
import { tr } from '../i18n';

type Ev = FightResult['events'][number];

export interface Bar { a: number; b: number; col: string; text: string; dark?: boolean; k?: string }
export interface Lane { name: string; rows: Bar[][] }
export interface Row { t: number; kind: 'start' | 'end' | 'dot' | 'low'; colour: string; label: string; title?: string; dps: number | null }

const NAME_KEYS: Record<string, string> = {
  overridePowerCharges: 'h_f_Logic.power',
  overrideFrenzyCharges: 'h_f_Logic.frenzy',
  overrideEnduranceCharges: 'h_f_Logic.endurance',
  multiplierPoisonOnEnemy: 'h_f_Logic.poison',
  multiplierBleedsOnEnemy: 'h_f_Logic.bleeds',
  multiplierImpalesOnEnemy: 'h_f_Logic.impales',
  multiplierWitheredStackCount: 'h_f_Logic.wither',
  multiplierCorrosionStackCount: 'h_f_Logic.corrosion',
  multiplierRage: 'h_f_Logic.rage',
};
const nameOf = (c: string) => (tr as unknown as (k: string) => string)(NAME_KEYS[c]!);
const CURSE = new Set(['conditionEnemyCursed', 'conditionCursedEnemyRecently']);
const LOW = 'conditionEnemyLowLife';
const isFlask = (c: string) => c.startsWith('flask:');
const isStack = (c: string) => c in NAME_KEYS;

/** "conditionEnemyShocked" to "Enemy Shocked". */
const pretty = (e: Ev): string => (e.label !== e.condition ? e.label : e.condition.replace(/^(condition|multiplier|use)/, '').replace(/([a-z])([A-Z])/g, '$1 $2').trim() || e.condition);

export const fmtS = (v: number) => v.toFixed(1);
export const fmtM = (v: number) => (v >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(1) + 'k' : String(Math.round(v)));

/** The fight's length: the kill time, or the capped fight's seconds. */
export const fightEnd = (r: FightResult): number => r.ttk.seconds ?? r.dpsSeries.length;

/** DPS of the fight's second that holds time `t`. */
export const dpsAt = (r: FightResult, t: number): number | null => {
  const s = r.dpsSeries;
  return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.floor(t)))]! : null;
};

export function lanesOf(r: FightResult): Lane[] {
  const T = fightEnd(r);
  const stacks: Bar[][] = [];
  const seen = new Map<string, { max: number; last: number }>();
  const flaskOn = new Map<string, number>();
  const flasks: Bar[] = [];
  const curse: Bar[] = [];
  const low: Bar[] = [];
  for (const e of r.events) {
    if (isStack(e.condition) && typeof e.value === 'number') {
      const s = seen.get(e.condition) ?? { max: 0, last: 0 };
      if (e.value > s.max) seen.set(e.condition, { max: e.value, last: e.t });
    } else if (e.condition.endsWith('Stacks') && e.configured === null && typeof e.value === 'number') {
      stacks.push([{ a: 0, b: e.t, col: '#9cc8ff', text: tr('h_f_Logic.stack_full', { name: e.label.replace(' at full stacks', ''), n: Math.round(e.value), t: fmtS(e.t) }), dark: true }]);
    } else if (isFlask(e.condition)) {
      if (e.value === true) flaskOn.set(e.condition, e.t);
      else if (flaskOn.has(e.condition)) {
        const a = flaskOn.get(e.condition)!;
        flaskOn.delete(e.condition);
        flasks.push({ a, b: e.t, col: 'rgba(79,220,124,.5)', k: e.condition.slice(6), text: tr('h_f_Logic.flask_win', { f: e.condition.slice(6), a: fmtS(a), b: fmtS(e.t) }) });
      }
    } else if (CURSE.has(e.condition) && e.value === true && !curse.length) curse.push({ a: e.t, b: T, col: 'rgba(178,92,255,.55)', text: tr('h_f_Logic.curse_from', { t: fmtS(e.t) }) });
    else if (e.condition === LOW && e.value === true) low.push({ a: e.t, b: T, col: 'rgba(239,70,86,.6)', text: tr('h_f_Logic.low_from', { pct: Math.round(r.boss.lowLifeThreshold * 100), t: fmtS(e.t) }) });
  }
  for (const [c, s] of seen) if (s.last > 0) stacks.push([{ a: 0, b: s.last, col: '#9cc8ff', text: tr('h_f_Logic.stack_at', { name: nameOf(c), n: Math.round(s.max), t: fmtS(s.last) }), dark: true }]);
  for (const [c, a] of flaskOn) flasks.push({ a, b: T, col: 'rgba(79,220,124,.5)', k: c.slice(6), text: tr('h_f_Logic.flask_from', { f: c.slice(6), a: fmtS(a) }) });
  // One row per flask: windows of different flasks overlap and would hide each other on one row.
  const flaskRows = new Map<string, Bar[]>();
  for (const b of flasks.sort((x, y) => x.a - y.a)) flaskRows.set(b.k!, [...(flaskRows.get(b.k!) ?? []), b]);
  const out: Lane[] = [];
  if (stacks.length) out.push({ name: tr('h_f_Logic.lane_stacks'), rows: stacks });
  if (curse.length) out.push({ name: tr('h_f_Logic.lane_curse'), rows: [curse] });
  if (low.length) out.push({ name: tr('h_f_Logic.lane_low'), rows: [low] });
  if (flasks.length) out.push({ name: tr('h_f_Logic.lane_flask'), rows: [...flaskRows.entries()].sort((x, y) => Number(x[0]) - Number(y[0])).map((e) => e[1]) });
  return out;
}

export function rowsOf(r: FightResult): Row[] {
  const T = fightEnd(r);
  const rows: Row[] = [{ t: 0, kind: 'start', colour: 'var(--text-muted)', label: tr('h_f_Logic.fight_starts'), dps: null }];
  const full = new Map<string, Ev>();
  const grouped = new Map<number, Ev[]>();
  for (const e of r.events) {
    if (isStack(e.condition) && typeof e.value === 'number') {
      if (e.value > 0) full.set(e.condition, e);
    } else if (e.condition.endsWith('Stacks') && e.configured === null) rows.push({ t: e.t, kind: 'dot', colour: 'var(--stat-speed)', label: e.label, dps: dpsAt(r, e.t) });
    else if (isFlask(e.condition)) rows.push({ t: e.t, kind: 'dot', colour: 'var(--positive)', label: tr(e.value === true ? 'h_f_Logic.flask_starts' : 'h_f_Logic.flask_ends', { f: e.condition.slice(6) }), dps: dpsAt(r, e.t) });
    else if (e.condition === LOW) { if (e.value === true) rows.push({ t: e.t, kind: 'low', colour: 'var(--negative)', label: tr('h_f_Logic.boss_low'), dps: dpsAt(r, e.t) }); }
    else if (CURSE.has(e.condition)) { if (e.value === true) rows.push({ t: e.t, kind: 'dot', colour: 'var(--compare-b)', label: tr('h_f_Logic.curse_applied'), dps: dpsAt(r, e.t) }); }
    else if (e.t > 0 && e.value === true) grouped.set(e.t, [...(grouped.get(e.t) ?? []), e]);
  }
  for (const e of full.values()) rows.push({ t: e.t, kind: 'dot', colour: 'var(--stat-speed)', label: tr('h_f_Logic.stacks_n', { name: nameOf(e.condition), n: Math.round(e.value as number) }), dps: dpsAt(r, e.t) });
  for (const [t, es] of grouped) {
    const names = es.map(pretty);
    rows.push({ t, kind: 'dot', colour: 'var(--text-2)', label: names.length > 2 ? tr('h_f_Logic.more', { names: names.slice(0, 2).join(', '), n: names.length - 2 }) : names.join(', '), title: names.join(', '), dps: dpsAt(r, t) });
  }
  rows.push({ t: T, kind: 'end', colour: 'var(--gold-400)', label: r.killed ? tr('h_f_Logic.boss_dies') : tr('h_f_Logic.boss_alive'), dps: null });
  return rows.sort((a, b) => a.t - b.t || (a.kind === 'end' ? 1 : 0) - (b.kind === 'end' ? 1 : 0));
}

/** Kill times in equal bins, whole seconds unless the spread is wide. */
export function binsOf(ttks: number[]): { lo: number; step: number; counts: number[] } {
  const min = ttks[0]!, max = ttks[ttks.length - 1]!;
  const step = Math.max(1, Math.ceil((max - min) / 30));
  const lo = Math.floor(min / step) * step;
  const counts = new Array<number>(Math.floor((max - lo) / step) + 1).fill(0);
  for (const v of ttks) counts[Math.floor((v - lo) / step)]!++;
  return { lo, step, counts };
}

/** An axis step of 1, 2 or 5 times a power of ten that gives about `n` divisions of `max`. */
export function niceStep(max: number, n: number): number {
  const raw = max / n, p = 10 ** Math.floor(Math.log10(raw)), f = raw / p;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
}
