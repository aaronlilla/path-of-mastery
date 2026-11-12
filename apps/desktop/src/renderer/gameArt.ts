import type { GemColour } from '@pom/protocol';
import { ATTR } from '../shared/skillsLogic';
// Game art for any named game object (item, unique, base, gem, currency, map, ...). The images live in
// public/game (fetched once per league and stored in the repository); the name index is bundled.
import index from './gameArtIndex.json';

interface ArtEntry {
  file: string;
  url?: string | null;
  category: string;
  fallback?: string;
}

const entries = index as unknown as Record<string, ArtEntry>;

/** Engine gem names drop the " Support" suffix the art index may carry, and the reverse. */
function lookup(name: string, category?: string): ArtEntry | undefined {
  const keys = category ? [`${category}:${name}`, name] : [name];
  for (const k of keys) {
    const e = entries[k];
    if (e) return e;
  }
  if (name.endsWith(' Support')) return lookup(name.slice(0, -' Support'.length), category);
  return category === 'gems' ? entries[`gems:${name} Support`] : undefined;
}

/**
 * The image URL for a game object, or undefined when there is none (show no image rather than a wrong one).
 * `category` narrows the lookup where one name exists in several categories (`gems`, `uniques`, `bases`, ...).
 */
export function artFor(name: string | undefined | null, category?: string): string | undefined {
  if (!name) return undefined;
  const e = lookup(name, category);
  if (!e) return undefined;
  // Paths are relative to the poe folder; slot silhouettes live one level up (../ui/...).
  return `game/poe/${e.file}`.replace('game/poe/../', 'game/');
}

/** Whether the index holds this name in this category. */
export function hasArt(category: string, name: string): boolean {
  return `${category}:${name}` in entries;
}

let baseKeys: string[] | null = null;
/** Every base item name the index holds. */
export function baseArtNames(): string[] {
  baseKeys ??= Object.keys(entries).filter((k) => k.startsWith('bases:')).map((k) => k.slice(6));
  return baseKeys;
}

/** Whether the art is a stand-in (same-base, parent gem, slot silhouette, card frame) rather than the object's own. */
export function isFallbackArt(name: string, category?: string): boolean {
  return Boolean(lookup(name, category)?.fallback);
}

// ---- helpers the Configuration and Skills tabs use ----

/** Where the bundled game art lives (public/game). */
export const ART_BASE = './game/';

/** Gem icon by gem name, or the plain coloured frame (pass the colour) when the art has none, so no missing file is requested. */
export function gemArt(name: string, colour: GemColour = 'str'): string {
  return artFor(name, 'gems') ?? gemFrame(colour);
}

/** The plain coloured gem frame, for a gem with no art of its own. */
export function gemFrame(colour: GemColour): string {
  return `${ART_BASE}poe/gems/${ATTR[colour].frame}.png`;
}

/** Item slot icon (Weapon 1, Body Armour, ...). */
export function slotIcon(slot: string): string {
  const s = slot.toLowerCase();
  const file = s.startsWith('weapon 2') ? 'icon_weapon_2' : s.startsWith('weapon') ? 'icon_weapon' : s.startsWith('helmet') ? 'icon_helmet' : s.startsWith('body') ? 'icon_body_armour' : s.startsWith('gloves') ? 'icon_gloves' : s.startsWith('boots') ? 'icon_boots' : s.startsWith('amulet') ? 'icon_amulet' : s === 'ring 2' || s === 'ring 3' ? 'icon_ring_right' : s.startsWith('ring') ? 'icon_ring_left' : s.startsWith('belt') ? 'icon_belt' : '';
  return file ? `${ART_BASE}ui/${file}.png` : '';
}

/** The socket art for an item socket colour. */
export function socketIcon(colour: GemColour): string {
  return `${ART_BASE}poe/ui/${ATTR[colour].icon}.png`;
}
