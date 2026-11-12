import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseBlocks } from '../src/shared/lootfilter/blocks.js';
import { buildCatalog } from '../src/shared/lootfilter/catalog.js';
import { tierNames } from '../src/shared/lootfilter/tierNames.js';
import { NEVERSINK_DIR } from './lootfilterHelpers.js';

const cat = buildCatalog(parseBlocks(readFileSync(join(NEVERSINK_DIR, '2-SEMI-STRICT.filter'), 'utf8')).blocks);

test('tiers are named S, A, B by their NeverSink number', () => {
  const currency = cat.types.find((t) => t.type === 'currency')!;
  const names = tierNames(currency.tiers);
  assert.equal(names.get('currency|t1exalted'), 'S');
  assert.equal(names.get('currency|t4chaos'), 'C');
  assert.deepEqual([...names.values()].slice(0, 5), ['S', 'A', 'B', 'C', 'D']);
});

test('no two tiers of one item type share a name (they used to repeat "Tier 4")', () => {
  let checked = 0;
  for (const ty of cat.types) {
    const names = [...tierNames(ty.tiers).values()];
    assert.equal(new Set(names).size, names.length, `${ty.type}: ${names.join(', ')}`);
    checked += names.length;
  }
  assert.ok(checked > 500, `${checked} tiers checked`);
  const div = cat.types.find((t) => t.type === 'divination')!;
  const dn = tierNames(div.tiers);
  assert.notEqual(dn.get('divination|t4'), dn.get('divination|t4c'), 'two tags that both say tier 4 get different names');
});
