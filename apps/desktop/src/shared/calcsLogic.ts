/**
 * The Calcs tab's logic that needs no screen: which sections sit in which column, the build-file inputs the tab saves
 * (`<Calcs><Input .../></Calcs>`), search, and how an engine breakdown table becomes the blocks a popup draws
 * (`CalcBreakdownControl:AddBreakdownSection`). No number is calculated here; every number comes from the engine.
 */
import type { CalcDetail, CalcModTable, CalcSkillView, CalcViewRow, CalcViewSection } from '@pom/protocol';
import { escapeXml } from './buildXml.js';
import { luaPatternToRegExp } from '../renderer/tree/treeSearch.js';

// ---- sections ------------------------------------------------------------------------------------------------------

/** Offence and defence stacks: upstream's layout group 1 is offence, except the wide Damage Taken table. */
export function sectionKind(s: Pick<CalcViewSection, 'group' | 'id'>): 'offence' | 'defence' {
  return s.group === 1 && s.id !== 'DamageTaken' ? 'offence' : 'defence';
}

/** The icon and tone token each section wears. */
export const SECTION_LOOK: Record<string, { icon: string; tone: string }> = {
  HitDamage: { icon: 'melee', tone: '--stat-dps' },
  Warcries: { icon: 'zap', tone: '--stat-dps' },
  Pacts: { icon: 'sparkles', tone: '--stat-dps' },
  Dot: { icon: 'dps', tone: '--stat-dps' },
  Speed: { icon: 'speed', tone: '--stat-speed' },
  Crit: { icon: 'crit', tone: '--stat-crit' },
  Impale: { icon: 'physical', tone: '--dmg-physical' },
  SkillTypeStats: { icon: 'target', tone: '--stat-damage' },
  HitChance: { icon: 'accuracy', tone: '--stat-accuracy' },
  Bleed: { icon: 'life', tone: '--pool-life' },
  Poison: { icon: 'chaos', tone: '--dmg-chaos' },
  Ignite: { icon: 'fire', tone: '--dmg-fire' },
  Decay: { icon: 'chaos', tone: '--dmg-chaos' },
  LeechGain: { icon: 'leech', tone: '--pool-life' },
  EleAilments: { icon: 'cold', tone: '--dmg-cold' },
  MiscEffects: { icon: 'sparkle', tone: '--stat-damage' },
  Attributes: { icon: 'user', tone: '--stat-neutral' },
  Life: { icon: 'life', tone: '--pool-life' },
  Mana: { icon: 'mana', tone: '--pool-mana' },
  EnergyShield: { icon: 'energy-shield', tone: '--pool-es' },
  Ward: { icon: 'ward', tone: '--pool-ward' },
  Resist: { icon: 'resist', tone: '--dmg-fire' },
  Armour: { icon: 'armour', tone: '--stat-armour' },
  Evasion: { icon: 'evasion', tone: '--stat-evasion' },
  DamageAvoidance: { icon: 'block', tone: '--stat-block' },
  Flasks: { icon: 'flask', tone: '--stat-neutral' },
  Rage: { icon: 'crit', tone: '--pool-rage' },
  Charges: { icon: 'orb', tone: '--stat-neutral' },
  MiscDefences: { icon: 'shield-check', tone: '--stat-neutral' },
  DamageTaken: { icon: 'shield', tone: '--dmg-fire' },
};

/**
 * The small icon in front of a row (the design's Calcs tab marks the rows that are the section's headline number:
 * the same icon and colour as the sidebar shows for that stat). `sectionId` is the engine's section id and `label`
 * the row's text; the main-hand/off-hand prefix is ignored. Rows with no headline role return null.
 */
export function rowLook(sectionId: string, label: string | null): { icon: string; tone: string } | null {
  if (!label) return null;
  const l = stripCodes(label).replace(/^(MH|OH)\s+/, '').trim();
  const L = (icon: string, tone: string) => ({ icon, tone });
  switch (sectionId) {
    case 'HitDamage':
      return l === 'Skill DPS' ? L('dps', '--stat-dps') : null;
    case 'Speed':
      return /per second$/.test(l) ? L('speed', '--stat-speed') : null;
    case 'Crit':
      return l === 'Crit Chance' ? L('crit', '--stat-crit') : null;
    case 'HitChance':
      return l === 'Chance to Hit' ? L('accuracy', '--stat-accuracy') : null;
    case 'SkillTypeStats':
      return l === 'Mana Cost' ? L('mana', '--pool-mana') : null;
    case 'Attributes':
      return l === 'Strength' ? L('attr-str', '--attr-str') : l === 'Dexterity' ? L('attr-dex', '--attr-dex') : l === 'Intelligence' ? L('attr-int', '--attr-int') : null;
    case 'Life':
      return l === 'Total' ? L('life', '--pool-life') : null;
    case 'Mana':
      return l === 'Total' ? L('mana', '--pool-mana') : null;
    case 'EnergyShield':
      return l === 'Total' ? L('energy-shield', '--pool-es') : null;
    case 'Ward':
      return l === 'Total' ? L('ward', '--pool-ward') : null;
    case 'Armour':
      return l === 'Total' ? L('armour', '--stat-armour') : /^Phys\. Dmg\. Reduct/.test(l) ? L('physical', '--dmg-physical') : null;
    case 'Evasion':
      return l === 'Total' ? L('evasion', '--stat-evasion') : null;
    case 'LeechGain':
      return l === 'Life Leech Rate' ? L('leech', '--pool-life') : l === 'Mana Leech Rate' ? L('leech', '--pool-mana') : null;
    case 'Resist':
      return l === 'Fire Resist' ? L('fire', '--dmg-fire') : l === 'Cold Resist' ? L('cold', '--dmg-cold') : l === 'Lightning Resist' ? L('lightning', '--dmg-lightning') : l === 'Chaos Resist' ? L('chaos', '--dmg-chaos') : null;
    case 'DamageAvoidance':
      return l === 'Block Chance' || l === 'Spell Block Chance' ? L('block', '--stat-block') : /^Suppression Ch/.test(l) ? L('suppress', '--stat-block') : null;
    case 'DamageTaken':
      return l === 'Effective Hit Pool' ? L('ehp', '--stat-armour') : null;
    default:
      return null;
  }
}

export function lookOf(id: string): { icon: string; tone: string } {
  return SECTION_LOOK[id] ?? { icon: 'calculator', tone: '--stat-neutral' };
}

/** The sections upstream draws: a section whose flags fail is left out of the layout. */
export function shownSections(sections: CalcViewSection[]): CalcViewSection[] {
  return sections.filter((s) => s.shown);
}

/** The column titles a table-like sub-section needs: its own header row when it shows one, else the titles upstream defines. */
export function columnTitles(sub: CalcViewSection['subSections'][number]): string[] | null {
  if (sub.rows.some(isHeaderRow)) return null;
  const multi = sub.rows.some((r) => r.cols > 1 && r.label !== null);
  return multi && sub.columns && sub.columns.length > 1 ? sub.columns : null;
}

/** A section's card title: its first sub-section's label. */
export function sectionTitle(s: CalcViewSection): string {
  return s.subSections[0]?.label ?? s.id;
}

export const collapseKey = (id: string, index: number): string => `${id}:${index}`;

/** True when the cell's popup is the breakdown of this stat (a stat id such as ChaosMaximumHitTaken). */
export const cellIsStat = (details: CalcDetail[] | undefined, stat: string): boolean => !!details?.some((d) => d.breakdown === stat);

/** Where a stat sits on the Calcs tab, found in a view with every sub-section open (a collapsed one carries no rows). */
export function findStatCell(sections: CalcViewSection[], stat: string): { sid: string; sub: number } | null {
  for (const s of shownSections(sections)) {
    const sub = s.subSections.findIndex((x) => x.rows.some((r) => r.cellDetails.some((d) => cellIsStat(d, stat))));
    if (sub >= 0) return { sid: s.id, sub };
  }
  return null;
}

/** `^7`, `^xRRGGBB` and the other colour codes taken out. */
export function stripCodes(s: string): string {
  return s.replace(/\^x[0-9a-fA-F]{6}|\^[0-9]/g, '');
}

const patCache = new Map<string, RegExp | null>();

/** `CalcsTab:SearchMatch`: the lower-cased search text is a Lua pattern found anywhere in the lower-cased text. A malformed pattern matches nothing. */
export function searchMatch(text: string | null | undefined, q: string): boolean {
  if (q.length === 0 || !text) return false;
  const key = q.toLowerCase();
  let re = patCache.get(key);
  if (re === undefined) {
    re = luaPatternToRegExp(key);
    if (patCache.size > 200) patCache.clear();
    patCache.set(key, re);
  }
  return !!re && re.test(stripCodes(text).toLowerCase());
}

/** Whether a sub-section's header or any row label matches the search (rows the section shows). */
export function sectionMatches(s: CalcViewSection, q: string): boolean {
  return s.subSections.some((ss) => searchMatch(ss.label, q) || ss.rows.some((r) => searchMatch(r.label, q)));
}

/** Per section id, per kept sub-section index: the kept row indexes, or null for every row. Sections with nothing to show are absent. */
export type SearchKeep = Map<number, number[] | null>;

/** The search as a filter: a matching section title keeps the whole section, a matching sub-section heading keeps its rows, otherwise only matching rows stay. Indexes stay upstream ones. */
export function searchFilter(sections: CalcViewSection[], q: string): Map<string, SearchKeep> {
  const out = new Map<string, SearchKeep>();
  for (const s of sections) {
    const keep: SearchKeep = new Map();
    const all = searchMatch(sectionTitle(s), q);
    s.subSections.forEach((ss, i) => {
      if (all || searchMatch(ss.label, q)) return void keep.set(i, null);
      const rows = ss.rows.flatMap((r, ri) => (searchMatch(r.label, q) ? [ri] : []));
      if (rows.length) keep.set(i, rows);
    });
    if (keep.size) out.set(s.id, keep);
  }
  return out;
}

/** A header row of a table: no label, every cell a column name ("Physical:"). */
export const isHeaderRow = (r: CalcViewRow): boolean => r.label === null;

// ---- the build file's Calcs inputs ------------------------------------------------------------------------------------

export interface CalcsInputs {
  skillNumber: number;
  showMinion: boolean;
  buffMode: string;
}

const inputRe = /<Input\b((?:[^>"']|"[^"]*"|'[^']*')*?)\/>/g;

function calcsBlock(xml: string): { start: number; end: number; inner: string; innerStart: number } | null {
  const m = /<Calcs\b[^>]*?(\/>|>)/.exec(xml);
  if (!m) return null;
  if (m[1] === '/>') return { start: m.index, end: m.index + m[0].length, inner: '', innerStart: -1 };
  const innerStart = m.index + m[0].length;
  const close = xml.indexOf('</Calcs>', innerStart);
  if (close < 0) return null;
  return { start: m.index, end: close + '</Calcs>'.length, inner: xml.slice(innerStart, close), innerStart };
}

function attrOf(src: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(src);
  return m ? m[1] : undefined;
}

/** The Calcs tab's saved inputs: the socket group, the minion switch and the calculation mode (`CalcsTab:Load`). */
export function readCalcsInputs(xml: string): CalcsInputs {
  const out: CalcsInputs = { skillNumber: 1, showMinion: false, buffMode: 'EFFECTIVE' };
  const b = calcsBlock(xml);
  if (!b) return out;
  for (const m of b.inner.matchAll(inputRe)) {
    const name = attrOf(m[1]!, 'name');
    if (name === 'skill_number') {
      const n = Number(attrOf(m[1]!, 'number'));
      if (Number.isFinite(n) && n >= 1) out.skillNumber = Math.floor(n);
    } else if (name === 'showMinion') out.showMinion = attrOf(m[1]!, 'boolean') === 'true';
    else if (name === 'misc_buffMode') out.buffMode = attrOf(m[1]!, 'string') ?? 'EFFECTIVE';
  }
  return out;
}

export type CalcsInputValue = { number: number } | { string: string } | { boolean: boolean };

/** Sets one saved Calcs input (replacing an earlier one of that name, adding the `<Calcs>` element when the file has none). */
export function setCalcsInput(xml: string, name: string, value: CalcsInputValue): string {
  const [kind, v] = Object.entries(value)[0]!;
  const el = `<Input name="${escapeXml(name)}" ${kind}="${escapeXml(String(v))}"/>`;
  const b = calcsBlock(xml);
  if (!b) {
    const at = xml.lastIndexOf('</PathOfBuilding>');
    const add = `<Calcs>${el}</Calcs>`;
    return at < 0 ? xml + add : xml.slice(0, at) + add + xml.slice(at);
  }
  if (b.innerStart < 0) return xml.slice(0, b.start) + `<Calcs>${el}</Calcs>` + xml.slice(b.end);
  let replaced = false;
  const inner = b.inner.replace(inputRe, (all, attrs: string) => {
    if (attrOf(attrs, 'name') !== name) return all;
    if (replaced) return '';
    replaced = true;
    return el;
  });
  return xml.slice(0, b.innerStart) + (replaced ? inner : el + inner) + xml.slice(b.innerStart + b.inner.length);
}

/** The skill controls that show for the Calcs skill, by upstream's rules (`CalcsTab` rows and `RefreshSkillSelectControls`). */
export interface SkillControls {
  part: boolean;
  stages: boolean;
  mines: boolean;
  showMinion: boolean;
  minion: boolean;
  spectre: boolean;
  minionSkill: boolean;
}

/**
 * Whether the Calcs tab shows another skill (socket group, active skill or skill part) than the sidebar's main skill.
 * Upstream keeps the two separate (`skill_number`, `mainActiveSkillCalcs`, `skillPartCalcs` against `mainSocketGroup`,
 * `mainActiveSkill`, `skillPart`), so a saved build can open with them apart; the tab says so and offers the main skill.
 */
export function calcsDiffersFromMain(main: { group: number; active: number; part: number }, calcs: { group: number; active: number; part: number }): boolean {
  return main.group !== calcs.group || main.active !== calcs.active || main.part !== calcs.part;
}

export function skillControls(v: CalcSkillView | null): SkillControls {
  const none: SkillControls = { part: false, stages: false, mines: false, showMinion: false, minion: false, spectre: false, minionSkill: false };
  if (!v) return none;
  const player = new Set(v.playerFlags);
  const shown = new Set(v.flags);
  const multiPart = v.parts.length > 1;
  return {
    part: multiPart && player.has('multiPart'),
    stages: player.has('multiStage') && ((multiPart && v.partHasStages) || !multiPart),
    mines: player.has('mine'),
    showMinion: shown.has('haveMinion') || v.haveMinion,
    minion: shown.has('minion') || v.minions.length > 0,
    spectre: shown.has('spectre') || v.spectre,
    minionSkill: v.minionSkills.length > 0 && (shown.has('haveMinion') || v.haveMinion),
  };
}

// ---- numbers in popup text ------------------------------------------------------------------------------------------------

export interface NumFormat {
  thousands: boolean;
  thousandsSeparator: string;
  decimalSeparator: string;
}

export const DEFAULT_NUM_FORMAT: NumFormat = { thousands: true, thousandsSeparator: ',', decimalSeparator: '.' };

/**
 * `formatNumSep`: groups the digits of every number in a line by thousands ("1234.56" to "1,234.56") and swaps the
 * decimal separator, leaving colour codes (`^x......`, `^7`) alone.
 */
export function formatNumSep(str: string, fmt: NumFormat = DEFAULT_NUM_FORMAT): string {
  const re = /(\^?x?[0-9A-Fa-f]?[0-9A-Fa-f]?[0-9A-Fa-f]?[0-9A-Fa-f]?[0-9A-Fa-f]?[0-9A-Fa-f]?-?\d+\.?\d+)/g;
  return str.replace(re, (m) => {
    const colour = /(\^x[0-9A-Fa-f]{6})/.exec(m)?.[1] ?? /(\^\d)/.exec(m)?.[1] ?? '';
    const body = m.replace(/(\^x[0-9A-Fa-f]{6})/, '').replace(/(\^\d)/, '');
    if (body === '' || (colour === '' && m.includes('^'))) return m;
    const mm = /(-?)(\d+)(\.?\d*)/.exec(body);
    if (!mm) return m;
    let integer = mm[2]!;
    if (fmt.thousands && fmt.thousandsSeparator !== '') {
      integer = integer.replace(/\B(?=(\d{3})+(?!\d))/g, fmt.thousandsSeparator);
    }
    return colour + mm[1] + integer + mm[3]!.replace('.', fmt.decimalSeparator);
  });
}

/** Lua's `tostring` for a number (14 significant digits). */
export function luaToString(v: unknown): string {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return v > 0 ? 'inf' : v < 0 ? '-inf' : 'nan';
    return String(Number(v.toPrecision(14)));
  }
  return String(v);
}

// ---- breakdown tables ---------------------------------------------------------------------------------------------------------

export interface PopupColumn {
  label: string;
  key: string;
  right?: boolean;
}

export type PopupBlock =
  | { kind: 'text'; lines: string[] }
  | { kind: 'table'; label?: string; footer?: string; cols: PopupColumn[]; rows: Record<string, string>[]; source?: boolean }
  | { kind: 'radius'; radius: number }
  | { kind: 'mods'; table: CalcModTable };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `actor.breakdown[key]`, where `Namespace.Name` reads the table inside `Namespace` (`MainHand.Speed`). */
export function lookupBreakdown(tables: Record<string, unknown> | null | undefined, key: string): unknown {
  if (!tables) return undefined;
  const dot = /^([A-Za-z]+)\.([A-Za-z]+)$/.exec(key);
  if (dot) {
    const ns = tables[dot[1]!];
    return isObj(ns) ? ns[dot[2]!] : undefined;
  }
  return tables[key];
}

/** The text lines of a table: its array part (a JSON array, or an object keyed "1", "2", ...). */
export function textLines(t: unknown): string[] {
  if (Array.isArray(t)) return t.filter((x) => typeof x === 'string' || typeof x === 'number').map(String);
  if (!isObj(t)) return [];
  const keys = Object.keys(t).filter((k) => /^\d+$/.test(k)).sort((a, b) => Number(a) - Number(b));
  return keys.map((k) => t[k]).filter((x) => typeof x === 'string' || typeof x === 'number').map(String);
}

const RESERVATION_COLS: PopupColumn[] = [
  { label: 'Skill', key: 'skillName' },
  { label: 'Base', key: 'base' },
  { label: 'MCM', key: 'mult' },
  { label: 'More/less', key: 'more' },
  { label: 'Inc/red', key: 'inc' },
  { label: 'Efficiency', key: 'efficiency' },
  { label: 'Efficiency More/less', key: 'efficiencyMore' },
  { label: 'Reservation', key: 'total' },
];

const DAMAGE_TYPE_COLS: PopupColumn[] = [
  { label: 'From', key: 'source', right: true },
  { label: 'Base', key: 'base' },
  { label: 'Inc/red', key: 'inc' },
  { label: 'More/less', key: 'more' },
  { label: 'Converted Damage', key: 'convSrc' },
  { label: 'Total', key: 'total' },
  { label: 'Conversion', key: 'convDst' },
  { label: 'Gain', key: 'gainDst' },
];

const SLOT_COLS: PopupColumn[] = [
  { label: 'Base', key: 'base', right: true },
  { label: 'Inc/red', key: 'inc' },
  { label: 'More/less', key: 'more' },
  { label: 'Total', key: 'total', right: true },
  { label: 'Source', key: 'source' },
  { label: 'Name', key: 'sourceLabel' },
];

const SLOT_GEAR_COLS: PopupColumn[] = [
  { label: 'Value', key: 'base', right: true },
  { label: 'Source', key: 'source' },
  { label: 'Name', key: 'sourceLabel' },
];

function stringRows(rows: unknown[], keys: string[]): Record<string, string>[] {
  return rows.filter(isObj).map((r) => {
    const o: Record<string, string> = {};
    for (const k of Object.keys(r)) {
      const v = r[k];
      if (v === undefined || v === null || v === false || typeof v === 'object') continue;
      o[k] = luaToString(v);
    }
    for (const k of keys) if (!(k in o) && r[k] !== undefined && r[k] !== false && r[k] !== null && typeof r[k] !== 'object') o[k] = luaToString(r[k]);
    return o;
  });
}

/** Lua's `a > b` between two table values: numbers numerically, strings by bytes. */
function luaGreater(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return a > b;
  return String(a) > String(b);
}

export interface SlotItems {
  /** The item in each equipment slot, for the Name column of a slots table. */
  (slot: string): { name: string; rarity: string; id: number } | null;
}

/**
 * The blocks one `breakdown` entry draws (`CalcBreakdownControl:AddBreakdownSection`): its text lines, the radius, the
 * generic rows table, the reservation, damage-type and slots tables.
 */
export function breakdownBlocks(tbl: unknown, detail: CalcDetail, slotItem?: SlotItems): PopupBlock[] {
  const out: PopupBlock[] = [];
  if (tbl === undefined || tbl === null) return out;
  const lines = textLines(tbl);
  if (lines.length > 0) out.push({ kind: 'text', lines });
  if (!isObj(tbl)) return out;
  if (typeof tbl.radius === 'number') out.push({ kind: 'radius', radius: tbl.radius });
  if (Array.isArray(tbl.rowList) && tbl.rowList.length > 0 && Array.isArray(tbl.colList) && tbl.colList.length > 0) {
    const cols = (tbl.colList as Obj[]).map((c) => ({ label: String(c.label ?? ''), key: String(c.key ?? ''), right: !!c.right }));
    let rows = (tbl.rowList as Obj[]).slice();
    const colKey = cols[0]!.key;
    // Ailment tables keep upstream's order; the others sort by their first column, largest first.
    if (tbl.source) {
      rows = rows.sort((a, b) => (typeof a.reqNum === 'number' && typeof b.reqNum === 'number' ? b.reqNum - a.reqNum : luaGreater(a[colKey], b[colKey]) ? -1 : luaGreater(b[colKey], a[colKey]) ? 1 : 0));
    }
    out.push({ kind: 'table', label: typeof tbl.label === 'string' ? tbl.label : undefined, footer: typeof tbl.footer === 'string' ? tbl.footer : undefined, cols, rows: stringRows(rows, cols.map((c) => c.key)), source: !!tbl.source });
  }
  if (Array.isArray(tbl.reservations) && tbl.reservations.length > 0) {
    out.push({ kind: 'table', cols: RESERVATION_COLS, rows: stringRows(tbl.reservations, RESERVATION_COLS.map((c) => c.key)) });
  }
  if (Array.isArray(tbl.damageTypes) && tbl.damageTypes.length > 0) {
    out.push({ kind: 'table', cols: DAMAGE_TYPE_COLS, rows: stringRows(tbl.damageTypes, DAMAGE_TYPE_COLS.map((c) => c.key)) });
  }
  if (Array.isArray(tbl.slots) && tbl.slots.length > 0) {
    let slots = (tbl.slots as Obj[]).slice();
    const gear = !!detail.gearOnly;
    const named = (r: Obj): { name: string; rarity: string; id: number } | null => (typeof r.source === 'string' && slotItem ? slotItem(r.source) : null);
    if (gear) slots = slots.filter((r) => named(r) !== null);
    slots.sort((a, b) => Number(b.base ?? 0) - Number(a.base ?? 0));
    const cols = gear ? SLOT_GEAR_COLS : SLOT_COLS;
    const rows = stringRows(slots, cols.map((c) => c.key)).map((r, i) => {
      const it = named(slots[i]!);
      const label = it ? it.name : typeof slots[i]!.sourceName === 'string' ? (slots[i]!.sourceName as string) : '';
      return label ? { ...r, sourceLabel: label, _rarity: it?.rarity ?? '', _item: it ? String(it.id) : '' } : r;
    });
    out.push({ kind: 'table', cols, rows });
  }
  return out;
}

/** Whether a table cell is drawn with thousands separators (`DrawBreakdownTable`'s letters / " to " / parentheses rule). */
export function groupsDigits(text: string): boolean {
  const letters = (text.match(/[A-Za-z]/g) ?? []).length;
  return letters === 0 || / to /.test(text) || /\([^()]*\)/.test(text);
}

/** The popup's value colour for a modifier row: sign decides, as the design shows. */
export function modValueTone(v: string): 'pos' | 'neg' | 'plain' {
  if (/^[−-]/.test(v) || /reduced|less/.test(v)) return 'neg';
  if (/^\+|increased|more|^Override|^True/.test(v)) return 'pos';
  return 'plain';
}

// ---- the Spectre Library (`<Build><Spectre id=".."/></Build>`) ------------------------------------------------------------

function buildBlock(xml: string): { open: [number, number]; selfClosing: boolean; close: number } | null {
  const m = /<Build\b((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/.exec(xml);
  if (!m) return null;
  const selfClosing = m[2] === '/';
  const openEnd = m.index + m[0].length;
  if (selfClosing) return { open: [m.index, openEnd], selfClosing, close: openEnd };
  const close = xml.indexOf('</Build>', openEnd);
  return close < 0 ? null : { open: [m.index, openEnd], selfClosing, close };
}

/** The Spectre Library of the build file, in order. */
export function readSpectres(xml: string): string[] {
  const b = buildBlock(xml);
  if (!b || b.selfClosing) return [];
  return [...xml.slice(b.open[1], b.close).matchAll(/<Spectre\s+id="([^"]*)"\s*\/>/g)].map((m) => m[1]!);
}

/** The build file with its Spectre Library replaced by `ids` (`Build:Save` writes them as the Build element's children). */
export function setSpectres(xml: string, ids: string[]): string {
  const b = buildBlock(xml);
  if (!b) return xml;
  const els = ids.map((id) => `<Spectre id="${escapeXml(id)}"/>`).join('');
  if (b.selfClosing) {
    if (!ids.length) return xml;
    const tag = xml.slice(b.open[0], b.open[1]).replace(/\s*\/>$/, '>');
    return xml.slice(0, b.open[0]) + tag + els + '</Build>' + xml.slice(b.open[1]);
  }
  const inner = xml.slice(b.open[1], b.close).replace(/<Spectre\s+id="[^"]*"\s*\/>/g, '');
  return xml.slice(0, b.open[1]) + inner + els + xml.slice(b.close);
}
