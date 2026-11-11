// The Craft item popover's five headings (design: Weapons, Armour, Jewellery, Jewels, Flasks) over the engine's item types
// (`Body Armour: Energy Shield`, `One Handed Sword: Thrusting`, ...). Kept free of React so the grouping can be tested.

export interface CraftGroup {
  name: string;
  types: string[];
}

const GROUPS: Array<{ name: string; test: (family: string) => boolean }> = [
  { name: 'Weapons', test: (f) => /^(One Handed|Two Handed) /.test(f) || ['Bow', 'Claw', 'Dagger', 'Fishing Rod', 'Sceptre', 'Staff', 'Wand', 'Shield', 'Quiver'].includes(f) },
  { name: 'Armour', test: (f) => ['Helmet', 'Body Armour', 'Gloves', 'Boots'].includes(f) },
  // The prototype has no Graft; it is worn like the rest of these, so it sits with them.
  { name: 'Jewellery', test: (f) => ['Amulet', 'Ring', 'Belt', 'Graft'].includes(f) },
  { name: 'Jewels', test: (f) => f === 'Jewel' },
  { name: 'Flasks', test: (f) => f === 'Flask' || f === 'Tincture' },
];

/** The part of a type before its colon: `Boots: Armour` is a Boots type. */
const familyOf = (type: string) => type.split(':')[0]!.trim();

/** The types under their five headings, in the order the types come; a type that fits none is kept under "Other". Empty headings are left out. */
export function craftGroups(types: string[]): CraftGroup[] {
  const out: CraftGroup[] = GROUPS.map((g) => ({ name: g.name, types: [] }));
  const other: CraftGroup = { name: 'Other', types: [] };
  for (const t of types) {
    const i = GROUPS.findIndex((g) => g.test(familyOf(t)));
    (i >= 0 ? out[i]! : other).types.push(t);
  }
  return [...out, other].filter((g) => g.types.length > 0);
}
