import type { Block } from './types.js';
import type { Issue } from './syntax.js';
import { findShadows } from './shadow.js';
import { preflightIssues, type PreflightIssue } from './preflight.js';

/**
 * Every warning the app knows about, in one list: the Export checklist, the status bar and the Advanced diagnostics
 * all read it, so they always show the same number. Kinds, in the order the Export screen groups them:
 *  - size: the file is over 90% of the game's 1 MB limit;
 *  - syntax: a problem the syntax checker found that does not stop the game from loading the file;
 *  - sound: a custom sound file a rule names that is not in the game folder;
 *  - unreachable: a rule no item can reach (its own conditions contradict each other);
 *  - shadowed: a rule hidden by an earlier rule (every item it matches is decided above it);
 *  - partial: a rule that skips some items because an earlier rule takes them first;
 *  - review: a rule the generator could not place;
 *  - idle: an enabled rule that wrote no block.
 */
export type WarningKind = 'size' | 'syntax' | 'sound' | 'unreachable' | 'shadowed' | 'partial' | 'review' | 'idle';

export const WARNING_ORDER: WarningKind[] = ['size', 'syntax', 'sound', 'unreachable', 'shadowed', 'partial', 'review', 'idle'];

export interface Warning {
  id: string;
  kind: WarningKind;
  title: string;
  text: string;
  /** Line of the block this is about in the written file. */
  line?: number;
  ruleId?: string;
  /** For a missing sound: the file name the rule asks for. */
  file?: string;
}

export interface WarningInput {
  blocks: Block[];
  text: string;
  bytes: number;
  maxBytes: number;
  /** File names that exist in the game folder. */
  exists: (file: string) => boolean;
  ruleName?: (ruleId: string) => string | undefined;
  /** Item class by name, so two rules on different classes are not mistaken for overlapping ones. */
  classOf?: (name: string) => string | undefined;
  /** Syntax problems of the written file (only the warnings are used here). */
  issues: Issue[];
  needsReview: { ruleId: string; message: string }[];
  /** Enabled rules that wrote nothing. */
  idle: { id: string; name?: string }[];
}

const nameOf = (b: Block, ruleName?: (id: string) => string | undefined): string => {
  const own = b.ruleId ? ruleName?.(b.ruleId) : undefined;
  if (own) return own;
  const t = b.headerComment.replace(/pom:rule=\S+\s*/, '').replace(/^#\s*/, '').trim();
  return t || `the rule at line ${b.line}`;
};

export function allWarnings(i: WarningInput): Warning[] {
  const out: Warning[] = [];
  if (i.bytes >= 0.9 * i.maxBytes && i.bytes < i.maxBytes) out.push({ id: 'size', kind: 'size', title: 'File size', text: `${Math.round(i.bytes / 1024)} KB, close to the 1 MB limit.` });

  for (const s of i.issues) if (s.severity === 'warning') out.push({ id: `syntax:${s.line}:${s.code}`, kind: 'syntax', title: `Warning on line ${s.line}`, text: s.message, line: s.line });

  const base = preflightIssues({ blocks: i.blocks, text: i.text, exists: i.exists, ...(i.ruleName ? { ruleName: i.ruleName } : {}) });
  const covered = new Set<number>();
  for (const p of base as PreflightIssue[]) {
    if (p.kind !== 'sound') covered.add(p.line);
    out.push({ id: p.id, kind: p.kind as WarningKind, title: p.title, text: p.text, line: p.line, ...(p.ruleId ? { ruleId: p.ruleId } : {}), ...(p.file ? { file: p.file } : {}) });
  }

  // The finer shadow check: also reports a rule that only loses some of its items.
  const mine = i.blocks.filter((b) => b.ruleId);
  for (const f of findShadows(mine, i.classOf ? { classOf: i.classOf } : {})) {
    const b = f.block;
    if (f.kind === 'hidden') {
      if (covered.has(b.line)) continue;
      covered.add(b.line);
      out.push({
        id: `shadowed:${b.line}`,
        kind: 'shadowed',
        title: 'A rule hidden by an earlier rule',
        text: `“${nameOf(b, i.ruleName)}”, line ${b.line}, never applies. “${nameOf(f.by, i.ruleName)}”, line ${f.by.line}, catches them first.`,
        line: b.line,
        ...(b.ruleId ? { ruleId: b.ruleId } : {}),
      });
    } else {
      out.push({
        id: `partial:${b.line}:${f.by.line}`,
        kind: 'partial',
        title: 'A rule that skips some items',
        text: `“${nameOf(b, i.ruleName)}”, line ${b.line}, skips ${f.takes}, because “${nameOf(f.by, i.ruleName)}”, line ${f.by.line}, is above it.`,
        line: b.line,
        ...(b.ruleId ? { ruleId: b.ruleId } : {}),
      });
    }
  }

  for (const n of i.needsReview) out.push({ id: `review:${n.ruleId}`, kind: 'review', title: i.ruleName?.(n.ruleId) ? `Needs a look: ${i.ruleName(n.ruleId)}` : 'A rule needs a look', text: n.message, ruleId: n.ruleId });
  for (const r of i.idle) out.push({ id: `idle:${r.id}`, kind: 'idle', title: 'A rule that changes nothing', text: `“${r.name ?? 'Untitled rule'}” is on but no block in this filter uses it.`, ruleId: r.id });

  const rank = new Map(WARNING_ORDER.map((k, n) => [k, n] as const));
  return out.sort((a, b) => rank.get(a.kind)! - rank.get(b.kind)! || (a.line ?? 0) - (b.line ?? 0));
}
