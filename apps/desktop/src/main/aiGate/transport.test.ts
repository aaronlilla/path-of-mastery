import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createAiBackend } from './client.js';
import { fixture, limits, target } from './fixtures.js';
import { PANEL } from './gate.js';
import { ClientPairing } from './pairing.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(complete => { resolve = complete; });
  return { promise, resolve };
}

function streamingBackend() {
  let account = 'first-account';
  const reading = deferred();
  const release = deferred();
  const body = new ReadableStream<Uint8Array>({ async pull(controller) {
    reading.resolve(); await release.promise;
    controller.enqueue(new TextEncoder().encode(JSON.stringify({ ok: true, value: { synthetic: true } })));
    controller.close();
  } }, { highWaterMark: 0 });
  const backend = createAiBackend({ baseUrl: 'https://fixture.invalid', installation: 'a'.repeat(64),
    accountId: () => account, token: async () => 'synthetic-token', appHeaders: async () => ({}), limits,
    fetch: async () => new Response(body, { status: 200 }) });
  return { backend, reading, release, switchAccount: () => { account = 'second-account'; } };
}

test('a delayed response body is denied when the account changes after headers', async () => {
  const f = streamingBackend(); const result = f.backend.post('session', {}, PANEL);
  await f.reading.promise; f.switchAccount(); f.release.resolve();
  const response = await result;
  assert.equal(response.ok, false);
  if (!response.ok) assert.equal(response.code, 'CONNECTION_REVOKED');
});

test('an account switch during signing prevents the old-account request from being sent', async () => {
  let account = 'first-account'; let sent = 0;
  const signing = deferred(); const release = deferred();
  const backend = createAiBackend({ baseUrl: 'https://fixture.invalid', installation: 'a'.repeat(64),
    accountId: () => account, token: async () => 'synthetic-token', limits,
    appHeaders: async () => { signing.resolve(); await release.promise; return {}; },
    fetch: async () => { sent++; return Response.json({ ok: true, value: { synthetic: true } }); },
  });
  const result = backend.post('session', {}, PANEL);
  await signing.promise; account = 'second-account'; release.resolve();
  const response = await result;
  assert.equal(sent, 0, 'an old-account request is never sent');
  assert.equal(response.ok, false);
  if (!response.ok) assert.equal(response.code, 'CONNECTION_REVOKED');
});

test('an abort while reading the body cannot return a successful DTO', async () => {
  const f = streamingBackend(); const abort = new AbortController();
  const result = f.backend.post('session', {}, PANEL, abort.signal);
  await f.reading.promise; abort.abort(); f.release.resolve();
  const response = await result;
  assert.equal(response.ok, false);
  if (!response.ok) assert.equal(response.code, 'CONNECTION_REVOKED');
});

test('an abort ends a stalled body without waiting for its remaining bytes', async () => {
  const f = streamingBackend(); const abort = new AbortController();
  const result = f.backend.post('session', {}, PANEL, abort.signal);
  await f.reading.promise; abort.abort();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([result, new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('The aborted response kept waiting for bytes.')), 1000);
    })]);
    assert.equal(response.ok, false);
    if (!response.ok) assert.equal(response.code, 'CONNECTION_REVOKED');
  } finally { clearTimeout(timeout); f.release.resolve(); }
});

test('a delayed body succeeds while the account and signal remain current', async () => {
  const f = streamingBackend(); const result = f.backend.post('session', {}, PANEL);
  await f.reading.promise; f.release.resolve();
  assert.deepEqual(await result, { ok: true, value: { synthetic: true } });
});

test('a non-success HTTP status cannot grant access through a successful-looking DTO', async () => {
  const backend = createAiBackend({ baseUrl: 'https://fixture.invalid', installation: 'a'.repeat(64),
    accountId: () => 'fixture-account', token: async () => 'synthetic-token', appHeaders: async () => ({}), limits,
    fetch: async () => Response.json({ ok: true, value: { synthetic: true } }, { status: 500 }) });
  const result = await backend.post('session', {}, PANEL);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'ENTITLEMENT_UNAVAILABLE');
});

test('a normalized denial on a non-success HTTP status preserves its failure code', async () => {
  const denial = { ok: false, code: 'AI_ACCESS_REQUIRED', message: 'Synthetic denial.' };
  const backend = createAiBackend({ baseUrl: 'https://fixture.invalid', installation: 'a'.repeat(64),
    accountId: () => 'fixture-account', token: async () => 'synthetic-token', appHeaders: async () => ({}), limits,
    fetch: async () => Response.json(denial, { status: 403 }) });
  assert.deepEqual(await backend.post('session', {}, PANEL), denial);
});

const BRIDGE = process.env.POM_P24_BRIDGE ?? fileURLToPath(new URL('../../mcp-bridge/bridge.js', import.meta.url));
type Reply = { id: number; result?: unknown; error?: { code: number; message: string; data?: { code: string } } };
function bridge(dir: string, clientId?: string) {
  const child = spawn(process.execPath, [BRIDGE, '--data', dir, ...(clientId === undefined ? [] : ['--client', clientId])],
    { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  const lines = createInterface({ input: child.stdout });
  return {
    request: () => new Promise<Reply>((resolve, reject) => {
      const timeout = setTimeout(() => { cleanup(); reject(new Error('The bridge did not answer.')); }, 3000);
      const exit = () => { cleanup(); reject(new Error('The bridge exited before answering.')); };
      const line = (text: string) => { cleanup(); try { resolve(JSON.parse(text) as Reply); } catch { reject(new Error('The bridge returned invalid JSON.')); } };
      const cleanup = () => { clearTimeout(timeout); lines.off('line', line); child.off('exit', exit); child.off('error', exit); };
      lines.once('line', line); child.once('exit', exit); child.once('error', exit);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }) + '\n');
    }),
    close: async () => {
      lines.close();
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit'); child.kill(); await exited;
    },
  };
}
async function files(discovery = true) {
  const dir = await mkdtemp(join(tmpdir(), 'p24-transport-'));
  await mkdir(join(dir, 'assistant/clients'), { recursive: true });
  if (discovery) await writeFile(join(dir, 'assistant/mcp.json'), JSON.stringify({ port: 1, pid: process.pid, version: 'fixture' }));
  return dir;
}
function revoked(reply: Reply, clientId?: string, token?: string) {
  assert.equal(reply.id, 7); assert.equal(reply.error?.code, -32001);
  assert.equal(reply.error?.data?.code, 'CONNECTION_REVOKED');
  const serialized = JSON.stringify(reply);
  assert.ok(!clientId || !serialized.includes(clientId), 'the bridge does not expose the client identity');
  assert.ok(!token || !serialized.includes(token), 'the bridge does not expose credentials');
}

for (const state of ['deleted', 'expired', 'malformed', 'wrong-client', 'invalid-token', 'invalid-expiry'] as const) {
  test(`the real stdio bridge returns structured revocation for ${state} grants`, async () => {
    const dir = await files(); const clientId = randomUUID(); const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + (state === 'expired' ? -60000 : 60000)).toISOString();
    if (state !== 'deleted') await writeFile(join(dir, 'assistant/clients', `${clientId}.json`), state === 'malformed' ? '{' : JSON.stringify({
      clientId: state === 'wrong-client' ? randomUUID() : clientId, token: state === 'invalid-token' ? [token] : token,
      expiresAt: state === 'invalid-expiry' ? [expiresAt] : expiresAt,
    }));
    const session = bridge(dir, clientId);
    try { revoked(await session.request(), clientId, token); }
    finally { await session.close(); await rm(dir, { recursive: true, force: true }); }
  });
}
for (const clientId of [undefined, 'invalid-client']) {
  test(`an active discovery file refuses ${clientId === undefined ? 'a missing' : 'an invalid'} client identity`, async () => {
    const dir = await files(); const session = bridge(dir, clientId);
    try { revoked(await session.request(), clientId); }
    finally { await session.close(); await rm(dir, { recursive: true, force: true }); }
  });
}
test('a configured client with no discovery and a deleted grant is revoked', async () => {
  const dir = await files(false); const clientId = randomUUID(); const session = bridge(dir, clientId);
  try { revoked(await session.request(), clientId); }
  finally { await session.close(); await rm(dir, { recursive: true, force: true }); }
});
for (const configured of [false, true]) {
  test(`a closed app preserves the legacy message ${configured ? 'with a valid grant' : 'without client configuration'}`, async () => {
    const dir = await files(false); const clientId = configured ? randomUUID() : undefined;
    if (clientId) await writeFile(join(dir, 'assistant/clients', `${clientId}.json`), JSON.stringify({ clientId,
      token: randomBytes(32).toString('hex'), expiresAt: new Date(Date.now() + 60000).toISOString() }));
    const session = bridge(dir, clientId);
    try {
      const reply = await session.request(); assert.equal(reply.error?.code, -32000);
      assert.match(reply.error?.message ?? '', /not running/);
    } finally { await session.close(); await rm(dir, { recursive: true, force: true }); }
  });
}

test('the same stdio bridge forwards a paired request and then reports actual per-client revoke', async () => {
  const dir = await files(false); const f = fixture();
  const pairing = new ClientPairing({ directory: join(dir, 'assistant/clients'), gate: f.gate, limits, approvedIdentities: ['fixture-client'] });
  const pending = await pairing.begin('fixture-client', ['mcp:tools:list'], [target()]);
  await pairing.allow(pending.clientId);
  let forwarded = 0;
  const server = createServer((request, response) => {
    const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1] ?? '';
    assert.ok(pairing.actor(token), 'only the paired token is forwarded'); forwarded++;
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ jsonrpc: '2.0', id: 7, result: { tools: [] } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  await writeFile(join(dir, 'assistant/mcp.json'), JSON.stringify({ port: address.port, pid: process.pid, version: 'fixture' }));
  const session = bridge(dir, pending.clientId);
  try {
    assert.deepEqual((await session.request()).result, { tools: [] }); assert.equal(forwarded, 1);
    await pairing.revoke(pending.clientId);
    revoked(await session.request(), pending.clientId); assert.equal(forwarded, 1);
  } finally {
    await session.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
