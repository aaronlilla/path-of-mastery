import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardTile, dpsTile, tileGap } from '../src/shared/dpsTile.js';

const of = (o: Record<string, number>) => (id: string) => o[id];

test('the DPS tile rule: Full DPS, Combined, hit, minion rows; a pin always wins', () => {
  assert.equal(dpsTile(of({ FullDPS: 5, CombinedDPS: 4, TotalDPS: 3 })).label, 'FULL DPS');
  assert.equal(dpsTile(of({ FullDPS: 0, CombinedDPS: 4, TotalDPS: 3 })).label, 'COMBINED DPS');
  assert.equal(dpsTile(of({ TotalDPS: 3 })).label, 'HIT DPS');
  assert.equal(dpsTile(of({ 'Minion.CombinedDPS': 2, 'Minion.TotalDPS': 1 })).id, 'Minion.CombinedDPS');
  assert.equal(dpsTile(of({ 'Minion.TotalDPS': 1 })).id, 'Minion.TotalDPS');
  assert.equal(dpsTile(of({})).id, 'TotalDPS');
  assert.equal(dpsTile(of({ FullDPS: 5 }), { id: 'TotalEHP', label: 'EHP' }).id, 'TotalEHP');
});

test('a build with cull: the card leads with the sidebar tile and names the gap to the tested figure', () => {
  const t = cardTile(of({ FullDPS: 0, CombinedDPS: 1_110_000, TotalDPS: 1_000_000, CullMultiplier: 1.1111 }));
  assert.deepEqual([t.stat, t.label, t.value], ['CombinedDPS', 'COMBINED DPS', 1_110_000]);
  const tested = 1_000_000;
  assert.ok(t.value > tested);
  assert.deepEqual(tileGap(t, tested), { cull: 11, extraSkills: false });
  assert.equal(tileGap({ ...t, value: tested }, tested), null);
  assert.deepEqual(tileGap({ stat: 'FullDPS', value: 2_000_000, cull: 1 }, tested), { cull: 0, extraSkills: true });
});
