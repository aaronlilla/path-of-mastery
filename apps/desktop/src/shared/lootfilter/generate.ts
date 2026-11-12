import type { Block, BlockKind, Condition, LabelStyle, Rule, TagRef, Target, Visibility } from './types.js';
import {
  blockStyle,
  blockToLines,
  conditionToLine,
  encodeRuleId,
  negateCondition,
  normalizeNewlines,
  parseBlocks,
  type ParsedFilter,
  styleToLines,
  tagKey,
  tagLabel,
  toFileText,
} from './blocks.js';
import { STRICTNESS, STYLES, applyStylePreset, styleIndexFor } from './styles.js';
import { isActionKey } from './syntax.js';

export const POM_FORMAT = 1;
export const HEADER_MARK = '# pom-filter-format:';
const RULE = '#===============================================================================================================';

/** A small stable hash (two 32-bit FNV-1a lanes) for change detection. Not for security. */
export function hashText(s: string): string {
  let h1 = 0x811c9dc5 | 0;
  let h2 = 0x9747b28c | 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) ^ (h2 >>> 13);
  }
  const hex = (n: number): string => (n >>> 0).toString(16).padStart(8, '0');
  return hex(h1) + hex(h2);
}

export function mergeStyle(base: LabelStyle, over: LabelStyle | undefined): LabelStyle {
  if (!over) return base;
  const out: LabelStyle = { ...base };
  for (const k of Object.keys(over) as (keyof LabelStyle)[]) {
    if (over[k] !== undefined) (out as Record<string, unknown>)[k] = over[k];
  }
  return out;
}

export interface ReviewItem {
  ruleId: string;
  kind: 'tag-missing' | 'except-complex' | 'too-many' | 'raw-block';
  message: string;
  tag?: TagRef;
}

export interface GenerateInput {
  baseText: string;
  baseVersion: string;
  /** Index into STRICTNESS. */
  strictness: number;
  /** Index into STYLES. */
  style: number;
  /** A different style for currency-like sections only. */
  styleCurrency?: number;
  /** A different style for gear sections only. */
  styleGear?: number;
  /** False writes NeverSink's stacked-currency blocks commented out. Left out means on. */
  stackedTiering?: boolean;
  rules: Rule[];
  /** Fixed in tests so output is reproducible. */
  now?: Date;
  /** Shown in the header, for example the name of the build the filter follows. */
  buildName?: string;
  /** The base text already parsed, to skip parsing it again on every edit. */
  parsed?: ParsedFilter;
  /** Header comment lines for a Build Filter (`# build: ...`, `# build-mode: ...`, `# stages: ...`). */
  buildHeader?: string[];
  /** Banner text per `Rule.build.stage`, written above the first block of each stage group. */
  stageBanners?: Record<string, string>;
}

export interface GenerateResult {
  /** `\n` line endings, for parsing and display. */
  text: string;
  /** `\r\n` line endings, what is written to disk. */
  fileText: string;
  rulesHash: string;
  /** Rules that produced something, with how many blocks each wrote or restyled. */
  applied: { ruleId: string; written: number; restyled: number }[];
  needsReview: ReviewItem[];
  userBlocks: number;
  restyledBlocks: number;
  baseBlocks: number;
  bytes: number;
  /** Line (1-based) where NeverSink's text starts. */
  baseStartLine: number;
}

export interface HeaderInfo {
  format: number;
  baseVersion: string;
  strictness: number;
  strictnessName: string;
  style: string;
  rulesHash: string;
  rules: number;
  needsReview: number;
  generated: string;
}

export function formatHeader(h: HeaderInfo, extra: string[] = []): string[] {
  return [
    RULE,
    '# PATH OF MASTERY LOOT FILTER',
    `${HEADER_MARK} ${h.format}`,
    `# base: NeverSink ${h.baseVersion} (${h.strictnessName}), MIT licence, copyright NeverSink`,
    `# base-version: ${h.baseVersion}`,
    `# strictness: ${h.strictness} ${h.strictnessName}`,
    `# style: ${h.style}`,
    `# rules-hash: ${h.rulesHash}`,
    `# rules: ${h.rules} active, ${h.needsReview} need review`,
    `# generated: ${h.generated}`,
    '# This file is written by Path of Mastery. Edit your rules there; changes made here are overwritten the next time you write.',
    ...extra,
    RULE,
  ];
}

/** Reads our header from filter text, or null when the file is not ours. */
export function parseHeader(text: string): HeaderInfo | null {
  const head = normalizeNewlines(text).split('\n', 40);
  const fm = head.findIndex((l) => l.startsWith(HEADER_MARK));
  if (fm < 0) return null;
  const get = (key: string): string => {
    const l = head.find((x) => x.startsWith(`# ${key}:`));
    return l ? l.slice(key.length + 3).trim() : '';
  };
  const st = get('strictness');
  const stm = /^(\d+)\s+(.*)$/.exec(st);
  const rules = /^(\d+) active, (\d+) need review/.exec(get('rules'));
  return {
    format: Number(head[fm]!.slice(HEADER_MARK.length).trim()) || 0,
    baseVersion: get('base-version'),
    strictness: stm ? Number(stm[1]) : 0,
    strictnessName: stm ? stm[2]! : '',
    style: get('style'),
    rulesHash: get('rules-hash'),
    rules: rules ? Number(rules[1]) : 0,
    needsReview: rules ? Number(rules[2]) : 0,
    generated: get('generated'),
  };
}

/** The part of a rule that affects the output, so edits to labels or notes do not count as changes. */
export function rulesSignature(rules: Rule[], strictness: number, style: number, scopes: { styleCurrency?: number; styleGear?: number; stackedTiering?: boolean } = {}): string {
  const live = rules
    .filter((r) => r.enabled)
    .sort((a, b) => a.priority - b.priority)
    .map((r) => ({ id: r.id, p: r.priority, t: r.targets, e: r.except, v: r.visibility, s: r.style, f: r.styleFrom, r: r.reset, c: r.continue, w: r.raw, ct: r.customTier }));
  return hashText(JSON.stringify({ strictness, style, ...(scopes.styleCurrency !== undefined ? { sc: scopes.styleCurrency } : {}), ...(scopes.styleGear !== undefined ? { sg: scopes.styleGear } : {}), ...(scopes.stackedTiering === false ? { st: 0 } : {}), live }));
}

/** True for NeverSink's stacked-currency blocks: stacks of cheap items that get the look of a higher tier. */
export function isStackedTag(tag: TagRef | undefined): boolean {
  if (!tag) return false;
  if (/^currency->(stacked|levelingstacked)/.test(tag.type)) return true;
  return /stack/.test(tag.tier) && tag.type !== 'gold';
}

const namesOf = (r: Rule): string[] => r.targets.flatMap((t) => t.conditions ?? []).filter((c) => c.key === 'BaseType').flatMap((c) => c.values);

// ---- exceptions ----------------------------------------------------------------------------------

const MAX_EXPANSION = 64;

function sameCondition(a: Condition, b: Condition): boolean {
  return a.key === b.key && a.op === b.op && a.values.join('\u0000') === b.values.join('\u0000');
}

/** Drops exactly the names an exception removes from an exact BaseType list. */
function subtractBaseTypes(base: Condition[], names: string[]): Condition[] | null {
  const i = base.findIndex((c) => c.key === 'BaseType' && c.op === '==');
  if (i < 0) return null;
  const left = base[i]!.values.filter((v) => !names.includes(v));
  if (left.length === base[i]!.values.length) return null;
  if (!left.length) return [];
  const out = base.slice();
  out[i] = { ...base[i]!, values: left };
  return out;
}

/**
 * Turns "these conditions, except items matching any of these sets" into plain condition sets, because a block
 * cannot say "not (A and B)". Each exception becomes one block per condition, with the earlier ones kept true.
 * Returns null when an exception has no plain negation or the result would be too large.
 */
export function expandExceptions(base: Condition[], except: Condition[][]): Condition[][] | null {
  if (!except.length) return [base];
  const [e0, ...rest] = except as [Condition[], ...Condition[][]];
  if (!e0.length) return [];
  // The common case: a single exact BaseType exception on an exact BaseType list just removes names.
  if (e0.length === 1 && e0[0]!.key === 'BaseType' && (e0[0]!.op === '==' || e0[0]!.op === '')) {
    const sub = subtractBaseTypes(base, e0[0]!.values);
    if (sub) return sub.length ? expandExceptions(sub, rest) : [];
  }
  const out: Condition[][] = [];
  for (let i = 0; i < e0.length; i++) {
    const neg = negateCondition(e0[i]!);
    if (!neg) return null;
    const keep = e0.slice(0, i).filter((c) => !base.some((b) => sameCondition(b, c)));
    const piece = [...base, ...keep, ...neg];
    const sub = expandExceptions(piece, rest);
    if (!sub) return null;
    out.push(...sub);
    if (out.length > MAX_EXPANSION) return null;
  }
  return out;
}

// ---- rule resolution -------------------------------------------------------------------------------

function baseTypeNames(t: Target): string[] {
  const c = t.conditions;
  if (!c || c.length !== 1 || c[0]!.key !== 'BaseType') return [];
  return c[0]!.values;
}

/** Applies "put back to normal" rules: they cancel lower rules on the same tiers and remove the same base types. */
function resolveResets(sorted: Rule[]): Rule[] {
  const out = sorted.map((r) => ({ ...r, targets: r.targets.map((t) => ({ ...t })) }));
  for (let i = out.length - 1; i >= 0; i--) {
    const r = out[i]!;
    if (!r.reset) continue;
    const tags = new Set(r.targets.filter((t) => t.tag).map((t) => tagKey(t.tag!)));
    const names = new Set(r.targets.flatMap(baseTypeNames));
    for (let j = 0; j < i; j++) {
      const lower = out[j]!;
      if (lower.reset) continue;
      lower.targets = lower.targets.flatMap((t) => {
        if (t.tag && tags.has(tagKey(t.tag))) return [];
        const n = baseTypeNames(t);
        if (n.length && t.conditions) {
          const left = n.filter((x) => !names.has(x));
          if (!left.length) return [];
          if (left.length < n.length) return [{ conditions: [{ ...t.conditions[0]!, values: left }] }];
        }
        return [t];
      });
    }
  }
  return out.filter((r) => !r.reset);
}

function slug(s: string): string {
  return s.replace(/[\r\n#]+/g, ' ').trim().slice(0, 80);
}

function visKind(v: Visibility | undefined, fallback: BlockKind): BlockKind {
  if (v === 'hide') return 'Hide';
  if (v === 'show') return 'Show';
  return fallback;
}

interface Override {
  kind?: BlockKind;
  style?: LabelStyle;
  by: string[];
}

function rewriteBlock(lines: string[], b: Block, o: Override): string[] {
  const out: string[] = [];
  const header = lines[b.line - 1]!;
  out.push(header.replace(/^(\s*)(Show|Hide|Minimal)/, `$1${o.kind ?? b.kind}`));
  let cont: string | null = null;
  for (let i = b.line; i <= b.endLine - 1; i++) {
    const raw = lines[i]!;
    const t = raw.trim();
    if (!t) continue;
    if (t.startsWith('#')) {
      out.push(raw);
      continue;
    }
    const key = /^(\S+)/.exec(t)![1]!;
    if (key === 'Continue') {
      cont = raw;
      continue;
    }
    if (isActionKey(key)) continue;
    out.push(raw);
  }
  const kind = o.kind ?? b.kind;
  if (kind !== 'Hide' && o.style) for (const l of styleToLines(o.style)) out.push('\t' + l);
  if (cont) out.push(cont);
  return out;
}

function ruleStyleOf(rule: Rule, baseBlocks: Block[], ov: Map<Block, Override>): LabelStyle {
  let s: LabelStyle = {};
  if (rule.styleFrom) {
    const k = tagKey(rule.styleFrom);
    const src = baseBlocks.find((b) => b.tag && tagKey(b.tag) === k && b.kind !== 'Hide');
    if (src) s = ov.get(src)?.style ?? blockStyle(src);
  }
  return mergeStyle(s, rule.style);
}

export function generateFilter(input: GenerateInput): GenerateResult {
  const baseNorm = normalizeNewlines(input.baseText);
  const parsed = input.parsed ?? parseBlocks(baseNorm);
  const baseLines = parsed.lines;
  const blocks = parsed.blocks;
  const strict = STRICTNESS[input.strictness] ?? STRICTNESS[2];
  const needsReview: ReviewItem[] = [];
  const applied = new Map<string, { written: number; restyled: number }>();
  const note = (id: string, k: 'written' | 'restyled', n: number): void => {
    const e = applied.get(id) ?? { written: 0, restyled: 0 };
    e[k] += n;
    applied.set(id, e);
  };

  const ov = new Map<Block, Override>();
  // 1. whole-filter style
  const scoped = { style: input.style, ...(input.styleCurrency !== undefined ? { styleCurrency: input.styleCurrency } : {}), ...(input.styleGear !== undefined ? { styleGear: input.styleGear } : {}) };
  if (input.style > 0 || (input.styleCurrency ?? 0) > 0 || (input.styleGear ?? 0) > 0) {
    for (const b of blocks) {
      if (b.kind === 'Hide') continue;
      const idx = styleIndexFor(scoped, b.tag?.type);
      if (idx <= 0) continue;
      const s = blockStyle(b);
      if (s.bg === undefined && s.fg === undefined && s.bd === undefined && s.fs === undefined && s.beam === undefined) continue;
      const next = applyStylePreset(s, idx);
      if (JSON.stringify(next) !== JSON.stringify(s)) ov.set(b, { style: next, by: [] });
    }
  }

  // A tier the player added but has not put any item in yet writes nothing (a block with no conditions would match everything).
  const sorted = input.rules.filter((r) => r.enabled && !(r.customTier && namesOf(r).length === 0)).sort((a, b) => a.priority - b.priority);
  const rules = resolveResets(sorted);
  const byTag = new Map<string, Block[]>();
  for (const b of blocks) {
    if (!b.tag) continue;
    const k = tagKey(b.tag);
    const l = byTag.get(k);
    if (l) l.push(b);
    else byTag.set(k, [b]);
  }

  // 2. in-place restyles, lowest priority first so the highest priority is applied last and wins
  const topByRule = new Map<string, string[][]>();
  for (const rule of rules) {
    if (rule.raw) {
      topByRule.set(rule.id, [rule.raw]);
      needsReview.push({ ruleId: rule.id, kind: 'raw-block', message: rule.why ?? 'Kept as written from an imported file.' });
      continue;
    }
    const style = ruleStyleOf(rule, blocks, ov);
    const cloned = !!(rule.except && rule.except.length) || !!rule.continue;
    for (const t of rule.targets) {
      if (t.tag) {
        const hit = byTag.get(tagKey(t.tag));
        if (!hit || !hit.length) {
          needsReview.push({ ruleId: rule.id, kind: 'tag-missing', tag: t.tag, message: `The base filter no longer has a block tagged ${tagLabel(t.tag)}.` });
          continue;
        }
        if (!cloned) {
          for (const b of hit) {
            const cur = ov.get(b) ?? { by: [] };
            const baseStyle = cur.style ?? blockStyle(b);
            const nextStyle = mergeStyle(baseStyle, style);
            ov.set(b, { kind: visKind(rule.visibility, cur.kind ?? b.kind), style: nextStyle, by: [...cur.by, rule.id] });
          }
          note(rule.id, 'restyled', hit.length);
          continue;
        }
        const out = topByRule.get(rule.id) ?? [];
        for (const b of hit) {
          const sets = expandExceptions(b.conditions, rule.except ?? []);
          if (!sets) {
            needsReview.push({ ruleId: rule.id, kind: 'except-complex', tag: t.tag, message: 'An exception on this rule cannot be written as plain conditions.' });
            break;
          }
          const kind = visKind(rule.visibility, b.kind);
          const own = mergeStyle(ov.get(b)?.style ?? blockStyle(b), style);
          for (const set of sets) {
            const head = `${kind} # pom:rule=${encodeRuleId(rule.id)} ${slug(rule.name ?? tagLabel(t.tag))}`;
            const lines = [head, ...set.map((c) => '\t' + conditionToLine(c))];
            if (kind !== 'Hide') for (const l of styleToLines(own)) lines.push('\t' + l);
            if (rule.continue) lines.push('\tContinue');
            out.push(lines);
          }
        }
        if (out.length) topByRule.set(rule.id, out);
        continue;
      }
      if (t.conditions) {
        const sets = expandExceptions(t.conditions, rule.except ?? []);
        if (!sets) {
          needsReview.push({ ruleId: rule.id, kind: 'except-complex', message: 'An exception on this rule cannot be written as plain conditions.' });
          continue;
        }
        const out = topByRule.get(rule.id) ?? [];
        const kind: BlockKind = rule.visibility === 'hide' ? 'Hide' : 'Show';
        for (const set of sets) {
          out.push(blockToLines({ kind, comment: `pom:rule=${encodeRuleId(rule.id)} ${slug(rule.name ?? 'rule')}`, conditions: set, style: kind === 'Hide' ? {} : style, continue: rule.continue }));
        }
        if (out.length) topByRule.set(rule.id, out);
      }
    }
  }

  // 3. top blocks, highest priority first (first match wins in the game)
  const topLines: string[] = [];
  let userBlocks = 0;
  let lastStage: string | undefined;
  for (const rule of [...rules].sort((a, b) => b.priority - a.priority)) {
    const bl = topByRule.get(rule.id);
    if (!bl) continue;
    if (bl.length > MAX_EXPANSION * 4) {
      needsReview.push({ ruleId: rule.id, kind: 'too-many', message: `This rule would write ${bl.length} blocks.` });
      continue;
    }
    const stage = rule.build?.stage;
    if (stage !== lastStage) {
      if (stage) topLines.push(`# STAGE ${slug(input.stageBanners?.[stage] ?? (stage === 'all' ? 'ALL Safety net and build items' : stage))}`);
      else if (lastStage) topLines.push('# YOUR RULES');
      lastStage = stage;
    }
    for (const lines of bl) {
      topLines.push(...lines, '');
      userBlocks++;
    }
    note(rule.id, 'written', bl.length);
  }

  // 4. reassemble
  const out: string[] = [];
  const blockAt = new Map<number, Block>();
  const stackedOff = input.stackedTiering === false;
  const switchedOff = (b: Block): boolean => stackedOff && b.kind !== 'Hide' && isStackedTag(b.tag);
  for (const b of blocks) if (ov.has(b) || switchedOff(b)) blockAt.set(b.line - 1, b);
  for (let i = 0; i < baseLines.length; i++) {
    const b = blockAt.get(i);
    if (b) {
      const lines = ov.has(b) ? rewriteBlock(baseLines, b, ov.get(b)!) : baseLines.slice(b.line - 1, b.endLine);
      out.push(...(switchedOff(b) ? ['# Stacked tiering is off in Path of Mastery, so this block is switched off:', ...lines.map((l) => (l.trim() ? '# ' + l : l))] : lines));
      i = b.endLine - 1;
    } else out.push(baseLines[i]!);
  }
  const reviewIds = new Set(needsReview.map((n) => n.ruleId));
  const live = rules.length;
  const rulesHash = rulesSignature(input.rules, input.strictness, input.style, { ...(input.styleCurrency !== undefined ? { styleCurrency: input.styleCurrency } : {}), ...(input.styleGear !== undefined ? { styleGear: input.styleGear } : {}), ...(input.stackedTiering === false ? { stackedTiering: false } : {}) });
  const style = STYLES[input.style] ?? STYLES[0]!;
  const scopeBits: string[] = [];
  if (input.styleCurrency !== undefined && input.styleCurrency !== input.style) scopeBits.push(`currency ${STYLES[input.styleCurrency]?.name ?? ''}`);
  if (input.styleGear !== undefined && input.styleGear !== input.style) scopeBits.push(`gear ${STYLES[input.styleGear]?.name ?? ''}`);
  const extra: string[] = [];
  if (input.buildName) extra.push(`# follows build: ${slug(input.buildName)}`);
  if (input.buildHeader) extra.push(...input.buildHeader.map((l) => '# ' + slug(l)));
  for (const n of needsReview) extra.push(`# needs review: rule ${n.ruleId}: ${slug(n.message)}`);
  const head = formatHeader(
    {
      format: POM_FORMAT,
      baseVersion: input.baseVersion,
      strictness: input.strictness,
      strictnessName: strict.name,
      style: scopeBits.length ? `${style.name} (${scopeBits.join(', ')})` : style.name,
      rulesHash,
      rules: live - reviewIds.size,
      needsReview: reviewIds.size,
      generated: (input.now ?? new Date()).toISOString(),
    },
    extra,
  );
  const userHead = [RULE, '# YOUR RULES. The first rule that matches an item wins, so these sit above NeverSink.', RULE, ''];
  const baseHead = [RULE, `# NEVERSINK BASE ${input.baseVersion} ${strict.name}. Tiers below are restyled in place by your rules.`, RULE, ''];
  const all = [...head, '', ...userHead, ...(topLines.length ? topLines : ['# (no rules write blocks)', '']), ...baseHead];
  const baseStartLine = all.length + 1;
  all.push(...out);
  const text = all.join('\n');
  const fileText = toFileText(text);
  return {
    text,
    fileText,
    rulesHash,
    applied: [...applied].map(([ruleId, v]) => ({ ruleId, ...v })),
    needsReview,
    userBlocks,
    restyledBlocks: [...ov.values()].filter((o) => o.by.length).length,
    baseBlocks: blocks.length,
    bytes: new TextEncoder().encode(fileText).length,
    baseStartLine,
  };
}
