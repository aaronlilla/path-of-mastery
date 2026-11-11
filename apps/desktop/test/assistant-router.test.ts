import { fixture } from '../src/main/aiGate/fixtures.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { routeMessage, type RouterDeps } from '../src/main/assistant/router.js';
import type { JevDecide } from '../src/main/assistant/jev.js';
import { AssistantService } from '../src/main/assistant/service.js';
import type { AssistantEngine } from '../src/main/assistant/tools.js';
import type { AssistantPush } from '../src/shared/assistant/types.js';

const pick = (choice: string, confidence = 0.95): JevDecide => async () => ({ route: { choice, confidence } });

function deps(decide: JevDecide, calls: string[] = []): RouterDeps {
  return {
    decide,
    openSolve: () => void calls.push('openSolve'),
    lookup: async (tool, args) => {
      calls.push(tool);
      if (tool === 'getStats') return { stats: [{ id: 'Life', label: 'Life', shown: '5,120' }, { id: 'ChaosResist', label: 'Chaos resistance', shown: '-60%' }] };
      if (tool === 'getPointBudget') return { passive: { used: 90, available: 122, left: 32 }, ascendancy: { used: 8, available: 8, left: 0 } };
      if (tool === 'getConfigOptions') return { options: [{ label: 'Is the enemy shocked?', section: 'Effects', value: false }] };
      if (tool === 'searchGems') return { gems: [{ name: 'Fireball', support: false, colour: 'red', tags: ['spell', 'fire'], requires: { levelAtGemLevel1: 1 } }] };
      if (tool === 'searchUniques') return { uniques: [{ name: 'Tabula Rasa', base: 'Simple Robe', matching: ['Has 6 White Sockets'] }] };
      throw new Error(tool);
    },
  };
}

test('a stat lookup is answered from getStats', async () => {
  const calls: string[] = [];
  const r = await routeMessage('what is my chaos resistance?', deps(pick('stat'), calls));
  assert.equal(r?.text, 'Chaos resistance: -60%');
  assert.deepEqual(calls, ['getStats']);
});

test('point budget, setting, gem and unique lookups are answered from the read tools', async () => {
  assert.match((await routeMessage('how many passive points do I have left?', deps(pick('budget'))))!.text, /32 left/);
  assert.match((await routeMessage('where is the shocked setting', deps(pick('setting'))))!.text, /Configuration tab, Effects section/);
  assert.match((await routeMessage('what is fireball', deps(pick('gem'))))!.text, /Fireball: skill gem, red/);
  assert.match((await routeMessage('which unique has white sockets', deps(pick('unique'))))!.text, /Tabula Rasa/);
});

test('navigation opens the tab, and the solve request opens the Solve form', async () => {
  assert.deepEqual(await routeMessage('open the tree', deps(pick('go-tree'))), { text: 'Opened the tree tab.', nav: 'tree' });
  const calls: string[] = [];
  const r = await routeMessage('I want to solve a build', deps(pick('go-solve'), calls));
  assert.equal(r?.openSolve, true);
  assert.deepEqual(calls, ['openSolve']);
});

test('reasoning, low confidence, no answer, an error, or a lookup with no result all go to Claude', async () => {
  assert.equal(await routeMessage('why is my build weak?', deps(pick('claude'))), null);
  assert.equal(await routeMessage('what is my life', deps(pick('stat', 0.79))), null);
  assert.equal(await routeMessage('what is my life', deps(async () => null)), null);
  assert.equal(await routeMessage('what is my life', deps(async () => { throw new Error('network'); })), null);
  assert.equal(await routeMessage('what is zzz', { ...deps(pick('stat')), lookup: async () => ({ stats: [] }) }), null);
  assert.equal(await routeMessage('what is my life', { ...deps(pick('stat')), lookup: async () => { throw new Error('engine'); } }), null);
});

async function run(decide: JevDecide, prefs: { jevRouter?: boolean }, req: { text: string; skipRouter?: boolean }) {
  const dir = await mkdtemp(join(tmpdir(), 'pom-router-'));
  const svc = new AssistantService({ ...fixture().deps, engine: {} as AssistantEngine, dataDir: dir, version: 'test', bridgePath: 'x', jevDecide: decide, env: { ...process.env } });
  const events: AssistantPush[] = [];
  const toClaude: string[] = [];
  (svc as unknown as { startClaude: (r: { text: string }) => void }).startClaude = (r) => void toClaude.push(r.text);
  svc.onPush((p) => events.push(p));
  svc.setContext({ buildKey: 'k', buildId: 'b', name: 'n' });
  await svc.start();
  try {
    await svc.setPrefs(prefs);
    svc.send({ provider: 'claude', buildKey: 'k', ...req });
    for (let i = 0; i < 50 && !toClaude.length && !events.some((e) => e.kind === 'turn' && e.event.type === 'done'); i++) await new Promise((r) => setTimeout(r, 20));
    const done = events.flatMap((e) => (e.kind === 'turn' && e.event.type === 'done' ? [e.event] : []));
    return { done, toClaude, busy: svc.busy };
  } finally {
    await svc.stop();
    await rm(dir, { recursive: true, force: true });
  }
}

test('service: the router is on when the player never set it', async () => {
  const r = await run(pick('go-calcs'), {}, { text: 'show calcs' });
  assert.equal(r.done[0]?.instant, true);
  assert.deepEqual(r.toClaude, []);
});

test('service: an instant route answers with the instant mark and never starts Claude', async () => {
  const r = await run(pick('go-calcs'), { jevRouter: true }, { text: 'show calcs' });
  assert.equal(r.done[0]?.instant, true);
  assert.equal(r.done[0]?.nav, 'calcs');
  assert.deepEqual(r.toClaude, []);
  assert.equal(r.busy, false);
});

test('service: Claude route, low confidence, error, switch off, and Ask Claude instead all reach Claude', async () => {
  for (const [decide, prefs, req] of [
    [pick('claude'), { jevRouter: true }, { text: 'a' }],
    [pick('go-tree', 0.5), { jevRouter: true }, { text: 'b' }],
    [async () => { throw new Error('x'); }, { jevRouter: true }, { text: 'c' }],
    [pick('go-tree'), { jevRouter: false }, { text: 'd' }],
    [pick('go-tree'), { jevRouter: true }, { text: 'e', skipRouter: true }],
  ] as const) {
    const r = await run(decide, prefs, req);
    assert.deepEqual(r.toClaude, [req.text]);
    assert.equal(r.done.length, 0);
  }
});

test('a minion question is never answered from the player sheet', async () => {
  let looked = false; // the guard is on the stat answer only: tab jumps and gem lookups with a minion word still work
  const deps = { decide: async () => ({ route: { choice: 'stat', confidence: 1 } }) as never, lookup: async () => { looked = true; return {}; }, openSolve: () => {} } as unknown as RouterDeps;
  assert.equal(await routeMessage('what is my minion life and dps?', deps), null);
  assert.equal(looked, false);
});

test('a pasted code the app cannot import is reported with its reason, not left as a blob', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../src/main/assistant/service.ts', import.meta.url), 'utf8');
  assert.match(src, /could not import: \$\{why\}/);
});

test('a build request that already carries its goal is not answered with "Opened the Solve panel"', async () => {
  const decide = async () => ({ route: { choice: 'go-solve', confidence: 1 } }) as never;
  let opened = false;
  const deps = { decide, lookup: async () => ({}), openSolve: () => { opened = true; } } as unknown as RouterDeps;
  assert.equal(await routeMessage('Make me a level 90 Poisonous Concoction build with 1M DPS and 50k EHP, rares only.', deps), null);
  assert.equal(opened, false);
  const r = await routeMessage('open the solver', deps);
  assert.equal(opened, true);
  assert.match(r?.text ?? '', /Opened the Solve panel/);
});

test('Jev gets a 250 ms race: a slow decide falls through to the normal path, a fast one still routes', async () => {
  const slow: JevDecide = () => new Promise((r) => setTimeout(() => r({ route: { choice: 'go-tree', confidence: 1 } }), 1000));
  const t0 = Date.now();
  assert.equal(await routeMessage('open the tree', deps(slow)), null);
  assert.ok(Date.now() - t0 < 300, `took ${Date.now() - t0} ms`);
  assert.deepEqual(await routeMessage('open the tree', deps(pick('go-tree'))), { text: 'Opened the tree tab.', nav: 'tree' });
});
