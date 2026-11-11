import type { Block, LabelStyle, Rule, TagRef } from '../../../../shared/lootfilter/types.js';
import { blockStyle, blockToLines, parseBlocks } from '../../../../shared/lootfilter/blocks.js';
import { mergeStyle } from '../../../../shared/lootfilter/generate.js';
import { isActionKey, validateFilter } from '../../../../shared/lootfilter/syntax.js';
import { tr } from '../../../i18n';

/**
 * Your rules as text, and text back into rules. Only rules that write their own blocks can be shown as text:
 * an enabled Advanced rule whose targets are all plain conditions, with no exceptions. Everything else (rules that
 * restyle a NeverSink tier, rules from Guided, Build or Retier, disabled rules) stays exactly as it is.
 */

export function isEditable(r: Rule): boolean {
  return r.enabled && !r.reset && !(r.except && r.except.length) && r.targets.length > 0 && r.targets.every((t) => !t.tag && !!t.conditions && t.conditions.length > 0);
}

/** The blocks one rule is written as in the text, one per target. */
function ruleBlocks(r: Rule, tierStyle: (t: TagRef) => LabelStyle | undefined): string[][] {
  const hide = r.visibility === 'hide';
  const from = r.styleFrom ? tierStyle(r.styleFrom) ?? {} : {};
  const style = hide ? {} : mergeStyle(from, r.style);
  return r.targets.map((t) => blockToLines({ kind: hide ? 'Hide' : 'Show', comment: (r.name ?? 'Rule').replace(/[\r\n#]+/g, ' ').trim(), conditions: t.conditions ?? [], style, ...(r.continue ? { continue: true } : {}) }));
}

/** The text of every rule that can be written as plain blocks, highest priority first, under the same title the Your rules view has. */
export function rulesToText(rules: Rule[], tierStyle: (t: TagRef) => LabelStyle | undefined, title = '', buildName = ''): string {
  const mine = rules.filter(isEditable).sort((a, b) => b.priority - a.priority);
  const out: string[] = [`# Your rules \u00b7 ${title}`, ...(buildName ? [`# Build: ${buildName}`] : []), ''];
  for (const r of mine) for (const bl of ruleBlocks(r, tierStyle)) out.push(...bl, '');
  return out.join('\n');
}

const norm = (ls: string[]): string => ls.map((l) => l.trim()).filter(Boolean).join('\n');

export interface TextError {
  line: number;
  message: string;
}

export type TextResult = { ok: true; rules: Rule[]; ignoredMinimal: number } | { ok: false; errors: TextError[] };

const nameOf = (b: Block): string => {
  const n = b.headerComment.replace(/^#\s*/, '').replace(/pom:rule=\S+\s*/, '').trim();
  return n || tr('lootfilter_advanced_raw_convert.block_at_line', { line: b.line });
};

/** Turns the edited text into rules. Refuses, with line numbers, when the text would not be a valid filter or has lines a rule cannot keep. */
export function textToRules(text: string, ctx: { newId: (prefix: string) => string; existing: Rule[]; baseAbove: number; tierStyle?: (t: TagRef) => LabelStyle | undefined }): TextResult {
  const v = validateFilter(text);
  const errors: TextError[] = v.issues.filter((i) => i.severity === 'error').map((i) => ({ line: i.line, message: i.message }));
  const parsed = parseBlocks(text);
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  // Action lines the game accepts but a rule cannot store.
  for (const b of parsed.blocks) {
    for (let ln = b.line; ln <= b.endLine && ln <= lines.length; ln++) {
      const key = /^\s*(\S+)/.exec(lines[ln - 1] ?? '')?.[1];
      if (key && isActionKey(key) && /^(Disable|Enable)DropSoundIfAlertSound$/.test(key)) errors.push({ line: ln, message: tr('lootfilter_advanced_raw_convert.cannot_be_kept_in_a_rule', { key: key }) });
    }
  }
  if (errors.length) return { ok: false, errors: errors.sort((a, b) => a.line - b.line) };

  const pool = ctx.existing.filter(isEditable);
  const now = Date.now();
  const n = parsed.blocks.length;
  const rules: Rule[] = [];
  let minimal = 0;
  parsed.blocks.forEach((b, i) => {
    if (b.kind === 'Minimal') minimal++;
    const name = nameOf(b);
    const k = pool.findIndex((r) => (r.name ?? 'Rule') === name);
    const old = k >= 0 ? pool.splice(k, 1)[0] : undefined;
    const hide = b.kind === 'Hide';
    const style = hide ? undefined : blockStyle(b);
    const rule: Rule = {
      id: old?.id ?? ctx.newId('a'),
      name,
      source: 'advanced',
      enabled: true,
      priority: ctx.baseAbove + (n - i),
      targets: [{ conditions: b.conditions.map((c) => ({ ...c, values: [...c.values] })) }],
      visibility: hide ? 'hide' : 'show',
      createdAt: old?.createdAt ?? now,
    };
    if (style && Object.keys(style).length) rule.style = style;
    if (b.continue) rule.continue = true;
    if (old?.why) rule.why = old.why;
    // A block the player did not touch keeps its rule whole (source, Guided answers, reason).
    if (old && old.targets.length === 1 && ctx.tierStyle && norm(ruleBlocks(old, ctx.tierStyle)[0]!) === norm(lines.slice(b.line - 1, b.endLine))) rules.push({ ...old, priority: rule.priority });
    else rules.push(rule);
  });
  return { ok: true, rules, ignoredMinimal: minimal };
}
