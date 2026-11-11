import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EngineEvent } from '@pom/protocol';
import type { AssistantPush, TurnEvent } from '../src/shared/assistant/types.js';
import { AssistantService } from '../src/main/assistant/service.js';
import type { AssistantEngine } from '../src/main/assistant/tools.js';
import { fixture } from '../src/main/aiGate/fixtures.js';
import { accountChanged, getAiStatus, isSignedIn, onAiStatusChange, onSignInChange, setAccountSource, setAiStatus } from '../src/main/entitlements.js';

test('AI access follows sign-in, and listeners hear only a real change', () => {
  let user: string | null = null;
  setAccountSource(() => user);
  let heard = 0;
  const off = onSignInChange(() => heard++);
  assert.equal(isSignedIn(), false);
  accountChanged();
  assert.equal(heard, 0, 'nothing changed');
  user = 'u1';
  assert.equal(isSignedIn(), true);
  accountChanged(); accountChanged();
  assert.equal(heard, 1, 'one notice for one sign-in');
  user = null;
  accountChanged();
  assert.equal(heard, 2);
  off();
  user = 'u2'; accountChanged();
  assert.equal(heard, 2, 'an unsubscribed listener hears nothing');
  setAccountSource(null);
  assert.equal(isSignedIn(), false);
});

test('the server answer is kept as the AI status and listeners hear each change', () => {
  let heard = 0;
  const off = onAiStatusChange(() => heard++);
  assert.deepEqual(getAiStatus(), { status: 'off' });
  setAiStatus({ status: 'denied', code: 'AI_ACCESS_REQUIRED' });
  assert.deepEqual(getAiStatus(), { status: 'denied', code: 'AI_ACCESS_REQUIRED' });
  setAiStatus({ status: 'off' });
  assert.equal(heard, 2);
  off();
});

// ---- the assistant refuses for a free player ------------------------------------------------------------------

const FAKE = fileURLToPath(new URL('./fixtures/fakeCli.js', import.meta.url));
const NO_ENGINE: AssistantEngine = {
  send: () => Promise.reject(new Error('the engine is not used in this test')),
  onEvent: (_l: (e: EngineEvent) => void) => () => undefined,
};

test('a server-denied account starts no tool server or provider; being signed in cannot enable Connections', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pom-free-'));
  const log = join(dir, 'fake.log');
  let signedIn = false;
  const f = fixture();
  f.state.denied = 'AI_ACCESS_REQUIRED';
  let notify: () => void = () => undefined;
  const jevCalls: string[] = [];
  const svc = new AssistantService({
    ...f.deps,
    engine: NO_ENGINE,
    dataDir: dir,
    version: 'test',
    bridgePath: 'unused',
    env: { ...process.env, POM_CLAUDE_CLI: FAKE, POM_CODEX_CLI: FAKE, FAKE_LOG: log, TYPESAFE_API_KEY: 'test-key' },
    jevDecide: async (state) => {
      jevCalls.push(state);
      return null;
    },
    isSignedIn: () => signedIn,
    onSignInChange: (cb) => {
      notify = cb;
      return () => undefined;
    },
    settleMs: 2000,
  });
  svc.setContext({ buildKey: 'k', buildId: 'b1', name: 'Test build' });
  const events: TurnEvent[] = [];
  svc.onPush((p: AssistantPush) => {
    if (p.kind === 'turn') events.push(p.event);
  });
  try {
    await svc.start();
    assert.throws(() => svc.mcpUrl, /not running/, 'no tool server for a free player');
    assert.equal(existsSync(join(dir, 'assistant', 'mcp.json')), false, 'no secret file for the Claude Desktop bridge');

    for (const surface of [undefined, 'lootfilter'] as const) {
      for (const provider of ['claude', 'codex'] as const) {
        svc.send({ provider, buildKey: 'k', text: 'hello', ...(surface ? { surface } : {}) });
      }
    }
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(events.filter((e) => e.type === 'error').length, 4, 'every turn is refused');
    assert.ok(!events.some((e) => e.type === 'started'), 'no turn starts');
    assert.equal(existsSync(log), false, 'the fake Claude and Codex program was never started');

    const st = await svc.status();
    assert.ok(st.every((s) => s.state === 'unknown'), 'the check does not run the programs');
    assert.equal(existsSync(log), false);
    assert.equal((await svc.openLogin('claude')).started, false);
    assert.equal(await svc.restartDesktop(), false);
    await assert.rejects(svc.installConnector(), /not available/);
    assert.equal(existsSync(log), false);
    assert.deepEqual(jevCalls, [], 'Jev was never asked');

    signedIn = true;
    notify();
    assert.throws(() => svc.mcpUrl, /not running/, 'being signed in cannot start the tool server');
    await assert.rejects(svc.setConnectionsEnabled(true), /not available/);
    assert.equal(existsSync(join(dir, 'assistant', 'mcp.json')), false);
    f.state.denied = null;
    await svc.verifyAi();
    assert.throws(() => svc.mcpUrl, /not running/, 'server authorization leaves Connections Off until enabled');
    await svc.setConnectionsEnabled(true);
    assert.ok(svc.mcpUrl.startsWith('http'), 'explicit Connections enable starts the server after authorization');
    assert.equal(existsSync(join(dir, 'assistant', 'mcp.json')), true);
    f.state.denied = 'AI_ACCESS_REQUIRED';
    signedIn = false;
    notify();
    await new Promise((r) => setTimeout(r, 300));
    assert.throws(() => svc.mcpUrl, /not running/);
    assert.equal(existsSync(join(dir, 'assistant', 'mcp.json')), false);
  } finally {
    await svc.stop();
    if (existsSync(log)) assert.fail('spawn log appeared: ' + readFileSync(log, 'utf8'));
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('a sign-in notice that changes nothing never shows a never-paired account "Expired"; signing out says access required', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pom-prochange-'));
  let signedIn = true;
  const f = fixture();
  let notify: () => void = () => undefined;
  const svc = new AssistantService({
    ...f.deps, engine: NO_ENGINE, dataDir: dir, version: 'test', bridgePath: 'unused',
    env: { ...process.env, POM_CLAUDE_CLI: FAKE, POM_CODEX_CLI: FAKE },
    isSignedIn: () => signedIn, onSignInChange: (cb) => { notify = cb; return () => undefined; },
  });
  try {
    await svc.start();
    assert.equal(f.gate.state.status, 'off', 'never verified, never paired');
    notify(); notify();
    assert.equal(f.gate.state.status, 'off', 'a notice with the same sign-in state leaves the gate alone');
    assert.notEqual(f.gate.state.code, 'CONNECTION_REVOKED');
    await svc.verifyAi();
    assert.equal(f.gate.state.status, 'ready');
    notify();
    assert.equal(f.gate.state.status, 'ready', 'still signed in: still Ready');
    signedIn = false; f.state.denied = 'AI_ACCESS_REQUIRED';
    notify();
    assert.deepEqual(f.gate.state, { status: 'denied', code: 'AI_ACCESS_REQUIRED' }, 'signing out is reported as access required, not Expired');
  } finally {
    await svc.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
