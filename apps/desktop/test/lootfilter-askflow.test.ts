process.env.POM_FORCE_PRO = '1'; // the assistant is a Pro feature
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EngineEvent } from '@pom/protocol';
import type { AssistantPush, TurnEvent } from '../src/shared/assistant/types.js';
import type { LfProposal } from '../src/shared/lootfilter/ipcTypes.js';
import { AssistantService } from '../src/main/assistant/service.js';
import type { AiAccess } from '../src/main/aiGate/gate.js';
import type { AssistantEngine } from '../src/main/assistant/tools.js';
import { NeverSinkStore } from '../src/main/lootfilter/neversink.js';
import { LootFilterStore } from '../src/main/lootfilter/store.js';
import { NEVERSINK_DIR } from './lootfilterHelpers.js';

const FAKE = fileURLToPath(new URL('./fixtures/fakeCli.js', import.meta.url));
const BRIDGE = fileURLToPath(new URL('../../dist/mcp/bridge.cjs', import.meta.url));

const XML = `<PathOfBuilding><Build level="68" className="Ranger" ascendClassName="Deadeye" mainSocketGroup="1"/>
<Skills><Skill enabled="true"><Gem nameSpec="Tornado Shot" skillId="TornadoShot" enabled="true"/></Skill></Skills>
<Items><Item id="1">Rarity: RARE
Doom Whorl
Slink Boots
Item Level: 84</Item><ItemSet id="1"><Slot name="Boots" itemId="1"/></ItemSet></Items></PathOfBuilding>`;

const ENGINE: AssistantEngine = {
  send: (async (command: string) => {
    if (command === 'getBuildXml') return { buildXml: XML };
    throw new Error('not used');
  }) as AssistantEngine['send'],
  onEvent: (_l: (e: EngineEvent) => void) => () => undefined,
};

async function rig(env: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), 'pom-lfask-'));
  const log = join(dir, 'fake.log');
  const store = new LootFilterStore(join(dir, 'filters.json'));
  const st = await store.load();
  // The AI gate refuses everything without a server; these tests are about the Ask flow, so the gate is stubbed to grant access.
  const grant = {
    state: { status: 'allowed' }, verify: async () => undefined, run: async (_a: unknown, _s: unknown, _t: unknown, _i: unknown, op: () => Promise<unknown>) => op(),
    model: async () => null, pair: async () => { throw new Error('not used'); }, revoke: async () => undefined, invalidate: () => undefined, onChange: () => () => undefined,
  } as unknown as AiAccess;
  const target = async () => ({ objectId: 'o', revisionId: 'r', payloadHash: 'h', stamp: {} }) as never;
  const svc = new AssistantService({ engine: ENGINE, dataDir: dir, version: 'test', bridgePath: BRIDGE, ai: grant, target, scopedContext: async (_t, _a, _tool, _args, ctx) => ctx, env: { ...process.env, POM_CLAUDE_CLI: FAKE, POM_CODEX_CLI: FAKE, FAKE_LOG: log, ...env }, settleMs: 8000 });
  svc.setContext({ buildKey: 'k', buildId: 'b1', name: 'Kaelen' });
  svc.setLootContext({ store, ns: new NeverSinkStore(join(NEVERSINK_DIR, '..'), join(dir, 'dl')), prices: async () => null });
  await svc.start();
  const events: AssistantPush[] = [];
  svc.onPush((p) => events.push(p));
  const ask = (text: string): Promise<TurnEvent[]> =>
    new Promise((resolve) => {
      const mine: TurnEvent[] = [];
      svc.onPush((p) => {
        if (p.kind !== 'turn') return;
        mine.push(p.event);
        if (p.event.type === 'done' || p.event.type === 'error' || p.event.type === 'stopped') setTimeout(() => resolve(mine), 20);
      });
      svc.send({ provider: 'claude', buildKey: `lootfilter:${st.activeId}`, text, surface: 'lootfilter' });
    });
  const cleanup = async (): Promise<void> => {
    await svc.stop();
    for (let i = 0; i < 50 && svc.busy; i++) await new Promise((r) => setTimeout(r, 100));
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };
  return { svc, dir, log, store, events, ask, cleanup };
}

const toolLog = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { tool?: string; isError?: boolean; text?: string }).filter((l) => l.tool) : []);

test('Ask through the app: the program reads the filter and the build, proposes, and nothing changes until the player applies', { skip: !existsSync(BRIDGE) && 'run npm run build:bridge first' }, async () => {
  const steps = [
    { call: 'getLootFilter', args: {} },
    { call: 'getLootBuild', args: {} },
    { call: 'proposeLootRules', args: { title: 'Quiet white gear', changes: [{ action: 'hide', items: ['Scroll of Wisdom'], section: 'Scrolls', reason: 'You asked for fewer scrolls.' }, { action: 'standout', items: ['Divine Orb'], section: 'Currency' }] } },
    { text: 'Plan: hide scrolls and make Divine Orbs stand out.' },
  ];
  const dir = await mkdtemp(join(tmpdir(), 'pom-steps-'));
  const stepsFile = join(dir, 'steps.json');
  writeFileSync(stepsFile, JSON.stringify(steps));
  const r = await rig({ FAKE_MODE: 'tools', FAKE_STEPS_FILE: stepsFile });
  try {
    const before = JSON.stringify((await r.store.load()).filters[0]!.rules);
    const turn = await r.ask('Hide scrolls and make Divine Orbs louder');
    const last = turn[turn.length - 1]!;
    assert.equal(last.type, 'done', JSON.stringify(last));
    const tools = toolLog(r.log);
    assert.deepEqual(tools.map((t) => t.tool), ['getLootFilter', 'getLootBuild', 'proposeLootRules']);
    assert.ok(tools.every((t) => !t.isError), JSON.stringify(tools));
    assert.match(tools[1]!.text ?? '', /Slink Boots/);
    const proposals = r.events.flatMap((e) => (e.kind === 'lfproposal' ? [e.proposal as LfProposal] : []));
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0]!.changes.length, 2);
    assert.equal(proposals[0]!.changes[0]!.section, 'Scrolls');
    assert.equal(proposals[0]!.status, 'pending');
    assert.equal(JSON.stringify((await r.store.load()).filters[0]!.rules), before, 'the player rules are untouched until Apply');
    const chips = turn.flatMap((e) => (e.type === 'tool' ? [e.chip.label] : []));
    assert.ok(chips.includes('Read filter') && chips.includes('Read build') && chips.includes('Propose change'), chips.join(', '));
  } finally {
    await r.cleanup();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Ask through the app: a program that is signed out ends the turn with an error the panel can show', { skip: !existsSync(BRIDGE) && 'run npm run build:bridge first' }, async () => {
  const r = await rig({ FAKE_MODE: 'loggedOut' });
  try {
    const turn = await r.ask('Hide scrolls');
    const last = turn[turn.length - 1]!;
    assert.equal(last.type, 'error');
    assert.equal(r.events.filter((e) => e.kind === 'lfproposal').length, 0);
  } finally {
    await r.cleanup();
  }
});

test('Ask through the app: a name NeverSink does not have fails the proposal with a way forward and shows no card', { skip: !existsSync(BRIDGE) && 'run npm run build:bridge first' }, async () => {
  const steps = [{ call: 'proposeLootRules', args: { title: 'x', changes: [{ action: 'hide', items: ['Totally Fake Orb'] }] } }, { text: 'I could not find that item.' }];
  const dir = await mkdtemp(join(tmpdir(), 'pom-steps-'));
  const stepsFile = join(dir, 'steps.json');
  writeFileSync(stepsFile, JSON.stringify(steps));
  const r = await rig({ FAKE_MODE: 'tools', FAKE_STEPS_FILE: stepsFile });
  try {
    await r.ask('Hide the fake orb');
    const tools = toolLog(r.log);
    assert.equal(tools[0]!.isError, true);
    assert.match(tools[0]!.text ?? '', /Totally Fake Orb/);
    assert.equal(r.events.filter((e) => e.kind === 'lfproposal').length, 0);
  } finally {
    await r.cleanup();
    await rm(dir, { recursive: true, force: true });
  }
});
