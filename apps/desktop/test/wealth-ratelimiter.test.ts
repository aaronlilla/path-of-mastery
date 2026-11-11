import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLimits, parseState, RateLimiter, GGG_DEFAULT_LIMITS } from '../src/main/wealth/rateLimiter.js';

function clock() {
  let t = 1_000_000;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

const headers = (o: Record<string, string>) => ({ get: (n: string) => o[n.toLowerCase()] ?? null });

test('limits and state headers are parsed', () => {
  assert.deepEqual(parseLimits('30:60:120,90:1800:600'), [
    { max: 30, period: 60, restrict: 120 },
    { max: 90, period: 1800, restrict: 600 },
  ]);
  assert.deepEqual(parseState('3:60:0,3:1800:45'), [
    { hits: 3, period: 60, restricted: 0 },
    { hits: 3, period: 1800, restricted: 45 },
  ]);
  assert.deepEqual(parseLimits(null), []);
  assert.deepEqual(parseLimits('garbage'), []);
});

test('two requests are never closer than the minimum gap', async () => {
  const c = clock();
  const rl = new RateLimiter({ now: c.now, sleep: c.sleep, minGapMs: 2000, margin: 0, defaults: { stash: [{ max: 100, period: 60, restrict: 60 }] } });
  const t0 = c.now();
  await rl.acquire('stash');
  assert.equal(c.now() - t0, 0, 'the first request goes at once');
  await rl.acquire('stash');
  assert.equal(c.now() - t0, 2000);
  await rl.acquire('stash');
  assert.equal(c.now() - t0, 4000);
});

test('a full window waits until the oldest request leaves it', async () => {
  const c = clock();
  const rl = new RateLimiter({ now: c.now, sleep: c.sleep, minGapMs: 0, margin: 0, defaults: { stash: [{ max: 3, period: 10, restrict: 30 }] } });
  const t0 = c.now();
  await rl.acquire('stash');
  await rl.acquire('stash');
  await rl.acquire('stash');
  assert.equal(c.now() - t0, 0, 'three fit in the window');
  await rl.acquire('stash');
  assert.equal(c.now() - t0, 10_000, 'the fourth waits for the first to age out');
});

test('the safety margin keeps hits unused under the window', async () => {
  const c = clock();
  const rl = new RateLimiter({ now: c.now, sleep: c.sleep, minGapMs: 0, margin: 1, defaults: { stash: [{ max: 3, period: 10, restrict: 30 }] } });
  const t0 = c.now();
  await rl.acquire('stash');
  await rl.acquire('stash');
  assert.equal(c.now() - t0, 0, 'two of three are used');
  await rl.acquire('stash');
  assert.equal(c.now() - t0, 10_000, 'the third would leave no margin, so it waits');
});

test('the longer windows bind too', async () => {
  const c = clock();
  const rl = new RateLimiter({
    now: c.now,
    sleep: c.sleep,
    minGapMs: 0,
    margin: 0,
    defaults: {
      stash: [
        { max: 10, period: 60, restrict: 120 },
        { max: 12, period: 1800, restrict: 600 },
      ],
    },
  });
  const t0 = c.now();
  for (let i = 0; i < 10; i++) await rl.acquire('stash');
  assert.equal(c.now() - t0, 0);
  for (let i = 0; i < 2; i++) await rl.acquire('stash'); // 11th and 12th wait for the first minute
  assert.equal(c.now() - t0, 60_000);
  await rl.acquire('stash'); // the 13th would break 12:1800, so it waits for the first request to leave 30 minutes
  assert.equal(c.now() - t0, 1_800_000);
});

test('limits from response headers replace the defaults', async () => {
  const c = clock();
  const rl = new RateLimiter({ now: c.now, sleep: c.sleep, minGapMs: 0, margin: 0, defaults: GGG_DEFAULT_LIMITS });
  rl.update('stash', headers({ 'x-rate-limit-rules': 'Ip', 'x-rate-limit-ip': '2:5:20', 'x-rate-limit-ip-state': '1:5:0' }));
  assert.deepEqual(rl.limitsFor('stash'), [{ max: 2, period: 5, restrict: 20 }]);
  const t0 = c.now();
  await rl.acquire('stash'); // the server already counted one hit in this window, we add ours: 2 of 2
  assert.equal(c.now() - t0, 0);
  await rl.acquire('stash');
  assert.equal(c.now() - t0, 5000, 'the third waits for the window the server reported');
});

test('a restriction reported by the server blocks until it ends', async () => {
  const c = clock();
  const rl = new RateLimiter({ now: c.now, sleep: c.sleep, minGapMs: 0, margin: 0, defaults: GGG_DEFAULT_LIMITS });
  rl.update('stash', headers({ 'x-rate-limit-rules': 'Ip', 'x-rate-limit-ip': '30:60:120', 'x-rate-limit-ip-state': '31:60:45' }));
  assert.equal(rl.waitTime('stash'), 45_000);
});

test('a 429 backs the policy off for Retry-After seconds and other policies are untouched', async () => {
  const c = clock();
  const rl = new RateLimiter({ now: c.now, sleep: c.sleep, minGapMs: 0, margin: 0, defaults: GGG_DEFAULT_LIMITS });
  rl.penalize('stash', 90);
  assert.equal(rl.waitTime('stash'), 90_000);
  assert.equal(rl.waitTime('characters'), 0);
  assert.equal(rl.resumesAt('stash'), c.now() + 90_000);
  c.advance(60_000);
  assert.equal(rl.waitTime('stash'), 30_000);
  const t0 = c.now();
  await rl.acquire('stash');
  assert.equal(c.now() - t0, 30_000);
  assert.equal(rl.resumesAt('stash'), null);
});

test('the defaults match the live limits', () => {
  assert.deepEqual(GGG_DEFAULT_LIMITS.stash?.map((l) => `${l.max}:${l.period}:${l.restrict}`), ['30:60:120', '90:1800:600', '180:7200:3600']);
  assert.deepEqual(GGG_DEFAULT_LIMITS.characters?.map((l) => `${l.max}:${l.period}:${l.restrict}`), ['15:60:120', '90:1800:600', '180:7200:3600']);
});
