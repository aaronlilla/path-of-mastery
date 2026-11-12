import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gemVersions, groupWarnings } from '../src/shared/skillsLogic.js';

const G = (id: string, name: string, transfiguredOf?: string, legacy = false) => ({ id, name, legacy, ...(transfiguredOf ? { transfiguredOf } : {}) });
const GEMS = [
  G('Cyclone', 'Cyclone'),
  G('CycloneAltX', 'Cyclone of Tumult', 'Cyclone'),
  G('Arc', 'Arc'),
  G('ArcAltX', 'Arc of Surging', 'Arc'),
  G('ArcAltY', 'Arc of Oscillating', 'Arc'),
  G('ArcOld', 'Arc', undefined, true),
];

test('the versions of a base gem are its transfigured variants', () => {
  assert.deepEqual(gemVersions(GEMS, GEMS[2]!).map((g) => g.name), ['Arc of Oscillating', 'Arc of Surging']);
});

test('the versions of a transfigured gem are the base first, then its siblings', () => {
  assert.deepEqual(gemVersions(GEMS, GEMS[3]!).map((g) => g.name), ['Arc', 'Arc of Oscillating']);
  assert.deepEqual(gemVersions(GEMS, GEMS[1]!).map((g) => g.name), ['Cyclone']);
});

test('a gem with no variants has no versions', () => {
  assert.deepEqual(gemVersions([G('Zeal', 'Zealotry')], G('Zeal', 'Zealotry')), []);
});

test('group warnings: too many gems for the sockets, and gems the calculation flags', () => {
  const gems = [1, 2, 3, 4, 5].map((i) => ({ known: true, nameSpec: 'G' + i }));
  assert.deepEqual(groupWarnings({ gems }, 4), ['5 gems in 4 sockets: 1 gem over the link limit']);
  assert.deepEqual(groupWarnings({ gems }, 6), []);
  assert.deepEqual(groupWarnings({ gems }, null), []);
  assert.deepEqual(groupWarnings({ gems: [{ known: true, nameSpec: 'Hatred', errMsg: 'Not enough mana' }, { known: false, nameSpec: 'X', errMsg: 'Unknown' }] }, null), ['Hatred: Not enough mana']);
});
