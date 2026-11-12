// Account controls in the assistant panel: sign out, cancel and replace a sign-in, the sign-in timeout, the error box button,
// and the gate rechecking itself when the Path of Mastery account signs in. The programs are test/fixtures/fakeCli.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture } from '../src/main/aiGate/fixtures.js';
import { detectProvider } from '../src/main/assistant/cli.js';
import { AssistantService } from '../src/main/assistant/service.js';
import type { AssistantEngine } from '../src/main/assistant/tools.js';
import type { AssistantPush } from '../src/shared/assistant/types.js';
import { accountLines, clearSignIn, errorAction, focusLost, planLabel, providerChrome } from '../src/shared/assistant/account.js';
import { aiStatusView } from '../src/renderer/gates/ai/status.js';

const FAKE = fileURLToPath(new URL('./fixtures/fakeCli.js', import.meta.url));
const NO_ENGINE = { send: () => Promise.reject(new Error('unused')), onEvent: () => () => undefined } as unknown as AssistantEngine;
const logLines = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>) : []);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (ok: () => boolean, ms = 15000) => { for (let t = 0; t < ms && !ok(); t += 25) await new Promise((r) => setTimeout(r, 25)); return ok(); };

async function rig(env: Record<string, string> = {}, extra: { loginTimeoutMs?: number; verifyDelayMs?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pom-acct-'));
  const log = join(dir, 'fake.log');
  const state = join(dir, 'auth-state');
  writeFileSync(state, 'in');
  const gate = fixture();
  const { verifyDelayMs, ...serviceExtra } = extra;
  const svc = new AssistantService({
    ...gate.deps, engine: NO_ENGINE, dataDir: dir, version: 'test', bridgePath: 'unused', ...serviceExtra,
    // a slow server check: the window in which Cancel can arrive before the sign-in program exists
    ...(verifyDelayMs ? { target: async () => { await new Promise((r) => setTimeout(r, verifyDelayMs)); return gate.deps.target!(); } } : {}),
    env: { ...process.env, POM_CLAUDE_CLI: FAKE, POM_CODEX_CLI: FAKE, FAKE_LOG: log, FAKE_STATE: state, FAKE_EMAIL: 'a@b.co', FAKE_PLAN: 'max', ...env },
  });
  svc.setContext({ buildKey: 'k', buildId: 'b1', name: 'Test build' });
  const pushes: AssistantPush[] = [];
  svc.onPush((p) => pushes.push(p));
  return { svc, gate, log, pushes, cleanup: async () => { await svc.stop(); await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } };
}
const loginPids = (log: string) => logLines(log).filter((l) => l.login).map((l) => l.pid as number);

test('the status gives the plan and email for Claude, and nothing invented for ChatGPT', async () => {
  const env = { ...process.env, POM_CLAUDE_CLI: FAKE, POM_CODEX_CLI: FAKE, FAKE_EMAIL: 'a@b.co', FAKE_PLAN: 'max' };
  const c = await detectProvider('claude', env);
  assert.equal(c.state, 'ready');
  assert.equal(c.plan, 'Max plan');
  assert.deepEqual(accountLines(c), ['Claude · Max plan', 'a@b.co']);
  const x = await detectProvider('codex', env);
  assert.equal(x.plan, undefined);
  assert.equal(x.account, undefined);
  assert.deepEqual(accountLines(x), ['ChatGPT']);
  assert.equal((await detectProvider('claude', { ...env, FAKE_PLAN: '' })).plan, undefined, 'no plan line when the program gives none');
  assert.equal(planLabel('enterprise'), 'Enterprise plan');
  assert.equal(planLabel('<script>'), undefined);
});

test('Sign out runs the program’s own logout and the next check says signed out', async () => {
  const r = await rig();
  try {
    assert.equal((await r.svc.status()).find((s) => s.id === 'claude')!.state, 'ready');
    const after = await r.svc.signOut('claude');
    assert.deepEqual(logLines(r.log).filter((l) => l.logout).map((l) => l.logout), ['auth logout']);
    assert.equal(after.find((s) => s.id === 'claude')!.state, 'loggedOut');
    await r.svc.signOut('codex');
    assert.deepEqual(logLines(r.log).filter((l) => l.logout).map((l) => l.logout), ['auth logout', 'logout']);
  } finally { await r.cleanup(); }
});

test('Cancel kills the running sign-in program', async () => {
  const r = await rig({ FAKE_LOGIN_HANG: '1' });
  try {
    assert.equal((await r.svc.openLogin('claude')).started, true);
    assert.ok(await until(() => loginPids(r.log).length === 1), 'the sign-in program started');
    const pid = loginPids(r.log)[0]!;
    assert.equal(alive(pid), true);
    r.svc.cancelLogin('claude');
    assert.ok(await until(() => !alive(pid)), 'the sign-in program is gone after Cancel');
  } finally { await r.cleanup(); }
});

test('a second click does not leave a second sign-in program running', async () => {
  const r = await rig({ FAKE_LOGIN_HANG: '1' });
  try {
    await r.svc.openLogin('claude');
    assert.ok(await until(() => loginPids(r.log).length === 1));
    await r.svc.openLogin('claude');
    assert.ok(await until(() => loginPids(r.log).length === 2));
    const [first, second] = loginPids(r.log);
    assert.ok(await until(() => !alive(first!)), 'the first one was replaced');
    assert.equal(alive(second!), true);
    r.svc.cancelLogin('claude');
    assert.ok(await until(() => !alive(second!)));
  } finally { await r.cleanup(); }
});

test('a sign-in nobody finishes ends by itself and the panel is told', async () => {
  const r = await rig({ FAKE_LOGIN_HANG: '1' }, { loginTimeoutMs: 6000 });
  try {
    await r.svc.openLogin('claude');
    assert.ok(await until(() => loginPids(r.log).length === 1));
    const pid = loginPids(r.log)[0]!;
    assert.ok(await until(() => r.pushes.some((p) => p.kind === 'login' && p.provider === 'claude' && p.state === 'timeout')), 'the panel got the timeout');
    assert.ok(await until(() => !alive(pid)), 'the program was killed');
  } finally { await r.cleanup(); }
});

test('a turn that fails as signed out offers Sign in, not Retry', () => {
  const err = (code: string) => ({ code, message: 'm' }) as never;
  assert.deepEqual(errorAction(err('loggedOut'), 'claude'), { kind: 'signIn', label: 'Sign in with Claude' });
  assert.deepEqual(errorAction(err('loggedOut'), 'codex'), { kind: 'signIn', label: 'Sign in with ChatGPT' });
  assert.deepEqual(errorAction(err('offline'), 'claude'), { kind: 'retry' });
});

test('the panel’s Path of Mastery sign-in button names the account', () => {
  assert.equal(aiStatusView({ status: 'denied', code: 'SIGN_IN_REQUIRED' }).recovery, 'Sign in to Path of Mastery');
});

// Walkthrough steps 37-41: after a sign-out and sign-in the gate was reset to Off and stayed there until "Retry verification".
test('when the Path of Mastery account signs in, the gate checks itself and becomes ready', async () => {
  const r = await rig();
  try {
    await r.svc.start();
    r.gate.gate.reset(); // what main/mastery/index.ts does on a sign-in
    assert.ok(await until(() => r.gate.gate.state.status === 'ready'), `the gate stayed ${r.gate.gate.state.status}`);
    assert.ok(r.pushes.some((p) => p.kind === 'gate' && p.state.status === 'ready'), 'the panel was told');
  } finally { await r.cleanup(); }
});

// Codex review: Cancel while the server check still runs found no process to kill, and the sign-in started afterwards.
test('Cancel during the server check stops the sign-in before it starts', async () => {
  const r = await rig({ FAKE_LOGIN_HANG: '1' }, { verifyDelayMs: 600 });
  try {
    const started = r.svc.openLogin('claude');
    await new Promise((res) => setTimeout(res, 100));
    r.svc.cancelLogin('claude');
    assert.equal((await started).started, false);
    await new Promise((res) => setTimeout(res, 1500));
    assert.deepEqual(loginPids(r.log), [], 'no sign-in program was started');
  } finally { await r.cleanup(); }
});

// A turn still running on the old account kept its Claude Code program, and put it back in the warm pool.
test('Sign out while a question is running ends that program and keeps no old-account program', async () => {
  const r = await rig({ FAKE_MODE: 'slow' });
  try {
    await r.svc.start();
    r.svc.send({ provider: 'claude', buildKey: 'k', text: 'hi' });
    assert.ok(await until(() => logLines(r.log).some((l) => l.start)), 'the program started');
    await r.svc.signOut('claude');
    const pids = () => logLines(r.log).filter((l) => l.start).map((l) => l.pid as number);
    assert.ok(await until(() => pids().every((p) => !alive(p))), 'every Claude Code program of the old account is gone');
    assert.equal((r.svc as unknown as { warm: { items: unknown[] } }).warm.items.length, 0, 'none is waiting in the pool');
  } finally { await r.cleanup(); }
});

// A refused check put the gate back to Off, which the service took for a new sign-in and checked again, without end.
test('a check that fails after a sign-in is not repeated by itself', async () => {
  const r = await rig();
  try {
    await r.svc.start();
    r.gate.state.denied = 'RATE_LIMITED';
    r.gate.gate.reset();
    await new Promise((res) => setTimeout(res, 1500));
    assert.equal(r.gate.state.calls.filter((c) => c.route === 'session').length, 1, 'one check for one sign-in');
  } finally { await r.cleanup(); }
});

// On Windows codex.cmd runs node, which runs the native program; a plain kill left that and its sign-in server running.
test('Cancel ends the whole sign-in process tree, not only its first program', async () => {
  const r = await rig({ FAKE_LOGIN_HANG: '1', FAKE_LOGIN_GRANDCHILD: '1' });
  try {
    await r.svc.openLogin('codex');
    const grand = () => logLines(r.log).find((l) => l.grandchild)?.grandchild as number | undefined;
    assert.ok(await until(() => !!grand()), 'the sign-in program started its own child');
    const g = grand()!;
    r.svc.cancelLogin('codex');
    assert.ok(await until(() => !alive(g)), 'the child is gone too');
  } finally { await r.cleanup(); }
});

test('the card never takes the place of the composer while a question runs', () => {
  assert.equal(providerChrome({ status: 'ready' }, 'loggedOut', true).card, false);
  assert.equal(providerChrome({ status: 'ready' }, 'loggedOut', false).card, true);
});

test('a sign-out the program refused is an error, not a silent success', async () => {
  const r = await rig({ FAKE_LOGOUT_FAIL: '1' });
  try {
    await assert.rejects(r.svc.signOut('claude'), /Could not sign out of Claude/);
  } finally { await r.cleanup(); }
});

// Screenshot 04 of the first account PR: "Ready" over a signed-out chip, and two Sign in with Claude buttons.
test('a signed-out provider hides "Ready" and leaves the one sign-in button to its card', () => {
  assert.deepEqual(providerChrome({ status: 'ready' }, 'loggedOut'), { gate: null, card: true });
  assert.deepEqual(providerChrome({ status: 'ready' }, 'ready'), { gate: { status: 'ready' }, card: false });
  assert.deepEqual(providerChrome({ status: 'denied', code: 'SIGN_IN_REQUIRED' }, 'loggedOut'), { gate: { status: 'denied', code: 'SIGN_IN_REQUIRED' }, card: false }, 'a denial shows, and the card stays away');
});

// 0.1.7 review: signing out of one provider hid the other provider's "Finish signing in" screen and its Cancel button.
test('signing out of one provider leaves the other provider’s sign-in waiting', () => {
  assert.equal(clearSignIn('codex', 'claude'), 'codex');
  assert.equal(clearSignIn('claude', 'claude'), null);
  assert.equal(clearSignIn(null, 'claude'), null);
});

// 0.1.7 review: after a menu item the chip or menu is gone and keyboard focus fell to the page; the card's sign-in button takes it only then.
test('the sign-in button takes keyboard focus only when focus has nowhere else to be', () => {
  const body = {};
  assert.equal(focusLost(body, body), true);
  assert.equal(focusLost(null, body), true);
  assert.equal(focusLost({}, body), false);
});
