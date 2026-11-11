import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SolveGoal } from '@pom/protocol';
import type { JevDecide, JevQuestion } from '../src/main/assistant/jev.js';
import { MOD_FAMILIES, shortlist, uniquesAllowed } from '../src/main/assistant/shortlist.js';
import { SolveManager } from '../src/main/assistant/solve.js';
import type { AssistantEngine } from '../src/main/assistant/tools.js';

const gem = (name: string, support: boolean, extra: Record<string, unknown> = {}) => ({ id: name.replace(/ /g, ''), name, support, legacy: false, vaal: false, exceptional: false, tags: support ? ['support', 'attack'] : ['attack', 'melee'], levelReq: [1], ...extra });
const GEMS = [gem('Boneshatter', false), gem('Pulverise', true), gem('Arcane Surge', true), gem('Ruthless', true), gem('Empower', true, { exceptional: true }), gem('Old Thing', true, { legacy: true })];
const UNIQUES = [
  { name: 'Kaom\'s Heart', base: 'Glorious Plate', level: 68, text: "Kaom's Heart\nGlorious Plate\nRequires Level 68\nHas no Sockets\n+500 to maximum Life" },
  { name: 'Tabula Rasa', base: 'Simple Robe', level: 1, text: 'Tabula Rasa\nSimple Robe\nHas 6 White Sockets' },
  { name: 'Mageblood', base: 'Heavy Belt', level: 99, text: 'Mageblood\nHeavy Belt\nMagic Utility Flasks are always active' },
];

function engine(log: string[] = []): AssistantEngine {
  return {
    async send(cmd: string, params: unknown) {
      log.push(cmd);
      if (cmd === 'gemCatalog') return { gems: GEMS };
      if (cmd === 'itemCatalog') return { catalog: { uniques: UNIQUES, rares: [] } };
      if (cmd === 'solveStart') {
        log.push(JSON.stringify((params as { goal: unknown }).goal));
        return { solveId: 's1' };
      }
      if (cmd === 'solveStep') return { active: true, done: false, layer: 'gems', evaluations: 0, elapsedMs: 0, results: [] };
      throw new Error(cmd);
    },
  } as unknown as AssistantEngine;
}

/** Jev as a fake: yes for Pulverise, Kaom's Heart and Physical Damage, no for the rest; records what it was asked. */
function fakeJev(asked: Array<Record<string, JevQuestion>> = []): JevDecide {
  return async (_state, qs) => {
    asked.push(qs);
    return Object.fromEntries(Object.entries(qs).map(([k, q]) => [k, { noul: /Pulverise|Kaom|"Physical Damage"/.test(q.instructions) ? 0.9 : 0.2 }]));
  };
}

const GOAL: SolveGoal = { skill: 'Boneshatter', level: 90, targets: [{ name: 'DPS', metric: 'combined' }], wealth: 'mirror', assume: { playMode: 'mapping' } };

test('the shortlist asks one yes/no question per candidate and returns the probabilities', async () => {
  const asked: Array<Record<string, JevQuestion>> = [];
  const p = await shortlist(GOAL, { engine: engine(), decide: fakeJev(asked) });
  assert.ok(p);
  // supports: usable ones only (no exceptional, no legacy, not the skill); uniques up to the level; every mod family
  assert.deepEqual(p.supports, { Pulverise: 0.9, 'Arcane Surge': 0.2, Ruthless: 0.2 });
  assert.deepEqual(p.uniques, { "Kaom's Heart": 0.9, 'Tabula Rasa': 0.2 });
  assert.equal(Object.keys(p.modGroups ?? {}).length, MOD_FAMILIES.length);
  assert.equal(p.modGroups?.['Physical Damage'], 0.9);
  const qs = asked.flatMap((q) => Object.values(q));
  assert.ok(qs.every((q) => q.type === 'noul'));
  assert.match(qs.find((q) => q.instructions.includes("Kaom's Heart"))!.instructions, /\+500 to maximum Life/);
});

test('no uniques asked when the item rules leave them out', async () => {
  const goal: SolveGoal = { ...GOAL, items: { rarities: ['rare'] } };
  assert.equal(uniquesAllowed(goal), false);
  assert.equal(uniquesAllowed({ ...goal, items: { rarities: ['rare'], mustUse: ['Mageblood'] } }), true);
  const log: string[] = [];
  const p = await shortlist(goal, { engine: engine(log), decide: fakeJev() });
  assert.equal(p?.uniques, undefined);
  assert.ok(!log.includes('itemCatalog'));
});

test('no key, an error or a slow Jev: no shortlist', async () => {
  assert.equal(await shortlist(GOAL, { engine: engine(), decide: async () => null }), null);
  assert.equal(await shortlist(GOAL, { engine: engine(), decide: async () => Promise.reject(new Error('down')) }), null);
  const t = Date.now();
  assert.equal(await shortlist(GOAL, { engine: engine(), decide: () => new Promise(() => undefined), timeoutMs: 50 }), null);
  assert.ok(Date.now() - t < 1000);
});

function manager(log: string[], withShortlist: boolean) {
  const eng = engine(log);
  return new SolveManager({
    engine: eng,
    open: () => ({ buildId: 'b1', buildKey: 'k1', name: 'Test' }),
    proposals: {} as never,
    tree: {} as never,
    push: () => undefined,
    pollMs: 60_000,
    ...(withShortlist ? { shortlist: (g: SolveGoal) => shortlist(g, { engine: eng, decide: fakeJev() }) } : {}),
  });
}

test('the solve carries the priority with Jev, and the goal unchanged without it', async () => {
  const log: string[] = [];
  const m = manager(log, true);
  await m.run(GOAL);
  await m.stop();
  const sent = JSON.parse(log[log.indexOf('solveStart') + 1]!) as SolveGoal;
  assert.equal(sent.priority?.supports?.Pulverise, 0.9);
  assert.equal(m.state.goal?.priority, undefined, 'the form keeps the player goal');

  const plain: string[] = [];
  const n = manager(plain, false);
  await n.run(GOAL);
  await n.stop();
  assert.deepEqual(JSON.parse(plain[plain.indexOf('solveStart') + 1]!), GOAL);
  assert.ok(!plain.includes('gemCatalog'));
});

test('the panel shows shortlisting while Jev orders the candidates, then running', async () => {
  const seen: string[] = [];
  const eng = engine([]);
  const m = new SolveManager({
    engine: eng,
    open: () => ({ buildId: 'b1', buildKey: 'k1', name: 'Test' }),
    proposals: {} as never,
    tree: {} as never,
    push: (s) => void seen.push(s.status),
    pollMs: 60_000,
    shortlist: (g: SolveGoal) => shortlist(g, { engine: eng, decide: fakeJev() }),
  });
  await m.run(GOAL);
  await m.stop();
  assert.deepEqual(seen.slice(0, 2), ['shortlisting', 'running']);
});

test('a panel edit after a finished solve keeps the results', async () => {
  const m = manager([], false);
  await m.run(GOAL);
  await m.stop();
  const before = m.state;
  assert.ok(before.snapshot, 'the stopped solve has a snapshot');
  await m.setGoal({ ...GOAL, wealth: 'rich' }, {}, 'panel');
  assert.equal(m.state.goal?.wealth, 'rich');
  assert.equal(m.state.status, before.status);
  assert.equal(m.state.snapshot, before.snapshot);
});

test('a solve needs a wealth tier, and carries the live unique prices', async () => {
  const log: string[] = [];
  const m = new SolveManager({ engine: engine(log), open: () => ({ buildId: 'b1', buildKey: 'k1', name: 'Test' }), proposals: {} as never, tree: {} as never, push: () => undefined, pollMs: 60_000, uniquePrices: async () => ({ Goldrim: 0.01 }) });
  const { wealth: _, ...noWealth } = GOAL;
  await assert.rejects(m.run(noWealth), /Pick how rich you are/);
  assert.ok(!log.includes('solveStart'), 'nothing ran without a tier');
  await m.run(GOAL);
  await m.stop();
  const sent = JSON.parse(log[log.indexOf('solveStart') + 1]!) as SolveGoal;
  assert.equal(sent.wealth, 'mirror');
  assert.deepEqual(sent.uniquePrices, { Goldrim: 0.01 });
});
