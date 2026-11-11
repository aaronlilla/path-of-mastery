// The real Bulk board feed: listings of players, made-up examples only apart and only while few real sellers exist, seller name per listing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CloudBoardFeed } from '../src/main/wealth/bulkBoard.js';
import type { BoardBackend } from '../src/main/wealth/communityStrategies.js';
import type { BulkRow } from '../src/main/accounts/cloudApi.js';

const NOW = 1_000_000_000_000;
const row = (i: number, over: Partial<BulkRow> = {}): BulkRow => ({ id: `r${i}`, seller: `Seller${i}`, cat: 'cur', items: [{ name: 'Divine Orb', qty: 10 }], marketChaos: 3700, mult: 95, postedAt: NOW - 3600_000, lastOnlineAt: NOW - 60_000, vouches: 0, mine: false, voted: undefined, offers: [], ...over });

function backend(rows: BulkRow[], over: { signedIn?: boolean; fail?: boolean } = {}) {
  const calls: unknown[] = [];
  const b: BoardBackend = {
    index: async () => [],
    submit: async () => undefined,
    signedIn: () => over.signedIn ?? true,
    userName: () => 'Kaelen',
    bulk: {
      view: async () => { if (over.fail) throw new Error('Could not reach the cloud.'); return rows; },
      post: async (i) => void calls.push(['post', i]),
      heartbeat: async () => void calls.push(['heartbeat']),
      vote: async (id, k) => void calls.push(['vote', id, k]),
      offer: async (id, m, n) => void calls.push(['offer', id, m, n]),
      remove: async (id) => void calls.push(['remove', id]),
    },
  };
  return { feed: new CloudBoardFeed(b, () => 'Allflame', () => 377, () => NOW), calls };
}

test('real listings come through; the sample block appears apart while fewer than 5 sellers have a live listing', async () => {
  const { feed } = backend([row(1), row(2)]);
  const v = await feed.view();
  assert.equal(v.status, 'ready');
  if (v.status !== 'ready') return;
  assert.equal(v.sample, false);
  assert.deepEqual(v.listings.map((l) => l.seller), ['Seller1', 'Seller2']);
  assert.ok(v.sampleListings!.length > 0);
  assert.ok(v.sampleListings!.every((s) => !v.listings.some((l) => l.id === s.id)));
});

test('with 5 real sellers the sample block is gone', async () => {
  const { feed } = backend([1, 2, 3, 4, 5].map((i) => row(i)));
  const v = await feed.view();
  assert.equal(v.status === 'ready' && v.sampleListings!.length, 0);
});

test('the seller name is per listing and falls back to the account name; signed out cannot post', async () => {
  const { feed, calls } = backend([]);
  assert.deepEqual(await feed.post({ cat: 'cur', items: [{ name: 'Divine Orb', qty: 5 }], marketChaos: 1850, mult: 98, seller: 'Hex#12' }), { ok: true });
  assert.deepEqual(await feed.post({ cat: 'cur', items: [{ name: 'Divine Orb', qty: 5 }], marketChaos: 1850, mult: 98 }), { ok: true });
  assert.equal((calls[0] as any)[1].seller, 'Hex#12');
  assert.equal((calls[1] as any)[1].seller, 'Kaelen');
  assert.equal((calls[0] as any)[1].league, 'Allflame');
  const out = backend([], { signedIn: false });
  assert.equal((await out.feed.post({ cat: 'cur', items: [{ name: 'a', qty: 1 }], marketChaos: 1, mult: 100 })).ok, false);
});

test('an unreachable backend says so, with no listings', async () => {
  const { feed } = backend([], { fail: true });
  const v = await feed.view();
  assert.equal(v.status, 'unavailable');
});

test('the owner sees offers with price and age; votes and offers go to the backend', async () => {
  const { feed, calls } = backend([row(1, { mine: true, offers: [{ id: 'o1', from: 'Corvin#9015', mult: 90, at: NOW - 600_000 }] })]);
  const v = await feed.view();
  assert.equal(v.status === 'ready' && v.listings[0]!.offers![0]!.mult, 90);
  await feed.vouch('r1');
  await feed.report('r1');
  await feed.offer('r1', 999);
  assert.deepEqual(calls.filter((c) => (c as unknown[])[0] !== 'heartbeat'), [['vote', 'r1', 'vouch'], ['vote', 'r1', 'report'], ['offer', 'r1', 150, 'Kaelen']]);
});
