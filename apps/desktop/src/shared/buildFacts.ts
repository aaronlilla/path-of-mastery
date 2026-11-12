/**
 * What the Compare tab needs to know about a build file: its tree specs, item sets, skill sets and config sets, which
 * of each is active, and the loadouts they form. Read straight from the XML; nothing here calculates a number.
 * Also the few XML edits the Compare tab sends the engine (adding a socket group or support gem for the power report,
 * writing config inputs for Copy Config), done the way the engine's own edits splice the file.
 */
import { escapeXml, parseAttrs, unescapeXml } from './buildXml.js';

export interface ItemFact {
  id: number;
  /** Abyssal sockets of the item, from its `Sockets:` line. */
  abyssal: number;
  raw: string;
  rarity: string;
  name: string;
  base: string;
}

export interface GemFact {
  name: string;
  skillId: string;
  level: number;
  quality: number;
  enabled: boolean;
  /** The gem's element as written in the file. */
  xml: string;
}

export interface GroupFact {
  label: string;
  slot: string;
  enabled: boolean;
  gems: GemFact[];
  /** The group's element as written in the file. */
  xml: string;
}

export interface SpecFact {
  title: string;
  nodes: number[];
  treeVersion: string;
  classId: number;
  ascendClassId: number;
  /** Jewel socket node to the id of the jewel in it (items of the build's own list). */
  jewels: Map<number, number>;
}

export type ConfigValue = string | number | boolean;

export interface BuildFacts {
  className: string;
  ascendClassName: string;
  level: number;
  mainSocketGroup: number;
  specs: SpecFact[];
  activeSpec: number;
  items: Map<number, ItemFact>;
  itemSets: { id: number; title: string; slots: Map<string, number> }[];
  activeItemSet: number;
  skillSets: { id: number; title: string; groups: GroupFact[] }[];
  activeSkillSet: number;
  configSets: { id: number; title: string; input: Map<string, ConfigValue> }[];
  activeConfigSet: number;
  /** The quest and pantheon picks kept as <Build> attributes; upstream copies them into the config input on load. */
  picks: Record<'bandit' | 'pantheonMajorGod' | 'pantheonMinorGod', string>;
}

interface Block {
  start: number;
  end: number;
  attrs: Record<string, string>;
  /** Text between the start and end tags ('' for a self-closing element). */
  inner: string;
  /** Offset of `inner` in the file. */
  innerStart: number;
}

/** The elements named `tag` between `from` and `to`, in order. Elements of one name never nest in a build file. */
function blocks(xml: string, tag: string, from = 0, to = xml.length): Block[] {
  const out: Block[] = [];
  const re = new RegExp(`<${tag}\\b((?:[^>"']|"[^"]*"|'[^']*')*?)(\\/>|>)`, 'g');
  re.lastIndex = from;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) && m.index < to) {
    const attrs = parseAttrs(m[1] ?? '');
    if (m[2] === '/>') {
      out.push({ start: m.index, end: re.lastIndex, attrs, inner: '', innerStart: re.lastIndex });
      continue;
    }
    const close = xml.indexOf(`</${tag}>`, re.lastIndex);
    if (close < 0) break;
    out.push({ start: m.index, end: close + tag.length + 3, attrs, inner: xml.slice(re.lastIndex, close), innerStart: re.lastIndex });
    re.lastIndex = close + tag.length + 3;
  }
  return out;
}

const int = (s: string | undefined, d: number): number => {
  const n = parseInt(s ?? '', 10);
  return Number.isFinite(n) ? n : d;
};

function parseItem(id: number, innerRaw: string): ItemFact {
  // The item text is the element's text; child elements (mod ranges) are not part of it.
  const raw = unescapeXml(innerRaw.replace(/<[A-Za-z][\s\S]*$/, '')).replace(/^\s+/, '').replace(/\s+$/, '');
  const lines = raw.split(/\r?\n/).map((l) => l.trim());
  const rarity = /^Rarity:\s*(\w+)/i.exec(lines[0] ?? '')?.[1]?.toUpperCase() ?? 'NORMAL';
  const first = lines[1] ?? '';
  const second = lines[2] ?? '';
  const twoLines = rarity === 'RARE' || rarity === 'UNIQUE' || rarity === 'RELIC';
  const sockets = /^Sockets:\s*(.*)$/m.exec(raw)?.[1] ?? '';
  const abyssal = (sockets.match(/\bA\b/g) ?? []).length;
  return { id, abyssal, raw, rarity, name: first, base: twoLines ? second : first };
}

function readGroups(xml: string, from: number, to: number): GroupFact[] {
  return blocks(xml, 'Skill', from, to).map((g) => ({
    label: g.attrs.label ?? '',
    slot: g.attrs.slot ?? '',
    enabled: g.attrs.enabled !== 'false',
    xml: xml.slice(g.start, g.end),
    gems: blocks(xml, 'Gem', g.innerStart, g.innerStart + g.inner.length).map((e) => ({
      name: e.attrs.nameSpec ?? e.attrs.skillId ?? '',
      skillId: e.attrs.skillId ?? '',
      level: int(e.attrs.level, 1),
      quality: int(e.attrs.quality, 0),
      enabled: e.attrs.enabled !== 'false',
      xml: xml.slice(e.start, e.end),
    })),
  }));
}

function readInputs(xml: string, from: number, to: number): Map<string, ConfigValue> {
  const out = new Map<string, ConfigValue>();
  for (const i of blocks(xml, 'Input', from, to)) {
    const name = i.attrs.name;
    if (!name) continue;
    if (i.attrs.boolean !== undefined) out.set(name, i.attrs.boolean === 'true');
    else if (i.attrs.number !== undefined) out.set(name, Number(i.attrs.number));
    else if (i.attrs.string !== undefined) out.set(name, i.attrs.string);
  }
  return out;
}

/** Reads the facts of a build file. Missing sections give empty ones. */
export function readFacts(xml: string): BuildFacts {
  const build = blocks(xml, 'Build')[0];
  const tree = blocks(xml, 'Tree')[0];
  const specs: SpecFact[] = tree
    ? blocks(xml, 'Spec', tree.start, tree.end).map((s) => ({
        title: s.attrs.title ?? '',
        nodes: (s.attrs.nodes ?? '').split(',').map((x) => parseInt(x, 10)).filter(Number.isFinite),
        treeVersion: s.attrs.treeVersion ?? '',
        classId: int(s.attrs.classId, 0),
        ascendClassId: int(s.attrs.ascendClassId, 0),
        jewels: new Map(
          blocks(xml, 'Socket', s.start, s.end)
            .map((k) => [int(k.attrs.nodeId, 0), int(k.attrs.itemId, 0)] as [number, number])
            .filter(([n, i]) => n > 0 && i > 0),
        ),
      }))
    : [];
  const itemsEl = blocks(xml, 'Items')[0];
  const items = new Map<number, ItemFact>();
  const itemSets: BuildFacts['itemSets'] = [];
  if (itemsEl) {
    for (const it of blocks(xml, 'Item', itemsEl.start, itemsEl.end)) {
      const id = int(it.attrs.id, 0);
      if (id) items.set(id, parseItem(id, it.inner));
    }
    const sets = blocks(xml, 'ItemSet', itemsEl.start, itemsEl.end);
    for (const s of sets) {
      const slots = new Map<string, number>();
      for (const sl of blocks(xml, 'Slot', s.start, s.end)) slots.set(sl.attrs.name ?? '', int(sl.attrs.itemId, 0));
      itemSets.push({ id: int(s.attrs.id, 1), title: s.attrs.title ?? '', slots });
    }
    if (!sets.length) {
      // A legacy save keeps the slots directly under <Items>.
      const slots = new Map<string, number>();
      for (const sl of blocks(xml, 'Slot', itemsEl.start, itemsEl.end)) slots.set(sl.attrs.name ?? '', int(sl.attrs.itemId, 0));
      itemSets.push({ id: 1, title: '', slots });
    }
  }
  const skillsEl = blocks(xml, 'Skills')[0];
  const skillSets: BuildFacts['skillSets'] = [];
  if (skillsEl) {
    const sets = blocks(xml, 'SkillSet', skillsEl.start, skillsEl.end);
    for (const s of sets) skillSets.push({ id: int(s.attrs.id, 1), title: s.attrs.title ?? '', groups: readGroups(xml, s.start, s.end) });
    if (!sets.length) skillSets.push({ id: 1, title: '', groups: readGroups(xml, skillsEl.start, skillsEl.end) });
  }
  const configEl = blocks(xml, 'Config')[0];
  const configSets: BuildFacts['configSets'] = [];
  if (configEl) {
    const sets = blocks(xml, 'ConfigSet', configEl.start, configEl.end);
    for (const s of sets) configSets.push({ id: int(s.attrs.id, 1), title: s.attrs.title ?? '', input: readInputs(xml, s.start, s.end) });
    if (!sets.length) configSets.push({ id: 1, title: '', input: readInputs(xml, configEl.start, configEl.end) });
  }
  const asc = build?.attrs.ascendClassName ?? '';
  return {
    className: build?.attrs.className ?? '',
    ascendClassName: asc === 'None' || asc === 'nil' ? '' : asc,
    level: int(build?.attrs.level, 1),
    mainSocketGroup: int(build?.attrs.mainSocketGroup, 1),
    specs,
    activeSpec: int(tree?.attrs.activeSpec, 1),
    items,
    itemSets,
    activeItemSet: int(itemsEl?.attrs.activeItemSet, 1),
    skillSets,
    activeSkillSet: int(skillsEl?.attrs.activeSkillSet, 1),
    configSets,
    activeConfigSet: int(configEl?.attrs.activeConfigSet, 1),
    picks: { bandit: build?.attrs.bandit ?? 'None', pantheonMajorGod: build?.attrs.pantheonMajorGod ?? 'None', pantheonMinorGod: build?.attrs.pantheonMinorGod ?? 'None' },
  };
}

export function activeSpecOf(f: BuildFacts): SpecFact | undefined {
  return f.specs[f.activeSpec - 1] ?? f.specs[0];
}

export function activeItemSetOf(f: BuildFacts): BuildFacts['itemSets'][number] | undefined {
  return f.itemSets.find((s) => s.id === f.activeItemSet) ?? f.itemSets[0];
}

/** The equipped item of each slot of the active item set. */
export function equipped(f: BuildFacts): Map<string, ItemFact> {
  const out = new Map<string, ItemFact>();
  const set = activeItemSetOf(f);
  if (!set) return out;
  for (const [slot, id] of set.slots) {
    const it = id ? f.items.get(id) : undefined;
    if (it) out.set(slot, it);
  }
  return out;
}

export function activeGroupsOf(f: BuildFacts): GroupFact[] {
  return (f.skillSets.find((s) => s.id === f.activeSkillSet) ?? f.skillSets[0])?.groups ?? [];
}

export function activeConfigOf(f: BuildFacts): Map<string, ConfigValue> {
  return (f.configSets.find((s) => s.id === f.activeConfigSet) ?? f.configSets[0])?.input ?? new Map();
}

// ---- Loadouts -------------------------------------------------------------------------------------------------------

/** A loadout: a tree spec with the item, skill and config sets that go with it (Build.lua's loadout list). */
export interface Loadout {
  name: string;
  spec: number;
  itemSet: number;
  skillSet: number;
  configSet: number;
}

/**
 * The loadouts of a build. A loadout is named after a tree spec; each other kind of set goes with it when it has the
 * same title, or is the only one of its kind. Specs with no match for some set are not loadouts. Builds with a single
 * spec have none to offer (it is the build itself).
 */
export function loadoutsOf(f: BuildFacts): Loadout[] {
  const out: Loadout[] = [];
  const pick = (sets: { id: number; title: string }[], name: string): number | undefined => {
    if (sets.length <= 1) return sets[0]?.id ?? 1;
    const exact = sets.find((s) => (s.title || 'Default') === name);
    if (exact) return exact.id;
    const link = /\{(\w+)\}/.exec(name)?.[1];
    return link ? sets.find((s) => s.title.includes(link))?.id : undefined;
  };
  f.specs.forEach((spec, i) => {
    const name = spec.title || 'Default';
    const itemSet = pick(f.itemSets, name);
    const skillSet = pick(f.skillSets, name);
    const configSet = pick(f.configSets, name);
    if (itemSet === undefined || skillSet === undefined || configSet === undefined) return;
    out.push({ name, spec: i + 1, itemSet, skillSet, configSet });
  });
  return out;
}

function setAttr(xml: string, tag: string, attr: string, value: string): string {
  const b = blocks(xml, tag)[0];
  if (!b) return xml;
  const open = /^<[A-Za-z]+\b((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?>)/.exec(xml.slice(b.start));
  if (!open) return xml;
  const head = open[0];
  const has = new RegExp(`\\b${attr}\\s*=\\s*(?:"[^"]*"|'[^']*')`).test(head);
  const next = has ? head.replace(new RegExp(`\\b${attr}\\s*=\\s*(?:"[^"]*"|'[^']*')`), `${attr}="${escapeXml(value)}"`) : head.replace(/(\/?>)$/, ` ${attr}="${escapeXml(value)}"$1`);
  return xml.slice(0, b.start) + next + xml.slice(b.start + head.length);
}

/** Which kind of set a build keeps several of: tree specs, item sets, skill sets and config sets. */
export type SetKind = 'spec' | 'itemSet' | 'skillSet' | 'configSet';

/** The build text with set `id` of that kind made the active one (the `activeSpec`, `activeItemSet`, ... attribute). */
export function setActiveSetXml(xml: string, kind: SetKind, id: number): string {
  const [tag, attr] = kind === 'spec' ? ['Tree', 'activeSpec'] : kind === 'itemSet' ? ['Items', 'activeItemSet'] : kind === 'skillSet' ? ['Skills', 'activeSkillSet'] : ['Config', 'activeConfigSet'];
  return setAttr(xml, tag!, attr!, String(id));
}

/** The build text with a loadout made the active one. */
export function loadoutXml(xml: string, lo: Loadout): string {
  let out = setAttr(xml, 'Tree', 'activeSpec', String(lo.spec));
  out = setAttr(out, 'Items', 'activeItemSet', String(lo.itemSet));
  out = setAttr(out, 'Skills', 'activeSkillSet', String(lo.skillSet));
  out = setAttr(out, 'Config', 'activeConfigSet', String(lo.configSet));
  return out;
}

// ---- Edits for the power report and Copy Config -------------------------------------------------------------------

function activeSkillSetBlock(xml: string): Block | undefined {
  const skills = blocks(xml, 'Skills')[0];
  if (!skills) return undefined;
  const sets = blocks(xml, 'SkillSet', skills.start, skills.end);
  if (!sets.length) return skills;
  const active = int(skills.attrs.activeSkillSet, 1);
  return sets.find((s) => int(s.attrs.id, 1) === active) ?? sets[0];
}

/** Inserts `text` as the last child of the element `b` (turning `<X/>` into a pair). */
function appendChild(xml: string, b: Block, tag: string, text: string): string {
  if (b.inner === '' && /\/>$/.test(xml.slice(b.start, b.end))) {
    const open = xml.slice(b.start, b.end - 2).replace(/\s+$/, '');
    return xml.slice(0, b.start) + `${open}>${text}</${tag}>` + xml.slice(b.end);
  }
  const close = b.end - (tag.length + 3);
  return xml.slice(0, close) + text + xml.slice(close);
}

/** The build text with a socket group added to the active skill set. */
export function addGroupXml(xml: string, groupXml: string): string {
  const set = activeSkillSetBlock(xml);
  if (!set) return xml;
  const tag = /^<([A-Za-z]+)/.exec(xml.slice(set.start))?.[1] ?? 'SkillSet';
  return appendChild(xml, set, tag, groupXml);
}

/** The build text with a gem added to the `index`-th (1-based) socket group of the active skill set. */
export function addGemXml(xml: string, index: number, gemXml: string): string {
  const set = activeSkillSetBlock(xml);
  if (!set) return xml;
  const group = blocks(xml, 'Skill', set.start, set.end)[index - 1];
  if (!group) return xml;
  return appendChild(xml, group, 'Skill', gemXml);
}

const NUM = (n: number): string => (Number.isInteger(n) ? String(n) : String(n));

function inputElement(key: string, v: ConfigValue): string {
  if (typeof v === 'boolean') return `<Input name="${escapeXml(key)}" boolean="${v}"/>`;
  if (typeof v === 'number') return `<Input name="${escapeXml(key)}" number="${NUM(v)}"/>`;
  return `<Input name="${escapeXml(key)}" string="${escapeXml(v)}"/>`;
}

/** The build text with config inputs set in the active config set (null removes one), as the engine's setConfig does. */
export function setConfigInputs(xml: string, values: Record<string, ConfigValue | null>): string {
  let out = xml;
  for (const [key, v] of Object.entries(values)) {
    const config = blocks(out, 'Config')[0];
    if (!config) {
      if (v === null) continue;
      const end = out.lastIndexOf('</PathOfBuilding>');
      if (end < 0) return out;
      out = out.slice(0, end) + `\t<Config>${inputElement(key, v)}</Config>\n` + out.slice(end);
      continue;
    }
    const sets = blocks(out, 'ConfigSet', config.start, config.end);
    const active = int(config.attrs.activeConfigSet, 1);
    const set = sets.length ? [...sets].reverse().find((s) => int(s.attrs.id, 1) === active) : config;
    if (!set) continue;
    const tag = set === config ? 'Config' : 'ConfigSet';
    const old = blocks(out, 'Input', set.start, set.end).filter((i) => i.attrs.name === key).pop();
    if (old) out = out.slice(0, old.start) + (v === null ? '' : inputElement(key, v)) + out.slice(old.end);
    else if (v !== null) out = appendChild(out, set, tag, inputElement(key, v));
  }
  return out;
}

// ---- Items and jewels --------------------------------------------------------------------------------------------

/** The build text with `itemText` added to the item list, and the new item's id. */
export function addItemXml(xml: string, itemText: string): { xml: string; id: number } {
  const items = blocks(xml, 'Items')[0];
  const id = (items ? Math.max(0, ...blocks(xml, 'Item', items.start, items.end).map((i) => int(i.attrs.id, 0))) : 0) + 1;
  const el = `<Item id="${id}">${itemText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</Item>`;
  if (!items) {
    const end = xml.lastIndexOf('</PathOfBuilding>');
    return { xml: xml.slice(0, end) + `\t<Items activeItemSet="1">${el}<ItemSet id="1"/></Items>\n` + xml.slice(end), id };
  }
  return { xml: appendChild(xml, items, 'Items', el), id };
}

function activeItemSetBlock(xml: string): Block | undefined {
  const items = blocks(xml, 'Items')[0];
  if (!items) return undefined;
  const sets = blocks(xml, 'ItemSet', items.start, items.end);
  if (!sets.length) return items;
  const active = int(items.attrs.activeItemSet, 1);
  return sets.find((s) => int(s.attrs.id, 1) === active) ?? sets[0];
}

/** The build text with `slot` of the active item set holding item `itemId` (0 empties it). */
export function setSlotXml(xml: string, slot: string, itemId: number): string {
  const set = activeItemSetBlock(xml);
  if (!set) return xml;
  const tag = /^<([A-Za-z]+)/.exec(xml.slice(set.start))?.[1] ?? 'ItemSet';
  const old = blocks(xml, 'Slot', set.start, set.end).filter((k) => k.attrs.name === slot).pop();
  const el = `<Slot name="${escapeXml(slot)}" itemId="${itemId}"/>`;
  if (old) return xml.slice(0, old.start) + el + xml.slice(old.end);
  return appendChild(xml, set, tag, el);
}

/** The build text with `itemText` equipped in `slot`, and each of `also` (slot, item text or null to empty) set too. */
export function swapItemsXml(xml: string, slot: string, itemText: string, also: Array<[string, string | null]> = []): string {
  let out = xml;
  for (const [s, text] of [[slot, itemText] as [string, string | null], ...also]) {
    if (text === null) {
      out = setSlotXml(out, s, 0);
      continue;
    }
    const added = addItemXml(out, text);
    out = setSlotXml(added.xml, s, added.id);
  }
  return out;
}

/** The build text with the jewel `itemText` socketed in tree socket `nodeId` of the active spec. */
export function setJewelXml(xml: string, nodeId: number, itemText: string): string {
  const added = addItemXml(xml, itemText);
  const out = added.xml;
  const tree = blocks(out, 'Tree')[0];
  if (!tree) return out;
  const specs = blocks(out, 'Spec', tree.start, tree.end);
  const spec = specs[int(tree.attrs.activeSpec, 1) - 1] ?? specs[0];
  if (!spec) return out;
  const el = `<Socket nodeId="${nodeId}" itemId="${added.id}"/>`;
  const sockets = blocks(out, 'Sockets', spec.start, spec.end)[0];
  if (!sockets) return appendChild(out, spec, 'Spec', `<Sockets>${el}</Sockets>`);
  const old = blocks(out, 'Socket', sockets.start, sockets.end).filter((k) => int(k.attrs.nodeId, 0) === nodeId).pop();
  if (old) return out.slice(0, old.start) + el + out.slice(old.end);
  return appendChild(out, sockets, 'Sockets', el);
}

// ---- Copying a tree ------------------------------------------------------------------------------------------------

/**
 * The build text with the active tree set of `from` added to its tree sets, titled `title`, without the jewels in its
 * sockets (upstream's "Copy tree"). With `use` the new set becomes the active one ("Copy and use").
 */
export function copySpecXml(xml: string, from: string, title: string, use: boolean): string {
  const srcTree = blocks(from, 'Tree')[0];
  const dstTree = blocks(xml, 'Tree')[0];
  if (!srcTree || !dstTree) return xml;
  const srcSpecs = blocks(from, 'Spec', srcTree.start, srcTree.end);
  const spec = srcSpecs[int(srcTree.attrs.activeSpec, 1) - 1] ?? srcSpecs[0];
  if (!spec) return xml;
  let text = from.slice(spec.start, spec.end);
  // No jewels travel with the copy.
  text = text.replace(/<Sockets\b[\s\S]*?<\/Sockets>|<Sockets\b[^>]*\/>/g, '');
  const open = /^<Spec\b((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?>)/.exec(text);
  if (!open) return xml;
  const head = /\btitle\s*=\s*(?:"[^"]*"|'[^']*')/.test(open[0]) ? open[0].replace(/\btitle\s*=\s*(?:"[^"]*"|'[^']*')/, `title="${escapeXml(title)}"`) : open[0].replace(/^<Spec\b/, `<Spec title="${escapeXml(title)}"`);
  text = head + text.slice(open[0].length);
  const count = blocks(xml, 'Spec', dstTree.start, dstTree.end).length;
  let out = appendChild(xml, dstTree, 'Tree', text);
  if (use) out = setAttr(out, 'Tree', 'activeSpec', String(count + 1));
  return out;
}
