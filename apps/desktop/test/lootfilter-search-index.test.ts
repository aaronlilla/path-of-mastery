// The Customize search finds an item in every section that lists it, not only in the one where it first lands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseBlocks } from '../src/shared/lootfilter/blocks.js';
import { buildCatalog, itemSectionHits } from '../src/shared/lootfilter/catalog.js';
import { NEVERSINK_DIR } from './lootfilterHelpers.js';

const cat = buildCatalog(parseBlocks(readFileSync(join(NEVERSINK_DIR, '2-SEMI-STRICT.filter'), 'utf8')).blocks);

test('"astrolabe" is found in General currency and in Unique items', () => {
  const hits = itemSectionHits(cat, 'astrolabe');
  assert.equal(hits.get('currency')?.length, 10, 'the ten Astrolabes of General currency');
  assert.deepEqual(hits.get('uniques'), ['Astrolabe Amulet']);
});

test('an item that several sections list is counted in each of them', () => {
  const hits = itemSectionHits(cat, 'astrolabe amulet');
  const sections = [...hits.keys()];
  assert.ok(sections.length >= 2, `found in ${sections.join(', ')}`);
  for (const names of hits.values()) assert.deepEqual(names, ['Astrolabe Amulet']);
});

test('one letter finds nothing, and the search ignores case', () => {
  assert.equal(itemSectionHits(cat, 'a').size, 0);
  assert.deepEqual([...itemSectionHits(cat, 'ASTROLABE').keys()].sort(), [...itemSectionHits(cat, 'astrolabe').keys()].sort());
});
