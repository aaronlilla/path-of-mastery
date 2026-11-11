import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendModLine, fuzzyScore, filterMods } from '../src/shared/modBrowser.js';

// Add Mod picker search (Modules/ConfigModBrowser.lua).

test('mod search ranks the whole phrase first, then all words, then a split word', () => {
  const mods = [
    { text: '10% increased Attack Speed', sources: ['Item mod'] },
    { text: 'Attack and Cast Speed is 5% faster', sources: ['Passive Node'] },
    { text: '+20% to Fire Resistance', sources: ['Item mod'] },
  ];
  assert.deepEqual(filterMods(mods, 'attack speed').map((m) => m.text), ['10% increased Attack Speed', 'Attack and Cast Speed is 5% faster']);
  // Equal rank: the engine's key order (the text with numbers and symbols stripped).
  assert.deepEqual(filterMods(mods, 'speed attack').map((m) => m.text), ['Attack and Cast Speed is 5% faster', '10% increased Attack Speed']);
  assert.equal(fuzzyScore('10% increased Attack Speed', 'attack speed', ['attack', 'speed']), 1);
  assert.equal(fuzzyScore('Attack and Cast Speed', 'speed attack', ['speed', 'attack']), 2);
  assert.equal(fuzzyScore('+20% to Fire Resistance', 'fireres', ['fireres']), 3);
  assert.equal(fuzzyScore('+20% to Fire Resistance', 'zzz', ['zzz']), undefined);
  assert.equal(filterMods(mods, '   ').length, 3);
  assert.deepEqual(filterMods(mods, 'nothing at all'), []);
});

test('picking a mod adds it on its own line', () => {
  assert.equal(appendModLine('', '10% increased Damage'), '10% increased Damage');
  assert.equal(appendModLine('5% increased Life', '10% increased Damage'), '5% increased Life\n10% increased Damage');
  assert.equal(appendModLine('5% increased Life\n', '10% increased Damage'), '5% increased Life\n10% increased Damage');
});
