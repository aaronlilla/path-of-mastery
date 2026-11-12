// The Nodes list buttons: Allocate needs a path from the start; Unallocate works for any allocated node (even a missing or isolated one).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseId, type AtlasDataset } from '@pom/mastery-contracts';
import { createGraph, known, rootComponent, unknown } from '../src/shared/atlas/graph.js';
import { createCanvasModel, rowActionAvailable } from '../src/renderer/atlas/canvas/model.js';

function model() {
  const ids = ['root:atlas', 'a', 'b', 'isolated'];
  const edges: Record<string, string[]> = { 'root:atlas': ['a'], a: ['root:atlas', 'b'], b: ['a'], isolated: [] };
  const graph: AtlasDataset['graph'] = { graphHash: parseId('hash', 'a'.repeat(64)), rootId: ids[0]!, nodes: ids.map(nodeId => ({
    nodeId, name: `N ${nodeId}`, adjacentIds: edges[nodeId]!, asset: null, stats: [] })) } as never;
  return createCanvasModel({ datasetHash: parseId('hash', 'b'.repeat(64)), graph: createGraph(graph, unknown('Cost model not qualified.')),
    geometry: Object.fromEntries(ids.map((id, i) => [id, { position: known({ x: i * 80, y: 0 }, 'p') }])), nodeMetadata: {} });
}

test('Allocate is unavailable for an unreachable node; Unallocate stays available for any allocated node', () => {
  const m = model(), reachable = rootComponent(m.graph);
  assert.equal(rowActionAvailable(m, reachable, [], 'b'), true);
  assert.equal(rowActionAvailable(m, reachable, [], 'isolated'), false, 'cannot allocate an isolated node');
  assert.equal(rowActionAvailable(m, reachable, ['isolated'], 'isolated'), true, 'an allocated isolated node can be removed');
  assert.equal(rowActionAvailable(m, reachable, ['ghost'], 'ghost'), true, 'an allocated node missing from the tree data can be removed');
});
