import type { CharacterRow, ImportParts } from '../../shared/characterImport.js';
import { activeSetOf, addItem, deleteItems, newItemSet, readItems, setActiveSet, setItemText, setJewel, setSlot } from '../../shared/itemsXml.js';
import { escapeXml, parseXml, type XmlNode } from '../../shared/buildXml.js';
import { importItems, type GemOut, type GItem, type GroupOut, type ItemData, type Placement } from './items.js';

/**
 * Puts a character from the character window into build text: the passive tree and its jewels, the equipped items and
 * the skill gems. This follows `ImportTab:ImportPassiveTreeAndJewels` and `ImportTab:ImportItemsAndSkills`; the
 * result goes back to the engine as one new text of the build, so it is a single undo step.
 */

export interface TreeInfo {
  /** By class id; `ascendancies[i]` is the name of ascendancy id i + 1. */
  classes: { name: string; ascendancies: string[] }[];
  jewelSlots: number[];
  nodes: Record<string, { type?: string; ascendancyName?: string; isMultipleChoiceOption?: boolean }>;
  /** Alternate ascendancy (bloodline) name to its ascendancy id. */
  secondaryAscend: Record<string, number>;
  tattoos: Record<string, { dn: string; icon: string; activeEffectImage: string; sd: string[] }>;
}

export interface ConvertData {
  items: ItemData;
  /** The tree of a version; the latest is the one a character is imported to. */
  tree: (version: string) => TreeInfo;
  latestTree: string;
  hasTree: (version: string) => boolean;
}

export interface PassivesJson {
  hashes?: number[];
  hashes_ex?: number[];
  /** Socket id to `{ type, radius, subgraph }`: the subgraph a socketed cluster jewel made (`hashes_ex` names its nodes). */
  jewel_data?: Record<string, unknown>;
  mastery_effects?: Record<string, number>;
  skill_overrides?: Record<string, { name?: string }>;
  alternate_ascendancy?: number | string;
  bandit_choice?: string;
  pantheon_major?: string;
  pantheon_minor?: string;
  items?: GItem[];
}

export interface ItemsJson {
  items?: GItem[];
  guardian?: GItem[];
}

export interface Bundle {
  character: CharacterRow;
  passives?: PassivesJson;
  items?: ItemsJson;
}

// ---- small text helpers ----------------------------------------------------------------------------------------

const eolOf = (xml: string) => (xml.includes('\r\n') ? '\r\n' : '\n');

function serialize(n: XmlNode, indent: string, eol: string): string {
  const attrs = Object.entries(n.attrs)
    .map(([k, v]) => ` ${k}="${escapeXml(v)}"`)
    .join('');
  const text = n.text.trim() === '' ? '' : n.text;
  if (!n.children.length && !text) return `<${n.tag}${attrs} />`;
  if (!n.children.length) return `<${n.tag}${attrs}>${escapeXml(text).replace(/&quot;/g, '"')}</${n.tag}>`;
  const inner = n.children.map((c) => `${indent}\t${serialize(c, indent + '\t', eol)}`).join(eol);
  return `<${n.tag}${attrs}>${eol}${inner}${eol}${indent}</${n.tag}>`;
}

/** The first element of that name at any depth, as [start, end) in the text. */
function findElement(xml: string, tag: string, from = 0): { start: number; end: number } | null {
  const open = new RegExp(`<${tag}\\b[^>]*?(/?)>`, 'g');
  open.lastIndex = from;
  const m = open.exec(xml);
  if (!m) return null;
  if (m[1] === '/') return { start: m.index, end: m.index + m[0].length };
  const close = xml.indexOf(`</${tag}>`, m.index + m[0].length);
  if (close < 0) return null;
  return { start: m.index, end: close + tag.length + 3 };
}

function setBuildAttrs(xml: string, attrs: Record<string, string>): string {
  return xml.replace(/<Build\b([^>]*?)(\/?)>/, (_m, a: string, slash: string) => {
    let s = a;
    for (const [k, v] of Object.entries(attrs)) {
      const re = new RegExp(`(\\s${k}=)("[^"]*"|'[^']*')`);
      s = re.test(s) ? s.replace(re, `$1"${escapeXml(v)}"`) : `${s} ${k}="${escapeXml(v)}"`;
    }
    return `<Build${s}${slash}>`;
  });
}

/** Sets inputs in the active config set (or the legacy Config element). */
function setConfigInputs(xml: string, inputs: Record<string, { string?: string; number?: number }>): string {
  const r = findElement(xml, 'Config');
  const eol = eolOf(xml);
  if (!r) return xml;
  const cfg = parseXml(xml.slice(r.start, r.end));
  const activeId = cfg.attrs.activeConfigSet ?? '1';
  const sets = cfg.children.filter((c) => c.tag === 'ConfigSet');
  const holder = sets.length ? (sets.find((s) => (s.attrs.id ?? '1') === activeId) ?? sets[0]!) : cfg;
  for (const [name, v] of Object.entries(inputs)) {
    holder.children = holder.children.filter((c) => !(c.tag === 'Input' && c.attrs.name === name));
    holder.children.push({ tag: 'Input', attrs: { name, ...(v.string !== undefined ? { string: v.string } : {}), ...(v.number !== undefined ? { number: String(v.number) } : {}) }, children: [], text: '' });
  }
  return xml.slice(0, r.start) + serialize(cfg, '\t', eol) + xml.slice(r.end);
}

// ---- tree ------------------------------------------------------------------------------------------------------

/** Upstream's act estimate (`Build:EstimatePlayerProgress`): the resistance penalty a character of this size is under. */
const ACTS: [number, number][] = [
  [1, 0],
  [12, 2],
  [22, 4],
  [32, 6],
  [40, 7],
  [44, 9],
  [50, 12],
  [54, 15],
  [60, 18],
  [64, 20],
  [67, 23],
];

export function estimateAct(pointsUsed: number): { act: number | 'Endgame'; level: number } {
  let act = 0;
  let level = 1;
  do {
    act++;
    level = Math.min(Math.max(pointsUsed + 1 - ACTS[act - 1]![1], ACTS[act - 1]![0]), 100);
  } while (act < 11 && level > ACTS[act]![0]);
  return { act: level < 90 && act <= 10 ? act : 'Endgame', level };
}

/** The resistance penalty setting of upstream after a character import: None, Act 5 (-30%) or the default Act 10 (-60%). */
export function resistancePenaltyFor(act: number | 'Endgame'): number | null {
  if (act === 'Endgame') return null;
  if (act < 5) return 0;
  if (act > 5 && act < 11) return -30;
  return null;
}

function countPoints(hashes: number[], tree: TreeInfo): number {
  let used = 0;
  for (const h of hashes) {
    const n = tree.nodes[String(h)];
    if (!n) {
      // A node that only exists once a cluster jewel is socketed: it still costs a point.
      if (h >= 65536) used++;
      continue;
    }
    if (n.type === 'ClassStart' || n.type === 'AscendClassStart') continue;
    if (!n.ascendancyName) used++;
  }
  return used;
}

function resolveClass(tree: TreeInfo, name: string): { classId: number; ascendClassId: number } | null {
  for (let c = 0; c < tree.classes.length; c++) {
    const k = tree.classes[c]!;
    if (k.name === name) return { classId: c, ascendClassId: 0 };
    const i = k.ascendancies.indexOf(name);
    if (i >= 0) return { classId: c, ascendClassId: i + 1 };
  }
  return null;
}

function activeSpecRange(xml: string): { start: number; end: number } | null {
  const tree = findElement(xml, 'Tree');
  if (!tree) return null;
  const active = parseInt(/<Tree\b[^>]*\bactiveSpec="(\d+)"/.exec(xml)?.[1] ?? '1', 10) || 1;
  const specRe = /<Spec\b[^>]*?(\/?)>/g;
  specRe.lastIndex = tree.start;
  const specs: { start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = specRe.exec(xml)) && m.index < tree.end) {
    if (m[1] === '/') specs.push({ start: m.index, end: m.index + m[0].length });
    else {
      const close = xml.indexOf('</Spec>', m.index);
      specs.push({ start: m.index, end: close < 0 ? tree.end : close + 7 });
    }
  }
  return specs[active - 1] ?? specs[0] ?? null;
}

/** Adds node ids to the `nodes=` list of the active spec (the ones already in it stay as they are). */
export function appendSpecNodes(xml: string, ids: number[]): string {
  const range = activeSpecRange(xml);
  if (!range || !ids.length) return xml;
  const old = xml.slice(range.start, range.end);
  const open = /<Spec\b[^>]*?\/?>/.exec(old);
  if (!open) return xml;
  const tag = open[0];
  const m = /(\bnodes=")([^"]*)"/.exec(tag);
  if (!m) return xml;
  const have = new Set(m[2]!.split(',').filter(Boolean).map(Number));
  const add = ids.filter((i) => !have.has(i));
  if (!add.length) return xml;
  const joined = m[2] ? `${m[2]},${add.join(',')}` : add.join(',');
  const next = tag.replace(m[0], `${m[1]}${joined}"`);
  return xml.slice(0, range.start) + next + old.slice(tag.length) + xml.slice(range.end);
}

function applyTree(xml: string, b: Bundle, p: ImportParts, d: ConvertData, notes: string[]): string {
  const pass = b.passives!;
  const league = b.character.league ?? '';
  const ruthless = /Ruthless/.test(league) ? '_ruthless' : '';
  const latest = d.latestTree;
  const latestInfo = d.tree(latest);
  const known = resolveClass(latestInfo, b.character.class);
  let version = latest + ruthless + (known ? '' : '_alternate');
  if (!d.hasTree(version)) {
    notes.push(`The tree ${version.replace(/_/g, '.')} is not in this app, so the current tree is used.`);
    version = latest + ruthless;
    if (!d.hasTree(version)) version = latest;
  }
  const tree = d.tree(version);
  const cls = resolveClass(tree, b.character.class) ?? known ?? { classId: Math.max(0, b.character.classId ?? 0), ascendClassId: 0 };
  let secondary = 0;
  const alt = pass.alternate_ascendancy;
  if (alt !== undefined && alt !== null && alt !== 0) secondary = typeof alt === 'string' ? (tree.secondaryAscend[alt] ?? 0) : alt;
  const hashes = (pass.hashes ?? []).filter((h) => Number.isFinite(h));
  const masteryEffects = Object.entries(pass.mastery_effects ?? {})
    .map(([k, v]) => `{${k},${v}}`)
    .join(',');

  // Tattoos (replaced nodes) are written as the build file does.
  const eol = eolOf(xml);
  const overrides: string[] = [];
  for (const [nodeId, o] of Object.entries(pass.skill_overrides ?? {})) {
    const t = tree.tattoos[o?.name ?? ''];
    if (!t) {
      notes.push(`A tattoo (${o?.name ?? 'unknown'}) is not in this app's data and was left out.`);
      continue;
    }
    overrides.push(`\t\t\t\t<Override nodeId="${nodeId}" icon="${escapeXml(t.icon)}" activeEffectImage="${escapeXml(t.activeEffectImage)}" dn="${escapeXml(t.dn)}">${escapeXml(t.sd.join('\n'))}</Override>`);
  }

  if (p.deleteJewels) xml = deleteJewelItems(xml);
  const range = activeSpecRange(xml);
  if (!range) return xml;
  const old = xml.slice(range.start, range.end);
  const title = /<Spec\b[^>]*?\btitle="([^"]*)"/.exec(old)?.[1];
  const sockets = /<Sockets\b[\s\S]*?<\/Sockets>|<Sockets\b[^>]*?\/>/.exec(old)?.[0];
  const attrs = [
    ...(title !== undefined ? [`title="${title}"`] : []),
    `treeVersion="${version}"`,
    'clusterHashFormatVersion="2"',
    `classId="${cls.classId}"`,
    `ascendClassId="${cls.ascendClassId}"`,
    `secondaryAscendClassId="${secondary}"`,
    `nodes="${hashes.join(',')}"`,
    `masteryEffects="${masteryEffects}"`,
  ].join(' ');
  const spec = [`<Spec ${attrs}>`, ...(sockets ? [`\t\t\t${sockets}`] : []), ...(overrides.length ? ['\t\t\t<Overrides>', ...overrides, '\t\t\t</Overrides>'] : []), '\t\t</Spec>'].join(eol);
  xml = xml.slice(0, range.start) + spec + xml.slice(range.end);

  // The character's level and the quest choices that follow from the tree.
  const level = b.character.level || 100;
  xml = setBuildAttrs(xml, { level: String(level), characterLevelAutoMode: 'false', className: tree && tree.classes[cls.classId]?.name ? tree.classes[cls.classId]!.name : b.character.class, ascendClassName: cls.ascendClassId > 0 ? (tree.classes[cls.classId]?.ascendancies[cls.ascendClassId - 1] ?? 'None') : 'None' });
  const inputs: Record<string, { string?: string; number?: number }> = {};
  const penalty = resistancePenaltyFor(estimateAct(countPoints(hashes, tree)).act);
  inputs.resistancePenalty = penalty === null ? { number: -60 } : { number: penalty };
  const bandit = pass.bandit_choice;
  if (bandit !== undefined) {
    const v = bandit === 'Eramir' || !bandit ? 'None' : bandit;
    inputs.bandit = { string: v };
    xml = setBuildAttrs(xml, { bandit: v });
  }
  if (pass.pantheon_major !== undefined) {
    inputs.pantheonMajorGod = { string: pass.pantheon_major || 'None' };
    xml = setBuildAttrs(xml, { pantheonMajorGod: pass.pantheon_major || 'None' });
  }
  if (pass.pantheon_minor !== undefined) {
    inputs.pantheonMinorGod = { string: pass.pantheon_minor || 'None' };
    xml = setBuildAttrs(xml, { pantheonMinorGod: pass.pantheon_minor || 'None' });
  }
  xml = setConfigInputs(xml, inputs);
  notes.push(`Passive tree imported: ${hashes.length} nodes, ${tree.classes[cls.classId]?.name ?? b.character.class}${cls.ascendClassId ? ' ' + (tree.classes[cls.classId]?.ascendancies[cls.ascendClassId - 1] ?? '') : ''}, level ${level}.`);

  if (p.jewels && pass.items?.length) {
    const r = importItems(pass.items, d.items, tree.jewelSlots, { ignoreWeaponSwap: false });
    xml = place(xml, r.placements);
    for (const s of r.skipped) notes.push(`A jewel was left out because its base is not known: ${s}.`);
    notes.push(`Jewels imported: ${r.placements.filter((x) => x.jewelNode !== undefined).length}.`);
  }
  return xml;
}

/** Deletes every item that sits in a jewel socket of the tree. */
function deleteJewelItems(xml: string): string {
  const m = readItems(xml);
  const spec = m.specs[m.activeSpec - 1] ?? m.specs[0];
  const ids = [...(spec?.sockets.values() ?? [])].filter((i) => i > 0);
  return ids.length ? deleteItems(xml, ids) : xml;
}

// ---- items -----------------------------------------------------------------------------------------------------

function uniqueIdOf(text: string): string | undefined {
  return /^Unique ID: (.+)$/m.exec(text)?.[1]?.trim();
}

/** Adds the items (an item already in the build with the same id is overwritten) and puts each in its slot. */
function place(xml: string, placements: Placement[]): string {
  const activeBefore = readItems(xml).activeSet;
  for (const pl of placements) {
    const have = readItems(xml).items.find((i) => pl.uniqueId && uniqueIdOf(i.text) === pl.uniqueId);
    let id: number;
    if (have) {
      id = have.id;
      xml = setItemText(xml, id, pl.raw);
    } else {
      const r = addItem(xml, pl.raw);
      xml = r.xml;
      id = r.id;
    }
    if (pl.jewelNode !== undefined) xml = setJewel(xml, pl.jewelNode, id);
    else if (pl.slot) {
      if (pl.guardian) {
        const { xml: x1, id: setId } = guardianSet(xml);
        xml = setSlot(setActiveSet(x1, setId), pl.slot, id);
      } else xml = setSlot(xml, pl.slot, id);
    }
    if (pl.guardian) xml = setActiveSet(xml, activeBefore);
  }
  return xml;
}

const GUARD_SET = 'Animate Guardian';

function guardianSet(xml: string): { xml: string; id: number } {
  const m = readItems(xml);
  const have = m.sets.find((s) => s.title === GUARD_SET);
  if (have) return { xml, id: have.id };
  return newItemSet(xml, GUARD_SET);
}

// ---- skills ----------------------------------------------------------------------------------------------------

const GROUP_STATE = ['enabled', 'includeInFullDPS', 'groupCount', 'label', 'mainActiveSkill', 'mainActiveSkillCalcs'];
const GEM_STATE = ['enabled', 'count', 'skillPart', 'skillPartCalcs', 'skillStageCount', 'skillStageCountCalcs', 'skillMineCount', 'skillMineCountCalcs', 'skillMinion', 'skillMinionCalcs', 'skillMinionItemSet', 'skillMinionItemSetCalcs', 'skillMinionSkill', 'skillMinionSkillCalcs', 'enableGlobal1', 'enableGlobal2'];

function gemNode(g: GemOut): XmlNode {
  return {
    tag: 'Gem',
    attrs: {
      nameSpec: g.row.name,
      skillId: g.row.grantedEffectId,
      gemId: g.row.gameId,
      ...(g.row.variantId ? { variantId: g.row.variantId } : {}),
      level: String(g.level),
      quality: String(g.quality),
      enabled: 'true',
      enableGlobal1: 'true',
      enableGlobal2: 'false',
      count: '1',
    },
    children: [],
    text: '',
  };
}

function groupNode(g: GroupOut): XmlNode {
  return {
    tag: 'Skill',
    attrs: { enabled: 'true', includeInFullDPS: 'false', label: '', slot: g.slot, mainActiveSkill: '1', mainActiveSkillCalcs: '1', ...(g.imbuedSupport ? { imbuedSupport: g.imbuedSupport } : {}) },
    children: g.gems.map(gemNode),
    text: '',
  };
}

const SEP = '\u001f';
const groupKey = (n: XmlNode) =>
  [n.attrs.slot ?? '', n.attrs.source ?? '', String(n.children.length), n.children.map((c) => (c.attrs.nameSpec ?? '').toLowerCase()).join(SEP)].join(SEP);

function activeSkillSet(skills: XmlNode): XmlNode {
  const sets = skills.children.filter((c) => c.tag === 'SkillSet');
  if (!sets.length) return skills;
  const id = skills.attrs.activeSkillSet ?? '1';
  return sets.find((s) => (s.attrs.id ?? '1') === id) ?? sets[0]!;
}

function applySkills(xml: string, groups: GroupOut[], p: ImportParts, notes: string[], guardId: number | null): string {
  const r = findElement(xml, 'Skills');
  const eol = eolOf(xml);
  if (!r) return xml;
  const skills = parseXml(xml.slice(r.start, r.end));
  const set = activeSkillSet(skills);
  const isGroup = (c: XmlNode) => c.tag === 'Skill';
  let existing = set.children.filter(isGroup);
  const rest = set.children.filter((c) => !isGroup(c));
  const mainIndex = (parseInt(/<Build\b[^>]*\bmainSocketGroup="(\d+)"/.exec(xml)?.[1] ?? '1', 10) || 1) - 1;
  const mainSkillEmpty = existing.length === 0;
  let mainKey: string | null = null;
  const saved = new Map<string, XmlNode[]>();
  let order: string[] = [];
  if (p.deleteSkills) {
    for (const g of existing)
      for (const gem of g.children) if (gem.attrs.nameSpec && !/ Support$/.test(gem.attrs.nameSpec) && !/^Support/.test(gem.attrs.skillId ?? '')) order.push(gem.attrs.nameSpec);
    existing.forEach((g, i) => {
      const k = groupKey(g);
      saved.set(k, [...(saved.get(k) ?? []), g]);
      if (i === mainIndex) mainKey = k;
    });
    existing = [];
  }
  const fresh = groups.map(groupNode);
  const merged: XmlNode[] = [...existing];
  for (const g of fresh) {
    // A group that matches one already in the build is updated, not added twice.
    const match = merged.find((e) => e.children.length === g.children.length && (!e.attrs.slot || e.attrs.slot === g.attrs.slot) && e.children.every((gem, i) => (gem.attrs.nameSpec ?? '').toLowerCase() === (g.children[i]!.attrs.nameSpec ?? '').toLowerCase()));
    if (match) {
      match.children.forEach((gem, i) => {
        gem.attrs.level = g.children[i]!.attrs.level!;
        gem.attrs.quality = g.children[i]!.attrs.quality!;
      });
    } else merged.push(g);
  }
  let finalList = merged;
  if (p.deleteSkills) {
    // Skills keep the order they had, and the settings of a group that is still there come back with it.
    const rank = (n: XmlNode) => {
      let best: number | undefined;
      for (const gem of n.children) {
        if (!gem.attrs.nameSpec || / Support$/.test(gem.attrs.nameSpec) || /^Support/.test(gem.attrs.skillId ?? '')) continue;
        const i = order.indexOf(gem.attrs.nameSpec);
        if (i >= 0 && (best === undefined || i < best)) best = i;
      }
      return best;
    };
    const pos = new Map(merged.map((n, i) => [n, i]));
    finalList = [...merged].sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      if (ra !== undefined && rb !== undefined) return ra !== rb ? ra - rb : pos.get(a)! - pos.get(b)!;
      if (ra === undefined && rb === undefined) return pos.get(a)! - pos.get(b)!;
      return ra !== undefined ? -1 : 1;
    });
    let restoredMain: number | null = null;
    finalList.forEach((n, i) => {
      const list = saved.get(groupKey(n));
      const old = list?.shift();
      if (!old) return;
      for (const k of GROUP_STATE) if (old.attrs[k] !== undefined) n.attrs[k] = old.attrs[k]!;
      n.children.forEach((gem, gi) => {
        const og = old.children[gi];
        if (og) for (const k of GEM_STATE) if (og.attrs[k] !== undefined) gem.attrs[k] = og.attrs[k]!;
      });
      if (groupKey(old) === mainKey && restoredMain === null) restoredMain = i;
    });
    if (restoredMain !== null) xml = setBuildAttrs(xml, { mainSocketGroup: String(restoredMain + 1) });
  }
  if (guardId !== null) {
    for (const g of finalList)
      for (const gem of g.children)
        if (gem.attrs.nameSpec === GUARD_SET) {
          for (const k of ['skillMinionItemSet', 'skillMinionItemSetCalcs']) if (!gem.attrs[k]) gem.attrs[k] = String(guardId);
        }
  }
  if (mainSkillEmpty && finalList.length) {
    let best = 0;
    let bestN = 0;
    finalList.forEach((g, i) => {
      if (g.children.length > bestN) {
        bestN = g.children.length;
        best = i;
      }
    });
    xml = setBuildAttrs(xml, { mainSocketGroup: String(best + 1) });
  }
  set.children = [...rest, ...finalList];
  const out = xml.slice(0, r.start) + serialize(skills, '\t', eol) + xml.slice(r.end);
  notes.push(`Skills imported: ${groups.length} socket ${groups.length === 1 ? 'group' : 'groups'}.`);
  return out;
}

function applyItemsAndSkills(xml: string, b: Bundle, p: ImportParts, d: ConvertData, notes: string[]): string {
  const dump = b.items!;
  const tree = d.tree(d.latestTree);
  if (p.deleteItems) {
    const m = readItems(xml);
    const ids = [...activeSetOf(m).slots.entries()].filter(([name, s]) => s.itemId > 0 && !/^Jewel /.test(name)).map(([, s]) => s.itemId);
    if (ids.length) xml = deleteItems(xml, ids);
  }
  const r = importItems(dump.items ?? [], d.items, tree.jewelSlots, { ignoreWeaponSwap: p.ignoreWeaponSwap });
  const guardian = dump.guardian?.length ? importItems(dump.guardian, d.items, tree.jewelSlots, { ignoreWeaponSwap: p.ignoreWeaponSwap, guardian: true }) : null;
  const placements = r.placements.filter((x) => x.jewelNode === undefined);
  if (p.items) {
    xml = place(xml, placements);
    if (guardian) xml = place(xml, guardian.placements);
    notes.push(`Items imported: ${placements.length + (guardian?.placements.length ?? 0)}${guardian ? ` (${guardian.placements.length} for Animate Guardian)` : ''}.`);
    for (const s of [...r.skipped, ...(guardian?.skipped ?? [])]) notes.push(`An item was left out because its base is not known: ${s}.`);
  }
  if (p.skills) {
    const guardId = guardian ? readItems(xml).sets.find((s) => s.title === GUARD_SET)?.id ?? null : null;
    xml = applySkills(xml, [...r.groups, ...(guardian?.groups ?? [])], p, notes, guardId);
  }
  xml = setBuildAttrs(xml, { level: String(b.character.level || 100), characterLevelAutoMode: 'false' });
  return xml;
}

/** Applies the character to the build text. */
export function applyCharacter(xml: string, b: Bundle, p: ImportParts, d: ConvertData): { xml: string; notes: string[] } {
  const notes: string[] = [];
  let out = xml;
  if (p.tree && b.passives) out = applyTree(out, b, p, d, notes);
  else if (p.jewels && b.passives?.items?.length) {
    // Jewels alone: they go in the sockets of the tree the build already has.
    const tree = d.tree(d.latestTree);
    if (p.deleteJewels) out = deleteJewelItems(out);
    const r = importItems(b.passives.items, d.items, tree.jewelSlots, { ignoreWeaponSwap: false });
    out = place(out, r.placements);
    notes.push(`Jewels imported: ${r.placements.length}.`);
  }
  if ((p.items || p.skills) && b.items) out = applyItemsAndSkills(out, b, p, d, notes);
  return { xml: out, notes };
}
