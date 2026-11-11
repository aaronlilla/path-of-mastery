/**
 * The "this will give you:" lines of upstream's tooltips (`Build:CompareStatList`): every display stat the change
 * moves, as a signed difference in the stat's own format, green when it helps and red when it hurts.
 */
import type { StatDelta } from '@pom/protocol';

/** One display stat (`BuildDisplayStats.lua`): its output id, label and C-style format. */
export interface StatMeta {
  id: string;
  label: string;
  fmt: string;
  lowerIsBetter?: boolean;
  pc?: boolean;
  mod?: boolean;
  compPercent?: boolean;
}

export interface CompareLine {
  /** Signed difference with its suffix, like "+12.5%" or "-1,034". */
  value: string;
  label: string;
  /** The change is an improvement. */
  positive: boolean;
  /** " (+3.2%)" for stats that show a relative change. */
  percent?: string;
}

function addThousands(s: string): string {
  const m = /^([+-]?)(\d+)(.*)$/.exec(s);
  if (!m) return s;
  return m[1] + m[2]!.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + m[3];
}

/** `string.format("%+" .. fmt, v)` for the formats the display stats use ("d", ".1f", ".2fs", ".2f%%", "d%%"), with upstream's trailing-zero trim. */
export function formatSigned(fmt: string, v: number): string {
  const m = /^\+?(?:\.(\d+))?([df])(.*)$/.exec(fmt);
  if (!m) return String(v);
  const digits = m[2] === 'd' ? 0 : Number(m[1] ?? 6);
  const suffix = (m[3] ?? '').replace(/%%/g, '%');
  const rounded = m[2] === 'd' ? Math.trunc(v) : v;
  let body = rounded.toFixed(digits);
  if (!body.startsWith('-')) body = '+' + body;
  if (/^[+-]\d+\.\d+$/.test(body)) body = body.replace(/0+$/, '').replace(/\.$/, '');
  return addThousands(body + suffix);
}

export function compareStats(changed: StatDelta[], meta: StatMeta[]): CompareLine[] {
  const by = new Map<string, StatDelta>();
  for (const d of changed) by.set(d.statId, d);
  const seen = new Set<string>();
  const out: CompareLine[] = [];
  for (const m of meta) {
    const d = by.get(m.id);
    if (!d || seen.has(m.id)) continue;
    const before = typeof d.before === 'number' ? d.before : 0;
    const after = typeof d.after === 'number' ? d.after : 0;
    const diff = after - before;
    if (!(diff > 0.001 || diff < -0.001)) continue;
    seen.add(m.id);
    const positive = m.lowerIsBetter ? diff < 0 : diff > 0;
    const line: CompareLine = { value: formatSigned(m.fmt, diff * (m.pc || m.mod ? 100 : 1)), label: m.label, positive };
    if (m.compPercent && before !== 0 && after !== 0) {
      const pc = (after / before) * 100 - 100;
      line.percent = ` (${pc >= 0 ? '+' : ''}${pc.toFixed(1)}%)`;
    }
    out.push(line);
  }
  return out;
}
