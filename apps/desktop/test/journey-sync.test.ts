import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CharSync, JourneyBudget } from '../src/main/journey/charSync.js';
import { LiveTracker } from '../src/main/journey/live.js';
import type { LogEvent } from '../src/shared/journey/logEvent.js';
import type { CharacterLink } from '../src/shared/journey/types.js';
import { GggError } from '../src/main/wealth/ggg.js';
import { RateLimiter, GGG_DEFAULT_LIMITS } from '../src/main/wealth/rateLimiter.js';
import { synthBuild, synthKb } from './journeyHelpers.js';

const LINK: CharacterLink = { buildKey: 'b1', realm: 'pc', account: 'Kaelen#4821', character: 'Ayrton', autoLink: true };
const T0 = Date.parse('2026-10-10T18:00:00');
const ITEMS = JSON.stringify({ character: { name: 'Ayrton', class: 'Ranger', level: 13, league: 'Mirage' }, items: [] });
const PASSIVES = JSON.stringify({ hashes: [] });

/** A fake pathofexile.com that enforces the real 15:60:120, 90:1800:600, 180:7200:3600 rules for every caller together. */
class FakeGgg {
  hits: { at: number; who: 'journey' | 'wealth' }[] = [];
  r429 = 0;
  bannedUntil = 0;
  constructor(private readonly now: () => number) {}
  hit(who: 'journey' | 'wealth'): void {
    const t = this.now();
    if (t < this.bannedUntil) {
      this.r429++;
      throw new GggError('rate-limited', 'banned', 60);
    }
    this.hits.push({ at: t, who });
    for (const [max, period, ban] of [[15, 60, 120], [90, 1800, 600], [180, 7200, 3600]] as const) {
      const n = this.hits.filter((h) => h.at > t - period * 1000).length;
      if (n > max) {
        this.bannedUntil = t + ban * 1000;
        this.r429++;
        throw new GggError('rate-limited', 'too many', ban);
      }
    }
  }
  count(who: 'journey' | 'wealth', windowSec: number, end: number): number {
    return this.hits.filter((h) => h.who === who && h.at > end - windowSec * 1000 && h.at <= end).length;
  }
}

test('2 simulated hours of play: 0 responses with 429, Journey inside half of every window, no trigger waits in the limiter queue', async () => {
  const clock = { t: T0 };
  const now = () => clock.t;
  const limiter = new RateLimiter({ now, sleep: async (ms) => void (clock.t += ms), minGapMs: 2000, margin: 2, defaults: GGG_DEFAULT_LIMITS });
  const server = new FakeGgg(now);
  const waits: number[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'jrn-sim-'));
  const journeyWin = async (path: string): Promise<string> => {
    waits.push(limiter.waitTime('characters'));
    await limiter.acquire('characters');
    server.hit('journey');
    limiter.update('characters', new Headers());
    return path.endsWith('get-items') ? ITEMS : PASSIVES;
  };
  const sync = new CharSync({ win: journeyWin, hasCookie: () => true, budget: new JourneyBudget(limiter, now), now, cacheDir: dir });
  const outcomes: Record<string, number> = {};
  const orig = sync.sync.bind(sync);
  sync.sync = async (l, r) => {
    const o = await orig(l, r);
    outcomes[o.kind + (o.kind === 'skipped' ? ':' + o.why : '')] = (outcomes[o.kind + (o.kind === 'skipped' ? ':' + o.why : '')] ?? 0) + 1;
    return o;
  };
  const live = new LiveTracker({
    now,
    later: () => () => undefined,
    kb: () => synthKb(),
    loadBuild: async () => synthBuild(),
    ticks: { get: () => [], tick: () => [] },
    decisions: { get: () => ({ kept: [], refund: [] }), set: () => undefined },
    sync,
    jev: null,
    push: () => undefined,
    clientLog: () => ({ found: true, path: 'fake' }),
  });
  try {
    await live.setBuild(synthBuild());
    await live.setLink(LINK);
    const feed = (e: Omit<LogEvent, 'at'> & Record<string, unknown>): void => live.onEvent({ ...e, at: clock.t } as LogEvent);
    feed({ t: 'level', char: LINK.character, cls: 'Ranger', level: 13 });
    const settle = async (): Promise<void> => {
      for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
    };
    const steps = 240; // 2 h in 30 s steps
    let towns = 0;
    for (let i = 1; i <= steps; i++) {
      clock.t = Math.max(clock.t, T0 + i * 30_000);
      if (i % 8 === 0) {
        towns++;
        feed({ t: 'area', id: '1_1_town', level: 13 });
        feed({ t: 'zone', name: "Lioneye's Watch" });
      } else {
        feed({ t: 'area', id: '1_1_2', level: 2 });
        feed({ t: 'zone', name: 'The Coast' });
      }
      if (i % 20 === 0) {
        // Wealth reads the character list every 10 minutes: 3 hits through the same limiter
        for (let k = 0; k < 3; k++) {
          await limiter.acquire('characters');
          server.hit('wealth');
        }
      }
      if (i % 40 === 0) await live.runSync('manual'); // the player presses Sync now now and then
      await settle();
    }
    const end = clock.t;
    console.log('outcomes', JSON.stringify(outcomes), 'journey hits total', server.hits.filter((h) => h.who === 'journey').length);
    const j2h = server.count('journey', 7200, end);
    let max30 = 0;
    for (let t = T0; t <= end; t += 30_000) max30 = Math.max(max30, server.count('journey', 1800, t));
    let max60 = 0;
    for (let t = T0; t <= end; t += 30_000) max60 = Math.max(max60, server.count('journey', 60, t));
    const maxWait = Math.max(0, ...waits);
    console.log(`towns ${towns}; 429s ${server.r429}; Journey hits in 2 h ${j2h} (limit 90); worst 30 min ${max30} (limit 45); worst 60 s ${max60} (limit 7); Wealth hits ${server.hits.filter((h) => h.who === 'wealth').length}; longest queue wait before a Journey hit ${maxWait} ms`);
    assert.equal(server.r429, 0);
    assert.ok(j2h <= 90, `2 h ${j2h}`);
    assert.ok(max30 <= 45, `30 min ${max30}`);
    assert.ok(max60 <= 7, `60 s ${max60}`);
    assert.ok(maxWait <= 2000, `a Journey hit waited ${maxWait} ms in the limiter queue`);
    assert.ok(j2h >= 20, 'it does sync on towns');
    // zone changes alone never sync: far fewer syncs than zone changes
    assert.ok(server.count('journey', 7200, end) / 2 < steps / 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('when the budget is full a trigger is skipped, not queued, and Sync now reports when it frees up', async () => {
  const clock = { t: T0 };
  const now = () => clock.t;
  const limiter = new RateLimiter({ now, sleep: async (ms) => void (clock.t += ms), minGapMs: 2000, margin: 2, defaults: GGG_DEFAULT_LIMITS });
  const budget = new JourneyBudget(limiter, now);
  let reqs = 0;
  const sync = new CharSync({
    win: async (path) => {
      reqs++;
      await limiter.acquire('characters');
      return path.endsWith('get-items') ? ITEMS : PASSIVES;
    },
    hasCookie: () => true,
    budget,
    now,
  });
  // 3 syncs fit in a 60 s window (6 hits is under half of 15 = 7); the 4th does not
  const outs = [];
  for (let i = 0; i < 4; i++) {
    outs.push(await sync.sync(LINK, 'manual'));
    clock.t += 5000;
  }
  assert.deepEqual(outs.map((o) => o.kind), ['synced', 'synced', 'synced', 'skipped']);
  const skipped = outs[3]!;
  assert.ok(skipped.kind === 'skipped' && skipped.nextAt !== null && skipped.nextAt > clock.t);
  assert.equal(reqs, 6);
  const next = sync.nextAllowedAt();
  assert.ok(next !== null && next > clock.t, 'the countdown is positive');
  clock.t = next! + 1;
  assert.equal((await sync.sync(LINK, 'manual')).kind, 'synced');
});

test('errors: 429 backs off from 3 min and doubles to 30; an expired session and a private profile drop to log-only', async () => {
  const clock = { t: T0 };
  const now = () => clock.t;
  const limiter = new RateLimiter({ now, sleep: async () => undefined, defaults: GGG_DEFAULT_LIMITS });
  let mode: 'limit' | 'down' | 'expired' | 'private' | 'ok' = 'limit';
  const sync = new CharSync({
    win: async (path) => {
      if (mode === 'limit') throw new GggError('rate-limited', 'slow down', 60);
      if (mode === 'down') throw new GggError('down', 'five hundred');
      if (mode === 'expired') throw new GggError('expired', 'login');
      if (mode === 'private') throw new GggError('private', 'private');
      return path.endsWith('get-items') ? ITEMS : PASSIVES;
    },
    hasCookie: () => true,
    budget: new JourneyBudget(limiter, now),
    now,
  });
  const waits: number[] = [];
  for (let i = 0; i < 6; i++) {
    const o = await sync.sync(LINK, 'manual');
    assert.equal(o.kind, 'failed');
    if (o.kind === 'failed') waits.push(Math.round((o.nextAt - clock.t) / 60_000));
    clock.t += (waits.at(-1)! * 60_000) + 1000;
    limiter.update('characters', new Headers());
  }
  console.log('back-off minutes after each failure:', waits.join(', '));
  assert.deepEqual(waits, [3, 6, 12, 24, 30, 30]);
  mode = 'expired';
  const e = await sync.sync(LINK, 'manual');
  assert.ok(e.kind === 'log-only' && /expired/.test(e.why));
  mode = 'ok';
  assert.equal((await sync.sync(LINK, 'manual')).kind, 'log-only', 'stays log-only until the player reconnects');
  sync.clearDead();
  clock.t += 60 * 60_000;
  assert.equal((await sync.sync(LINK, 'manual')).kind, 'synced');
  mode = 'private';
  clock.t += 60 * 60_000;
  const p = await sync.sync(LINK, 'manual');
  assert.ok(p.kind === 'log-only' && /private/.test(p.why));
});
