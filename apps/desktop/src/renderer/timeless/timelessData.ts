// Find Timeless Jewel: the dialog's constants and its pure logic (weight lists, the jewel item, the trade link). The
// search itself runs in the engine; nothing here invents a number.
import type { TimelessRow } from '@pom/protocol';

export interface JewelType {
  id: number;
  label: string;
  /** The id prefix of this jewel's passives in the Legion data. */
  name: string;
  conqueror: string;
  /** The seed range the jewel has (Elegant Hubris counts in twenties). */
  seeds: [number, number];
}

export const JEWEL_TYPES: JewelType[] = [
  { id: 1, label: 'Glorious Vanity', name: 'vaal', conqueror: 'Vaal', seeds: [100, 8000] },
  { id: 2, label: 'Lethal Pride', name: 'karui', conqueror: 'Karui', seeds: [10000, 18000] },
  { id: 3, label: 'Brutal Restraint', name: 'maraketh', conqueror: 'Maraketh', seeds: [500, 8000] },
  { id: 4, label: 'Militant Faith', name: 'templar', conqueror: 'Templars', seeds: [2000, 10000] },
  { id: 5, label: 'Elegant Hubris', name: 'eternal', conqueror: 'Eternal Empire', seeds: [2000, 160000] },
  { id: 6, label: 'Heroic Tragedy', name: 'kalguur', conqueror: 'Kalguur', seeds: [100, 8000] },
  { id: 7, label: 'Festering Vengeance', name: 'abyss_murderous', conqueror: 'Abyssal', seeds: [100, 8000] },
  { id: 8, label: 'Extinguishing Grasp', name: 'abyss_searching', conqueror: 'Abyssal', seeds: [100, 8000] },
  { id: 9, label: 'Baleful Dominion', name: 'abyss_hypnotic', conqueror: 'Abyssal', seeds: [100, 8000] },
  { id: 10, label: 'Destructive Aspiration', name: 'abyss_ghastly', conqueror: 'Abyssal', seeds: [100, 8000] },
  { id: 11, label: 'Reclaimed Malevolence', name: 'abyss_special', conqueror: 'Abyssal', seeds: [100, 8000] },
];

/** The table file each jewel type reads (without extension). */
export const TABLE_OF: Record<number, string> = {
  1: 'GloriousVanity',
  2: 'LethalPride',
  3: 'BrutalRestraint',
  4: 'MilitantFaith',
  5: 'ElegantHubris',
  6: 'HeroicTragedy',
  7: 'AbyssTecrod',
  8: 'AbyssUlaman',
  9: 'AbyssKurgal',
  10: 'AbyssAmanamu',
  11: 'AbyssZorath',
};

export interface Choice {
  id: number;
  label: string;
}

export const CONQUERORS: Record<number, Choice[]> = {
  1: [{ id: 1, label: 'Any' }, { id: 2, label: 'Doryani (Corrupted Soul)' }, { id: 3, label: 'Xibaqua (Divine Flesh)' }, { id: 4, label: 'Ahuana (Immortal Ambition)' }],
  2: [{ id: 1, label: 'Any' }, { id: 2, label: 'Kaom (Strength of Blood)' }, { id: 3, label: 'Rakiata (Tempered by War)' }, { id: 4, label: 'Akoya (Chainbreaker)' }],
  3: [{ id: 1, label: 'Any' }, { id: 2, label: 'Asenath (Dance with Death)' }, { id: 3, label: 'Nasima (Second Sight)' }, { id: 4, label: 'Balbala (The Traitor)' }],
  4: [{ id: 1, label: 'Any' }, { id: 2, label: 'Avarius (Power of Purpose)' }, { id: 3, label: 'Dominus (Inner Conviction)' }, { id: 4, label: 'Maxarius (Transcendence)' }],
  5: [{ id: 1, label: 'Any' }, { id: 2, label: 'Cadiro (Supreme Decadence)' }, { id: 3, label: 'Victario (Supreme Grandstanding)' }, { id: 4, label: 'Caspiro (Supreme Ostentation)' }],
  6: [{ id: 1, label: 'Any' }, { id: 2, label: 'Vorana (Black Scythe Training)' }, { id: 3, label: 'Uhtred (Celestial Mathematics)' }, { id: 4, label: 'Medved (The Unbreaking Circle)' }],
  7: [{ id: 1, label: 'Tecrod (Overwhelming Hate)' }],
  8: [{ id: 1, label: 'Ulaman (Weighted Exchange)' }],
  9: [{ id: 1, label: 'Kurgal (Reconstructed Essence)' }],
  10: [{ id: 1, label: 'Amanamu (The Loyal Few)' }],
  11: [{ id: 1, label: 'Zorath' }],
};

export const DEVOTION_VARIANTS: Choice[] = [
  { id: 1, label: 'Any' },
  { id: 2, label: 'Totem Damage' },
  { id: 3, label: 'Brand Damage' },
  { id: 4, label: 'Channelling Damage' },
  { id: 5, label: 'Area Damage' },
  { id: 6, label: 'Elemental Damage' },
  { id: 7, label: 'Elemental Resistances' },
  { id: 8, label: 'Effect of non-Damaging Ailments' },
  { id: 9, label: 'Elemental Ailment Duration' },
  { id: 10, label: 'Duration of Curses' },
  { id: 11, label: 'Minion Attack and Cast Speed' },
  { id: 12, label: 'Minions Accuracy Rating' },
  { id: 13, label: 'Mana Regen' },
  { id: 14, label: 'Mana Cost (legacy)' },
  { id: 17, label: 'Mana Cost Efficiency' },
  { id: 15, label: 'Non-Curse Aura Effect' },
  { id: 16, label: 'Defences from Shield' },
];

/** The hover texts of upstream's controls, word for word. */
export const TIPS = {
  socketFilter: ['Enable this option to exclude nodes that you do not have allocated on your active passive skill tree.', "This can be useful if you're never going to path towards those excluded nodes and don't care what happens to them."],
  socketAllocate: ['Double clicking a result also equips the jewel in its jewel socket.', "The socket must be allocated on your current tree; if it isn't, the jewel is only added to your item list.", 'A jewel already in that socket is replaced.'],
  distance: ['This controls the maximum amount of points that need to be spent to grab a node before its filtered out'],
  slider3: ['Seeds that do not meet the minimum weight threshold for a desired node are excluded from the search results.'],
  total: ['Optional: Only show results where total weight meets or exceeds this value.'],
  generate: ['Click this button to generate new fallback node weights, replacing your old ones.'],
  desired: ['This contains a list of your desired nodes along with their primary, secondary, and minimum weights.', 'This list can be updated manually or by selecting the node you want to update via the search dropdown list and then moving the node weight sliders.'],
  fallback: [
    'This contains a list of your fallback nodes along with their primary, secondary, and minimum weights.',
    'This list can be updated manually or by selecting the node you want to update via the search dropdown list and then moving the node weight sliders.',
    'Fallback node weights are only used when no matching entry exists in the desired nodes list, allowing you to override or disable specific automatic weights.',
    'Fallback node weights typically contain automatically generated stat weights based on your current build.',
    'Any manual changes made to your fallback nodes are lost when you click the generate button, as it completely replaces them.',
  ],
  trade: ['Click to generate and open a trade URL for searching for jewels in this list.', 'Paste the URL in a web browser to search.', '', 'You can click to select a row so that search begins from there.', 'After selecting a row You can also shift+click on another row to select a range of rows to search.'],
  searchMore: ["By default, this tool only searches for 4 or 10 (depending on conqueror) seeds at once to preserve sorting.", "This option searches up to 180 or 60 seeds at once if you don't care about the sorting."],
  slider1: (stat: string) => (stat === 'None' ? ['For nodes with multiple stats this slider controls the weight of the first stat listed.'] : ['This slider controls the weight of the following stat:', '        ' + stat]),
  slider2: (stat: string) => (stat === 'None' ? ['For nodes with multiple stats this slider controls the weight of the second stat listed.'] : ['This slider controls the weight of the following stat:', '        ' + stat]),
};

// ---- weight lists -------------------------------------------------------------------------------------------------

/** `parseSearchList`: one row per line, split on commas and white space. */
export function parseRows(text: string): string[][] {
  return text
    .split(/[\r\n]+/)
    .filter((l) => l.length > 0)
    .map((l) => l.split(/[,\s]+/).filter((t) => t.length > 0));
}

export function rowsToText(rows: string[][]): string {
  return rows.map((r) => r.join(', ')).join('\n');
}

/** Rounds like upstream's `round(x, 3)` and prints no trailing zeros. */
export function weightText(x: number): string {
  const r = Math.round(x * 1000) / 1000;
  return String(r);
}

export type Weights = [string, string, string];

/** What the three sliders hold: the primary and secondary weight (0 to 10) and the minimum weight (0 to 500, or "required"). */
export interface SliderValues {
  w1: number;
  w2: number;
  /** 0 to 500; 500 is "Required". */
  min: number;
}

export function weightsOf(s: SliderValues): Weights {
  return [weightText(s.w1), weightText(s.w2), s.min >= 500 ? 'required' : String(Math.round(s.min))];
}

/** Writes `weights` into the row of `id` (when it has one), as `parseSearchList(1, ...)` does. */
export function setRowWeights(text: string, id: string, weights: Weights): string {
  const rows = parseRows(text);
  let changed = false;
  for (const row of rows) {
    if (row[0] === id) {
      row[1] = weights[0];
      row[2] = weights[1];
      row[3] = weights[2];
      changed = true;
    }
  }
  return changed ? rowsToText(rows) : text;
}

/** `updateSliders`: the slider values a row holds. */
export function sliderValuesOf(row: string[]): SliderValues {
  const num = (s: string | undefined, scale: number, max: number) => (s === 'required' ? max : Math.min(Math.max((Number(s) || 0) / scale, 0), 1) * max);
  return { w1: num(row[1], 10, 10), w2: num(row[2], 10, 10), min: row[3] === 'required' ? 500 : Math.min(Math.max(Number(row[3]) || 0, 0), 500) };
}

/** The node select's action: an existing row loads its weights into the sliders, a new one is added with the sliders' weights. */
export function pickNode(text: string, id: string, weights: Weights): { text: string; existing: string[] | null } {
  const rows = parseRows(text);
  const found = rows.find((r) => r[0] === id);
  if (found) return { text, existing: found };
  const line = [id, ...weights].join(', ');
  return { text: text.length > 0 ? text + '\n' + line : line, existing: null };
}

// ---- the jewel item ----------------------------------------------------------------------------------------------

const MF_ALT_LINES = [
  'Totem Damage',
  'Brand Damage',
  'Channelling Damage',
  'Area Damage',
  'Elemental Damage',
  'Elemental Resistances',
  'Effect of non-Damaging Ailments',
  'Elemental Ailment Duration',
  'Duration of Curses',
  'Minion Attack and Cast Speed',
  'Minions Accuracy Rating',
  'Mana Regen',
  'Mana Cost (legacy)',
  'Non-Curse Aura Effect',
  'Defences from Shield',
  'Mana Cost Efficiency',
];

interface LegionItem {
  name: string;
  variants: string[];
  lines: (seed: number) => string[];
  tail: string;
}

const LEGION_ITEMS: Record<number, LegionItem> = {
  1: {
    name: 'Glorious Vanity',
    variants: ['Doryani (Corrupted Soul)', 'Xibaqua (Divine Flesh)', 'Ahuana (Immortal Ambition)'],
    lines: (s) => ['Doryani', 'Xibaqua', 'Ahuana'].map((c) => `Bathed in the blood of ${s} sacrificed in the name of ${c}`),
    tail: 'Passives in radius are Conquered by the Vaal',
  },
  2: {
    name: 'Lethal Pride',
    variants: ['Kaom (Strength of Blood)', 'Rakiata (Tempered by War)', 'Akoya (Chainbreaker)'],
    lines: (s) => ['Kaom', 'Rakiata', 'Akoya'].map((c) => `Commanded leadership over ${s} warriors under ${c}`),
    tail: 'Passives in radius are Conquered by the Karui',
  },
  3: {
    name: 'Brutal Restraint',
    variants: ['Asenath (Dance with Death)', 'Nasima (Second Sight)', 'Balbala (The Traitor)'],
    lines: (s) => ['Asenath', 'Nasima', 'Balbala'].map((c) => `Denoted service of ${s} dekhara in the akhara of ${c}`),
    tail: 'Passives in radius are Conquered by the Maraketh',
  },
  5: {
    name: 'Elegant Hubris',
    variants: ['Cadiro (Supreme Decadence)', 'Victario (Supreme Grandstanding)', 'Caspiro (Supreme Ostentation)'],
    lines: (s) => ['Cadiro', 'Victario', 'Caspiro'].map((c) => `Commissioned ${s} coins to commemorate ${c}`),
    tail: 'Passives in radius are Conquered by the Eternal Empire',
  },
  6: {
    name: 'Heroic Tragedy',
    variants: ['Vorana (Black Scythe Training)', 'Uhtred (Celestial Mathematics)', 'Medved (The Unbreaking Circle)'],
    lines: (s) => ['Vorana', 'Uhtred', 'Medved'].map((c) => `Remembrancing ${s} songworthy deeds by the line of ${c}`),
    tail: 'Passives in radius are Conquered by the Kalguur',
  },
};

/** The Abyss jewels (types 7 to 11): item name, base, the line with the seed and the conqueror's name. */
const ABYSS_ITEMS: Record<number, { name: string; base: string; line: (seed: number) => string }> = {
  7: { name: 'Festering Vengeance', base: 'Murderous Eye Jewel', line: (s) => `Subjugating ${s} souls in the thrall of Tecrod` },
  8: { name: 'Extinguishing Grasp', base: 'Searching Eye Jewel', line: (s) => `Subjugating ${s} souls in the thrall of Ulaman` },
  9: { name: 'Baleful Dominion', base: 'Hypnotic Eye Jewel', line: (s) => `Subjugating ${s} souls in the thrall of Kurgal` },
  10: { name: 'Destructive Aspiration', base: 'Ghastly Eye Jewel', line: (s) => `Subjugating ${s} souls in the thrall of Amanamu` },
  11: { name: 'Reclaimed Malevolence', base: 'Assembled Eye Jewel', line: (s) => `Binding ${s} souls to phylacteries to sustain Zorath` },
};

export interface JewelPick {
  jewelType: number;
  /** The conqueror's id in `CONQUERORS` (1 is "Any"). */
  conqueror: number;
  devotion1: number;
  devotion2: number;
}

/** `GetJewelItem`: the item text of a result. Militant Faith's two devotion modifiers that are "Any" are drawn at random
 * (kept on the row so adding the same row twice gives the same jewel). */
export function jewelItemText(pick: JewelPick, row: Pick<TimelessRow, 'seed' | 'totalText' | 'socketLabel'>, socketKeystone: string, alt?: { a: number; b: number }): { text: string; alt?: { a: number; b: number } } {
  const info = row.socketLabel ?? (socketKeystone || 'Unknown');
  const head = (name: string) => `${name} [${row.seed}; ${row.totalText}; ${info}]`;
  const variant = pick.conqueror === 1 ? 1 : pick.conqueror - 1;
  const common = ['Timeless Jewel', 'League: Legion', 'Limited to: 1 Historic'];
  if (pick.jewelType === 4) {
    let a = pick.devotion1 !== 1 ? pick.devotion1 : alt?.a ?? 2 + Math.floor(Math.random() * 16);
    const b = pick.devotion2 !== 1 ? pick.devotion2 : alt?.b ?? 2 + Math.floor(Math.random() * 16);
    if (a === b) a = (a % 16) + 2;
    const variants = ['Avarius (Power of Purpose)', 'Dominus (Inner Conviction)', 'Maxarius (Transcendence)', ...MF_ALT_LINES];
    const lines = [
      ...['Avarius', 'Dominus', 'Maxarius'].map((c) => `Carved to glorify ${row.seed} new faithful converted by High Templar ${c}`),
      '4% increased Totem Damage per 10 Devotion',
      '4% increased Brand Damage per 10 Devotion',
      'Channelling Skills deal 4% increased Damage per 10 Devotion',
      '4% increased Area Damage per 10 Devotion',
      '4% increased Elemental Damage per 10 Devotion',
      '+2% to all Elemental Resistances per 10 Devotion',
      '3% increased Effect of non-Damaging Ailments on Enemies per 10 Devotion',
      '4% reduced Elemental Ailment Duration on you per 10 Devotion',
      '4% reduced Duration of Curses on you per 10 Devotion',
      '1% increased Minion Attack and Cast Speed per 10 Devotion',
      'Minions have +60 to Accuracy Rating per 10 Devotion',
      'Regenerate 0.6 Mana per Second per 10 Devotion',
      '1% reduced Mana Cost of Skills per 10 Devotion',
      '1% increased effect of Non-Curse Auras per 10 Devotion',
      '3% increased Defences from Equipped Shield per 10 Devotion',
      '3% increased Mana Cost Efficiency per 10 Devotion',
    ];
    const text = [
      head('Militant Faith'),
      ...common,
      'Has Alt Variant: true',
      'Has Alt Variant Two: true',
      ...variants.map((v) => `Variant: ${v}`),
      `Selected Variant: ${variant}`,
      `Selected Alt Variant: ${a + 2}`,
      `Selected Alt Variant Two: ${b + 2}`,
      'Radius: Large',
      'Implicits: 0',
      ...lines.map((l, i) => `{variant:${i + 1}}${l}`),
      'Passives in radius are Conquered by the Templars',
      'Historic',
      '',
    ].join('\n');
    return { text, alt: { a, b } };
  }
  const ab = ABYSS_ITEMS[pick.jewelType];
  if (ab) {
    const text = [head(ab.name), ab.base, 'League: Allflame', 'Limited to: 1 Historic', 'Implicits: 0', ab.line(row.seed), 'Passives affected are Conquered by the Abyssal', 'Historic', ''].join('\n');
    return { text };
  }
  const t = LEGION_ITEMS[pick.jewelType];
  if (!t) throw new Error('This jewel type cannot be added yet.');
  const text = [
    head(t.name),
    ...common,
    ...t.variants.map((v) => `Variant: ${v}`),
    `Selected Variant: ${variant}`,
    'Radius: Large',
    'Implicits: 0',
    ...t.lines(row.seed).map((l, i) => `{variant:${i + 1}}${l}`),
    t.tail,
    'Historic',
    '',
  ].join('\n');
  return { text };
}

// ---- the trade link ----------------------------------------------------------------------------------------------

const TRADE_IDS: Record<number, { keystone: string[]; devotion?: string[] }> = {
  1: { keystone: ['explicit.pseudo_timeless_jewel_doryani', 'explicit.pseudo_timeless_jewel_xibaqua', 'explicit.pseudo_timeless_jewel_ahuana'] },
  2: { keystone: ['explicit.pseudo_timeless_jewel_kaom', 'explicit.pseudo_timeless_jewel_rakiata', 'explicit.pseudo_timeless_jewel_akoya'] },
  3: { keystone: ['explicit.pseudo_timeless_jewel_asenath', 'explicit.pseudo_timeless_jewel_nasima', 'explicit.pseudo_timeless_jewel_balbala'] },
  4: {
    keystone: ['explicit.pseudo_timeless_jewel_avarius', 'explicit.pseudo_timeless_jewel_dominus', 'explicit.pseudo_timeless_jewel_maxarius'],
    devotion: ['explicit.stat_2566390555', 'explicit.stat_2697019412', 'explicit.stat_970844066', 'explicit.stat_1724614884', 'explicit.stat_3103189267', 'explicit.stat_1910205563', 'explicit.stat_1810368194', 'explicit.stat_730530528', 'explicit.stat_4235333770', 'explicit.stat_3808469650', 'explicit.stat_2830135449', 'explicit.stat_2042813020', 'explicit.stat_3293275880', 'explicit.stat_2585926696', 'explicit.stat_2803981661', 'explicit.stat_1355915086'],
  },
  5: { keystone: ['explicit.pseudo_timeless_jewel_cadiro', 'explicit.pseudo_timeless_jewel_victario', 'explicit.pseudo_timeless_jewel_caspiro'] },
  6: { keystone: ['explicit.pseudo_timeless_jewel_vorana', 'explicit.pseudo_timeless_jewel_uhtred', 'explicit.pseudo_timeless_jewel_medved'] },
  7: { keystone: ['explicit.pseudo_timeless_jewel_tecrod'] },
  8: { keystone: ['explicit.pseudo_timeless_jewel_ulaman'] },
  9: { keystone: ['explicit.pseudo_timeless_jewel_kurgal'] },
  10: { keystone: ['explicit.pseudo_timeless_jewel_amanamu'] },
  11: { keystone: ['explicit.pseudo_timeless_jewel_zorath'] },
};

export const TRADE_STATUS = ['securable', 'available', 'onlineleague', 'online', 'any'];
export const TRADE_TYPES = ['Instant buyout', 'Instant buyout and in person', 'In person (online in league)', 'In person (online)', 'Any (includes offline)'];
export const REALMS = ['PC', 'Sony', 'Xbox'];

export interface TradeRequest {
  jewelType: number;
  conqueror: number;
  devotion1: number;
  devotion2: number;
  /** The seeds of the rows to search for. */
  seeds: number[];
  tradeType: number;
  realm: string;
  league: string;
}

/** The pathofexile.com trade search for the seeds (upstream's Open Trade URL button). */
export function tradeUrl(r: TradeRequest): string {
  const ids = TRADE_IDS[r.jewelType]!;
  const filters: Array<{ id: string; value: { min: number; max: number } }> = [];
  for (const seed of r.seeds) {
    const tradeIds = r.jewelType >= 7 ? [ids.keystone[0]!] : r.conqueror > 1 ? [ids.keystone[r.conqueror - 2]!] : ids.keystone;
    for (const id of tradeIds) filters.push({ id, value: { min: seed, max: seed } });
  }
  const stats: unknown[] = [{ filters, type: 'count', value: { min: 1 } }];
  if (ids.devotion) {
    const devotionFilters: Array<{ id: string }> = [];
    if (r.devotion1 > 1) devotionFilters.push({ id: ids.devotion[r.devotion1 - 2]! });
    if (r.devotion2 > 1) devotionFilters.push({ id: ids.devotion[r.devotion2 - 2]! });
    if (devotionFilters.length) stats.push({ filters: devotionFilters, type: 'and' });
  }
  const search = { query: { status: { option: TRADE_STATUS[r.tradeType] ?? 'securable' }, stats }, sort: { price: 'asc' } };
  const realmPath = r.realm.toLowerCase() === 'pc' ? '' : r.realm.toLowerCase() + '/';
  const q = JSON.stringify(search).replace(/[^a-zA-Z0-9]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
  return `https://www.pathofexile.com/trade/search/${realmPath}${r.league}/?q=${q}`;
}

/** The rows a click on Open Trade URL searches: the selected row on, or the shift-click range. `last` is the previous search. */
export function tradeRange(opts: { count: number; sel: number; highlight: number | null; more: boolean; conqueror: number; last: [number, number] | null }): { start: number; end: number; seedCount: number } | null {
  let start: number;
  let end: number;
  if (opts.highlight !== null && !opts.more) {
    start = Math.min(opts.sel, opts.highlight);
    end = Math.max(opts.sel, opts.highlight);
  } else {
    start = opts.sel;
    const max = opts.more ? 180 : 10;
    end = start + Math.floor(max / (opts.conqueror === 1 ? 3 : 1));
  }
  let seedCount = Math.min(opts.count - 1 - (start - 1), end - start) + 1;
  if (opts.last && opts.last[0] === start && opts.last[1] === seedCount) {
    start = end + 1;
    if (start > opts.count) return null;
    seedCount = Math.min(opts.count - start + 1, seedCount);
    end = start + seedCount - 1;
  }
  return { start, end, seedCount };
}

/** "Required ascendancy outcome": the weight list without any ascendancy outcome row, plus the chosen one as `id, 1, 0, 1`. */
export function withOutcome(text: string, outcomeId: string | null): string {
  const rows = parseRows(text).filter((r) => !/^abyss_special_ascendancy_notable_/.test(r[0] ?? ''));
  const lines = rows.map((r) => r.join(', '));
  if (outcomeId) lines.push(`${outcomeId}, 1, 0, 1`);
  return lines.join('\n');
}

/** The outcome a weight list already asks for. */
export function outcomeOf(text: string): string | null {
  const row = parseRows(text).find((r) => /^abyss_special_ascendancy_notable_/.test(r[0] ?? ''));
  return row?.[0] ?? null;
}
