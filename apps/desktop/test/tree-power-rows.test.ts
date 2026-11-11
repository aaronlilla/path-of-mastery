import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pointsLabel, reportRows } from '../src/renderer/tree/powerRows.js';

const tree = {
  nodeById: (id: number) =>
    ({
      1: { t: 1, name: 'Merciless Skewering' },
      2: { t: 1, name: 'Tenacity' },
      3: { t: 3, name: 'Axe Mastery' },
      4: { t: 3, name: 'Dual Wielding Mastery', mastery: { effects: [{ e: 11, s: ['+15% Chance to Block Attack Damage if you have not Blocked Recently'] }, { e: 12, s: ['10% increased Attack Speed', 'Skills have a 5% chance to Cast'] }] } },
    } as Record<number, { t: number; name: string; mastery?: { effects: Array<{ e: number; s: string[] }> } }>)[id],
};
const np = (id: number, dist: number, single: number, pathPower: number | null) => ({ id, dist, offence: 0, defence: 0, single, pathPower });

test('a node nothing reaches shows Anoint points and no per-point value (original: pathDist 1000, pathPower nil)', () => {
  const rows = reportRows([np(2, 1000, 127708, null)], tree, { masteries: true });
  assert.equal(rows.length, 1);
  assert.equal(pointsLabel(rows[0]!.points), 'Anoint');
  assert.equal(rows[0]!.perPoint, 0);
});

test('a reachable node shows its distance and its path change per point', () => {
  const rows = reportRows([np(1, 4, 155000, 255100)], tree, { masteries: true });
  assert.equal(pointsLabel(rows[0]!.points), '4');
  assert.equal(rows[0]!.perPoint, 255100 / 4);
});

test('a mastery without a path change falls back on its own change', () => {
  const rows = reportRows([np(3, 2, 1000, null)], tree, { masteries: true });
  assert.equal(rows[0]!.perPoint, 500);
});

test('a mastery gets one row per effect with power, named like the original (node name, then the effect lines)', () => {
  const m = { ...np(4, 15, 15, 15), effects: [{ e: 11, offence: 0, defence: 0, single: 15, pathPower: 15 }, { e: 12, offence: 0, defence: 0, single: 0, pathPower: 0 }] };
  const rows = reportRows([m], tree, { masteries: true });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.name, 'Dual Wielding Mastery: +15% Chance to Block Attack Damage if you have not Blocked Recently');
  assert.equal(rows[0]!.power, 15);
  assert.equal(rows[0]!.perPoint, 1);
  assert.equal(reportRows([m], tree, { masteries: false }).length, 0);
});

test('two effects with power are two rows with their own keys', () => {
  const m = { ...np(4, 2, 9, 9), effects: [{ e: 11, offence: 0, defence: 0, single: 9, pathPower: 12 }, { e: 12, offence: 0, defence: 0, single: 4, pathPower: null }] };
  const rows = reportRows([m], tree, { masteries: true });
  assert.deepEqual(rows.map((r) => [r.power, r.perPoint]), [[9, 6], [4, 2]]);
  assert.equal(new Set(rows.map((r) => r.key)).size, 2);
});

const alloc = (id: number, dist: number, single: number, pathPower: number, effects?: Array<{ e: number; single: number; pathPower: number | null }>) => ({
  id, dist, offence: 0, defence: 0, single, pathPower, allocated: true,
  ...(effects ? { effects: effects.map((e) => ({ ...e, offence: 0, defence: 0 })) } : {}),
});

test('Show Unallocated leaves the allocated nodes out and Show Allocated lists only them, whatever their change (the original does not filter on power > 0)', () => {
  const nodes = [np(1, 4, 155000, 255100), alloc(2, 3, -50000, -90000), alloc(2 + 100, 1, 0, 0)];
  const lookup = { nodeById: (id: number) => (id === 102 ? { t: 0, name: 'Plain' } : tree.nodeById(id)) };
  assert.deepEqual(reportRows(nodes, lookup, { masteries: true }).map((r) => r.id), [1]);
  const rows = reportRows(nodes, lookup, { masteries: true, allocated: true });
  assert.deepEqual(rows.map((r) => r.id), [2, 102]);
  // power is the removal change (negative: the node helps); per point is the whole removal over the nodes that go with it
  assert.equal(rows[0]!.power, -50000);
  assert.equal(rows[0]!.points, 3);
  assert.equal(rows[0]!.perPoint, -90000 / 3);
});

test('an allocated mastery is one row for the effect taken, named like the original', () => {
  const rows = reportRows([alloc(4, 1, -2000, -2000, [{ e: 12, single: -2000, pathPower: -2000 }])], tree, { masteries: true, allocated: true });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.name, 'Dual Wielding Mastery: 10% increased Attack Speed / Skills have a 5% chance to Cast');
  assert.equal(reportRows([alloc(4, 1, -2000, -2000, [{ e: 12, single: -2000, pathPower: -2000 }])], tree, { masteries: false, allocated: true }).length, 0);
});
