import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseId, type ApiResult, type PublicItemPayload } from '@pom/mastery-contracts';
import { hashBytes } from '../src/main/documents/blobs.js';
import { MarketplaceStore } from '../src/main/marketplace/store.js';
import { PublicCache } from '../src/main/marketplace/cache.js';
import { registerMarketplaceIpc } from '../src/main/marketplace/ipc.js';
import { createMarketplaceClient } from '../src/renderer/marketplace/client.js';
import { fresh, publicPayload, limits, stamp, deferred } from '../src/main/marketplace/testFixtures.js';

test('signed-out Save and collections work offline and survive a durable reopen with Unknown stamps', async () => {
  const f = await fresh();
  try {
    const ref = await f.cache.save(publicPayload()); const collection = await f.cache.createCollection('Local collection', stamp());
    await f.cache.setMember(collection.objectId, ref.objectId, true);
    assert.equal(f.api.calls.length, 0); assert.equal(f.cache.collections()[0]!.members.length, 1);
    await f.store.close(); const reopened = new MarketplaceStore(f.dir, limits); await reopened.init();
    try { const cache = new PublicCache(reopened, f.api); const open = await cache.open(ref.objectId);
      assert.equal(open.saved.stamp.leagueId.status, 'unknown'); assert.equal(open.saved.cachedPayload.document.kind, 'timeline');
      assert.equal(cache.collections()[0]!.stamp.realm.status, 'unknown'); } finally { await reopened.close(); }
  } finally { await f.cleanup(); }
});
test('failed or partial download retains a Download needed reference and cannot open', async () => {
  const f = await fresh();
  try {
    const item = publicPayload(), ref = await f.cache.reserve(item.publicId, item.publishedRevision, item.stamp);
    await f.cache.download(ref.objectId); assert.equal(f.cache.reference(ref.objectId).cacheStatus, 'download_needed');
    await assert.rejects(f.cache.open(ref.objectId), { code: 'DOWNLOAD_NEEDED' });
    const malformed = publicPayload(); if (malformed.document.kind === 'timeline') malformed.document.payload.dependencies = [];
    f.api.run = async () => ({ ok: true, value: malformed });
    await assert.rejects(f.cache.download(ref.objectId), { code: 'INVALID' }); assert.equal(f.cache.list().length, 1);
  } finally { await f.cleanup(); }
});
test('required assets must download and pass SHA-256 before a cache becomes ready', async () => {
  const bytes = Buffer.from('synthetic asset'); let fail = true;
  const f = await fresh({ assets: async () => fail ? Buffer.from('corrupt') : bytes });
  try {
    const payload = publicPayload(); if (payload.document.kind === 'timeline') payload.document.payload.assets = [{ assetId: 'fixture-image', contentHash: hashBytes(bytes), mediaType: 'image/png' }];
    await assert.rejects(f.cache.save(payload), { code: 'INVALID' }); assert.equal(f.cache.list()[0]!.cacheStatus, 'download_needed');
    fail = false; const saved = await f.cache.save(payload); assert.equal(saved.cacheStatus, 'ready'); await f.cache.open(saved.objectId);
  } finally { await f.cleanup(); }
});
test('no asset reader preserves the saved reference without claiming offline readiness', async () => {
  const f = await fresh();
  try { const payload = publicPayload(); if (payload.document.kind === 'timeline') payload.document.payload.assets = [{ assetId: 'fixture-image', contentHash: hashBytes('asset'), mediaType: 'image/png' }];
    await assert.rejects(f.cache.save(payload), { code: 'DOWNLOAD_NEEDED' }); assert.equal(f.cache.list()[0]!.cacheStatus, 'download_needed');
  } finally { await f.cleanup(); }
});
test('source removal preserves cached snapshot and embedded dependencies', async () => {
  const f = await fresh();
  try { const ref = await f.cache.save(publicPayload()); await f.cache.previewUpdate(ref.objectId);
    const open = await f.cache.open(ref.objectId); assert.equal(open.originalRemoved, true);
    assert.equal(open.saved.cachedPayload.document.kind === 'timeline' && open.saved.cachedPayload.document.payload.dependencies.length, 1);
  } finally { await f.cleanup(); }
});
test('preview is separate from explicit Save update and existing clips/Run snapshots remain pinned', async () => {
  const f = await fresh();
  try {
    const original = publicPayload(), frozenRun = structuredClone(original.document), ref = await f.cache.save(original);
    const collection = await f.cache.createCollection('Current', stamp()); await f.cache.setMember(collection.objectId, ref.objectId, true);
    const update = publicPayload(); update.publishedRevision = { ...update.publishedRevision, revisionId: parseId('revision', '66666666-6666-4666-8666-666666666666'), displayRevision: 2 as typeof update.publishedRevision.displayRevision }; update.title = 'Creator correction';
    f.api.run = async () => ({ ok: true, value: update }); await f.cache.previewUpdate(ref.objectId);
    assert.equal((await f.cache.open(ref.objectId)).saved.selectedRevision.displayRevision, 1);
    await f.cache.applyUpdate(ref.objectId, original.publishedRevision, update);
    assert.equal((await f.cache.open(ref.objectId)).saved.selectedRevision.displayRevision, 2);
    assert.deepEqual(frozenRun, original.document); assert.equal(f.cache.collections()[0]!.members[0]!.source.revisionId, update.publishedRevision.revisionId);
    await assert.rejects(f.cache.applyUpdate(ref.objectId, original.publishedRevision, update), { code: 'CONFLICT' });
  } finally { await f.cleanup(); }
});
test('wrong public identity or exact revision from the resolver is rejected', async () => {
  const f = await fresh();
  try { const ref = await f.cache.save(publicPayload()), wrong = publicPayload(); wrong.publicId = parseId('public', '77777777-7777-4777-8777-777777777777');
    f.api.run = async () => ({ ok: true, value: wrong }); await assert.rejects(f.cache.download(ref.objectId), { code: 'INVALID' }); await assert.rejects(f.cache.previewUpdate(ref.objectId), { code: 'INVALID' });
  } finally { await f.cleanup(); }
});
test('a removed reference cannot be resurrected by a delayed download', async () => {
  const f = await fresh(), waiting = deferred<ApiResult<PublicItemPayload>>();
  try { const ref = await f.cache.save(publicPayload()); f.api.run = () => waiting.promise; const download = f.cache.download(ref.objectId);
    await f.cache.remove(ref.objectId); waiting.resolve({ ok: true, value: publicPayload() }); await assert.rejects(download, { code: 'INVALID' }); assert.equal(f.cache.list().length, 0);
  } finally { await f.cleanup(); }
});
test('corrupt blob bytes are rejected on open without destroying reference', async () => {
  const f = await fresh();
  try { const ref = await f.cache.save(publicPayload()), path = join(f.store.blobs.root, `${ref.blob}.json`); const before = await readFile(path, 'utf8');
    await writeFile(path, before + ' '); await assert.rejects(f.cache.open(ref.objectId), /hash/); assert.equal(f.cache.list().length, 1);
  } finally { await f.cleanup(); }
});
test('disk/index failure cannot publish a ready pointer; retry completes the same reference', async () => {
  let fail = false; const f = await fresh({ probe: point => { if (fail && point === 'beforeIndexCommit') throw new Error('Synthetic disk failure.'); } });
  try { const item = publicPayload(), ref = await f.cache.reserve(item.publicId, item.publishedRevision, item.stamp); fail = true;
    await assert.rejects(f.cache.save(item), /disk/); assert.equal(f.cache.reference(ref.objectId).cacheStatus, 'download_needed'); fail = false;
    assert.equal((await f.cache.save(item)).objectId, ref.objectId);
  } finally { await f.cleanup(); }
});
test('sender and field checks protect the registered client boundary; no account can be supplied by renderer', async () => {
  const f = await fresh(); let handler!: (event: unknown, input: unknown) => Promise<unknown>; let removed = false;
  try { const dispose = registerMarketplaceIpc({ handle: (_channel, fn) => { handler = fn; }, removeHandler: () => { removed = true; } }, f, event => event === 'main');
    const client = createMarketplaceClient(async (_channel, input) => handler('main', input));
    assert.equal((await client.call('save', { payload: publicPayload() })).ok, true);
    assert.equal((await handler('run', { schemaVersion: 1, method: 'saved' }) as { ok: boolean }).ok, false);
    assert.equal((await handler('main', { schemaVersion: 1, method: 'activity', account: 'forged' }) as { ok: boolean }).ok, false);
    dispose(); assert.equal(removed, true);
  } finally { await f.cleanup(); }
});
test('collection name bounds and shutdown barrier reject invalid/late changes', async () => {
  const f = await fresh();
  try { await assert.rejects(f.cache.createCollection('x'.repeat(81), stamp()), { code: 'INVALID' }); await f.store.close(); await assert.rejects(f.cache.save(publicPayload()), { code: 'CLOSED' }); }
  finally { await f.cleanup(); }
});
