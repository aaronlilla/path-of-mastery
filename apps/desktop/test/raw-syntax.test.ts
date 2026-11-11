import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandMarkers } from '../src/shared/sourceMarkers.js';
import { gemTagLabels, gemRowLook } from '../src/shared/skillsLogic.js';

test('item source text drops the unique{} / normal{} / currency{} markers and colours what they wrap', () => {
  const out = expandMarkers([{ c: 'source', t: 'Source: Upgraded from unique{Eye of Chayula} using currency{Blessing of Chayula}' }]);
  assert.equal(out.map((s) => s.t).join(''), 'Source: Upgraded from Eye of Chayula using Blessing of Chayula');
  assert.equal(out.find((s) => s.t === 'Eye of Chayula')?.colour, 'var(--rarity-unique)');
  assert.equal(out.find((s) => s.t === 'Blessing of Chayula')?.colour, 'var(--currency, #AA9E82)');
  assert.equal(out[0]!.colour, 'var(--mod-source)');
  assert.equal(out.find((s) => s.t === ' using ')?.colour, 'var(--mod-source)');
});

test('a name with a comma inside the marker stays one piece, and text without markers is untouched', () => {
  const out = expandMarkers([{ c: 'source', t: 'Source: Drops from unique{Farrul, First of the Plains}' }]);
  assert.equal(out.map((s) => s.t).join(''), 'Source: Drops from Farrul, First of the Plains');
  assert.deepEqual(expandMarkers([{ c: 'magic', t: '+10 to Life' }]), [{ t: '+10 to Life', colour: 'var(--mod-explicit)' }]);
});

test('hidden gem tags the original leaves out of its tag string stay hidden', () => {
  assert.deepEqual(gemTagLabels(['low_max_level', 'grants_active_skill', 'support', 'awakened', 'exceptional', 'random_element', 'banner']), ['Support', 'Exceptional']);
});

test('a gem the data no longer has shows its saved name, without the "Unrecognised" message, when it names its skill', () => {
  assert.deepEqual(gemRowLook({ known: false, nameSpec: 'Ancestral Protector', skillId: 'TotemMelee', errMsg: "Unrecognised gem name 'Ancestral Protector'" }), { text: 'Ancestral Protector', muted: true, note: undefined });
  assert.equal(gemRowLook({ known: false, nameSpec: 'Flamez', errMsg: "Unrecognised gem name 'Flamez'" }).text, "Unrecognised gem name 'Flamez'");
  assert.equal(gemRowLook({ known: true, nameSpec: 'Arc' }).text, 'Arc');
});
