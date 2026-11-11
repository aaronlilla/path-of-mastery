// A failed write of filters.json must not read as saved. The real file is made read-only, so the
// store's tmp+rename really fails; the unsaved state stays in memory (no data loss) and saveError says it is not on disk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LootFilterStore, emptyState } from '../src/main/lootfilter/store.js';

test('a failed save keeps the edit in memory, reports saveError until a save succeeds, and leaves the disk alone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pom-lf-store-'));
  const file = join(dir, 'filters.json');
  try {
    const store = new LootFilterStore(file);
    const st = emptyState(1);
    await store.save({ ...st, filters: [{ ...st.filters[0]!, name: 'On disk' }] });
    assert.equal(store.saveError, null);

    chmodSync(file, 0o444);
    await assert.rejects(store.save({ ...st, filters: [{ ...st.filters[0]!, name: 'Unsaved' }] }));
    assert.match(store.saveError ?? '', /EPERM|EACCES/);
    assert.match(readFileSync(file, 'utf8'), /On disk/, 'the disk still holds the last saved state');
    assert.equal((await store.load()).filters[0]!.name, 'Unsaved', 'the unsaved edit is kept for the reopened area');

    chmodSync(file, 0o666);
    await store.save(await store.load());
    assert.equal(store.saveError, null);
    assert.match(readFileSync(file, 'utf8'), /Unsaved/);
  } finally {
    try { chmodSync(file, 0o666); } catch { /* gone */ }
    rmSync(dir, { recursive: true, force: true });
  }
});
