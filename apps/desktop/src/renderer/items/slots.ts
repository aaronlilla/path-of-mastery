import type { ItemInfo, TreeState } from '@pom/protocol';
import { label, tr } from '../i18n';

/** One place an item can be equipped. Names are the ones the build file uses. */
export interface SlotDef {
  name: string;
  label: string;
  kind: 'gear' | 'flask' | 'jewel' | 'abyssal';
  /** For a jewel socket, its tree node. */
  nodeId?: number;
  /** The parent gear slot of an abyssal socket. */
  parent?: string;
  /** A short note beside the name (a jewel socket's size). */
  note?: string;
  /** The slot silhouette shown when it is empty (a file under game/ui). */
  icon: string;
}

export const BASE_SLOTS = ['Weapon 1', 'Weapon 2', 'Helmet', 'Body Armour', 'Gloves', 'Boots', 'Amulet', 'Ring 1', 'Ring 2', 'Ring 3', 'Belt', 'Graft 1', 'Graft 2', 'Flask 1', 'Flask 2', 'Flask 3', 'Flask 4', 'Flask 5'];

const ICONS: Record<string, string> = {
  'Weapon 1': 'icon_weapon',
  'Weapon 2': 'icon_weapon_2',
  Helmet: 'icon_helmet',
  'Body Armour': 'icon_body_armour',
  Gloves: 'icon_gloves',
  Boots: 'icon_boots',
  Amulet: 'icon_amulet',
  'Ring 1': 'icon_ring_left',
  'Ring 2': 'icon_ring_right',
  'Ring 3': 'icon_ring_left',
  Belt: 'icon_belt',
};

/** The slot silhouette's URL (under the bundled game art), or undefined where there is none. */
export function slotIcon(def: SlotDef): string | undefined {
  const f = def.icon;
  return f ? `game/ui/${f}.png` : undefined;
}

export function baseSlotDef(name: string): SlotDef {
  const kind = name.startsWith('Flask') ? 'flask' : 'gear';
  return { name, label: label(name), kind, icon: ICONS[name] ?? '' };
}

/** The slots the Items tab lists: the gear slots, each with its abyssal sockets, then flasks, grafts, and jewel sockets. */
export interface SlotContext {
  /** Whether the second weapon set is showing (its slots are the " Swap" twins). */
  second: boolean;
  /** Whether each gear slot's item has abyssal sockets: name -> count. */
  abyssal: Record<string, number>;
  /** Slots that hold an item now (Ring 3 and the grafts show only then, or when the build allows). */
  filled: Set<string>;
  /** The build grants a third ring slot. */
  ring3: boolean;
  /** Tree version 3.27 and later has the graft slots. */
  grafts: boolean;
  sockets: Array<{ id: number; size: number | null }>;
}

export function listSlots(c: SlotContext): SlotDef[] {
  const out: SlotDef[] = [];
  for (const n of BASE_SLOTS) {
    if (n === 'Ring 3' && !c.ring3 && !c.filled.has('Ring 3')) continue;
    if ((n === 'Graft 1' || n === 'Graft 2') && !c.grafts && !c.filled.has(n)) continue;
    if (n.startsWith('Flask') || n.startsWith('Graft')) continue;
    const name = c.second && (n === 'Weapon 1' || n === 'Weapon 2') ? `${n} Swap` : n;
    out.push({ ...baseSlotDef(n), name, label: label(n) });
    const count = c.abyssal[name] ?? 0;
    for (let i = 1; i <= Math.min(6, count); i++) out.push({ name: `${name} Abyssal Socket ${i}`, label: label('Abyssal Socket'), kind: 'abyssal', parent: name, icon: '' });
  }
  for (const n of ['Graft 1', 'Graft 2']) if (c.grafts || c.filled.has(n)) out.push({ ...baseSlotDef(n), kind: 'gear' });
  for (const n of ['Flask 1', 'Flask 2', 'Flask 3', 'Flask 4', 'Flask 5']) out.push(baseSlotDef(n));
  c.sockets.forEach((s, i) => out.push({ name: `Jewel ${s.id}`, label: tr('items_slots.socket', { n: i + 1 }), kind: 'jewel', nodeId: s.id, note: s.size === 2 ? label('Large') : s.size === 1 ? label('Medium') : s.size === 0 ? label('Small') : undefined, icon: '' }));
  return out;
}

/** `ItemClass:GetPrimarySlot`. */
export function primarySlot(i: ItemInfo): string {
  if (i.isWeapon) return 'Weapon 1';
  switch (i.type) {
    case 'Quiver':
    case 'Shield':
      return 'Weapon 2';
    case 'Ring':
      return 'Ring 1';
    case 'Flask':
    case 'Tincture':
      return 'Flask 1';
    case 'Graft':
      return 'Graft 1';
    default:
      return i.type ?? '';
  }
}

/** The second slot of a pair (Shift+click equips there). */
export function alternateSlot(slot: string): string {
  switch (slot) {
    case 'Weapon 1':
      return 'Weapon 2';
    case 'Ring 1':
      return 'Ring 2';
    case 'Flask 1':
      return 'Flask 2';
    case 'Graft 1':
      return 'Graft 2';
    default:
      return slot;
  }
}

/** What the slot picker needs to know about the item in Weapon 1 (`ItemsTabClass:IsItemValidForSlot`). */
export interface SlotCheck {
  /** The type of the item in Weapon 1 of the same weapon set ('None' when empty), and whether it is one-handed. */
  weapon1Type: string;
  weapon1OneHand: boolean | null;
  /** Whether the jewel socket node is a cluster (expansion) socket and its size, or a charm socket. */
  node?: { size: number | null; charm?: boolean };
}

/** What the Items tab's slots come from: the active item set, the build's items, its tree and its third-ring flag. */
export interface SlotSource {
  set: { useSecond: boolean; slots: Map<string, { itemId: number }> };
  infos: Map<number, ItemInfo>;
  tree: TreeState | null;
  ring3: boolean;
}

function versionAtLeast(v: string | undefined, major: number, minor: number): boolean {
  const m = /^(\d+)_(\d+)/.exec(v ?? '');
  if (!m) return true;
  const a = parseInt(m[1]!, 10);
  const b = parseInt(m[2]!, 10);
  return a > major || (a === major && b >= minor);
}

/** The slots the Items tab lists for a build (the background pre-ranking uses the same, so its values are the tab's). */
export function slotsOf(s: SlotSource): SlotDef[] {
  const abyssal: Record<string, number> = {};
  const filled = new Set<string>();
  for (const [name, ref] of s.set.slots) {
    if (ref.itemId > 0) {
      filled.add(name);
      const n = s.infos.get(ref.itemId)?.abyssalSockets ?? 0;
      if (n) abyssal[name] = n;
    }
  }
  return listSlots({ second: s.set.useSecond, abyssal, filled, ring3: s.ring3, grafts: versionAtLeast(s.tree?.treeVersion, 3, 27), sockets: (s.tree?.sockets ?? []).map((x) => ({ id: x.id, size: x.size })) });
}

export function slotCheckOf(s: SlotSource, def: SlotDef): SlotCheck {
  const w1 = s.set.slots.get(s.set.useSecond ? 'Weapon 1 Swap' : 'Weapon 1')?.itemId ?? 0;
  const w1i = w1 ? s.infos.get(w1) : undefined;
  const node = def.nodeId !== undefined ? s.tree?.sockets.find((x) => x.id === def.nodeId) : undefined;
  return { weapon1Type: w1i?.type ?? 'None', weapon1OneHand: w1i?.oneHand ?? null, node: node ? { size: node.size } : undefined };
}

export function itemFitsSlot(i: ItemInfo, slotName: string, c: SlotCheck): boolean {
  if (!i.valid) return false;
  const m = /^([A-Za-z ]+) (\d+)$/.exec(slotName);
  const slotType = m ? m[1]! : slotName;
  if (slotType === 'Jewel') {
    if (i.type !== 'Jewel') return false;
    const node = c.node;
    if (!node) return false;
    if (node.charm || i.charm) return Boolean(node.charm && i.charm);
    if (i.cluster && node.size === null) return false;
    if (node.size === null || node.size === 2) return true;
    return !i.cluster || i.cluster.sizeIndex <= node.size;
  }
  if (i.type === slotType) return true;
  if (i.type === 'Tincture' && slotType === 'Flask') return true;
  if (i.type === 'Jewel' && i.abyssJewel && slotName.includes('Abyssal Socket')) return true;
  if (slotName === 'Weapon 1' || slotName === 'Weapon 1 Swap') return Boolean(i.isWeapon);
  if (slotName === 'Weapon 2' || slotName === 'Weapon 2 Swap') {
    const oneHand = (t: string | undefined) => i.type === t && i.oneHand === true;
    if (c.weapon1Type === 'None') return i.type === 'Shield' || i.oneHand === true;
    if (c.weapon1Type === 'Bow') return i.type === 'Quiver';
    if (c.weapon1OneHand) {
      if (i.type === 'Shield') return true;
      if (i.oneHand !== true) return false;
      return c.weapon1Type === 'Wand' ? oneHand('Wand') : i.type !== 'Wand';
    }
  }
  return false;
}
