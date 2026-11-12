// The art tile cache held 400 tiles, but a 3840x2160 device-pixel canvas shows ~510. Painting the
// visible tiles evicted visible ones, so every repaint redrew them and the canvas never settled. This drives the real
// AtlasCanvas paint loop on a stubbed 2D canvas and counts how many tiles are painted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseId, type AtlasDataset } from '@pom/mastery-contracts';
import { createGraph, known, unknown } from '../src/shared/atlas/graph.js';
import { createCanvasModel } from '../src/renderer/atlas/canvas/model.js';
import { AtlasCanvas } from '../src/renderer/atlas/canvas/AtlasCanvas.js';

const ids = ['root:atlas', 'a', 'b'];
const graph: AtlasDataset['graph'] = { graphHash: parseId('hash', 'a'.repeat(64)), rootId: ids[0]!, nodes: ids.map((nodeId, i) => ({
  nodeId, name: nodeId, adjacentIds: ids.filter((o) => o !== nodeId), asset: null,
  stats: [{ statId: 's', sourceText: 'x', aggregation: 'conditional', value: unknown('x'), unit: unknown('x'), effectSchemaHash: parseId('hash', 'c'.repeat(64)), provenance: [] }],
})) };
const model = createCanvasModel({ datasetHash: parseId('hash', 'b'.repeat(64)), graph: createGraph(graph, unknown('none')),
  geometry: Object.fromEntries(ids.map((id, i) => [id, { position: known({ x: i * 80, y: i * 40 }, 'p') }])), nodeMetadata: {} });

const g = globalThis as Record<string, unknown>;
const ctxStub = () => new Proxy({}, { get: (_t, k) => (k === 'measureText' ? () => ({ width: 10 }) : k === 'createPattern' ? () => null : () => undefined), set: () => true });
const fakeCanvas = (w = 0, h = 0): Record<string, unknown> => ({
  width: w, height: h, dataset: {}, parentElement: null, getContext: () => ctxStub(),
  addEventListener() {}, removeEventListener() {}, getBoundingClientRect: () => ({ width: 1920, height: 1080, left: 0, top: 0 }),
});

test('a 3840x2160 canvas settles: after the first pass a repaint paints no tiles and nothing stays scheduled', () => {
  const frames: (() => void)[] = [];
  let tilesPainted = 0;
  Object.assign(g, {
    window: { devicePixelRatio: 2 }, ResizeObserver: class { observe() {} disconnect() {} }, MutationObserver: class { observe() {} disconnect() {} },
    document: { documentElement: {}, createElement: () => fakeCanvas() }, getComputedStyle: () => ({ getPropertyValue: () => '' }),
    requestAnimationFrame: (f: () => void) => frames.push(f),
  });
  const art = Object.assign(() => null, { sprite: (_f: string, name: string) => { if (name === 'Background2') tilesPainted++; return { image: {}, x: 0, y: 0, w: 8, h: 8, zoom: 1 }; } });
  const canvas = new AtlasCanvas(fakeCanvas() as unknown as HTMLCanvasElement, model, { hover() {}, activate() {}, status() {} }, art as never);
  assert.equal((canvas.canvas as unknown as { width: number }).width, 3840);
  assert.equal((canvas.canvas as unknown as { height: number }).height, 2160);
  const state = { allocated: [], matches: new Set<string>(), repair: new Set<string>(), focused: null, overlay: null };
  canvas.setState(state);
  canvas.setView({ x: 0, y: 0, scale: 0.5 });
  const run = (max: number): number => { let n = 0; while (frames.length && n < max) { frames.splice(0).forEach((f) => f()); n++; } return n; };

  assert.ok(run(30) < 30, 'the first paint finishes within 30 frames');
  assert.ok(tilesPainted >= 510, `the whole screen was painted (${tilesPainted} tiles)`);
  tilesPainted = 0;
  canvas.setState(state);
  run(1);
  assert.equal(tilesPainted, 0, 'a repaint of an unchanged view paints no tile again');
  assert.equal(frames.length, 0, 'no further repaint is scheduled');
});
