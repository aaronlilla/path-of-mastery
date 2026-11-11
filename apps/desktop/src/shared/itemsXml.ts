import { escapeXml, parseXml, type XmlNode } from './buildXml.js';

/**
 * The `<Items>` section of a build file, read and rewritten. Reading goes through the small XML reader; writing
 * replaces only the `<Items>` element (and, for jewels, one `<Socket>` of the active spec), so the rest of the file
 * stays as it was.
 */

export interface ItemEntry {
  id: number;
  text: string;
}

export interface SlotRef {
  name: string;
  itemId: number;
  active: boolean;
}

export interface ItemSetModel {
  id: number;
  title: string;
  useSecond: boolean;
  slots: Map<string, SlotRef>;
}

export interface SpecModel {
  index: number;
  title: string;
  /** Jewel socket node id -> item id (0 is empty). */
  sockets: Map<number, number>;
}

export interface ItemsModel {
  activeSet: number;
  /** `<Item>` elements in file order (the order of the item list). */
  items: ItemEntry[];
  sets: ItemSetModel[];
  specs: SpecModel[];
  activeSpec: number;
}

function child(n: XmlNode | undefined, tag: string): XmlNode | undefined {
  return n?.children.find((c) => c.tag === tag);
}

function int(v: string | undefined, d: number): number {
  const n = parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : d;
}

/** The item text as upstream reads it: an element's text with the file's indentation left as is. */
export function itemTextOf(n: XmlNode): string {
  return n.text.replace(/^\r?\n/, '').replace(/\r?\n?[\t ]*$/, '').replace(/\r\n/g, '\n');
}

export function readItems(xml: string): ItemsModel {
  const out: ItemsModel = { activeSet: 1, items: [], sets: [], specs: [], activeSpec: 1 };
  let root: XmlNode;
  try {
    root = parseXml(xml);
  } catch {
    // A file that is not a build still gets the one empty item set the tab needs.
    out.sets.push({ id: 1, title: '', useSecond: false, slots: new Map() });
    return out;
  }
  const items = child(root, 'Items');
  if (items) {
    out.activeSet = int(items.attrs.activeItemSet, 1);
    for (const it of items.children.filter((c) => c.tag === 'Item')) out.items.push({ id: int(it.attrs.id, 0), text: itemTextOf(it) });
    const readSlots = (el: XmlNode) => new Map(el.children.filter((c) => c.tag === 'Slot' && c.attrs.name).map((s) => [s.attrs.name!, { name: s.attrs.name!, itemId: int(s.attrs.itemId, 0), active: s.attrs.active === 'true' }]));
    const sets = items.children.filter((c) => c.tag === 'ItemSet');
    for (const s of sets) out.sets.push({ id: int(s.attrs.id, 1), title: s.attrs.title ?? '', useSecond: s.attrs.useSecondWeaponSet === 'true', slots: readSlots(s) });
    if (!sets.length && items.children.some((c) => c.tag === 'Slot')) out.sets.push({ id: 1, title: '', useSecond: items.attrs.useSecondWeaponSet === 'true', slots: readSlots(items) });
  }
  if (!out.sets.length) out.sets.push({ id: 1, title: '', useSecond: false, slots: new Map() });
  if (!out.sets.some((s) => s.id === out.activeSet)) out.activeSet = out.sets[0]!.id;
  const tree = child(root, 'Tree');
  if (tree) {
    out.activeSpec = int(tree.attrs.activeSpec, 1);
    tree.children
      .filter((c) => c.tag === 'Spec')
      .forEach((s, i) => {
        const sockets = new Map<number, number>();
        for (const k of child(s, 'Sockets')?.children.filter((c) => c.tag === 'Socket') ?? []) sockets.set(int(k.attrs.nodeId, 0), int(k.attrs.itemId, 0));
        out.specs.push({ index: i + 1, title: s.attrs.title ?? '', sockets });
      });
  }
  return out;
}

/** What a build file with no item set at all (a damaged file, or one that is not a build) is read as: one empty set. */
const EMPTY_SET: ItemSetModel = { id: 1, title: '', useSecond: false, slots: new Map() };

export function activeSetOf(m: ItemsModel): ItemSetModel {
  return m.sets.find((s) => s.id === m.activeSet) ?? m.sets[0] ?? EMPTY_SET;
}

// ---- writing --------------------------------------------------------------------------------------------------

function escText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function attrString(a: Record<string, string>): string {
  return Object.entries(a)
    .map(([k, v]) => ` ${k}="${escapeXml(v)}"`)
    .join('');
}

function serialize(n: XmlNode, indent: string, eol: string): string {
  const open = `<${n.tag}${attrString(n.attrs)}`;
  const text = n.text.trim() === '' ? '' : n.text;
  if (!n.children.length && !text) return `${open} />`;
  if (!n.children.length) return `${open}>${escText(text)}</${n.tag}>`;
  const inner = n.children.map((c) => `${indent}\t${serialize(c, indent + '\t', eol)}`).join(eol);
  return `${open}>${text ? escText(text) : ''}${eol}${inner}${eol}${indent}</${n.tag}>`;
}

const ITEMS_RE = /<Items\b[^>]*?(?:\/>|>[\s\S]*?<\/Items>)/;

/** Parses the `<Items>` element of `xml` for editing: the node, and a function that puts an edited node back. */
function withItemsNode(xml: string, edit: (items: XmlNode) => void): string {
  const eol = xml.includes('\r\n') ? '\r\n' : '\n';
  const m = ITEMS_RE.exec(xml);
  let items: XmlNode;
  if (m) {
    items = parseXml(m[0]);
  } else {
    items = { tag: 'Items', attrs: { activeItemSet: '1', useSecondWeaponSet: 'nil' }, children: [{ tag: 'ItemSet', attrs: { useSecondWeaponSet: 'nil', id: '1' }, children: [], text: '' }], text: '' };
  }
  edit(items);
  const text = serialize(items, '\t', eol);
  if (m) return xml.slice(0, m.index) + text + xml.slice(m.index + m[0].length);
  const cfg = /\r?\n?[\t ]*<Config\b/.exec(xml);
  if (cfg) return xml.slice(0, cfg.index) + eol + '\t' + text + xml.slice(cfg.index);
  const end = xml.lastIndexOf('</PathOfBuilding>');
  return end < 0 ? xml : xml.slice(0, end) + '\t' + text + eol + xml.slice(end);
}

function setEl(items: XmlNode, id: number): XmlNode {
  const sets = items.children.filter((c) => c.tag === 'ItemSet');
  return sets.find((s) => int(s.attrs.id, 1) === id) ?? sets[0] ?? items;
}

function slotEl(set: XmlNode, name: string, create: boolean): XmlNode | undefined {
  let s = set.children.filter((c) => c.tag === 'Slot' && c.attrs.name === name).pop();
  if (!s && create) {
    s = { tag: 'Slot', attrs: { name, itemId: '0' }, children: [], text: '' };
    set.children.push(s);
  }
  return s;
}

/** Puts the item text in the next free id; returns the new file text and the id. */
export function addItem(xml: string, text: string): { xml: string; id: number } {
  let id = 1;
  const out = withItemsNode(xml, (items) => {
    id = Math.max(0, ...items.children.filter((c) => c.tag === 'Item').map((c) => int(c.attrs.id, 0))) + 1;
    const firstSet = items.children.findIndex((c) => c.tag !== 'Item');
    const el: XmlNode = { tag: 'Item', attrs: { id: String(id) }, children: [], text: text.replace(/\r\n/g, '\n') };
    items.children.splice(firstSet < 0 ? items.children.length : firstSet, 0, el);
  });
  return { xml: out, id };
}

export function setItemText(xml: string, id: number, text: string): string {
  return withItemsNode(xml, (items) => {
    const it = items.children.find((c) => c.tag === 'Item' && int(c.attrs.id, 0) === id);
    if (it) it.text = text.replace(/\r\n/g, '\n');
  });
}

/** Removes the items, and every slot and jewel socket (of every spec) that holds one. */
export function deleteItems(xml: string, ids: number[]): string {
  const gone = new Set(ids);
  let out = withItemsNode(xml, (items) => {
    items.children = items.children.filter((c) => !(c.tag === 'Item' && gone.has(int(c.attrs.id, 0))));
    for (const set of items.children.filter((c) => c.tag === 'ItemSet')) {
      for (const s of set.children.filter((c) => c.tag === 'Slot')) if (gone.has(int(s.attrs.itemId, 0))) s.attrs.itemId = '0';
    }
    for (const s of items.children.filter((c) => c.tag === 'Slot')) if (gone.has(int(s.attrs.itemId, 0))) s.attrs.itemId = '0';
  });
  out = out.replace(/(<Socket\b[^>]*?\bitemId=")(\d+)(")/g, (m, a: string, id: string, b: string) => (gone.has(parseInt(id, 10)) ? `${a}0${b}` : m));
  return out;
}

export function setActiveSet(xml: string, id: number): string {
  return withItemsNode(xml, (items) => {
    items.attrs.activeItemSet = String(id);
  });
}

/** Which weapon set a slot name belongs to: 1 for the first set's weapon slots, 2 for the swap slots, 0 for any other slot. */
export function weaponSetOfSlot(slot: string | undefined): 0 | 1 | 2 {
  if (!slot) return 0;
  if (/^Weapon [12] Swap( Abyssal Socket \d)?$/.test(slot)) return 2;
  if (/^Weapon [12]( Abyssal Socket \d)?$/.test(slot)) return 1;
  return 0;
}

/**
 * Switching weapon sets also moves the main skill: when the main socket group sits in a weapon slot of the set being left,
 * the first socket group in a slot of the set being entered becomes the main one (`weaponSwap1` and `weaponSwap2`).
 */
export function retargetMainSocketGroup(xml: string, toSecond: boolean): string {
  const skills = /<Skills\b[^>]*>([\s\S]*?)<\/Skills>/.exec(xml);
  if (!skills) return xml;
  const active = int(/\bactiveSkillSet="(\d+)"/.exec(skills[0])?.[1], 1);
  const sets = [...skills[1]!.matchAll(/<SkillSet\b([^>]*)>([\s\S]*?)<\/SkillSet>/g)];
  const body = sets.length ? (sets.find((m) => int(/\bid="(\d+)"/.exec(m[1]!)?.[1], 1) === active) ?? sets[0]!)[2]! : skills[1]!;
  const slotOf = [...body.matchAll(/<Skill\b([^>]*)>/g)].map((m) => /\bslot="([^"]*)"/.exec(m[1]!)?.[1]);
  const build = /(<Build\b[^>]*\bmainSocketGroup=")(\d+)(")/.exec(xml);
  if (!build) return xml;
  const main = int(build[2], 1);
  const leaving = toSecond ? 1 : 2;
  const entering = toSecond ? 2 : 1;
  if (weaponSetOfSlot(slotOf[main - 1]) !== leaving) return xml;
  const next = slotOf.findIndex((sl) => weaponSetOfSlot(sl) === entering);
  if (next < 0) return xml;
  return xml.slice(0, build.index) + build[1] + String(next + 1) + build[3] + xml.slice(build.index + build[0].length);
}

export function setSecondWeaponSet(xml: string, on: boolean): string {
  const out = withItemsNode(xml, (items) => {
    const active = setEl(items, int(items.attrs.activeItemSet, 1));
    active.attrs.useSecondWeaponSet = on ? 'true' : 'false';
  });
  return retargetMainSocketGroup(out, on);
}

export function setFlaskActive(xml: string, slotName: string, active: boolean): string {
  return withItemsNode(xml, (items) => {
    const s = slotEl(setEl(items, int(items.attrs.activeItemSet, 1)), slotName, true)!;
    if (active) s.attrs.active = 'true';
    else delete s.attrs.active;
  });
}

/** Puts item `itemId` (0 = nothing) in a slot of the active item set. */
export function setSlot(xml: string, slotName: string, itemId: number): string {
  return withItemsNode(xml, (items) => {
    const s = slotEl(setEl(items, int(items.attrs.activeItemSet, 1)), slotName, true)!;
    s.attrs.itemId = String(itemId);
  });
}

function nextSetId(items: XmlNode): number {
  return Math.max(0, ...items.children.filter((c) => c.tag === 'ItemSet').map((c) => int(c.attrs.id, 0))) + 1;
}

/** A new item set (empty, or a copy of `copyOf`), made the active one; returns its id. */
export function newItemSet(xml: string, title: string, copyOf?: number): { xml: string; id: number } {
  let id = 1;
  const out = withItemsNode(xml, (items) => {
    id = nextSetId(items);
    const src = copyOf !== undefined ? items.children.find((c) => c.tag === 'ItemSet' && int(c.attrs.id, 1) === copyOf) : undefined;
    const attrs: Record<string, string> = { ...(src?.attrs ?? { useSecondWeaponSet: 'nil' }), id: String(id) };
    if (title) attrs.title = title;
    else delete attrs.title;
    const slots = (src?.children ?? []).map((c) => ({ ...c, attrs: { ...c.attrs }, children: [...c.children] }));
    items.children.push({ tag: 'ItemSet', attrs, children: slots, text: '' });
  });
  return { xml: out, id };
}

export function renameItemSet(xml: string, id: number, title: string): string {
  return withItemsNode(xml, (items) => {
    const el = items.children.find((c) => c.tag === 'ItemSet' && int(c.attrs.id, 1) === id);
    if (!el) return;
    if (title) el.attrs.title = title;
    else delete el.attrs.title;
  });
}

/** Removes a set (not the last one); the first remaining set becomes active when the active one goes. */
export function deleteItemSet(xml: string, id: number): string {
  return withItemsNode(xml, (items) => {
    const sets = items.children.filter((c) => c.tag === 'ItemSet');
    if (sets.length < 2) return;
    items.children = items.children.filter((c) => !(c.tag === 'ItemSet' && int(c.attrs.id, 1) === id));
    if (int(items.attrs.activeItemSet, 1) === id) items.attrs.activeItemSet = items.children.find((c) => c.tag === 'ItemSet')!.attrs.id ?? '1';
  });
}

/** Sets the item in a jewel socket of the active spec (0 empties it). */
export function setJewel(xml: string, nodeId: number, itemId: number): string {
  const treeAt = /<Tree\b/.exec(xml);
  if (!treeAt) return xml;
  const activeSpec = int(/<Tree\b[^>]*\bactiveSpec="(\d+)"/.exec(xml)?.[1], 1);
  const starts: number[] = [];
  const specRe = /<Spec\b/g;
  let m: RegExpExecArray | null;
  while ((m = specRe.exec(xml))) starts.push(m.index);
  const from = starts[activeSpec - 1] ?? starts[0];
  if (from === undefined) return xml;
  const end = xml.indexOf('</Spec>', from);
  const to = end < 0 ? xml.length : end;
  const region = xml.slice(from, to);
  const eol = xml.includes('\r\n') ? '\r\n' : '\n';
  const re = new RegExp(`(<Socket\\b[^>]*?\\bnodeId="${nodeId}"[^>]*?\\bitemId=")\\d+(")`);
  let next: string;
  if (re.test(region)) {
    next = region.replace(re, `$1${itemId}$2`);
  } else {
    const entry = `<Socket nodeId="${nodeId}" itemId="${itemId}" />`;
    const sockets = /<Sockets\b[^>]*?(\/>|>)/.exec(region);
    if (sockets && sockets[1] === '/>') next = region.slice(0, sockets.index) + `<Sockets>${entry}</Sockets>` + region.slice(sockets.index + sockets[0].length);
    else if (sockets) next = region.slice(0, sockets.index + sockets[0].length) + eol + '\t\t\t\t' + entry + region.slice(sockets.index + sockets[0].length);
    else next = region + `\t<Sockets>${eol}\t\t\t\t${entry}${eol}\t\t\t</Sockets>${eol}\t\t`;
  }
  return xml.slice(0, from) + next + xml.slice(to);
}

/** The text of the item set as one tooltip line per equipped slot is built from this. */
export function slotItemId(set: ItemSetModel, name: string): number {
  return set.slots.get(name)?.itemId ?? 0;
}
