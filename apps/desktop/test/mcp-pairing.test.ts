import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClientPairing } from '../src/main/aiGate/pairing.js';
import { composeAssistantAi } from '../src/main/mastery/assistantGate.js';
import { fixture, target, limits } from '../src/main/aiGate/fixtures.js';
import { fileAccess } from '../src/main/assistant/secretFile.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AssistantService } from '../src/main/assistant/service.js';
import type { AssistantEngine } from '../src/main/assistant/tools.js';
import { AiDenied, AiGate, PANEL, canonicalJson, type AiBackend, type AiActor } from '../src/main/aiGate/gate.js';
import { parseId, type ApiResult } from '@pom/mastery-contracts';

test('pairing needs explicit Allow, private per-client config and current server grants on reconnect', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'p24-pair-')); const f = fixture();
  const p = new ClientPairing({ directory: dir, gate: f.gate, limits, approvedIdentities: ['fixture-client'] });
  try {
    const pending = await p.begin('fixture-client', ['mcp:tools:list','mcp:read','mcp:propose'], [target()]);
    assert.equal(pending.lastUsedAt, null); assert.equal(pending.paused, false);
    assert.equal(pending.status, 'pending'); assert.equal(JSON.stringify(p.views()).includes('proof'), false);
    await assert.rejects(readFile(join(dir, `${pending.clientId}.json`)), /ENOENT/);
    await p.allow(pending.clientId);
    const data = JSON.parse(await readFile(join(dir, `${pending.clientId}.json`), 'utf8'));
    assert.equal(p.actor(data.token)?.actor.clientId, pending.clientId);
    assert.equal(p.actor('forged'), null); assert.equal(p.views()[0]?.status, 'paired');
    assert.ok((await fileAccess(join(dir, `${pending.clientId}.json`))).length > 0);
    p.clear(); assert.equal(p.actor(data.token), null);
    await p.reconnect(); assert.equal(p.actor(data.token)?.actor.clientId, pending.clientId);
    f.state.denied = 'CONNECTION_REVOKED'; await p.reconnect(); assert.equal(p.actor(data.token), null);
    assert.equal(p.views()[0]?.paused, true);
    await p.revoke(pending.clientId); await assert.rejects(readFile(join(dir, `${pending.clientId}.json`)), /ENOENT/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('the app pairs Claude Code, Codex CLI and Claude Desktop, and nothing else', async () => {
  const f = fixture();
  const { pairing } = composeAssistantAi({ library: {}, limits, ai: f.gate, documents: {} } as never, {} as never, () => null);
  const p = new ClientPairing({ directory: '', gate: f.gate, ...pairing! });
  for (const name of ['Claude Code', 'Codex CLI', 'Claude Desktop']) assert.equal((await p.begin(name, ['mcp:tools:list', 'mcp:propose'], [target()])).status, 'pending');
  await assert.rejects(p.begin('Some Other App', ['mcp:tools:list'], [target()]), (e: AiDenied) => e.code === 'VALIDATION_FAILED');
});
test('unapproved identities, shell scopes and expired pending grants are denied', async () => {
  const f = fixture(); const p = new ClientPairing({ directory: '', gate: f.gate, limits, approvedIdentities: ['fixture-client'] });
  await assert.rejects(p.begin('unapproved', ['mcp:read'], [target()]));
  await assert.rejects(p.begin('fixture-client', ['shell' as never], [target()]));
  await assert.rejects(p.allow('missing'));
});

test('revoking one paired client preserves the other client and shared listener', { timeout: 10000 }, async () => {
  const f = fixture(); const dir = await mkdtemp(join(tmpdir(), 'p24-two-clients-')); const releases: Array<string | null> = [];
  const engine = { onEvent: () => () => undefined, send: async (command: string) => {
    assert.equal(command, 'getBuildXml'); return { buildXml: '<PathOfBuilding><Notes>Synthetic note.</Notes></PathOfBuilding>' };
  } } as unknown as AssistantEngine;
  const svc = new AssistantService({ ...f.deps, releaseScopedContext: async actor => { releases.push(actor?.clientId ?? null); }, engine, dataDir: dir, version: 'fixture', bridgePath: 'unused' });
  svc.setContext({ buildId: 'b', buildKey: 'k', name: 'Fixture' });
  const clients: Client[] = [];
  try {
    await svc.start(); await svc.setConnectionsEnabled(true); const url = svc.mcpUrl;
    const ids: string[] = [];
    for (let index = 0; index < 2; index++) {
      const info = await svc.beginPairing('fixture-client', ['mcp:tools:list', 'mcp:read']);
      const id = info.paired!.find(client => client.status === 'pending')!.clientId; ids.push(id);
      await svc.allowPairing(id);
      const local = JSON.parse(await readFile(join(dir, 'assistant/clients', `${id}.json`), 'utf8')) as { token: string };
      const client = new Client({ name: `fixture-${index}`, version: 'fixture' }); clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${local.token}` } } }));
      assert.ok((await client.listTools()).tools.some(tool => tool.name === 'getNotes'));
      // tools/list skips the gate (speed); a real tool call goes through access and marks the client used.
      assert.equal((await client.callTool({ name: 'getNotes', arguments: {} })).isError, undefined);
      assert.equal((await svc.connectorInfo()).paired?.find(client => client.clientId === id)?.paused, false);
      assert.ok((await svc.connectorInfo()).paired?.find(client => client.clientId === id)?.lastUsedAt);
    }
    const info = await svc.revokeConnections(ids[0]!);
    assert.equal(info.running, true); assert.equal(info.enabled, true); assert.equal(svc.mcpUrl, url);
    assert.equal(existsSync(join(dir, 'assistant/mcp.json')), true); assert.deepEqual(releases, [ids[0]]);
    await assert.rejects(clients[0]!.listTools());
    assert.ok((await clients[1]!.listTools()).tools.some(tool => tool.name === 'getNotes'));
    const result = await clients[1]!.callTool({ name: 'getNotes', arguments: {} });
    assert.equal(result.isError, undefined); assert.match(JSON.stringify(result), /Synthetic note/);
    assert.equal(f.gate.state.status, 'ready');
    assert.ok(f.state.calls.some(call => call.route === 'revoke' && call.body.clientId === ids[0]));
  } finally { await Promise.all(clients.map(client => client.close())); await svc.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('a paired client keeps working after the open build is saved; a revoked client does not', { timeout: 10000 }, async () => {
  const f = fixture(); const dir = await mkdtemp(join(tmpdir(), 'p24-follow-'));
  let open = target();
  const gate = new AiGate({ backend: f.backend, limits, current: async ref => canonicalJson(ref) === canonicalJson(open) });
  const engine = { onEvent: () => () => undefined, send: async () => ({ buildXml: '<PathOfBuilding><Notes>Synthetic note.</Notes></PathOfBuilding>' }) } as unknown as AssistantEngine;
  const svc = new AssistantService({ ...f.deps, ai: gate, target: async () => open, engine, dataDir: dir, version: 'fixture', bridgePath: 'unused' });
  svc.setContext({ buildId: 'b', buildKey: 'k', name: 'Fixture' });
  const client = new Client({ name: 'fixture', version: 'fixture' });
  try {
    await svc.start(); await svc.setConnectionsEnabled(true);
    const id = (await svc.beginPairing('fixture-client', ['mcp:tools:list', 'mcp:read'])).paired!.find(c => c.status === 'pending')!.clientId;
    await svc.allowPairing(id);
    const local = JSON.parse(await readFile(join(dir, 'assistant/clients', `${id}.json`), 'utf8')) as { token: string };
    await client.connect(new StreamableHTTPClientTransport(new URL(svc.mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${local.token}` } } }));
    assert.equal((await client.callTool({ name: 'getNotes', arguments: {} })).isError, undefined);
    // The player saves: the open build has a new revision.
    open = { ...open, revisionId: parseId('revision', '44444444-4444-4444-8444-444444444444'), payloadHash: parseId('hash', 'b'.repeat(64)) };
    const after = await client.callTool({ name: 'getNotes', arguments: {} });
    assert.equal(after.isError, undefined); assert.match(JSON.stringify(after), /Synthetic note/);
    assert.ok(f.state.calls.some(c => c.route === 'authorize' && c.body.request.clientId === id && canonicalJson(c.body.request.target) === canonicalJson(open)));
    assert.equal((await svc.connectorInfo()).paired?.find(c => c.clientId === id)?.paused, false);
    await svc.revokeConnections(id);
    await assert.rejects(client.callTool({ name: 'getNotes', arguments: {} }));
  } finally { await client.close(); await svc.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('single client revocation aborts only its gate work and leaves peers authorized', async () => {
  const f = fixture(); const original = f.backend.post.bind(f.backend); const signals = new Map<string, AbortSignal>();
  f.backend.post = async <T>(route: Parameters<AiBackend['post']>[0], body: unknown, actor: AiActor, signal?: AbortSignal): Promise<ApiResult<T>> => {
    if (actor.clientId && signal) signals.set(actor.clientId, signal);
    return original<T>(route, body, actor, signal);
  };
  await f.gate.verify(PANEL, target());
  const first = '77777777-7777-4777-8777-777777777777'; const second = '88888888-8888-4888-8888-888888888888';
  let enterFirst!: () => void; let enterSecond!: () => void; let resume!: () => void;
  const enteredFirst = new Promise<void>(resolve => { enterFirst = resolve; }); const enteredSecond = new Promise<void>(resolve => { enterSecond = resolve; });
  const pending = new Promise<void>(resolve => { resume = resolve; });
  const firstRun = f.gate.run({ clientId: first }, 'mcp:read', target(), {}, async () => { enterFirst(); await pending; return 'first'; }).then(value => ({ value }), error => ({ error }));
  const secondRun = f.gate.run({ clientId: second }, 'mcp:read', target(), {}, async () => { enterSecond(); await pending; return 'second'; }).then(value => ({ value }), error => ({ error }));
  try {
    await Promise.all([enteredFirst, enteredSecond]); await f.gate.revoke(first);
    assert.equal(signals.get(first)?.aborted, true); assert.equal(signals.get(second)?.aborted, false);
    resume(); const a = await firstRun; const b = await secondRun;
    assert.ok('error' in a && a.error instanceof AiDenied && a.error.code === 'CONNECTION_REVOKED');
    assert.deepEqual(b, { value: 'second' }); assert.equal(f.gate.state.status, 'ready');
  } finally { resume(); await Promise.all([firstRun, secondRun]); }
});

test('actor-specific authorization denials do not invalidate peers or account readiness', async () => {
  for (const code of ['CONNECTION_REVOKED', 'REVISION_CONFLICT', 'VALIDATION_FAILED'] as const) {
    const f = fixture(); const first = '77777777-7777-4777-8777-777777777777'; const original = f.backend.post.bind(f.backend);
    f.backend.post = async <T>(route: Parameters<AiBackend['post']>[0], body: unknown, actor: AiActor, signal?: AbortSignal): Promise<ApiResult<T>> =>
      actor.clientId === first ? { ok: false, code, message: 'Synthetic actor denial.' } : original<T>(route, body, actor, signal);
    await f.gate.verify(PANEL, target());
    await assert.rejects(f.gate.run({ clientId: first }, 'mcp:read', target(), {}, async () => 'private'), error => error instanceof AiDenied && error.code === code);
    assert.equal(f.gate.state.status, 'ready');
    assert.equal(await f.gate.run({ clientId: '88888888-8888-4888-8888-888888888888' }, 'mcp:read', target(), {}, async () => 'peer'), 'peer');
  }
});
