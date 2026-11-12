import { baseClassOf, CLASSES } from '../shared/buildXml.js';
import type { BuildInfo } from '../shared/library.js';
import { tr } from './i18n';
import crestUrl from './design/assets/logo/crest-128.png';
import crest256Url from './design/assets/logo/crest-256.webp';

const portraits = import.meta.glob('./design/assets/ascendancy/*.webp', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

function portrait(file: string): string {
  return portraits[`./design/assets/ascendancy/${file}.webp`] ?? '';
}

export const crest = crestUrl;
export const crest256 = crest256Url;

export function classPortrait(className: string): string {
  const key = className.toLowerCase();
  return portrait(CLASSES.some((c) => c.name.toLowerCase() === key) ? key : 'scion');
}

/** The class a build shows: its base class, resolving an ascendancy-only record. */
export function classKey(info: Pick<BuildInfo, 'className' | 'ascendClassName'>): string {
  return baseClassOf(info).toLowerCase() || 'scion';
}

/** The ghost row behind the library: ascendancy art with its vertical offsets, in the design's order. */
export const GHOSTS: { src: string; mt: number }[] = [
  ['a9', 40], ['a1', 0], ['a6', 60], ['a3', 20], ['a11', 50], ['a7', 10], ['a12', 45], ['a2', 5], ['a5', 55], ['a10', 25], ['a8', 35], ['a4', 15], ['a13', 50],
].map(([f, mt]) => ({ src: portrait(f as string), mt: mt as number }));

const A = { Str: tr('h_rA_art.str'), Dex: tr('h_rA_art.dex'), Int: tr('h_rA_art.int') };
export const CLASS_ARC: { name: string; attrs: string }[] = [
  { name: 'Marauder', attrs: A.Str },
  { name: 'Duelist', attrs: `${A.Str} · ${A.Dex}` },
  { name: 'Ranger', attrs: A.Dex },
  { name: 'Shadow', attrs: `${A.Dex} · ${A.Int}` },
  { name: 'Witch', attrs: A.Int },
  { name: 'Templar', attrs: `${A.Str} · ${A.Int}` },
  { name: 'Scion', attrs: `${A.Str} · ${A.Dex} · ${A.Int}` },
];
