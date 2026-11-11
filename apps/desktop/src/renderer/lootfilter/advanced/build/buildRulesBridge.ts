import type { Catalog } from '../../../../shared/lootfilter/catalog.js';
import type { FilterDoc, Rule } from '../../../../shared/lootfilter/types.js';
import { proposalsFor, proposalsForUse, readBuildFacts } from '../../../../shared/lootfilter/buildRules.js';
import type { OpenBuild } from '../../../types';
import { useBuildRules } from '../../buildRulesHook';

/** The seam to the build-derived rules (src/shared/lootfilter/buildRules.ts and buildRulesHook.ts). */

export interface BuildRulesInput {
  build: OpenBuild;
  doc: FilterDoc;
  catalog: Catalog | null;
  newId(prefix?: string): string;
  nextPriority(): number;
}

export const buildRulesAvailable = (): boolean => true;

/** The rules a build asks for, with `source: 'build'` and a `why` on each. Null when the build cannot be read. */
export async function deriveBuildRules(input: BuildRulesInput): Promise<Rule[] | null> {
  const facts = readBuildFacts(input.build.xml);
  if (!facts) return null;
  const ps = input.doc.setup.followBuild ? proposalsFor(facts, input.catalog, -1000) : proposalsForUse(input.doc.setup.use, -1000);
  return ps.map((p) => p.rule);
}

export type RereadFn = () => void | Promise<void>;

/** Returns the "Read build again" action: writes the build's rules into the filter, keeping the player's on/off choices. */
export function useBuildRulesHook(): { reread: RereadFn } {
  const br = useBuildRules();
  return { reread: () => br.apply() };
}
