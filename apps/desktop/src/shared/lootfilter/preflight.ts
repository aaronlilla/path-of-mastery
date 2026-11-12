import type { Block, Condition } from './types.js';

/**
 * The warnings the Export screen lists and the status bar counts, worked out from the filter text that would be
 * written. Three of them need more than the syntax checker:
 *  - a custom sound file a rule names that is not in the game folder,
 *  - a rule no item can reach (its own conditions contradict each other),
 *  - a rule hidden by an earlier rule (every item it matches is already decided by a block above it).
 * Only blocks our rules wrote (they carry `pom:rule=`) are judged: NeverSink's own file has many overlapping blocks on purpose.
 */

export interface PreflightIssue {
  id: string;
  kind: 'sound' | 'unreachable' | 'shadowed';
  title: string;
  text: string;
  /** Line of the block this is about. */
  line: number;
  ruleId?: string;
  /** For a missing sound: the file name the rule asks for. */
  file?: string;
}

const RARITIES = ['Normal', 'Magic', 'Rare', 'Unique'];
const NUMERIC = new Set(['ItemLevel', 'DropLevel', 'AreaLevel', 'StackSize', 'Quality', 'LinkedSockets', 'MapTier', 'GemLevel', 'Height', 'Width']);
const BOOLEAN = new Set(['Corrupted', 'Identified', 'Mirrored', 'ElderItem', 'ShaperItem', 'FracturedItem', 'SynthesisedItem', 'AnyEnchantment', 'Replica', 'ScourgedItem', 'Foulborn']);

interface Range {
  lo: number;
  hi: number;
}

const FULL: Range = { lo: -Infinity, hi: Infinity };

/** The values the game can actually give these properties, so `ItemLevel > 100` reads as a rule nothing can match. */
const DOMAIN: Record<string, Range> = { ItemLevel: { lo: 1, hi: 100 }, DropLevel: { lo: 1, hi: 100 }, AreaLevel: { lo: 1, hi: 100 }, LinkedSockets: { lo: 0, hi: 6 } };

/** The numbers a numeric condition lets through, or null when it is a "not equal" that cannot be one range. */
function rangeOf(c: Condition): Range | null {
  const n = Number(c.values[0]);
  if (!Number.isFinite(n)) return null;
  switch (c.op) {
    case '':
    case '=':
    case '==':
      return { lo: n, hi: n };
    case '>':
      return { lo: n + 1e-9, hi: Infinity };
    case '>=':
      return { lo: n, hi: Infinity };
    case '<':
      return { lo: -Infinity, hi: n - 1e-9 };
    case '<=':
      return { lo: -Infinity, hi: n };
    default:
      return null;
  }
}

const meet = (a: Range, b: Range): Range => ({ lo: Math.max(a.lo, b.lo), hi: Math.min(a.hi, b.hi) });
const within = (inner: Range, outer: Range): boolean => inner.lo >= outer.lo && inner.hi <= outer.hi;
const empty = (r: Range): boolean => r.lo > r.hi;

/** The rarities a Rarity condition lets through. */
function raritySet(c: Condition): Set<string> | null {
  const idx = (v: string | undefined): number => RARITIES.indexOf(v ?? '');
  if (c.op === '' || c.op === '=' || c.op === '==') return new Set(c.values.filter((v) => idx(v) >= 0));
  if (c.op === '!' || c.op === '!=') return new Set(RARITIES.filter((r) => !c.values.includes(r)));
  const lim = idx(c.values[0]);
  if (lim < 0) return null;
  const keep = (i: number): boolean => (c.op === '<' ? i < lim : c.op === '<=' ? i <= lim : c.op === '>' ? i > lim : c.op === '>=' ? i >= lim : false);
  return new Set(RARITIES.filter((_r, i) => keep(i)));
}

const meetSets = (a: Set<string> | null, b: Set<string>): Set<string> => (a ? new Set([...a].filter((x) => b.has(x))) : b);
const lower = (xs: string[]): string[] => xs.map((x) => x.toLowerCase());
const isExact = (op: string): boolean => op === '==' || op === '=';
const isNot = (op: string): boolean => op === '!' || op === '!=';

/** True when `inner` (a condition of the later block) lets through only items that `outer` also lets through. */
function condWithin(inner: Condition[], outer: Condition): boolean {
  const same = inner.filter((c) => c.key === outer.key);
  if (!same.length) return false;
  if (NUMERIC.has(outer.key)) {
    const o = rangeOf(outer);
    if (!o) return false;
    let r = FULL;
    let any = false;
    for (const c of same) {
      const x = rangeOf(c);
      if (x) {
        r = meet(r, x);
        any = true;
      }
    }
    return any && within(r, o);
  }
  if (outer.key === 'Rarity') {
    const o = raritySet(outer);
    if (!o) return false;
    let r = null as Set<string> | null;
    for (const c of same) {
      const s = raritySet(c);
      if (!s) continue;
      r = meetSets(r, s);
    }
    return !!r && [...r].every((x) => o.has(x));
  }
  if (BOOLEAN.has(outer.key)) {
    const val = (c: Condition): boolean | null => {
      const want = /^true$/i.test(c.values[0] ?? '');
      if (!/^(true|false)$/i.test(c.values[0] ?? '')) return null;
      return isNot(c.op) ? !want : want;
    };
    const o = val(outer);
    return o !== null && same.some((c) => val(c) === o);
  }
  if (outer.key === 'BaseType' || outer.key === 'Class') {
    if (isNot(outer.op)) return same.some((c) => c.op === outer.op && lower(c.values).every((v) => lower(outer.values).includes(v)) && lower(outer.values).every((v) => lower(c.values).includes(v)));
    const ov = lower(outer.values);
    return same.some((c) => {
      if (isNot(c.op)) return false;
      const cv = lower(c.values);
      if (isExact(outer.op)) return isExact(c.op) && cv.every((v) => ov.includes(v));
      // outer matches by substring: everything the inner condition names must contain one of outer's words
      return cv.every((v) => ov.some((w) => v.includes(w)));
    });
  }
  // Any other condition: only the same line counts.
  const sig = (c: Condition): string => `${c.op}|${c.values.join('\u0001')}`;
  return same.some((c) => sig(c) === sig(outer));
}

/** True when `later` can only match items that `earlier` also matches. */
function covers(earlier: Block, later: Block): boolean {
  return earlier.conditions.every((c) => condWithin(later.conditions, c));
}

/** Why a block's own conditions can never all hold, or null. */
export function contradiction(b: Block): string | null {
  const byKey = new Map<string, Condition[]>();
  for (const c of b.conditions) byKey.set(c.key, [...(byKey.get(c.key) ?? []), c]);
  for (const [key, cs] of byKey) {
    if (NUMERIC.has(key)) {
      let r = DOMAIN[key] ?? FULL;
      let k = 0;
      for (const c of cs) {
        const x = rangeOf(c);
        if (!x) continue;
        r = meet(r, x);
        k++;
      }
      if (k > 1 && empty(r)) return `${key} cannot be ${cs.map((c) => `${c.op || '='} ${c.values[0]}`).join(' and ')} at once`;
      if (k === 1 && empty(r)) return DOMAIN[key] ? `${key} can only be ${DOMAIN[key]!.lo} to ${DOMAIN[key]!.hi} in the game, and this asks for ${cs[0]!.op || '='} ${cs[0]!.values[0]}` : `${key} has no value that fits`;
    } else if (key === 'Rarity') {
      let r = null as Set<string> | null;
      for (const c of cs) {
        const s = raritySet(c);
        if (!s) continue;
        r = meetSets(r, s);
      }
      if (r && r.size === 0) return 'no rarity fits all its Rarity lines';
    } else if ((key === 'BaseType' || key === 'Class') && cs.length > 1) {
      const exact = cs.filter((c) => isExact(c.op));
      if (exact.length > 1) {
        let r = null as Set<string> | null;
        for (const c of exact) {
          const s = new Set(lower(c.values));
          r = meetSets(r, s);
        }
        if (r && r.size === 0) return `no ${key} fits all its ${key} lines`;
      }
    }
  }
  return null;
}

const nameOf = (b: Block): string => {
  const t = b.headerComment.replace(/pom:rule=\S+\s*/, '').replace(/^#\s*/, '').trim();
  return t || `the rule at line ${b.line}`;
};

/** The custom sound files the filter text names, with the line of each. */
export function customSounds(text: string): { file: string; line: number }[] {
  const out: { file: string; line: number }[] = [];
  text.replace(/\r\n?/g, '\n').split('\n').forEach((l, i) => {
    const m = /^\s*CustomAlertSound(?:Optional)?\s+"([^"]+)"/.exec(l);
    if (m) out.push({ file: m[1]!, line: i + 1 });
  });
  return out;
}

export interface PreflightInput {
  blocks: Block[];
  /** The generated text, for the custom sound lines. */
  text: string;
  /** File names that exist in the game folder. A name is only checked when it is a bare file name (no folder part). */
  exists: (file: string) => boolean;
  /** Rule names for the messages, by rule id. */
  ruleName?: (ruleId: string) => string | undefined;
}

export function preflightIssues(input: PreflightInput): PreflightIssue[] {
  const out: PreflightIssue[] = [];
  const { blocks } = input;
  const label = (b: Block): string => (b.ruleId ? input.ruleName?.(b.ruleId) : undefined) ?? nameOf(b);

  // custom sounds: one row per file, naming the first block that uses it
  const seen = new Set<string>();
  for (const s of customSounds(input.text)) {
    if (/[\\/]/.test(s.file) || seen.has(s.file.toLowerCase())) continue;
    seen.add(s.file.toLowerCase());
    if (input.exists(s.file)) continue;
    const owner = [...blocks].reverse().find((b) => b.line <= s.line && b.endLine >= s.line);
    out.push({
      id: `sound:${s.file.toLowerCase()}`,
      kind: 'sound',
      title: 'Custom sound file missing',
      text: `${s.file} is not in the filter folder.${owner ? ` Used by “${label(owner)}”, line ${owner.line}.` : ''}`,
      line: owner?.line ?? s.line,
      ...(owner?.ruleId ? { ruleId: owner.ruleId } : {}),
      file: s.file,
    });
  }

  // rules we wrote: contradictions, then shadowing by any earlier block that decides
  blocks.forEach((b, i) => {
    if (!b.ruleId) return;
    const why = contradiction(b);
    if (why) {
      out.push({ id: `unreachable:${b.line}`, kind: 'unreachable', title: 'A rule no item can reach', text: `“${label(b)}”, line ${b.line}, can never match: ${why}.`, line: b.line, ruleId: b.ruleId });
      return;
    }
    for (let j = 0; j < i; j++) {
      const a = blocks[j]!;
      if (a.continue || (a.ruleId && a.ruleId === b.ruleId) || contradiction(a)) continue;
      if (covers(a, b)) {
        out.push({ id: `shadowed:${b.line}`, kind: 'shadowed', title: 'A rule hidden by an earlier rule', text: `“${label(b)}”, line ${b.line}, never applies. “${label(a)}”, line ${a.line}, catches them first.`, line: b.line, ruleId: b.ruleId });
        break;
      }
    }
  });
  return out;
}
