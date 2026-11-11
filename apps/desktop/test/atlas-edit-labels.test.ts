// Atlas optimizer: history labels for allocations and the mastery call wait at startup.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { editLabel, inFolder } from '../src/renderer/atlas/editor/presenter.js';
import { HANDLER_WAIT_MS, notRegistered, withHandlerWait } from '../src/renderer/mastery/handlerWait.js';
import { limits } from '@pom/mastery-contracts/fixtures';
import { verifiedLinkPlan } from '../src/main/atlas/formats.js';
import { encodeOfficialAtlasLink } from '../src/shared/atlas/codecs/external.js';

const stepId = 'step:00000000-0000-4000-8000-000000000001' as never;
const alloc = (beforeIds: string[], afterIds: string[]) => ({ kind: 'allocation' as const, stepId, beforeIds, afterIds, datasetHash: 'x' });

test('allocation edits are labelled "Allocated {N} nodes" / "Removed {N} nodes" as on the wire', () => {
  assert.equal(editLabel(alloc([], ['29045', '10884', '57739', '64048'])), 'Allocated 4 nodes');
  assert.equal(editLabel(alloc(['29045'], ['29045', '10884'])), 'Allocated 1 node');
  assert.equal(editLabel(alloc(['29045', '10884', '57739'], ['29045'])), 'Removed 2 nodes');
  assert.equal(editLabel(alloc(['29045', '10884'], ['29045', '57739'])), 'Changed allocations', 'a swap is neither a pure add nor a pure removal');
  assert.equal(editLabel({ kind: 'title', title: 'x' } as never), 'Renamed plan', 'other labels are unchanged');
});

const unregistered = () => new Error("Error invoking remote method 'mastery:atlas-port': Error: No handler registered for 'mastery:atlas-port'");

test('a mastery call made before main registers its handler waits for it instead of failing', async () => {
  let calls = 0, clock = 0;
  const value = await withHandlerWait(async () => { calls++; if (calls < 4) throw unregistered(); return 'ready'; }, HANDLER_WAIT_MS, async (ms) => { clock += ms; }, () => clock);
  assert.equal(value, 'ready');
  assert.equal(calls, 4);
  assert.equal(clock, 100 + 200 + 400, 'backs off 100, 200, 400 ms');
});

test('other errors fail at once, and a handler that never comes fails after the wait', async () => {
  let calls = 0;
  await assert.rejects(withHandlerWait(async () => { calls++; throw new Error('Atlas request is unsupported.'); }, 1000, async () => {}, () => 0), /unsupported/);
  assert.equal(calls, 1);
  let clock = 0; calls = 0;
  await assert.rejects(withHandlerWait(async () => { calls++; throw unregistered(); }, 5000, async (ms) => { clock += ms; }, () => clock), /No handler registered/);
  assert.ok(clock <= 5000 && calls > 3, `gave up within the wait (${clock} ms, ${calls} calls)`);
  assert.equal(notRegistered(new Error('boom')), false);
});

test('a tree link imported as a new plan is saved only when the plan holds exactly the link nodes on known tree data', () => {
  const ids = ['10884', '29045', '57739', '64048'];
  const link = encodeOfficialAtlasLink(ids)!, bareCode = link.split('/').at(-1)!;
  const known = (() => ({ graph: {} as never, compatibilityVerified: false })) as never, missing = (() => null) as never;
  const plan = (allocatedIds: string[]) => ({ dataset: { datasetId: 'atlas:x' }, stepsById: { s1: { allocatedIds } } });
  const reversed = plan([...ids].reverse());
  assert.equal(verifiedLinkPlan(link, reversed, limits, known), reversed, 'the same IDs in any order are accepted');
  assert.deepEqual(verifiedLinkPlan(link, plan(ids), limits, known).stepsById, { s1: { allocatedIds: ids } });
  assert.deepEqual(verifiedLinkPlan(bareCode, plan(ids), limits, known).stepsById, { s1: { allocatedIds: ids } }, 'a bare tree code as pasted is read as its link');
  assert.throws(() => verifiedLinkPlan(link, plan(['10884', '29045']), limits, known), /does not match the link/);
  assert.throws(() => verifiedLinkPlan(link, plan(ids), limits, missing), /Choose bundled tree data/);
  assert.throws(() => verifiedLinkPlan(link, { ...plan(ids), stepsById: { a: { allocatedIds: ids }, b: { allocatedIds: ids } } }, limits, known), /Choose bundled tree data/);
  assert.throws(() => verifiedLinkPlan('{"format":"pathofmastery"}', plan(ids), limits, known), /not an Atlas plan/);
});

test('the Local root lists only plans that are not in a folder; a folder lists its own plans', () => {
  assert.equal(inFolder(null, null), true);
  assert.equal(inFolder('mapping', null), false, 'a plan moved into a folder leaves the root');
  assert.equal(inFolder('mapping', 'mapping'), true);
  assert.equal(inFolder(null, 'mapping'), false);
  assert.equal(inFolder('other', 'mapping'), false);
});
