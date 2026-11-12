import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, input, observation } from '../src/main/run/testing/fixture.js';
import { RunStore } from '../src/main/run/store.js';
import { RunService } from '../src/main/run/service.js';

test('only exact live selected-context final-trigger evidence auto-queues; it does not review or open completion', async () => {
  const f = await fixture();
  try {
    await f.service.start(await input()); await f.service.setAccount('account-a');
    for (const [sequence, trigger, flags] of [
      [0, { kind: 'level', level: 100 }, {}], [1, { kind: 'level', level: 31 }, { method: 'seed' }],
      [2, { kind: 'level', level: 31 }, { continuous: false }], [3, { kind: 'level', level: 31 }, { selectedContext: false }],
      [4, { kind: 'level', level: 31 }, { reliable: false }],
    ] as const) {
      await f.service.observe([observation(sequence, trigger, flags)]); assert.equal(f.service.queuedReceipts().length, 0);
    }
    await f.service.observe([observation(5, { kind: 'level', level: 31 })]);
    const receipt = f.service.queuedReceipts()[0]!;
    assert.equal(receipt.method, 'final_trigger_observed'); assert.equal(f.service.queuedReceipts().length, 1);
    assert.equal(f.service.view()!.state.reviewed.length, 0); assert.equal(f.service.view()!.finish, null);
    const remote = JSON.stringify(receipt);
    for (const privateField of ['characterBinding', 'logPath', 'runId', 'accountId', 'raw', 'notes']) assert.equal(remote.includes(privateField), false);
  } finally { await f.close(); }
});

test('final Next and sixty-percent coverage never count; one manual confirmation preserves outstanding actions', async () => {
  const f = await fixture();
  try {
    const start = await input(); await f.service.start(start); await f.service.setAccount('account-a');
    await f.command('next'); await f.command('next'); await f.command('next');
    assert.equal(f.service.queuedReceipts().length, 0);
    await f.service.command({ kind: 'jump', commandId: 'end-position', bundleId: f.service.view()!.snapshot.bundles.at(-1)!.bundleId });
    await f.command('next'); assert.ok(f.service.view()!.finish); assert.equal(f.service.queuedReceipts().length, 0);
    await f.command('confirmFinished'); assert.equal(f.service.queuedReceipts().length, 1);
    await f.command('confirmFinished'); assert.equal(f.service.queuedReceipts().length, 1);
    assert.equal(f.service.queuedReceipts()[0]!.method, 'player_confirmed');
    await f.service.closeRun(); await f.service.start(start);
    await f.command('finish'); const coverage = f.service.view()!.state.outstandingActionIds;
    await f.command('confirmFinished'); assert.deepEqual(f.service.view()!.state.outstandingActionIds, coverage);
    assert.equal(f.service.view()!.finish!.reviewedCount, 0); assert.equal(f.service.queuedReceipts().length, 1);
  } finally { await f.close(); }
});

test('counting defaults on; privacy cancels queued receipts durably and never backfills on sign-in or opt-in', async () => {
  const f = await fixture();
  try {
    await f.service.start(await input()); assert.equal(f.service.view()!.snapshot.settings.countRuns, true);
    await f.command('confirmFinished'); await f.service.setAccount('account-a'); assert.equal(f.service.queuedReceipts().length, 0);
    await f.command('confirmFinished'); assert.equal(f.service.queuedReceipts().length, 1);
    await f.service.setCounting(false); assert.equal(f.service.queuedReceipts().length, 0);
    await f.service.observe([observation(0, { kind: 'level', level: 31 })]); await f.command('confirmFinished');
    assert.equal(f.service.queuedReceipts().length, 0);
    await f.service.setCounting(true); assert.equal(f.service.queuedReceipts().length, 0);
    await f.service.close(); const store = new RunStore(f.directory, (await import('../src/main/run/testing/fixture.js')).limits);
    const service = new RunService(store, { documents: f.documents, limits: (await import('../src/main/run/testing/fixture.js')).limits });
    await service.init(); await service.setAccount('account-a'); assert.equal(service.queuedReceipts().length, 0); await service.close();
  } finally { await f.documents.close(); }
});

test('outbox is account-bound; delivery failure retains original method and server idempotency across repeated Runs', async () => {
  const f = await fixture();
  try {
    const start = await input(); await f.service.start(start); await f.service.setAccount('account-a'); await f.command('confirmFinished');
    const first = f.service.queuedReceipts()[0]!;
    await assert.rejects(f.service.deliverReceipts(async () => { throw new Error('offline'); }), /offline/);
    assert.deepEqual(f.service.queuedReceipts(), [first]);
    await f.service.setAccount('account-b'); assert.equal(f.service.queuedReceipts().length, 0);
    let sends = 0; await f.service.deliverReceipts(async () => { sends++; }); assert.equal(sends, 0);
    await f.command('confirmFinished'); assert.equal(f.service.queuedReceipts().length, 1);
    await f.service.setAccount('account-a');
    await f.service.deliverReceipts(async (receipt, account) => { assert.equal(account, 'account-a'); assert.deepEqual(receipt, first); sends++; });
    await f.service.closeRun(); await f.service.start(start); await f.command('confirmFinished');
    assert.equal(f.service.queuedReceipts().length, 0); assert.equal(sends, 1);
  } finally { await f.close(); }
});

test('mixed final bundle requires every trigger in its predicate', async () => {
  const f = await fixture();
  try {
    await f.service.start(await input([{ kind: 'level', level: 1 }, { kind: 'level', level: 31 }, { kind: 'areaLevel', level: 7 }]));
    await f.service.setAccount('account-a');
    await f.service.observe([observation(0, { kind: 'level', level: 31 }, { transitionId: 'mixed' })]);
    assert.equal(f.service.queuedReceipts().length, 0);
    await f.service.observe([observation(1, { kind: 'areaLevel', level: 7 }, { transitionId: 'mixed' })]);
    assert.equal(f.service.queuedReceipts().length, 1);
    assert.equal(f.service.queuedReceipts()[0]!.finalTrigger.kind, 'level');
  } finally { await f.close(); }
});

test('signed-out final evidence, manual maps and approximate final progress cannot later auto-count', async () => {
  const f = await fixture();
  try {
    await f.service.start(await input()); await f.service.observe([observation(0, { kind: 'level', level: 31 })]);
    await f.service.setAccount('account-a'); assert.equal(f.service.queuedReceipts().length, 0);
    await f.service.observe([observation(0, { kind: 'level', level: 31 })]); assert.equal(f.service.queuedReceipts().length, 0);
    await f.service.observe([observation(1, { kind: 'zone', zoneId: 'unrelated-synthetic-zone' })]);
    assert.equal(f.service.queuedReceipts().length, 0);
    await f.service.closeRun();
    await f.service.start(await input([{ kind: 'firstMap', anchorId: 'synthetic-maps' }]));
    await f.service.observe([observation(0, { kind: 'firstMap', anchorId: 'synthetic-maps' }, { method: 'manual' })]);
    assert.equal(f.service.queuedReceipts().length, 0);
    await f.service.observe([observation(1, { kind: 'firstMap', anchorId: 'synthetic-maps' }, { sourceEvidenceId: 'pinned-zone-join' })]);
    assert.equal(f.service.queuedReceipts().length, 1);
  } finally { await f.close(); }
});

test('opting out during final-trigger evidence prevents silent later backfill and leaves local coverage intact', async () => {
  const f = await fixture();
  try {
    await f.service.start(await input()); await f.service.setAccount('account-a'); await f.service.setCounting(false);
    await f.service.observe([observation(0, { kind: 'level', level: 31 })]);
    await f.service.setCounting(true);
    await f.service.observe([observation(1, { kind: 'zone', zoneId: 'unrelated-synthetic-zone' })]);
    assert.equal(f.service.queuedReceipts().length, 0); assert.equal(f.service.view()!.state.reviewed.length, 0);
    await f.command('confirmFinished'); assert.equal(f.service.queuedReceipts()[0]!.method, 'player_confirmed');
  } finally { await f.close(); }
});

test('automatic receipts are delivered with minimal continuous final-trigger evidence the outbox accepts', async () => {
  const f = await fixture();
  try {
    await f.service.start(await input()); await f.service.setAccount('account-a');
    await f.service.observe([observation(0, { kind: 'level', level: 31 })]);
    const receipt = f.service.queuedReceipts()[0]!; assert.equal(receipt.method, 'final_trigger_observed');
    let seen: unknown; await f.service.deliverReceipts(async (_r, _a, evidence) => { seen = evidence; });
    const e = seen as { origin: string; context: string; observations: { trigger: unknown; observedAt: string }[] };
    assert.deepEqual(Object.keys(e).sort(), ['context', 'observations', 'origin']);
    assert.equal(e.origin, 'live'); assert.equal(e.context, 'continuous'); assert.equal(e.observations.length, 1);
    assert.deepEqual(Object.keys(e.observations[0]!).sort(), ['observedAt', 'trigger']);
    assert.deepEqual(e.observations[0]!.trigger, receipt.finalTrigger); assert.ok(e.observations[0]!.observedAt.endsWith('Z'));
  } finally { await f.close(); }
});
