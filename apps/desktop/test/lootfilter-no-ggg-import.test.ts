// Regression: no "Import from pathofexile.com" card or account-sync text in the Filters and Export views.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

for (const f of ['FiltersView.tsx', 'ExportView.tsx']) {
  test(`${f} has no pathofexile.com import or sync text`, () => {
    const src = readFileSync(fileURLToPath(new URL(`../../src/renderer/lootfilter/advanced/views/${f}`, import.meta.url)), 'utf8');
    assert.doesNotMatch(src, /Import from pathofexile\.com|syncing to pathofexile\.com|Send to GGG|Update on account/);
  });
}

test('the generated stamp is kept while the filter is unchanged, and a failed write names the file', () => {
  const store = readFileSync(fileURLToPath(new URL('../../src/renderer/lootfilter/lfStore.tsx', import.meta.url)), 'utf8');
  assert.match(store, /stampRef\.current\?\.key !== key/);
  assert.match(store, /generateFilter\(\{ now: stampRef\.current\.at/);
  const ex = readFileSync(fileURLToPath(new URL('../../src/renderer/lootfilter/advanced/views/ExportView.tsx', import.meta.url)), 'utf8');
  assert.match(ex, /Write failed \(\$\{doc\.fileName\}\)/);
});
