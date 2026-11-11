import type { AtlasCoverage, AtlasDataset, DatasetRef, Known, ObservedProgress } from '@pom/mastery-contracts';

const unknown = <T>(reason: string): Known<T> => ({ status: 'unknown', reason });
const known = <T>(value: T, evidenceId: string): Known<T> => ({ status: 'known', value, evidenceId });
export type Membership = 'unknown' | 'allocated' | 'unallocated';
export type AtlasRules = {
  dataset: DatasetRef;
  /** Explicit log ID join supplied by the data adapter; never strip a prefix to guess an ID. */
  logNodeIds: Readonly<Record<string, string>>;
  costs: Known<AtlasDataset['costModel']>;
};
export type AtlasBaseline = {
  kind: 'unknown' | 'manualCount' | 'completeSnapshot'; count: Known<number>;
  nodeSet: string[] | null; contextEpoch: number; dataset: DatasetRef;
  evidenceAt: string | null; coverage: AtlasCoverage;
  membership: Record<string, Membership>; needsChecking: boolean;
};
export function unknownBaseline(dataset: DatasetRef, contextEpoch: number): AtlasBaseline {
  return { kind: 'unknown', count: unknown('Set an Atlas baseline.'), nodeSet: null, contextEpoch, dataset: structuredClone(dataset),
    evidenceAt: null, coverage: 'unknown', membership: {}, needsChecking: false };
}
export function manualBaseline(dataset: DatasetRef, contextEpoch: number, count: number, evidenceAt: string): AtlasBaseline {
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid allocated Atlas count.');
  return { ...unknownBaseline(dataset, contextEpoch), kind: 'manualCount', count: known(count, `manual:${contextEpoch}:${evidenceAt}`),
    evidenceAt, coverage: 'manual_baseline_and_deltas' };
}
/** No existing character-passive endpoint is accepted as an Atlas snapshot provider. */
export function completeBaseline(rules: AtlasRules, contextEpoch: number, nodeIds: string[], evidenceAt: string, evidenceId: string): AtlasBaseline {
  if (!evidenceId || rules.costs.status !== 'known' || !rules.costs.evidenceId || !rules.costs.value.provenance.length) throw new Error('Atlas snapshot requires verified costs and context evidence.');
  const ids = [...new Set(nodeIds)].sort();
  let count = 0;
  for (const id of ids) {
    const cost = Object.hasOwn(rules.costs.value.nodeCosts, id) ? rules.costs.value.nodeCosts[id] : undefined;
    if (!Number.isSafeInteger(cost) || cost! < 0) throw new Error('Atlas snapshot has an unknown node cost.');
    count += cost!;
  }
  if (!Number.isSafeInteger(count)) throw new Error('Atlas snapshot count exceeds the supported range.');
  return { kind: 'completeSnapshot', count: known(count, evidenceId), nodeSet: ids, contextEpoch, dataset: structuredClone(rules.dataset),
    evidenceAt, coverage: 'complete_snapshot', membership: Object.fromEntries(ids.map(id => [id, 'allocated'])), needsChecking: false };
}
export function membershipOf(baseline: AtlasBaseline, nodeId: string): Membership {
  return Object.hasOwn(baseline.membership, nodeId) ? baseline.membership[nodeId]! : baseline.kind === 'completeSnapshot' && !baseline.needsChecking ? 'unallocated' : 'unknown';
}
export function checkBaseline(baseline: AtlasBaseline, reason: string): AtlasBaseline {
  return { ...baseline, count: unknown(reason), nodeSet: null, coverage: 'gap', needsChecking: true };
}
/** Does not contain reviewed IDs or guide position, so respec/rebaseline cannot rewind either. */
export function applyAtlasDelta(baseline: AtlasBaseline, rules: AtlasRules, delta: {
  logNodeId: string; op: 'add' | 'remove'; contextEpoch: number; evidenceId: string; evidenceAt: string;
}): AtlasBaseline {
  if (baseline.contextEpoch !== delta.contextEpoch || baseline.dataset.contentHash !== rules.dataset.contentHash || baseline.dataset.variant !== rules.dataset.variant || baseline.dataset.datasetId !== rules.dataset.datasetId) return checkBaseline(baseline, 'Atlas context or dataset changed.');
  const id = Object.hasOwn(rules.logNodeIds, delta.logNodeId) ? rules.logNodeIds[delta.logNodeId] : undefined;
  if (!id) return checkBaseline(baseline, 'Atlas node mapping is unverified.');
  const desired: Membership = delta.op === 'add' ? 'allocated' : 'unallocated';
  if (membershipOf(baseline, id) === desired) return baseline;
  const membership = { ...baseline.membership, [id]: desired };
  const next: AtlasBaseline = { ...baseline, membership, evidenceAt: delta.evidenceAt };
  const cost = rules.costs.status === 'known' && Object.hasOwn(rules.costs.value.nodeCosts, id) ? rules.costs.value.nodeCosts[id] : undefined;
  if (rules.costs.status !== 'known' || !rules.costs.evidenceId || !rules.costs.value.provenance.length || !Number.isSafeInteger(cost) || cost! < 0) return checkBaseline(next, 'Atlas allocation cost is unverified.');
  if (baseline.needsChecking || baseline.count.status === 'unknown') return next;
  const count = baseline.count.value + (delta.op === 'add' ? cost! : -cost!);
  if (!Number.isSafeInteger(count) || count < 0) return checkBaseline(next, 'Atlas delta contradicts the baseline.');
  next.count = known(count, delta.evidenceId);
  if (baseline.kind === 'completeSnapshot') next.nodeSet = Object.keys(membership).filter(key => membership[key] === 'allocated').sort();
  return next;
}
export type CharacterContext = {
  epoch: number; selected: string | null; detected: string | null;
  state: 'unknown' | 'waiting_next' | 'confirmed' | 'changed'; generationId: string | null;
};
export type TelemetryState = {
  context: CharacterContext; observed: ObservedProgress; baseline: AtlasBaseline;
  cursor: { generationId: string; byteOffset: number; eventId: string } | null;
  retiredGenerationIds: string[];
};
export function emptyObserved(): ObservedProgress {
  return { characterLevel: unknown('Character not confirmed.'), zoneId: unknown('No selected-context zone evidence.'),
    areaLevel: unknown('No selected-context AreaLevel evidence.'), firstMap: unknown('No sourced First-map evidence.'),
    atlas: { allocatedCount: unknown('Set an Atlas baseline.'), nodeIds: unknown('No complete Atlas snapshot.'), coverage: 'unknown',
      available: unknown('Atlas capacity is unverified.'), unspent: unknown('Atlas capacity is unverified.'), earned: unknown('Atlas capacity is unverified.') }, observedAt: null };
}
export function projectBaseline(baseline: AtlasBaseline, observed: ObservedProgress): ObservedProgress {
  return { ...observed, atlas: { ...observed.atlas, allocatedCount: baseline.count, coverage: baseline.coverage,
    nodeIds: baseline.nodeSet ? known([...baseline.nodeSet], baseline.count.status === 'known' ? baseline.count.evidenceId : 'snapshot') : unknown('Only individual observed transitions are known.') } };
}
