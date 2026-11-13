// Restart now reopens the build that was open: the place is stashed before the restart and taken once at the next start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropPlace, stashPlace, takePlace } from '../src/renderer/updates/restartPlace.js';

const fake = () => {
  const m = new Map<string, string>();
  return { setItem: (k: string, v: string) => void m.set(k, v), getItem: (k: string) => m.get(k) ?? null, removeItem: (k: string) => void m.delete(k) };
};

test('a stashed place comes back once, then a normal start finds nothing', () => {
  const s = fake();
  stashPlace({ area: 'builds', tab: 'tree', buildId: 'b1' }, s);
  assert.deepEqual(takePlace(s), { area: 'builds', tab: 'tree', buildId: 'b1' });
  assert.equal(takePlace(s), null);
});

test('a refused restart drops the stash', () => {
  const s = fake();
  stashPlace({ buildId: 'b1' }, s);
  dropPlace(s);
  assert.equal(takePlace(s), null);
});
