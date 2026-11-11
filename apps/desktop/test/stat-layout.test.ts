import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moveGroup, orderedGroups, pinClick, readPins } from '../src/shared/statLayout.js';
import { sanitizeSettings } from '../src/main/library/settingsStore.js';

const DEF = ['minion', 'off', 'attr', 'hit', 'pools', 'res'];

test('a saved order keeps its sections, drops unknown ones and adds new ones last', () => {
  assert.deepEqual(orderedGroups(null, DEF), DEF);
  assert.deepEqual(orderedGroups(['res', 'off'], DEF), ['res', 'off', 'minion', 'attr', 'hit', 'pools']);
  assert.deepEqual(orderedGroups(['gone', 'off', 'off'], DEF), ['off', 'minion', 'attr', 'hit', 'pools', 'res']);
});

test('moving a section stops at the ends', () => {
  assert.deepEqual(moveGroup(DEF, 'attr', -1), ['minion', 'attr', 'off', 'hit', 'pools', 'res']);
  assert.deepEqual(moveGroup(DEF, 'res', 1), DEF);
  assert.deepEqual(moveGroup(DEF, 'minion', -1), DEF);
});

test('clicking a stat pins it to the right tile, and a stat already shown pins nothing', () => {
  const shown: [string, string] = ['FullDPS', 'TotalEHP'];
  assert.deepEqual(pinClick(['', ''], shown, 'Life'), { pins: ['', 'Life'], changed: true });
  assert.deepEqual(pinClick(['', ''], shown, 'FullDPS'), { pins: ['', ''], changed: false });
  assert.deepEqual(pinClick(['Life', 'Mana'], ['Life', 'Mana'], 'Mana'), { pins: ['Life', 'Mana'], changed: false });
});

test('the order and the pins survive the settings file, and a hand-edited value is cleaned', () => {
  const s = sanitizeSettings({ statOrder: ['res', 'off', 7], pinnedStats: ['', 'Life'] });
  assert.deepEqual(s.statOrder, ['res', 'off']);
  assert.deepEqual(readPins(s.pinnedStats), ['', 'Life']);
  assert.deepEqual(sanitizeSettings({ statOrder: 'x', pinnedStats: null }).statOrder, []);
  assert.deepEqual(sanitizeSettings({}).pinnedStats, []);
});
