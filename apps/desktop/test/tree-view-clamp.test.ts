import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampView } from '../src/renderer/tree/viewClamp.js';

const bounds = { minX: -11400, maxX: 11400, minY: -10000, maxY: 10000 };

test('a view centred on the tree is left alone', () => {
  const v = { x: 100, y: -200, s: 0.1 };
  assert.deepEqual(clampView(v, bounds), v);
});

test('dragging far to any side stops at the tree box', () => {
  assert.deepEqual(clampView({ x: -22400, y: 0, s: 0.05 }, bounds), { x: -11400, y: 0, s: 0.05 });
  assert.deepEqual(clampView({ x: 22400, y: 0, s: 0.05 }, bounds), { x: 11400, y: 0, s: 0.05 });
  assert.deepEqual(clampView({ x: 0, y: -90000, s: 1 }, bounds), { x: 0, y: -10000, s: 1 });
  assert.deepEqual(clampView({ x: 0, y: 90000, s: 1 }, bounds), { x: 0, y: 10000, s: 1 });
});

test('thirty drags in each direction never take the middle of the view off the tree, at any zoom', () => {
  for (const s of [0.02, 0.05, 0.3, 1.2]) {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      let v = { x: 0, y: 0, s };
      for (let i = 0; i < 30; i++) v = clampView({ x: v.x + (dx * 1500) / s, y: v.y + (dy * 1500) / s, s }, bounds);
      assert.ok(v.x >= bounds.minX && v.x <= bounds.maxX && v.y >= bounds.minY && v.y <= bounds.maxY);
    }
  }
});
