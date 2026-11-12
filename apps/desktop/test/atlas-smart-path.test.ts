import { test } from 'node:test';
import assert from 'node:assert/strict';
import { smartPath, smartRoute } from '../src/shared/atlas/smartPath.js';

// R-a-b-w1, R-x-y-w1 (longer way round), b-w2, y-w3.
const edges: [string, string][] = [['R', 'a'], ['a', 'b'], ['b', 'w1'], ['R', 'x'], ['x', 'y'], ['y', 'w1'], ['b', 'w2'], ['y', 'w3']];
const adjacent = new Map<string, string[]>();
for (const [p, q] of edges) { (adjacent.get(p) ?? adjacent.set(p, []).get(p)!).push(q); (adjacent.get(q) ?? adjacent.set(q, []).get(q)!).push(p); }
const connected = (ids: string[]) => { const s = new Set(['R', ...ids]), seen = new Set(['R']), q = ['R']; for (const n of q) for (const m of adjacent.get(n)!) if (s.has(m) && !seen.has(m)) { seen.add(m); q.push(m); } return seen.size === s.size; };

test('smart path: cheapest route, connected, avoided node never used, unreachable reported', () => {
  const plain = smartPath(adjacent, 'R', ['w1', 'w2'], new Set());
  assert.deepEqual(plain, { ids: ['a', 'b', 'w1', 'w2'], unreachableId: null });
  assert.ok(connected(plain.ids));
  // Same wanted nodes, one fewer node than walking each click's own path would use together (w1 via b is shared with w2).
  const around = smartPath(adjacent, 'R', ['w1', 'w3'], new Set(['b']));
  assert.deepEqual(around, { ids: ['w1', 'w3', 'x', 'y'], unreachableId: null });
  assert.ok(connected(around.ids) && !around.ids.includes('b'));
  // w2 only touches b: avoiding b strands it, and the tree is left empty for the caller to keep what it had.
  assert.deepEqual(smartPath(adjacent, 'R', ['w1', 'w2'], new Set(['b'])), { ids: [], unreachableId: 'w2' });
  assert.equal(smartPath(adjacent, 'R', ['missing'], new Set()).unreachableId, 'missing');
});

test('smart route: a click keeps every allocated notable, plain nodes may re-route', () => {
  // w1 and w3 are notables held through x-y; the player clicks w2 (only reachable via a-b).
  const plainIds = new Set(["a", "b", "x", "y"]), isPlain = (id: string) => plainIds.has(id), held = ["x", "y", "w1", "w3"];
  const route = smartRoute(adjacent, "R", ["w2"], new Set(), held, isPlain);
  assert.equal(route.unreachableId, null);
  for (const id of ["w1", "w2", "w3"]) assert.ok(route.ids.includes(id), `${id} kept`);
  assert.ok(connected(route.ids));
  // An avoided notable is dropped on purpose.
  assert.ok(!smartRoute(adjacent, "R", ["w2"], new Set(["w3"]), held, isPlain).ids.includes("w3"));
});

test('smart route: a plain allocated node marked want survives a click', () => {
  // x, y are plain travel nodes to the held notable w1; clicking w2 re-routes w1 through a-b and would drop them.
  const plainIds = new Set(["a", "b", "x", "y"]), isPlain = (id: string) => plainIds.has(id), held = ["x", "y", "w1"];
  assert.ok(!smartRoute(adjacent, "R", ["w2"], new Set(), held, isPlain).ids.includes("x"));
  const kept = smartRoute(adjacent, "R", ["w2", "x"], new Set(), held, isPlain);
  assert.ok(kept.ids.includes("x") && kept.ids.includes("w1") && kept.ids.includes("w2") && connected(kept.ids));
});
