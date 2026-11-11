import { tr } from '../i18n';

/** tr() for keys built at run time (the typed tr() only takes literal keys). */
const dyn = tr as unknown as (key: string) => string;

// Display names for the filter data the shared module keeps in English (colours, shapes, strictness levels, styles).
// The stored value stays English; only what the player reads goes through here.

const COLOURS: Record<string, () => string> = {
  Red: () => tr('labels.red'),
  Green: () => tr('lootfilter_guided_Wizard_2.green'),
  Blue: () => tr('lootfilter_guided_Wizard_2.blue'),
  Brown: () => tr('h_lootB_Names.brown'),
  White: () => tr('labels.white'),
  Yellow: () => tr('labels.yellow'),
  Cyan: () => tr('lootfilter_guided_Wizard_2.cyan'),
  Grey: () => tr('h_lootB_Names.grey'),
  Orange: () => tr('lootfilter_guided_Wizard_2.orange'),
  Pink: () => tr('lootfilter_guided_Wizard_2.pink'),
  Purple: () => tr('lootfilter_guided_Wizard_2.purple'),
  Black: () => tr('lootfilter_guided_Wizard_2.black'),
  'Pale blue': () => tr('lootfilter_guided_Wizard_2.pale_blue'),
  Teal: () => tr('lootfilter_guided_Wizard_2.teal'),
  'Dark red': () => tr('lootfilter_guided_Wizard_2.dark_red'),
};
export const colourName = (c: string): string => COLOURS[c]?.() ?? c;

const SHAPES: Record<string, () => string> = {
  Circle: () => tr('h_lootB_Names.circle'),
  Diamond: () => tr('lootfilter_guided_Wizard_2.diamond'),
  Hexagon: () => tr('lootfilter_guided_Wizard_2.hexagon'),
  Square: () => tr('lootfilter_guided_Wizard_2.square'),
  Star: () => tr('lootfilter_guided_Wizard_2.star'),
  Triangle: () => tr('lootfilter_guided_Wizard_2.triangle'),
  Cross: () => tr('h_lootB_Names.cross'),
  Moon: () => tr('h_lootB_Names.moon'),
  Raindrop: () => tr('h_lootB_Names.raindrop'),
  Kite: () => tr('h_lootB_Names.kite'),
  Pentagon: () => tr('h_lootB_Names.pentagon'),
  UpsideDownHouse: () => tr('h_lootB_Names.upside_down_house'),
};
export const shapeName = (s: string): string => SHAPES[s]?.() ?? s;

/** Minimap icon size index (0 large, 1 medium, 2 small). */
export const sizeName = (i: number): string => [tr('lootfilter_guided_Wizard_2.large'), tr('lootfilter_guided_Wizard_2.medium'), tr('lootfilter_guided_Wizard_2.small')][i] ?? '';

/** NeverSink's seven strictness levels (STRICTNESS in shared/lootfilter/styles). */
export const strictName = (i: number): string =>
  [tr('h_lootB_Names.s0'), tr('h_lootB_Names.s1'), tr('h_lootB_Names.s2'), tr('h_lootB_Names.s3'), tr('h_lootB_Names.s4'), tr('h_lootB_Names.s5'), tr('h_lootB_Names.s6')][i] ?? '';
export const strictBlurb = (i: number): string =>
  [tr('h_lootB_Names.sb0'), tr('h_lootB_Names.sb1'), tr('h_lootB_Names.sb2'), tr('h_lootB_Names.sb3'), tr('h_lootB_Names.sb4'), tr('h_lootB_Names.sb5'), tr('h_lootB_Names.sb6')][i] ?? '';

/** Guided's five labels (GUIDED_STRICTNESS). */
export const guidedName = (i: number): string =>
  [tr('lootfilter_guided_Guided_2.everything'), tr('lootfilter_guided_Guided_2.relaxed'), tr('lootfilter_guided_Guided_2.semi_strict'), tr('lootfilter_guided_Guided_2.strict'), tr('lootfilter_guided_Guided_2.very_strict')][i] ?? '';
export const guidedBlurb = (i: number): string =>
  [tr('h_lootB_Names.gb0'), tr('h_lootB_Names.gb1'), tr('h_lootB_Names.gb2'), tr('h_lootB_Names.gb3'), tr('h_lootB_Names.gb4')][i] ?? '';

/** Whole-filter styles (STYLES), by index. */
export const styleName = (i: number): string => [tr('h_lootB_Names.st0'), tr('h_lootB_Names.st1'), tr('h_lootB_Names.st2'), tr('h_lootB_Names.st3')][i] ?? '';
export const styleBlurb = (i: number): string => [tr('h_lootB_Names.sbs0'), tr('h_lootB_Names.sbs1'), tr('h_lootB_Names.sbs2'), tr('h_lootB_Names.sbs3')][i] ?? '';

/** Customize tree: group heading and section name, by the English shared-data value. */
const GROUP_KEY: Record<string, string> = {
  'Currency and rewards': 'g_currency', 'Your build': 'g_build', 'Endgame (level 68+)': 'g_endgame', 'Gems, flasks and jewels': 'g_gems',
  Leveling: 'g_leveling', 'Heist and Sanctum': 'g_heist', Fallbacks: 'g_fallbacks',
};
export const groupName = (g: string): string => (GROUP_KEY[g] ? dyn(`h_lootB_Sect.${GROUP_KEY[g]}`) : g);
export const sectionName = (def: { id: string; name: string }): string => dyn(`h_lootB_Sect.${def.id}`);

/** Guided's six category tiles (GUIDED_SECTIONS), name and subtitle. */
export const gsecName = (sec: { id: string }): string => dyn(`h_lootB_GSec.${sec.id}`);
export const gearKindName = (id: string, fallback: string): string => (['body', 'helmet', 'gloves', 'boots', 'belt', 'ring', 'amulet', 'shield', 'quiver', 'flask', 'jewel', 'weapon'].includes(id) ? dyn(`h_lootB_Gear.${id}`) : fallback);
export const gsecSub =(sec: { id: string }): string => dyn(`h_lootB_GSec.sub_${sec.id}`);
