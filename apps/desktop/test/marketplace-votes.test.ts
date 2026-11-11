// The Marketplace vote store (presenter.ts VoteStore) against a model of the database: a per-post vote revision that only grows (a
// counter, never a row count), the viewer's own counted vote (myVote) with every read, refreshes of several mounted feeds (some serving
// an older page), detail reads, other accounts' votes, other voters' account erasure, the viewer's votes with answers delayed and
// delivered out of order, rate limits, failures and retries, interleaved.
// After every step: the count shown is the database's count as of the highest-revision read the app received, with only the vote being
// sent added on top (net - myVote + choice); every place shows the same; once nothing is in flight and a fresh read arrived, it equals
// the database now. The viewer's vote is never counted twice.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PostId } from '@pom/mastery-contracts';
import { VoteStore, type Direction, type VoteOutcome } from '../src/renderer/marketplace/presenter.js';

const POST = '44444444-4444-4444-8444-444444444444' as PostId;
type Feed = 'current' | 'archive' | 'following';
type Read = { net: number; revision: number; myVote: Direction };

/** The database for one post: other voters, the viewer's counted vote, and a revision counter that every change raises. */
function world(start: Direction[] = [1]) {
  let revision = 0, viewer: Direction = 0, rateLimited = false, failNext = false, delayed = false;
  const others = [...start];
  const net = () => others.reduce<number>((a, b) => a + b, 0) + viewer;
  const now = (): Read => ({ net: net(), revision, myVote: viewer });
  let highest: Read = { net: net(), revision: -1, myVote: 0 }; // the highest-revision read the app received
  const received = (r: Read) => { if (r.revision >= highest.revision) highest = r; };
  const snapshots: Partial<Record<Feed, Read>> = {};
  const held: (() => void)[] = [];
  const send = (_post: PostId, direction: Direction): Promise<VoteOutcome> => {
    if (rateLimited) return Promise.resolve({ kind: 'rate_limited' });
    if (failNext) { failNext = false; return Promise.resolve({ kind: 'failed' }); }
    if (direction !== viewer) { viewer = direction; revision++; } // the database applies the vote at once
    const answer = now();
    const outcome: VoteOutcome = { kind: 'counted', direction, net: answer.net, revision: answer.revision, myVote: answer.myVote };
    if (!delayed) { received(answer); return Promise.resolve(outcome); }
    return new Promise(resolve => held.push(() => { received(answer); resolve(outcome); }));
  };
  const store = new VoteStore(send);
  const settle = () => new Promise(r => setTimeout(r, 0));
  return {
    store, others,
    get net() { return net(); }, get viewer() { return viewer; }, get highest() { return highest; }, get inFlight() { return held.length; },
    other(delta: Direction) { others.push(delta); revision++; },
    /** Account erasure of another voter: their vote is deleted, and the revision still goes up. */
    erase() { const i = others.findIndex(v => v !== 0); if (i >= 0) { others.splice(i, 1); revision++; } },
    refresh(feed: Feed, fresh: boolean) {
      const snap = fresh || !snapshots[feed] ? now() : snapshots[feed]!;
      snapshots[feed] = snap; received(snap);
      store.observe(POST, snap.net, snap.revision, snap.myVote);
    },
    detail() { const r = now(); received(r); store.observe(POST, r.net, r.revision, r.myVote); },
    setRateLimited(v: boolean) { rateLimited = v; }, failOnce() { failNext = true; }, setDelayed(v: boolean) { delayed = v; },
    /** Delivers one held answer (the oldest or the newest: out of order). */
    async deliver(newest = false) { const f = newest ? held.pop() : held.shift(); f?.(); await settle(); await settle(); },
    async deliverAll() { while (held.length) await this.deliver(); },
    settle,
  };
}
function check(w: ReturnType<typeof world>, step: string) {
  const shown = w.store.shown(POST, 0, -999), elsewhere = w.store.shown(POST, 0, 12345);
  assert.deepEqual(shown, elsewhere, `${step}: every card and detail page shows the same`);
  const h = w.highest, expected = shown.state === 'sending' ? h.net - h.myVote + shown.selected : h.net;
  assert.equal(shown.net, expected, `${step}: shown ${shown.net}, expected ${expected} (highest read ${JSON.stringify(h)}, database ${w.net}, state ${shown.state})`);
  if (shown.state === 'idle' && w.inFlight === 0 && h.revision >= 0) assert.equal(shown.selected, h.myVote, `${step}: the selected arrow is the viewer's counted vote`);
}

test("rate limit, another account votes, refresh, release, Retry: the count is the database's", async () => {
  const w = world([1]);
  w.refresh('current', true); check(w, 'start');
  w.setRateLimited(true); await w.store.click(POST, 1, 0); check(w, 'rate-limited');
  assert.equal(w.store.shown(POST, 0, 1).selected, 1, 'the choice is kept for Retry');
  w.other(1); w.refresh('current', true); check(w, 'another vote, refreshed');
  w.setRateLimited(false); await w.store.retry(POST); check(w, 'retried');
  assert.deepEqual([w.store.shown(POST, 0, 0).net, w.net], [3, 3]);
});

test('a mounted Archive or Following feed serving an older page never hides the confirmed count', async () => {
  const w = world([1]);
  w.refresh('current', true); w.refresh('archive', true); w.refresh('following', true);
  w.other(1); w.refresh('current', true);
  await w.store.click(POST, 1, 0); check(w, 'upvote confirmed at 3');
  w.refresh('archive', false); w.refresh('following', false); check(w, 'hidden feeds re-serve their older pages');
  assert.equal(w.store.shown(POST, 0, 0).net, 3);
});

test('a vote answer delayed past a fresh feed read never replaces the newer count', async () => {
  const w = world([1]); w.refresh('current', true);
  w.setDelayed(true); const voting = w.store.click(POST, 1, 0); await w.settle();
  w.other(1); w.refresh('current', true); check(w, 'fresh read while the answer is held');
  await w.deliver(); await voting; check(w, 'the old answer arrives last');
  assert.deepEqual([w.store.shown(POST, 0, 0).net, w.net], [3, 3]);
});

test('a refresh while the vote answer is delayed does not count the viewer\'s vote twice', async () => {
  const w = world([1]); w.refresh('current', true);
  w.setDelayed(true); const voting = w.store.click(POST, 1, 0); await w.settle();
  assert.equal(w.store.shown(POST, 0, 0).net, 2, 'optimistic: 1 + the upvote');
  w.refresh('current', true); // this page already includes the upvote (myVote 1)
  check(w, 'refreshed while sending');
  assert.equal(w.store.shown(POST, 0, 0).net, 2, 'still 2, not 3');
  await w.deliver(); await voting; check(w, 'answer arrives');
  assert.deepEqual([w.store.shown(POST, 0, 0).net, w.net], [2, 2]);
});

test('another voter\'s account erasure lowers the count, and the revision still goes up', async () => {
  const w = world([1, 1]); w.refresh('current', true); check(w, 'start at 2');
  w.erase(); w.refresh('current', true); check(w, 'after erasure');
  assert.deepEqual([w.store.shown(POST, 0, 0).net, w.net], [1, 1]);
});

test('random interleavings over 400 seeds: shown matches the database at every step', async () => {
  let seed = 1;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const feeds: Feed[] = ['current', 'archive', 'following'];
  for (let run = 1; run <= 400; run++) {
    seed = run * 7919;
    const w = world(Array.from({ length: Math.floor(random() * 5) }, () => (random() < 0.6 ? 1 : -1) as Direction));
    w.refresh(feeds[Math.floor(random() * 3)]!, true);
    const log: string[] = [];
    const pending: Promise<void>[] = [];
    for (let i = 0; i < 50; i++) {
      const r = random(), feed = feeds[Math.floor(random() * 3)]!;
      let step: string;
      if (r < 0.16) { step = `refresh ${feed}`; w.refresh(feed, true); }
      else if (r < 0.24) { step = `stale ${feed}`; w.refresh(feed, false); }
      else if (r < 0.33) { const d = random() < 0.5 ? 1 : -1; step = `other ${d}`; w.other(d); }
      else if (r < 0.38) { step = 'erase a voter'; w.erase(); }
      else if (r < 0.54) { const d = random() < 0.5 ? 1 : -1; step = `click ${d}`; pending.push(w.store.click(POST, d, 0)); await w.settle(); }
      else if (r < 0.6) { step = 'retry'; if (w.store.shown(POST, 0, 0).retryable) { pending.push(w.store.retry(POST)); await w.settle(); } }
      else if (r < 0.67) { const on = random() < 0.5; step = `rate ${on}`; w.setRateLimited(on); }
      else if (r < 0.72) { step = 'fail next'; w.failOnce(); }
      else if (r < 0.8) { const on = random() < 0.5; step = `delay ${on}`; w.setDelayed(on); }
      else if (r < 0.9) { step = 'deliver held answer'; await w.deliver(random() < 0.3); }
      else { step = 'detail'; w.detail(); }
      log.push(step);
      check(w, `seed ${run} step ${i} (${log.slice(-8).join(', ')})`);
    }
    w.setDelayed(false); await w.deliverAll(); await Promise.all(pending); await w.settle();
    w.refresh('current', true);
    const shown = w.store.shown(POST, 0, 0);
    if (shown.state !== 'sending') assert.equal(shown.net, w.net, `seed ${run}: after everything settles and a fresh read, shown is the database's ${w.net}`);
  }
});

test('concurrent presses while a vote is in flight: the last choice wins and the count matches the database', async () => {
  const w = world([]); w.refresh('current', true);
  const first = w.store.click(POST, 1, 0); void w.store.click(POST, -1, 0); void w.store.click(POST, -1, 0); void w.store.click(POST, 1, 0);
  await first; await w.settle();
  check(w, 'settled');
  assert.equal(w.viewer, 1);
});

test('a fresh detail read updates a known count (the highest revision wins), an older one does not', () => {
  const s = new VoteStore(async () => ({ kind: 'failed' }));
  s.observe(POST, 1, 1000, 0);
  s.observe(POST, 2, 2000, 0);
  assert.equal(s.shown(POST, 0, 0).net, 2);
  s.observe(POST, 1, 1500, 0);
  assert.equal(s.shown(POST, 0, 0).net, 2);
});
