import { dataset, stamp } from '@pom/mastery-contracts/fixtures';
import { atlasDatasetDigest, hashJson } from '../../../main/kb/sources/atlas.js';

export function syntheticDataset() {
  const data = dataset(), ids = ['synthetic-root', 'synthetic-bridge', 'synthetic-left', 'synthetic-right', 'synthetic-leaf'];
  const edges = [[1], [0, 2, 3], [1, 4], [1, 4], [2, 3]];
  data.ref.datasetId = 'Synthetic tree v1'; data.ref.variant = 'synthetic-only'; data.ref.stamp = stamp();
  data.costModel.provenance = [{ sourceId: 'synthetic-fixture', sourceHash: data.schemaHash, field: 'synthetic-costs', fetchedAt: data.ref.stamp.createdAt }];
  data.graph.rootId = ids[0]!;
  data.graph.nodes = ids.map((nodeId, index) => ({ nodeId, name: `Synthetic ${nodeId.replace('synthetic-', '')}`, adjacentIds: edges[index]!.map(i => ids[i]!), asset: null,
    stats: [{ statId: 'synthetic-effect', sourceText: `Synthetic ${index} source effect`, aggregation: index === 3 ? 'conditional' as const : 'additive' as const, value: { status: 'known' as const, value: index, evidenceId: 'synthetic-source' }, unit: { status: 'known' as const, value: 'synthetic-unit', evidenceId: 'synthetic-source' }, effectSchemaHash: data.schemaHash, provenance: [...data.costModel.provenance] }] }));
  data.graph.graphHash = hashJson({ rootId: data.graph.rootId, nodes: data.graph.nodes });
  data.costModel.nodeCosts = Object.fromEntries(ids.map((id, i) => [id, i === 0 ? 0 : 1]));
  data.costModel.maximumPoints = { status: 'unknown', reason: 'Synthetic fixture is not game data.' };
  const { contentHash: _cost, ...cost } = data.costModel; data.costModel.contentHash = hashJson(cost);
  data.taxonomy.targets = [];
  const { contentHash: _taxonomy, ...taxonomy } = data.taxonomy; data.taxonomy.contentHash = hashJson(taxonomy);
  data.catalogs.maps = [{ catalogId: 'synthetic-map', name: 'Synthetic map', asset: null, provenance: [...data.costModel.provenance] }];
  data.catalogs.scarabs = [{ catalogId: 'synthetic-scarab', name: 'Synthetic scarab', asset: null, provenance: [...data.costModel.provenance] }];
  data.ref.contentHash = atlasDatasetDigest(data);
  return data;
}
