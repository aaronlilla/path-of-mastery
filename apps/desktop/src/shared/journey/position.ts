/**
 * "You are here": zone, level and the next guide steps, from the game log. Pure.
 */
import type { Guide, GuideStep, ZoneInfo } from '../leveling/types.js';
import type { LogEvent } from './logEvent.js';

export interface Position {
  char?: { name: string; cls: string; level: number };
  /** The character level and where it came from. */
  level: number | null;
  levelSource: 'log' | 'sync' | 'unknown';
  zone?: { id: string; name: string; areaLevel: number; act: number };
  /** The name the last level-up or death line gave; used for auto-link. */
  lastNamed: string | null;
}

export interface PositionInput {
  events: readonly LogEvent[];
  /** Follow this character's lines only; null follows whoever the log names. */
  follow: string | null;
  zones: readonly ZoneInfo[];
  guide: Guide | null;
  syncedLevel?: number | null;
  syncedChar?: { name: string; cls: string } | null;
}

/** Steps of the whole guide in order, with the act each belongs to. */
export function flatSteps(guide: Guide | null): { step: GuideStep; act: number }[] {
  const out: { step: GuideStep; act: number }[] = [];
  for (const a of guide?.acts ?? []) for (const s of a.steps) out.push({ step: s, act: a.act });
  return out;
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export function position(inp: PositionInput): Position {
  let zone: Position['zone'];
  let pendingArea: { id: string; level: number } | null = null;
  let char: Position['char'];
  let lastNamed: string | null = null;
  const flat = flatSteps(inp.guide);
  const actOfZone = (id: string, name: string): number => {
    const z = inp.zones.find((x) => x.id === id) ?? inp.zones.find((x) => same(x.name, name));
    if (z) return z.act;
    const arr = flat.find((f) => f.step.kind === 'arrive' && same(f.step.zone, name));
    return arr?.act ?? 0;
  };
  for (const e of inp.events) {
    if (e.t === 'area') pendingArea = { id: e.id, level: e.level };
    else if (e.t === 'zone') {
      const id = pendingArea?.id ?? inp.zones.find((x) => same(x.name, e.name))?.id ?? '';
      const areaLevel = pendingArea?.level ?? inp.zones.find((x) => same(x.name, e.name))?.monsterLevel ?? 0;
      zone = { id, name: e.name, areaLevel, act: actOfZone(id, e.name) };
      pendingArea = null;
    } else if (e.t === 'level') {
      if (inp.follow && !same(inp.follow, e.char)) continue;
      char = { name: e.char, cls: e.cls, level: e.level };
      lastNamed = e.char;
    } else if (e.t === 'death') {
      if (inp.follow && !same(inp.follow, e.char)) continue;
      lastNamed = e.char;
    }
  }
  // A "Generating level" line with no "You have entered" yet (the log is mid-write): show the area id.
  if (pendingArea && !zone) zone = { id: pendingArea.id, name: pendingArea.id, areaLevel: pendingArea.level, act: actOfZone(pendingArea.id, pendingArea.id) };
  if (char) return { char, level: char.level, levelSource: 'log', ...(zone ? { zone } : {}), lastNamed };
  if (inp.syncedLevel != null) {
    const c = inp.syncedChar ? { name: inp.syncedChar.name, cls: inp.syncedChar.cls, level: inp.syncedLevel } : undefined;
    return { ...(c ? { char: c } : {}), level: inp.syncedLevel, levelSource: 'sync', ...(zone ? { zone } : {}), lastNamed };
  }
  return { level: null, levelSource: 'unknown', ...(zone ? { zone } : {}), lastNamed };
}

/**
 * The guide steps a zone entry completes: the first arrive step for that zone that is not ticked, and every unticked
 * step before it. Empty when the zone is not on the route (or already ticked).
 */
export function stepsToTick(guide: Guide | null, ticked: ReadonlySet<string>, zoneName: string): string[] {
  const flat = flatSteps(guide);
  const at = flat.findIndex((f) => f.step.kind === 'arrive' && !ticked.has(f.step.id) && same(f.step.zone, zoneName));
  if (at < 0) return [];
  return flat.slice(0, at + 1).filter((f) => !ticked.has(f.step.id)).map((f) => f.step.id);
}

/** The next unticked steps after the last ticked arrive step. */
export function nextSteps(guide: Guide | null, ticked: ReadonlySet<string>, count = 5): GuideStep[] {
  const flat = flatSteps(guide);
  let from = -1;
  flat.forEach((f, i) => {
    if (f.step.kind === 'arrive' && ticked.has(f.step.id)) from = i;
  });
  return flat.slice(from + 1).filter((f) => !ticked.has(f.step.id)).slice(0, count).map((f) => f.step);
}

/** The act the player is in: the zone's, else the act of the last ticked arrive step. */
export function currentAct(guide: Guide | null, ticked: ReadonlySet<string>, zoneAct?: number): number {
  if (zoneAct) return zoneAct;
  let act = 1;
  for (const f of flatSteps(guide)) if (f.step.kind === 'arrive' && ticked.has(f.step.id)) act = f.act;
  return act;
}
