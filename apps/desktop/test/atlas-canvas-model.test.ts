import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseId, type AtlasDataset } from '@pom/mastery-contracts';
import { createGraph, known, unknown } from '../src/shared/atlas/graph.js';
import { createCanvasModel, canvasRows, inspectNode, fitView, hitNode, screenPoint, worldPoint, overlayFor, type CanvasSource } from '../src/renderer/atlas/canvas/model.js';
import { spriteArt } from '../src/renderer/atlas/canvas/art.js';

function source(): CanvasSource {
  const ids = ['root:atlas', '01', '1', 'branch', 'leaf', 'isolated'];
  const edges: Record<string, string[]> = { 'root:atlas': ['01', '1'], '01': ['branch'], '1': ['branch'], branch: ['leaf'], leaf: [], isolated: [] };
  const graph: AtlasDataset['graph'] = { graphHash: parseId('hash', 'a'.repeat(64)), rootId: ids[0]!, nodes: ids.map(nodeId => ({
    nodeId, name: `Synthetic ${nodeId}`, adjacentIds: edges[nodeId]!, asset: null,
    stats: [{ statId: 'synthetic', sourceText: 'Exact synthetic effect', aggregation: 'conditional', value: unknown('Synthetic'), unit: unknown('Synthetic'), effectSchemaHash: parseId('hash', 'c'.repeat(64)), provenance: [] }],
  })) };
  return { datasetHash: parseId('hash', 'b'.repeat(64)), graph: createGraph(graph, unknown('Cost model not qualified.')),
    geometry: Object.fromEntries(ids.map((id, i) => [id, { position: known({ x: i * 80 - 200, y: i % 2 * 70 - 90 }, 'synthetic-position') }])), nodeMetadata: {} };
}

test('dense IDs are reversible, deterministic and scoped to dataset and graph; numeric-looking IDs remain distinct', () => {
  const s = source(), m = createCanvasModel(s);
  assert.equal(m.scope.datasetHash, s.datasetHash);
  assert.equal(m.scope.graphHash, s.graph.graphHash);
  assert.notEqual(m.denseById.get('01'), m.denseById.get('1'));
  for (const [id, index] of m.denseById) assert.equal(m.ids[index], id);
  assert.deepEqual(createCanvasModel({ ...s, graph: { ...s.graph, nodes: new Map([...s.graph.nodes].reverse()) } }).ids, m.ids);
  assert.notDeepEqual(createCanvasModel({ ...s, datasetHash: parseId('hash', 'd'.repeat(64)) }).scope, m.scope);
  assert.equal(m.edges.length, 5, 'undirected cycle edges are not pruned');
});

test('root uses supplied negative geometry, never a class start or a fabricated origin', () => {
  const s = source(), m = createCanvasModel(s), root = m.nodes[m.denseById.get(s.graph.rootId)!]!;
  assert.deepEqual(root.position, { x: -200, y: -90 });
  assert.equal(root.isRoot, true);
  const missing = createCanvasModel({ ...s, geometry: { ...s.geometry, [s.graph.rootId]: { position: unknown('Root anchor not reviewed.') } } });
  assert.equal(missing.nodes[missing.denseById.get(s.graph.rootId)!]!.position, null);
  assert.ok(missing.geometryWarnings.includes(s.graph.rootId));
  assert.equal(fitView(missing, [], 400, 300), null, 'empty Fit cannot invent root geometry');
});

test('nonfinite and missing positions stay explicit while the accessible list retains every node', () => {
  const s = source();
  delete s.geometry.leaf;
  s.geometry.branch = { position: known({ x: NaN, y: 0 }, 'synthetic') };
  const m = createCanvasModel(s);
  assert.deepEqual(m.geometryWarnings, ['branch', 'leaf']);
  assert.equal(canvasRows(m, [], '', 'all').length, s.graph.nodes.size);
  assert.equal(canvasRows(m, ['imported-missing'], '', 'allocated')[0]!.repair, true);
});

test('search uses exact names and stats without regex injection; filters preserve repair IDs', () => {
  const m = createCanvasModel(source());
  assert.equal(canvasRows(m, [], 'EXACT synthetic', 'matches').length, 6);
  assert.equal(canvasRows(m, [], 'does not exist', 'matches').length, 0);
  assert.equal(canvasRows(m, [], '[', 'matches').length, 0);
  const rows = canvasRows(m, ['leaf', 'unavailable'], '', 'allocated');
  assert.deepEqual(rows.map(r => r.nodeId), ['leaf', 'unavailable']);
  assert.equal(rows[1]!.name, 'Node unavailable is unavailable in this dataset.');
});

test('hover allocation and exact cascade ghosts do not mutate the saved allocation', () => {
  const m = createCanvasModel(source()), allocated = ['01', 'branch', 'leaf', 'missing'];
  const before = structuredClone(allocated);
  const add = inspectNode(m, [], 'leaf', 0);
  assert.equal(add.kind, 'allocate');
  if (add.kind === 'allocate') {
    assert.deepEqual(add.preview.addedIds, ['01', 'branch', 'leaf']);
    assert.equal(add.preview.totalCost.status, 'unknown');
  }
  const removal = inspectNode(m, allocated, 'branch', 0);
  assert.equal(removal.kind, 'remove');
  if (removal.kind === 'remove') {
    assert.deepEqual(removal.preview.cascadeIds, ['leaf']);
    assert.deepEqual(removal.preview.allocatedIds, ['01', 'missing']);
  }
  assert.deepEqual(allocated, before);
  assert.equal(inspectNode(m, [], 'isolated', 0).kind, 'unavailable');
  assert.equal(inspectNode(m, [], m.graph.rootId, 0).kind, 'root');
});

test('overbudget manual previews stay available and source root cost is included', () => {
  const s = source();
  const costs: AtlasDataset['costModel'] = { revision: 'synthetic', contentHash: parseId('hash', 'e'.repeat(64)),
    nodeCosts: Object.fromEntries([...s.graph.nodes.keys()].map(id => [id, 2])), maximumPoints: unknown('Synthetic'), grantedPoints: unknown('Synthetic'),
    provenance: [{ sourceId: 'synthetic', sourceHash: parseId('hash', 'f'.repeat(64)), field: 'synthetic', fetchedAt: '2026-10-11T00:00:00Z' }] };
  const m = createCanvasModel({ ...s, graph: { ...s.graph, costs: known(costs, 'synthetic') } });
  const p = inspectNode(m, [], 'leaf', 1);
  assert.equal(p.kind, 'allocate');
  if (p.kind === 'allocate') { assert.deepEqual(p.preview.totalCost, known(8, 'synthetic')); assert.deepEqual(p.preview.overBudget, known(7, 'synthetic')); }
});

test('diff and ghost overlays describe added, removed and unchanged nodes without rewriting the step', () => {
  const o = overlayFor(['01', 'branch'], ['1', 'branch']);
  assert.deepEqual([...o.added], ['1']); assert.deepEqual([...o.removed], ['01']); assert.deepEqual([...o.unchanged], ['branch']);
  const rows = canvasRows(createCanvasModel(source()), ['01', 'branch'], '', 'all', o);
  assert.equal(rows.find(r => r.nodeId === '01')!.delta, 'removed');
  assert.equal(rows.find(r => r.nodeId === '1')!.delta, 'added');
});

test('empty Fit shows the start and its first ring of nodes; with allocations it fits those', () => {
  const m = createCanvasModel(source()), v = fitView(m, [], 800, 600)!;
  for (const id of ['root:atlas', '01', '1']) {
    const screen = screenPoint(m.nodes[m.denseById.get(id)!]!.position!, v, 800, 600);
    assert.ok(screen.x >= 0 && screen.x <= 800 && screen.y >= 0 && screen.y <= 600, `${id} is on screen`);
  }
  const single = fitView(m, ['leaf'], 800, 600)!;
  assert.notDeepEqual(v, single);
});

test('fit, transformed hit testing and coordinate roundtrips include the actual source root', () => {
  const m = createCanvasModel(source()), v = fitView(m, ['leaf'], 800, 600)!;
  for (const id of [m.graph.rootId, 'leaf']) {
    const n = m.nodes[m.denseById.get(id)!]!, screen = screenPoint(n.position!, v, 800, 600);
    assert.ok(screen.x >= 0 && screen.x <= 800 && screen.y >= 0 && screen.y <= 600);
    assert.deepEqual(worldPoint(screen, v, 800, 600), n.position);
    assert.equal(hitNode(m, screen, v, 800, 600), id);
  }
  assert.equal(hitNode(m, { x: -1000, y: -1000 }, v, 800, 600), null);
});

test('cross-dataset diff keeps unavailable added and removed IDs as explicit accessible repair rows', () => {
  const rows = canvasRows(createCanvasModel(source()), ['01'], '', 'all', overlayFor(['01', 'missing-before'], ['1', 'missing-after']));
  assert.equal(rows.find(r => r.nodeId === 'missing-before')!.delta, 'removed');
  assert.equal(rows.find(r => r.nodeId === 'missing-after')!.delta, 'added');
  assert.equal(rows.find(r => r.nodeId === 'missing-after')!.repair, true);
});

test('game art uses only the pinned sheet, validated source rect and caller-supplied asset URL', () => {
  const asset = { assetId: 'assets/synthetic.png', contentHash: parseId('hash', 'a'.repeat(64)), mediaType: 'image/png' as const };
  const sprites = { synthetic: { '1': { filename: 'https://source.invalid/assets/synthetic.png', w: 80, h: 40, coords: { icon: { x: 10, y: 5, w: 20, h: 20 } } } } };
  assert.deepEqual(spriteArt(asset, 'icon', sprites, '/verified/synthetic.png'), { url: '/verified/synthetic.png', width: 80, height: 40, x: 10, y: 5, w: 20, h: 20 });
  assert.equal(spriteArt(asset, 'icon', sprites, null), null);
  assert.equal(spriteArt({ ...asset, assetId: 'assets/other.png' }, 'icon', sprites, '/verified/synthetic.png'), null);
  assert.equal(spriteArt(asset, 'missing', sprites, '/verified/synthetic.png'), null);
  sprites.synthetic['1'].coords.icon.w = 100;
  assert.equal(spriteArt(asset, 'icon', sprites, '/verified/synthetic.png'), null);
});
