// AI human check : the site answers HUMAN_CHECK_REQUIRED, the desktop shows the check, then retries once with the clearance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createAiBackend } from '../src/main/aiGate/client.js';
import { createAdmission } from '../src/main/mastery/admission.js';
import { PANEL, hashJson } from '../src/main/aiGate/gate.js';

const limits = { maxBytes: 1 << 20, maxDepth: 16, maxNodes: 10000, maxArrayLength: 1000, maxStringLength: 10000 };
const ACCOUNT = randomUUID();
const installation = 'b'.repeat(64);
const target = { objectId: randomUUID(), revisionId: randomUUID(), payloadHash: 'e'.repeat(64), fallbackSnapshotHash: 'f'.repeat(64),
  stamp: { leagueId: { status: 'unknown', reason: 'x' }, realm: { status: 'unknown', reason: 'x' }, mode: { status: 'unknown', reason: 'x' }, patchVersion: { status: 'unknown', reason: 'x' },
    datasetVersion: { status: 'unknown', reason: 'x' }, createdAt: '2026-01-01T00:00:00.000Z' } } as never;
const sessionBody = { clientId: null, targets: [target], scopes: ['ai:suggest'], idempotencyKey: 'k1' };
/** Continue on an AI request the way the app does it: resume(), the request continues (aiRequire resolves), the client reports the
 *  retry's answer (aiOutcome), and only then does resume() settle. */
async function continueAi(admission: ReturnType<typeof createAdmission>, waiting: Promise<Record<string, string> | null>) {
  const r = admission.resume(); const headers = await waiting;
  admission.aiOutcome('session', sessionBody, PANEL, { ok: true, value: {} } as never, false);
  return { status: (await r).status, headers };
}
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

test('backend: HUMAN_CHECK_REQUIRED -> asks once -> retries once with the clearance headers; declined stays denied', async () => {
  const seen: (string | null)[] = []; let asked = 0; let answer: Record<string, string> | null = { 'x-pom-clearance': 'c1' };
  const backend = createAiBackend({
    baseUrl: 'http://127.0.0.1:4321/', installation, accountId: () => 'acct', token: async () => 't', appHeaders: async () => ({}), limits, allowLoopback: true,
    fetch: (async (_u: unknown, init: RequestInit) => {
      const h = init.headers as Record<string, string>; seen.push(h['x-pom-clearance'] ?? null);
      return h['x-pom-clearance'] ? json({ ok: true, value: { sessionId: 's' } }) : json({ ok: false, code: 'HUMAN_CHECK_REQUIRED', message: 'x' }, 403);
    }) as typeof fetch,
    humanCheck: async () => { asked++; return answer; },
  });
  const ok = await backend.post('session', sessionBody, PANEL);
  assert.equal(ok.ok, true); assert.deepEqual(seen, [null, 'c1']); assert.equal(asked, 1);
  seen.length = 0; answer = null;
  const no = await backend.post('session', sessionBody, PANEL);
  assert.deepEqual(no.ok ? null : no.code, 'HUMAN_CHECK_REQUIRED'); assert.deepEqual(seen, [null], 'no retry without a clearance');
  seen.length = 0; answer = { 'x-pom-clearance': 'c2' };
  const again = await createAiBackend({
    baseUrl: 'http://127.0.0.1:4321/', installation, accountId: () => 'acct', token: async () => 't', appHeaders: async () => ({}), limits, allowLoopback: true,
    fetch: (async () => json({ ok: false, code: 'HUMAN_CHECK_REQUIRED', message: 'x' }, 403)) as typeof fetch,
    humanCheck: async () => answer,
  }).post('session', sessionBody, PANEL);
  assert.equal(again.ok, false, 'a second refusal after the retry is returned, not looped');
});

test('admission: dialog -> provider token -> verified clearance cached and reused until expiry; decline cools down', async () => {
  let asked = 0, challenges = 0; let now = Date.now(); const ttl = 300_000;
  const hashOf = (body: any) => body.intent.requestHash as string;
  const fakeFetch = (async (url: string, init: RequestInit) => {
    const op = String(url).split('/api/network/')[1]; const body = JSON.parse(String(init.body));
    if (op === 'challenge') {
      challenges++;
      return json({ ok: true, value: { challenge: { challengeId: randomUUID(), nonce: randomUUID(), contextHash: 'c'.repeat(64), provider: 'turnstile', requestHash: hashOf(body), expiresAt: new Date(now + ttl).toISOString() },
        presentation: { url: 'https://pathofmastery.gg/network-check?n=1', accessibleUrl: null } } });
    }
    const clear = { status: 'clear', clearanceId: randomUUID(), requestHash: hashOf(body), expiresAt: new Date(now + ttl).toISOString() };
    return json({ ok: true, value: op === 'verify' ? clear : { clearance: clear, resumePolicy: body.intent.resumePolicy } });
  }) as unknown as typeof fetch;
  let admission: ReturnType<typeof createAdmission>;
  admission = createAdmission({
    origin: 'http://127.0.0.1:4321', allowLoopback: true, limits, installation, sign: () => ({}), accountId: () => ACCOUNT,
    accessToken: async () => 't', fetch: fakeFetch, now: () => now, aiTimeoutMs: 2000,
    askUser: () => { asked++; void (async () => { const s = await admission.begin(false); assert.equal(s.status, 'ready'); assert.equal((await admission.complete('XXXX.DUMMY.TOKEN.XXXX')).status, 'passed'); void admission.resume(); })(); },
  });
  const first = await admission.aiRequire('session', sessionBody, PANEL);
  admission.aiOutcome('session', sessionBody, PANEL, { ok: true, value: {} } as never, false); // the client reports the retry's answer
  assert.ok(first && first['x-pom-clearance'] && first['x-pom-network-intent'], 'clearance headers returned');
  assert.equal(asked, 1);
  const intent = JSON.parse(Buffer.from(first['x-pom-network-intent']!, 'base64url').toString());
  assert.equal(intent.requestHash, hashJson({ body: sessionBody, installationHash: installation, proofHash: null }), 'bound to the exact hash the site computes');
  assert.deepEqual(admission.aiCached('session', sessionBody, PANEL), first, 'cached clearance reused');
  assert.deepEqual(await admission.aiRequire('session', sessionBody, PANEL), first); assert.equal(asked, 1, 'no second dialog while cached');
  // authorize + request share the clearance (same session, same request hash)
  const request = { requestId: 'r1', target, scope: 'ai:suggest', clientId: null, requestHash: 'd'.repeat(64) };
  const a = await admission.aiRequire('authorize', { sessionId: randomUUID(), request }, PANEL); assert.ok(a); assert.equal(asked, 2);
  admission.aiOutcome('authorize', { sessionId: randomUUID(), request }, PANEL, { ok: true, value: {} } as never, false);
  now += ttl + 1000;
  assert.equal(admission.aiCached('session', sessionBody, PANEL), null, 'expired clearance is dropped');
  // decline: dialog closes without a pass
  const declining = createAdmission({ origin: 'http://127.0.0.1:4321', allowLoopback: true, limits, installation, sign: () => ({}), accountId: () => ACCOUNT,
    accessToken: async () => 't', fetch: fakeFetch, now: () => now, askUser: () => { asked++; setTimeout(() => declining.cancel(), 5); } });
  assert.equal(await declining.aiRequire('session', sessionBody, PANEL), null);
  const before = asked; assert.equal(await declining.aiRequire('session', sessionBody, PANEL), null); assert.equal(asked, before, 'no dialog storm right after "Keep working locally"');
  assert.ok(challenges >= 2);
});

test('soft check: a passed check ends the decline cooldown (the server clears the account for a session window, for all actions)', async () => {
  const { createAiClearances } = await import('../src/main/aiGate/clearance.js');
  let now = 1_000_000; const c = createAiClearances({ now: () => now });
  c.declined(); assert.equal(c.coolingDown(), true);
  c.passed(); assert.equal(c.coolingDown(), false);
});

test('a passed check keeps the AI request waiting until Continue, then it is retried once', async () => {
  const fakeFetch = (async (url: string, init: RequestInit) => {
    const op = String(url).split('/api/network/')[1]; const body = JSON.parse(String(init.body)); const at = new Date(Date.now() + 300_000).toISOString();
    if (op === 'challenge') return json({ ok: true, value: { challenge: { challengeId: randomUUID(), nonce: randomUUID(), contextHash: 'c'.repeat(64), provider: 'turnstile', requestHash: body.intent.requestHash, expiresAt: at },
      presentation: { url: 'https://pathofmastery.gg/network-check?n=1', accessibleUrl: null } } });
    const clear = { status: 'clear', clearanceId: randomUUID(), requestHash: body.intent.requestHash, expiresAt: at };
    return json({ ok: true, value: op === 'verify' ? clear : { clearance: clear, resumePolicy: body.intent.resumePolicy } });
  }) as unknown as typeof fetch;
  let settled = false; let stage: any = null;
  const admission = createAdmission({ origin: 'http://127.0.0.1:4321', allowLoopback: true, limits, installation, sign: () => ({}), accountId: () => ACCOUNT,
    accessToken: async () => 't', fetch: fakeFetch, aiTimeoutMs: 5000, askUser: () => undefined });
  const waiting = admission.aiRequire('session', sessionBody, PANEL).then(v => { settled = true; return v; });
  await new Promise(r => setTimeout(r, 20));
  stage = await admission.begin(false);
  assert.equal(stage.status, 'ready'); assert.equal(stage.pending, 'AI request', 'the Pending line names the action');
  assert.equal((await admission.complete('XXXX.DUMMY.TOKEN.XXXX')).status, 'passed');
  await new Promise(r => setTimeout(r, 50));
  assert.equal(settled, false, 'the request is not retried by the pass alone');
  const c = await continueAi(admission, waiting);
  assert.equal(c.status, 'passed'); const headers = c.headers;
  assert.ok(headers?.['x-pom-clearance'], 'Continue hands the clearance to the one retry');
  assert.equal((await admission.resume()).status, 'expired', 'a second Continue retries nothing and says so');
});

test('a vote the site paused shows the banner, binds to the feed revision, and Continue sends it once', async () => {
  const post = { postId: randomUUID(), revisionId: randomUUID(), displayRevision: 3 };
  const challenged: any[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    const op = String(url).split('/api/network/')[1]; const body = JSON.parse(String(init.body)); const at = new Date(Date.now() + 300_000).toISOString();
    if (op === 'challenge') { challenged.push(body.intent); return json({ ok: true, value: { challenge: { challengeId: randomUUID(), nonce: randomUUID(), contextHash: 'c'.repeat(64), provider: 'turnstile', requestHash: body.intent.requestHash, expiresAt: at },
      presentation: { url: 'https://pathofmastery.gg/network-check?n=1', accessibleUrl: null } } }); }
    const clear = { status: 'clear', clearanceId: randomUUID(), requestHash: body.intent.requestHash, expiresAt: at };
    return json({ ok: true, value: op === 'verify' ? clear : { clearance: clear, resumePolicy: body.intent.resumePolicy } });
  }) as unknown as typeof fetch;
  const banners: string[] = []; const resent: unknown[] = [];
  const admission = createAdmission({ origin: 'http://127.0.0.1:4321', allowLoopback: true, limits, installation, sign: () => ({}), accountId: () => ACCOUNT,
    accessToken: async () => 't', fetch: fakeFetch, onBlocked: p => banners.push(p), resume: async (op, body) => { resent.push({ op, body }); return { state: 'done', result: { ok: true, value: { net: 1 } } }; } });
  admission.note('feed', {}, ACCOUNT, { ok: true, value: { items: [{ publishedRevision: post }], nextCursor: null } } as never);
  const vote = { request: { postId: post.postId, direction: 1, idempotencyKey: randomUUID() }, clientSequence: 1 };
  admission.note('vote', vote, ACCOUNT, { ok: false, code: 'HUMAN_CHECK_REQUIRED', message: 'x' } as never);
  assert.deepEqual(banners, ['Vote'], 'the banner names the paused vote; no dialog opens by itself');
  const stage: any = await admission.begin(false);
  assert.equal(stage.status, 'ready'); assert.equal(stage.pending, 'Vote');
  assert.deepEqual(challenged[0].target, post, 'the check is bound to the exact published revision of the voted post');
  assert.equal((await admission.begin(true) as any).status, 'ready', 'switching to the accessible check starts a second challenge');
  assert.deepEqual(challenged[1], challenged[0], 'the accessible challenge binds the same pending request (same request id and key)');
  assert.equal(challenged[0].operation, 'vote'); assert.equal(challenged[0].resumePolicy, 'once');
  assert.equal((await admission.complete('XXXX.DUMMY.TOKEN.XXXX')).status, 'passed');
  assert.deepEqual(resent, [], 'nothing is sent before Continue');
  const h = await admission.headers('vote', vote, ACCOUNT);
  assert.ok(h['x-pom-clearance'], 'the paused vote carries the approved clearance');
  assert.equal((await admission.resume()).status, 'passed');
  assert.deepEqual(resent, [{ op: 'vote', body: vote }], 'Continue resends the paused vote exactly once');
  assert.equal((await admission.resume()).status, 'expired'); assert.equal(resent.length, 1);
});

test('a publish paused for a check returns to its review; Continue never sends it', async () => {
  const resent: unknown[] = [];
  const admission = createAdmission({ origin: 'http://127.0.0.1:4321', allowLoopback: true, limits, installation, sign: () => ({}), accountId: () => ACCOUNT,
    accessToken: async () => 't', onBlocked: () => undefined, resume: async (op, body) => { resent.push({ op, body }); return { state: 'done', result: { ok: true, value: { net: 1 } } }; } });
  admission.note('publish', { request: {} }, ACCOUNT, { ok: false, code: 'HUMAN_CHECK_REQUIRED', message: 'x' } as never);
  assert.equal((await admission.resume()).status, 'expired', 'no approved clearance, nothing to resume (shown, not a silent close)');
  assert.deepEqual(resent, []);
});

test('an account switch resets the AI gate to Off (never "Expired" for the new account); sign-out asks to sign in', async () => {
  const { fixture } = await import('../src/main/aiGate/fixtures.js');
  const f = fixture();
  await f.gate.verify(PANEL, (await f.deps.target!())!);
  assert.equal(f.gate.state.status, 'ready');
  f.gate.reset();
  assert.deepEqual(f.gate.state, { status: 'off' });
  f.gate.invalidate('SIGN_IN_REQUIRED');
  assert.deepEqual(f.gate.state, { status: 'denied', code: 'SIGN_IN_REQUIRED' });
});

// Injected clock for the AI wait (no real 3-minute waits): a fake timer list the test fires by hand.
function fakeTimers() {
  const live = new Map<number, () => void>(); let next = 1;
  return { live, set: (fn: () => void) => { const id = next++; live.set(id, fn); return id; }, clear: (h: unknown) => { live.delete(h as number); },
    fireAll() { const fns = [...live.values()]; live.clear(); for (const f of fns) f(); } };
}
const checkFetch = (async (url: string, init: RequestInit) => {
  const op = String(url).split('/api/network/')[1]; const body = JSON.parse(String(init.body)); const at = new Date(Date.now() + 300_000).toISOString();
  if (op === 'challenge') return json({ ok: true, value: { challenge: { challengeId: randomUUID(), nonce: randomUUID(), contextHash: 'c'.repeat(64), provider: 'turnstile', requestHash: body.intent.requestHash, expiresAt: at },
    presentation: { url: 'https://pathofmastery.gg/network-check?n=1', accessibleUrl: null } } });
  const clear = { status: 'clear', clearanceId: randomUUID(), requestHash: body.intent.requestHash, expiresAt: at };
  return json({ ok: true, value: op === 'verify' ? clear : { clearance: clear, resumePolicy: body.intent.resumePolicy } });
}) as unknown as typeof fetch;

test('a passed check cancels the wait timer, so a late Continue still retries the request', async () => {
  const t = fakeTimers(); let expired = 0; let settled: unknown = 'pending';
  const admission = createAdmission({ origin: 'http://127.0.0.1:4321', allowLoopback: true, limits, installation, sign: () => ({}), accountId: () => ACCOUNT,
    accessToken: async () => 't', fetch: checkFetch, timers: t, onExpired: () => { expired++; }, askUser: () => undefined });
  const waiting = admission.aiRequire('session', sessionBody, PANEL).then(v => { settled = v; return v; });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(t.live.size, 1, 'the wait timer is armed while the check is open');
  assert.equal((await admission.begin(false)).status, 'ready');
  assert.equal((await admission.complete('XXXX.DUMMY.TOKEN.XXXX')).status, 'passed');
  assert.equal(t.live.size, 0, 'passing cancels the wait timer');
  t.fireAll(); await new Promise(r => setTimeout(r, 10));
  assert.equal(settled, 'pending', 'time passing after the pass changes nothing'); assert.equal(expired, 0);
  const c = await continueAi(admission, waiting);
  assert.equal(c.status, 'passed', 'a late Continue retries');
  assert.ok(c.headers?.['x-pom-clearance'], 'the request continues with the clearance');
});

test('expiring while the dialog shows keeps the request, says "expired", and Retry starts over; never a silent drop', async () => {
  const t = fakeTimers(); let expired = 0; let settled: unknown = 'pending';
  const admission = createAdmission({ origin: 'http://127.0.0.1:4321', allowLoopback: true, limits, installation, sign: () => ({}), accountId: () => ACCOUNT,
    accessToken: async () => 't', fetch: checkFetch, timers: t, onExpired: () => { expired++; }, askUser: () => undefined });
  const waiting = admission.aiRequire('session', sessionBody, PANEL).then(v => { settled = v; return v; });
  await new Promise(r => setTimeout(r, 10));
  assert.equal((await admission.begin(false)).status, 'ready');
  t.fireAll(); await new Promise(r => setTimeout(r, 10));
  assert.equal(expired, 1, 'the dialog is told the request expired');
  assert.equal(settled, 'pending', 'the request is not dropped while the dialog shows');
  assert.equal((await admission.complete('XXXX.DUMMY.TOKEN.XXXX')).status, 'expired', 'a token for the expired challenge says expired');
  assert.equal((await admission.resume()).status, 'expired', 'Continue says expired, it does not close as if it worked');
  assert.equal((await admission.begin(false)).status, 'ready', 'Retry starts a fresh check');
  assert.equal(t.live.size, 1, 'with a fresh wait');
  assert.equal((await admission.complete('XXXX.DUMMY.TOKEN.XXXX')).status, 'passed');
  const c = await continueAi(admission, waiting);
  assert.equal(c.status, 'passed');
  assert.ok(c.headers?.['x-pom-clearance'], 'the same request then continues');
});

test('with no dialog ever shown the wait still ends the request (denied), and Keep working locally ends it too', async () => {
  const t = fakeTimers();
  const a1 = createAdmission({ origin: 'http://127.0.0.1:4321', allowLoopback: true, limits, installation, sign: () => ({}), accountId: () => ACCOUNT,
    accessToken: async () => 't', fetch: checkFetch, timers: t, askUser: () => undefined });
  const w1 = a1.aiRequire('session', sessionBody, PANEL);
  await new Promise(r => setTimeout(r, 10)); t.fireAll();
  assert.equal(await w1, null, 'unanswered and never shown: denied after the wait');
  const a2 = createAdmission({ origin: 'http://127.0.0.1:4321', allowLoopback: true, limits, installation, sign: () => ({}), accountId: () => ACCOUNT,
    accessToken: async () => 't', fetch: checkFetch, timers: t, askUser: () => undefined });
  const w2 = a2.aiRequire('session', sessionBody, PANEL);
  await new Promise(r => setTimeout(r, 10)); await a2.begin(false); t.fireAll(); a2.cancel();
  assert.equal(await w2, null, 'expired then Keep working locally: denied');
  assert.equal(t.live.size, 0, 'no timer left behind');
});

// ---- A pending request is never dropped silently: the clearance can run out between the pass and Continue, or the site can
// refuse it on the retry. Fake clock for the clearance expiry and the wait; a fake site for /api/network/* and /api/ai/session.
function harness(opts: { refuseFirstClearance?: boolean; retryAnswer?: (n: number) => unknown } = {}) {
  let clock = Date.now(); const t = fakeTimers();
  const sessions: { clearance: string | null }[] = []; const issued: string[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const u = String(url); const body = JSON.parse(String(init.body ?? '{}'));
    if (u.includes('/api/network/')) {
      const op = u.split('/api/network/')[1]; const at = new Date(clock + 300_000).toISOString();
      if (op === 'challenge') return json({ ok: true, value: { challenge: { challengeId: randomUUID(), nonce: randomUUID(), contextHash: 'c'.repeat(64), provider: 'turnstile', requestHash: body.intent.requestHash, expiresAt: at },
        presentation: { url: 'https://pathofmastery.gg/network-check?n=1', accessibleUrl: null } } });
      const id = randomUUID(); if (op === 'admit') issued.push(id);
      const clear = { status: 'clear', clearanceId: id, requestHash: body.intent.requestHash, expiresAt: at };
      return json({ ok: true, value: op === 'verify' ? clear : { clearance: clear, resumePolicy: body.intent.resumePolicy } });
    }
    const h = init.headers as Record<string, string>; const c = h['x-pom-clearance'] ?? null; sessions.push({ clearance: c });
    if (!c || (opts.refuseFirstClearance && c === issued[0])) return json({ ok: false, code: 'HUMAN_CHECK_REQUIRED', message: 'x' }, 403);
    const custom = opts.retryAnswer?.(sessions.length); if (custom) return json(custom, 503);
    return json({ ok: true, value: { sessionId: 's' } });
  }) as unknown as typeof fetch;
  let asked = 0;
  const admission = createAdmission({ origin: 'http://127.0.0.1:4321', allowLoopback: true, limits, installation, sign: () => ({}), accountId: () => ACCOUNT,
    accessToken: async () => 't', fetch: fetchFn, timers: t, now: () => clock, askUser: () => { asked++; } });
  const backend = createAiBackend({ baseUrl: 'http://127.0.0.1:4321/', installation, accountId: () => ACCOUNT, token: async () => 't', appHeaders: async () => ({}), limits, allowLoopback: true,
    fetch: fetchFn, clearanceHeaders: async (r, b, a) => admission.aiCached(r, b, a) ?? {}, humanCheck: (r, b, a) => admission.aiRequire(r, b, a),
    humanCheckOutcome: (r, b, a, res, again) => admission.aiOutcome(r, b, a, res, again) });
  const tick = () => new Promise(r => setTimeout(r, 60));
  const pass = async () => { assert.equal((await admission.begin(false)).status, 'ready'); assert.equal((await admission.complete('XXXX.DUMMY.TOKEN.XXXX')).status, 'passed'); };
  return { admission, backend, sessions, t, tick, pass, advance: (ms: number) => { clock += ms; }, asked: () => asked };
}

test('never dropped: the clearance runs out between the pass and Continue -> "again", a fresh check, then Continue sends once', async () => {
  const h = harness(); let settled: unknown = 'pending';
  const post = h.backend.post('session', sessionBody, PANEL).then(r => { settled = r; return r; });
  await h.tick(); await h.pass();
  h.advance(10 * 60_000); // well past the clearance (300 s here; 600 s by default on the site)
  assert.equal((await h.admission.resume()).status, 'again', 'Continue says the check expired instead of closing');
  await h.tick(); assert.equal(settled, 'pending', 'the request is kept');
  await h.pass();
  assert.equal((await h.admission.resume()).status, 'passed');
  const r = await post; assert.equal(r.ok, true, 'the request goes through');
  assert.deepEqual(h.sessions.map(s => !!s.clearance), [false, true], 'the refused first try and exactly one send with a live clearance');
  assert.equal(h.asked(), 1, 'one dialog the whole time');
});

test('never dropped: the site refuses the clearance on the retry -> "again" in the same dialog, a fresh check, then Continue sends once', async () => {
  const h = harness({ refuseFirstClearance: true }); let settled: unknown = 'pending';
  const post = h.backend.post('session', sessionBody, PANEL).then(r => { settled = r; return r; });
  await h.tick(); await h.pass();
  assert.equal((await h.admission.resume()).status, 'again', 'the refused retry asks for a fresh check');
  assert.equal(settled, 'pending', 'the request is kept');
  await h.pass();
  assert.equal((await h.admission.resume()).status, 'passed');
  assert.equal((await post).ok, true);
  assert.deepEqual(h.sessions.map(s => !!s.clearance), [false, true, true], 'first try, the refused retry, the accepted retry');
  assert.equal(h.asked(), 1, 'no second dialog');
});

test('never silent: a retry the site answers with another failure is reported to the open dialog as sendFailed', async () => {
  const h = harness({ retryAnswer: () => ({ ok: false, code: 'AI_SERVICE_UNAVAILABLE', message: 'down' }) });
  const post = h.backend.post('session', sessionBody, PANEL);
  await h.tick(); await h.pass();
  assert.deepEqual(await h.admission.resume(), { status: 'sendFailed', code: 'AI_SERVICE_UNAVAILABLE' });
  const r = await post; assert.equal(r.ok ? null : r.code, 'AI_SERVICE_UNAVAILABLE', 'the caller gets the real answer too');
});

test('never dropped: a reloaded window asks again for a request that was waiting on the old window, even after its pass', async () => {
  const h = harness(); let settled: unknown = 'pending';
  const post = h.backend.post('session', sessionBody, PANEL).then(r => { settled = r; return r; });
  await h.tick(); await h.pass();
  assert.deepEqual(h.admission.hello(), { paused: null });
  assert.equal(h.asked(), 2, 'the new window is asked to show the check');
  assert.equal((await h.admission.begin(false)).status, 'ready', 'the new window shows a fresh check for the same request');
  h.t.fireAll(); await h.tick();
  assert.equal(settled, 'pending', 'still kept, even when the wait runs out while the new window shows it');
  await h.pass(); assert.equal((await h.admission.resume()).status, 'passed');
  assert.equal((await post).ok, true);
});

test('never dropped: a vote whose clearance ran out when Continue sent it comes back as "again", then sends once', async () => {
  const post = { postId: randomUUID(), revisionId: randomUUID(), displayRevision: 1 };
  const vote = { request: { postId: post.postId, direction: 1, idempotencyKey: randomUUID() }, clientSequence: 1 };
  let sends = 0;
  const admission: ReturnType<typeof createAdmission> = createAdmission({ origin: 'http://127.0.0.1:4321', allowLoopback: true, limits, installation, sign: () => ({}), accountId: () => ACCOUNT,
    accessToken: async () => 't', fetch: checkFetch, onBlocked: () => undefined,
    resume: async (op, body) => {
      sends++;
      const result = sends === 1 ? { ok: false, code: 'HUMAN_CHECK_REQUIRED', message: 'x' } : { ok: true, value: { net: 1 } };
      admission.note(op, body, ACCOUNT, result as never); // what the outbox's send does
      return { state: result.ok ? 'done' : 'review', result };
    } });
  admission.note('feed', {}, ACCOUNT, { ok: true, value: { items: [{ publishedRevision: post }], nextCursor: null } } as never);
  admission.note('vote', vote, ACCOUNT, { ok: false, code: 'HUMAN_CHECK_REQUIRED', message: 'x' } as never);
  assert.equal((await admission.begin(false)).status, 'ready'); assert.equal((await admission.complete('XXXX.DUMMY.TOKEN.XXXX')).status, 'passed');
  assert.equal((await admission.resume()).status, 'again', 'the refused send keeps the vote and asks for a fresh check');
  assert.equal((await admission.begin(false)).status, 'ready'); assert.equal((await admission.complete('XXXX.DUMMY.TOKEN.XXXX')).status, 'passed');
  assert.equal((await admission.resume()).status, 'passed');
  assert.equal(sends, 2, 'sent once per Continue, never dropped');
});
