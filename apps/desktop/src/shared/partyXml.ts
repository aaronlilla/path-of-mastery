/**
 * The Party tab's data in a build file: the `<Party>` element, read and written the way PartyTab.lua's Load and Save
 * do. Only that element is touched; everything else in the file stays byte for byte.
 *
 * The engine reads the `<ImportedBuffs>` blocks (crates/pipeline/src/party.rs). "Disable Party Effects" is kept in the
 * file as `DisableEffects="true"` on `<Party>` and the blocks stay `<ImportedBuffs>`, so upstream
 * still opens the file with its party data. The engine is given the same blocks as `<DisabledBuffs>` (`partyToEngine`),
 * which it does not read, and the file gets them back as `<ImportedBuffs>` (`partyFromEngine`).
 */
import type { PartyState } from '@pom/protocol';
import { escapeXml, unescapeXml } from './buildXml.js';

export const PARTY_DESTINATIONS = ['All', 'Party Member Stats', 'Aura', 'Curse', 'Warcry Skills', 'Link Skills', 'EnemyConditions', 'EnemyMods'] as const;
export type PartyDestination = (typeof PARTY_DESTINATIONS)[number];

/** The text fields of the tab, by the `name` the build file stores them under. */
export type PartyField = 'stats' | 'auras' | 'curses' | 'warcries' | 'links' | 'enemyCond' | 'enemyMods';

export const FIELD_NAME: Record<PartyField, string> = {
  stats: 'PartyMemberStats',
  auras: 'Aura',
  curses: 'Curse',
  warcries: 'Warcry Skills',
  links: 'Link Skills',
  enemyCond: 'EnemyConditions',
  enemyMods: 'EnemyMods',
};

export const FIELDS = Object.keys(FIELD_NAME) as PartyField[];

export interface PartyData extends PartyState {
  destination: PartyDestination;
}

export const EMPTY_PARTY: PartyData = {
  stats: '',
  auras: '',
  curses: '',
  warcries: '',
  links: '',
  enemyCond: '',
  enemyMods: '',
  destination: 'All',
  append: false,
  showAdvanced: false,
  disabled: false,
};

/** Party data from an edit's state, with an unknown destination read as All. */
export function partyFromState(s: PartyState): PartyData {
  const dest = (PARTY_DESTINATIONS as readonly string[]).includes(s.destination) ? (s.destination as PartyDestination) : 'All';
  return { ...EMPTY_PARTY, ...s, destination: dest };
}

/** Which fields a destination touches. */
export function destinationFields(d: PartyDestination): PartyField[] {
  switch (d) {
    case 'All':
      return [...FIELDS];
    case 'Party Member Stats':
      return ['stats'];
    case 'Aura':
      return ['auras'];
    case 'Curse':
      return ['curses'];
    case 'Warcry Skills':
      return ['warcries'];
    case 'Link Skills':
      return ['links'];
    case 'EnemyConditions':
      return ['enemyCond'];
    case 'EnemyMods':
      return ['enemyMods'];
  }
}

const PARTY_RE = /<Party\b[^>]*?(?:\/>|>[\s\S]*?<\/Party>)/;
const BLOCK_RE = /<(ImportedBuffs|ExportedBuffs|DisabledBuffs)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/g;

function attr(src: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(src);
  return m ? unescapeXml(m[1] ?? m[2] ?? '') : undefined;
}

interface RawBlock {
  tag: string;
  name: string;
  text: string;
}

function blocksOf(partyXml: string): RawBlock[] {
  const out: RawBlock[] = [];
  const open = /^<Party\b[^>]*?>/.exec(partyXml);
  const inner = open && !open[0].endsWith('/>') ? partyXml.slice(open[0].length) : '';
  BLOCK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BLOCK_RE.exec(inner))) {
    out.push({ tag: m[1]!, name: attr(m[2] ?? '', 'name') ?? '', text: unescapeXml((m[3] ?? '').trim()) });
  }
  return out;
}

/** The party data of a build file. A build without a `<Party>` element has the empty party. */
export function readParty(xml: string): PartyData {
  const m = PARTY_RE.exec(xml);
  if (!m) return { ...EMPTY_PARTY };
  const party = m[0];
  const head = /^<Party\b([^>]*?)\/?>/.exec(party)?.[1] ?? '';
  const out: PartyData = { ...EMPTY_PARTY };
  const dest = attr(head, 'destination');
  if (dest && (PARTY_DESTINATIONS as readonly string[]).includes(dest)) out.destination = dest as PartyDestination;
  out.append = attr(head, 'append') === 'true';
  const flagged = attr(head, 'DisableEffects') === 'true';
  out.showAdvanced = attr(head, 'ShowAdvanceTools') === 'true';
  const blocks = blocksOf(party);
  const hasImported = blocks.some((b) => b.tag === 'ImportedBuffs');
  const hasDisabled = blocks.some((b) => b.tag === 'DisabledBuffs');
  // Effects are off only when text exists solely in the disabled blocks.
  out.disabled = flagged || (hasDisabled && !hasImported);
  for (const b of blocks) {
    if (b.tag === 'ExportedBuffs') continue;
    if (b.tag === 'DisabledBuffs' && hasImported) continue;
    const f = FIELDS.find((k) => FIELD_NAME[k] === b.name);
    if (f) out[f] = b.text;
  }
  return out;
}

/** The `<ExportedBuffs>` blocks of a build file: what a party member's build offers (PartyTab.lua's import source). */
export function readExportedBuffs(xml: string): Partial<Record<PartyField, string>> {
  const m = PARTY_RE.exec(xml);
  if (!m) return {};
  const out: Partial<Record<PartyField, string>> = {};
  for (const b of blocksOf(m[0])) {
    if (b.tag !== 'ExportedBuffs') continue;
    const f = FIELDS.find((k) => FIELD_NAME[k] === b.name);
    if (f) out[f] = b.text;
  }
  return out;
}

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** The `<Party>` element for the data, in the layout upstream writes. `kept` is any `<ExportedBuffs>` text to carry over. */
function partyElement(p: PartyData, kept: string, eol: string): string {
  const tag = p.disabled ? 'DisabledBuffs' : 'ImportedBuffs';
  const attrs = `destination="${escapeXml(p.destination)}" ShowAdvanceTools="${p.showAdvanced}" append="${p.append}"${p.disabled ? ' DisableEffects="true"' : ''}`;
  const lines: string[] = [];
  for (const f of FIELDS) {
    const text = p[f];
    if (text === '') continue;
    lines.push(`\t\t<${tag} name="${escapeXml(FIELD_NAME[f])}">${eol}\t\t\t${escapeText(text).replace(/\n/g, eol)}${eol}\t\t</${tag}>`);
  }
  if (!lines.length && !kept) return `<Party ${attrs} />`;
  return `<Party ${attrs}>${eol}${lines.join(eol)}${lines.length ? eol : ''}${kept}\t</Party>`;
}

function exportedElements(blocks: readonly (readonly [string, string])[], eol: string): string {
  return blocks.map(([name, text]) => `\t\t<ExportedBuffs name="${escapeXml(name)}">${eol}\t\t\t${escapeText(text).replace(/\n/g, eol)}${eol}\t\t</ExportedBuffs>${eol}`).join('');
}

/** The build file with its `<Party>` element replaced by `p`. A build with no party and nothing to add is left alone.
 * `exported` (the engine's `<ExportedBuffs>` blocks, Export Support) replaces the blocks the text carries; `[]` drops them. */
export function writeParty(xml: string, p: PartyData, exported?: readonly (readonly [string, string])[]): string {
  const eol = xml.includes('\r\n') ? '\r\n' : '\n';
  const m = PARTY_RE.exec(xml);
  if (!m) {
    const empty = FIELDS.every((f) => p[f] === '') && p.destination === 'All' && !p.append && !p.showAdvanced && !p.disabled && !exported?.length;
    if (empty) return xml;
    const block = partyElement(p, exported ? exportedElements(exported, eol) : '', eol);
    const tree = /\r?\n?[\t ]*<Tree\b/.exec(xml);
    if (tree) return xml.slice(0, tree.index) + eol + '\t' + block + xml.slice(tree.index);
    const end = xml.lastIndexOf('</PathOfBuilding>');
    if (end < 0) return xml;
    return xml.slice(0, end) + '\t' + block + eol + xml.slice(end);
  }
  let kept = '';
  if (exported) kept = exportedElements(exported, eol);
  else {
    for (const b of blocksOf(m[0])) {
      if (b.tag === 'ExportedBuffs') kept += `\t\t<ExportedBuffs name="${escapeXml(b.name)}">${eol}\t\t\t${escapeText(b.text).replace(/\n/g, eol)}${eol}\t\t</ExportedBuffs>${eol}`;
    }
  }
  return xml.slice(0, m.index) + partyElement(p, kept, eol) + xml.slice(m.index + m[0].length);
}

/** The text a share code, a link or a saved file carries: with Export Support on, the engine's `<ExportedBuffs>` blocks;
 * with it off, none (upstream writes them only while the switch is on). */
export function withExportedBuffs(xml: string, blocks: readonly (readonly [string, string])[]): string {
  return writeParty(xml, readParty(xml), blocks);
}

// ---- The file and the engine ---------------------------------------------------------------------------------------

const PARTY_OPEN = /<Party\b([^>]*?)(\/?)>/;

/** The build text as the engine takes it: with party effects disabled, the blocks are named `<DisabledBuffs>`. */
export function partyToEngine(xml: string): string {
  const m = PARTY_RE.exec(xml);
  if (!m || !/\bDisableEffects\s*=\s*["']true["']/.test(PARTY_OPEN.exec(m[0])?.[1] ?? '')) return xml;
  const party = m[0].replace(/<(\/?)ImportedBuffs\b/g, '<$1DisabledBuffs');
  return xml.slice(0, m.index) + party + xml.slice(m.index + m[0].length);
}

/** The build text as it is saved: effects that are switched off keep their blocks as `<ImportedBuffs>` and flag `<Party>`. */
export function partyFromEngine(xml: string): string {
  const m = PARTY_RE.exec(xml);
  if (!m || !/<DisabledBuffs\b/.test(m[0]) || /<ImportedBuffs\b/.test(m[0])) return xml;
  let party = m[0].replace(/<(\/?)DisabledBuffs\b/g, '<$1ImportedBuffs');
  if (!/\bDisableEffects\s*=/.test(PARTY_OPEN.exec(party)?.[1] ?? '')) party = party.replace(/^<Party\b/, '<Party DisableEffects="true"');
  return xml.slice(0, m.index) + party + xml.slice(m.index + m[0].length);
}

// ---- Import --------------------------------------------------------------------------------------------------------

/**
 * Importing a party member's build into the tab (PartyTab.lua finishImport). `exported` is the other build's
 * `<ExportedBuffs>`. Without Append the destination is cleared first; with it the new text goes after the old.
 * Curses and links keep their own rules, as in upstream.
 */
export function importParty(cur: PartyData, exported: Partial<Record<PartyField, string>>, destination: PartyDestination, append: boolean): PartyData {
  const out: PartyData = { ...cur, destination, append, disabled: false };
  const dest = destinationFields(destination);
  const before: Partial<Record<PartyField, string>> = {};
  for (const f of dest) before[f] = cur[f];
  // Clearing: a plain import clears every destination field; Append clears only curses and links (kept in a buffer).
  for (const f of dest) {
    if (!append || f === 'curses' || f === 'links') out[f] = '';
  }
  for (const f of dest) {
    if (!(f in exported)) continue;
    let node = exported[f] ?? '';
    if (out[f] !== '') node = out[f] + '\n' + node;
    if (f === 'curses' && append && before.curses && node === '--- Curse Limit ---\n1') node = before.curses;
    if (f === 'links' && append && before.links && node === '') node = before.links;
    out[f] = node;
  }
  return out;
}

/** The fields a party member's code carries that an import to `destination` would leave out. */
export function skippedFields(exported: Partial<Record<PartyField, string>>, destination: PartyDestination): PartyField[] {
  const dest = destinationFields(destination);
  return FIELDS.filter((f) => f in exported && !dest.includes(f));
}

// ---- Rows for the tab ----------------------------------------------------------------------------------------------

export interface PartyRow {
  /** Where the row's lines start and end in the field's text (line numbers, end exclusive), so it can be removed. */
  from: number;
  to: number;
  name: string;
  /** The effect percentage of an aura, curse, warcry or link. */
  effect: number | null;
  mark: boolean;
  /** The mods, one per line, as the design words them ("+3210 to Armour", "32% more Armour"). */
  lines: string[];
  /** The same mods as the build file stores them, one per line (shown on hover). */
  raw: string[];
}

/** A mod's internal name as words: "PhysicalDamageTaken" is "Physical Damage Taken", "Condition:Tailwind" is "Tailwind". */
function statWords(name: string): string {
  const base = name.replace(/^(Condition|Multiplier|Flag):/, '').replace(/:/g, ' ');
  return base.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').trim();
}

const SIGNED = (n: number): string => (n < 0 ? '' : '+') + String(n);

/**
 * One mod line (`value|source|name|type|flags|keywordFlags|tags`) as a player reads it: "+3210 to Armour",
 * "32% more Armour", "21% increased Movement Speed". Upstream lists the raw fields instead; this is
 * the design's wording for the same data, so the raw line stays available on hover.
 */
export function describeModLine(line: string): string {
  const parts = line.split('|');
  if (parts.length < 4) return line;
  const [v, , name = '', type = '', flags = '', keywords = ''] = parts;
  const num = Number(v);
  const prefix = [flags, keywords].filter((x) => x && x !== '-').join(' ').replace(/,/g, ' ');
  // A flag such as Spell or Attack qualifies the stat: "Spell Damage", "Attack Speed".
  const stat = (prefix ? prefix.split(/\s+/).map(statWords).join(' ') + ' ' : '') + statWords(name);
  if (type === 'FLAG') return v === 'false' ? 'Not ' + stat : stat;
  if (!Number.isFinite(num)) return `${stat}: ${v}`;
  const a = Math.abs(num);
  switch (type) {
    case 'INC':
      return `${a}% ${num < 0 ? 'reduced' : 'increased'} ${stat}`;
    case 'MORE':
      return `${a}% ${num < 0 ? 'less' : 'more'} ${stat}`;
    case 'BASE':
      if (/Resist$/.test(name)) return `${SIGNED(num)}% to ${stat}ance`;
      if (/(Chance|Block|Suppress)/.test(name)) return `${SIGNED(num)}% to ${stat}`;
      return `${SIGNED(num)} to ${stat}`;
    case 'OVERRIDE':
      return `${stat} is ${num}`;
    default:
      return `${type} ${stat}: ${v}`;
  }
}

/** An enemy modifier line as the design lists it: "39|INC|PhysicalDamageTaken". */
export function describeEnemyModLine(line: string): string {
  const parts = line.split('|');
  if (parts.length < 4) return line;
  return `${parts[0]}|${parts[3]}|${parts[2]}`;
}

/** The blocks of an Aura, Curse, Warcry or Link field (PartyTab.lua ParseBuffs, text half). */
export function parseBuffRows(text: string, kind: 'Aura' | 'Curse' | 'Warcry' | 'Link'): { rows: PartyRow[]; curseLimit: number | null } {
  const lines = text === '' ? [] : text.split('\n').map((l) => l.replace(/\r$/, ''));
  const rows: PartyRow[] = [];
  let mode: 'CurseLimit' | 'Name' | 'Effect' | 'isMark' | 'Stats' = kind === 'Curse' ? 'CurseLimit' : 'Name';
  let cur: PartyRow | null = null;
  let curseLimit: number | null = null;
  const close = (at: number) => {
    if (cur) {
      cur.to = at;
      rows.push(cur);
      cur = null;
    }
  };
  lines.forEach((line, i) => {
    if (line !== '---' && line.includes('---')) return;
    if (mode === 'CurseLimit' && line !== '') {
      const n = Number(line);
      curseLimit = Number.isFinite(n) ? n : null;
      mode = 'Name';
    } else if (mode === 'Name' && line !== '') {
      close(i);
      cur = { from: i, to: i + 1, name: line.replace('_Debuff', ''), effect: null, mark: false, lines: [], raw: [] };
      mode = line === 'extraAura' || line === 'otherEffects' ? 'Stats' : 'Effect';
    } else if (mode === 'Effect') {
      const n = Number(line);
      if (cur) cur.effect = Number.isFinite(n) ? n : 0;
      mode = kind === 'Curse' ? 'isMark' : 'Stats';
    } else if (mode === 'isMark') {
      if (cur) cur.mark = line === 'true';
      mode = 'Stats';
    } else if (line === '---') {
      close(i + 1);
      mode = 'Name';
    } else if (cur && line.includes('|')) {
      const l = cur.name === 'otherEffects' ? line.split('|').slice(2).join('|') : line;
      cur.lines.push(describeModLine(l));
      cur.raw.push(l);
    }
  });
  close(lines.length);
  return { rows, curseLimit };
}

/** EnemyMods: a name line, then the mod lines under it. */
export function parseEnemyModRows(text: string): PartyRow[] {
  const lines = text === '' ? [] : text.split('\n').map((l) => l.replace(/\r$/, ''));
  const rows: PartyRow[] = [];
  let cur: PartyRow | null = null;
  lines.forEach((line, i) => {
    if (!line.includes('|')) {
      if (line === '') return;
      if (cur) cur.to = i;
      cur = { from: i, to: i + 1, name: line, effect: null, mark: false, lines: [], raw: [] };
      rows.push(cur);
    } else if (cur) {
      cur.lines.push(describeEnemyModLine(line));
      cur.raw.push(line);
      cur.to = i + 1;
    }
  });
  return rows;
}

/** The text without the row's lines. */
export function removeRow(text: string, row: Pick<PartyRow, 'from' | 'to'>): string {
  const lines = text.split('\n');
  lines.splice(row.from, row.to - row.from);
  return lines.join('\n').replace(/^\n+/, '');
}
