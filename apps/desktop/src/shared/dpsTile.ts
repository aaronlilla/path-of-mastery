export interface DpsTile { id: string; label: string }

/**
 * The sidebar's first tile: Full DPS when something is included in it (upstream hides the row at 0), else the best DPS the build has.
 * A minion build whose own damage is nothing shows the minion's (the player's rows would read 0). A pin always wins.
 * `get` reads a stat by id; minion stats are 'Minion.<stat>'. The sidebar and the solve card both use this.
 */
export function dpsTile(get: (id: string) => number | undefined, pin?: DpsTile): DpsTile {
  if (pin) return pin;
  const pos = (id: string) => (get(id) ?? 0) > 0;
  if (pos('FullDPS')) return { id: 'FullDPS', label: 'FULL DPS' };
  if (pos('CombinedDPS')) return { id: 'CombinedDPS', label: 'COMBINED DPS' };
  if (pos('TotalDPS')) return { id: 'TotalDPS', label: 'HIT DPS' };
  if (pos('Minion.CombinedDPS')) return { id: 'Minion.CombinedDPS', label: 'MINION COMBINED DPS' };
  if (pos('Minion.TotalDPS')) return { id: 'Minion.TotalDPS', label: 'MINION HIT DPS' };
  return { id: 'TotalDPS', label: 'HIT DPS' };
}

/** The card's headline: the tile's stat, label and value for one build's stats. `cull`: the build's cull multiplier (1 = none). */
export function cardTile(get: (id: string) => number | undefined): { stat: string; label: string; value: number; cull: number } {
  const t = dpsTile(get);
  return { stat: t.id, label: t.label, value: get(t.id) ?? 0, cull: get('CullMultiplier') ?? 1 };
}

/** Why the sidebar figure sits above the tested single-target one: the cull share (percent, 0 = none) and Full DPS' other skills. null when they match. The panel words it (tr). */
export function tileGap(tile: { stat: string; value: number; cull: number }, tested: number): { cull: number; extraSkills: boolean } | null {
  if (!(tested > 0) || tile.value <= tested * 1.005) return null;
  const cull = tile.cull > 1.005 ? tile.cull : 1;
  const extraSkills = tile.stat === 'FullDPS' && tile.value > tested * cull * 1.005;
  return cull > 1 || extraSkills ? { cull: cull > 1 ? Math.round((cull - 1) * 100) : 0, extraSkills } : null;
}
