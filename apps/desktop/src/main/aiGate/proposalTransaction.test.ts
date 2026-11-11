import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProposalStore } from '../assistant/proposals.js';
import { LfProposalStore } from '../assistant/lootTools.js';
import type { ToolContext } from '../assistant/tools.js';
import { fixture, limits, target } from './fixtures.js';
import { PANEL } from './gate.js';
import { createProposalTransaction } from './proposalTransaction.js';
import { buildSourceHash, createSelectedDocumentContext } from './scopedContext.js';
import { xmlHash } from '../assistant/buildReaders.js';

function input(buildId = 'active'): Parameters<ProposalStore['create']>[0] {
  return { buildId, buildKey: 'selected', title: 'Synthetic proposal', edits: [{ kind: 'setLevel', level: 1 }],
    kind: 'changes', removedIds: [], addedIds: [], removed: [], added: [], lines: [], gems: [], changes: [],
    origin: 'external', baseHash: 'synthetic' };
}
function context(file?: string): ToolContext {
  return { engine: {} as never, open: () => null, tree: {} as never, proposals: new ProposalStore(file), origin: 'external',
    loot: { store: {} as never, ns: {} as never, prices: async () => null, proposals: new LfProposalStore() } };
}

test('release denial discards generated build/filter cards without persistence or notification', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'pom-p24-proposals-')), 'proposals.json');
  const original = context(file); const transaction = createProposalTransaction(original); const f = fixture();
  const pushes: string[] = []; original.proposals.onCreated(p => pushes.push(p.id)); original.loot!.proposals.onCreated(p => pushes.push(p.id));
  let buildId = ''; let filterId = '';
  await assert.rejects(async () => {
    try {
      await f.gate.run(PANEL, 'mcp:propose', target(), {}, async () => {
        buildId = transaction.context.proposals.create(input()).id;
        filterId = transaction.context.loot!.proposals.create({ filterId: 'selected-filter', title: 'Synthetic filter', changes: [] }).id;
        assert.equal(original.proposals.get(buildId), undefined);
        assert.equal(original.loot!.proposals.get(filterId), undefined);
        assert.equal(existsSync(file), false); assert.deepEqual(pushes, []);
        f.state.denied = 'AI_ACCESS_REQUIRED';
        return { buildId, filterId };
      });
      transaction.commit();
    } catch (error) { transaction.discard(); throw error; }
  });
  assert.equal(original.proposals.get(buildId), undefined);
  assert.equal(original.loot!.proposals.get(filterId), undefined);
  assert.equal(existsSync(file), false); assert.deepEqual(pushes, []);
  assert.throws(() => transaction.commit());
});

test('authorized release commits exact staged IDs once and preserves saved free Apply', async () => {
  const original = context(); const saved = original.proposals.create(input());
  const pushes: string[] = []; original.proposals.onCreated(p => pushes.push(p.id)); original.loot!.proposals.onCreated(p => pushes.push(p.id));
  const transaction = createProposalTransaction(original); const f = fixture();
  const result = await f.gate.run(PANEL, 'mcp:propose', target(), {}, async () => {
    const build = transaction.context.proposals.create(input());
    const filter = transaction.context.loot!.proposals.create({ filterId: 'selected-filter', title: 'Synthetic filter', changes: [] });
    assert.equal('baseHash' in build, false);
    assert.deepEqual(pushes, []);
    return { build, filter };
  });
  transaction.commit(); transaction.commit(); transaction.discard();
  assert.deepEqual(pushes, [result.build.id, result.filter.id]);
  assert.equal(original.proposals.get(result.build.id)!.id, result.build.id);
  assert.equal(original.loot!.proposals.get(result.filter.id)!.id, result.filter.id);
  assert.equal(original.proposals.takeForApply(saved.id).proposal.id, saved.id);
  assert.throws(() => transaction.context.proposals.create(input()));
});

test('prepared cards cannot be forged, edited before commit, or committed across stores', () => {
  const store = new ProposalStore(); const foreign = new ProposalStore(); const prepared = store.prepare(input());
  prepared.title = 'Changed after prepare';
  assert.throws(() => store.commitPrepared(structuredClone(prepared)));
  assert.throws(() => foreign.commitPrepared(prepared));
  const committed = store.commitPrepared(prepared);
  assert.equal(committed.title, 'Synthetic proposal');
  const pending = store.prepare(input()); store.discardPrepared(pending); assert.throws(() => store.commitPrepared(pending));
  assert.equal(store.takeForApply(committed.id).proposal.baseHash, 'synthetic');
});

test('read-only context with no proposal stores needs no transaction capabilities', () => {
  const original = { engine: {} } as ToolContext;
  const transaction = createProposalTransaction(original);
  assert.equal(transaction.context.proposals, undefined);
  assert.equal(transaction.context.loot, undefined);
  assert.throws(() => transaction.context.proposals.create(input()));
  transaction.commit(); transaction.commit();
});

test('scoped prepare binds original build and preserves excluded notes before authorized commit', async () => {
  const original = context();
  const rawXml = '<PathOfBuilding><Build level="1"/><Notes>private source notes</Notes></PathOfBuilding>';
  let next = 0; const builds = new Map([['active', rawXml]]);
  original.open = () => ({ buildId: 'active', name: 'Selected', buildKey: 'selected' });
  original.engine = {
    async send(command, params) {
      const args = params as Record<string, unknown>;
      if (command === 'getBuildXml') return { buildXml: builds.get(String(args.buildId)) } as never;
      if (command === 'loadBuild') { const buildId = `scratch-${++next}`; builds.set(buildId, String(args.buildXml)); return { buildId } as never; }
      if (command === 'closeBuild') builds.delete(String(args.buildId));
      return {} as never;
    }, onEvent: () => () => undefined,
  };
  const selected = createSelectedDocumentContext({ limits, resolve: async () => ({ kind: 'build', ref: target(),
    engineBuildId: 'active', buildKey: 'selected', libraryBuildId: 'selected', name: 'Selected', xmlHash: buildSourceHash(rawXml) }), current: async () => true });
  const scoped = await selected.scopedContext(target(), PANEL, 'proposeEdit', {}, original);
  const transaction = createProposalTransaction(scoped);
  const proposal = transaction.context.proposals.create({ ...input(scoped.open()!.buildId),
    edits: [{ kind: 'setXml', xml: '<PathOfBuilding><Build level="2"/><Notes></Notes></PathOfBuilding>' }] });
  assert.equal(original.proposals.get(proposal.id), undefined);
  transaction.commit();
  const saved = original.proposals.takeForApply(proposal.id);
  assert.equal(saved.proposal.buildId, 'active'); assert.equal(saved.proposal.baseHash, xmlHash(rawXml));
  assert.ok((saved.edits[0] as { xml: string }).xml.includes('private source notes'));
  const denied = createProposalTransaction(scoped); const pending = denied.context.proposals.create(input(scoped.open()!.buildId));
  await selected.release(); assert.throws(() => denied.commit()); denied.discard();
  assert.equal(original.proposals.get(pending.id), undefined);
});
