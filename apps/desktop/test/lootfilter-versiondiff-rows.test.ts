// Two tiers that restyle together and share a sample item are one row in the Update merge list (the
// "Stacked Currencies B tier" case: Abrasive Catalyst was listed twice).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseBlocks } from '../src/shared/lootfilter/blocks.js';
import { buildCatalog } from '../src/shared/lootfilter/catalog.js';
import { diffVersions } from '../src/shared/lootfilter/versionDiff.js';
import { NEVERSINK_DIR } from './lootfilterHelpers.js';

const oldText = readFileSync(join(NEVERSINK_DIR, '2-SEMI-STRICT.filter'), 'utf8');
const oldCat = buildCatalog(parseBlocks(oldText).blocks);

test('restyled tiers that share a sample item and a name make one row, and no item is listed twice', () => {
  const lines = oldText.replace(/\r\n?/g, '\n').split('\n');
  let touched = 0;
  for (const b of parseBlocks(oldText).blocks) {
    if (!b.tag || !/^currency->stacked(six|three)$/.test(b.tag.type) || b.kind !== 'Show') continue;
    for (let i = b.line - 1; i < b.endLine; i++) {
      if (/^\s*SetTextColor/.test(lines[i]!)) {
        lines[i] = '\tSetTextColor 9 8 7 255';
        touched++;
      }
    }
  }
  assert.ok(touched >= 2, `${touched} blocks restyled in the fixture`);
  const diff = diffVersions(oldCat, buildCatalog(parseBlocks(lines.join('\n')).blocks), [], '8.99.0', 'Semi-Strict');
  const seen = new Map<string, number>();
  for (const c of diff.changes) seen.set(c.item, (seen.get(c.item) ?? 0) + 1);
  assert.deepEqual([...seen].filter(([, n]) => n > 1), [], 'no item is listed twice');
  const whats = diff.changes.map((c) => c.what);
  assert.equal(new Set(whats).size, whats.length, 'no two rows read the same');
});
