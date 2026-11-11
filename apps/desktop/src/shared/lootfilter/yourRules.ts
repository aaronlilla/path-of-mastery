import type { Block, Rule } from './types.js';
import { checkCondition } from './evaluate.js';
import { findShadows } from './shadow.js';
import { MAX_FILTER_BYTES, type Issue } from './syntax.js';
import type { Warning } from './warnings.js';

/**
 * The "Your rules" side of the Advanced screen: the player's own blocks pulled out of the generated file, with the
 * line numbers mapped, and the notes that go with them (syntax problems, what each block matches, blocks an earlier
 * block hides). Pure functions so the numbers can be tested against real files.
 */

export interface YourRulesView {
  /** The text shown: a two line title, a blank line, then the player's blocks as written in the file. */
  lines: string[];
  /** First and last line (1-based) of the player's blocks in the generated file, or null when none were written. */
  span: { start: number; end: number } | null;
  /** Number of title lines above the blocks (including the blank one). */
  head: number;
  /** Line in `lines` for a line of the generated file, or null when it is not one of the player's blocks. */
  fromFile(line: number): number | null;
  /** Line of the generated file for a line in `lines`. */
  toFile(line: number): number | null;
}

/** Cuts the player's blocks out of the generated text. `baseStartLine` is where NeverSink's text starts. */
export function yourRulesView(text: string, baseStartLine: number, title: string, buildName?: string): YourRulesView {
  const all = text.split('\n');
  const mark = all.findIndex((l) => l.startsWith('# YOUR RULES.'));
  let span: { start: number; end: number } | null = null;
  let body: string[] = [];
  if (mark >= 0) {
    const start = mark + 3 + 1; // banner rule, text, banner rule, blank line
    const end = baseStartLine - 5; // the 4 line NeverSink banner sits just above its text
    const raw = all.slice(start - 1, end);
    if (raw.length && !raw[0]!.startsWith('# (no rules write blocks)')) {
      let last = raw.length;
      while (last > 0 && raw[last - 1]!.trim() === '') last--;
      if (last > 0) {
        span = { start, end: start + last - 1 };
        body = raw.slice(0, last).map((l) => l.replace(/pom:rule=\S+\s*/, ''));
      }
    }
  }
  const head = [`# Your rules · ${title}`, ...(buildName ? [`# Build: ${buildName}`] : []), ''];
  return {
    lines: [...head, ...body],
    span,
    head: head.length,
    fromFile: (n) => (span && n >= span.start && n <= span.end ? n - span.start + 1 + head.length : null),
    toFile: (n) => (span && n > head.length && n - head.length <= span.end - span.start + 1 ? n - head.length - 1 + span.start : null),
  };
}

export type DiagKind = 'error' | 'warning' | 'info' | 'ok';

export interface Diag {
  /** Line in the text that is on screen. */
  line: number;
  kind: DiagKind;
  text: string;
  /** How many warnings this one line stands for (a note about warnings outside the part on screen). Default 1. */
  count?: number;
}

export interface MatchItem {
  name: string;
  class?: string;
}

/** How many known item types a block's BaseType and Class lines let through. Other conditions are not counted. */
export function matchCount(b: Pick<Block, 'conditions'>, universe: MatchItem[]): number | null {
  const cs = b.conditions.filter((c) => c.key === 'BaseType' || c.key === 'Class');
  if (!cs.length) return null;
  // Exact names count even when the app has no table for them (most gems): each listed name is one item type.
  const exact = cs.find((c) => c.key === 'BaseType' && c.op === '==');
  if (exact) {
    const byName = new Map(universe.map((u) => [u.name, u]));
    const classes = cs.filter((c) => c.key === 'Class');
    let k = 0;
    for (const name of exact.values) {
      const known = byName.get(name);
      if (!known || !known.class || classes.every((c) => checkCondition(c, { name, class: known.class }) !== false)) k++;
    }
    return k;
  }
  let n = 0;
  for (const it of universe) {
    const props = { name: it.name, ...(it.class ? { class: it.class } : {}) };
    if (cs.every((c) => checkCondition(c, props) !== false)) n++;
  }
  return n;
}

export interface DiagInput {
  /** Blocks of the generated file, in order. */
  blocks: Block[];
  /** Syntax problems of the whole generated file. */
  issues: Issue[];
  rules: Rule[];
  baseStartLine: number;
  bytes: number;
  universe: MatchItem[];
  /** Maps a line of the generated file onto the line shown. Null hides the note. */
  lineOf: (fileLine: number) => number | null;
  /** For the whole-file view: also list syntax problems found in NeverSink's text. */
  scope: 'rules' | 'file';
  /**
   * Every warning of the filter, from allWarnings. When given, these replace the syntax warnings and the shadow
   * checks done here, so the list shows exactly the warnings the Export screen and the status bar count.
   */
  warnings?: Warning[];
}

const NOTE_LIMIT = 5;
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;

/** The list under the code: real syntax problems, blocks hidden by an earlier block, what each block matches, and the file size check. */
export function diagnose(inp: DiagInput): Diag[] {
  const out: Diag[] = [];
  let outside = 0;
  for (const i of inp.issues) {
    if (inp.warnings && i.severity !== 'error') continue;
    const ln = inp.lineOf(i.line);
    if (ln === null) {
      outside++;
      continue;
    }
    out.push({ line: ln, kind: i.severity, text: i.message });
  }
  if (inp.warnings) {
    for (const w of inp.warnings) {
      const ln = w.line === undefined ? 1 : inp.lineOf(w.line);
      if (ln === null) {
        outside++;
        continue;
      }
      out.push({ line: ln, kind: 'warning', text: w.kind === 'syntax' ? w.text : `${w.title}: ${w.text}` });
    }
  }
  if (outside > 0 && inp.scope === 'rules') out.push({ line: 1, kind: 'warning', count: outside, text: `${plural(outside, 'problem')} in NeverSink's part of the file. Open Full filter to see ${outside === 1 ? 'it' : 'them'}.` });
  const user = inp.blocks.filter((b) => b.line < inp.baseStartLine && b.ruleId);
  const ruleOf = new Map(inp.rules.map((r) => [r.id, r]));
  const lineOr = (n: number): number => inp.lineOf(n) ?? n;
  const classes = new Map(inp.universe.map((u) => [u.name, u.class]));
  for (const f of inp.warnings ? [] : findShadows(user, { classOf: (n) => classes.get(n) })) {
    const ln = inp.lineOf(f.block.line);
    if (ln === null) continue;
    const at = lineOr(f.by.line);
    out.push({
      line: ln,
      kind: 'warning',
      text: f.kind === 'hidden' ? `Nothing reaches this ${f.block.kind}: the ${f.by.kind} at line ${at} is above it and catches every item it would.` : `This ${f.block.kind} skips ${f.takes}, because the ${f.by.kind} at line ${at} is above it.`,
    });
  }
  const notes: Diag[] = [];
  for (const b of user) {
    const ln = inp.lineOf(b.line);
    if (ln === null) continue;
    const n = matchCount(b, inp.universe);
    if (n === null) continue;
    const r = b.ruleId ? ruleOf.get(b.ruleId) : undefined;
    notes.push({ line: ln, kind: 'info', text: n === 0 ? 'Matches no item types the app knows.' : `Matches ${plural(n, 'item type')}${r?.source === 'build' ? ' from your build' : ''}.` });
  }
  // A long list of rules would bury the warnings: show the first few and count the rest.
  out.push(...notes.slice(0, NOTE_LIMIT));
  if (notes.length > NOTE_LIMIT) out.push({ line: notes[NOTE_LIMIT]!.line, kind: 'info', text: `${plural(notes.length - NOTE_LIMIT, 'more block')} below. Each says how many item types it matches in the outline.` });
  const errors = out.filter((d) => d.kind === 'error').length;
  const kb = Math.round(inp.bytes / 1024);
  const rank: Record<DiagKind, number> = { error: 0, warning: 1, info: 2, ok: 3 };
  out.sort((a, b) => rank[a.kind] - rank[b.kind] || a.line - b.line);
  if (errors === 0) out.push({ line: 1, kind: 'ok', text: inp.bytes > MAX_FILTER_BYTES ? 'No syntax errors.' : `No errors. The file fits the 1 MB limit (${kb.toLocaleString()} KB).` });
  return out;
}

export function diagSummary(d: Diag[]): string {
  const e = d.filter((x) => x.kind === 'error').reduce((n, x) => n + (x.count ?? 1), 0);
  const w = d.filter((x) => x.kind === 'warning').reduce((n, x) => n + (x.count ?? 1), 0);
  return `${plural(e, 'error')} · ${plural(w, 'warning')}`;
}
