import type { AtlasDataset } from '@pom/mastery-contracts';
import { atlasDatasetDigest, hashJson } from '../../../main/kb/sources/atlas.js';
import { syntheticDataset } from '../editor/fixtureSource.js';

/** Synthetic only: made-up names, costs and groups. Nothing here is a game fact. */
import { MECHANIC_NAMES, SUSTAIN } from './fixtureConstants.js';
export { MECHANIC_NAMES, SUSTAIN };
const edges: [string, string][] = [['root', 'a1'], ['a1', 'a2'], ['a2', 'alpha1'], ['alpha1', 'alpha2'], ['root', 'b1'], ['b1', 'beta1'], ['beta1', 'b2'], ['b2', 'beta2'],
  ['root', 'c1'], ['c1', 'c2'], ['c2', 'c3'], ['c3', 'gamma1'], ['a1', 'c1'], ['b2', 'd1'], ['d1', 'delta1'], ['a2', 'd1'], ['c3', 'zeta1'], ['zeta1', 'e1'], ['e1', 'eps1'], ['beta2', 'e1'],
  ['root', 's1'], ['s1', 'sus1'], ['s1', 'sus2']];
const cost: Record<string, number> = { root: 0, a1: 1, a2: 1, alpha1: 1, alpha2: 1, b1: 1, beta1: 1, b2: 1, beta2: 1, c1: 1, c2: 1, c3: 1, gamma1: 1, d1: 2, delta1: 1, e1: 1, eps1: 1, zeta1: 0, s1: 1, sus1: 1, sus2: 1 };
export function optimizerDataset(opts: { taxonomy?: 'verified' | 'unverified'; sustain?: boolean } = {}): AtlasDataset {
  const data = syntheticDataset(), ids = Object.keys(cost);
  const adj = new Map(ids.map(id => [id, [] as string[]]));
  for (const [x, y] of edges) { adj.get(x)!.push(y); adj.get(y)!.push(x); }
  const stat = data.graph.nodes[1]!.stats[0]!;
  data.graph.rootId = 'root';
  data.graph.nodes = ids.map(nodeId => ({ nodeId, name: nodeId === 'root' ? 'Synthetic root' : `Synthetic ${nodeId}`, adjacentIds: adj.get(nodeId)!, asset: null,
    stats: /\d$/.test(nodeId) && /^(alpha|beta|gamma|delta|eps|zeta|sus)/.test(nodeId) ? [{ ...stat, sourceText: `Synthetic ${nodeId} effect` }] : [] }));
  data.graph.graphHash = hashJson({ rootId: data.graph.rootId, nodes: data.graph.nodes });
  data.costModel.nodeCosts = { ...cost };
  data.costModel.maximumPoints = { status: 'known', value: 30, evidenceId: 'synthetic-fixture' };
  const { contentHash: _c, ...costBody } = data.costModel; data.costModel.contentHash = hashJson(costBody);
  const ev = (verified: boolean) => verified ? { status: 'known' as const, value: true, evidenceId: 'synthetic-taxonomy' } : { status: 'unknown' as const, reason: 'Synthetic: not verified.' };
  const ok = opts.taxonomy !== 'unverified';
  data.taxonomy.targets = [
    { targetId: 'alpha', nodeIds: ['alpha1', 'alpha2'], verified: ev(true) }, { targetId: 'beta', nodeIds: ['beta1', 'beta2'], verified: ev(true) },
    { targetId: 'gamma', nodeIds: ['gamma1'], verified: ev(true) }, { targetId: 'delta', nodeIds: ['delta1'], verified: ev(ok) }, { targetId: 'eps', nodeIds: ['eps1'], verified: ev(true) }, { targetId: 'zeta', nodeIds: ['zeta1'], verified: ev(true) }];
  const { contentHash: _t, ...taxBody } = data.taxonomy; data.taxonomy.contentHash = hashJson(taxBody);
  data.ref.contentHash = atlasDatasetDigest(data);
  return data;
}
