import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RevisionRef } from '@pom/mastery-contracts';
import { AiDenied, AiGate, PANEL, PANEL_SCOPES, type AiBackend, type AiActor } from '../src/main/aiGate/gate.js';
import { fixture, target, limits } from '../src/main/aiGate/fixtures.js';

// One question is many tool steps. The site counts AI sessions against the hourly limit, so the gate opens one session per
// question and every step reuses it; each step still needs its own server authorization (operation + release).

const count = (f: ReturnType<typeof fixture>, route: string) => f.state.calls.filter(c => c.route === route).length;
function gateWith(f: ReturnType<typeof fixture>, opts: { now?: () => number; current?: (t: RevisionRef) => Promise<boolean> } = {}) {
  return new AiGate({ backend: f.backend, limits, current: opts.current ?? (async ref => JSON.stringify(ref) === JSON.stringify(target())), ...(opts.now ? { now: opts.now } : {}) });
}
const other = (): RevisionRef => ({ ...target(), revisionId: '44444444-4444-4444-8444-444444444444' as RevisionRef['revisionId'] });

test('forty tool steps of one question open one session and still authorize every step', async () => {
  const f = fixture(); const gate = gateWith(f);
  for (let step = 0; step < 40; step++) assert.equal(await gate.run(PANEL, step % 2 ? 'mcp:read' : 'mcp:propose', target(), { step }, async () => step), step);
  assert.equal(count(f, 'session'), 1);
  assert.equal(count(f, 'authorize'), 80, 'operation and release each still get a fresh server authorization');
  assert.equal(count(f, 'request'), 80);
  const sessionIds = new Set(f.state.calls.filter(c => c.route === 'authorize').map(c => c.body.sessionId));
  assert.equal(sessionIds.size, 1);
  assert.deepEqual([...f.state.calls.find(c => c.route === 'session')!.body.scopes].sort(), [...PANEL_SCOPES].sort(), 'the panel session covers every panel scope');
});

test('a question with the tool-server start checks opens one session; every verify is still a server round trip', async () => {
  const f = fixture(); const gate = gateWith(f);
  gate.renew(PANEL);
  await gate.run(PANEL, 'mcp:read', target(), { action: 'start-turn' }, async () => undefined);
  const before = f.state.calls.length;
  await gate.verify(PANEL, target()); await gate.verify(PANEL, target()); // syncPro's verify and the MCP start verify
  assert.equal(count(f, 'session'), 1, 'the start checks reuse the question session');
  assert.equal(f.state.calls.length - before, 2, 'each verify asked the server');
  assert.equal(gate.state.status, 'ready');
  await gate.run(PANEL, 'mcp:read', target(), {}, async () => 1);
  await gate.model(PANEL, 'ai:suggest', target(), { q: 1 });
  assert.equal(count(f, 'session'), 1);
  f.state.denied = 'AI_ACCESS_REQUIRED';
  await assert.rejects(gate.verify(PANEL, target()), e => e instanceof AiDenied && e.code === 'AI_ACCESS_REQUIRED');
  assert.equal(gate.state.status, 'denied');
});

test('polling after the grant and then the session expire: 60 polls => no new session, then 60 more => exactly one', async () => {
  const f = fixture(); let now = Date.now(); const original = f.backend.post.bind(f.backend);
  f.backend.post = async <T>(route: Parameters<AiBackend['post']>[0], body: unknown, actor: AiActor, signal?: AbortSignal) => {
    const result = await original<T>(route, body, actor, signal);
    if (result.ok && (route === 'session' || route === 'authorize')) (result.value as { expiresAt: string }).expiresAt = new Date(now + (route === 'session' ? 3_600_000 : 300_000)).toISOString();
    return result;
  };
  const gate = gateWith(f, { now: () => now });
  await gate.run(PANEL, 'mcp:read', target(), {}, async () => 1);
  now += 10 * 60_000; // grant expired, session live
  for (let i = 0; i < 60; i++) { await gate.check(PANEL, target()); now += 1000; }
  assert.equal(count(f, 'session'), 1, 'an expired grant never opens a session');
  assert.equal(count(f, 'authorize'), 3, 'one authorized step renewed the grant; the other polls asked about it');
  now += 60 * 60_000; // session expired too
  for (let i = 0; i < 60; i++) { await gate.check(PANEL, target()); now += 1000; }
  assert.equal(count(f, 'session'), 2, 'one new session per expiry, not one per poll');
  now += 2 * 60 * 60_000; // expired again; ten polls overlap
  await Promise.all(Array.from({ length: 10 }, () => gate.check(PANEL, target())));
  assert.equal(count(f, 'session'), 3, 'overlapping polls share one new session');
});

test('renew starts a new session for the next question: five questions, five sessions', async () => {
  const f = fixture(); const gate = gateWith(f);
  for (let q = 0; q < 5; q++) {
    gate.renew(PANEL);
    for (let step = 0; step < 8; step++) await gate.run(PANEL, 'mcp:read', target(), { q, step }, async () => step);
  }
  assert.equal(count(f, 'session'), 5);
  assert.equal(count(f, 'authorize'), 80);
});

test('a session close to its end is not reused', async () => {
  const f = fixture(); let now = Date.now(); const original = f.backend.post.bind(f.backend);
  // The server's clock is the test clock: sessions last an hour from it, grants a minute (the grant object is the stored one).
  f.backend.post = async <T>(route: Parameters<AiBackend['post']>[0], body: unknown, actor: AiActor, signal?: AbortSignal) => {
    const result = await original<T>(route, body, actor, signal);
    if (result.ok && (route === 'session' || route === 'authorize')) (result.value as { expiresAt: string }).expiresAt = new Date(now + (route === 'session' ? 3_600_000 : 60_000)).toISOString();
    return result;
  };
  const gate = gateWith(f, { now: () => now });
  await gate.run(PANEL, 'mcp:read', target(), {}, async () => 1);
  now += 30 * 60_000; await gate.run(PANEL, 'mcp:read', target(), {}, async () => 1);
  assert.equal(count(f, 'session'), 1, 'half an hour in, the hour-long session is still used');
  now += 29 * 60_000 + 30_000; await gate.run(PANEL, 'mcp:read', target(), {}, async () => 1);
  assert.equal(count(f, 'session'), 2, 'inside the last minute a new session is opened');
});

test('sign-out, Pro ending, an account change and revoke all drop the cached session (fail closed)', async () => {
  const f = fixture(); const gate = gateWith(f);
  await gate.run(PANEL, 'mcp:read', target(), {}, async () => 1);
  f.state.denied = 'SIGN_IN_REQUIRED';
  await assert.rejects(gate.run(PANEL, 'mcp:read', target(), {}, async () => 1), e => e instanceof AiDenied && e.code === 'SIGN_IN_REQUIRED');
  assert.equal(gate.state.status, 'denied');
  f.state.denied = null;
  await gate.run(PANEL, 'mcp:read', target(), {}, async () => 1);
  assert.equal(count(f, 'session'), 2, 'after a signed-out denial the next step asks the server for a new session');
  gate.invalidate('AI_ACCESS_REQUIRED'); await gate.run(PANEL, 'mcp:read', target(), {}, async () => 1);
  gate.reset(); await gate.run(PANEL, 'mcp:read', target(), {}, async () => 1);
  await gate.revoke(null); await gate.run(PANEL, 'mcp:read', target(), {}, async () => 1);
  assert.equal(count(f, 'session'), 5);
});

test('a denied step never runs its operation even with a cached session', async () => {
  const f = fixture(); const gate = gateWith(f); let ran = 0;
  await gate.run(PANEL, 'mcp:read', target(), {}, async () => ++ran);
  for (const code of ['AI_ACCESS_REQUIRED', 'HUMAN_CHECK_REQUIRED', 'RATE_LIMITED', 'CONNECTION_REVOKED'] as const) {
    f.state.denied = code;
    await assert.rejects(gate.run(PANEL, 'mcp:read', target(), {}, async () => ++ran), e => e instanceof AiDenied && e.code === code);
  }
  assert.equal(ran, 1);
});

test('sessions are per actor and per build revision', async () => {
  const f = fixture(); let selected = target();
  const gate = gateWith(f, { current: async ref => JSON.stringify(ref) === JSON.stringify(selected) });
  const client: AiActor = { clientId: '77777777-7777-4777-8777-777777777777', proof: 'p'.repeat(43) };
  await gate.run(PANEL, 'mcp:read', target(), {}, async () => 1);
  await gate.run(client, 'mcp:read', target(), {}, async () => 1);
  await gate.run(client, 'mcp:read', target(), {}, async () => 1);
  assert.equal(count(f, 'session'), 2);
  assert.deepEqual(f.state.calls.filter(c => c.route === 'session')[1]!.body.scopes, ['mcp:read'], 'a paired client asks only for the scope it uses');
  await gate.run(client, 'mcp:propose', target(), {}, async () => 1);
  assert.deepEqual(f.state.calls.filter(c => c.route === 'session')[2]!.body.scopes, ['mcp:read', 'mcp:propose']);
  selected = other();
  await gate.run(PANEL, 'mcp:read', other(), {}, async () => 1);
  assert.equal(count(f, 'session'), 4, 'an applied change (new revision) gets its own session');
  await assert.rejects(gate.run(PANEL, 'mcp:read', target(), {}, async () => 1), e => e instanceof AiDenied && e.code === 'REVISION_CONFLICT');
});

test('the every-second live check during an answer opens no session while one is live, and fails closed', async () => {
  const f = fixture(); const gate = gateWith(f);
  await gate.check(PANEL, target());
  assert.equal(count(f, 'session'), 1, 'with no live session the check is a full verify');
  await gate.run(PANEL, 'mcp:read', target(), {}, async () => 1);
  for (let i = 0; i < 30; i++) await gate.check(PANEL, target());
  assert.equal(count(f, 'session'), 1, 'thirty seconds of an answer: still one session');
  const status = f.state.calls.filter(c => c.route === 'request' && c.body.action === 'status');
  assert.equal(status.length, 30); assert.ok(status.every(c => c.body.sessionId === status[0]!.body.sessionId && c.body.clientId === null));
  f.state.denied = 'AI_ACCESS_REQUIRED';
  await assert.rejects(gate.check(PANEL, target()), e => e instanceof AiDenied && e.code === 'AI_ACCESS_REQUIRED');
  assert.equal(gate.state.status, 'denied');
  f.state.denied = null;
  await gate.check(PANEL, target());
  assert.equal(count(f, 'session'), 2, 'after Pro ended the next check asks the server for a new session');
});

test('steps that start together share one session request', async () => {
  const f = fixture(); const original = f.backend.post.bind(f.backend);
  f.backend.post = async <T>(route: Parameters<AiBackend['post']>[0], body: unknown, actor: AiActor, signal?: AbortSignal) => {
    if (route === 'session') await new Promise(r => setTimeout(r, 20));
    return original<T>(route, body, actor, signal);
  };
  const gate = gateWith(f);
  await Promise.all(Array.from({ length: 6 }, (_, i) => gate.run(PANEL, 'mcp:read', target(), { i }, async () => i)));
  assert.equal(count(f, 'session'), 1);
});

test('a session opened while the account changed is not kept', async () => {
  const f = fixture(); const original = f.backend.post.bind(f.backend); let gate!: AiGate; let first = true;
  f.backend.post = async <T>(route: Parameters<AiBackend['post']>[0], body: unknown, actor: AiActor, signal?: AbortSignal) => {
    const result = await original<T>(route, body, actor, signal);
    if (route === 'session' && first) { first = false; gate.reset(); }
    return result;
  };
  gate = gateWith(f);
  await assert.rejects(gate.run(PANEL, 'mcp:read', target(), {}, async () => 1), e => e instanceof AiDenied && e.code === 'CONNECTION_REVOKED');
  await gate.run(PANEL, 'mcp:read', target(), {}, async () => 1);
  assert.equal(count(f, 'session'), 2);
});

test('one dropped connection on the every-second live check does not end a long answer; three in a row still fail closed', async () => {
  const f = fixture(); const original = f.backend.post.bind(f.backend); let drop = 0;
  f.backend.post = async <T>(route: Parameters<AiBackend['post']>[0], body: unknown, actor: AiActor, signal?: AbortSignal) => {
    if (route === 'request' && (body as { action?: string }).action === 'status' && drop > 0) { drop--; return { ok: false, code: 'ENTITLEMENT_UNAVAILABLE', message: 'Could not authorize this request.' } as never; }
    return original<T>(route, body, actor, signal);
  };
  const gate = gateWith(f);
  await gate.run(PANEL, 'mcp:read', target(), {}, async () => 1);
  drop = 1; await gate.check(PANEL, target());
  assert.notEqual(gate.state.status, 'denied');
  drop = 3; await assert.rejects(gate.check(PANEL, target()), e => e instanceof AiDenied && e.code === 'ENTITLEMENT_UNAVAILABLE');
  assert.equal(gate.state.status, 'denied');
});
