import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modLabel } from '../src/renderer/items/itemText.js';

const TEXT = [
  'Rarity: RARE',
  'Doom Knuckle',
  'Vaal Gauntlets',
  'Implicits: 3',
  '{enchant}Enchant line',
  '{scourge}Scourge line',
  '{eater}Eater line',
  '{fractured}+86 to maximum Life',
  '{crafted}Adds 9 to 15 Physical Damage to Attacks',
  '{custom}Typed line',
  '{crucible}Crucible line',
  '{exarch}Exarch line',
  'Plain line',
].join('\n');
const m = (bucket: string, rawLine: number, extra: Record<string, boolean> = {}) => ({ bucket, rawLine, crafted: false, fractured: false, custom: false, prefix: false, suffix: false, ...extra }) as never;

test('each kind of modifier line is labelled the way the original labels it', () => {
  assert.deepEqual(modLabel(TEXT, m('enchant', 4)), { label: 'Enchant:' });
  assert.deepEqual(modLabel(TEXT, m('scourge', 5)), { label: 'Scourge:' });
  assert.deepEqual(modLabel(TEXT, m('implicit', 6)), { label: 'Eater:' });
  assert.deepEqual(modLabel(TEXT, m('explicit', 7, { fractured: true })), { label: 'Explicit:', sub: 'Fractured' });
  assert.deepEqual(modLabel(TEXT, m('explicit', 8, { crafted: true })), { label: 'Crafted:' });
  assert.deepEqual(modLabel(TEXT, m('explicit', 9, { custom: true })), { label: 'Custom:' });
  assert.deepEqual(modLabel(TEXT, m('crucible', 10)), { label: 'Crucible:' });
  assert.deepEqual(modLabel(TEXT, m('implicit', 11)), { label: 'Exarch:' });
  assert.deepEqual(modLabel(TEXT, m('explicit', 12, { prefix: true })), { label: 'Prefix:' });
  assert.deepEqual(modLabel(TEXT, m('explicit', 12)), { label: 'Explicit:' });
});
