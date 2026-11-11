// The tree search, as upstream's PassiveTreeView does it: the text is split into words (a "quoted phrase" is one
// word), every word is a Lua pattern, `(a|b)` and `a|b` mean either, and a node matches when every word matches its name,
// one of its stat lines or its type. A search starting with `oil:` matches anoint recipes instead.

/** What one node offers to a search. */
export interface SearchTarget {
  name: string;
  lines: string[];
  /** Normal, Notable, Keystone, Mastery, Socket... */
  type: string;
  /** Anoint recipe oils, e.g. ["GoldenOil", "TealOil"]. */
  recipe?: string[];
}

/** The search words: quoted phrases first, then the rest split on white space (upstream's prepSearch). */
export function prepSearch(search: string): string[] {
  let s = search.toLowerCase();
  const words: string[] = [];
  for (const m of s.matchAll(/"([^"]*)"/g)) words.push(m[1]!);
  s = s.replace(/"[^"]*"/g, '');
  for (const w of s.split(/\s+/)) if (w) words.push(w);
  return words;
}

// ---- Lua patterns -> RegExp ----------------------------------------------------------------------------------------------

const CLASSES: Record<string, string> = {
  a: 'A-Za-z',
  d: '0-9',
  l: 'a-z',
  u: 'A-Z',
  w: 'A-Za-z0-9',
  x: 'A-Fa-f0-9',
  s: ' \\t\\n\\r\\f\\v',
  p: '!-\\/:-@\\[-`{-~',
  c: '\\x00-\\x1f\\x7f',
};

const esc = (c: string) => c.replace(/[\\^$.*+?()[\]{}|\-/]/g, '\\$&');

/** One Lua pattern as a RegExp, or null when Lua would call it malformed (upstream then counts the node as no match). */
export function luaPatternToRegExp(pat: string): RegExp | null {
  let out = '';
  let i = 0;
  const n = pat.length;
  let anchored = false;
  if (pat[0] === '^') {
    anchored = true;
    i = 1;
  }
  let depth = 0;
  const item = (): string | null => {
    // One single-character class: a char, `.`, `%x` or a `[set]`.
    const c = pat[i]!;
    if (c === '%') {
      const d = pat[i + 1];
      if (d === undefined) return null;
      i += 2;
      if (d === 'b' || d === 'f') return null;
      if (/[0-9]/.test(d)) return null;
      const lower = d.toLowerCase();
      const cls = CLASSES[lower];
      if (cls && /[a-zA-Z]/.test(d)) return d === lower ? `[${cls}]` : `[^${cls}]`;
      return esc(d);
    }
    if (c === '[') {
      let j = i + 1;
      let neg = false;
      if (pat[j] === '^') {
        neg = true;
        j++;
      }
      let set = '';
      let first = true;
      for (;;) {
        if (j >= n) return null;
        const ch = pat[j]!;
        if (ch === ']' && !first) break;
        first = false;
        if (ch === '%') {
          const d = pat[j + 1];
          if (d === undefined) return null;
          const lower = d.toLowerCase();
          const cls = CLASSES[lower];
          if (cls && /[a-zA-Z]/.test(d)) set += d === lower ? cls : '';
          else set += esc(d);
          j += 2;
        } else if (pat[j + 1] === '-' && pat[j + 2] !== undefined && pat[j + 2] !== ']') {
          set += `${esc(ch)}-${esc(pat[j + 2]!)}`;
          j += 3;
        } else {
          set += esc(ch);
          j++;
        }
      }
      i = j + 1;
      return `[${neg ? '^' : ''}${set}]`;
    }
    i++;
    if (c === '.') return '[\\s\\S]';
    return esc(c);
  };
  while (i < n) {
    const c = pat[i]!;
    if (c === '(') {
      depth++;
      out += '(';
      i++;
      continue;
    }
    if (c === ')') {
      if (depth === 0) return null;
      depth--;
      out += ')';
      i++;
      continue;
    }
    if (c === '$' && i === n - 1) {
      out += '$';
      i++;
      continue;
    }
    // A quantifier with nothing before it is an ordinary character.
    const it = item();
    if (it === null) return null;
    const q = pat[i];
    if (q === '*' || q === '+' || q === '?') {
      out += it + q;
      i++;
    } else if (q === '-') {
      out += it + '*?';
      i++;
    } else out += it;
  }
  if (depth !== 0) return null;
  try {
    return new RegExp((anchored ? '^' : '') + out);
  } catch {
    return null;
  }
}

/** Upstream's `(a|b)` expansion: every alternative of every group, as separate plain patterns. */
export function orPatterns(pattern: string): string[] {
  const groups: Array<{ open: number; close: number; alts: string[] }> = [];
  // `%b()` groups at the top level
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] === '(') {
      let depth = 0;
      let j = i;
      for (; j < pattern.length; j++) {
        if (pattern[j] === '(') depth++;
        else if (pattern[j] === ')' && --depth === 0) break;
      }
      if (j >= pattern.length) break;
      groups.push({ open: i, close: j, alts: orPatterns(pattern.slice(i + 1, j)) });
      i = j + 1;
    } else i++;
  }
  let generated = [pattern.slice(0, groups[0] ? groups[0].open : pattern.length)];
  groups.forEach((g, k) => {
    const next = pattern.slice(g.close + 1, groups[k + 1] ? groups[k + 1]!.open : pattern.length);
    const temp: string[] = [];
    for (const base of generated) for (const alt of g.alts) temp.push(base + alt + next);
    generated = temp;
  });
  const out = new Set<string>();
  for (const g of generated) for (const part of g.split('|')) if (part) out.add(part);
  return [...out];
}

const cache = new Map<string, RegExp[] | null>();
/** Does `hay` match the word as upstream's matchOrPattern does? A malformed pattern throws, like upstream's error. */
export function matchOrPattern(hay: string, word: string): boolean {
  let regs = cache.get(word);
  if (regs === undefined) {
    const list: RegExp[] = [];
    let bad = false;
    for (const p of orPatterns(word)) {
      const r = luaPatternToRegExp(p);
      if (!r) bad = true;
      else list.push(r);
    }
    regs = bad ? null : list;
    if (cache.size > 500) cache.clear();
    cache.set(word, regs);
  }
  if (!regs) throw new Error('malformed pattern');
  return regs.some((r) => r.test(hay));
}

const oilName = (o: string) => o.replace(/Oil/g, '').toLowerCase();

/** A search ready to run on many nodes. Returns null for an empty search. */
export function compileSearch(search: string): ((t: SearchTarget) => boolean) | null {
  const words = prepSearch(search);
  if (!words.length) return null;
  const oil = words[0] === 'oil:';
  return (t) => {
    let need = words.slice();
    const run = (hay: string) => {
      need = need.filter((w) => !matchOrPattern(hay, w));
    };
    try {
      if (oil) {
        if (!t.recipe) return false;
        for (const r of t.recipe) {
          run(oilName(r));
          if (need.length === 1 && need[0] === 'oil:') return true;
        }
        return false;
      }
      run(t.name.toLowerCase());
      if (!need.length) return true;
      for (const line of t.lines) {
        run(line.toLowerCase());
        if (!need.length) return true;
      }
      run(t.type.toLowerCase());
      return !need.length;
    } catch {
      return false;
    }
  };
}
