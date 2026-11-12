/**
 * `Build:CompareStatList`'s lines for the stats an edit changed, in upstream's number formats ("+12 Total Life").
 * The rows (label, format, which direction is better) come from upstream's own display stat list; see statCompare.ts.
 */

export interface StatRow {
  stat: string;
  label: string;
  fmt: string;
  flag?: string;
  notFlag?: string;
  childStat?: string;
  lowerIsBetter?: boolean;
  pc?: boolean;
  mod?: boolean;
  compPercent?: boolean;
}

export interface Delta {
  statId: string;
  before: number | string | boolean | null;
  after: number | string | boolean | null;
}

export interface CompareLine {
  /** The whole line: value, label and percentage. */
  text: string;
  good: boolean;
  stat: string;
}

/** What kind of main skill the build has, which decides which of two rows sharing a stat applies. */
export interface SkillKind {
  spell: boolean;
  attack: boolean;
}

export function skillKindOf(stats: Record<string, number | string | boolean | null | undefined>): SkillKind {
  const spell = typeof stats.CastRate === 'number';
  return { spell, attack: !spell && typeof stats.Speed === 'number' && stats.Speed > 0 };
}

function flagOk(flag: string | undefined, kind: SkillKind): boolean {
  if (!flag) return true;
  if (flag === 'attack') return kind.attack;
  if (flag === 'spell') return kind.spell;
  return flag === 'hit' || flag === 'notAverage';
}

/** A C-style `%+<fmt>` of `v`: `d`, `.1f`, `.2f%%`, `+d%%`, `.2fs`; thousands are grouped and a trailing decimal zero is dropped. */
export function formatSigned(fmt: string, v: number): string {
  const m = /^\+?(?:\.(\d+))?([df])(.*)$/.exec(fmt);
  if (!m) return String(v);
  const digits = m[1] !== undefined ? parseInt(m[1], 10) : 0;
  const suffix = (m[3] ?? '').replace(/%%/g, '%');
  const num = m[2] === 'd' ? Math.trunc(v) : v;
  let s = (m[2] === 'd' ? String(Math.abs(num)) : Math.abs(num).toFixed(digits)) + suffix;
  const trim = /^(\d+\.\d+)(\D*)$/.exec(s);
  if (trim) s = trim[1]!.replace(/0+$/, '').replace(/\.$/, '') + trim[2];
  const group = /^(\d+)(.*)$/.exec(s);
  if (group) s = group[1]!.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + group[2];
  return (num < 0 ? '-' : '+') + s;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export function compareLines(rows: StatRow[], changed: Delta[], kind: SkillKind): CompareLine[] {
  const by = new Map(changed.map((c) => [c.statId, c]));
  const out: CompareLine[] = [];
  const done = new Set<string>();
  for (const r of rows) {
    if (r.childStat || r.stat === 'SkillDPS' || done.has(r.stat)) continue;
    const c = by.get(r.stat);
    if (!c || !flagOk(r.flag, kind)) continue;
    const after = num(c.after);
    const before = num(c.before);
    const diff = after - before;
    if (!(diff > 0.001 || diff < -0.001)) continue;
    done.add(r.stat);
    const good = r.lowerIsBetter ? diff < 0 : diff > 0;
    const val = diff * (r.pc || r.mod ? 100 : 1);
    let text = `${formatSigned(r.fmt, val)} ${r.label}`;
    if (r.compPercent && after !== 0 && before !== 0) {
      const pc = (after / before) * 100 - 100;
      text += ` (${pc >= 0 ? '+' : '-'}${Math.abs(pc).toFixed(1)}%)`;
    }
    out.push({ text, good, stat: r.stat });
  }
  return out;
}
