import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpGgg, GggError, encodeAccount, validAccountName, flattenTabs, defaultCounted, unreadableReason, newGggLimiter, type RawTab } from '../src/main/wealth/ggg.js';

const SECRET = 'abcdef0123456789abcdef0123456789';

function clock() {
  let t = 5_000_000;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

function makeClient(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const c = clock();
  const calls: { url: string; init: RequestInit }[] = [];
  const limiter = newGggLimiter(c.now, c.sleep);
  const ggg = new HttpGgg({
    cookie: () => SECRET,
    userAgent: 'PathOfMastery/test (contact: example)',
    limiter,
    fetchFn: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return handler(url, init);
    }) as unknown as typeof fetch,
  });
  return { ggg, calls, limiter, clock: c };
}

const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

test('the stash URL is the documented one, zero-based, with the # in the account name escaped', async () => {
  const { ggg, calls } = makeClient(() => json({ numTabs: 3, tabs: [], items: [] }));
  await ggg.stashTab('Kaelen#4821', 'Allflame', 2, true);
  const u = new URL(calls[0]!.url);
  assert.equal(u.host, 'www.pathofexile.com');
  assert.equal(u.pathname, '/character-window/get-stash-items');
  assert.equal(u.searchParams.get('accountName'), 'Kaelen#4821');
  assert.ok(calls[0]!.url.includes('accountName=Kaelen%234821'), 'the raw URL carries %23');
  assert.equal(u.searchParams.get('tabIndex'), '2');
  assert.equal(u.searchParams.get('tabs'), '1');
  assert.equal(u.searchParams.get('realm'), 'pc');
  assert.equal(u.searchParams.get('league'), 'Allflame');
});

test('the cookie goes in the Cookie header only, never in the URL', async () => {
  const { ggg, calls } = makeClient(() => json({ numTabs: 0, items: [] }));
  await ggg.stashTab('Kaelen', 'Allflame', 0, true);
  assert.equal((calls[0]!.init.headers as Record<string, string>).Cookie, `POESESSID=${SECRET}`);
  assert.ok(!calls[0]!.url.includes(SECRET));
});

test('a client pointed at any other host is refused, so the cookie cannot be sent elsewhere', () => {
  const limiter = newGggLimiter(() => 0, async () => {});
  assert.throws(() => new HttpGgg({ cookie: () => SECRET, userAgent: 'x', limiter, baseUrl: 'https://evil.example.com' }));
});

test('403 on the stash means the cookie expired; 403 on characters means the profile is private', async () => {
  const { ggg } = makeClient(() => new Response('Forbidden', { status: 403 }));
  await assert.rejects(ggg.stashTab('Kaelen', 'Allflame', 0, true), (e: unknown) => e instanceof GggError && e.kind === 'expired');
  await assert.rejects(ggg.characters('Kaelen'), (e: unknown) => e instanceof GggError && e.kind === 'private');
});

test('429 backs the policy off for Retry-After and the error says how long', async () => {
  const { ggg, limiter, clock: c } = makeClient(() => new Response('', { status: 429, headers: { 'retry-after': '75' } }));
  await assert.rejects(ggg.stashTab('Kaelen', 'Allflame', 0, true), (e: unknown) => e instanceof GggError && e.kind === 'rate-limited' && e.retryAfterSec === 75);
  assert.equal(limiter.resumesAt('stash'), c.now() + 75_000);
  assert.equal(limiter.resumesAt('characters'), null);
  assert.equal(ggg.resumesAt('stash'), c.now() + 75_000);
});

test('limits are learned from the response headers', async () => {
  const { ggg, limiter } = makeClient(() => json({ numTabs: 0, items: [] }, { headers: { 'x-rate-limit-rules': 'Ip', 'x-rate-limit-ip': '5:10:60', 'x-rate-limit-ip-state': '1:10:0' } }));
  await ggg.stashTab('Kaelen', 'Allflame', 0, true);
  assert.deepEqual(limiter.limitsFor('stash'), [{ max: 5, period: 10, restrict: 60 }]);
});

test('errors and thrown messages never contain the cookie', async () => {
  const { ggg } = makeClient(() => {
    throw new Error(`socket hang up for POESESSID=${SECRET}`);
  });
  try {
    await ggg.stashTab('Kaelen', 'Allflame', 0, true);
    assert.fail('should have thrown');
  } catch (e) {
    assert.ok(e instanceof GggError);
    assert.ok(!String((e as Error).message).includes(SECRET));
    assert.equal(e.kind, 'down');
    assert.match(e.message, /offline/);
  }
});

test('a missing cookie is an expired state and sends nothing', async () => {
  const c = clock();
  let sent = 0;
  const ggg = new HttpGgg({ cookie: () => null, userAgent: 'x', limiter: newGggLimiter(c.now, c.sleep), fetchFn: (async () => void sent++) as unknown as typeof fetch });
  await assert.rejects(ggg.stashTab('Kaelen', 'Allflame', 0, true), (e: unknown) => e instanceof GggError && e.kind === 'expired');
  assert.equal(sent, 0);
});

test('account names: the discriminator is escaped and junk is rejected', () => {
  assert.equal(encodeAccount('Kaelen#4821'), 'Kaelen%234821');
  assert.equal(validAccountName('Kaelen#4821'), true);
  assert.equal(validAccountName('Kaelen'), true);
  assert.equal(validAccountName('a b'), false);
  assert.equal(validAccountName('Kaelen#48'), false);
  assert.equal(validAccountName('x'), false);
  assert.equal(validAccountName('Kaelen/../x'), false);
});

test('tabs: folders are flattened, remove-only, friend and trade tabs are off by default, unreadable ones say why', () => {
  const tabs: RawTab[] = [
    { n: 'Currency', i: 0, id: 'a', type: 'CurrencyStash' },
    { n: 'Trade 1', i: 1, id: 'b', type: 'NormalStash' },
    { n: 'folder', i: 2, id: 'c', type: 'Folder', children: [{ n: 'Dump 1', i: 3, id: 'd', type: 'PremiumStash' }, { n: 'Remove-only', i: 4, id: 'e', type: 'RemoveOnlyStash' }] },
    { n: 'Maps', i: 5, id: 'f', type: 'MapStash' },
    { n: 'Heist locker', i: 6, id: 'g', type: 'HeistLocker' },
  ];
  const flat = flattenTabs(tabs);
  assert.deepEqual(flat.map((t) => t.n), ['Currency', 'Trade 1', 'Dump 1', 'Remove-only', 'Maps', 'Heist locker']);
  assert.deepEqual(flat.map(defaultCounted), [true, false, true, false, false, false]);
  assert.equal(unreadableReason(flat[4]!), 'paused by GGG');
  assert.equal(unreadableReason(flat[5]!), 'not in the API');
  assert.equal(unreadableReason(flat[0]!), undefined);
});
