import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseId, type AtlasPlan } from '@pom/mastery-contracts';
import { limits } from '@pom/mastery-contracts/fixtures';
import { createPlan } from '../src/shared/atlas/plan.js';
import { createGraph, known } from '../src/shared/atlas/graph.js';
import { AtlasOptimizerService } from '../src/main/atlas/optimizerService.js';
import { PREFERENCE_DEBOUNCE_MS } from '../src/shared/atlas/solver/protocol.js';
import { PREFERENCE_IDLE_MS } from '../src/shared/atlas/suggestions/choices.js';
import { certaintyOf, STALE_TEXT, staleReason } from '../src/shared/atlas/suggestions/proposal.js';
import { applySummary, summaryText } from '../src/shared/atlas/suggestions/summary.js';
import { choicesFromPlan } from '../src/shared/atlas/suggestions/choices.js';
import { SyntheticRepository } from '../src/renderer/atlas/editor/fixtureModel.js';
import { AtlasEditorSession, type AtlasEditorPort } from '../src/renderer/atlas/editor/session.js';
import { OptimizerController, type OptimizerPort } from '../src/renderer/atlas/optimizer/controller.js';
import { MECHANIC_NAMES, optimizerDataset, SUSTAIN } from '../src/renderer/atlas/optimizer/fixtureData.js';
import { RailController } from '../src/renderer/atlas/optimizer/railController.js';
import { pathForTargets, type Suggestion } from '../src/shared/atlas/suggestions/rules.js';

const workerPath = process.env.P11_WORKER;
if (!workerPath) throw new Error('Run through apps/desktop/src/renderer/atlas/optimizer/check.mjs, which bundles the solver worker.');
const exactLimits = { maxNodes: 2048, maxEdges: 8192, maxInputIds: 8192, maxDpBytes: 512 * 1024 * 1024 };
const first = parseId('step', 'step:first');
const extras: Pick<AtlasEditorPort, 'parse' | 'importNew' | 'exportFile' | 'share' | 'exportRecovery'> = {
  parse: async () => { throw new Error('unused'); }, importNew: async () => { throw new Error('unused'); }, exportFile: async () => {}, share: async () => '', exportRecovery: async () => {} };
const services: AtlasOptimizerService[] = [];
after(() => services.forEach(s => s.dispose()));

async function env(budget = 8) {
  const data = optimizerDataset(), repo = new SyntheticRepository(data), session = new AtlasEditorSession(repo.port(extras), limits);
  await session.create(createPlan(data.ref, data.ref.stamp, first, budget));
  const graph = createGraph(data.graph, known(data.costModel, 'synthetic-fixture'));
  const service = new AtlasOptimizerService({ data: () => ({ graph, taxonomyHash: data.taxonomy.contentHash, qualified: false }), limits: exactLimits, workerUrl: pathToFileURL(workerPath!) });
  services.push(service);
  const port: OptimizerPort = { prepare: async r => service.prepare(r), find: i => service.find(i), continueSolving: () => service.continueSolving(), cancel: () => service.cancel(),
    freeze: async i => service.freeze(i), onMessage: l => service.onMessage(l) };
  const controller = new OptimizerController({ session, port, names: MECHANIC_NAMES, sustain: SUSTAIN, debounceMs: 5 });
  return { data, session, controller, graph };
}
async function until(check: () => boolean, ms = 8000) { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) assert.fail('Timed out waiting for the solver.'); await delay(10); } }
const solved = (c: OptimizerController) => until(() => c.snapshot().status === 'complete' && !!c.snapshot().proposal);
const stepOf = (s: AtlasEditorSession) => s.state.plan!.stepsById[first]!;

test('the idle delay matches the worker host debounce', () => { assert.equal(PREFERENCE_IDLE_MS, PREFERENCE_DEBOUNCE_MS); assert.equal(PREFERENCE_IDLE_MS, 250); });

test('priority run: earlier accepted mechanics stay, a non-fitting one is skipped in place, later ones are still checked', async () => {
  const { controller: c } = await env(5);
  c.setMark('alpha', 'want'); c.setMark('beta', 'want'); c.setMark('gamma', 'want'); // alpha 4 pts, beta 4 more: no; gamma 4: no
  await c.find(); await solved(c);
  const rows = c.snapshot().proposal!.results;
  assert.deepEqual(rows.map(r => r.name), ['Synthetic Alpha', 'Synthetic Beta', 'Synthetic Gamma']);
  assert.equal(rows[0]!.label, 'Reached');
  assert.ok(rows.slice(1).every(r => r.tone !== 'reached'));
  assert.ok(c.snapshot().proposal!.afterIds.includes('alpha2'));
});

test('unqualified data is never called Shortest, even with an exact proof', async () => {
  const { controller: c } = await env();
  c.setMark('gamma', 'want'); await c.find(); await solved(c);
  const p = c.snapshot().proposal!;
  assert.equal(p.contract.proof.kind, 'exact');
  assert.equal(p.certainty, 'Best found so far');
  assert.equal(certaintyOf({ proof: p.contract.proof, label: 'Shortest' }, true), 'Shortest');
  assert.equal(certaintyOf({ proof: p.contract.proof, label: 'Shortest' }, false), 'Best found so far');
});

test('stale Apply: a plan edit after the preview disables Apply and leaves the tree alone', async () => {
  const { session, controller: c, data } = await env();
  c.setMark('gamma', 'want'); await c.find(); await solved(c);
  assert.equal(c.snapshot().stale, false); assert.equal(c.snapshot().blocked, null);
  session.edit({ kind: 'allocation', stepId: first, beforeIds: [], afterIds: ['a1'], datasetHash: data.ref.contentHash });
  await session.flush();
  assert.equal(c.snapshot().stale, true);
  assert.equal(c.snapshot().blocked, STALE_TEXT);
  assert.equal(await c.apply(), STALE_TEXT);
  assert.deepEqual(stepOf(session).allocatedIds, ['a1']);
  assert.equal(staleReason(c.snapshot().proposal!, c.current()!), STALE_TEXT);
});

test('Apply is one tree-only edit and one Undo restores the source exactly', async () => {
  const { session, controller: c } = await env();
  c.setMark('gamma', 'want'); await c.find(); await solved(c);
  const before = structuredClone(session.state.plan!), eventsBefore = session.state.record!.history.events.length;
  assert.equal(await c.apply(), null); await session.flush();
  const after = session.state.plan!;
  assert.ok(stepOf(session).allocatedIds.includes('gamma1'));
  const strip = (p: AtlasPlan) => { const q = structuredClone(p); q.stepsById[first]!.allocatedIds = []; q.stepsById[first]!.repair = { missingIds: [], disconnectedIds: [] }; return q; };
  assert.deepEqual(strip(after), strip(before), 'only the step tree changed');
  assert.equal(session.state.record!.history.events.length, eventsBefore + 1, 'one transaction');
  await session.historyAction('undo');
  assert.deepEqual(session.state.plan!.stepsById[first]!.allocatedIds, []);
  assert.deepEqual(strip(session.state.plan!), strip(before));
});

test('avoid traversal: avoided notables are not targets, and travel through them is reported', async () => {
  const { controller: c } = await env();
  c.setMark('eps', 'want'); c.setMark('zeta', 'avoid'); await c.find(); await solved(c);
  const p = c.snapshot().proposal!;
  assert.ok(p.afterIds.includes('eps1'));
  assert.deepEqual(p.incidental.map(i => [i.name, i.nodeIds]), [['Synthetic Zeta', ['zeta1']]]);
  assert.ok(!c.snapshot().rowPlan.rows.some(r => r.targetIds.includes('zeta1')));
});

test('worker output for an older run is ignored once choices change', async () => {
  const { controller: c } = await env();
  c.setMark('gamma', 'want'); await c.find(); await solved(c);
  const old = c.snapshot().proposal!;
  c.setMark('alpha', 'want');
  assert.equal(c.snapshot().stale, true);
  assert.equal(await c.apply(), STALE_TEXT);
  assert.equal(c.snapshot().proposal?.contract.inputHash, old.contract.inputHash);
});

test('Keep current allocations starts ON; a choice saved with the plan wins; a step that cannot be kept starts OFF', async () => {
  const { session, controller: c, data } = await env();
  assert.equal(c.snapshot().choices.retainCurrent, true, 'fresh plan: on');
  const plan = session.state.plan!, step = stepOf(session);
  assert.equal(choicesFromPlan(plan, step, [], null, false).retainCurrent, false, 'unavailable or disconnected nodes: off');
  const saved = { ...structuredClone(plan), optimizerPreferences: { targetIds: ['gamma'], avoidNodeIds: [], retainCurrent: false, budget: 8 } };
  assert.equal(choicesFromPlan(saved, step, [], null).retainCurrent, false, 'saved choice wins');
  // On by default, Apply adds to the tree: an existing allocation stays.
  session.edit({ kind: 'allocation', stepId: first, beforeIds: [], afterIds: ['b1'], datasetHash: data.ref.contentHash }); await session.flush();
  c.setMark('gamma', 'want'); await c.find(); await solved(c);
  assert.ok(c.snapshot().proposal!.afterIds.includes('b1'), 'kept b1');
  assert.equal(await c.apply(), null); await session.flush();
  assert.ok(stepOf(session).allocatedIds.includes('b1') && stepOf(session).allocatedIds.includes('gamma1'));
});

test('a suggestion hover that resolves after the pointer left, or after Close, leaves no preview; a Details pin survives the pointer leaving', async () => {
  const { controller: c, graph } = await env();
  const rail = new RailController({ controller: c, ai: null, storage: null, online: () => false });
  const path = pathForTargets(graph, [], ['gamma1'])!;
  const row: Suggestion = { id: 'r', key: 'r', rule: 'test', origin: 'Rule', kind: 'path', text: 'Reach Gamma', detail: '', target: { targetId: 'gamma', name: 'Synthetic Gamma', nodeIds: ['gamma1'] }, afterIds: path.afterIds, cost: path.afterIds.length };
  // Pointer enters then leaves before the proposal is built: nothing may stick.
  const enter = rail.preview(row); await rail.preview(null); await enter;
  assert.equal(rail.snapshot().active, null, 'hover then leave: no preview');
  // Hover resolves after Close.
  const late = rail.preview(row); rail.closePreview(); await late;
  assert.equal(rail.snapshot().active, null, 'hover then Close: no preview');
  // A plain hover that stays shows the preview.
  await rail.preview(row); assert.equal(rail.snapshot().activeKey, 'r');
  await rail.preview(null); assert.equal(rail.snapshot().active, null);
  // Details pins it; the pointer leaving the chip while the pin is pending does not drop it.
  const pin = rail.preview(row, true); await rail.preview(null); await pin;
  assert.equal(rail.snapshot().activeKey, 'r'); assert.equal(rail.snapshot().pinned, true);
  rail.dispose();
});

test('Apply summary: points added, removed and left, and why points are left unspent', async () => {
  const { controller: c, graph } = await env(8);
  c.setMark('gamma', 'want'); await c.find(); await solved(c);
  let p = c.snapshot().proposal!, s = applySummary(graph, p, 8);
  // root -> c1 -> c2 -> c3 -> gamma1: four 1-point nodes.
  assert.deepEqual([s.addedNodes, s.addedPoints, s.removedNodes, s.removedPoints, s.total, s.left], [4, 4, 0, 0, 4, 4]);
  assert.equal(s.unspent, 'Why points are left: Synthetic Gamma is reached, and the optimizer only spends the points a path needs. Choose more mechanics to use them.');
  assert.equal(summaryText(s), 'Adds 4 points (4 nodes). 4 / 8 points, 4 left.');
  // Budget 5 with three mechanics: alpha fits (4), beta and gamma do not fit in the 1 point left.
  const small = await env(5);
  small.controller.setMark('alpha', 'want'); small.controller.setMark('beta', 'want'); small.controller.setMark('gamma', 'want');
  await small.controller.find(); await solved(small.controller);
  p = small.controller.snapshot().proposal!; s = applySummary(small.graph, p, 5);
  assert.equal(s.total, 4); assert.equal(s.left, 1);
  // Unqualified data: the skips are estimates, so they are 'not proven to fit yet', never 'does not fit'.
  assert.deepEqual(p.results.slice(1).map(r => r.tone), ['tentative', 'tentative']);
  assert.match(s.unspent!, /^Why points are left: Synthetic Beta \(.+\), Synthetic Gamma \(.+\) are not proven to fit yet\.$/);
  // Each kind of miss is worded for what it is.
  const mixed = { ...p, results: [p.results[0]!, { ...p.results[1]!, tone: 'short' as const, label: '4 points short' }, { ...p.results[2]!, tone: 'unavailable' as const, label: 'No connected path' }] };
  assert.equal(applySummary(small.graph, mixed, 5).unspent, 'Why points are left: Synthetic Beta (4 points short) does not fit in what is left; Synthetic Gamma (No connected path) cannot be reached in this tree data.');
  // Every point used: nothing to explain.
  assert.equal(applySummary(small.graph, p, 4).unspent, null);
  // Over budget: says by how much, never a negative "left".
  const over = applySummary(small.graph, p, 3);
  assert.equal(over.left, -1); assert.equal(over.unspent, null); assert.match(summaryText(over), /4 \/ 3 points, 1 over budget\.$/);
});
