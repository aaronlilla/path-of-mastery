/**
 * Edits to an item's text (what upstream's item editor writes back after each change). The engine parses the
 * result for display, so none of this decides what an item shows or calculates; it only changes lines. Lines are
 * the item's non-blank lines, trimmed: the same ones the engine's `rawLine` indexes.
 */

import type { ItemMod } from '@pom/protocol';

export function textLines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
}

export function joinLines(lines: string[]): string {
  return lines.join('\n');
}

export const INFLUENCE_LINES: Record<string, string> = {
  shaper: 'Shaper Item',
  elder: 'Elder Item',
  adjudicator: 'Warlord Item',
  basilisk: 'Hunter Item',
  crusader: 'Crusader Item',
  eyrie: 'Redeemer Item',
  cleansing: 'Searing Exarch Item',
  tangle: 'Eater of Worlds Item',
};

/** Where new spec lines (Quality, Sockets, influence) go: after the base line, past a leading Item Class and separators. */
function specAnchor(lines: string[]): number {
  let i = lines.findIndex((l) => /^Rarity:/i.test(l));
  if (i < 0) return Math.min(2, lines.length);
  i += 1;
  // Rare and unique items have a title line before the base; normal and magic have just the base.
  const rarity = /^Rarity:\s*(\w+)/i.exec(lines[i - 1]!)?.[1]?.toUpperCase() ?? 'NORMAL';
  const nameLines = rarity === 'RARE' || rarity === 'UNIQUE' || rarity === 'RELIC' ? 2 : 1;
  return Math.min(lines.length, i + nameLines);
}

function dropLine(lines: string[], re: RegExp): string[] {
  return lines.filter((l) => !re.test(l));
}

export function setQuality(text: string, q: number | null): string {
  let lines = dropLine(textLines(text), /^Quality:/i);
  if (q !== null && q > 0) lines.splice(specAnchor(lines), 0, `Quality: +${Math.round(q)}%`);
  else if (q === 0) lines.splice(specAnchor(lines), 0, 'Quality: 0');
  return joinLines(lines);
}

export function setRarity(text: string, rarity: string): string {
  const lines = textLines(text);
  const at = lines.findIndex((l) => /^Rarity:/i.test(l));
  if (at < 0) return joinLines([`Rarity: ${rarity}`, ...lines]);
  const was = /^Rarity:\s*(\w+)/i.exec(lines[at]!)?.[1]?.toUpperCase() ?? 'NORMAL';
  const titled = (r: string) => r === 'RARE' || r === 'UNIQUE' || r === 'RELIC';
  lines[at] = `Rarity: ${rarity}`;
  if (titled(was) && !titled(rarity)) lines.splice(at + 1, 1);
  else if (!titled(was) && titled(rarity)) lines.splice(at + 1, 0, 'New Item');
  return joinLines(lines);
}

export function setTitle(text: string, title: string): string {
  const lines = textLines(text);
  const at = lines.findIndex((l) => /^Rarity:/i.test(l));
  if (at >= 0 && at + 1 < lines.length) lines[at + 1] = title.trim() || 'New Item';
  return joinLines(lines);
}

export interface SocketSpec {
  c: string;
  /** Linked to the next socket. */
  link: boolean;
}

export function socketsLine(s: SocketSpec[]): string {
  return s.map((k, i) => k.c + (i < s.length - 1 ? (k.link ? '-' : ' ') : '')).join('');
}

/** Replaces the (non-abyssal) sockets; abyssal ones stay with the item's own line. */
export function setSockets(text: string, s: SocketSpec[]): string {
  const lines = textLines(text);
  const at = lines.findIndex((l) => /^Sockets:/i.test(l));
  const old = at >= 0 ? lines[at]!.slice(8).trim() : '';
  const abyssal = old.match(/A/g)?.length ?? 0;
  const next = s.length ? socketsLine(s) + (abyssal ? ' ' + 'A'.repeat(abyssal).split('').join(' ') : '') : abyssal ? old.replace(/[^A ]/g, '').trim() : '';
  if (at >= 0) {
    if (next) lines[at] = `Sockets: ${next}`;
    else lines.splice(at, 1);
  } else if (next) {
    lines.splice(specAnchor(lines), 0, `Sockets: ${next}`);
  }
  return joinLines(lines);
}

/** The influence lines of the item, replaced by `keys` (shaper, elder, ...). */
export function setInfluences(text: string, keys: string[]): string {
  const all = Object.values(INFLUENCE_LINES);
  const lines = textLines(text).filter((l) => !all.includes(l));
  const at = specAnchor(lines);
  lines.splice(at, 0, ...keys.map((k) => INFLUENCE_LINES[k]).filter((x): x is string => Boolean(x)));
  return joinLines(lines);
}

export function setCorrupted(text: string, on: boolean): string {
  const lines = dropLine(textLines(text), /^Corrupted$/i);
  if (on) lines.push('Corrupted');
  return joinLines(lines);
}

const LEAD_TAGS = /^((?:\{[^}]*\})*)(.*)$/s;

/** Changes the roll of a mod line (`{range:X}`, 0 to 1). */
export function setRange(text: string, rawLine: number, range: number): string {
  const lines = textLines(text);
  const l = lines[rawLine];
  if (l === undefined) return text;
  const m = LEAD_TAGS.exec(l)!;
  const tags = m[1]!.replace(/\{range:[^}]*\}/g, '');
  lines[rawLine] = `{range:${Math.round(range * 1e6) / 1e6}}${tags}${m[2]}`;
  return joinLines(lines);
}

/** Removes a mod line; `implicit` lines also come off the `Implicits: N` count. */
export function removeLine(text: string, rawLine: number, implicit: boolean): string {
  const lines = textLines(text);
  if (rawLine < 0 || rawLine >= lines.length) return text;
  lines.splice(rawLine, 1);
  if (implicit) {
    const at = lines.findIndex((l) => /^Implicits:/i.test(l));
    if (at >= 0) {
      const n = parseInt(lines[at]!.slice(10), 10);
      if (Number.isFinite(n) && n > 0) lines[at] = `Implicits: ${n - 1}`;
    }
  }
  return joinLines(lines);
}

const TRAILING = /^(Corrupted|Mirrored|Split|Fractured Item|Synthesised Item|Foil Unique.*|Unmodifiable|Unidentified)$/i;

/** Adds an explicit mod line (`{custom}` for typed-in text, `{crafted}` for a bench craft) before the trailing flags. */
export function addExplicit(text: string, line: string, tag: 'custom' | 'crafted' = 'custom'): string {
  const lines = textLines(text);
  let at = lines.length;
  while (at > 0 && TRAILING.test(lines[at - 1]!)) at -= 1;
  lines.splice(at, 0, `{${tag}}${line.trim()}`);
  return joinLines(lines);
}

/** Adds an implicit line after the existing ones and counts it in `Implicits: N`. */
export function addImplicit(text: string, line: string, tag: 'custom' | 'crafted' = 'custom'): string {
  const lines = textLines(text);
  let at = lines.findIndex((l) => /^Implicits:/i.test(l));
  if (at < 0) {
    const anchor = Math.min(lines.length, specAnchor(lines));
    lines.splice(anchor, 0, 'Implicits: 0');
    at = anchor;
  }
  const n = parseInt(lines[at]!.slice(10), 10) || 0;
  lines[at] = `Implicits: ${n + 1}`;
  lines.splice(at + 1 + n, 0, `{${tag}}${line.trim()}`);
  return joinLines(lines);
}

/** The first line of an item's text that is not a header: used to tell whether text is in the game's copy format. */
export function isGameFormat(text: string): boolean {
  return /^Item Class:/im.test(text) || /^--------$/m.test(text);
}

/** Whether pasted text looks like an item at all (it starts with a Rarity line, after an optional Item Class). */
export function looksLikeItem(text: string): boolean {
  const lines = textLines(text);
  const i = /^Item Class:/i.test(lines[0] ?? '') ? 1 : 0;
  return /^Rarity:/i.test(lines[i] ?? '');
}

// ---- implicit block: enchants, anoints, corruption --------------------------------------------------------------

/** Text the build file keeps: an `Implicits: N` line says how many lines after it are enchants, scourge and implicits. */
export function hasImplicitCount(text: string): boolean {
  return /^Implicits:/im.test(text);
}

function ensureImplicits(lines: string[]): number {
  let at = lines.findIndex((l) => /^Implicits:/i.test(l));
  if (at < 0) {
    at = Math.min(lines.length, specAnchor(lines));
    lines.splice(at, 0, 'Implicits: 0');
  }
  return at;
}

function tagged(tag: string, tags: string[], line: string): string {
  return `${tags.length ? `{tags:${tags.join(',')}}` : ''}{${tag}}${line.trim()}`.replace('{}', '');
}

export interface RawMod {
  bucket: string;
  rawLine: number | null;
}

/** Puts `entries` (the new lines, already tagged) in the enchant slot `slot` (1-based), replacing what is there; none removes it. */
export function setEnchantSlot(text: string, mods: RawMod[], slot: number, entries: string[] | null): string {
  const lines = textLines(text);
  const at = ensureImplicits(lines);
  const enchants = mods.filter((m) => m.bucket === 'enchant' && m.rawLine !== null).map((m) => m.rawLine!);
  const drop = enchants[slot - 1];
  let n = parseInt(lines[at]!.slice(10), 10) || 0;
  let insertAt = at + 1 + Math.min(slot - 1, enchants.length);
  if (drop !== undefined) {
    lines.splice(drop, 1);
    n -= 1;
    insertAt = drop;
  }
  if (entries && entries.length) {
    lines.splice(insertAt, 0, ...entries);
    n += entries.length;
  }
  lines[at] = `Implicits: ${Math.max(0, n)}`;
  return joinLines(lines);
}

export function enchantEntry(line: string): string {
  return `{crafted}{enchant}${line.trim()}`;
}

/** Replaces the item's implicit (or scourge) lines with `entries`, and counts them. */
export function replaceImplicits(text: string, mods: RawMod[], bucket: 'implicit' | 'scourge', entries: string[]): string {
  const lines = textLines(text);
  const drop = new Set(mods.filter((m) => m.bucket === bucket && m.rawLine !== null).map((m) => m.rawLine!));
  const at0 = lines.findIndex((l) => /^Implicits:/i.test(l));
  const kept = lines.filter((_, i) => !drop.has(i));
  const at = ensureImplicits(kept);
  let n = (parseInt(kept[at]!.slice(10), 10) || 0) - (at0 >= 0 ? drop.size : 0);
  // New lines go at the end of the implicit block: after the enchants and the lines that stay.
  const insertAt = at + 1 + Math.max(0, n);
  kept.splice(insertAt, 0, ...entries);
  n += entries.length;
  kept[at] = `Implicits: ${Math.max(0, n)}`;
  return joinLines(kept);
}

/** The corrupted-range multiplier of a mod line (0.78 to 1.22). */
export function setCorruptedRange(text: string, rawLine: number, value: number): string {
  const lines = textLines(text);
  const l = lines[rawLine];
  if (l === undefined) return text;
  const m = LEAD_TAGS.exec(l)!;
  const tags = m[1]!.replace(/\{corruptedRange:[^}]*\}/g, '');
  const v = Math.round(value * 100) / 100;
  lines[rawLine] = v === 1 ? `${tags}${m[2]}` : `{corruptedRange:${v}}${tags}${m[2]}`;
  return joinLines(lines);
}

/** An explicit modifier from a pool entry: its lines tagged with the entry's tags and kind. */
export function poolLines(tags: string[], kind: PoolKind, lines: string[], affix?: 'Prefix' | 'Suffix' | null): string[] {
  const flag = kind === 'implicit' ? '' : kind;
  const pre = affix === 'Prefix' ? '{prefix}' : affix === 'Suffix' ? '{suffix}' : '';
  return lines.map((l) => tagged(flag, tags, `${pre}${l}`));
}

export type PoolKind = 'custom' | 'crafted' | 'implicit' | 'scourge' | 'crucible' | 'exarch' | 'eater' | 'vestigial';

/** The item's Crucible lines replaced by `entries` (upstream writes them after the explicit lines, each flagged `{crucible}`). */
export function setCrucible(text: string, mods: RawMod[], entries: string[]): string {
  const lines = textLines(text);
  const drop = new Set(mods.filter((m) => m.bucket === 'crucible' && m.rawLine !== null).map((m) => m.rawLine!));
  const kept = lines.filter((_, i) => !drop.has(i));
  let at = kept.length;
  while (at > 0 && TRAILING.test(kept[at - 1]!)) at -= 1;
  kept.splice(at, 0, ...entries);
  return joinLines(kept);
}

/** Puts implicit lines in the implicit block: Eldritch lines replace the item's own of that kind, a Vestigial one replaces them all. */
export function addImplicitMod(text: string, mods: RawMod[], kind: 'exarch' | 'eater' | 'vestigial', entries: string[]): string {
  if (kind === 'vestigial') return replaceImplicits(text, mods, 'implicit', entries);
  const lines = textLines(text);
  const flagged = new RegExp(`^(?:\\{[^}]*\\})*\\{${kind}\\}`);
  const own = mods.filter((m) => m.bucket === 'implicit' && m.rawLine !== null && flagged.test(lines[m.rawLine!] ?? '')).map((m) => m.rawLine!);
  if (own.length) {
    const first = own[0]!;
    entries.forEach((e, i) => {
      if (first + i <= own[own.length - 1]!) lines[first + i] = e;
      else lines.splice(first + i, 0, e);
    });
    const at = lines.findIndex((l) => /^Implicits:/i.test(l));
    if (at >= 0) lines[at] = `Implicits: ${(parseInt(lines[at]!.slice(10), 10) || 0) + Math.max(0, entries.length - own.length)}`;
    return joinLines(lines);
  }
  const at = ensureImplicits(lines);
  const n = parseInt(lines[at]!.slice(10), 10) || 0;
  lines.splice(at + 1 + n, 0, ...entries);
  lines[at] = `Implicits: ${n + entries.length}`;
  return joinLines(lines);
}

/** The catalyst of a jewellery item and its quality (`Catalyst:` and `CatalystQuality:`); none removes both. */
export function setCatalyst(text: string, name: string | null, quality: number): string {
  const lines = dropLine(dropLine(textLines(text), /^Catalyst:/i), /^CatalystQuality:/i);
  if (name) {
    const at = specEnd(lines);
    lines.splice(at, 0, `Catalyst: ${name}`, `CatalystQuality: ${Math.max(0, Math.min(99, Math.round(quality)))}`);
  }
  return joinLines(lines);
}

function specEnd(lines: string[]): number {
  let i = specAnchor(lines);
  while (i < lines.length && /^(Crafted|Prefix|Suffix|Quality|Sockets|LevelReq|Item Level|League|Source|Variant|Selected Variant|Unique ID|Catalyst|CatalystQuality|Radius|Limited to|Talisman Tier|Cluster Jewel Skill|Cluster Jewel Node Count):/i.test(lines[i]!)) i += 1;
  return i;
}

/** Adds explicit lines before the trailing flags. */
export function addExplicitLines(text: string, entries: string[]): string {
  const lines = textLines(text);
  let at = lines.length;
  while (at > 0 && TRAILING.test(lines[at - 1]!)) at -= 1;
  lines.splice(at, 0, ...entries);
  return joinLines(lines);
}

/** The names of the item's variants (`Variant:` lines, in order). */
export function variantNames(text: string): string[] {
  return textLines(text)
    .filter((l) => /^Variant:/i.test(l))
    .map((l) => l.slice(8).trim());
}

/** Picks variant `n` (1-based) of an item that has variants. */
export function setVariant(text: string, n: number): string {
  const lines = textLines(text);
  const at = lines.findIndex((l) => /^Selected Variant:/i.test(l));
  if (at >= 0) lines[at] = `Selected Variant: ${n}`;
  else {
    const last = lines.map((l, i) => (/^Variant:/i.test(l) ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
    lines.splice(last + 1, 0, `Selected Variant: ${n}`);
  }
  return joinLines(lines);
}

/** All the item's enchantment lines replaced by `entries` (a cluster jewel's crafted enchantments are rebuilt as a block). */
export function setEnchantBlock(text: string, mods: RawMod[], entries: string[]): string {
  const lines = textLines(text);
  const drop = new Set(mods.filter((m) => m.bucket === 'enchant' && m.rawLine !== null).map((m) => m.rawLine!));
  const kept = lines.filter((_, i) => !drop.has(i));
  const at0 = lines.findIndex((l) => /^Implicits:/i.test(l));
  const at = ensureImplicits(kept);
  const n = (parseInt(kept[at]!.slice(10), 10) || 0) - (at0 >= 0 ? drop.size : 0);
  kept.splice(at + 1, 0, ...entries);
  kept[at] = `Implicits: ${Math.max(0, n) + entries.length}`;
  return joinLines(kept);
}

/** The `Cluster Jewel Skill:` and `Cluster Jewel Node Count:` lines of a cluster jewel. */
export function setClusterSpec(text: string, skillId: string, nodeCount: number): string {
  const lines = dropLine(dropLine(textLines(text), /^Cluster Jewel Skill:/i), /^Cluster Jewel Node Count:/i);
  const at = specEnd(lines);
  lines.splice(at, 0, `Cluster Jewel Skill: ${skillId}`, `Cluster Jewel Node Count: ${nodeCount}`);
  return joinLines(lines);
}

/** The crafted enchantment lines of a cluster jewel (`CraftClusterJewel`): the added passive count, its sockets, and the skill's own lines. */
export function clusterEnchants(size: string | null, nodeCount: number, skillEnchant: string[]): string[] {
  const out = [`Adds ${nodeCount} Passive Skills`];
  if (size === 'Large') out.push('2 Added Passive Skills are Jewel Sockets');
  else if (size === 'Medium') out.push('1 Added Passive Skill is a Jewel Socket');
  out.push(...skillEnchant);
  return out.map((l) => enchantEntry(l));
}

/** The extra variant axes an item can have (`Has Alt Variant`, `... Two`, up to `... Five`) and the line each one stores its choice in. */
const ALT = [
  { has: 'Has Alt Variant', sel: 'Selected Alt Variant', label: 'Alt variant' },
  { has: 'Has Alt Variant Two', sel: 'Selected Alt Variant Two', label: 'Alt variant 2' },
  { has: 'Has Alt Variant Three', sel: 'Selected Alt Variant Three', label: 'Alt variant 3' },
  { has: 'Has Alt Variant Four', sel: 'Selected Alt Variant Four', label: 'Alt variant 4' },
  { has: 'Has Alt Variant Five', sel: 'Selected Alt Variant Five', label: 'Alt variant 5' },
];

/** Choice `n` (1-based) of an alternate variant axis. */
export function setAltVariant(text: string, sel: string, n: number): string {
  const lines = textLines(text);
  const at = lines.findIndex((l) => l.toLowerCase().startsWith(`${sel.toLowerCase()}:`));
  if (at >= 0) lines[at] = `${sel}: ${n}`;
  else {
    const last = lines.map((l, i) => (/^Variant:/i.test(l) ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
    lines.splice(last + 1, 0, `${sel}: ${n}`);
  }
  return lines.join('\n');
}

export function altVariants(text: string): Array<{ sel: string; label: string; value: number }> {
  const lines = textLines(text);
  const out: Array<{ sel: string; label: string; value: number }> = [];
  for (const a of ALT) {
    if (!lines.some((l) => l.toLowerCase().startsWith(`${a.has.toLowerCase()}:`))) continue;
    const v = lines.find((l) => l.toLowerCase().startsWith(`${a.sel.toLowerCase()}:`));
    out.push({ sel: a.sel, label: a.label, value: v ? parseInt(v.slice(a.sel.length + 1), 10) || 1 : 1 });
  }
  return out;
}


/** Turns a modifier line off or on (`{disabled}`): the line stays in the item but adds nothing (`ToggleDisplayItemModLine`). */
export function toggleDisabled(text: string, rawLine: number): string {
  const lines = textLines(text);
  const l = lines[rawLine];
  if (l === undefined) return text;
  const m = LEAD_TAGS.exec(l)!;
  const tags = m[1]!;
  lines[rawLine] = /\{disabled\}/.test(tags) ? `${tags.replace(/\{disabled\}/g, '')}${m[2]}` : `{disabled}${tags}${m[2]}`;
  return joinLines(lines);
}

/** One line group of a Foulborn unique that can be turned into its other form (`ItemClass:MutateMod`). */
export interface Mutation {
  rawLines: number[];
  modId: string;
  newModId: string;
  mutated: boolean;
  replace: string[];
}

/** The mutation applied: the lines it covers become `replace`, at the position of the first of them. */
export function applyMutation(text: string, m: Mutation): string {
  const lines = textLines(text);
  const first = Math.min(...m.rawLines);
  const drop = new Set(m.rawLines);
  const out: string[] = [];
  lines.forEach((l, i) => {
    if (i === first) out.push(...m.replace);
    if (!drop.has(i)) out.push(l);
  });
  return joinLines(out);
}

/**
 * With prefix and suffix rows showing, the modifier lines under them are only the ones the rows can't make: crafted and
 * custom lines (`ItemClass:Craft` keeps those and rebuilds the rest from the affixes). A plain line that arrives with
 * the item's Prefix and Suffix entries is the same modifier again.
 */
export function extraAffixLine(m: Pick<ItemMod, 'prefix' | 'suffix' | 'custom' | 'crafted'>): boolean {
  return !m.prefix && !m.suffix && (m.custom || m.crafted);
}

/**
 * The label in front of a modifier line, the way upstream's item editor names it (`Crafted:`, `Custom:`, `Crucible:`),
 * plus the implicit kinds (`Enchant:`, `Scourge:`, `Eater:`, `Exarch:`). A fractured line keeps its own label and adds a
 * second `Fractured` line under it, so no label ever sits on top of the modifier's text.
 */
export function modLabel(text: string, m: Pick<ItemMod, 'bucket' | 'rawLine' | 'crafted' | 'fractured' | 'custom' | 'prefix' | 'suffix'>): { label: string; sub?: string } {
  const raw = m.rawLine === null ? '' : (textLines(text)[m.rawLine] ?? '');
  const has = (tag: string) => new RegExp(`\\{${tag}(?::[^}]*)?\\}`).test(raw);
  let label: string;
  if (m.bucket === 'enchant') label = 'Enchant:';
  else if (m.bucket === 'scourge') label = 'Scourge:';
  else if (m.bucket === 'crucible') label = 'Crucible:';
  else if (m.bucket === 'implicit') label = has('eater') ? 'Eater:' : has('exarch') ? 'Exarch:' : m.crafted ? 'Crafted:' : 'Implicit:';
  else if (m.crafted) label = 'Crafted:';
  else if (m.custom) label = 'Custom:';
  else if (m.prefix) label = 'Prefix:';
  else if (m.suffix) label = 'Suffix:';
  else label = 'Explicit:';
  return m.fractured ? { label, sub: 'Fractured' } : { label };
}

/** Eater of Worlds and Searing Exarch can only be chosen on armour (and the rare items that say they can have eldritch influence), as `ItemsTab` lists them. */
export function eldritchInfluenceAllowed(type: string | undefined, text: string): boolean {
  return type === 'Helmet' || type === 'Body Armour' || type === 'Gloves' || type === 'Boots' || /if the eater of worlds is dominant/i.test(text);
}
