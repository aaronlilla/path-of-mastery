import type { Block, LabelStyle, Rule } from './types.js';
import { blockStyle, normalizeNewlines, parseBlocks, tagKey } from './blocks.js';
import { isActionKey } from './syntax.js';
import { STRICTNESS, STYLES, applyStylePreset } from './styles.js';

/**
 * Reads a `.filter` file into rules. Blocks that map onto our rule kinds become rules: a changed NeverSink tier
 * becomes a tier restyle, a block of conditions becomes a condition rule. Anything else is kept word for word as a
 * raw block and flagged, so nothing in the file is lost.
 */

export interface ImportResult {
  strictness: number;
  /** NeverSink version named in the file, if any. */
  baseVersion: string;
  rules: Rule[];
  tierRules: number;
  conditionRules: number;
  rawBlocks: number;
  /** Plain-language notes, one per flagged block. */
  flags: string[];
  /** Index into STYLES named in our header, 0 otherwise. */
  style: number;
  /** True when the file looks like NeverSink's own or ours. */
  recognised: boolean;
}

export function detectStrictness(text: string): { index: number; version: string; recognised: boolean } {
  const head = normalizeNewlines(text).split('\n', 60).join('\n');
  const ours = /# strictness:\s*(\d+)/.exec(head);
  const type = /# TYPE:\s*(\d)-/.exec(head);
  const ver = /# (?:base-)?version:\s*(\S+)/i.exec(head) ?? /# VERSION:\s*(\S+)/.exec(head);
  const idx = ours ? Number(ours[1]) : type ? Number(type[1]) : 2;
  return { index: Math.max(0, Math.min(STRICTNESS.length - 1, idx)), version: ver ? ver[1]! : '', recognised: !!(ours || type) };
}

const condSig = (b: Block): string => b.conditions.map((c) => `${c.key} ${c.op} ${c.values.join('|')}`).join(';');

function styleDiff(base: LabelStyle, now: LabelStyle): LabelStyle | null {
  const out: LabelStyle = {};
  let any = false;
  for (const k of ['fg', 'bd', 'bg', 'fs', 'sound', 'icon', 'beam', 'dropSound'] as const) {
    const a = JSON.stringify(base[k] ?? null);
    const b = JSON.stringify(now[k] ?? null);
    if (a !== b) {
      (out as Record<string, unknown>)[k] = now[k] === undefined ? null : now[k];
      any = true;
    }
  }
  return any ? out : null;
}

export function importFilter(text: string, baseBlocksFor: (strictness: number) => Block[] | null): ImportResult {
  const norm = normalizeNewlines(text);
  const det = detectStrictness(norm);
  const stName = /# style:\s*(.+)/.exec(norm.split('\n', 60).join('\n'))?.[1]?.trim();
  const styleIdx = Math.max(0, STYLES.findIndex((x) => x.name === stName));
  const base = baseBlocksFor(det.index);
  const { blocks, lines } = parseBlocks(norm);
  const baseByKey = new Map<string, Block[]>();
  if (base) {
    for (const b of base) {
      if (!b.tag) continue;
      const k = `${tagKey(b.tag)}#${condSig(b)}`;
      const l = baseByKey.get(k);
      if (l) l.push(b);
      else baseByKey.set(k, [b]);
    }
  }
  const flags: string[] = [];
  const userRules: Rule[] = [];
  const tierRules = new Map<string, Rule>();
  let raw = 0;
  let now = 0;
  const addRaw = (b: Block, why: string): void => {
    raw++;
    const body = lines.slice(b.line - 1, b.endLine).map((l) => l.replace(/\s+$/, ''));
    flags.push(`Line ${b.line}: ${why}. Kept as written.`);
    userRules.push({ id: `imp-raw-${b.line}`, name: `Raw block from line ${b.line}`, source: 'advanced', enabled: true, priority: 0, targets: [], raw: body, why });
  };
  for (const b of blocks) {
    const unknown = b.lines.find((l) => l.key !== 'Continue' && !isActionKey(l.key) && !b.conditions.some((c) => c.key === l.key));
    if (b.tag) {
      const key = `${tagKey(b.tag)}#${condSig(b)}`;
      const cand = baseByKey.get(key);
      if (!base) {
        addRaw(b, 'there is no NeverSink file to compare this tier with');
        continue;
      }
      if (!cand || !cand.length) {
        addRaw(b, `$type->${b.tag.type} $tier->${b.tag.tier} is not in this NeverSink version, or its conditions changed`);
        continue;
      }
      const baseBlock = cand.shift()!;
      const bs = blockStyle(baseBlock);
      const lit = baseBlock.kind !== 'Hide' && (bs.bg !== undefined || bs.fg !== undefined || bs.bd !== undefined || bs.fs !== undefined);
      const diff = styleDiff(styleIdx > 0 && lit ? applyStylePreset(bs, styleIdx) : bs, blockStyle(b));
      const kindChange = baseBlock.kind !== b.kind;
      if (!diff && !kindChange) continue;
      const tk = tagKey(b.tag);
      if (tierRules.has(tk)) continue;
      const rule: Rule = {
        id: `imp-tier-${b.tag.type}-${b.tag.tier}`,
        name: `Restyled ${b.tag.type} ${b.tag.tier}`,
        source: 'advanced',
        enabled: true,
        priority: 0,
        targets: [{ tag: { type: b.tag.type, tier: b.tag.tier } }],
        ...(kindChange ? { visibility: b.kind === 'Hide' ? ('hide' as const) : ('show' as const) } : {}),
        ...(diff && b.kind !== 'Hide' ? { style: diff } : {}),
      };
      tierRules.set(tk, rule);
      continue;
    }
    if (unknown || b.kind === 'Minimal') {
      addRaw(b, unknown ? `${unknown.key} is not a line this app edits` : 'Minimal blocks only work in Ruthless filters');
      continue;
    }
    if (!b.conditions.length && !b.lines.length) continue;
    now++;
    const id = b.ruleId ?? `imp-${b.line}`;
    const name = b.headerComment.replace(/pom:rule=\S+\s*/, '').replace(/^#\s*/, '').trim();
    userRules.push({
      id: `${id}-${b.line}`,
      name: name || `Rule from line ${b.line}`,
      source: 'advanced',
      enabled: true,
      priority: 0,
      targets: [{ conditions: b.conditions.map((c) => ({ ...c })) }],
      visibility: b.kind === 'Hide' ? 'hide' : 'show',
      ...(b.kind !== 'Hide' && Object.keys(blockStyle(b)).length ? { style: blockStyle(b) } : {}),
      ...(b.continue ? { continue: true } : {}),
    });
  }
  // The first block in the file wins, so it gets the highest priority.
  const n = userRules.length;
  userRules.forEach((r, i) => (r.priority = n - i));
  const rules = [...userRules, ...tierRules.values()];
  return { strictness: det.index, baseVersion: det.version, rules, tierRules: tierRules.size, conditionRules: now, rawBlocks: raw, flags, style: styleIdx, recognised: det.recognised };
}
