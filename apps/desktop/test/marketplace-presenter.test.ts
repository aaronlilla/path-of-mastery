import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PostId, PublicItemPayload } from '@pom/mastery-contracts';
import { publicPayload, publishedRef, stamp } from '@pom/mastery-contracts/fixtures';
import { HOT_DIVISOR_SECONDS, hotScore, rank, risingScore, sortExplanation, type RankInput } from '../src/renderer/marketplace/ranking.js';
import { VOTE_FAILED, VOTE_RATE, VoteStore, appendPage, buildQuery, cardFromPayload, current, emptyMessage, filterChips, filterFieldsFor, initialFeedState, matchesFilters,
  reconcile, versionList, setFilters, setSearch, setSort, setType, voteBlock, voteOutcome, voteTransition, type Direction, type VoteOutcome } from '../src/renderer/marketplace/presenter.js';

const H = 3600_000, NOW = Date.parse('2026-03-10T12:00:00Z'), START = Date.parse('2026-03-01T00:00:00Z');
const item = (id: string, ageH: number, net: number, votes: { at: number; delta: number }[] = []): RankInput => ({ id, publishedAt: NOW - ageH * H, net, votes, leagueStart: START });

test('Hot uses the published formula and nothing else', () => {
  assert.equal(hotScore(0, START, START), 0);
  assert.equal(hotScore(100, START + 45000_000, START), 3);
  assert.equal(hotScore(-10, START + 45000 * 1000, START), 0);
  assert.equal(HOT_DIVISOR_SECONDS, 45000);
  const a = item('a', 10, 5), b = item('b', 10, 50), c = item('c', 5, 5);
  assert.deepEqual(rank([a, b, c], 'hot', '7_days', NOW).map(i => i.id), ['b', 'c', 'a']);
  assert.match(sortExplanation('hot', '7_days', 'Test league').formula!, /log10\(max\(\|net votes\|, 1\)\).*45000/);
});

test('Top counts votes inside the window; New and Old are publication time; ties go newer then ID', () => {
  const a = item('a', 100, 9, [{ at: NOW - 2 * H, delta: 1 }]), b = item('b', 200, 9, [{ at: NOW - 30 * H, delta: 5 }]), c = item('c', 300, 0, [{ at: NOW - 3 * H, delta: 1 }]);
  assert.deepEqual(rank([a, b, c], 'top', '24_hours', NOW).map(i => i.id), ['a', 'c', 'b']);
  assert.deepEqual(rank([a, b, c], 'top', '7_days', NOW).map(i => i.id), ['b', 'a', 'c']);
  assert.deepEqual(rank([a, b, c], 'new', '7_days', NOW).map(i => i.id), ['a', 'b', 'c']);
  assert.deepEqual(rank([a, b, c], 'old', '7_days', NOW).map(i => i.id), ['c', 'b', 'a']);
  const x = item('x', 10, 1), y = item('y', 10, 1);
  assert.deepEqual(rank([y, x], 'new', '7_days', NOW).map(i => i.id), ['x', 'y']);
});

test('Rising ranks only posts under 72 hours by 24 hour net votes over max(age,1)', () => {
  const young = item('young', 0.5, 3, [{ at: NOW - 1 * H, delta: 3 }]), mid = item('mid', 48, 10, [{ at: NOW - 2 * H, delta: 6 }]), old = item('old', 80, 99, [{ at: NOW - H, delta: 99 }]);
  assert.equal(risingScore(young, NOW), 3);
  assert.equal(risingScore(mid, NOW), 6 / 48);
  assert.equal(risingScore(old, NOW), null);
  assert.deepEqual(rank([old, mid, young], 'rising', '7_days', NOW).map(i => i.id), ['young', 'mid']);
});

test('type tabs keep their own search and filters; All shows common filters only', () => {
  let s = initialFeedState();
  s = setType(s, 'build'); s = setSearch(s, 'cyclone'); s = setFilters(s, { ...current(s).filters, skills: ['Cyclone'], verifiedOnly: true });
  s = setType(s, 'timeline'); assert.equal(current(s).search, '');
  s = setType(s, 'build'); assert.equal(current(s).search, 'cyclone'); assert.deepEqual(current(s).filters.skills, ['Cyclone']);
  s = setType(s, 'all'); assert.deepEqual(filterFieldsFor('all'), ['mode', 'budget', 'tags', 'video', 'verified']); assert.deepEqual(filterChips(s.tabs.build.filters, 'all').map(c => c.id), ['verified']);
  assert.equal(buildQuery(setType(s, 'all'), stamp(), null).skills, undefined);
  const q = buildQuery(setType(s, 'build'), stamp(), 'c2');
  assert.deepEqual([q.query.type, q.query.sort, q.query.window, q.query.search, q.query.cursor, q.skills, q.verifiedOnly], ['build', 'hot', '7_days', 'cyclone', 'c2', ['Cyclone'], true]);
  assert.equal(setSort(initialFeedState(), 'rising').sort, 'rising');
  const chip = filterChips(current(setType(s, 'build')).filters, 'build').find(c => c.id === 'skill:Cyclone')!;
  assert.deepEqual(chip.clear(current(setType(s, 'build')).filters).skills, []);
});

test('feed filters match by field and never by hidden ranking inputs', () => {
  const p = publicPayload();
  assert.equal(matchesFilters(p, { ...initialFeedState().tabs.all.filters, verifiedOnly: true }, 'all'), false);
  assert.equal(matchesFilters(p, initialFeedState().tabs.all.filters, 'build'), false);
  assert.equal(matchesFilters(p, initialFeedState().tabs.all.filters, 'timeline'), true);
});

test('voting: click selected clears, opposite switches, own post and offline block, signed out goes to sign in', () => {
  assert.equal(voteTransition(1, 1), 0); assert.equal(voteTransition(0, 1), 1); assert.equal(voteTransition(1, -1), -1); assert.equal(voteTransition(-1, -1), 0);
  assert.equal(voteBlock({ signedIn: true, ownPostIds: ['p'] }, 'p', false).disabled, true);
  assert.equal(voteBlock({ signedIn: true, ownPostIds: [] }, 'p', true).disabled, true);
  assert.deepEqual(voteBlock({ signedIn: false, ownPostIds: [] }, 'p', false), { disabled: false, reason: null, signIn: true });
});

test('vote count is optimistic only while sending; a deferred vote is never shown as counted', async () => {
  const post = publishedRef().postId as PostId;
  const gates: ((o: VoteOutcome) => void)[] = [];
  const s = new VoteStore(() => new Promise<VoteOutcome>(r => gates.push(r)));
  s.observe(post, 10, 1000);
  const sending = s.click(post, 1, 0);
  assert.equal(s.shown(post, 0, 10).net, 11, 'sending: optimistic');
  const later = new Date(Date.now() + 3600_000).toISOString();
  gates[0]!({ kind: 'pending', direction: 1, countAt: later, net: 10, revision: 2000 });
  await sending;
  assert.deepEqual([s.shown(post, 0, 10).net, s.shown(post, 0, 10).state], [10, 'pending_count'], 'deferred: not counted');
  assert.equal(voteOutcome({ state: 'done', result: { ok: true, value: { direction: 1, net: 4, countAt: later } } }).kind, 'pending');
  assert.deepEqual(voteOutcome({ state: 'done', result: { ok: true, value: { direction: 1, net: 4, revision: 17 } } }), { kind: 'counted', direction: 1, net: 4, revision: 17 });
  assert.equal(voteOutcome({ state: 'retry', result: null }).kind, 'rate_limited');
  assert.equal(voteOutcome({ state: 'failed', result: null }).kind, 'failed');
});

test('a counted vote shows the net the site confirmed; an older feed page never replaces it, a newer one does', async () => {
  const post = publishedRef().postId as PostId;
  const s = new VoteStore(async () => ({ kind: 'counted', direction: 1, net: 2, revision: 2000 }));
  s.observe(post, 1, 1000);
  await s.click(post, 1, 0);
  assert.deepEqual([s.shown(post, 0, 1).net, s.shown(post, 0, 1).selected], [2, 1]);
  s.observe(post, 1, 1500); // a page counted before the vote
  assert.equal(s.shown(post, 0, 1).net, 2);
  s.observe(post, 5, 3000); // a page counted after it
  assert.equal(s.shown(post, 0, 1).net, 5);
  s.observe(post, 9, null); // a count of unknown time never replaces a known one
  assert.equal(s.shown(post, 0, 1).net, 5);
});

test('pending votes serialize and the final intended direction wins', async () => {
  const sent: Direction[] = []; const gates: ((o: VoteOutcome) => void)[] = [];
  const post = publishedRef().postId as PostId;
  const s = new VoteStore((_p, d) => { sent.push(d); return new Promise<VoteOutcome>(r => gates.push(r)); });
  const first = s.click(post, 1); void s.click(post, 1); void s.click(post, -1);
  assert.deepEqual(sent, [1]); assert.equal(s.shown(post, 0, 0).selected, -1);
  gates[0]!({ kind: 'counted', direction: 1, net: 1, revision: 1 });
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(sent, [1, -1]);
  gates[1]!({ kind: 'counted', direction: -1, net: -1, revision: 2 });
  await first;
  const done = s.shown(post, 0, 0); assert.deepEqual([done.counted, done.selected, done.state, done.net], [-1, -1, 'idle', -1]);
});

test('failed vote rolls back with the exact message and Retry sends it again; a rate limit keeps the choice', async () => {
  const post = publishedRef().postId as PostId;
  const answers: VoteOutcome[] = [{ kind: 'failed' }, { kind: 'counted', direction: 1, net: 1, revision: 5 }];
  const failing = new VoteStore(async () => answers.shift()!);
  await failing.click(post, 1, 0);
  const f = failing.shown(post, 0, 0);
  assert.deepEqual([f.counted, f.selected, f.state, f.message, f.retryable], [0, 0, 'error', VOTE_FAILED, true]);
  assert.equal(VOTE_FAILED, 'Your vote was not saved. Retry.');
  await failing.retry(post);
  assert.deepEqual([failing.shown(post, 0, 0).selected, failing.shown(post, 0, 0).net], [1, 1], 'Retry sent the vote that failed');
  const limited = new VoteStore(async () => ({ kind: 'rate_limited' }));
  await limited.click(post, -1, 1);
  const v = limited.shown(post, 1, 3);
  assert.equal(v.selected, -1); assert.equal(v.message, VOTE_RATE); assert.equal(v.retryable, true); assert.equal(v.net, 3, 'not counted');
});

test('rank refresh: new posts wait for Refresh; reordering waits while the pointer is on a row', () => {
  const mk = (id: string, net: number) => ({ ...publicPayload(), publicId: id as never, votes: { up: net, down: 0, net } }) as PublicItemPayload;
  const shown = [mk('a', 5), mk('b', 4)];
  assert.deepEqual(reconcile(shown, shown, true), { apply: false, pending: null });
  assert.deepEqual(reconcile(shown, [mk('c', 9), ...shown], false), { apply: false, pending: { kind: 'new', newCount: 1 } });
  const swapped = [mk('b', 6), mk('a', 5)];
  assert.deepEqual(reconcile(shown, swapped, true), { apply: false, pending: { kind: 'ranks', newCount: 0 } });
  assert.deepEqual(reconcile(shown, swapped, false), { apply: true, pending: null });
});

test('Load more keeps cursor history and never duplicates a row on re-entry', () => {
  const mk = (id: string) => ({ ...publicPayload(), publicId: id as never }) as PublicItemPayload;
  let f = appendPage({ items: [], cursors: [], next: null }, null, [mk('a'), mk('b')], 'c1');
  f = appendPage(f, 'c1', [mk('b'), mk('c')], null);
  assert.deepEqual(f.items.map(i => i.publicId), ['a', 'b', 'c']); assert.deepEqual(f.cursors, [null, 'c1']);
  assert.equal(appendPage(f, 'c1', [mk('z')], null), f);
});

test('building a card or reading a detail never changes the published source', () => {
  const p = publicPayload(); const before = JSON.stringify(p);
  const frozen = structuredClone(p);
  const deep = (o: unknown): void => { if (o && typeof o === 'object') { Object.freeze(o); Object.values(o).forEach(deep); } }; deep(frozen);
  const card = cardFromPayload(frozen, false);
  assert.equal(card.ownership, 'public'); assert.equal(card.title, p.title);
  assert.equal(JSON.stringify(p), before);
});

test('empty and offline copy matches the spec', () => {
  const s = initialFeedState();
  assert.equal(emptyMessage(s, 'Mirage', false).text, 'No posts for Mirage yet.');
  assert.equal(emptyMessage(s, 'Mirage', true).text, 'No items match these filters.');
  assert.equal(emptyMessage(initialFeedState('following'), 'Mirage', false).text, 'Follow a creator to see their posts here.');
  assert.equal(emptyMessage(initialFeedState('archive'), 'Mirage', false).text, "No posts in Mirage's archive.");
});

test('viewing an older version keeps the newer ones in the Versions list', () => {
  const old = { ...publicPayload(), publishedRevision: { ...publicPayload().publishedRevision, displayRevision: 1 } } as PublicItemPayload;
  assert.deepEqual(versionList(old).map(v => v.revision), [1]);
  assert.deepEqual(versionList(old, 2).map(v => [v.revision, v.latest]), [[2, true], [1, false]]);
});

test('a vote refused for a human check and resent after Continue goes through the vote store: count, revision and myVote, no new request', async () => {
  const post = publishedRef().postId as PostId;
  let sends = 0;
  const s = new VoteStore(async () => { sends++; return { kind: 'failed' }; });
  s.observe(post, 0, 10, 0);
  await s.click(post, 1, 0);
  assert.equal(s.shown(post, 0, 0).message, VOTE_FAILED);
  s.settle(post, { kind: 'counted', direction: 1, net: 1, revision: 11, myVote: 1 });
  const v = s.shown(post, 0, 0);
  assert.deepEqual([v.net, v.selected, v.counted, v.state, v.message], [1, 1, 1, 'idle', undefined], 'the resent vote shows as counted');
  s.observe(post, 0, 10, 0);
  assert.equal(s.shown(post, 0, 0).net, 1, 'an older read (lower revision) does not undo it');
  s.settle(post, { kind: 'failed' });
  assert.equal(s.shown(post, 0, 0).state, 'idle', 'a failed resend changes nothing here (the dialog reports it)');
  assert.equal(sends, 1, 'settling sends nothing');
});
