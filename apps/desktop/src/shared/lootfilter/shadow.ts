import type { Block, Condition } from './types.js';

/**
 * Which block sits above which. In the game the first matching block decides (unless it says Continue), so a block is
 * "hidden" when every item it could match is already caught by an earlier block, and "partly skipped" when an earlier
 * block of the opposite kind (Show against Hide) catches some of its items. Both are found without any item: from
 * the conditions alone. A condition the checker does not understand counts as "not implied", so it never reports a
 * block hidden by guesswork.
 */

export interface ShadowFinding {
  /** The block that loses items. */
  block: Block;
  /** The earlier block that takes them. */
  by: Block;
  /** hidden: nothing reaches `block`. partial: some items are taken by `by`. */
  kind: 'hidden' | 'partial';
  /** Plain words for what `by` takes, like "items with 4 or more links". Empty for hidden. */
  takes: string;
}

const NUMERIC = new Set(['ItemLevel', 'DropLevel', 'AreaLevel', 'StackSize', 'Quality', 'LinkedSockets', 'MapTier', 'GemLevel', 'Height', 'Width']);
const RARITY: Record<string, number> = { Normal: 0, Magic: 1, Rare: 2, Unique: 3 };
const EQ = new Set(['', '=', '==']);
const NE = new Set(['!', '!=']);

interface Range {
  lo: number;
  hi: number;
}

function rangeOf(c: Condition): Range | null {
  const n = Number(c.values[0]);
  if (!Number.isFinite(n)) return null;
  if (EQ.has(c.op)) return { lo: n, hi: n };
  if (c.op === '>') return { lo: n + 1, hi: Infinity };
  if (c.op === '>=') return { lo: n, hi: Infinity };
  if (c.op === '<') return { lo: -Infinity, hi: n - 1 };
  if (c.op === '<=') return { lo: -Infinity, hi: n };
  return null;
}

function intersect(a: Range, b: Range): Range {
  return { lo: Math.max(a.lo, b.lo), hi: Math.min(a.hi, b.hi) };
}

function rarityOf(c: Condition): Set<number> | null {
  const all = [0, 1, 2, 3];
  if (EQ.has(c.op)) {
    const s = c.values.map((v) => RARITY[v]).filter((x): x is number => x !== undefined);
    return s.length === c.values.length ? new Set(s) : null;
  }
  if (NE.has(c.op)) {
    const s = c.values.map((v) => RARITY[v]).filter((x): x is number => x !== undefined);
    return s.length === c.values.length ? new Set(all.filter((x) => !s.includes(x))) : null;
  }
  const lim = RARITY[c.values[0] ?? ''];
  if (lim === undefined) return null;
  const f = c.op === '<' ? (x: number) => x < lim : c.op === '<=' ? (x: number) => x <= lim : c.op === '>' ? (x: number) => x > lim : c.op === '>=' ? (x: number) => x >= lim : null;
  return f ? new Set(all.filter(f)) : null;
}

const lower = (s: string): string => s.toLowerCase();

/** Does every item matched by the string condition `b` also match `a` (same key)? */
function stringImplies(b: Condition, a: Condition): boolean {
  if (NE.has(a.op) || NE.has(b.op)) return sameCondition(a, b);
  const aExact = a.op === '==';
  const bExact = b.op === '==';
  return b.values.every((v) => {
    if (bExact) return a.values.some((x) => (aExact ? lower(x) === lower(v) : lower(v).includes(lower(x))));
    if (aExact) return false;
    return a.values.some((x) => lower(v).includes(lower(x)));
  });
}

function sameCondition(a: Condition, b: Condition): boolean {
  return a.key === b.key && a.op === b.op && [...a.values].sort().join('\u0000') === [...b.values].sort().join('\u0000');
}

/** Whether the conjunction `bs` (all conditions of one block) guarantees condition `a`. */
function impliedBy(bs: Condition[], a: Condition, classOf?: (name: string) => string | undefined): boolean {
  const same = bs.filter((c) => c.key === a.key);
  if (!same.length && classOf && a.key === 'Class' && a.op === '==') {
    // The block names exact base types and each one is known to be in a class `a` lists.
    const names = bs.filter((c) => c.key === 'BaseType' && c.op === '==').flatMap((c) => c.values);
    const classes = new Set(a.values.map(lower));
    return names.length > 0 && names.every((n) => {
      const k = classOf(n);
      return k !== undefined && classes.has(lower(k));
    });
  }
  if (!same.length) return false;
  if (same.some((c) => sameCondition(c, a))) return true;
  if (NUMERIC.has(a.key)) {
    const ar = rangeOf(a);
    if (!ar) return false;
    let r: Range = { lo: -Infinity, hi: Infinity };
    let any = false;
    for (const c of same) {
      const cr = rangeOf(c);
      if (cr) {
        r = intersect(r, cr);
        any = true;
      }
    }
    return any && r.lo >= ar.lo && r.hi <= ar.hi;
  }
  if (a.key === 'Rarity') {
    const as = rarityOf(a);
    if (!as) return false;
    let cur = null as Set<number> | null;
    for (const c of same) {
      const s = rarityOf(c);
      if (!s) continue;
      cur = cur ? new Set([...cur].filter((x) => s.has(x))) : s;
    }
    return !!cur && [...cur].every((x) => as.has(x));
  }
  if (a.key === 'BaseType' || a.key === 'Class') return same.some((c) => stringImplies(c, a));
  return false;
}

export interface ShadowOptions {
  /** The item class of a base type, when known. With it, "Scroll of Wisdom" and "Class == Body Armours" are told apart. */
  classOf?: (name: string) => string | undefined;
}

/** Exact base types against exact classes: disjoint when every name has a known class that is not one of the listed ones. */
function disjointByClass(bt: Condition[], cl: Condition[], classOf: (name: string) => string | undefined): boolean {
  const exactBt = bt.filter((c) => c.key === 'BaseType' && c.op === '==');
  const exactCl = cl.filter((c) => c.key === 'Class' && c.op === '==');
  if (!exactBt.length || !exactCl.length) return false;
  const classes = new Set(exactCl.flatMap((c) => c.values.map(lower)));
  const names = exactBt.flatMap((c) => c.values);
  return names.every((n) => {
    const k = classOf(n);
    return k !== undefined && !classes.has(lower(k));
  });
}

/** Could one item match both blocks? False only when a pair of conditions on the same key clearly cannot hold together. */
function canOverlap(x: Condition[], y: Condition[], classOf?: (name: string) => string | undefined): boolean {
  if (classOf && (disjointByClass(x, y, classOf) || disjointByClass(y, x, classOf))) return false;
  for (const key of new Set(x.map((c) => c.key))) {
    const xs = x.filter((c) => c.key === key);
    const ys = y.filter((c) => c.key === key);
    if (!ys.length) continue;
    if (NUMERIC.has(key)) {
      let r: Range = { lo: -Infinity, hi: Infinity };
      for (const c of [...xs, ...ys]) {
        const cr = rangeOf(c);
        if (cr) r = intersect(r, cr);
      }
      if (r.lo > r.hi) return false;
    } else if (key === 'Rarity') {
      let cur = null as Set<number> | null;
      for (const c of [...xs, ...ys]) {
        const s = rarityOf(c);
        if (!s) continue;
        cur = cur ? new Set([...cur].filter((v) => s.has(v))) : s;
      }
      if (cur && cur.size === 0) return false;
    } else if (key === 'BaseType' || key === 'Class') {
      const xe = xs.filter((c) => c.op === '==');
      const ye = ys.filter((c) => c.op === '==');
      if (xe.length && ye.length) {
        const xv = new Set(xe.flatMap((c) => c.values.map(lower)));
        if (!ye.some((c) => c.values.some((v) => xv.has(lower(v))))) return false;
      }
    }
  }
  return true;
}

const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;
const joinOr = (l: string[]): string => (l.length <= 1 ? l.join('') : `${l.slice(0, -1).join(', ')} or ${l[l.length - 1]}`);

/** One condition as words that follow "items", like "with 4 or more links". */
export function conditionWords(c: Condition): string {
  const n = Number(c.values[0]);
  const num = Number.isFinite(n);
  switch (c.key) {
    case 'LinkedSockets':
      if (num && c.op === '>=') return `with ${n} or more links`;
      if (num && c.op === '>') return `with ${n + 1} or more links`;
      if (num && EQ.has(c.op)) return `with exactly ${plural(n, 'link')}`;
      break;
    case 'Sockets':
      return `with sockets ${c.values.join(' ')}`;
    case 'Rarity':
      if (EQ.has(c.op)) return `that are ${joinOr(c.values.map(lower))}`;
      if (c.op === '<=' || c.op === '<') return `that are ${lower(c.values[0] ?? '')} or lower`;
      if (c.op === '>=' || c.op === '>') return `that are ${lower(c.values[0] ?? '')} or higher`;
      break;
    case 'ItemLevel':
      if (num && c.op === '>=') return `of item level ${n} or higher`;
      if (num && c.op === '<=') return `of item level ${n} or lower`;
      if (num && EQ.has(c.op)) return `of item level ${n}`;
      break;
    case 'AreaLevel':
      if (num && c.op === '>=') return `dropped in area level ${n} or higher`;
      if (num && c.op === '<=') return `dropped in area level ${n} or lower`;
      break;
    case 'Quality':
      if (num && c.op === '>=') return `with quality ${n} or more`;
      break;
    case 'StackSize':
      if (num && c.op === '>=') return `in stacks of ${n} or more`;
      if (num && c.op === '<=') return `in stacks of ${n} or fewer`;
      break;
    case 'BaseType':
      return `called ${c.values.length > 2 ? `${c.values.slice(0, 2).join(', ')} and ${c.values.length - 2} more` : joinOr(c.values)}`;
    case 'Class':
      return `of class ${joinOr(c.values)}`;
    case 'Corrupted':
      return /^true$/i.test(c.values[0] ?? '') ? 'that are corrupted' : 'that are not corrupted';
    case 'Identified':
      return /^true$/i.test(c.values[0] ?? '') ? 'that are identified' : 'that are not identified';
  }
  return `where ${c.key} ${c.op} ${c.values.join(' ')}`.replace(/\s+/g, ' ').trim();
}

function wordsOf(cs: Condition[]): string {
  const named = cs.some((c) => c.key === 'BaseType' && c.op === '==');
  return cs.filter((c) => !(named && c.key === 'Class')).map(conditionWords).join(' and ');
}

/** True when every item that matches `b` also matches `a`, so `a` takes it first when `a` sits above `b`. */
export function blockImplies(b: Pick<Block, 'conditions'>, a: Pick<Block, 'conditions'>, classOf?: (name: string) => string | undefined): boolean {
  return a.conditions.every((c) => impliedBy(b.conditions, c, classOf));
}

/**
 * Finds blocks that an earlier block hides or partly takes over. `blocks` are in file order, so earlier means higher
 * priority. Blocks written by the same rule never count against each other. A block that says Continue never takes
 * an item for good, so it hides nothing below it.
 */
export function findShadows(blocks: Block[], opts: ShadowOptions = {}): ShadowFinding[] {
  const out: ShadowFinding[] = [];
  for (let j = 1; j < blocks.length; j++) {
    const b = blocks[j]!;
    let done = false;
    for (let i = 0; i < j && !done; i++) {
      const a = blocks[i]!;
      if (a.continue) continue;
      if (a.ruleId && a.ruleId === b.ruleId) continue;
      if (blockImplies(b, a, opts.classOf)) {
        out.push({ block: b, by: a, kind: 'hidden', takes: '' });
        done = true;
      }
    }
    if (done) continue;
    let found = 0;
    for (let i = 0; i < j && found < 3; i++) {
      const a = blocks[i]!;
      if (a.continue || a.kind === b.kind || (a.ruleId && a.ruleId === b.ruleId)) continue;
      if (!canOverlap(a.conditions, b.conditions, opts.classOf)) continue;
      const rest = a.conditions.filter((c) => !impliedBy(b.conditions, c, opts.classOf));
      if (!rest.length) continue;
      out.push({ block: b, by: a, kind: 'partial', takes: `items ${wordsOf(rest)}` });
      found++;
    }
  }
  return out;
}
