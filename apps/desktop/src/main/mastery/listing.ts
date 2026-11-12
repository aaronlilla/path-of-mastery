// Listing metadata derived from the source itself at publish time: never typed by the creator.
import type { AtlasDataset, AtlasPlan, BuildSnapshot, DatasetRef } from '@pom/mastery-contracts';

const MECHANIC = /^mechanic:[a-z0-9-]{1,55}$/;

/**
 * The mechanics an Atlas plan invests in: each verified taxonomy target (`mechanic:*`) that has at least one of its nodes allocated in any
 * step of the plan. Optimizer targets that were never applied do not count. Sorted, unique, at most 64.
 */
export function planMechanics(plan: AtlasPlan, taxonomyOf: (ref: DatasetRef) => AtlasDataset['taxonomy'] | null): string[] {
  const allocated = new Set(Object.values(plan.stepsById).flatMap(step => step.allocatedIds));
  const out = new Set<string>();
  for (const target of taxonomyOf(plan.dataset)?.targets ?? []) {
    if (MECHANIC.test(target.targetId) && target.verified.status === 'known' && target.verified.value && target.nodeIds.some(id => allocated.has(id))) out.add(target.targetId);
  }
  return [...out].sort().slice(0, 64);
}

/** Class and ascendancy of a frozen Build (read from its XML when it was frozen). */
export function buildClass(build: BuildSnapshot): { className: string | null; ascendancy: string | null } {
  return { className: build.className ?? null, ascendancy: build.ascendancy ?? null };
}
