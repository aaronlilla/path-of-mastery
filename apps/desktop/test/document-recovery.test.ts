import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseId, sourceSnapshotSchema, type LeagueStamp, type ObjectId, type RevisionId, type WriteDocumentRequest } from '@pom/mastery-contracts';
import { DocumentStore } from '../src/main/documents/store.js';
import type { FaultPoint } from '../src/main/documents/blobs.js';

const limits = { maxBytes: 1000000, maxDepth: 40, maxNodes: 10000, maxArrayLength: 1000, maxStringLength: 100000 };
const stamp: LeagueStamp = {
  leagueId: { status: 'unknown', reason: 'Synthetic test' }, realm: { status: 'unknown', reason: 'Synthetic test' },
  mode: { status: 'unknown', reason: 'Synthetic test' }, patchVersion: { status: 'unknown', reason: 'Synthetic test' },
  datasetVersion: { status: 'unknown', reason: 'Not applicable to test notes' }, createdAt: '2026-10-11T00:00:00.000Z',
};
const payload = (text: string) => ({ kind: 'notes' as const, payload: { schemaVersion: 1 as const, title: 'Test notes', stamp, instructions: [], notes: text } });
const request = (id: ObjectId, expected: RevisionId | null, text: string): WriteDocumentRequest<ReturnType<typeof payload>> =>
  ({ objectId: id, expectedRevisionId: expected, payload: payload(text), stamp, idempotencyKey: randomUUID() });
const options = { schemas: { notes: sourceSnapshotSchema }, limits, checkpointEvery: 2 };

for (const point of ['blobWrite', 'blobFlush', 'blobRename', 'beforeIndexCommit'] as const) {
  test(`disk-full at ${point} preserves old index, failed draft and recovery export`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'p02-recovery-'));
    let fail: FaultPoint | null = null;
    const store = new DocumentStore(dir, { ...options, probe: point => {
      if (point === fail) throw Object.assign(new Error('Synthetic disk full'), { code: 'ENOSPC' });
    } });
    await store.init();
    const id = parseId('object', randomUUID());
    try {
      const saved = await store.write('notes', request(id, null, 'old'), { label: 'Created notes' });
      fail = point;
      await assert.rejects(store.write('notes', request(id, saved.revision.revisionId, 'pending'), { label: 'Changed text' }), { code: 'STORAGE_FAILED' });
      assert.deepEqual((await store.read(id)).payload, payload('old'));
      assert.equal(store.history(id).events.length, 1);
      assert.equal(store.hasUnsavedChanges, true);
      await assert.rejects(store.close(), { code: 'UNSAVED' });
      const file = join(dir, 'recovery.json');
      await store.exportRecovery(id, file);
      assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).request.payload, payload('pending'));
      const inventory = await store.recoveryInventory();
      assert.equal(inventory.length, 1);
      assert.equal(inventory[0]!.complete, point === 'beforeIndexCommit');
      await store.exportOrphan(inventory[0]!.name, join(dir, 'orphan.json'));
      fail = null;
      await store.retry(id);
      assert.deepEqual((await store.read(id)).payload, payload('pending'));
      assert.equal(store.hasUnsavedChanges, false);
    } finally { await store.close(true); await rm(dir, { recursive: true, force: true }); }
  });
}

for (const point of ['beforeIndexCommit', 'afterIndexCommit'] as const) {
  test(`process crash ${point}: reopen sees only a complete old or new revision`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'p02-crash-'));
    const id = parseId('object', randomUUID());
    let store = new DocumentStore(dir, options);
    await store.init();
    const saved = await store.write('notes', request(id, null, 'old'), { label: 'Created notes' });
    const pending = request(id, saved.revision.revisionId, 'new');
    await store.close();
    const storeUrl = new URL('../src/main/documents/store.js', import.meta.url).href;
    const contractsUrl = import.meta.resolve('@pom/mastery-contracts');
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { DocumentStore } from ${JSON.stringify(storeUrl)};
      import { sourceSnapshotSchema } from ${JSON.stringify(contractsUrl)};
      const store = new DocumentStore(${JSON.stringify(dir)}, {
        schemas: { notes: sourceSnapshotSchema }, limits: ${JSON.stringify(limits)}, checkpointEvery: 2,
        probe: point => { if (point === ${JSON.stringify(point)}) process.exit(73); }
      });
      await store.init();
      await store.write('notes', ${JSON.stringify(pending)}, { label: 'Changed text' });
    `], { env: process.env, encoding: 'utf8', timeout: 15000 });
    assert.equal(child.status, 73, child.stderr);
    store = new DocumentStore(dir, options);
    await store.init();
    try {
      assert.deepEqual((await store.read(id)).payload, payload(point === 'afterIndexCommit' ? 'new' : 'old'));
      assert.equal(store.history(id).events.length, point === 'afterIndexCommit' ? 2 : 1);
      const inventory = await store.recoveryInventory();
      assert.equal(inventory.length, point === 'beforeIndexCommit' ? 1 : 0);
      if (point === 'beforeIndexCommit') assert.equal(inventory[0]!.complete, true);
      const result = await store.write('notes', pending, { label: 'Changed text' });
      assert.equal((await store.read(id)).revision.revisionId, result.revision.revisionId);
      assert.equal(store.history(id).events.length, 2);
    } finally { await store.close(true); await rm(dir, { recursive: true, force: true }); }
  });
}

test('lost reply after durable commit retries by receipt without another history event', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'p02-reply-'));
  let fail = false;
  const store = new DocumentStore(dir, { ...options, probe: point => { if (point === 'afterIndexCommit' && fail) throw new Error('Reply interrupted'); } });
  await store.init();
  const id = parseId('object', randomUUID());
  try {
    fail = true;
    await assert.rejects(store.write('notes', request(id, null, 'committed'), { label: 'Created notes' }), { code: 'STORAGE_FAILED' });
    assert.equal(store.hasUnsavedChanges, true);
    assert.deepEqual((await store.read(id)).payload, payload('committed'));
    fail = false;
    await store.retry(id);
    assert.equal(store.history(id).events.length, 1);
    assert.equal(store.hasUnsavedChanges, false);
  } finally { await store.close(true); await rm(dir, { recursive: true, force: true }); }
});

test('durable draft is separate from successful history and reopens for recovery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'p02-draft-'));
  let store = new DocumentStore(dir, options);
  await store.init();
  const id = parseId('object', randomUUID());
  try {
    await store.persistDraft('notes', request(id, null, 'draft'), { label: 'Created notes' });
    assert.equal(store.list().length, 0);
    await store.close(true);
    store = new DocumentStore(dir, options);
    await store.init();
    assert.equal(store.hasUnsavedChanges, true);
    assert.deepEqual((await store.recoverDraft(id))!.request.payload, payload('draft'));
    await store.retry(id);
    assert.equal(store.history(id).events.length, 1);
    assert.equal(await store.recoverDraft(id), null);
  } finally { await store.close(true); await rm(dir, { recursive: true, force: true }); }
});

test('invalid recovery drafts remain on disk and do not hide valid documents', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'p02-invalid-draft-'));
  let store = new DocumentStore(dir, options);
  await store.init();
  const id = parseId('object', randomUUID());
  try {
    await store.write('notes', request(id, null, 'saved'), { label: 'Created notes' });
    await store.close();
    const draftFile = join(dir, 'mastery/drafts', `${id}.json`);
    await writeFile(draftFile, JSON.stringify({ schemaVersion: 1, kind: 'notes', request: request(id, null, 'bad'), edit: { label: '', extra: true } }));
    store = new DocumentStore(dir, options);
    await store.init();
    assert.deepEqual(store.recoveryIssues, [{ objectId: id, code: 'INVALID' }]);
    assert.deepEqual((await store.read(id)).payload, payload('saved'));
    assert.ok((await readFile(draftFile, 'utf8')).includes('extra'));
  } finally { await store.close(true); await rm(dir, { recursive: true, force: true }); }
});

test('corrupt or missing committed blob cannot be returned as a valid document', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'p02-corrupt-'));
  const store = new DocumentStore(dir, options);
  await store.init();
  const id = parseId('object', randomUUID());
  try {
    const saved = await store.write('notes', request(id, null, 'original'), { label: 'Created notes' });
    const path = join(store.blobs.root, `${saved.revision.fallbackSnapshotHash}.json`);
    await writeFile(path, '{}');
    await assert.rejects(store.read(id), /hash/);
    assert.equal((await store.recoveryInventory())[0]!.hash, null);
    await rm(path);
    await assert.rejects(store.read(id), { code: 'ENOENT' });
  } finally { await store.close(true); await rm(dir, { recursive: true, force: true }); }
});

test('real filesystem write failure keeps the pending snapshot exportable and retryable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'p02-real-failure-'));
  const store = new DocumentStore(dir, options);
  await store.init();
  const id = parseId('object', randomUUID());
  try {
    const saved = await store.write('notes', request(id, null, 'old'), { label: 'Created notes' });
    // Remove the empty write destination after relocating upstream blobs inside this temp store.
    const { rename } = await import('node:fs/promises');
    await rename(store.blobs.root, join(store.root, 'retained-blobs'));
    await writeFile(store.blobs.root, 'Occupied by a file');
    await assert.rejects(store.write('notes', request(id, saved.revision.revisionId, 'recover me'), { label: 'Changed text' }), { code: 'STORAGE_FAILED' });
    await store.exportRecovery(id, join(dir, 'real-recovery.json'));
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'real-recovery.json'), 'utf8')).request.payload, payload('recover me'));
    await rm(store.blobs.root);
    await rename(join(store.root, 'retained-blobs'), store.blobs.root);
    await store.retry(id);
    assert.deepEqual((await store.read(id)).payload, payload('recover me'));
    assert.equal(store.history(id).events.length, 2);
  } finally { await store.close(true); await rm(dir, { recursive: true, force: true }); }
});

test('SQLite page exhaustion rolls back index changes and preserves the orphan and pending content', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'p02-sqlite-full-'));
  const store = new DocumentStore(dir, options);
  await store.init();
  const id = parseId('object', randomUUID());
  try {
    const saved = await store.write('notes', request(id, null, 'old'), { label: 'Created notes' });
    const db = (store as unknown as { db: import('../src/main/kb/db.js').KbDb }).db;
    const pages = db.get<{ page_count: number }>('PRAGMA page_count')!.page_count;
    db.exec(`PRAGMA max_page_count=${pages}`);
    await assert.rejects(store.write('notes', request(id, saved.revision.revisionId, 'new'), { label: 'Large history label '.repeat(3000) }), { code: 'STORAGE_FAILED' });
    assert.deepEqual((await store.read(id)).payload, payload('old'));
    assert.equal(store.history(id).events.length, 1);
    assert.equal((await store.recoveryInventory()).length, 1);
    db.exec('PRAGMA max_page_count=1073741823');
    await store.retry(id);
    assert.deepEqual((await store.read(id)).payload, payload('new'));
  } finally { await store.close(true); await rm(dir, { recursive: true, force: true }); }
});

test('failed Undo remains exportable and retries the history pointer without appending an edit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'p02-undo-failure-'));
  let fail = false;
  const store = new DocumentStore(dir, { ...options, probe: point => { if (fail && point === 'beforeIndexCommit') throw new Error('Synthetic storage failure'); } });
  await store.init();
  const id = parseId('object', randomUUID());
  try {
    const a = await store.write('notes', request(id, null, 'A'), { label: 'Created notes' });
    const b = await store.write('notes', request(id, a.revision.revisionId, 'B'), { label: 'Changed text' });
    fail = true;
    await assert.rejects(store.undo(id, b.revision.revisionId), { code: 'STORAGE_FAILED' });
    assert.deepEqual(store.pendingSnapshot(id)!.request.payload, payload('A'));
    assert.deepEqual((await store.read(id)).payload, payload('B'));
    fail = false;
    const undo = await store.retry(id);
    assert.deepEqual((await store.read(id)).payload, payload('A'));
    assert.equal(store.history(id).events.length, 2);
    await store.redo(id, undo.revision.revisionId);
    assert.deepEqual((await store.read(id)).payload, payload('B'));
  } finally { await store.close(true); await rm(dir, { recursive: true, force: true }); }
});
