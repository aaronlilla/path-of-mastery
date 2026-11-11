/**
 * What the engine says about an item (crates/napi `item_info`): the tooltip lines as upstream draws them, and the
 * facts the Items tab needs to edit it and to pick a slot for it.
 */

/** A colour by name; the renderer maps each name to a design token. */
export type ItemColour =
  | 'normal' | 'magic' | 'rare' | 'unique' | 'relic'
  | 'muted' | 'white' | 'positive' | 'negative'
  | 'fire' | 'cold' | 'lightning' | 'chaos'
  | 'str' | 'dex' | 'int' | 'scion' | 'socket-a'
  | 'crafted' | 'fractured' | 'mutated' | 'scourge' | 'custom' | 'crucible' | 'vestigial'
  | 'gem' | 'unsupported' | 'disabled' | 'source' | 'league' | 'memory' | 'intangibility';

export interface TooltipSeg {
  c: ItemColour | null;
  t: string;
}

/** `title` lines are the item's name, `big` the stat and mod lines, `flavour` the italic lore, `sep` a divider. */
export interface TooltipLine {
  k: 'title' | 'big' | 'tip' | 'flavour' | 'sep';
  segs: TooltipSeg[];
}

export interface ItemMod {
  bucket: 'enchant' | 'scourge' | 'implicit' | 'explicit' | 'crucible';
  text: string;
  c: ItemColour;
  /** Index among the item text's non-blank lines, or null for a line the base adds. */
  rawLine: number | null;
  range: number | null;
  scalable: boolean;
  crafted: boolean;
  fractured: boolean;
  custom: boolean;
  mutated: boolean;
  prefix: boolean;
  suffix: boolean;
  unsupported: boolean;
}

export interface ItemInfo {
  valid: boolean;
  /** The item text the engine read: the text given, with crafted modifier lines and database defaults filled in. */
  text?: string;
  name: string;
  title?: string | null;
  baseName?: string;
  /** The base's own key (with any parenthesised suffix). */
  baseKey?: string;
  /** The name to look the item's art up by. */
  artName?: string;
  rarity?: 'NORMAL' | 'MAGIC' | 'RARE' | 'UNIQUE' | 'RELIC';
  headerRarity?: ItemColour;
  type?: string;
  subType?: string | null;
  isWeapon?: boolean;
  /** The jewel's radius label ("Large", "Variable"...) and the index of its ring in the radius list. */
  jewelRadius?: string | null;
  jewelRadiusIndex?: number | null;
  oneHand?: boolean | null;
  quality?: number | null;
  noQuality?: boolean;
  canInfluence?: boolean;
  /** Influence keys: shaper, elder, adjudicator, basilisk, crusader, eyrie, cleansing, tangle. */
  influences?: string[];
  /** The up to two icons the tooltip header shows, by name (Shaper, Fractured, ...). */
  headerInfluence?: string[];
  sockets?: Array<{ c: string; g: number }>;
  socketLimit?: number | null;
  normalSockets?: number;
  abyssalSockets?: number;
  corrupted?: boolean;
  mirrored?: boolean;
  crafted?: boolean;
  catalyst?: string | null;
  catalystQuality?: number | null;
  itemLevel?: number | null;
  levelReq?: number | null;
  implicitCount?: number;
  mods?: ItemMod[];
  cluster?: { size: string; sizeIndex: number } | null;
  charm?: boolean;
  abyssJewel?: boolean;
  variants?: number;
  selectedVariant?: number;
  /** Enchantment slots the item has (1 to 4). */
  maxEnchants?: number;
  anointable?: boolean;
  corruptible?: boolean;
  implicitsLocked?: boolean;
  canAddImplicit?: boolean;
  canCrucible?: boolean;
  /** Some modifier line carries tags (an item copied with its tooltip details). */
  hasModTags?: boolean;
  /** Skills the item grants (`Grants Level 20 Blood Rage`): the skill's id and level. */
  granted?: Array<{ skillId: string; level: number }>;
  /** Armour, Evasion, EnergyShield and Ward of an armour piece, with the rolls and quality applied. */
  defences?: Record<string, number> | null;
  lines: TooltipLine[];
}

export interface CatalogBase {
  name: string;
  type: string;
  subType?: string | null;
  level?: number | null;
  str?: number | null;
  dex?: number | null;
  int?: number | null;
  implicit?: string | null;
  flask: boolean;
  weapon: boolean;
  armour?: boolean;
  melee?: boolean | null;
  oneHand?: boolean | null;
}

export interface CatalogUnique {
  name: string;
  base: string;
  group: string;
  level: number;
  league: string | null;
  source: string | null;
  variants: string[];
  /** The attribute requirements after the unique's own requirement modifiers (what the requirement filter compares). */
  reqStr?: number | null;
  reqDex?: number | null;
  reqInt?: number | null;
  text: string;
}

export interface CatalogRare {
  label: string;
  base: string;
  text: string;
}

export interface ItemCatalog {
  types: string[];
  bases: Record<string, CatalogBase[]>;
  uniques: CatalogUnique[];
  rares: CatalogRare[];
}

/** A skill's tooltip (the gem tooltip), as lines like an item's. */
export interface GemTip {
  name: string;
  lines: TooltipLine[];
}

/** One modifier of a `modPool` result (crates/item/src/modpool.rs `PoolMod`). */
export interface PoolMod {
  id: string;
  affix: string;
  group: string;
  /** 1 is the best tier of this modifier on the base; `tiers` the worst. */
  tier: number;
  tiers: number;
  /** Item level the modifier needs. */
  level: number;
  /** Character level it sets (80% of `level`). */
  reqLevel: number;
  weight: number;
  stats: { text: string; values: { min: number; max: number }[] }[];
  tags: string[];
  source: 'normal' | 'influence' | 'elevated' | 'essence' | 'bench' | 'veiled' | 'delve' | 'exarch' | 'eater';
  influence?: string;
  essence?: string;
}

/** The modifiers that can roll on a base at an item level (`modPool`). */
export interface ModPool {
  base: string;
  baseType: string;
  itemLevel: number;
  prefixLimit: number;
  suffixLimit: number;
  prefixes: PoolMod[];
  suffixes: PoolMod[];
  implicits: PoolMod[];
  anoints: { nodeId: number; name: string; stats: string[]; oils: string[] }[];
  clusterSkills: { id: string; name: string; tag: string; enchant: string[] }[];
}
