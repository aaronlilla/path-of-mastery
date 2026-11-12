import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { parseId, type ApiResult, type DocumentEnvelope } from '@pom/mastery-contracts';
import { MarketplaceApi } from '../src/main/marketplace/api.js';
import { MarketplaceSync } from '../src/main/marketplace/sync.js';
import { DocumentStore } from '../src/main/documents/store.js';
import { atlasPlanSchema } from '@pom/mastery-contracts';
import { A, B, fresh, publicPayload, limits, plan, stamp, ref, publishedRef, action, deferred } from '../src/main/marketplace/testFixtures.js';

test('Save sync is opt-in and sends the enrollment shape without erasing local collections', async () => {
  const f = await fresh();
  try { const saved = await f.cache.save(publicPayload()); await f.cache.createCollection('Local only', stamp()); assert.equal(f.outbox.entries().length, 0);
    await f.outbox.activate(A); await f.sync.enrollSave(saved.objectId); f.api.run = async () => ({ ok: true, value: { rowVersion: 1 } }); await f.outbox.drain();
    const body = f.api.calls[0]!.body as Record<string, unknown>; assert.equal(body.action, 'write'); assert.equal(body.cacheStatus, 'ready'); assert.equal(body.expectedRowVersion, 0);
    assert.equal(f.cache.collections().length, 1); assert.equal((await f.cache.open(saved.objectId)).saved.stamp.leagueId.status, 'unknown');
  } finally { await f.cleanup(); }
});
test('partial download enrollment explicitly sends download_needed', async () => {
  const f = await fresh();
  try { const item = publicPayload(), saved = await f.cache.reserve(item.publicId, item.publishedRevision, item.stamp); await f.outbox.activate(A); await f.sync.enrollSave(saved.objectId);
    assert.equal((f.outbox.entries()[0]!.body as { cacheStatus: string }).cacheStatus, 'download_needed');
  } finally { await f.cleanup(); }
});
test('cloud CAS conflict keeps both immutable snapshots and creates a local copy through the document store', async () => {
  const f = await fresh(), documents = new DocumentStore(f.dir, { schemas: { atlas: atlasPlanSchema }, limits, checkpointEvery: 2 }); await documents.init();
  try { await f.outbox.activate(A); const id = parseId('object', randomUUID());
    const written = await documents.write('atlas', { objectId: id, expectedRevisionId: null, payload: plan(), stamp: stamp(), idempotencyKey: 'create' }, { label: 'Created synthetic plan' });
    const local = await documents.read(id), remote: DocumentEnvelope<unknown> = { ...local, revision: { ...local.revision, revisionId: parseId('revision', randomUUID()) }, payload: { ...plan(), title: 'Remote edit' } };
    f.api.run = async (_operation, body) => (body as { action: string }).action === 'write' ? { ok: false, code: 'REVISION_CONFLICT', message: 'CAS conflict.' } : { ok: true, value: { items: [{ ...remote, rowVersion: 2, deletedAt: null }] } };
    const sync = new MarketplaceSync(f.store, f.api, f.outbox, f.cache, documents); const conflict = await sync.pushDocument(local, written.revision.revisionId);
    assert.ok('keptCopy' in conflict); assert.ok(conflict.keptCopy); assert.equal(sync.conflicts().length, 1);
    assert.deepEqual((await documents.read(id)).payload, local.payload); assert.deepEqual((await documents.read(conflict.keptCopy!)).payload, local.payload);
    assert.equal((conflict.remote.payload as { title: string }).title, 'Remote edit'); await f.outbox.activate(B); assert.equal(sync.conflicts().length, 0);
  } finally { await documents.close(); await f.cleanup(); }
});
test('private messages and reply drafts remain account-scoped; signed-out feedback drafts stay local', async () => {
  const f = await fresh();
  try { const draft = { request: { publishedRevision: publishedRef(), clipId: action().clipId, actionId: action().actionId, reason: 'timing_wrong', text: 'Local note', idempotencyKey: 'draft' }, allowReplies: false, bundleId: null };
    await f.privateCache.saveDraft('local', draft); assert.equal(f.privateCache.drafts().length, 1); await f.outbox.activate(A); assert.equal(f.privateCache.drafts().length, 0);
    f.api.run = async () => ({ ok: true, value: { items: [{ threadId: randomUUID(), role: 'runner', publishedRevision: publishedRef(), allowReplies: false, text: 'Private note', messages: [] }] } });
    await f.privateCache.refresh('sent'); assert.equal(f.privateCache.threads().length, 1); await f.outbox.activate(B); f.privateCache.accountChanged(); assert.equal(f.privateCache.threads().length, 0);
    await f.outbox.activate(null); assert.equal(f.privateCache.drafts().length, 1); assert.equal(f.privateCache.threads().length, 0);
  } finally { await f.cleanup(); }
});
test('late private inbox response cannot cross an account switch', async () => {
  const f = await fresh(), pending = deferred<ApiResult<unknown>>();
  try { await f.outbox.activate(A); f.api.run = () => pending.promise; const refresh = f.privateCache.refresh('sent');
    await f.outbox.activate(B); f.privateCache.accountChanged(); pending.resolve({ ok: true, value: { items: [] } }); await assert.rejects(refresh, { code: 'ACCOUNT_CHANGED' });
    assert.equal(f.privateCache.threads().length, 0);
  } finally { await f.cleanup(); }
});
test('HTTP API exercises anonymous offline->online Save at loopback with the sync route and envelope', async () => {
  const f = await fresh(); let requests = 0;
  const server = createServer(async (request, response) => {
    requests++; assert.equal(request.url, '/api/marketplace/item'); assert.equal(request.headers.authorization, undefined);
    let bytes = ''; for await (const part of request) bytes += part;
    const body = JSON.parse(bytes); assert.equal(body.publicId, publicPayload().publicId); assert.equal(body.revision, 1);
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ ok: true, value: publicPayload() }));
  }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try { const address = server.address() as { port: number }, api = new MarketplaceApi(`http://127.0.0.1:${address.port}`, () => null, limits);
    const cache = new (await import('../src/main/marketplace/cache.js')).PublicCache(f.store, api);
    const item = publicPayload(), saved = await cache.reserve(item.publicId, item.publishedRevision, item.stamp); assert.equal(requests, 0);
    await cache.download(saved.objectId); await cache.open(saved.objectId); assert.equal(requests, 1);
  } finally { server.close(); await once(server, 'close'); await f.cleanup(); }
});
test('HTTP client rejects changed account, oversized response and nonlocal cleartext origins', async () => {
  const f = await fresh(); let account = A;
  try { assert.throws(() => new MarketplaceApi('http://example.com', () => null, limits), { code: 'INVALID' });
    const api = new MarketplaceApi('https://fixture.invalid', () => ({ accountId: account, accessToken: 'fixture-only' }), limits,
      async () => { account = B; return new Response(JSON.stringify({ ok: true, value: {} })); });
    await assert.rejects(api.request('saves', { action: 'read' }, A), { code: 'ACCOUNT_CHANGED' });
    const large = new MarketplaceApi('https://fixture.invalid', () => null, { ...limits, maxBytes: 30 }, async () => new Response('x'.repeat(31)));
    await assert.rejects(large.request('item', {}, null), /too large/);
  } finally { await f.cleanup(); }
});

test('two offline writes to one Save: the second takes the first one\'s accepted version and a retry repeats the same request', async () => {
  const f = await fresh();
  try { const saved = await f.cache.save(publicPayload()); await f.outbox.activate(A);
    await f.sync.enrollSave(saved.objectId); await f.sync.enrollSave(saved.objectId);
    let cloud = 0, dropOnce = true;
    f.api.run = async (_operation, body) => { const b = body as { expectedRowVersion: number };
      if (b.expectedRowVersion !== cloud) return { ok: false, code: 'REVISION_CONFLICT', message: 'CAS conflict.' };
      if (dropOnce && cloud === 1) { dropOnce = false; return { ok: false, code: 'UNAVAILABLE', message: 'offline' }; }
      cloud++; return { ok: true, value: { rowVersion: cloud } }; };
    await f.outbox.drain();
    const entries = f.outbox.entries(); assert.deepEqual(entries.map(e => e.state), ['done', 'failed']);
    const second = f.api.calls[1]!.body as { expectedRowVersion: number }; assert.equal(second.expectedRowVersion, 1);
    // The failed one is retried with exactly the request it first sent.
    await f.outbox.confirm(entries[1]!.id); await f.outbox.drain();
    assert.deepEqual(f.api.calls[2]!.body, f.api.calls[1]!.body); assert.equal(f.outbox.entries()[1]!.state, 'done');
  } finally { await f.cleanup(); }
});
