import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { ApiResult } from '@pom/mastery-contracts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AssistantMcpServer } from '../src/main/assistant/mcpServer.js';
import { AssistantService } from '../src/main/assistant/service.js';
import { BUILD_TOOLS } from '../src/main/assistant/buildTools.js';
import { LOOT_TOOLS } from '../src/main/assistant/lootTools.js';
import { TOOL_SCOPES } from '../src/main/assistant/toolPolicy.js';
import { AUDIT_NOTE, PANEL_ONLY_NOTES } from '../src/main/assistant/tools.js';
import { fixture } from '../src/main/aiGate/fixtures.js';
import type { AiBackend } from '../src/main/aiGate/gate.js';
import type { TurnEvent } from '../src/shared/assistant/types.js';
import { ProposalStore } from '../src/main/assistant/proposals.js';
import { LfProposalStore } from '../src/main/assistant/lootTools.js';
import type { AssistantEngine, ToolContext } from '../src/main/assistant/tools.js';

test('a server without server authority cannot listen, regardless of force flags', async () => {
  const server = new AssistantMcpServer({ tools: [], version: 'fixture', context: {} as ToolContext });
  try { await assert.rejects(server.start()); assert.equal(server.port, 0); }
  finally { await server.stop(); }
});
test('Free, unavailable and revoked startup write no discovery and start no provider', async () => {
  for (const code of ['AI_ACCESS_REQUIRED','ENTITLEMENT_UNAVAILABLE','CONNECTION_REVOKED'] as const) {
    const f = fixture(); f.state.denied = code; const dir = await mkdtemp(join(tmpdir(), 'p24-free-'));
    const svc = new AssistantService({ ...f.deps, engine: { onEvent: () => () => undefined } as unknown as AssistantEngine, dataDir: dir, version: 'fixture', bridgePath: 'unused',
      env: { POM_FORCE_PRO: '1', POM_AUTOMATION: '1' } });
    svc.setContext({ buildId: 'b', buildKey: 'k', name: 'Fixture' });
    try {
      await svc.start(); await assert.rejects(svc.setConnectionsEnabled(true));
      assert.throws(() => svc.mcpUrl); assert.equal(existsSync(join(dir, 'assistant/mcp.json')), false);
    } finally { await svc.stop(); await rm(dir, { recursive: true, force: true }); }
  }
});
test('every existing tool has an explicit scope; new tools stay closed', () => {
  for (const tool of [...BUILD_TOOLS, ...LOOT_TOOLS]) assert.ok(TOOL_SCOPES[tool.name], tool.name);
});
test('actual HTTP clients cannot impersonate the panel; read grants cannot propose; revoke denies metadata', async () => {
  const f = fixture(); let operations = 0;
  const external = { actor: { clientId: '77777777-7777-4777-8777-777777777777', proof: 'fixture' }, origin: 'external' as const, scopes: ['mcp:tools:list','mcp:read'] as const };
  const server = new AssistantMcpServer({ version: 'fixture', context: { proposals: new ProposalStore() } as ToolContext,
    access: { ...f.access, external: token => token === 'paired-token' ? external : null },
    tools: ['getStats','proposeEdit'].map(name => ({ name, chip: name, description: 'Synthetic tool.', shape: {}, run: async (_args, ctx) => { operations++; return { origin: ctx.origin }; } })) });
  await server.start(); const client = new Client({ name: 'panel', version: 'fixture' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { Authorization: 'Bearer paired-token', 'x-pom-client': 'panel' } } }));
    assert.deepEqual((await client.listTools()).tools.map(t => t.name), ['getStats']);
    const read = await client.callTool({ name: 'getStats', arguments: {} });
    assert.ok(JSON.stringify(read).includes('external'));
    const denied = await client.callTool({ name: 'proposeEdit', arguments: {} });
    assert.equal(denied.isError, true); assert.equal(operations, 1);
    f.state.denied = 'CONNECTION_REVOKED'; await assert.rejects(client.listTools()); assert.equal(operations, 1);
    const raw = await fetch(server.url, { method: 'POST', headers: { Authorization: 'Bearer forged', 'x-pom-client': 'panel', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(raw.status, 401);
  } finally { await client.close(); await server.stop(); }
});

test('a panel tool call is authorized once, for its own scope, and still fails closed when the server says no', async () => {
  const f = fixture(); let operations = 0;
  const server = new AssistantMcpServer({ version: 'fixture', context: { proposals: new ProposalStore() } as ToolContext, access: f.access,
    tools: [{ name: 'getStats', chip: 'getStats', description: 'Synthetic tool.', shape: {}, run: async () => { operations++; return { ok: true }; } }] });
  await server.start(); const client = new Client({ name: 'panel', version: 'fixture' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { Authorization: `Bearer ${server.secret}`, 'x-pom-client': 'panel' } } }));
    const scopes = () => f.state.calls.filter(c => c.route === 'authorize').map(c => c.body.request.scope as string);
    const before = scopes().length;
    const read = await client.callTool({ name: 'getStats', arguments: {} });
    assert.notEqual(read.isError, true); assert.equal(operations, 1);
    // the tool's own operation and release; no extra metadata check in front of it
    assert.deepEqual(scopes().slice(before), ['mcp:read', 'mcp:read']);
    f.state.denied = 'AI_ACCESS_REQUIRED';
    const denied = await client.callTool({ name: 'getStats', arguments: {} });
    assert.equal(denied.isError, true); assert.equal(operations, 1);
  } finally { await client.close(); await server.stop(); }
});

test('service composition routes scoped Apply review without granting remote edits', async () => {
  const f = fixture(); const dir = await mkdtemp(join(tmpdir(), 'p24-review-'));
  let reviews = 0; const engineCalls: string[] = [];
  const svc = new AssistantService({ ...f.deps, dataDir: dir, version: 'fixture', bridgePath: 'unused',
    engine: { async send(command) { engineCalls.push(command); throw new Error('No engine command is needed to inspect review status.'); }, onEvent: () => () => undefined },
    scopedContext: async (_target, actor, tool, _args, context) => {
      assert.ok(actor.clientId); assert.equal(tool, 'requestApplyReview');
      return { ...context, reviewExternalProposal: async proposalId => {
        assert.equal(proposalId, 'saved-proposal'); reviews++;
        return { proposalId, status: 'pending', reviewRequired: true, reviewIn: 'app' as const };
      } };
    },
  });
  const client = new Client({ name: 'fixture-client', version: 'fixture' });
  try {
    await svc.start(); await svc.setConnectionsEnabled(true);
    const pending = (await svc.beginPairing('fixture-client', ['mcp:tools:list', 'mcp:apply'])).paired!.find(c => c.status === 'pending')!;
    await svc.allowPairing(pending.clientId);
    const config = JSON.parse(await readFile(join(dir, 'assistant/clients', `${pending.clientId}.json`), 'utf8')) as { token: string };
    await client.connect(new StreamableHTTPClientTransport(new URL(svc.mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${config.token}` } } }));
    assert.deepEqual((await client.listTools()).tools.map(t => t.name), ['requestApplyReview']);
    const result = await client.callTool({ name: 'requestApplyReview', arguments: { proposalId: 'saved-proposal' } });
    assert.equal(result.isError, undefined); assert.ok(JSON.stringify(result).includes('reviewRequired')); assert.equal(reviews, 1);
    assert.equal((await client.callTool({ name: 'saveDraftAsBuild', arguments: {} })).isError, true);
    assert.equal(reviews, 1); assert.deepEqual(engineCalls, []);
  } finally { await client.close(); await svc.stop(); await rm(dir, { recursive: true, force: true }); }
});

function pauseBackend(f: ReturnType<typeof fixture>, match: (route: string, body: unknown) => boolean) {
  let enter!: () => void; let resume!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const pending = new Promise<void>(resolve => { resume = resolve; });
  const original = f.backend.post.bind(f.backend); let paused = false;
  f.backend.post = async <T>(route: Parameters<AiBackend['post']>[0], body: unknown, actor: Parameters<AiBackend['post']>[2], signal?: AbortSignal): Promise<ApiResult<T>> => {
    if (!paused && match(route, body)) { paused = true; enter(); await pending; }
    return original<T>(route, body, actor, signal);
  };
  return { entered, resume };
}

test('pending turn cancellation stops once without spawning or releasing output', { timeout: 3000 }, async () => {
  for (const change of ['stop', 'context'] as const) {
    const f = fixture(); const pause = pauseBackend(f, route => route === 'authorize');
    const dir = await mkdtemp(join(tmpdir(), 'p24-cancel-')); const log = join(dir, 'fake.log');
    const fake = fileURLToPath(new URL('./fixtures/fakeCli.js', import.meta.url)); const events: TurnEvent[] = [];
    const svc = new AssistantService({ ...f.deps, engine: { onEvent: () => () => undefined } as unknown as AssistantEngine,
      dataDir: dir, version: 'fixture', bridgePath: 'unused', env: { ...process.env, POM_CLAUDE_CLI: fake, FAKE_LOG: log } });
    svc.setContext({ buildId: 'b', buildKey: 'k', name: 'Fixture' });
    svc.onPush(push => { if (push.kind === 'turn') events.push(push.event); });
    try {
      await svc.start(); const { turnId } = svc.send({ provider: 'claude', buildKey: 'k', text: 'fixture', skipRouter: true });
      await pause.entered;
      if (change === 'stop') svc.stopTurn(turnId); else svc.setContext({ buildId: 'b2', buildKey: 'k2', name: 'Other fixture' });
      pause.resume(); await new Promise(resolve => setTimeout(resolve, 50));
      assert.deepEqual(events.map(event => event.type), ['stopped'], change);
      assert.equal(existsSync(log), false); assert.equal(svc.busy, false);
    } finally { pause.resume(); await svc.stop(); await rm(dir, { recursive: true, force: true }); }
  }
});

test('cancelled inline imports stay bound to the original turn and never operate', { timeout: 3000 }, async () => {
  const f = fixture(); const pause = pauseBackend(f, (route, body) => route === 'authorize' && (body as { request: { scope: string } }).request.scope === 'mcp:propose');
  const dir = await mkdtemp(join(tmpdir(), 'p24-inline-')); let operations = 0; const events: TurnEvent[] = [];
  const svc = new AssistantService({ ...f.deps, scopedContext: async (_target, _actor, _tool, _args, ctx) => { operations++; return ctx; },
    engine: { onEvent: () => () => undefined } as unknown as AssistantEngine, dataDir: dir, version: 'fixture', bridgePath: 'unused' });
  svc.setContext({ buildId: 'b', buildKey: 'k', name: 'Fixture' });
  svc.onPush(push => { if (push.kind === 'turn') events.push(push.event); });
  try {
    await svc.start(); const { turnId } = svc.send({ provider: 'claude', buildKey: 'k', text: 'A'.repeat(450), skipRouter: true });
    await pause.entered; svc.stopTurn(turnId); pause.resume(); await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(operations, 0); assert.deepEqual(events.map(event => event.type), ['stopped']);
  } finally { pause.resume(); await svc.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('revocation during MCP startup leaves no listener or discovery', { timeout: 3000 }, async () => {
  // Startup is enable verify (opens the session) -> syncPro verify -> MCP start verify; the last two reuse the session with a
  // server status round trip. Pause on the MCP start one (the second status call).
  const f = fixture(); let checks = 0;
  const pause = pauseBackend(f, (route, body) => route === 'request' && (body as { action?: string }).action === 'status' && ++checks === 2);
  const dir = await mkdtemp(join(tmpdir(), 'p24-start-race-'));
  const svc = new AssistantService({ ...f.deps, engine: { onEvent: () => () => undefined } as unknown as AssistantEngine, dataDir: dir, version: 'fixture', bridgePath: 'unused' });
  svc.setContext({ buildId: 'b', buildKey: 'k', name: 'Fixture' });
  try {
    await svc.start(); const start = svc.setConnectionsEnabled(true); const rejected = assert.rejects(start);
    await pause.entered; f.gate.invalidate('CONNECTION_REVOKED'); pause.resume(); await rejected;
    assert.throws(() => svc.mcpUrl); assert.equal(existsSync(join(dir, 'assistant/mcp.json')), false);
  } finally { pause.resume(); await svc.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('cancelled router decisions cannot run a lookup or release an answer', { timeout: 3000 }, async () => {
  const f = fixture(); const dir = await mkdtemp(join(tmpdir(), 'p24-router-cancel-'));
  let enter!: () => void; let resume!: () => void; let operations = 0; let engineCalls = 0;
  const entered = new Promise<void>(resolve => { enter = resolve; }); const pending = new Promise<void>(resolve => { resume = resolve; });
  const events: TurnEvent[] = [];
  const svc = new AssistantService({ ...f.deps, scopedContext: async (_target, _actor, _tool, _args, ctx) => { operations++; return ctx; },
    jevDecide: async () => { enter(); await pending; return { route: { choice: 'stat', confidence: 1 } }; },
    engine: { send: async () => { engineCalls++; throw new Error('Synthetic engine must not run.'); }, onEvent: () => () => undefined } as unknown as AssistantEngine,
    dataDir: dir, version: 'fixture', bridgePath: 'unused' });
  svc.setContext({ buildId: 'b', buildKey: 'k', name: 'Fixture' });
  svc.onPush(push => { if (push.kind === 'turn') events.push(push.event); });
  try {
    await svc.start(); await svc.setPrefs({ jevRouter: true });
    const { turnId } = svc.send({ provider: 'claude', buildKey: 'k', text: 'fixture value' });
    await entered; svc.stopTurn(turnId); resume(); await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(operations, 0); assert.equal(engineCalls, 0); assert.deepEqual(events.map(event => event.type), ['stopped']);
  } finally { resume(); await svc.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('local Solve starts without AI opt-in while entitlement is denied or unavailable', async () => {
  for (const code of ['AI_ACCESS_REQUIRED', 'ENTITLEMENT_UNAVAILABLE'] as const) {
    const f = fixture(); f.state.denied = code; f.gate.invalidate(code);
    const dir = await mkdtemp(join(tmpdir(), 'p24-local-solve-')); const commands: string[] = []; const statuses: string[] = [];
    const engine = { onEvent: () => () => undefined, send: async (command: string) => {
      commands.push(command);
      if (command === 'solveStart') return { solveId: 'synthetic' };
      if (command === 'solveStep') return { done: true };
      if (command === 'solveCancel') return {};
      throw new Error('Unexpected synthetic engine command.');
    } } as unknown as AssistantEngine;
    const svc = new AssistantService({ ...f.deps, engine, dataDir: dir, version: 'fixture', bridgePath: 'unused' });
    svc.setContext({ buildId: 'b', buildKey: 'k', name: 'Fixture' });
    svc.onPush(push => { if (push.kind === 'solve') statuses.push(push.state.status); });
    try {
      await svc.start(); const result = await svc.solve.run({ skill: 'Synthetic skill', wealth: 'league-start', assume: { playMode: 'mapping' } });
      assert.equal(result.status, 'running'); assert.deepEqual(commands, ['solveStart']);
      assert.equal(statuses.includes('shortlisting'), false); assert.deepEqual(f.state.calls, []);
    } finally { await svc.solve.stop(); await svc.stop(); await rm(dir, { recursive: true, force: true }); }
  }
});

test('a missing AI gate cannot open provider login or restart Desktop', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'p24-no-ai-')); const log = join(dir, 'fake.log');
  const fake = fileURLToPath(new URL('./fixtures/fakeCli.js', import.meta.url));
  const svc = new AssistantService({ engine: { onEvent: () => () => undefined } as unknown as AssistantEngine,
    dataDir: dir, version: 'fixture', bridgePath: 'unused', env: { ...process.env, POM_CLAUDE_CLI: fake, FAKE_LOG: log } });
  svc.setContext({ buildId: 'b', buildKey: 'k', name: 'Fixture' });
  try {
    await svc.start(); await assert.rejects(svc.verifyAi());
    assert.equal((await svc.openLogin('claude')).started, false); assert.equal(await svc.restartDesktop(), false);
    assert.equal(existsSync(log), false);
  } finally { await svc.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('MCP proposal release denial publishes no cards and preserves saved proposals', async () => {
  const f = fixture(); const dir = await mkdtemp(join(tmpdir(), 'p24-proposal-release-')); const file = join(dir, 'proposals.json');
  const proposals = new ProposalStore(file); const filters = new LfProposalStore(); let buildId = ''; let filterId = ''; let emitted = 0;
  const input = { buildId: 'synthetic-build', buildKey: 'k', baseHash: 'synthetic-hash', title: 'Synthetic change', kind: 'changes' as const,
    edits: [], removedIds: [], addedIds: [], removed: [], added: [], lines: [], gems: [], changes: [], origin: 'panel' as const };
  const saved = proposals.create(input); proposals.onCreated(() => { emitted++; }); filters.onCreated(() => { emitted++; });
  const server = new AssistantMcpServer({ version: 'fixture', access: f.access, context: { proposals, loot: { proposals: filters } } as unknown as Omit<ToolContext, 'origin'>,
    tools: [{ name: 'proposeEdit', chip: 'Fixture', description: 'Synthetic proposal.', shape: {}, run: async (_args, ctx) => {
      buildId = ctx.proposals.create(input).id;
      filterId = ctx.loot!.proposals.create({ filterId: 'synthetic-filter', title: 'Synthetic change', changes: [] }).id;
      f.state.denied = 'AI_ACCESS_REQUIRED'; return { buildId, filterId };
    } }] });
  const client = new Client({ name: 'fixture', version: 'fixture' });
  try {
    await server.start(); await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { Authorization: `Bearer ${server.secret}` } } }));
    assert.equal((await client.callTool({ name: 'proposeEdit', arguments: {} })).isError, true);
    assert.ok(buildId && filterId); assert.equal(proposals.get(buildId), undefined); assert.equal(filters.get(filterId), undefined);
    assert.equal(emitted, 0); assert.deepEqual(proposals.forBuild('k').map(proposal => proposal.id), [saved.id]);
    assert.deepEqual(new ProposalStore(file).forBuild('k').map(proposal => proposal.id), [saved.id]);
  } finally { await client.close(); await server.stop(); await rm(dir, { recursive: true, force: true }); }
});
test('outside clients list none of the 13 closed tools and get no panel-only note', async () => {
  const f = fixture();
  const external = { actor: { clientId: '77777777-7777-4777-8777-777777777777', proof: 'fixture' }, origin: 'external' as const, scopes: ['mcp:tools:list','mcp:read','mcp:propose'] as const };
  const closed = ['compareBuilds','listLibrary','listSharedItems','equipSharedItem','listCharacters','importCharacter','getWealth','searchTrade','upgradeCandidates','startSolve','getSolve','stopSolve','addLeads'];
  const server = new AssistantMcpServer({ version: 'fixture', context: { proposals: new ProposalStore() } as ToolContext,
    access: { ...f.access, external: token => token === 'paired-token' ? external : null },
    tools: [...closed, 'applySolveResult', 'getStats'].map(name => ({ name, chip: name, description: 'Synthetic tool.', shape: {}, run: async () => ({ note: `Numbers. ${PANEL_ONLY_NOTES.join(' ')} ${AUDIT_NOTE} Done.` }) })) });
  await server.start(); const client = new Client({ name: 'outside', version: 'fixture' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { Authorization: 'Bearer paired-token' } } }));
    assert.deepEqual((await client.listTools()).tools.map(t => t.name), ['getStats']);
    const text = JSON.stringify(await client.callTool({ name: 'getStats', arguments: {} }));
    assert.ok(text.includes('Numbers.') && text.includes('Done.')); assert.ok(!text.includes('buildAudit'));
    assert.ok(!/The panel now shows|app prints it under your answer|Check line/.test(text), text);
  } finally { await client.close(); await server.stop(); }
});
