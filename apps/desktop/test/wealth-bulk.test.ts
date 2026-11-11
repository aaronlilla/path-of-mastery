import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askChaos, lotSummary, boardOpen, EXPIRES_MS, filterListings, isHidden, isOnline, live, whisper, type BulkListing, type BulkFilter } from '../src/shared/bulk.js';
import { NeedsAccountFeed, SampleBoardFeed } from '../src/main/wealth/bulkBoard.js';

const NOW = 1_000_000_000_000;
const mk = (o: Partial<BulkListing> = {}): BulkListing => ({
  id: 'a', seller: 'Tyrel#1102', lastOnlineAt: NOW, cat: 'cur', items: [{ name: 'Divine Orb', qty: 40 }], marketChaos: 15080, mult: 98, postedAt: NOW, vouches: 0, reporters: [], ...o,
});
const F: BulkFilter = { q: '', cat: 'all', onlineOnly: false, sort: 'new' };

test('the asking price is market value times the multiplier', () => {
  assert.equal(askChaos(mk({ marketChaos: 1000, mult: 90 })), 900);
});

test('a listing ends 12 hours after its seller was last online', () => {
  const l = mk({ lastOnlineAt: NOW - EXPIRES_MS - 1 });
  assert.equal(live([l], NOW).length, 0);
  assert.equal(live([mk({ lastOnlineAt: NOW - EXPIRES_MS + 1000 })], NOW).length, 1);
});

test('online means the app was open in the last few minutes', () => {
  assert.ok(isOnline(mk({ lastOnlineAt: NOW - 60_000 }), NOW));
  assert.ok(!isOnline(mk({ lastOnlineAt: NOW - 3600_000 }), NOW));
});

test('two independent reports hide a listing, one reporter twice does not', () => {
  assert.ok(!isHidden(mk({ reporters: ['x'] })));
  assert.ok(!isHidden(mk({ reporters: ['x', 'x'] })));
  assert.ok(isHidden(mk({ reporters: ['x', 'y'] })));
  assert.equal(live([mk({ reporters: ['x', 'y'] })], NOW).length, 0);
  // the seller still sees their own reported listing
  assert.equal(live([mk({ reporters: ['x', 'y'], mine: true })], NOW).length, 1);
});

test('the board stays out of the nav until five other sellers have live listings', () => {
  const ls = (n: number) => Array.from({ length: n }, (_, i) => mk({ id: `l${i}`, seller: `s${i}` }));
  assert.ok(!boardOpen(ls(4), NOW));
  assert.ok(boardOpen(ls(5), NOW));
  // one seller with five listings is one seller
  assert.ok(!boardOpen(Array.from({ length: 5 }, (_, i) => mk({ id: `l${i}` })), NOW));
  // expired and hidden listings do not count
  assert.ok(!boardOpen([...ls(4), mk({ id: 'x', seller: 'z', reporters: ['a', 'b'] })], NOW));
});

test('filters by category, online and text; online sellers come first', () => {
  const a = mk({ id: 'a', seller: 'A#1', lastOnlineAt: NOW - 3600_000, mult: 90 });
  const b = mk({ id: 'b', seller: 'B#1', cat: 'scar', items: [{ name: 'Gilded Breach Scarab', qty: 10 }], mult: 99 });
  const c = mk({ id: 'c', seller: 'C#1', mult: 95 });
  assert.deepEqual(filterListings([a, b, c], F, NOW).map((l) => l.id), ['b', 'c', 'a']);
  assert.deepEqual(filterListings([a, b, c], { ...F, cat: 'scar' }, NOW).map((l) => l.id), ['b']);
  assert.deepEqual(filterListings([a, b, c], { ...F, onlineOnly: true }, NOW).map((l) => l.id).sort(), ['b', 'c']);
  assert.deepEqual(filterListings([a, b, c], { ...F, q: 'breach' }, NOW).map((l) => l.id), ['b']);
  assert.deepEqual(filterListings([a, b, c], { ...F, sort: 'deal', onlineOnly: true }, NOW).map((l) => l.id), ['c', 'b']);
  assert.equal(filterListings([mk({ mine: true })], F, NOW).length, 0, 'your own listing is not in the buyer table');
});

test('the whisper names the seller, the lot and the price', () => {
  const t = whisper(mk(), 377);
  assert.match(t, /^@Tyrel Hi,/);
  assert.match(t, /40x Divine Orb/);
  assert.match(t, /39\.2 divine \(98% of market\)/);
});

test('without an account the feed shows no listings and refuses every action', async () => {
  const f = new NeedsAccountFeed();
  assert.deepEqual(await f.view(), { status: 'needs-account', listings: [] });
  assert.equal((await f.post({ cat: 'cur', items: [{ name: 'x', qty: 1 }], marketChaos: 1, mult: 100 })).ok, false);
  assert.equal((await f.report('a')).ok, false);
});

test('the sample board opens the nav, takes a post, a vouch and two reports', async () => {
  const f = new SampleBoardFeed(() => NOW, () => 377);
  const v = async () => {
    const x = await f.view();
    assert.equal(x.status, 'ready');
    return x.status === 'ready' ? x.listings : [];
  };
  assert.ok(boardOpen(await v(), NOW), 'enough sample sellers for the nav');
  const before = (await v()).find((l) => l.id === 's0')!.vouches;
  await f.vouch('s0');
  await f.vouch('s0');
  assert.equal((await v()).find((l) => l.id === 's0')!.vouches, before + 1, 'one vouch per player');
  assert.equal((await f.post({ cat: 'cur', items: [], marketChaos: 0, mult: 100 })).ok, false);
  assert.equal((await f.post({ cat: 'cur', items: [{ name: 'Chaos Orb', qty: 100 }], marketChaos: 100, mult: 400 })).ok, true);
  const mine = (await v()).find((l) => l.mine)!;
  assert.equal(mine.mult, 150, 'the multiplier is held to 50-150');
  assert.ok((mine.offers ?? []).length > 0);
  await f.report('s1');
  assert.ok(!isHidden((await v()).find((l) => l.id === 's1')!), 'one report alone does not hide');
  assert.equal((await f.remove(mine.id)).ok, true);
  assert.equal((await v()).some((l) => l.mine), false);
});

test('a long lot is summarised, not listed in full', () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ name: `Item ${i}`, qty: 1 }));
  assert.equal(lotSummary(items), '1x Item 0, 1x Item 1, 1x Item 2 and 7 more');
  assert.ok(whisper(mk({ items }), 377).length < 200);
});
