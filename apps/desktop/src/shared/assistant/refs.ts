/**
 * Numbers the assistant shows come from tool results, never from the model's own text.
 *
 * Every tool result is stored under a ref id (the tool result carries it as `ref`). A model-written layout puts a
 * number on screen by naming a result and a path inside it, as a placeholder: `{{rk3f21:changes[0].after}}`. The
 * app prints what the stored result holds at that path. Any other number in a checked field is not drawn: it is
 * replaced by a dash and the field is marked "not checked". A placeholder that names no stored result, or a path
 * that holds nothing, is treated the same way.
 */

import { compact } from './statLabels.js';

export interface StoredResult {
  tool: string;
  data: unknown;
}
export type ResultStore = Record<string, StoredResult>;

export type CheckedSeg =
  | { t: 'text'; text: string }
  /** A value read from a stored result. */
  | { t: 'num'; text: string; ref: string; path: string; tool: string }
  /** A number the model typed, or a reference that does not resolve: shown as a dash. */
  | { t: 'unchecked'; text: string };

// `{{ref:path}}` as the prompt writes it; a model sometimes writes `{{ref.path}}`, which names the same thing, or copies the
// prompt's word too, `{{ref:rk3f21:path}}` (which once produced a whole answer of dashes), which also names rk3f21.
const PLACEHOLDER = /\{\{\s*(?:ref\s*:\s*(?=[A-Za-z0-9_-]+\s*:))?([A-Za-z0-9_-]+)\s*[:.]\s*([^}]+?)\s*\}\}/g;
// A typed quantity: digits with an optional sign, separators and unit. Digits inside a word (T1, 6L, Act2) are names, and so
// is a gear slot's number ("Rune Twirl in Ring 1" once drew "Ring –").
const TYPED_NUMBER = /(?<![\w.])(?<!\b(?:Ring|Weapon|Flask|Socket) )[+−-]?\d[\d,]*(?:\.\d+)?(?:\s?(?:%|[kKmMbB](?![A-Za-z])|div(?![A-Za-z])|ex(?![A-Za-z])|c(?![A-Za-z])|chaos(?![A-Za-z])))?(?![\w])/g;

/** Reads `a.b[2].c` from a value; undefined when any step is missing. */
export function getPath(data: unknown, path: string): unknown {
  let cur: unknown = data;
  const steps = path.match(/[^.[\]]+/g);
  if (!steps) return undefined;
  for (const s of steps) {
    if (cur === null || typeof cur !== 'object') return undefined;
    // An array entry is read by position (`stats[3]`) or by its id (`stats[FireMaximumHitTaken]`), so a long list cannot be miscounted.
    // (an evaluateEdits option is named by its label: `options[flat life]`, which printed a dash before)
    cur = Array.isArray(cur)
      ? /^\d+$/.test(s)
        ? cur[Number(s)]
        : cur.find((e) => e !== null && typeof e === 'object' && ((e as Record<string, unknown>).id === s || (e as Record<string, unknown>).stat === s)) ??
          cur.find((e) => e !== null && typeof e === 'object' && typeof (e as Record<string, unknown>).label === 'string' && ((e as Record<string, unknown>).label as string).toLowerCase() === s.toLowerCase())
      : (cur as Record<string, unknown>)[s];
  }
  return cur;
}

/**
 * Why a placeholder reads nothing, with what the result does hold at the step that failed (list ids or keys), so the
 * model's second try can point at a real entry or call the tool again for the stat it wanted (retries
 * that were only told "holds no value" printed dashes again).
 */
export function danglingHint(placeholder: string, get: (ref: string) => StoredResult | undefined): string {
  const m = new RegExp(PLACEHOLDER.source).exec(placeholder);
  if (!m) return 'not a placeholder';
  const hit = get(m[1]!);
  if (!hit) return `${m[1]} is not a tool result of this conversation`;
  const steps = m[2]!.match(/[^.[\]]+/g) ?? [];
  const list = (xs: string[]) => xs.slice(0, 30).join(', ') + (xs.length > 30 ? ', ...' : '');
  let cur: unknown = hit.data;
  const done: string[] = [];
  for (const s of steps) {
    const next = getPath(cur, s);
    if (next === undefined || next === null) {
      const at = done.length ? done.join('.') : 'the result';
      if (Array.isArray(cur)) {
        const ids = cur.map((e) => (e && typeof e === 'object' ? (e as Record<string, unknown>).id ?? (e as Record<string, unknown>).stat : undefined)).filter((x): x is string => typeof x === 'string');
        return `${at} has no entry ${s}; it has ${ids.length ? list(ids) : `${cur.length} entries`}. For another stat call the tool again with that stat`;
      }
      return `${at} has no ${s}; it has ${cur && typeof cur === 'object' ? list(Object.keys(cur)) : 'no fields'}`;
    }
    cur = next;
    done.push(s);
  }
  return cur && typeof cur === 'object' ? `it reads a group, not a value; pick one of ${list(Object.keys(cur))}` : 'it reads text too long or empty';
}

const STAT_PHRASE =/\b(fire|cold|lightning|chaos|physical)\s+(res\w*|max(?:imum)?\s+hit)\b[^.;:!?\n]{0,24}$/i;

/**
 * A placeholder that sits right after "chaos resistance" or "fire max hit" must read the entry for that stat. When the
 * path lands on an entry with another stat id (a wrong list position, the wrong damage type, a cap for a value), the
 * number would be true for some other stat, so it is not drawn.
 */
function statMismatch(before: string, store: ResultStore, ref: string, path: string): boolean {
  const m = STAT_PHRASE.exec(before);
  if (!m) return false;
  const steps = path.match(/[^.[\]]+/g);
  if (!steps || steps.length < 2) return false;
  const parent = getPath(store[ref]?.data, steps.slice(0, -1).join('.'));
  const id = parent && typeof parent === 'object' ? (parent as Record<string, unknown>).id : undefined;
  if (typeof id !== 'string') return false;
  const type = m[1]!.toLowerCase();
  const want = /^res/i.test(m[2]!) ? `${type}resist` : `${type}maximumhittaken`;
  // "chaos resistance cap" / "max chaos resistance" reads the cap, ChaosResistMax (the engine's resist plus what is missing to the cap).
  if (want.endsWith('resist') && id.toLowerCase() === `${want}max` && /\b(cap|max(imum)?)\b/i.test(m[0])) return false;
  // "missing chaos resistance of {{...MissingChaosResist...}}" reads the stat the words name
  if (want.endsWith('resist') && id.toLowerCase() === `missing${want}` && /\b(missing|short|below)\b/i.test(before.slice(-70))) return false;
  return id.toLowerCase() !== want;
}

/**
 * A placeholder that sits right after an item's name must read that item. `before` is the text ahead of it. When the
 * path lands on a list entry that has a `name`, and the nearest entry name written before the placeholder (on the same
 * line) is another entry's, the number belongs to a different item than the words say.
 */
function itemMismatch(before: string, store: ResultStore, ref: string, path: string): boolean {
  const steps = path.match(/[^.[\]]+/g);
  if (!steps || steps.length < 3) return false;
  const data = store[ref]?.data;
  const entry = getPath(data, steps.slice(0, -1).join('.'));
  const list = getPath(data, steps.slice(0, -2).join('.'));
  // an item has a name; a stat change row (changes[...]) has a label such as "Effective HP"
  const nameOf = (e: unknown) => (e && typeof e === 'object' ? ((e as Record<string, unknown>).name ?? (e as Record<string, unknown>).label) : undefined);
  const own = nameOf(entry);
  if (typeof own !== 'string' || !Array.isArray(list)) return false;
  const line = before.replace(/\{\{[^}]*\}\}/g, ' ').split('\n').pop()!.toLowerCase();
  let nearest = { at: -1, name: '' };
  for (const e of list) {
    const n = nameOf(e);
    if (typeof n !== 'string' || n.length < 4) continue;
    const at = line.lastIndexOf(n.toLowerCase());
    if (at >= 0 && at + n.length >= nearest.at + nearest.name.length) nearest = { at, name: n };
  }
  return nearest.at >= 0 && nearest.name.toLowerCase() !== own.toLowerCase();
}

/** What is wrong with a finished answer: numbers the model typed itself, and references that point at nothing. */
export interface TextAudit {
  /** Typed quantities outside code, like "13.7k" or "125%". */
  typed: string[];
  /** Placeholders whose result or path holds no value, as written. */
  dangling: string[];
  /** Placeholders that read one item while the words next to them name another. */
  mismatched: string[];
}

/**
 * Reads a finished answer the way the panel will draw it and says whether it breaks the rule that numbers come from
 * tool results. The service sends such an answer back for one more try instead of showing dashes and holes.
 */
export function auditText(text: string, get: (ref: string) => StoredResult | undefined): TextAudit {
  const prose = text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
  const typed: string[] = [];
  const dangling: string[] = [];
  const mismatched: string[] = [];
  let rest = prose;
  PLACEHOLDER.lastIndex = 0;
  let m: RegExpExecArray | null;
  const ph: string[] = [];
  while ((m = PLACEHOLDER.exec(prose))) {
    const hit = get(m[1]!);
    if (!hit || resolveRef({ [m[1]!]: hit }, m[1]!, m[2]!) === null) dangling.push(m[0]);
    else if (itemMismatch(prose.slice(Math.max(0, m.index - 80), m.index), { [m[1]!]: hit }, m[1]!, m[2]!)) mismatched.push(m[0]);
    ph.push(m[0]);
  }
  for (const p of ph) rest = rest.replace(p, ' ');
  // Braces that are not a placeholder the app can read would be drawn as a hole in the sentence: ask for the answer again.
  for (const m2 of rest.matchAll(/\{\{[^}]*\}\}/g)) dangling.push(m2[0]);
  TYPED_NUMBER.lastIndex = 0;
  while ((m = TYPED_NUMBER.exec(rest))) typed.push(m[0].trim());
  return { typed, dangling, mismatched };
}

/**
 * Words the model wrote just before a placeholder whose value starts with those same words go: "Your Full DPS counts Poisonous Concoction
 * {{r:shown}}" drew "Full DPS counts Poisonous Concoction Full DPS counts Poisonous Concoction 9 times".
 */
export function dropEchoBeforeRef(text: string, get: (ref: string) => StoredResult | undefined): string {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(new RegExp(PLACEHOLDER.source, 'g'))) {
    let before = text.slice(last, m.index);
    const hit = get(m[1]!);
    const v = hit ? resolveRef({ [m[1]!]: hit }, m[1]!, m[2]!) : null;
    const words = v ? v.split(/\s+/) : [];
    for (let n = Math.min(words.length - 1, 12); n >= 3; n--) {
      const head = words.slice(0, n).join(' ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`${head}\\s*$`, 'i');
      if (re.test(before)) { before = before.replace(re, ''); break; }
    }
    out += before + m[0];
    last = m.index! + m[0].length;
  }
  return out + text.slice(last);
}

/** The answer without the sentences that fail the audit, or null when nothing is left to show. */
export function dropBadSentences(text: string, get: (ref: string) => StoredResult | undefined): string | null {
  const ok = (s: string) => { const a = auditText(s, get); return !a.typed.length && !a.dangling.length && !a.mismatched.length; };
  const kept = text.split('\n').map((line) => line.split(/(?<=[.!?])\s+/).filter((s) => s.trim() && ok(s)).join(' ') || (line.trim() ? null : '')).filter((l) => l !== null).join('\n').trim();
  return kept || null;
}

/** How a number read from a result is written. Strings (the tools' `shown` fields) are used as they are. */
export function formatLeaf(v: unknown): string | null {
  if (typeof v === 'string') return v.length > 200 ? null : v;
  if (typeof v === 'number' && Number.isFinite(v)) {
    // a raw engine number (1431444.81, 17267.75) is written the way the sidebar writes it: no cents on thousands
    if (Math.abs(v) >= 10000) return compact(v);
    const r = Math.round(v * 100) / 100;
    return Math.abs(r) >= 1000 ? Math.round(r).toLocaleString('en-US') : String(r);
  }
  return null;
}

/** The value a reference points to as text, or null when it points at nothing usable. */
export function resolveRef(store: ResultStore, ref: string, path: string): string | null {
  const hit = store[ref];
  if (!hit) return null;
  const v = getPath(hit.data, path);
  // a finding's `line` or `shown` is a whole sentence the app wrote to be quoted as is, with its numbers and fix: longer than a plain value
  if (typeof v === 'string' && hit.tool === 'heldCard' && path === 'line' && v.length <= 1000) return v;
  if (typeof v === 'string' && /(findings\[[^\]]+\]\.(line|shown)|^treeNotes\[\d+\]|^checkNotes\[\d+\]|^notes\[\d+\]|^free\.shown|^spend\.items\[\d+\]\.(shown|costs))$/.test(path) && v.length <= 1000) return v;
  return formatLeaf(v);
}

/**
 * Splits a model-written text into what to draw: plain words, values read from stored results, and "not checked"
 * dashes where the model typed a number itself or pointed at nothing.
 */
export function checkedText(text: string, store: ResultStore): CheckedSeg[] {
  const out: CheckedSeg[] = [];
  const pushText = (s: string) => {
    if (!s) return;
    let last = 0;
    TYPED_NUMBER.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TYPED_NUMBER.exec(s))) {
      if (m.index > last) out.push({ t: 'text', text: s.slice(last, m.index) });
      out.push({ t: 'unchecked', text: '–' });
      last = m.index + m[0].length;
    }
    if (last < s.length) out.push({ t: 'text', text: s.slice(last) });
  };
  let last = 0;
  PLACEHOLDER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PLACEHOLDER.exec(text))) {
    pushText(text.slice(last, m.index));
    const ref = m[1]!;
    const path = m[2]!;
    let v = resolveRef(store, ref, path);
    if (v !== null && (statMismatch(text.slice(Math.max(0, last, m.index - 80), m.index), store, ref, path) || itemMismatch(text.slice(Math.max(0, m.index - 80), m.index), store, ref, path))) {
      // the stat or item named in the words is not the one the path reads: it is drawn as a dash below
      v = null;
    }
    // A reference that points at nothing is drawn as a dash, never as a hole in the sentence and never as a raw placeholder or a made-up value.
    // a quoted line with no full stop that runs straight into the next sentence or quote gets one (for example "(poe.ninja, level 4) Empower in place")
    if (v !== null && v.length >= 20 && / /.test(v) && !/[.!?:;]$/.test(v) && /^\s+(?:[A-Z]|\{\{)/.test(text.slice(PLACEHOLDER.lastIndex))) v += '.';
    // a line that already begins with its own label ("Not a legal roll: ...") is not given the same label twice
    if (v !== null) {
      const prev = out[out.length - 1];
      if (prev?.t === 'text') {
        const mm = /([A-Z][A-Za-z' ]{2,40}):[ \t]*$/.exec(prev.text);
        if (mm && v.toLowerCase().startsWith(`${mm[1]!.toLowerCase()}:`)) prev.text = prev.text.slice(0, mm.index);
      }
    }
    if (v !== null) out.push({ t: 'num', text: v, ref, path, tool: store[ref]!.tool });
    else out.push({ t: 'unchecked', text: '–' });
    last = PLACEHOLDER.lastIndex;
  }
  pushText(text.slice(last));
  return out;
}

/**
 * The player never sees a dash where a number should be: a sentence (or list line) whose number cannot be read from a tool
 * result is left out. When every sentence is like that, the text is kept as it is (it then draws its dashes and "not checked").
 */
export function dropUnresolved(text: string, store: ResultStore): string {
  const keep = text
    .split(/(\n+|(?<=[.!?])\s+)/)
    .reduce<string[]>((out, part, i, all) => {
      if (i % 2) return out; // separators are re-added below
      const sep = all[i + 1] ?? '';
      if (hasUnchecked(checkedText(part, store))) {
        // a label left alone by the line that went ("Mana:") never shows as an empty header
        const last = out[out.length - 1];
        if (last !== undefined && /^[A-Za-z' ,]{1,40}:\s*$/.test(last)) out.pop();
        return out;
      }
      out.push(part + sep);
      return out;
    }, []);
  if (keep.length) return keep.join('');
  // every sentence is unresolved: one that points at nothing still never shows (a markdown fragment is often one sentence)
  return [...text.matchAll(new RegExp(PLACEHOLDER.source, 'g'))].some((m) => resolveRef(store, m[1]!, m[2]!) === null) ? '' : text;
}

/** Fills placeholders from stored results and leaves every other character alone (for code blocks and inline code). */
export function resolveOnly(text: string, store: ResultStore): string {
  return text.replace(PLACEHOLDER, (_m, ref: string, path: string) => resolveRef(store, ref, path) ?? '');
}

/** While a reply streams, a placeholder may be cut off mid-way ("{{rk3"): hold that tail back until it is complete. */
export function holdBackPartial(text: string): string {
  return text.replace(/\{\{[^}]*$|\{$/, '');
}

export function hasUnchecked(segs: CheckedSeg[]): boolean {
  return segs.some((s) => s.t === 'unchecked');
}

/** Plain string of the checked text (for tests and copy buttons). */
export function checkedPlain(text: string, store: ResultStore): string {
  return checkedText(text, store)
    .map((s) => s.text)
    .join('');
}

/** Keeps the store small: newest entries last, oldest dropped. */
export function trimStore(store: ResultStore, max = 400): ResultStore {
  const keys = Object.keys(store);
  if (keys.length <= max) return store;
  const out: ResultStore = {};
  for (const k of keys.slice(keys.length - max)) out[k] = store[k]!;
  return out;
}
