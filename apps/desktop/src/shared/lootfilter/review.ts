import type { Block, Rule } from './types.js';
import { blockToLines, parseBlocks } from './blocks.js';
import { findShadows } from './shadow.js';

/**
 * Checks a proposed rule against the player's rules already in the filter. A proposal lands below every existing
 * rule (the player's own rules always win), so it can only be the one that loses: either an earlier rule already
 * catches every item it would, or an earlier rule of the opposite kind catches some of them.
 */

export interface RuleConflict {
  kind: 'hidden' | 'partial';
  text: string;
  /** The existing block that wins. */
  by: Block;
}

/** The blocks a rule would write, for the conditions it names. Rules that restyle a NeverSink tier write no block of their own. */
export function candidateBlocks(rule: Rule): Block[] {
  const out: Block[] = [];
  for (const t of rule.targets) {
    if (!t.conditions || !t.conditions.length) continue;
    const hide = rule.visibility === 'hide';
    const lines = blockToLines({ kind: hide ? 'Hide' : 'Show', comment: `pom:rule=${rule.id.replace(/\s/g, '_')} ${rule.name ?? 'proposed'}`, conditions: t.conditions, style: hide ? {} : rule.style ?? {}, ...(rule.continue ? { continue: true } : {}) });
    const b = parseBlocks(lines.join('\n')).blocks[0];
    if (b) out.push({ ...b, ruleId: rule.id });
  }
  return out;
}

/**
 * `existing` are the player's blocks in file order. `lineOf` gives the line the player sees for an existing block,
 * `nameOf` its rule's name and `sourceOf` a word for where the rule came from ("build" for a rule from the build).
 */
const SOCKET_KEYS = new Set(['LinkedSockets', 'Sockets']);

/**
 * `socketable` says whether the items the rule covers can have sockets at all. A currency item can never have four
 * links, so an earlier "keep 4 links" rule is not a conflict for it.
 */
export function conflictFor(existing: Block[], rule: Rule, lineOf: (b: Block) => number, nameOf: (b: Block) => string, sourceOf: (b: Block) => string, socketable: (r: Rule) => boolean = () => true, classOf?: (name: string) => string | undefined): RuleConflict | null {
  const mine = candidateBlocks(rule);
  if (!mine.length) return null;
  const hits = findShadows([...existing, ...mine], classOf ? { classOf } : {}).filter((f) => mine.includes(f.block));
  const f = hits.find((h) => !(h.kind === 'partial' && h.by.conditions.some((c) => SOCKET_KEYS.has(c.key)) && !socketable(rule)));
  if (!f) return null;
  const src = sourceOf(f.by);
  const who = `your ${src ? src + ' ' : ''}rule “${f.by.kind} ${nameOf(f.by)}” (line ${lineOf(f.by)})`;
  if (f.kind === 'hidden') return { kind: 'hidden', by: f.by, text: `Nothing would reach this: ${who} is above it and already catches every item it covers.` };
  return { kind: 'partial', by: f.by, text: `Conflicts with ${who}. Your rule stays above, so ${f.takes} still ${f.by.kind === 'Show' ? 'show' : 'stay hidden'}.` };
}
