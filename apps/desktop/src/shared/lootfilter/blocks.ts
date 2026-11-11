import type { Block, BlockKind, BlockLine, Color, Condition, IconSpec, LabelStyle, SoundSpec, TagRef } from './types.js';
import { MINIMAP_COLOURS, MINIMAP_SHAPES, isActionKey, isConditionKey, tokenize } from './syntax.js';

/**
 * Reading a filter into blocks and writing blocks back. NeverSink's files are CRLF; everything here works on
 * `\n` text and `toFileText` restores the line ending at the end.
 */

export function normalizeNewlines(text: string): string {
  return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

export function toFileText(text: string): string {
  return text.replace(/\n/g, '\r\n');
}

const HEADER = /^(Show|Hide|Minimal)\b(.*)$/;
const SECTION = /^#\s*\[\[?(\d+)\]\]?\s+(.*?)\s*$/;

/** Rule ids can hold spaces and quotes ("build:gem:Faster Attacks"); the comment form keeps them on one token. */
export function encodeRuleId(id: string): string {
  return id.replace(/[^A-Za-z0-9:_.-]/g, (c) => `~${c.codePointAt(0)!.toString(16)}~`);
}
export function decodeRuleId(s: string): string {
  return s.replace(/~([0-9a-f]+)~/g, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)));
}

export function parseTag(comment: string): { tag?: TagRef; code?: string; ruleId?: string } {
  const type = /\$type->(\S+)/.exec(comment);
  const tier = /\$tier->(\S+)/.exec(comment);
  const code = /%([A-Z]+\d*)\b/.exec(comment);
  const rule = /pom:rule=(\S+)/.exec(comment);
  const out: { tag?: TagRef; code?: string; ruleId?: string } = {};
  if (type && tier) out.tag = { type: type[1]!, tier: tier[1]! };
  if (code) out.code = code[1]!;
  if (rule) out.ruleId = decodeRuleId(rule[1]!);
  return out;
}

export function tagKey(t: TagRef): string {
  return `${t.type}|${t.tier}`;
}
export function tagLabel(t: TagRef): string {
  return `$type->${t.type} $tier->${t.tier}`;
}

export function parseCondition(key: string, restText: string): Condition {
  const { tokens } = tokenize(restText);
  let op = '';
  let rest = tokens;
  const first = tokens[0];
  if (first && !first.quoted && /^(<=|>=|==|!=|=|<|>|!)$/.test(first.text)) {
    op = first.text;
    rest = tokens.slice(1);
  } else if (first && !first.quoted && /^(<=|>=|==|!=|=|<|>|!)\d/.test(first.text)) {
    // HasExplicitMod >=2 "x": the operator is glued to the count, keep the whole token as a value.
  }
  return { key, op, values: rest.map((t) => t.text) };
}

export interface ParsedFilter {
  blocks: Block[];
  /** The text split into lines (no line endings), as parsed. */
  lines: string[];
}

/**
 * Parses the active blocks of a filter. Commented-out blocks (`#Show ...`) are ignored, like the game does.
 * `line` and `endLine` are 1-based and refer to the normalised text.
 */
export function parseBlocks(input: string): ParsedFilter {
  const text = normalizeNewlines(input);
  const lines = text.split('\n');
  const blocks: Block[] = [];
  let cur: Block | null = null;
  let section: string | undefined;
  const close = (endIdx: number): void => {
    if (cur) {
      cur.endLine = endIdx;
      blocks.push(cur);
      cur = null;
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const t = raw.trim();
    if (t === '') {
      // A blank line ends a block (NeverSink separates every block with one).
      close(i);
      continue;
    }
    if (t.startsWith('#')) {
      const sm = SECTION.exec(t);
      if (sm && !/TABLE OF CONTENTS/i.test(t)) section = `${sm[1]} ${sm[2]}`;
      continue;
    }
    const hm = HEADER.exec(t);
    if (hm) {
      close(i);
      const comment = hm[2]!.trim();
      const meta = parseTag(comment);
      cur = {
        kind: hm[1] as BlockKind,
        headerComment: comment,
        conditions: [],
        lines: [],
        continue: false,
        line: i + 1,
        endLine: i + 1,
        ...(section ? { section } : {}),
        ...meta,
      };
      continue;
    }
    if (!cur) continue;
    const m = /^(\S+)\s*(.*)$/.exec(t);
    if (!m) continue;
    const key = m[1]!;
    const rest = m[2]!;
    if (key === 'Continue') {
      cur.continue = true;
      cur.lines.push({ key, rest: '', raw });
    } else if (isConditionKey(key)) {
      cur.conditions.push(parseCondition(key, rest));
      cur.lines.push({ key, rest, raw });
    } else {
      cur.lines.push({ key, rest, raw });
    }
  }
  close(lines.length);
  return { blocks, lines };
}

const num = (s: string | undefined, d = 0): number => (s !== undefined && /^-?\d+$/.test(s) ? Number(s) : d);

function colorFrom(tokens: string[]): Color {
  const c = tokens.slice(0, 4).map((x) => num(x));
  return c.length === 3 ? [c[0]!, c[1]!, c[2]!] : [c[0]!, c[1]!, c[2]!, c[3]!];
}

/** The look a block gives an item, read from its action lines. Missing actions stay `undefined`. */
export function blockStyle(b: Pick<Block, 'lines'>): LabelStyle {
  const s: LabelStyle = {};
  for (const l of b.lines) {
    if (!isActionKey(l.key)) continue;
    const { tokens } = tokenize(l.rest);
    const t = tokens.map((x) => x.text);
    switch (l.key) {
      case 'SetTextColor':
        s.fg = colorFrom(t);
        break;
      case 'SetBorderColor':
        s.bd = colorFrom(t);
        break;
      case 'SetBackgroundColor':
        s.bg = colorFrom(t);
        break;
      case 'SetFontSize':
        s.fs = num(t[0], 32);
        break;
      case 'PlayAlertSound':
      case 'PlayAlertSoundPositional': {
        if (/^none$/i.test(t[0] ?? '')) s.sound = null;
        else s.sound = { kind: 'builtin', id: num(t[0], 1), vol: num(t[1], 50), ...(l.key === 'PlayAlertSoundPositional' ? { positional: true } : {}) } as SoundSpec;
        break;
      }
      case 'CustomAlertSound':
      case 'CustomAlertSoundOptional':
        if (/^none$/i.test(t[0] ?? '')) s.sound = null;
        else s.sound = { kind: 'custom', file: t[0] ?? '', vol: num(t[1], 100), ...(l.key === 'CustomAlertSoundOptional' ? { optional: true } : {}) };
        break;
      case 'MinimapIcon':
        if (t[0] === '-1') s.icon = null;
        else s.icon = { size: Math.min(2, Math.max(0, num(t[0], 1))) as IconSpec['size'], colour: t[1] ?? 'White', shape: t[2] ?? 'Circle' };
        break;
      case 'PlayEffect':
        s.beam = /^none$/i.test(t[0] ?? '') ? null : { colour: t[0] ?? 'White', ...(t[1] === 'Temp' ? { temp: true } : {}) };
        break;
      case 'DisableDropSound':
        s.dropSound = false;
        break;
      case 'EnableDropSound':
        s.dropSound = true;
        break;
    }
  }
  return s;
}

const q = (s: string): string => `"${s}"`;

export function colorText(c: Color): string {
  return c.slice(0, 4).map((x) => Math.max(0, Math.min(255, Math.round(x)))).join(' ');
}

/** Action lines for a style, in the order NeverSink writes them. Undefined fields produce nothing. */
export function styleToLines(s: LabelStyle): string[] {
  const out: string[] = [];
  if (s.fs !== undefined) out.push(`SetFontSize ${Math.max(1, Math.min(45, Math.round(s.fs)))}`);
  if (s.fg) out.push(`SetTextColor ${colorText(s.fg)}`);
  if (s.bd) out.push(`SetBorderColor ${colorText(s.bd)}`);
  if (s.bg) out.push(`SetBackgroundColor ${colorText(s.bg)}`);
  if (s.sound === null) out.push('PlayAlertSound None');
  else if (s.sound) {
    if (s.sound.kind === 'builtin') out.push(`${s.sound.positional ? 'PlayAlertSoundPositional' : 'PlayAlertSound'} ${s.sound.id} ${s.sound.vol}`);
    else out.push(`${s.sound.optional ? 'CustomAlertSoundOptional' : 'CustomAlertSound'} ${q(s.sound.file)} ${s.sound.vol}`);
  }
  if (s.beam === null) out.push('PlayEffect None');
  else if (s.beam) out.push(`PlayEffect ${s.beam.colour}${s.beam.temp ? ' Temp' : ''}`);
  if (s.icon === null) out.push('MinimapIcon -1');
  else if (s.icon) out.push(`MinimapIcon ${s.icon.size} ${s.icon.colour} ${s.icon.shape}`);
  if (s.dropSound === false) out.push('DisableDropSound');
  else if (s.dropSound === true) out.push('EnableDropSound');
  return out;
}

export function conditionToLine(c: Condition): string {
  const spec = specialCase(c);
  if (spec) return spec;
  const vals = c.values.map((v) => (needsQuotes(c.key, v) ? q(v) : v)).join(' ');
  return `${c.key}${c.op ? ' ' + c.op : ''}${vals ? ' ' + vals : ''}`;
}

function specialCase(c: Condition): string | null {
  // HasExplicitMod >=2 "a" "b": the glued form is kept as a value, so values[0] already holds the count.
  if (c.key === 'HasExplicitMod' && c.values[0] && /^(<=|>=|==|!=|=|<|>|!)?\d+$/.test(c.values[0]) && !c.op) {
    return `HasExplicitMod ${c.values[0]} ${c.values.slice(1).map(q).join(' ')}`.trim();
  }
  return null;
}

const STRING_KEYS = new Set(['BaseType', 'Class', 'HasExplicitMod', 'HasEnchantment', 'EnchantmentPassiveNode', 'ArchnemesisMod', 'TransfiguredGem', 'HasImplicitMod']);
function needsQuotes(key: string, v: string): boolean {
  if (key === 'Class' && /^[A-Za-z]+$/.test(v)) return false;
  if (key === 'HasExplicitMod' && /^(<=|>=|==|!=|=|<|>|!)?\d+$/.test(v)) return false;
  return STRING_KEYS.has(key);
}

export function blockToLines(b: { kind: BlockKind; comment: string; conditions: Condition[]; style: LabelStyle; continue?: boolean }): string[] {
  const out = [b.comment ? `${b.kind} # ${b.comment}` : b.kind];
  for (const c of b.conditions) out.push('\t' + conditionToLine(c));
  for (const l of styleToLines(b.style)) out.push('\t' + l);
  if (b.continue) out.push('\tContinue');
  return out;
}

/**
 * The conditions that hold exactly when `c` does not. A list of values becomes one condition per value
 * (not A and not B). Returns null when a condition has no plain negation (socket colours, mod counts).
 */
export function negateCondition(c: Condition): Condition[] | null {
  if (c.key === 'HasExplicitMod' || c.key === 'HasInfluence' || c.key === 'Sockets' || c.key === 'SocketGroup') return null;
  if (c.values.length === 1 && /^(True|False)$/i.test(c.values[0]!) && !c.op) return [{ ...c, values: [/^true$/i.test(c.values[0]!) ? 'False' : 'True'] }];
  if (c.key === 'Class' || c.key === 'BaseType' || c.key === 'Rarity') {
    if (c.key !== 'Rarity' && c.op === '!=') return null;
    return c.values.map((v) => ({ key: c.key, op: '!=', values: [v] }));
  }
  const flip: Record<string, string> = { '>=': '<', '>': '<=', '<=': '>', '<': '>=', '==': '!=', '=': '!=', '!=': '==', '!': '=' };
  if (c.op && flip[c.op]) return [{ ...c, op: flip[c.op]! }];
  return null;
}

export type { BlockLine };
export { MINIMAP_COLOURS, MINIMAP_SHAPES };
