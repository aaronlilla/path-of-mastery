// The sidebar's stat sections: their saved order and the two pinned headline stats (design: Build Tree Frame,
// gOrderIds / moveGroup / pinStat).

/** The saved order with any section it does not know dropped and any section it lacks added at its default place. */
export function orderedGroups(saved: readonly string[] | null | undefined, defaults: readonly string[]): string[] {
  const kept = (saved ?? []).filter((id, i, all) => defaults.includes(id) && all.indexOf(id) === i);
  return [...kept, ...defaults.filter((id) => !kept.includes(id))];
}

/** Moves one section up (-1) or down (1); the same order when it is already at that end. */
export function moveGroup(order: readonly string[], id: string, d: -1 | 1): string[] {
  const out = [...order];
  const i = out.indexOf(id);
  const j = i + d;
  if (i < 0 || j < 0 || j >= out.length) return out;
  out.splice(i, 1);
  out.splice(j, 0, id);
  return out;
}

/**
 * Clicking a stat row: a stat already shown in a headline tile only flashes its section; any other stat takes the
 * right tile. `shown` is what the two tiles show now (the defaults included); `pins` is what is saved ('' = default).
 */
export function pinClick(pins: readonly [string, string], shown: readonly [string, string], stat: string): { pins: [string, string]; changed: boolean } {
  if (shown.includes(stat)) return { pins: [pins[0], pins[1]], changed: false };
  return { pins: [pins[0], stat], changed: true };
}

/** The two saved pins from the settings list ('' for a tile that shows its default). */
export function readPins(list: readonly string[] | null | undefined): [string, string] {
  return [typeof list?.[0] === 'string' ? list[0] : '', typeof list?.[1] === 'string' ? list[1] : ''];
}
