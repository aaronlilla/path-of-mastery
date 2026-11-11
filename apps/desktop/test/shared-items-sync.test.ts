import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SharedItemsSync, type SharedItemsApi, type SharedItemsStore } from '../src/main/accounts/sharedItemsSync.js';
import { mergeShared, type SharedItems } from '../src/shared/sharedItems.js';

const L = (items: string[] = [], titles: string[] = []): SharedItems => ({ items, sets: titles.map((title) => ({ title, slots: { Helmet: title } })) });

/** The cloud side: one document, compare-and-set, like shared_items_put. */
function fakeCloud(): SharedItemsApi & { doc: { rev: number; data: SharedItems } | null; puts: number } {
  const c = {
    doc: null as { rev: number; data: SharedItems } | null,
    puts: 0,
    async sharedItemsGet() {
      return c.doc ? { rev: c.doc.rev, data: c.doc.data, updated_at: '' } : null;
    },
    async sharedItemsPut(base: number, data: unknown) {
      c.puts++;
      const cur = c.doc;
      if (cur && cur.rev !== base) return { status: 'conflict' as const, rev: cur.rev, data: cur.data };
      c.doc = { rev: (cur?.rev ?? 0) + 1, data: data as SharedItems };
      return { status: 'ok' as const, rev: c.doc.rev };
    },
  };
  return c;
}
function pc(cloud: SharedItemsApi, start: SharedItems = L()) {
  const dir = mkdtempSync(join(tmpdir(), 'pom-shared-'));
  let file = start;
  const store: SharedItemsStore = { read: async () => file, writeFromSync: async (n) => void (file = n) };
  const sync = new SharedItemsSync({ api: cloud, dataDir: dir, deviceId: 'pc', pollMs: 3_600_000 });
  sync.attach(store);
  sync.start('u1');
  return { sync, get file() { return file; }, set(n: SharedItems) { file = n; }, done: () => { sync.stop(); rmSync(dir, { recursive: true, force: true }); } };
}

test('mergeShared: union, cloud order first; with a base, removals stay removed', () => {
  assert.deepEqual(mergeShared(L(['b', 'c']), L(['a', 'b'])).items, ['a', 'b', 'c']);
  assert.deepEqual(mergeShared(L([], ['S1']), L([], ['S2'])).sets.map((s) => s.title), ['S2', 'S1']);
  // base had a,b; this PC removed a; the cloud added c -> b, c
  assert.deepEqual(mergeShared(L(['b']), L(['a', 'b', 'c']), L(['a', 'b'])).items, ['b', 'c']);
  // the cloud removed b; this PC added d -> a, d
  assert.deepEqual(mergeShared(L(['a', 'b', 'd']), L(['a']), L(['a', 'b'])).items, ['a', 'd']);
});

test('a set shared on PC A shows up on PC B after B syncs, and B keeps its own items', async () => {
  const cloud = fakeCloud();
  const a = pc(cloud, L(['itemA'], ['Leveling set']));
  const b = pc(cloud, L(['itemB']));
  await a.sync.sync();
  await b.sync.sync();
  assert.deepEqual(b.file.sets.map((s) => s.title), ['Leveling set']);
  assert.deepEqual([...b.file.items].sort(), ['itemA', 'itemB']);
  await a.sync.sync();
  assert.deepEqual([...a.file.items].sort(), ['itemA', 'itemB']);
  a.done();
  b.done();
});

test('a deletion on one PC reaches the other; nothing is sent when nothing changed', async () => {
  const cloud = fakeCloud();
  const a = pc(cloud, L(['x', 'y']));
  const b = pc(cloud);
  await a.sync.sync();
  await b.sync.sync();
  a.set(L(['y']));
  await a.sync.sync();
  await b.sync.sync();
  assert.deepEqual(b.file.items, ['y']);
  const puts = cloud.puts;
  await a.sync.sync();
  await b.sync.sync();
  assert.equal(cloud.puts, puts);
  a.done();
  b.done();
});

test('a write from the other PC between our read and our push is merged, not lost', async () => {
  const cloud = fakeCloud();
  const a = pc(cloud, L(['one']));
  await a.sync.sync();
  const real = cloud.sharedItemsPut.bind(cloud);
  let first = true;
  cloud.sharedItemsPut = async (base, data, dev) => {
    if (first) {
      first = false;
      cloud.doc = { rev: cloud.doc!.rev + 1, data: L(['one', 'fromB']) }; // B pushed just before us
    }
    return real(base, data, dev);
  };
  a.set(L(['one', 'two']));
  await a.sync.sync();
  assert.deepEqual([...cloud.doc!.data.items].sort(), ['fromB', 'one', 'two']);
  assert.deepEqual([...a.file.items].sort(), ['fromB', 'one', 'two']);
  a.done();
});

test('signed out: nothing is read or written', async () => {
  const cloud = fakeCloud();
  const dir = mkdtempSync(join(tmpdir(), 'pom-shared-'));
  const sync = new SharedItemsSync({ api: cloud, dataDir: dir, deviceId: 'pc', pollMs: 3_600_000 });
  sync.attach({ read: async () => L(['x']), writeFromSync: async () => assert.fail('wrote') });
  await sync.sync();
  assert.equal(cloud.puts, 0);
  assert.equal(cloud.doc, null);
  rmSync(dir, { recursive: true, force: true });
});

test('an in-flight pass for account A is dropped when account B signs in: A\'s data is never merged or uploaded as B', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pom-shared-'));
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let gets = 0;
  const puts: unknown[] = [];
  const api: SharedItemsApi = {
    async sharedItemsGet() {
      if (++gets === 1) { await gate; return { rev: 5, data: L(['A-secret']), updated_at: '' }; }
      return null;
    },
    async sharedItemsPut(_b, data) { puts.push(data); return { status: 'ok', rev: 1 }; },
  };
  let file = L(['mine']);
  const sync = new SharedItemsSync({ api, dataDir: dir, deviceId: 'pc', pollMs: 3_600_000 });
  sync.attach({ read: async () => file, writeFromSync: async (n) => void (file = n) });
  sync.start('A');
  while (gets === 0) await new Promise((r) => setImmediate(r));
  sync.stop();
  sync.start('B');
  release();
  await sync.sync();
  assert.ok(!JSON.stringify(file).includes('A-secret'), 'A data merged locally');
  assert.ok(!JSON.stringify(puts).includes('A-secret'), 'A data uploaded as B');
  sync.stop();
  rmSync(dir, { recursive: true, force: true });
});
