import assert from 'node:assert/strict';
import test from 'node:test';
import { TOOLS, type AssistantEngine, type ToolContext } from '../assistant/tools.js';
import { ProposalStore } from '../assistant/proposals.js';
import { LfProposalStore } from '../assistant/lootTools.js';
import { emptyState, LootFilterStore, newFilterDoc } from '../lootfilter/store.js';
import { limits, target, fixture as authorizationFixture } from './fixtures.js';
import { hashJson, PANEL } from './gate.js';
import { buildSourceHash, createSelectedDocumentContext, panelClosed, type SelectedDocumentBinding } from './scopedContext.js';
import { ResultLog } from '../assistant/results.js';
import { AssistantMcpServer } from '../assistant/mcpServer.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { BUILD_TOOLS } from '../assistant/buildTools.js';
import { JEWEL_TYPES } from '../../renderer/timeless/timelessData.js';
import { createProposalTransaction } from './proposalTransaction.js';
import { APPROVED_CHANGE_TOOLS } from '../assistant/approvedChanges.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngineConnection } from '../engineConnection.js';
import { BuildStore } from '../library/buildStore.js';
import { composeAssistantAi } from '../mastery/assistantGate.js';
import type { ProcessHandle } from '../../shared/processHandle.js';

function fixture() {
  let current = true;
  let next = 0;
  const xml = '<PathOfBuilding><Build level="1"/><Notes>private notes</Notes></PathOfBuilding>';
  const builds = new Map([['active', xml]]);
  const sent: string[] = [];
  const calls: Array<{ command: string; params: Record<string, unknown> }> = [];
  const engine: AssistantEngine = {
    async send(command, params) {
      sent.push(command);
      const input = params as Record<string, unknown>;
      calls.push({ command, params: input });
      if (command === 'loadBuild') { const buildId = `scratch${++next}`; builds.set(buildId, String(input.buildXml)); return { buildId } as never; }
      if (command === 'getBuildXml') { if (!builds.has(String(input.buildId))) throw new Error(`unknown build id ${String(input.buildId)}`); return { buildXml: builds.get(String(input.buildId)) } as never; }
      if (command === 'getStats') return { stats: [] } as never;
      if (command === 'treeState') return { tree: { allocated: [] } } as never;
      if (command === 'spectreCatalog') return { spectres: [{ id: 'synthetic-spectre', name: 'Synthetic spectre' }] } as never;
      if (command === 'calcsView') return { mainSkill: { name: 'Synthetic skill' }, sections: [{ id: 'fixture-section', shown: true,
        subSections: [{ label: 'Fixture table', rows: [{ label: 'Fixture row', cells: ['12'], cellDetails: [[{ modName: 'FixtureStat' }]] }] }] }] } as never;
      if (command === 'calcsMods') return { table: { named: true, rows: [{ value: '12', sourceName: 'Fixture source', name: 'FixtureStat' }] } } as never;
      if (command === 'timelessStatus') return { missing: [] } as never;
      if (command === 'timelessInfo') return { sockets: [{ id: 1, label: 'Synthetic socket', keystone: '' }] } as never;
      if (command === 'timelessMods') return { mods: [{ id: 'fixture-mod', label: 'Synthetic passive', descriptions: ['Synthetic effect.'] }] } as never;
      if (command === 'timelessStart') return { started: true } as never;
      if (command === 'timelessStep') return { done: true, active: false } as never;
      if (command === 'timelessRows') return { total: 0, desired: [], rows: [] } as never;
      if (command === 'itemPool') return { pool: { table: { fixture: ['Synthetic enchantment'] }, sources: [{ name: 'fixture', label: 'Fixture source' }] } } as never;
      if (command === 'itemInfo') return { item: { mods: [] } } as never;
      if (command === 'closeBuild') builds.delete(String(input.buildId));
      return {} as never;
    },
    onEvent: () => () => undefined,
  };
  const context: ToolContext = { engine, open: () => ({ buildId: 'active', name: 'Selected', buildKey: 'local:selected' }),
    proposals: new ProposalStore(), results: new ResultLog(), tree: {} as never, origin: 'panel', library: {} as never,
    shared: {} as never, character: {} as never, wealth: {} as never, trade: {} as never, solve: {} as never };
  const binding: SelectedDocumentBinding = { ref: target(), kind: 'build', engineBuildId: 'active',
    libraryBuildId: 'selected', buildKey: 'local:selected', name: 'Selected', xmlHash: buildSourceHash(xml) };
  const deps = { limits, resolve: async () => binding, current: async () => current };
  return { ...createSelectedDocumentContext(deps), context, binding, builds, sent, calls, xml, change: () => { current = false; } };
}

test('selected build context strips notes, unrelated capabilities, and rejects foreign IDs', async () => {
  const f = fixture();
  const scoped = await f.scopedContext(target(), PANEL, 'getBuildSummary', {}, f.context);
  assert.notEqual(scoped.open()?.buildId, 'active');
  assert.equal(scoped.open()?.buildKey, 'local:selected');
  const { buildXml } = await scoped.engine.send('getBuildXml', { buildId: scoped.open()!.buildId });
  assert.ok(!buildXml.includes('private notes'));
  for (const key of ['library', 'shared', 'character', 'wealth', 'trade', 'loot']) assert.equal(scoped[key as keyof ToolContext], undefined);
  // the panel reads and applies its own solve (632269139); an outside client gets none of these
  assert.equal(scoped.solve, f.context.solve);
  const outside = await f.scopedContext(target(), { clientId: 'client-a' }, 'getBuildSummary', {}, f.context);
  for (const key of ['library', 'shared', 'character', 'wealth', 'trade', 'solve', 'loot']) assert.equal(outside[key as keyof ToolContext], undefined);
  await assert.rejects(scoped.engine.send('getBuildXml', { buildId: 'active' }));
  await assert.rejects(scoped.engine.send('edit', { buildId: scoped.open()!.buildId, edit: { kind: 'setLevel', level: 2 } }));
  await assert.rejects(f.scopedContext(target(), PANEL, 'getBuildSummary', { libraryBuildId: 'foreign' }, f.context));
  await assert.rejects(f.scopedContext(target(), PANEL, 'getNotes', {}, f.context));
  await assert.rejects(f.scopedContext(target(), PANEL, 'manageLibraryBuild', {}, f.context));
  await f.release();
  assert.deepEqual([...f.builds.keys()], ['active']);
});

test('panel trade tools get trade even when another tool opened the session first', async () => {
  const f = fixture();
  assert.equal((await f.scopedContext(target(), PANEL, 'getItems', {}, f.context)).trade, undefined);
  assert.equal((await f.scopedContext(target(), PANEL, 'upgradeCandidates', {}, f.context)).trade, f.context.trade);
  assert.equal((await f.scopedContext(target(), PANEL, 'getItems', {}, f.context)).trade, undefined);
  assert.equal((await f.scopedContext(target(), { clientId: 'client-a' }, 'getItems', {}, f.context)).trade, undefined);
  await assert.rejects(f.scopedContext(target(), { clientId: 'client-a' }, 'upgradeCandidates', {}, f.context));
  await f.release();
});

test('the panel may set up, run, read and stop its own solve; an outside client may not', async () => {
  const f = fixture();
  for (const tool of ['startSolve', 'getSolve', 'stopSolve', 'applySolveResult']) {
    assert.equal(panelClosed(tool), false, tool);
    assert.equal((await f.scopedContext(target(), PANEL, tool, {}, f.context)).solve, f.context.solve, tool);
    await assert.rejects(f.scopedContext(target(), { clientId: 'client-a' }, tool, {}, f.context), tool);
  }
  await f.release();
});

test('client selections isolate drafts and result logs, including panel identity', async () => {
  const f = fixture();
  const a = await f.scopedContext(target(), { clientId: 'client-a' }, 'startDraft', {}, f.context);
  const b = await f.scopedContext(target(), { clientId: 'client-b' }, 'startDraft', {}, f.context);
  const p = await f.scopedContext(target(), PANEL, 'startDraft', {}, f.context);
  const draft = await a.drafts!.create('<PathOfBuilding/>', { name: 'Draft', from: 'open', baseKey: 'local:selected', baseHash: 'synthetic' });
  assert.equal(b.drafts!.get(draft.id), undefined);
  assert.notEqual(a.results, b.results);
  assert.notEqual(a.results, p.results);
  const ref = a.results!.add('getStats', { secret: true });
  assert.equal(b.results!.get(ref), undefined);
  await assert.rejects(f.scopedContext(target(), { clientId: 'client-b' }, 'editDraft', { draftId: draft.id }, f.context));
  await f.scopedContext(target(), { clientId: 'client-a' }, 'editDraft', { draftId: draft.id }, f.context);
  await f.release({ clientId: 'client-a' });
  await assert.rejects(a.engine.send('getBuildXml', { buildId: a.open()!.buildId }));
  await b.engine.send('getBuildXml', { buildId: b.open()!.buildId });
  await f.release();
});

test('selected panel MCP results reach the app only after successful release', async () => {
  for (const denied of [false, true]) {
    const f = fixture(); const authorization = authorizationFixture(); const events: string[] = [];
    f.context.results!.onAdd(id => events.push(id));
    const server = new AssistantMcpServer({ version: 'fixture', context: f.context, access: { ...authorization.access,
      context: (identity, tool, args, ctx) => f.scopedContext(target(), identity.actor, tool, args, ctx) },
      tools: [{ name: 'getStats', chip: 'Fixture', description: 'Synthetic statistics.', shape: {}, run: async (_args, ctx) => {
        const result = await ctx.engine.send('getStats', { buildId: ctx.open()!.buildId });
        if (denied) authorization.state.denied = 'AI_ACCESS_REQUIRED';
        return result;
      } }] });
    const client = new Client({ name: 'fixture', version: 'fixture' });
    try {
      await server.start(); await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { Authorization: `Bearer ${server.secret}` } } }));
      const result = await client.callTool({ name: 'getStats', arguments: {} });
      if (denied) { assert.equal(result.isError, true); assert.deepEqual(events, []); }
      else {
        assert.equal(result.isError, undefined); assert.equal(events.length, 1);
        assert.deepEqual(f.context.results!.get(events[0]!)?.data, { stats: [] });
        assert.ok(JSON.stringify(result).includes(events[0]!));
      }
    } finally { await client.close(); await server.stop(); await f.release(); }
  }
});

test('missing mapping, wrong source hash and a source change all fail closed', async () => {
  const f = fixture();
  const absent = createSelectedDocumentContext({ limits, resolve: async () => null, current: async () => true });
  await assert.rejects(absent.scopedContext(target(), PANEL, 'getStats', {}, f.context));
  const mismatched = { ...f.binding, xmlHash: buildSourceHash('wrong source') };
  const wrong = createSelectedDocumentContext({ limits, resolve: async () => mismatched, current: async () => true });
  await assert.rejects(wrong.scopedContext(target(), { clientId: 'client-a' }, 'getStats', {}, f.context));
  const scoped = await f.scopedContext(target(), PANEL, 'getStats', {}, f.context);
  f.change();
  await assert.rejects(scoped.engine.send('getStats', { buildId: scoped.open()!.buildId }));
  await assert.rejects(f.scopedContext(target(), PANEL, 'getStats', {}, f.context));
  await f.release();
});

test('main-only note opt-in preserves original notes', async () => {
  const f = fixture();
  const opted = createSelectedDocumentContext({ limits, resolve: async () => ({ ...f.binding, includePrivateNotes: true }), current: async () => true });
  const scoped = await opted.scopedContext(target(), PANEL, 'getNotes', { includePrivateNotes: false }, f.context);
  const { buildXml } = await scoped.engine.send('getBuildXml', { buildId: scoped.open()!.buildId });
  assert.ok(buildXml.includes('private notes'));
  const actualTool = TOOLS.find(tool => tool.name === 'getNotes')!;
  const result = await actualTool.run({}, scoped);
  assert.deepEqual(result, { untrustedData: true, notes: 'private notes', truncated: false });
  await opted.release();
});

test('unchanged revision callback cannot hide a mutated active build or filter', async () => {
  const f = fixture();
  const scoped = await f.scopedContext(target(), PANEL, 'getStats', {}, f.context);
  f.builds.set('active', f.xml.replace('level="1"', 'level="2"'));
  await assert.rejects(scoped.engine.send('getStats', { buildId: scoped.open()!.buildId }));
  await assert.rejects(f.scopedContext(target(), { clientId: 'client-a' }, 'getStats', {}, f.context));
  await f.release();
});

/** An engine process behind the app's real EngineConnection: answers on the next tick from `builds`; `reuseId` makes the next loadBuild answer with that id (an engine restart numbers builds from 1 again). */
function engineProcess(builds: Map<string, string>) {
  let handler: (message: unknown) => void = () => undefined;
  const state = { next: 0, reuseId: undefined as string | undefined };
  const process: ProcessHandle = {
    postMessage(message) {
      const { id, command, params } = (message as { request: { id: string; command: string; params: Record<string, unknown> } }).request;
      let result: unknown = {};
      if (command === 'loadBuild') { const buildId = state.reuseId ?? `scratch${++state.next}`; state.reuseId = undefined; builds.set(buildId, String(params.buildXml)); result = { buildId }; }
      if (command === 'edit') builds.set(String(params.buildId), String((params.edit as { xml: string }).xml));
      if (command === 'getBuildXml') result = { buildXml: builds.get(String(params.buildId)) };
      if (command === 'getStats') result = { stats: [] };
      if (command === 'closeBuild') builds.delete(String(params.buildId));
      setImmediate(() => handler({ kind: 'engine-response', response: { id, command, ok: true, result } }));
    },
    onMessage(h) { handler = h; }, onExit() { /* never exits */ }, kill() { /* nothing to stop */ },
  };
  return { engine: new EngineConnection(process), state };
}

test('a mid-turn change to the open build through the engine connection fails closed', async () => {
  for (const how of ['edit', 'reused id'] as const) {
    const f = fixture(); const { engine, state } = engineProcess(f.builds);
    f.context.engine = engine;
    const panel = await f.scopedContext(target(), PANEL, 'getStats', {}, f.context);
    const outside = await f.scopedContext(target(), { clientId: 'client-a' }, 'getStats', {}, f.context);
    await panel.engine.send('getStats', { buildId: panel.open()!.buildId });
    await outside.engine.send('getStats', { buildId: outside.open()!.buildId });
    const changed = f.xml.replace('level="1"', 'level="5"');
    // the player edits the open build mid-turn, or the engine restarted and a new build took the open build's id
    if (how === 'edit') await engine.send('edit', { buildId: 'active', edit: { kind: 'setXml', xml: changed } } as never);
    else { state.reuseId = 'active'; await engine.send('loadBuild', { buildXml: changed }); }
    await assert.rejects(panel.engine.send('getStats', { buildId: panel.open()!.buildId }), how);
    await assert.rejects(outside.engine.send('getStats', { buildId: outside.open()!.buildId }), how);
    await assert.rejects(f.scopedContext(target(), { clientId: 'client-a' }, 'getStats', {}, f.context), how);
    await f.release();
  }
});

test('a mid-turn change to the saved source file or its frozen revision fails closed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pom-gate-'));
  try {
    for (const how of ['save', 'same-size write in place', 'new revision'] as const) {
      const f = fixture();
      const store = new BuildStore(join(dir, how, 'lib'), join(dir, how, 'trash')); await store.init();
      const entry = await store.create('', 'Selected', f.xml);
      const open = { buildId: 'active', buildKey: entry.id, name: 'Selected' };
      const ref = target(); let revisionId = ref.revisionId; let writes = 0;
      const documents = { get writeCount() { return writes; }, list: () => [{ objectId: ref.objectId, revisionId }], revisionRef: () => ({ ...ref, revisionId }) };
      const ai = composeAssistantAi({ limits, documents, library: { list: async () => [], readXml: async (id: string) => (await store.read(id)).xml,
        signature: (id: string) => store.signature(id) } } as never, { objectOf: () => ref.objectId } as never, () => open as never);
      const base = { ...f.context, open: () => open };
      const scoped = await ai.scopedContext!(ref, { clientId: 'client-a' }, 'getStats', {}, base);
      await scoped.engine.send('getStats', { buildId: scoped.open()!.buildId });
      if (how === 'save') await store.write(entry.id, f.xml.replace('level="1"', 'level="22"'));
      if (how === 'same-size write in place') await writeFile(join(store.root, 'Selected.xml'), f.xml.replace('level="1"', 'level="2"'));
      if (how === 'new revision') { revisionId = '44444444-4444-4444-8444-444444444444' as never; writes++; }
      await assert.rejects(scoped.engine.send('getStats', { buildId: scoped.open()!.buildId }), how);
      await assert.rejects(ai.scopedContext!(ref, { clientId: 'client-a' }, 'getStats', {}, base), how);
      await ai.releaseScopedContext!();
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the panel keeps working on its open build after an Undo or an unsaved edit; outside clients still fail closed', async () => {
  const f = fixture();
  await f.scopedContext(target(), PANEL, 'getStats', {}, f.context);
  // Undo of a live apply, or the player's own edit: the open build is neither the saved file nor the live-apply chain
  f.builds.set('active', f.xml.replace('level="1"', 'level="7"'));
  const scoped = await f.scopedContext(target(), PANEL, 'getStats', {}, f.context);
  const { buildXml } = await scoped.engine.send('getBuildXml', { buildId: scoped.open()!.buildId });
  assert.match(buildXml, /level="7"/);
  // the snapshot still holds still while tools read it
  f.builds.set('active', f.xml.replace('level="1"', 'level="8"'));
  await assert.rejects(scoped.engine.send('getStats', { buildId: scoped.open()!.buildId }));
  await assert.rejects(f.scopedContext(target(), { clientId: 'client-a' }, 'getStats', {}, f.context));
  // never another build: a different open build fails closed for the panel too
  const other = { ...f.context, open: () => ({ buildId: 'other', name: 'Other', buildKey: 'local:other' }) };
  await assert.rejects(f.scopedContext(target(), PANEL, 'getStats', {}, other));
  await f.release();
});

test('a snapshot the engine closed to make room (it keeps six builds) is replaced by the next tool call, not handed out again', async () => {
  const f = fixture();
  const first = await f.scopedContext(target(), PANEL, 'getStats', {}, f.context);
  const dead = first.open()!.buildId;
  f.builds.delete(dead); // the engine host evicted it: scratch copies of the plan and previews pushed it over the cap
  const next = await f.scopedContext(target(), PANEL, 'proposeEdit', {}, f.context);
  assert.notEqual(next.open()!.buildId, dead);
  await next.engine.send('getBuildXml', { buildId: next.open()!.buildId });
  await f.release();
});

test('a panel tool call still reading its session keeps working after the panel applied a change live', async () => {
  const f = fixture();
  const scoped = await f.scopedContext(target(), PANEL, 'getStats', {}, f.context);
  // the panel's own live apply moves the open build on while that call (a parallel call, a draft read) still runs
  const applied = f.xml.replace('level="1"', 'level="9"');
  f.builds.set('active', applied);
  f.accept('active', f.xml, applied);
  await scoped.engine.send('getStats', { buildId: scoped.open()!.buildId });
  // a change that is not the panel's own still fails closed for that call
  f.builds.set('active', f.xml.replace('level="1"', 'level="8"'));
  await assert.rejects(scoped.engine.send('getStats', { buildId: scoped.open()!.buildId }));
  await f.release();
});

test('reviewed proposals bind the real local build and preserve excluded private notes', async () => {
  const f = fixture();
  const scoped = await f.scopedContext(target(), PANEL, 'proposeEdit', {}, f.context);
  const proposal = scoped.proposals.create({ buildId: scoped.open()!.buildId, buildKey: 'local:selected', title: 'Synthetic proposal',
    edits: [{ kind: 'setXml', xml: '<PathOfBuilding><Notes></Notes></PathOfBuilding>' }],
    kind: 'changes', removedIds: [], addedIds: [], removed: [], added: [], lines: [], gems: [], changes: [], origin: 'external', baseHash: 'snapshot' });
  assert.equal(proposal.buildId, 'active');
  assert.ok((f.context.proposals.get(proposal.id)!.edits[0] as { xml: string }).xml.includes('private notes'));
  await f.release();
  assert.throws(() => scoped.proposals.create({ ...proposal, baseHash: 'snapshot' }));
});

test('filter snapshot exposes selected document only and rejects active/argument mismatch', async () => {
  const f = fixture();
  const state = emptyState();
  state.filters[0]!.written = { at: 0, folder: 'private', path: 'private/path', fileHash: 'hash', rulesHash: 'hash' };
  state.filters[0]!.buildId = 'unrelated-build';
  state.filters.push(newFilterDoc('foreign', 'Foreign private filter', 0));
  class Store extends LootFilterStore { override async load() { return state; } }
  f.context.loot = { store: new Store(''), ns: {} as never, prices: async () => null, proposals: new LfProposalStore() };
  const binding: SelectedDocumentBinding = { kind: 'filter', ref: target(), filterId: state.activeId, documentHash: hashJson(state.filters[0]) };
  const selected = createSelectedDocumentContext({ limits, resolve: async () => binding, current: async () => true });
  const scoped = await selected.scopedContext(target(), PANEL, 'getLootFilter', {}, f.context);
  const snapshot = await scoped.loot!.store.load();
  assert.equal(snapshot.filters.length, 1);
  assert.equal(snapshot.filters[0]!.written, undefined);
  assert.equal(snapshot.filters[0]!.buildId, undefined);
  await assert.rejects(scoped.loot!.store.save(state));
  await assert.rejects(selected.scopedContext(target(), PANEL, 'getLootFilter', { filterId: 'foreign' }, f.context));
  state.activeId = 'foreign';
  await assert.rejects(scoped.loot!.store.load());
  const fresh = createSelectedDocumentContext({ limits, resolve: async () => binding, current: async () => true });
  await assert.rejects(fresh.scopedContext(target(), PANEL, 'getLootFilter', {}, f.context));
});

test('selected command flows expose sourced spectre catalog entries', async () => {
  const f = fixture(); const tool = BUILD_TOOLS.find(tool => tool.name === 'listSpectres')!;
  try {
    const ctx = await f.scopedContext(target(), PANEL, tool.name, { query: 'synthetic' }, f.context);
    const result = await tool.run({ query: 'synthetic' }, ctx) as { spectres: Array<{ id: string; name: string }> };
    assert.deepEqual(result.spectres, [{ id: 'synthetic-spectre', name: 'Synthetic spectre' }]);
    assert.ok(f.sent.includes('spectreCatalog'));
  } finally { await f.release(); }
});

test('selected command flows expose calculation rows and their detail sources', async () => {
  const f = fixture(); const tool = BUILD_TOOLS.find(tool => tool.name === 'getCalcs')!;
  const args = { section: 'fixture-section', row: 'Fixture row' };
  try {
    const ctx = await f.scopedContext(target(), PANEL, tool.name, args, f.context);
    const result = await tool.run(args, ctx) as { tables: Array<{ rows: Array<{ sources: Array<Array<{ source: string }>> }> }> };
    assert.equal(result.tables[0]!.rows[0]!.sources[0]![0]!.source, 'Fixture source');
    const calls = f.calls.filter(call => call.command === 'calcsView' || call.command === 'calcsMods');
    assert.deepEqual(calls.map(call => call.command), ['calcsView', 'calcsMods']);
    assert.ok(calls.every(call => call.params.buildId === ctx.open()!.buildId && call.params.buildId !== 'active'));
  } finally { await f.release(); }
});

test('selected command flows run weighted timeless search only on an owned scratch build', async () => {
  const f = fixture(); const tool = BUILD_TOOLS.find(tool => tool.name === 'searchTimeless')!;
  const args = { jewel: JEWEL_TYPES[0]!.label, nodes: [{ name: 'Synthetic passive' }] };
  try {
    const ctx = await f.scopedContext(target(), PANEL, tool.name, args, f.context);
    const result = await tool.run(args, ctx) as { finished: boolean; seeds: unknown[] };
    assert.equal(result.finished, true); assert.deepEqual(result.seeds, []);
    for (const command of ['timelessStatus', 'timelessInfo', 'timelessMods', 'timelessStart', 'timelessStep', 'timelessRows']) assert.ok(f.sent.includes(command), command);
    const calls = f.calls.filter(call => ['timelessInfo', 'timelessMods', 'timelessStart', 'timelessStep', 'timelessRows'].includes(call.command));
    assert.ok(calls.every(call => call.params.buildId !== 'active' && call.params.buildId !== ctx.open()!.buildId));
    assert.deepEqual([...f.builds.keys()].sort(), ['active', ctx.open()!.buildId].sort());
  } finally { await f.release(); }
});

test('selected command flows apply an enchantment from the synthetic item pool', async () => {
  const f = fixture(); const tool = BUILD_TOOLS.find(tool => tool.name === 'searchEnchants')!;
  const args = { itemText: 'Rarity: RARE\nSynthetic item\nSynthetic base\n--------\nItem Level: 1\n', apply: { line: 'Synthetic enchantment' } };
  try {
    const ctx = await f.scopedContext(target(), PANEL, tool.name, args, f.context);
    const result = await tool.run(args, ctx) as { enchantedText: string };
    assert.ok(result.enchantedText.includes('Synthetic enchantment')); assert.ok(f.sent.includes('itemInfo'));
    assert.equal(f.calls.find(call => call.command === 'itemInfo')?.params.buildId, undefined);
  } finally { await f.release(); }
});

test('selected command boundaries reject foreign IDs and reserve search mutation for scratch builds', async () => {
  const f = fixture();
  try {
    const a = await f.scopedContext(target(), { clientId: 'client-a' }, 'searchTimeless', {}, f.context);
    const b = await f.scopedContext(target(), { clientId: 'client-b' }, 'searchTimeless', {}, f.context);
    for (const id of ['active', 'foreign', b.open()!.buildId]) {
      await assert.rejects(a.engine.send('calcsView', { buildId: id }));
      await assert.rejects(a.engine.send('timelessInfo', { buildId: id }));
    }
    for (const id of ['active', a.open()!.buildId, b.open()!.buildId]) {
      await assert.rejects(a.engine.send('timelessStart', { buildId: id, search: {} } as never));
      await assert.rejects(a.engine.send('timelessStep', { buildId: id, budgetMs: 1 }));
      await assert.rejects(a.engine.send('timelessCancel', { buildId: id }));
    }
    await assert.rejects(a.engine.send('spectreCatalog', { buildId: 'active' } as never));
    await assert.rejects(a.engine.send('itemInfo', { buildId: 'active', itemText: 'Synthetic item' }));
    await assert.rejects(a.engine.send('timelessSetDataDir', { dir: 'unrelated' }));
    const scratch = await a.engine.send('loadBuild', { buildXml: '<PathOfBuilding/>' });
    await a.engine.send('timelessStart', { buildId: scratch.buildId, search: { jewelType: JEWEL_TYPES[0]!.id, socketId: -1,
      socketFilter: false, socketFilterDistance: 0, totalMinimumWeight: null, searchList: 'fixture-mod, 1, 0, 0', searchListFallback: '', protected: [] } });
    await a.engine.send('timelessStep', { buildId: scratch.buildId, budgetMs: 1 });
    await a.engine.send('timelessCancel', { buildId: scratch.buildId });
    await a.engine.send('closeBuild', { buildId: scratch.buildId });
    await assert.rejects(a.engine.send('timelessStep', { buildId: scratch.buildId, budgetMs: 1 }));
  } finally { await f.release(); }
});

function reviewProposalInput(context: ToolContext): Parameters<ProposalStore['create']>[0] {
  return { buildId: context.open()!.buildId, buildKey: context.open()!.buildKey, title: 'Synthetic proposal',
    edits: [{ kind: 'setXml', xml: '<PathOfBuilding><Build level="1"/></PathOfBuilding>' }], kind: 'changes',
    removedIds: [], addedIds: [], removed: [], added: [], lines: [], gems: [], changes: [], origin: context.origin, baseHash: 'snapshot' };
}

test('selected apply review binds committed build proposals to their actor and immutable content', async () => {
  const f = fixture(); const actor = { clientId: 'client-a' };
  try {
    const a = await f.scopedContext(target(), actor, 'proposeEdit', {}, f.context);
    const transaction = createProposalTransaction(a); const pending = transaction.context.proposals.create(reviewProposalInput(a));
    const review = await f.scopedContext(target(), actor, 'requestApplyReview', { proposalId: pending.id }, f.context);
    await assert.rejects(review.reviewExternalProposal!(pending.id));
    transaction.commit();
    assert.deepEqual(await review.reviewExternalProposal!(pending.id), { proposalId: pending.id, status: 'pending', reviewRequired: true, reviewIn: 'app' });
    assert.equal(JSON.stringify(await review.reviewExternalProposal!(pending.id)).includes('private notes'), false);
    const b = await f.scopedContext(target(), { clientId: 'client-b' }, 'requestApplyReview', { proposalId: pending.id }, f.context);
    await assert.rejects(b.reviewExternalProposal!(pending.id));
    const prepared = a.proposals.prepare(reviewProposalInput(a));
    assert.throws(() => b.proposals.commitPrepared(prepared));
    a.proposals.discardPrepared(prepared);
    const panel = await f.scopedContext(target(), PANEL, 'proposeEdit', {}, f.context);
    const panelProposal = panel.proposals.create(reviewProposalInput(panel));
    await assert.rejects(review.reviewExternalProposal!(panelProposal.id));
    await assert.rejects(review.reviewExternalProposal!('forged'));
    const saved = f.context.proposals.get(pending.id)!; const title = saved.title;
    saved.title = 'Tampered content'; await assert.rejects(review.reviewExternalProposal!(pending.id)); saved.title = title;
    const baseHash = saved.baseHash;
    saved.baseHash = 'tampered'; await assert.rejects(review.reviewExternalProposal!(pending.id)); saved.baseHash = baseHash;
    f.context.proposals.setStatus(pending.id, 'dismissed', { note: 'Reviewed in the app.', undoSteps: 0 });
    assert.deepEqual(await review.reviewExternalProposal!(pending.id), { proposalId: pending.id, status: 'dismissed', reviewRequired: false, reviewIn: 'app' });
    await f.release(actor); await assert.rejects(review.reviewExternalProposal!(pending.id));
    assert.equal(f.context.proposals.get(pending.id)?.status, 'dismissed');
    assert.equal(f.sent.includes('edit'), false);
  } finally { await f.release(); }
});

test('selected apply review binds filter proposals and rejects a stale selected source', async () => {
  const f = fixture(); const state = emptyState();
  class Store extends LootFilterStore { override async load() { return state; } }
  f.context.loot = { store: new Store(''), ns: {} as never, prices: async () => null, proposals: new LfProposalStore() };
  const binding: SelectedDocumentBinding = { kind: 'filter', ref: target(), filterId: state.activeId, documentHash: hashJson(state.filters[0]) };
  const selected = createSelectedDocumentContext({ limits, resolve: async () => binding, current: async () => true });
  try {
    const a = await selected.scopedContext(target(), { clientId: 'client-a' }, 'proposeLootRules', {}, f.context);
    const transaction = createProposalTransaction(a);
    const pending = transaction.context.loot!.proposals.create({ filterId: state.activeId, title: 'Synthetic filter proposal', changes: [] });
    const review = await selected.scopedContext(target(), { clientId: 'client-a' }, 'requestApplyReview', { proposalId: pending.id }, f.context);
    await assert.rejects(review.reviewExternalProposal!(pending.id)); transaction.commit();
    assert.deepEqual(await review.reviewExternalProposal!(pending.id), { proposalId: pending.id, status: 'pending', reviewRequired: true, reviewIn: 'app' });
    const foreign = f.context.loot.proposals.create({ filterId: state.activeId, title: 'Other client proposal', changes: [] });
    await assert.rejects(review.reviewExternalProposal!(foreign.id));
    const saved = f.context.loot.proposals.get(pending.id)!; saved.title = 'Tampered content'; await assert.rejects(review.reviewExternalProposal!(pending.id));
    saved.title = 'Synthetic filter proposal'; state.filters[0]!.name = 'Changed selected filter';
    await assert.rejects(review.reviewExternalProposal!(pending.id));
  } finally { await selected.release(); await f.release(); }
});

test('selected apply review over HTTP exposes only own proposal metadata and blocks legacy mutators', async () => {
  const f = fixture(); const authorization = authorizationFixture(); let legacyCalls = 0;
  const scopes = ['mcp:tools:list', 'mcp:propose', 'mcp:apply'] as const;
  const identities = ['77777777-7777-4777-8777-777777777777', '88888888-8888-4888-8888-888888888888'];
  const legacyNames = ['saveDraftAsBuild', 'manageLibraryBuild', 'saveSharedItem', 'wealthAction', 'applySolveResult'];
  const server = new AssistantMcpServer({ version: 'fixture', context: f.context, access: { ...authorization.access,
    external: token => token === 'fixture-a' || token === 'fixture-b' ? { actor: { clientId: identities[token === 'fixture-a' ? 0 : 1]!, proof: 'fixture' }, origin: 'external', scopes } : null,
    context: (identity, tool, args, ctx) => f.scopedContext(target(), identity.actor, tool, args, ctx) }, tools: [
      ...APPROVED_CHANGE_TOOLS,
      { name: 'proposeEdit', chip: 'Fixture', description: 'Synthetic proposal.', shape: {}, run: async (_args, ctx) => ({ proposalId: ctx.proposals.create(reviewProposalInput(ctx)).id }) },
      ...legacyNames.map(name => ({ name, chip: 'Fixture', description: 'Synthetic legacy mutator.', shape: {}, run: async () => { legacyCalls++; return {}; } })),
    ] });
  const clients = [new Client({ name: 'fixture-a', version: 'fixture' }), new Client({ name: 'fixture-b', version: 'fixture' })];
  const payload = (result: unknown) => JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text) as Record<string, unknown>;
  try {
    await server.start();
    for (const [index, client] of clients.entries()) await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { Authorization: `Bearer fixture-${index === 0 ? 'a' : 'b'}` } } }));
    const listed = (await clients[0]!.listTools()).tools.map(tool => tool.name);
    assert.ok(listed.includes('requestApplyReview')); assert.ok(legacyNames.every(name => !listed.includes(name)));
    const proposed = await clients[0]!.callTool({ name: 'proposeEdit', arguments: {} }); assert.equal(proposed.isError, undefined);
    const id = String(payload(proposed).proposalId);
    const result = await clients[0]!.callTool({ name: 'requestApplyReview', arguments: { proposalId: id } }); assert.equal(result.isError, undefined);
    const { ref: _ref, ...metadata } = payload(result);
    assert.deepEqual(metadata, { proposalId: id, status: 'pending', reviewRequired: true, reviewIn: 'app' });
    assert.equal(JSON.stringify(result).includes('private notes'), false);
    assert.equal((await clients[1]!.callTool({ name: 'requestApplyReview', arguments: { proposalId: id } })).isError, true);
    for (const name of legacyNames) assert.equal((await clients[0]!.callTool({ name, arguments: {} })).isError, true);
    assert.equal(legacyCalls, 0); assert.equal(f.sent.includes('edit'), false); assert.equal(f.sent.includes('undo'), false);
  } finally { await Promise.all(clients.map(client => client.close())); await server.stop(); await f.release(); }
});
