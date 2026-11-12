/**
 * The build header's Loadouts (Build.lua `SyncLoadouts`): a loadout is a tree set with the item, skill and config sets that go
 * with it. Reads and edits the build text; the engine applies the text, so the numbers are always its own.
 */
import { loadoutXml, loadoutsOf, readFacts, type Loadout } from './buildFacts.js';
import { newItemSet } from './itemsXml.js';
import { addSpec, emptySpecXml, readSpecSummaries } from './treeSets.js';

export interface LoadoutRow extends Loadout {
  /** The loadout that is open now: its tree is the active one and each set it names is the active set. */
  active: boolean;
}

export function loadoutRows(xml: string): LoadoutRow[] {
  const f = readFacts(xml);
  return loadoutsOf(f).map((lo) => ({ ...lo, active: lo.spec === f.activeSpec && lo.itemSet === f.activeItemSet && lo.skillSet === f.activeSkillSet && lo.configSet === f.activeConfigSet }));
}

/** The loadout the build text has open, if its sets line up (else null: tree, items, skills and config were picked apart). */
export function activeLoadout(xml: string): LoadoutRow | null {
  return loadoutRows(xml).find((r) => r.active) ?? null;
}

/**
 * Step one of a new loadout: a tree set (same class and ascendancies as the open one, nothing allocated) and an item set,
 * both with the name. The skill set and the config set are added by the engine's own edits, which keep the rest of their
 * structure; then {@link openLoadoutNamed} makes the new loadout the open one.
 */
export function addLoadoutTreeAndItems(xml: string, name: string): string {
  const { active, specs } = readSpecSummaries(xml);
  const base = specs[active - 1] ?? specs[0];
  const withSpec = addSpec(xml, emptySpecXml(name, { classId: base?.classId ?? 0, ascendClassId: base?.ascendClassId ?? 0, secondaryAscendClassId: base?.secondaryAscendClassId ?? 0 }));
  return newItemSet(withSpec, name).xml;
}

/** The build text with the loadout of that name open (the newest one when several share the name). */
export function openLoadoutNamed(xml: string, name: string): string {
  const rows = loadoutRows(xml).filter((r) => r.name === name);
  const lo = rows[rows.length - 1];
  return lo ? loadoutXml(xml, lo) : xml;
}
