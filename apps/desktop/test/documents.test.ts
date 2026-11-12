import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseId, sourceSnapshotSchema, type LeagueStamp, type ObjectId, type RevisionId, type WriteDocumentRequest } from '@pom/mastery-contracts';
import { DocumentStore, DocumentStoreError } from '../src/main/documents/store.js';
import { historyPath, replayRevision, TextEditGroup } from '../src/shared/documents/history.js';
import { threeWayMerge } from '../src/shared/documents/merge.js';
import { DOCUMENT_CHANNEL, registerDocumentIpc } from '../src/main/documents/ipc.js';

export const limits = { maxBytes: 1000000, maxDepth: 40, maxNodes: 10000, maxArrayLength: 1000, maxStringLength: 100000 };
export const stamp: LeagueStamp = {
  leagueId: { status: 'unknown', reason: 'Synthetic test' }, realm: { status: 'unknown', reason: 'Synthetic test' },
  mode: { status: 'unknown', reason: 'Synthetic test' }, patchVersion: { status: 'unknown', reason: 'Synthetic test' },
  datasetVersion: { status: 'unknown', reason: 'Not applicable to test notes' }, createdAt: '2026-10-11T00:00:00.000Z',
};
export const payload = (text: string) => ({ kind: 'notes' as const, payload: { schemaVersion: 1 as const, title: 'Test notes', stamp, instructions: [], notes: text } });
export const request = (id: ObjectId, expected: RevisionId | null, text: string): WriteDocumentRequest<ReturnType<typeof payload>> =>
  ({ objectId: id, expectedRevisionId: expected, payload: payload(text), stamp, idempotencyKey: randomUUID() });
export async function fresh() {
  const dir = await mkdtemp(join(tmpdir(), 'p02-documents-'));
  const options = { schemas: { notes: sourceSnapshotSchema }, limits, checkpointEvery: 2 };
  const store = new DocumentStore(dir, options);
  await store.init();
  const id = parseId('object', randomUUID());
  return { dir, store, id, options, cleanup: async () => { await store.close(true); await rm(dir, { recursive: true, force: true }); } };
}

test('create, durable reopen, separate CAS row version, and Unknown stamp', async () => {
  const { dir, store, id, options, cleanup } = await fresh();
  try {
    assert.equal(store.driver, 'wasm');
    const saved = await store.write('notes', request(id, null, 'first'), { label: 'Created notes' });
    assert.equal(saved.rowVersion, 1);
    assert.equal((await store.read(id)).revision.stamp.leagueId.status, 'unknown');
    await store.close();
    const reopened = new DocumentStore(dir, options);
    await reopened.init();
    assert.deepEqual((await reopened.read(id)).payload, payload('first'));
    assert.deepEqual(reopened.revisionRef(id, saved.revision.revisionId), saved.revision);
    await reopened.close();
  } finally { await cleanup(); }
});

test('simultaneous CAS writes accept one, preserve the losing pending snapshot', async () => {
  const { store, id, cleanup } = await fresh();
  try {
    const first = await store.write('notes', request(id, null, 'base'), { label: 'Created notes' });
    const results = await Promise.allSettled(['one', 'two'].map(text => store.write('notes', request(id, first.revision.revisionId, text), { label: 'Changed text' })));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const failure = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    assert.equal((failure.reason as DocumentStoreError).code, 'CONFLICT');
    assert.deepEqual((await store.read(id)).payload, payload('one'));
    assert.deepEqual(store.pendingSnapshot(id)!.request.payload, payload('two'));
    assert.equal(store.history(id).events.length, 2);
  } finally { await cleanup(); }
});

test('idempotent retry returns the original receipt and rejects changed key reuse', async () => {
  const { store, id, cleanup } = await fresh();
  try {
    const input = request(id, null, 'first');
    const response = await store.write('notes', input, { label: 'Created notes' });
    assert.deepEqual(await store.write('notes', input, { label: 'Created notes' }), response);
    await assert.rejects(store.write('notes', { ...input, payload: payload('different') }, { label: 'Created notes' }), { code: 'CONFLICT' });
    assert.equal(store.history(id).events.length, 1);
  } finally { await cleanup(); }
});

test('Undo creates a fresh CAS revision, Redo follows active branch, abandoned edits survive', async () => {
  const { store, id, cleanup } = await fresh();
  try {
    const a = await store.write('notes', request(id, null, 'A'), { label: 'Created notes' });
    const b = await store.write('notes', request(id, a.revision.revisionId, 'B'), { label: 'Changed text' });
    const undo = await store.undo(id, b.revision.revisionId);
    assert.notEqual(undo.revision.revisionId, a.revision.revisionId);
    assert.deepEqual((await store.read(id)).payload, payload('A'));
    await assert.rejects(store.write('notes', request(id, a.revision.revisionId, 'stale'), { label: 'Stale change' }), { code: 'CONFLICT' });
    const c = await store.write('notes', request(id, undo.revision.revisionId, 'C'), { label: 'New branch' });
    const history = store.history(id);
    assert.equal(history.events.length, 3);
    assert.notEqual(history.events[1]!.branchId, history.events[2]!.branchId);
    assert.deepEqual((await store.readRevision(id, b.revision.revisionId)).payload, payload('B'));
    const back = await store.undo(id, c.revision.revisionId);
    const redo = await store.redo(id, back.revision.revisionId);
    assert.deepEqual((await store.read(id)).payload, payload('C'));
    const restored = await store.restore(id, redo.revision.revisionId, b.revision.revisionId, randomUUID());
    assert.deepEqual((await store.read(id)).payload, payload('B'));
    assert.equal(store.history(id).events.length, 4);
    const restoredUndo = await store.undo(id, restored.revision.revisionId);
    assert.deepEqual((await store.read(id)).payload, payload('C'));
    assert.ok(restoredUndo.rowVersion > restored.rowVersion);
  } finally { await cleanup(); }
});

test('checkpoint replay and historical preview leave the current revision untouched', async () => {
  const { store, id, cleanup } = await fresh();
  try {
    let revision: RevisionId | null = null;
    for (const text of ['A', 'B', 'C', 'D', 'E']) revision = (await store.write('notes', request(id, revision, text), { label: 'Changed text' })).revision.revisionId;
    const history = store.history(id);
    assert.equal(history.checkpoints.length, 3);
    for (const event of history.events) {
      assert.deepEqual(replayRevision(history.events, history.checkpoints, event.transactionId), event.after);
      assert.deepEqual(replayRevision(history.events, [], event.transactionId), event.after);
    }
    assert.deepEqual((await store.preview(id, history.events[0]!.transactionId)).payload, payload('A'));
    assert.equal((await store.read(id)).revision.revisionId, revision);
    assert.equal(historyPath(history.events, history.tip).length, 5);
    assert.throws(() => historyPath([{ ...history.events[0]!, parentTransactionId: history.tip }], history.events[0]!.transactionId));
  } finally { await cleanup(); }
});

test('trash removes only the listing, restore preserves revisions, dependencies and branches', async () => {
  const { store, id, cleanup } = await fresh();
  try {
    const saved = await store.write('notes', request(id, null, 'retained'), { label: 'Created notes' });
    await store.retain({ kind: 'run', id: randomUUID() }, [saved.revision.fallbackSnapshotHash]);
    await store.trash(id, saved.revision.revisionId);
    assert.equal(store.list().length, 0);
    assert.equal(store.list(true).length, 1);
    await assert.rejects(store.read(id), { code: 'NOT_FOUND' });
    assert.ok(store.retainedRoots().includes(saved.revision.fallbackSnapshotHash));
    assert.deepEqual((await store.readRevision(id, saved.revision.revisionId)).payload, payload('retained'));
    await store.restoreTrash(id);
    assert.equal(store.list().length, 1);
    assert.equal((await store.read(id)).revision.revisionId, saved.revision.revisionId);
  } finally { await cleanup(); }
});

test('Run and Save roots keep standalone frozen blobs reachable across reopen', async () => {
  const { store, dir, options, cleanup } = await fresh();
  try {
    const hash = await store.blobs.put(JSON.stringify({ frozen: 'synthetic dependency' }));
    assert.equal((await store.recoveryInventory()).length, 1);
    await store.retain({ kind: 'run', id: randomUUID() }, [hash]);
    await store.retain({ kind: 'save', id: randomUUID() }, [hash]);
    await store.close();
    const reopened = new DocumentStore(dir, options);
    await reopened.init();
    assert.ok(reopened.retainedRoots().includes(hash));
    assert.equal((await reopened.recoveryInventory()).length, 0);
    await reopened.close();
  } finally { await cleanup(); }
});

test('bounded ingress rejects invalid payloads and unregistered kinds without history', async () => {
  const { store, id, cleanup } = await fresh();
  try {
    await assert.rejects(store.write('atlas', request(id, null, 'wrong'), { label: 'Invalid' }), { code: 'INVALID' });
    await assert.rejects(store.write('notes', { ...request(id, null, 'wrong'), payload: { ...payload('wrong'), privateExtra: true } }, { label: 'Invalid' }), { code: 'INVALID' });
    assert.equal(store.list().length, 0);
  } finally { await cleanup(); }
});

test('text grouping flushes after 500 ms idle or blur; discrete gestures stay outside it', () => {
  const group = new TextEditGroup<string>();
  assert.equal(group.push('', 'a', 0), null);
  assert.equal(group.push('a', 'ab', 400), null);
  assert.equal(group.flush(899), null);
  assert.deepEqual(group.flush(900), { before: '', after: 'ab' });
  group.push('ab', 'abc', 901);
  assert.deepEqual(group.flush(902, true), { before: 'ab', after: 'abc' });
  group.push('abc', 'abcd', 1000);
  assert.deepEqual(group.push('abcd', 'abcde', 1600), { before: 'abc', after: 'abcd' });
});

test('three-way update preserves mine by default and applies independent remote changes', () => {
  const base = { title: 'original', instructions: 'original', ids: ['synthetic:1'] };
  const mine = { ...base, title: 'local', ids: ['synthetic:2'] };
  const theirs = { title: 'remote', instructions: 'updated', ids: ['synthetic:3'] };
  const result = threeWayMerge(base, mine, theirs);
  assert.deepEqual(result.value, { title: 'local', instructions: 'updated', ids: ['synthetic:2'] });
  assert.deepEqual(result.conflicts.map(conflict => conflict.path), [['title'], ['ids']]);
  assert.equal(threeWayMerge({ a: 1, b: 2 }, { b: 2 }, { a: 1, b: 3 }).value.a, undefined);
  assert.deepEqual(base.ids, ['synthetic:1']);
});

test('exclusive store owner rejects another live opener without touching its index', async () => {
  const { store, dir, id, options, cleanup } = await fresh();
  try {
    await store.write('notes', request(id, null, 'owned'), { label: 'Created notes' });
    const second = new DocumentStore(dir, options);
    await assert.rejects(second.init());
    assert.deepEqual((await store.read(id)).payload, payload('owned'));
  } finally { await cleanup(); }
});

test('close drains an accepted write once and rejects new writes while closing', async () => {
  const { store, id, cleanup } = await fresh();
  try {
    const saving = store.write('notes', request(id, null, 'accepted'), { label: 'Created notes' });
    const closing = store.close();
    assert.equal(store.close(), closing);
    await assert.rejects(store.write('notes', request(id, null, 'too late'), { label: 'Created notes' }), { code: 'CLOSED' });
    await saving;
    await closing;
  } finally { await cleanup(); }
});

test('IPC validates sender and IDs, preserves CAS failures, and uses a main-owned export path', async () => {
  const { store, dir, id, cleanup } = await fresh();
  try {
    let handler!: (event: unknown, input: unknown) => Promise<unknown>;
    let removed = '';
    const dispose = registerDocumentIpc({ handle: (channel, fn) => { assert.equal(channel, DOCUMENT_CHANNEL); handler = fn; }, removeHandler: channel => { removed = channel; } }, store,
      { isTrustedSender: event => event === 'trusted', chooseRecoveryDestination: async () => join(dir, 'ipc-recovery.json') });
    const call = (method: string, args = {}) => handler('trusted', { schemaVersion: 1, method, ...args }) as Promise<{ ok: boolean; error?: { code: string }; value?: unknown }>;
    assert.equal((await handler('untrusted', { schemaVersion: 1, method: 'list' }) as { ok: boolean }).ok, false);
    assert.equal((await call('read', { objectId: '../unsafe' })).error!.code, 'INVALID');
    assert.equal((await call('exportRecovery', { objectId: id, path: '../unsafe' })).error!.code, 'INVALID');
    const saved = await store.write('notes', request(id, null, 'base'), { label: 'Created notes' });
    await store.write('notes', request(id, saved.revision.revisionId, 'changed'), { label: 'Changed text' });
    const conflict = await call('write', { kind: 'notes', request: request(id, saved.revision.revisionId, 'pending'), edit: { label: 'Changed text' } });
    assert.equal(conflict.error!.code, 'CONFLICT');
    assert.deepEqual((await call('exportRecovery', { objectId: id })).value, { exported: true });
    dispose();
    assert.equal(removed, DOCUMENT_CHANNEL);
  } finally { await cleanup(); }
});
