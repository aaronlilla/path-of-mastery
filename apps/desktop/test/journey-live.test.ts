import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CharSync, JourneyBudget } from '../src/main/journey/charSync.js';
import { LiveTracker, type LiveBuild, type LiveCheckpoint, type LiveKbView } from '../src/main/journey/live.js';
import type { LiveStateX } from '../src/shared/journey/liveExtra.js';
import type { LogEvent } from '../src/shared/journey/logEvent.js';
import type { Guide } from '../src/shared/leveling/types.js';
import type { CharacterLink } from '../src/shared/journey/types.js';
import type { DefenceNumbers } from '../src/shared/journey/townRules.js';
import { RateLimiter, GGG_DEFAULT_LIMITS } from '../src/main/wealth/rateLimiter.js';
import { GUIDE, synthBuild, synthKb } from './journeyHelpers.js';

const LINK: CharacterLink = { buildKey: 'b1', realm: 'pc', account: 'Kaelen#4821', character: 'Ayrton', autoLink: true };
const T0 = Date.parse('2026-10-10T18:00:00');

const ITEMS = JSON.stringify({ character: { name: 'Ayrton', class: 'Ranger', level: 13, league: 'Mirage' }, items: [] });
const PASSIVES = JSON.stringify({ hashes: [] });

interface Rig {
  live: LiveTracker;
  now: { t: number };
  requests: string[];
  ticks: Map<string, Set<string>>;
  pushes: LiveStateX[];
  settle(): Promise<void>;
}

function rig(o: { aiAccess?: boolean; build?: LiveBuild; kb?: LiveKbView; cookie?: boolean; jev?: (s: string, q: string) => Promise<number | null>; numbers?: () => Promise<DefenceNumbers | null> } = {}): Rig {
  const now = { t: T0 };
  const requests: string[] = [];
  const ticks = new Map<string, Set<string>>();
  const pushes: LiveStateX[] = [];
  const limiter = new RateLimiter({ now: () => now.t, sleep: async (ms) => void (now.t += ms), defaults: GGG_DEFAULT_LIMITS });
  const budget = new JourneyBudget(limiter, () => now.t);
  const cookie = o.cookie ?? true;
  const sync = new CharSync({
    win: async (path) => {
      requests.push(path);
      await limiter.acquire('characters');
      return path.endsWith('get-items') ? ITEMS : PASSIVES;
    },
    hasCookie: () => cookie,
    budget,
    now: () => now.t,
  });
  const kb = o.kb ?? synthKb();
  const decisions = new Map<string, { kept: number[]; refund: number[] }>();
  const live = new LiveTracker({
    now: () => now.t,
    later: () => () => undefined,
    kb: () => kb,
    loadBuild: async () => o.build ?? synthBuild(),
    ticks: {
      get: (k) => [...(ticks.get(k) ?? [])],
      tick: (k, ids, done) => {
        const s = ticks.get(k) ?? new Set<string>();
        ids.forEach((i) => (done ? s.add(i) : s.delete(i)));
        ticks.set(k, s);
        return [...s];
      },
    },
    decisions: { get: (k) => decisions.get(k) ?? { kept: [], refund: [] }, set: (k, v) => void decisions.set(k, v) },
    sync,
    jev: o.jev ?? null,
    hasAiAccess: () => o.aiAccess ?? true,
    push: (s) => pushes.push(s),
    clientLog: () => ({ found: true, path: 'fake' }),
    ...(o.numbers ? { numbers: o.numbers } : {}),
  });
  return { live, now, requests, ticks, pushes, settle: async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); } };
}

const at = (r: Rig, e: Omit<LogEvent, 'at'> & Record<string, unknown>): void => r.live.onEvent({ ...e, at: r.now.t } as LogEvent);

test('an allocated passive moves its node from toTake to allocated; an unplanned one lands in offPlan', async () => {
  const r = rig({ cookie: false });
  await r.live.setBuild(synthBuild());
  await r.live.setLink(LINK);
  at(r, { t: 'level', char: 'Ayrton', cls: 'Ranger', level: 1 });
  assert.deepEqual(r.live.state().treeDiff?.toTake, [10, 11, 20]);
  at(r, { t: 'passive', op: 'add', id: 'life1213', name: 'Life', atlas: false });
  const s1 = r.live.state();
  console.log('after "allocated life1213 Life": toTake', JSON.stringify(s1.treeDiff?.toTake), 'offPlan', JSON.stringify(s1.treeDiff?.offPlan));
  assert.deepEqual(s1.treeDiff?.toTake, [11, 20]);
  assert.deepEqual(s1.treeDiff?.offPlan, []);
  at(r, { t: 'passive', op: 'add', id: 'dexterity1', name: 'Dexterity', atlas: false });
  const s2 = r.live.state();
  console.log('after "allocated Dexterity": offPlan', JSON.stringify(s2.treeDiff?.offPlan));
  assert.deepEqual(s2.treeDiff?.offPlan, [30]);
  assert.deepEqual(s2.treeDiff?.toTake, [11, 20]);
  at(r, { t: 'passive', op: 'remove', id: 'dexterity1', name: 'Dexterity', atlas: false });
  assert.deepEqual(r.live.state().treeDiff?.offPlan, []);
  // Keep adds it to the plan for the player: it stops being off plan
  at(r, { t: 'passive', op: 'add', id: 'dexterity1', name: 'Dexterity', atlas: false });
  r.live.offPlan(30, 'keep');
  assert.deepEqual(r.live.state().treeDiff?.offPlan, []);
  // Atlas passives are ignored
  at(r, { t: 'passive', op: 'add', id: 'atlas_path_23_', name: 'Map Drop Chance', atlas: true });
  assert.deepEqual(r.live.state().treeDiff?.offPlan, []);
});

test('a level-up line for the linked name sets the level; another name is ignored', async () => {
  const r = rig({ cookie: false });
  await r.live.setBuild(synthBuild());
  await r.live.setLink(LINK);
  at(r, { t: 'level', char: 'Ayrton', cls: 'Ranger', level: 1 });
  at(r, { t: 'level', char: 'SomeoneElse', cls: 'Witch', level: 40 });
  assert.equal(r.live.state().char, undefined);
  await r.live.setLink(LINK); // Explicit Keep current after detecting another character.
  at(r, { t: 'level', char: 'Ayrton', cls: 'Ranger', level: 13 });
  const s = r.live.state();
  assert.equal(s.char?.level, 13);
  assert.equal(s.playing?.known, true);
});

test('historical seed and generic events do not establish character context or tick a guide', async () => {
  const r = rig({ cookie: false });
  await r.live.setBuild(synthBuild()); await r.live.setLink(LINK);
  r.live.seed([{ t: 'level', at: T0, char: 'Ayrton', cls: 'Ranger', level: 13 }]);
  assert.equal(r.live.state().playing?.known, false);
  at(r, { t: 'zone', name: 'The Coast' }); at(r, { t: 'passive', op: 'add', id: 'life1', name: 'Life', atlas: false });
  assert.deepEqual(r.live.state().ticked, []); assert.deepEqual(r.live.state().treeDiff?.toTake, [10, 11, 20]);
  at(r, { t: 'level', char: 'Ayrton', cls: 'Ranger', level: 13 });
  at(r, { t: 'zone', name: 'The Coast' }); assert.ok(r.live.state().ticked.includes('s-coast'));
  at(r, { t: 'level', char: 'SomeoneElse', cls: 'Witch', level: 40 });
  at(r, { t: 'level', char: 'Ayrton', cls: 'Ranger', level: 14 });
  assert.equal(r.live.state().playing?.known, false);
  await r.live.setLink(LINK); at(r, { t: 'level', char: 'Ayrton', cls: 'Ranger', level: 14 });
  assert.equal(r.live.state().playing?.known, true);
});

test('two deaths in one zone within 10 minutes raise a defence card; one death or two far apart do not', async () => {
  const r = rig({ cookie: false });
  await r.live.setBuild(synthBuild({ checkpoints: [{ id: 'cp1', name: 'Leveling 1', level: 12, tree: [10], detours: [], numbers: { FireResist: 40, ColdResist: 75, LightningResist: 75, ChaosResist: 0, Life: 400, LifeFloor: 500 } }] }));
  await r.live.setLink(LINK);
  at(r, { t: 'level', char: 'Ayrton', cls: 'Ranger', level: 1 });
  at(r, { t: 'area', id: '1_1_2', level: 2 });
  at(r, { t: 'zone', name: 'The Coast' });
  at(r, { t: 'death', char: 'Ayrton' });
  await r.settle();
  assert.equal(r.live.state().defence, null);
  r.now.t += 5 * 60_000;
  at(r, { t: 'death', char: 'Ayrton' });
  await r.settle();
  const d = r.live.state().defence;
  console.log('defence card:', JSON.stringify(d));
  assert.ok(d && d.deaths === 2);
  assert.ok(d.lines.some((l) => /plan, not your character/.test(l)), 'log-only numbers are labelled as the plan');
  // far apart: a fresh rig
  const r2 = rig({ cookie: false });
  await r2.live.setBuild(synthBuild());
  await r2.live.setLink(LINK);
  at(r2, { t: 'level', char: 'Ayrton', cls: 'Ranger', level: 1 });
  at(r2, { t: 'zone', name: 'The Coast' });
  at(r2, { t: 'death', char: 'Ayrton' });
  r2.now.t += 11 * 60_000;
  at(r2, { t: 'death', char: 'Ayrton' });
  await r2.settle();
  assert.equal(r2.live.state().defence, null);
});

test('no cookie: log-only, zero requests, and position, level and tree still update', async () => {
  const r = rig({ cookie: false });
  await r.live.setBuild(synthBuild());
  await r.live.setLink(LINK);
  at(r, { t: 'level', char: 'Ayrton', cls: 'Ranger', level: 1 });
  at(r, { t: 'area', id: '1_1_2', level: 2 });
  at(r, { t: 'zone', name: 'The Coast' });
  at(r, { t: 'level', char: 'Ayrton', cls: 'Ranger', level: 13 });
  at(r, { t: 'passive', op: 'add', id: 'life1', name: 'Life', atlas: false });
  await r.settle();
  await r.live.runSync('manual');
  const s = r.live.state();
  assert.equal(s.mode, 'log-only');
  assert.equal(r.requests.length, 0);
  assert.equal(s.zone?.name, 'The Coast');
  assert.equal(s.char?.level, 13);
  assert.deepEqual(s.treeDiff?.toTake, [11, 20]);
  assert.ok(s.notes.some((n) => /connect in Wealth/.test(n)));
});

// ---- town advice ----

const ACT5: Guide = {
  league: '3.29',
  class: 'Ranger',
  stages: [],
  acts: [
    {
      act: 5,
      steps: [
        { id: 'a5-town', kind: 'arrive', zone: "Overseer's Tower", zoneId: '5_2_town', areaLevel: 0, text: 'Town', notes: [] },
        { id: 'a6-town', kind: 'arrive', zone: "Lioneye's Watch (Act 6)", zoneId: '6_1_town', areaLevel: 45, text: 'Act 6', notes: [] },
      ],
    },
  ],
};
const CP: LiveCheckpoint[] = [{ id: 'cp', name: 'Act 5', level: 40, tree: [], detours: [] }];

async function enterTown(r: Rig): Promise<void> {
  at(r, { t: 'area', id: '5_2_town', level: 40 });
  at(r, { t: 'zone', name: "Overseer's Tower" });
  await r.settle();
  await r.settle();
}

test('the next zone is past the Act 5 penalty and fire is 40 after it: hard advice', async () => {
  const numbers = async (): Promise<DefenceNumbers> => ({ source: 'sync', res: { fire: 70, cold: 80, light: 80, chaos: 0 }, resCap: 75 });
  const r = rig({ build: synthBuild({ guide: ACT5, checkpoints: CP }), numbers });
  await r.live.setBuild(synthBuild({ guide: ACT5, checkpoints: CP }));
  await r.live.setLink(LINK);
  at(r, { t: 'level', char: 'Ayrton', cls: 'Ranger', level: 1 });
  await r.settle();
  await enterTown(r);
  const t = r.live.state().town;
  console.log('town advice:', JSON.stringify(t));
  assert.equal(t?.level, 'hard');
  assert.equal(t?.decidedBy, 'code');
  assert.ok(t?.reasons.some((x) => /Fire drops to 40%/.test(x.text)));
});

test('a weight-1 case: Jev p=0.7 suggests, p=0.4 shows nothing, and no Jev shows nothing at weight 1', async () => {
  const build = (): LiveBuild => synthBuild({ guide: ACT5, checkpoints: CP });
  const run = async (jev: ((s: string, q: string) => Promise<number | null>) | null) => {
    const r = rig({ build: build(), cookie: false, ...(jev ? { jev } : {}) });
    await r.live.setBuild(build());
    await r.live.setLink(LINK);
    // level 30 against an area-45 zone next: under-levelled, weight 1
    at(r, { t: 'level', char: 'Ayrton', cls: 'Ranger', level: 30 });
    await enterTown(r);
    return r.live.state().town;
  };
  const yes = await run(async () => 0.7);
  assert.equal(yes?.level, 'suggested');
  assert.equal(yes?.decidedBy, 'jev');
  assert.equal(await run(async () => 0.4), null);
  assert.equal(await run(null), null);
});

test('Jev never gets the character or tree numbers: the question state is words', async () => {
  const seen: string[] = [];
  const build = synthBuild({ guide: ACT5, checkpoints: CP });
  const r = rig({ build, cookie: false, jev: async (s) => (seen.push(s), 0.9) });
  await r.live.setBuild(build);
  await r.live.setLink(LINK);
  at(r, { t: 'level', char: 'Ayrton', cls: 'Ranger', level: 30 });
  await enterTown(r);
  assert.ok(seen.length >= 1);
  assert.ok(seen.every((s) => !/\d{3,}/.test(s)), 'no long numbers in the state: ' + seen.join(' | '));
});

test('arriving in a zone ticks its guide step and the steps before it; Undo works; the next steps follow', async () => {
  const r = rig({ cookie: false });
  await r.live.setBuild(synthBuild());
  await r.live.setLink(LINK);
  at(r, { t: 'level', char: 'Ayrton', cls: 'Ranger', level: 1 });
  at(r, { t: 'zone', name: 'The Coast' });
  const s = r.live.state();
  assert.deepEqual(s.ticked.sort(), ['s-coast', 's-town']);
  assert.equal(s.next[0]?.id, 's-mud');
  r.live.tick(['s-coast'], false);
  assert.ok(!r.live.state().ticked.includes('s-coast'));
  // the guide helper is used as the base for the other tests
  assert.equal(GUIDE.acts[0]!.steps.length, 6);
});

test('without AI access Jev is never asked and weight-1 advice stays hidden; with it Jev is asked', async () => {
  let asked = 0;
  const build = (): LiveBuild => synthBuild({ guide: ACT5, checkpoints: CP });
  for (const aiAccess of [false, true]) {
    const r = rig({ aiAccess, build: build(), cookie: false, jev: async () => (asked++, 0.9) });
    await r.live.setBuild(build());
    await r.live.setLink(LINK);
    at(r, { t: 'level', char: 'Ayrton', cls: 'Ranger', level: 30 });
    await enterTown(r);
    assert.equal(r.live.state().aiAccess, aiAccess);
    assert.equal(r.live.state().town?.level ?? null, aiAccess ? 'suggested' : null);
    assert.equal(asked, aiAccess ? 1 : 0);
  }
});
