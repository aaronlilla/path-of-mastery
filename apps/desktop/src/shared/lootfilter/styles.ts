import type { Color, FilterSetup, LabelStyle } from './types.js';
import { themeScopeOfType } from './sections.js';

/** NeverSink's seven strictness files, in order. Guided uses the first five. */
export const STRICTNESS = [
  { id: '0-SOFT', name: 'Soft', file: '0-SOFT.filter', blurb: 'Shows nearly everything. For the first hours of a league.' },
  { id: '1-REGULAR', name: 'Regular', file: '1-REGULAR.filter', blurb: 'Hides currency shards and plain gear once you reach maps.' },
  { id: '2-SEMI-STRICT', name: 'Semi-Strict', file: '2-SEMI-STRICT.filter', blurb: 'Hides currency worth less than about 1c per slot, and normal and magic gear in maps.' },
  { id: '3-STRICT', name: 'Strict', file: '3-STRICT.filter', blurb: 'Also hides Chromatic Orbs, Transmutation and rares without a crafting base.' },
  { id: '4-VERY-STRICT', name: 'Very Strict', file: '4-VERY-STRICT.filter', blurb: 'Also hides Portal and Wisdom scrolls, low-tier maps and cheap cards.' },
  { id: '5-UBER-STRICT', name: 'Uber Strict', file: '5-UBER-STRICT.filter', blurb: 'Hides everything under about 5c except your build items and stacks.' },
  { id: '6-UBER-PLUS-STRICT', name: 'Uber Plus Strict', file: '6-UBER-PLUS-STRICT.filter', blurb: 'Shows only items worth about 20c or more, plus your build items.' },
] as const;

/** Guided's five labels map onto the first five files. */
export const GUIDED_STRICTNESS = [
  { index: 0, name: 'Everything', blurb: 'Nothing is hidden. Best while leveling.' },
  { index: 1, name: 'Relaxed', blurb: 'Hides only the cheapest scraps.' },
  { index: 2, name: 'Semi-strict', blurb: 'Hides most junk. Keeps anything worth a few chaos.' },
  { index: 3, name: 'Strict', blurb: 'Only good drops stay.' },
  { index: 4, name: 'Very strict', blurb: 'Only valuable drops. Best for fast mapping.' },
] as const;

export interface StylePreset {
  id: string;
  name: string;
  blurb: string;
}

/** Whole-filter restyles. Index 0 leaves NeverSink's colours alone. */
export const STYLES: StylePreset[] = [
  { id: 'standard', name: 'Standard', blurb: 'NeverSink colours' },
  { id: 'dark', name: 'Dark', blurb: 'Dark boxes' },
  { id: 'minimal', name: 'Minimal', blurb: 'Black label, no border, no beams. Text only.' },
  { id: 'vivid', name: 'Vivid', blurb: 'Brighter, bigger' },
];

const lum = (c: Color): number => {
  const f = (v: number): number => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(c[0]!) + 0.7152 * f(c[1]!) + 0.0722 * f(c[2]!);
};

/** Least contrast between label text and its background that the themes allow. */
export const MIN_TEXT_CONTRAST = 3;

const isLight = (bg: Color | undefined): boolean => !!bg && (bg[3] ?? 255) > 200 && lum(bg) > 0.25;

/** Applies a whole-filter style to one label look. Pure: used by the writer and by every on-screen preview. */
export function applyStylePreset(s: LabelStyle, styleIndex: number): LabelStyle {
  if (styleIndex === 1) {
    if (!s.bg || !isLight(s.bg)) return s;
    return { ...s, bg: [Math.round(s.bg[0]! * 0.2), Math.round(s.bg[1]! * 0.2), Math.round(s.bg[2]! * 0.2), 235], fg: s.bg.slice(0, 3), bd: s.bg.slice(0, 3) };
  }
  if (styleIndex === 2) {
    // Black label, no border, no beam; the text keeps the colour the tier is known by, as long as it can be
    // read on black. Otherwise the next colour the label already used (its background, text or border), and
    // white when none of them can be read.
    const light = isLight(s.bg);
    const out: LabelStyle = { ...s, bg: [0, 0, 0, 255], bd: [0, 0, 0, 0] };
    const rgb = (c: Color | undefined): Color | undefined => (c ? [c[0]!, c[1]!, c[2]!] : undefined);
    // On a light label the text colour is the tier's colour when it has one (red text on white stays red); a black or grey text
    // on a coloured background is not, so the background's colour stands for the tier.
    const chroma = (c: Color | undefined): boolean => !!c && Math.max(c[0]!, c[1]!, c[2]!) - Math.min(c[0]!, c[1]!, c[2]!) > 60;
    const pool = (light && !chroma(s.fg) ? [s.bg, s.fg, s.bd] : [s.fg, s.bg, s.bd]).map(rgb);
    const ok = (c: Color | undefined): c is Color => !!c && (c[3] ?? 255) > 0 && contrast(c, [0, 0, 0, 255]) >= MIN_TEXT_CONTRAST;
    const pick = pool.find(ok);
    if (s.fg || light) out.fg = pick ?? [255, 255, 255];
    if (s.beam) out.beam = null;
    return out;
  }
  if (styleIndex === 3) {
    const out: LabelStyle = { ...s };
    if (s.fg) out.bd = s.fg;
    if (s.fs !== undefined) out.fs = Math.min(45, s.fs + 2);
    if (s.beam && s.beam.temp) out.beam = { colour: s.beam.colour };
    return out;
  }
  return s;
}

/** The style index the setup gives a NeverSink `$type`: the scope's own style when it has one, else the whole-filter style. */
export function styleIndexFor(setup: Pick<FilterSetup, 'style' | 'styleCurrency' | 'styleGear'>, type: string | undefined): number {
  const sc = themeScopeOfType(type);
  if (sc === 'currency' && setup.styleCurrency !== undefined) return setup.styleCurrency;
  if (sc === 'gear' && setup.styleGear !== undefined) return setup.styleGear;
  return setup.style;
}

/** The style fields every generator call takes, from the filter's setup. */
export function styleInput(setup: Pick<FilterSetup, 'style' | 'styleCurrency' | 'styleGear' | 'stackedTiering'>): { style: number; styleCurrency?: number; styleGear?: number; stackedTiering?: boolean } {
  return {
    style: setup.style,
    ...(setup.stackedTiering === false ? { stackedTiering: false } : {}),
    ...(setup.styleCurrency !== undefined ? { styleCurrency: setup.styleCurrency } : {}),
    ...(setup.styleGear !== undefined ? { styleGear: setup.styleGear } : {}),
  };
}

export const COLOUR_HEX: Record<string, string> = {
  Red: '#ff4a3d',
  Green: '#3ee06a',
  Blue: '#4f7cff',
  Brown: '#b27240',
  White: '#f4f4f4',
  Yellow: '#ffe23d',
  Cyan: '#3de2e2',
  Grey: '#9b9b9b',
  Orange: '#ff9933',
  Pink: '#ff79c6',
  Purple: '#b25cff',
};

/** 10x10 paths for the twelve minimap shapes, as drawn in the design. */
export const SHAPE_PATH: Record<string, string> = {
  Circle: 'M5 1A4 4 0 1 1 4.99 1Z',
  Diamond: 'M5 .6L9.4 5 5 9.4 .6 5Z',
  Hexagon: 'M5 .6L8.9 2.8V7.2L5 9.4 1.1 7.2V2.8Z',
  Square: 'M1.4 1.4H8.6V8.6H1.4Z',
  Star: 'M5 .5L6.3 3.6 9.6 3.8 7.1 6 7.9 9.3 5 7.5 2.1 9.3 2.9 6 .4 3.8 3.7 3.6Z',
  Triangle: 'M5 .8L9.6 9H.4Z',
  Cross: 'M3.6 .6H6.4V3.6H9.4V6.4H6.4V9.4H3.6V6.4H.6V3.6H3.6Z',
  Moon: 'M6.2 .8A4.4 4.4 0 1 0 9.4 7 3.6 3.6 0 1 1 6.2 .8Z',
  Raindrop: 'M5 .4C6.8 3 8.6 4.9 8.6 6.4A3.6 3.6 0 0 1 1.4 6.4C1.4 4.9 3.2 3 5 .4Z',
  Kite: 'M5 .4L8.8 3.8 5 9.6 1.2 3.8Z',
  Pentagon: 'M5 .5L9.5 3.8 7.8 9.3H2.2L.5 3.8Z',
  UpsideDownHouse: 'M1 .8H9V5.4L5 9.4 1 5.4Z',
};

export const ICON_PX = [12, 10, 8] as const;

/** The game's 16 alert sounds. The numbers are what `PlayAlertSound` takes; the names are ours, for the pickers. */
export const SOUND_NAMES = ['Chime', 'Bell', 'Gong', 'Drum', 'Horn', 'Crash', 'Coin', 'Whistle', 'Harp', 'Pluck', 'Bloom', 'Knock', 'Sparkle', 'Toll', 'Rattle', 'Thud'] as const;

/** The game's own label colours (the 14 swatches NeverSink uses most). */
export const GAME_SWATCHES: Color[] = [
  [255, 0, 0], [255, 255, 255], [0, 0, 0], [240, 90, 35], [249, 150, 25], [213, 159, 100], [190, 178, 135],
  [175, 96, 37], [53, 13, 13], [0, 0, 255], [255, 0, 175], [145, 215, 230], [27, 162, 155], [255, 255, 119],
];

export function rgba(c: Color | undefined): string {
  if (!c) return 'transparent';
  const a = (c[3] ?? 255) / 255;
  return `rgba(${c[0]},${c[1]},${c[2]},${+a.toFixed(3)})`;
}

export function contrast(a: Color, bg: Color, ground: Color = [22, 19, 16]): number {
  const al = (bg[3] ?? 255) / 255;
  const b: Color = [0, 1, 2].map((i) => bg[i]! * al + ground[i]! * (1 - al));
  const x = lum(a);
  const y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

export { lum };

/** Game font size (pt, 18 to 45; below 18 the game draws 18) to the pixels a label is drawn at: 0.78 px per pt, so size 45 is 35 px. Every chip in the app uses this one mapping. */
export const LABEL_PX_PER_PT = 0.78;
/** The prototype draws every Advanced label (Overview, Customize, Simulate) at one design size, 24 px, whatever the game font size. */
export const LABEL_DESIGN_PX = 24;
export const gameLabelPx = (fs: number | undefined): number => Math.round(Math.max(18, Math.min(45, fs ?? 32)) * LABEL_PX_PER_PT);
