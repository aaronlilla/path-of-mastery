import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultItemSort } from '../src/renderer/items/rank.js';
import { rowLook } from '../src/shared/calcsLogic.js';

const PS = [
  { stat: 'FullDPS', items: true },
  { stat: 'CombinedDPS', items: true },
  { stat: 'TotalDPS', items: true },
];

test('the item list starts on Full DPS when the build has a Full DPS row', () => {
  assert.equal(defaultItemSort(true, { FullDPS: 3_120_000, CombinedDPS: 3_011_785 }, PS), 'FullDPS');
});

test('a build with no Full DPS row falls back to Combined DPS, then Hit DPS, then the name', () => {
  assert.equal(defaultItemSort(true, { CombinedDPS: 2_082_972 }, PS), 'CombinedDPS');
  assert.equal(defaultItemSort(true, { TotalDPS: 900 }, PS), 'TotalDPS');
  assert.equal(defaultItemSort(true, {}, PS), 'Name');
  assert.equal(defaultItemSort(true, { FullDPS: 0 }, PS), 'Name');
});

test('with no build open, or before the stat list is read, the list sorts by name', () => {
  assert.equal(defaultItemSort(false, { FullDPS: 5 }, PS), 'Name');
  assert.equal(defaultItemSort(true, { FullDPS: 5 }, null), 'Name');
});

test('Calcs rows that carry a headline number get the sidebar icon, the others none', () => {
  assert.deepEqual(rowLook('HitDamage', 'Skill DPS'), { icon: 'dps', tone: '--stat-dps' });
  assert.deepEqual(rowLook('Speed', 'MH Att. per second'), { icon: 'speed', tone: '--stat-speed' });
  assert.deepEqual(rowLook('Crit', 'OH Crit Chance'), { icon: 'crit', tone: '--stat-crit' });
  assert.equal(rowLook('Crit', 'MH Inc. Crit Chance'), null);
  assert.deepEqual(rowLook('Attributes', 'Strength'), { icon: 'attr-str', tone: '--attr-str' });
  assert.equal(rowLook('Attributes', 'Str. Required'), null);
  assert.deepEqual(rowLook('Life', 'Total'), { icon: 'life', tone: '--pool-life' });
  assert.equal(rowLook('Life', 'Total Base'), null);
  assert.deepEqual(rowLook('Resist', 'Chaos Resist'), { icon: 'chaos', tone: '--dmg-chaos' });
  assert.deepEqual(rowLook('LeechGain', 'Mana Leech Rate'), { icon: 'leech', tone: '--pool-mana' });
  assert.equal(rowLook('Flasks', 'Charges/s'), null);
  assert.equal(rowLook('Life', null), null);
});
