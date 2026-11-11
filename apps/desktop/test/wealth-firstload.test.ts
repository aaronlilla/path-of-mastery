import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NinjaFeed } from '../src/main/wealth/ninja.js';
import { PriceBook } from '../src/main/wealth/priceBook.js';
import { emptyView } from '../src/shared/wealth.js';
import { loadSteps } from '../src/renderer/wealth/loadSteps.js';

async function feed(fetchFn: typeof fetch, onProgress?: () => void) {
  const dir = await mkdtemp(join(tmpdir(), 'pom-ninja-'));
  const f = new NinjaFeed({ league: () => 'Allflame', cacheDir: dir, userAgent: 't', fetchFn, gapMs: 0, sleep: async () => {}, ...(onProgress ? { onProgress } : {}) });
  return { f, done: () => rm(dir, { recursive: true, force: true }) };
}

test('before any fetch has ended prices are neither failed nor loaded: the screens show loading, not an error', async () => {
  const { f, done } = await feed((async () => new Response('{}')) as typeof fetch);
  const st = f.status();
  assert.equal(st.failed, false);
  assert.equal(st.loading, false);
  assert.equal(st.lines, 0);
  await done();
});

test('while prices load the status carries real progress, and a failed fetch says what failed and what happens next in one message', async () => {
  const seen: { done: number; total: number }[] = [];
  let ft: NinjaFeed | null = null;
  const { f, done } = await feed((async () => new Response('down', { status: 503 })) as typeof fetch, () => {
    const p = ft!.status().progress;
    if (p) seen.push(p);
  });
  ft = f;
  const book = new PriceBook();
  const p = f.refresh(book);
  assert.equal(f.status().loading, true);
  const end = await p;
  assert.ok(seen.length > 10 && seen[0]!.done === 0 && seen[1]!.done === 1 && seen[seen.length - 1]!.done === seen[0]!.total);
  assert.equal(end.loading, false);
  assert.equal(end.failed, true);
  assert.match(end.message, /poe\.ninja answered 503/);
  assert.match(end.message, /tries again in 15 minutes/);
  await done();
});

test('the loading words use the real counts and name no failure', () => {
  const w = emptyView();
  assert.equal(loadSteps(w).prices, 'Loading prices…');
  w.prices = { ...w.prices, loading: true, progress: { done: 12, total: 46 } };
  assert.equal(loadSteps(w).prices, 'Loading prices… 12 of 46 categories');
  w.prices = { ...w.prices, lines: 900, loading: false, progress: null };
  assert.equal(loadSteps(w).stash, ''); // no account: nothing to say about a stash
  w.sync = { ...w.sync, connected: true, phase: 'reading', reading: { done: 2, total: 12, label: 'x' } };
  assert.equal(loadSteps(w).stash, 'Reading your stash: tab 3 of 12');
});
