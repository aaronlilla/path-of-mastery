import { sanitise } from '../../shared/tradeItemText.js';

/**
 * A character's equipped item from the character window (the site's JSON), written as item text in the build file format,
 * and the socket groups its gems make. This follows `ImportTab:ImportItem` and `ImportTab:ImportSocketedItems`
 * in upstream, and the item text follows `Item:BuildRaw`.
 */

export interface GItemProp {
  name: string;
  values: [string, number][];
}

export interface GItem {
  id?: string;
  inventoryId?: string;
  x?: number;
  y?: number;
  frameType?: number;
  name?: string;
  typeLine?: string;
  ilvl?: number;
  properties?: GItemProp[];
  requirements?: GItemProp[];
  sockets?: { group: number; attr?: string; sColour: string }[];
  socketedItems?: GItem[];
  socket?: number;
  abyssJewel?: boolean;
  support?: boolean;
  hybrid?: { baseTypeName?: string; isVaalGem?: boolean };
  builtInSupport?: string;
  influences?: Record<string, boolean>;
  searing?: boolean;
  tangled?: boolean;
  split?: boolean;
  duplicated?: boolean;
  mirrored?: boolean;
  corrupted?: boolean;
  fractured?: boolean;
  synthesised?: boolean;
  vestigial?: boolean;
  foilVariation?: number;
  isRelic?: boolean;
  enchantMods?: ModText[];
  scourgeMods?: ModText[];
  implicitMods?: ModText[];
  fracturedMods?: ModText[];
  explicitMods?: ModText[];
  craftedMods?: ModText[];
  mutatedMods?: ModText[];
  crucibleMods?: ModText[];
  flavourText?: string[];
}

/** The site sends plain strings; the official API sends { description, flags } too. */
export type ModText = string | { description?: string; flags?: Record<string, boolean> };

export interface GemRow {
  id: string;
  gameId: string;
  variantId?: string;
  grantedEffectId: string;
  name: string;
}

export interface ItemData {
  /** `data.itemBases`: base name to its row (only the type and weapon, armour, flask and tincture presence are read). */
  bases: Record<string, { type?: string; weapon?: unknown; armour?: unknown; flask?: unknown; tincture?: unknown }>;
  gems: Record<string, GemRow>;
  /** Lower-case gem name to the key of `gems`. */
  gemForBaseName: Record<string, string>;
  /** Granted effect id of a gem to the key of its Vaal version. */
  vaalGemFor: Record<string, string>;
}

export interface Placement {
  /** The slot name as the build file writes it ("Weapon 1", "Flask 3", "Weapon 1 Abyssal Socket 1"); tree jewels use `jewelNode`. */
  slot?: string;
  jewelNode?: number;
  raw: string;
  uniqueId?: string;
  /** Another item set than the active one (the Animate Guardian set). */
  guardian?: boolean;
}

export interface GemOut {
  row: GemRow;
  level: number;
  quality: number;
}

export interface GroupOut {
  slot: string;
  gems: GemOut[];
  imbuedSupport?: string;
}

const RARITY: Record<number, string> = { 0: 'NORMAL', 1: 'MAGIC', 2: 'RARE', 3: 'UNIQUE', 9: 'RELIC', 10: 'RELIC' };
const INFLUENCE: { key: string; display: string }[] = [
  { key: 'shaper', display: 'Shaper' },
  { key: 'elder', display: 'Elder' },
  { key: 'adjudicator', display: 'Warlord' },
  { key: 'basilisk', display: 'Hunter' },
  { key: 'crusader', display: 'Crusader' },
  { key: 'eyrie', display: 'Redeemer' },
  { key: 'cleansing', display: 'Searing Exarch' },
  { key: 'tangle', display: 'Eater of Worlds' },
];
// The website names influences by the item's own words; upstream reads them by the display name in lower case.
const INFLUENCE_FROM_SITE: Record<string, string> = { shaper: 'shaper', elder: 'elder', warlord: 'adjudicator', hunter: 'basilisk', crusader: 'crusader', redeemer: 'eyrie' };
const CATALYST_LIST = ['Abrasive', 'Accelerating', 'Dextral', 'Fertile', 'Imbued', 'Intrinsic', 'Noxious', 'Prismatic', 'Sinistral', 'Tempering', 'Turbulent', 'Unstable'];
const CATALYST_MAP: Record<string, number> = {
  Attack: 1,
  Speed: 2,
  Suffix: 3,
  'Life and Mana': 4,
  Caster: 5,
  Attribute: 6,
  'Physical and Chaos Damage': 7,
  Resistance: 8,
  Prefix: 9,
  Defense: 10,
  'Elemental Damage': 11,
  Critical: 12,
};
const FOIL = ['Amethyst', 'Verdant', 'Ruby', 'Cobalt', 'Sunset', 'Aureate', 'Celestial Quartz', 'Celestial Ruby', 'Celestial Emerald', 'Celestial Aureate', 'Celestial Pearl', 'Celestial Amethyst'];
const SLOT_MAP: Record<string, string> = {
  Weapon: 'Weapon 1',
  Offhand: 'Weapon 2',
  Weapon2: 'Weapon 1 Swap',
  Offhand2: 'Weapon 2 Swap',
  Helm: 'Helmet',
  BodyArmour: 'Body Armour',
  Gloves: 'Gloves',
  Boots: 'Boots',
  Amulet: 'Amulet',
  Ring: 'Ring 1',
  Ring2: 'Ring 2',
  Ring3: 'Ring 3',
  Belt: 'Belt',
  BrequelGrafts: 'Graft 1',
  BrequelGrafts2: 'Graft 2',
};
const ONE_HANDED = /^(One Handed|Thrusting One Handed|Claw|Dagger|Wand|Sceptre|Rune Dagger)/;

const firstNumber = (s: string | undefined): number | undefined => {
  const m = /\d+/.exec(s ?? '');
  return m ? parseInt(m[0], 10) : undefined;
};
/**
 * Upstream's `sanitiseText` (Modules/Common.lua), which `ImportTab` applies to an item's name, base and its gems' names:
 * text with a character above 127 or a "<" loses its balanced <...> parts, dashes become "-", a-umlaut and o-umlaut become
 * "a" and "o" (so "Maelström Staff" finds the base "Maelstrom Staff"), and any other character above 127 becomes one "?" for each
 * byte it takes in UTF-8.
 */
export function sanitiseText(text: string): string {
  if (!/[-￿<]/.test(text)) return text;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '<') {
      // %b<>: from this "<" to its matching ">", nesting counted; an unmatched "<" stays
      let depth = 0;
      let j = i;
      for (; j < text.length; j++) {
        if (text[j] === '<') depth++;
        else if (text[j] === '>' && --depth === 0) break;
      }
      if (j < text.length) {
        i = j;
        continue;
      }
    }
    out += text[i];
  }
  return Array.from(out)
    .map((ch) => {
      const c = ch.codePointAt(0)!;
      if (c < 128) return ch;
      if ((c >= 0x2010 && c <= 0x2015) || c === 0x2212 || c === 0x96 || c === 0x97) return '-';
      if (c === 0xe4) return 'a';
      if (c === 0xf6) return 'o';
      return '?'.repeat(c < 0x800 ? 2 : c < 0x10000 ? 3 : 4);
    })
    .join('');
}

const num = (s: string | undefined): number => {
  const n = parseFloat((s ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
};

function modLines(mods: ModText[] | undefined, flagsOf: (flags: Record<string, boolean>) => string = () => ''): string[] {
  const out: string[] = [];
  for (const m of mods ?? []) {
    const text = typeof m === 'string' ? m : (m.description ?? '');
    const flags = typeof m === 'string' ? {} : (m.flags ?? {});
    for (const l of sanitise(text).split('\n')) {
      const line = l.trim();
      if (line) out.push(flagsOf(flags) + line);
    }
  }
  return out;
}

const explicitFlags = (f: Record<string, boolean>) => (f.fractured ? '{fractured}' : '') + (f.crafted ? '{crafted}' : '') + (f.mutated ? '{mutated}' : '') + (f.vestigial ? '{vestigial}' : '');

/**
 * Writes the item as item text, or returns null for an item upstream skips (an unknown base, or no rarity).
 * `slotName` is set for items that go in a named slot whatever their inventory id (abyssal jewels in sockets).
 */
export function itemToRaw(it: GItem, data: ItemData): { raw: string; baseName: string; sockets: { group: number; color: string }[] } | null {
  let rarity = RARITY[it.frameType ?? -1];
  let title = '';
  let baseName = '';
  let nameLine = '';
  let implicits = it.implicitMods;
  let explicits = it.explicitMods;
  const typeLine = sanitiseText(sanitise(it.typeLine ?? ''));
  const name = sanitiseText(sanitise(it.name ?? ''));
  if (name.length > 0) {
    title = name;
    baseName = typeLine.replace(/Synthesised /g, '').replace(/^Vestigial /, '');
    if (baseName === 'Two-Toned Boots') baseName = 'Two-Toned Boots (Armour/Energy Shield)';
    nameLine = `${title}\n${baseName}`;
  } else {
    let n = typeLine;
    if (n.includes('Energy Blade')) {
      const oneHanded = (it.properties ?? []).some((p) => ONE_HANDED.test(p.name));
      n = oneHanded ? 'Energy Blade One Handed' : 'Energy Blade Two Handed';
      rarity = 'NORMAL';
      implicits = [];
      explicits = [];
    }
    // The base is the longest base name inside the item's name ("Rusted Sword" inside "Honed Rusted Sword of Slaying").
    let best = '';
    for (const b of Object.keys(data.bases)) if (b.length > best.length && n.includes(b)) best = b;
    if (best) baseName = best;
    else if (n.includes('Two-Toned Boots')) baseName = 'Two-Toned Boots (Armour/Energy Shield)';
    nameLine = n;
  }
  let base = data.bases[baseName];
  if (!base || !rarity) return null;

  let quality: number | undefined;
  if (base.weapon || base.armour || base.flask || base.tincture) quality = 0;
  let catalyst: number | undefined;
  let catalystQuality: number | undefined;
  let radius: string | undefined;
  let limit: number | undefined;
  let intangibility: number | undefined;
  let memoryStrands: number | undefined;
  const armour: Record<string, number> = {};
  for (const p of it.properties ?? []) {
    const v0 = p.values?.[0]?.[0];
    if (p.name === 'Quality') quality = firstNumber(v0);
    else if (/^Quality \(/.test(p.name)) {
      const kind = /^Quality \((.*) Modifiers\)/.exec(p.name)?.[1];
      catalyst = kind ? CATALYST_MAP[kind] : undefined;
      catalystQuality = firstNumber(v0);
    } else if (p.name === 'Radius') radius = v0;
    else if (p.name === 'Limited to') limit = firstNumber(v0);
    else if (p.name === 'Evasion Rating') {
      if (baseName === 'Two-Toned Boots (Armour/Energy Shield)') {
        baseName = 'Two-Toned Boots (Armour/Evasion)';
        base = data.bases[baseName] ?? base;
      }
    } else if (p.name === 'Energy Shield') {
      if (baseName === 'Two-Toned Boots (Armour/Evasion)') {
        baseName = 'Two-Toned Boots (Evasion/Energy Shield)';
        base = data.bases[baseName] ?? base;
      }
    } else if (p.name.includes('Intangibility')) intangibility = firstNumber(v0);
    else if (p.name === 'Memory Strands') memoryStrands = firstNumber(v0);
    if (p.name === 'Energy Shield' || p.name === 'Ward' || p.name === 'Armour' || p.name === 'Evasion Rating') {
      const key = p.name.replace(' Rating', '').replace(/ /g, '');
      for (const v of p.values) armour[key] = (armour[key] ?? 0) + num(v[0]);
    }
  }
  // Two-Toned Boots keep their (changed) base name in the text.
  if (name.length > 0) nameLine = `${title}\n${baseName}`;
  else if (/^Two-Toned Boots/.test(nameLine)) nameLine = baseName;

  const out: string[] = [`Rarity: ${rarity}`, nameLine];
  for (const [key, label] of [['Armour', 'Armour'], ['Evasion', 'Evasion'], ['EnergyShield', 'Energy Shield'], ['Ward', 'Ward']] as const) {
    if ((armour[key] ?? 0) > 0) out.push(`${label}: ${armour[key]}`);
  }
  if (intangibility !== undefined) out.push(`Intangibility: ${intangibility}%`);
  if (it.id) out.push(`Unique ID: ${it.id}`);
  const infl: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(it.influences ?? {})) if (v && INFLUENCE_FROM_SITE[k]) infl[INFLUENCE_FROM_SITE[k]!] = true;
  if (it.searing) infl.cleansing = true;
  if (it.tangled) infl.tangle = true;
  for (const i of INFLUENCE) if (infl[i.key]) out.push(`${i.display} Item`);
  if (catalyst && catalyst > 0) out.push(`Catalyst: ${CATALYST_LIST[catalyst - 1]}`);
  if (catalystQuality !== undefined) out.push(`CatalystQuality: ${catalystQuality}`);
  if ((it.ilvl ?? 0) > 0) out.push(`Item Level: ${it.ilvl}`);
  if (memoryStrands !== undefined) out.push(`Memory Strands: ${memoryStrands}`);
  if (quality !== undefined) out.push(`Quality: ${quality}`);

  const sockets = (it.sockets ?? []).map((s) => ({ group: s.group, color: s.sColour }));
  let abyssal = 0;
  for (const s of sockets) if (s.color === 'A') abyssal++;
  if (abyssal > 0 && nameLine.includes('Energy Blade')) explicits = [...(explicits ?? []), `Has ${abyssal} Abyssal Sockets`];
  if (sockets.length) {
    let s = '';
    sockets.forEach((k, i) => {
      s += k.color;
      const next = sockets[i + 1];
      if (next) s += next.group === k.group ? '-' : ' ';
    });
    out.push(`Sockets: ${s}`);
  }
  // Level and class requirements are not trusted when gems are socketed: they may override the item's own.
  let classRestriction: string | undefined;
  let levelReq: string | undefined;
  if (it.requirements && !(it.socketedItems && it.socketedItems.length)) {
    for (const r of it.requirements) {
      if (r.name === 'Level') levelReq = r.values?.[0]?.[0];
      else if (r.name === 'Class:') classRestriction = r.values?.[0]?.[0];
    }
  }
  if (levelReq !== undefined) out.push(`LevelReq: ${levelReq}`);
  if (radius !== undefined) out.push(`Radius: ${radius}`);
  if (limit !== undefined) out.push(`Limited to: ${limit}`);
  if (classRestriction !== undefined) out.push(`Requires Class ${classRestriction}`);

  const enchant = modLines(it.enchantMods).map((l) => `{crafted}${l}`);
  const scourge = modLines(it.scourgeMods).map((l) => `{scourge}${l}`);
  const implicit = modLines(implicits, (f) => (f.vestigial ? '{vestigial}' : ''));
  out.push(`Implicits: ${enchant.length + scourge.length + implicit.length}`);
  out.push(...enchant, ...scourge, ...implicit);
  out.push(...modLines(it.fracturedMods).map((l) => `{fractured}${l}`));
  out.push(...modLines(explicits, explicitFlags));
  out.push(...modLines(it.craftedMods).map((l) => `{crafted}${l}`));
  out.push(...modLines(it.mutatedMods).map((l) => `{mutated}${l}`));
  // Flavour text sometimes carries a real mod ("This item can be anointed by Cassia"): the part inside braces counts.
  for (const f of it.flavourText ?? []) {
    for (let line of f.split('\n')) {
      const a = line.indexOf('{');
      const b = line.indexOf('}');
      if (a >= 0 && b > a) line = line.slice(a + 1, b);
      if (/anointed by Cassia/i.test(line)) out.push(line.trim());
    }
  }
  out.push(...modLines(it.crucibleMods).map((l) => `{crucible}${l}`));
  if (it.split) out.push('Split');
  if (it.duplicated || it.mirrored) out.push('Mirrored');
  if (it.fractured) out.push('Fractured Item');
  if (it.corrupted) out.push('Corrupted');
  if (it.foilVariation !== undefined || it.isRelic) out.push(`Foil Unique (${FOIL[(it.foilVariation ?? 0) - 1] ?? 'Rainbow'})`);
  return { raw: out.join('\n'), baseName, sockets };
}

export interface ImportedItems {
  placements: Placement[];
  groups: GroupOut[];
  skipped: string[];
}

/**
 * Every item of the dump with where it goes, and the socket groups of its gems.
 * `treeJewelSlots` is the tree's list of jewel socket node ids (a jewel's x is an index into it).
 */
export function importItems(items: GItem[], data: ItemData, treeJewelSlots: number[], opts: { ignoreWeaponSwap: boolean; guardian?: boolean }): ImportedItems {
  const out: ImportedItems = { placements: [], groups: [], skipped: [] };
  const one = (it: GItem, slotName?: string) => {
    let slot = slotName;
    let jewelNode: number | undefined;
    if (!slot) {
      if (it.inventoryId === 'PassiveJewels') jewelNode = treeJewelSlots[(it.x ?? 0)];
      else if (it.inventoryId === 'Flask') slot = `Flask ${(it.x ?? 0) + 1}`;
      else if (!(opts.ignoreWeaponSwap && (it.inventoryId === 'Weapon2' || it.inventoryId === 'Offhand2'))) slot = SLOT_MAP[it.inventoryId ?? ''];
      if (!slot && jewelNode === undefined) return; // an item that goes in no known slot
    }
    const r = itemToRaw(it, data);
    if (!r) {
      out.skipped.push(sanitise(it.name || it.typeLine || 'an item'));
      return;
    }
    out.placements.push({ ...(slot ? { slot } : {}), ...(jewelNode !== undefined ? { jewelNode } : {}), raw: r.raw, ...(it.id ? { uniqueId: it.id } : {}), ...(opts.guardian ? { guardian: true } : {}) });
    if (it.socketedItems?.length && slot) socketed(it, r.sockets, slot);
  };
  const socketed = (it: GItem, sockets: { group: number; color: string }[], slot: string) => {
    const byGroup = new Map<number, GroupOut>();
    let abyssalId = 1;
    for (const s of it.socketedItems ?? []) {
      if (s.abyssJewel) {
        one(s, `${slot} Abyssal Socket ${abyssalId}`);
        abyssalId++;
        continue;
      }
      let key = data.gemForBaseName[sanitiseText(sanitise(s.typeLine ?? '')).toLowerCase()];
      if (s.hybrid) {
        key = data.gemForBaseName[sanitiseText(sanitise(s.hybrid.baseTypeName ?? '')).toLowerCase()];
        if (key && s.hybrid.isVaalGem) key = data.vaalGemFor[data.gems[key]?.grantedEffectId ?? ''];
      }
      const row = key ? data.gems[key] : undefined;
      if (!row) continue;
      let level = 20;
      let quality = 0;
      for (const p of s.properties ?? []) {
        if (p.name === 'Level') level = firstNumber(p.values?.[0]?.[0]) ?? level;
        else if (p.name === 'Quality') quality = firstNumber(p.values?.[0]?.[0]) ?? quality;
      }
      const sock = sockets[(s.socket ?? 0)];
      const gid = sock ? sock.group : 0;
      let g = byGroup.get(gid);
      if (!g) {
        g = { slot, gems: [] };
        byGroup.set(gid, g);
      }
      g.gems.push({ row, level, quality });
      if (s.builtInSupport) g.imbuedSupport = s.builtInSupport.replace('Supported by Level 1 ', '');
    }
    out.groups.push(...[...byGroup.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]));
  };
  for (const it of items) one(it);
  return out;
}
