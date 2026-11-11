/**
 * Item bases from the engine's game data (`data_itemBases.json`), reduced to what the filter needs.
 * Read in the main process, because the data lives next to the engine, then sent to the renderer.
 */

export interface BaseInfo {
  name: string;
  /** The filter's own Class name, like "Body Armours". */
  class: string;
  /** Level requirement from game data. */
  level: number;
}

const FLASK: Record<string, string> = { life: 'Life Flasks', mana: 'Mana Flasks', hybrid: 'Hybrid Flasks', utility: 'Utility Flasks' };

export const CLASS_OF_TYPE: Record<string, string> = {
  Amulet: 'Amulets',
  Belt: 'Belts',
  'Body Armour': 'Body Armours',
  Boots: 'Boots',
  Bow: 'Bows',
  Claw: 'Claws',
  Dagger: 'Daggers',
  'Rune Dagger': 'Rune Daggers',
  Gloves: 'Gloves',
  Helmet: 'Helmets',
  Jewel: 'Jewels',
  'One Handed Axe': 'One Hand Axes',
  'One Handed Mace': 'One Hand Maces',
  'One Handed Sword': 'One Hand Swords',
  'Thrusting One Handed Sword': 'Thrusting One Hand Swords',
  Quiver: 'Quivers',
  Ring: 'Rings',
  Sceptre: 'Sceptres',
  Shield: 'Shields',
  Staff: 'Staves',
  Warstaff: 'Warstaves',
  'Two Handed Axe': 'Two Hand Axes',
  'Two Handed Mace': 'Two Hand Maces',
  'Two Handed Sword': 'Two Hand Swords',
  Wand: 'Wands',
  'Fishing Rod': 'Fishing Rods',
  Tincture: 'Tinctures',
};

export interface RawBase {
  type?: string;
  req?: { level?: number };
  tags?: Record<string, boolean>;
}

export function classOfBase(raw: RawBase): string | null {
  const t = raw.type ?? '';
  if (t === 'Flask') {
    const tags = raw.tags ?? {};
    for (const k of Object.keys(FLASK)) if (tags[k] || tags[`${k}_flask`]) return FLASK[k]!;
    return 'Utility Flasks';
  }
  return CLASS_OF_TYPE[t] ?? null;
}

/** Reduces the engine's base table to filter classes. Unknown types are left out rather than guessed. */
export function reduceBases(data: Record<string, RawBase>): BaseInfo[] {
  const out: BaseInfo[] = [];
  for (const [name, raw] of Object.entries(data)) {
    const c = classOfBase(raw);
    if (!c) continue;
    out.push({ name, class: c, level: raw.req?.level ?? 1 });
  }
  return out;
}

/** The kinds of gear Guided offers, each as the filter classes it means. */
export const GEAR_KINDS: { id: string; label: string; classes: string[]; art: string }[] = [
  { id: 'body', label: 'Body armour', classes: ['Body Armours'], art: 'icon_body_armour' },
  { id: 'helmet', label: 'Helmet', classes: ['Helmets'], art: 'icon_helmet' },
  { id: 'gloves', label: 'Gloves', classes: ['Gloves'], art: 'icon_gloves' },
  { id: 'boots', label: 'Boots', classes: ['Boots'], art: 'icon_boots' },
  { id: 'belt', label: 'Belt', classes: ['Belts'], art: 'icon_belt' },
  { id: 'ring', label: 'Ring', classes: ['Rings'], art: 'icon_ring_left' },
  { id: 'amulet', label: 'Amulet', classes: ['Amulets'], art: 'icon_amulet' },
  { id: 'shield', label: 'Shield', classes: ['Shields'], art: 'icon_shield' },
  { id: 'quiver', label: 'Quiver', classes: ['Quivers'], art: 'icon_quiver' },
  { id: 'flask', label: 'Flask', classes: ['Life Flasks', 'Mana Flasks', 'Hybrid Flasks', 'Utility Flasks'], art: '' },
  { id: 'jewel', label: 'Jewel', classes: ['Jewels', 'Abyss Jewels'], art: '' },
  {
    id: 'weapon',
    label: 'Weapon',
    classes: ['Bows', 'Claws', 'Daggers', 'Rune Daggers', 'One Hand Axes', 'One Hand Maces', 'One Hand Swords', 'Thrusting One Hand Swords', 'Sceptres', 'Staves', 'Warstaves', 'Two Hand Axes', 'Two Hand Maces', 'Two Hand Swords', 'Wands'],
    art: 'icon_weapon',
  },
];
