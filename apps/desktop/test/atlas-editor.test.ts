import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atlasPlanSchema, parseId, type AtlasPlan, type StepId } from '@pom/mastery-contracts';
import { limits } from '@pom/mastery-contracts/fixtures';
import { createPlan, selectedSteps } from '../src/shared/atlas/plan.js';
import { createGraph, known } from '../src/shared/atlas/graph.js';
import { previewAllocation } from '../src/shared/atlas/allocation.js';
import { DocumentStore } from '../src/main/documents/store.js';
import { importMastery, exportMasteryFile } from '../src/main/atlas/formats.js';
import { syntheticDataset } from '../src/renderer/atlas/editor/fixtureSource.js';
import { SyntheticRepository } from '../src/renderer/atlas/editor/fixtureModel.js';
import { AtlasEditorSession, type AtlasEditorPort } from '../src/renderer/atlas/editor/session.js';
import { atlasServicePort } from '../src/renderer/atlas/editor/servicePort.js';
import { editPlan, importLabel, pointSummary, rowPrice, sameCoordinates, stepAfterRemoval, stepIds, transition, uniqueTitle } from '../src/renderer/atlas/editor/presenter.js';
import { changeTreeData, dataChangePreview } from '../src/renderer/atlas/editor/dataChange.js';
import { allocationImport, codecInput } from '../src/renderer/atlas/editor/externalImport.js';
import { encodeOfficialAtlasLink } from '../src/shared/atlas/codecs/external.js';

const data = syntheticDataset(), first = parseId('step', 'step:first'), second = parseId('step', 'step:second'), third = parseId('step', 'step:third');
const graph = createGraph(data.graph, known(data.costModel, 'synthetic-fixture'));
test('official and poeplanner link previews preserve exact nodes and unknown source scope', () => {
  for (const input of ['https://www.pathofexile.com/fullscreen-atlas-skill-tree/AAAABgAAA_dPX-tuugAA', 'https://poeplanner.com/atlas-tree/BQAcAAADAE_361-6bhQAH4sIAAAAAAAAAwMAAAAAAAAAAAA=']) {
    const decoded = importMastery(input, limits, undefined, graph); assert.equal(decoded.kind, 'allocation');
    if (decoded.kind !== 'allocation') throw new Error('Expected supported allocation');
    const preview = allocationImport(decoded, { dataset: data.ref, stamp: data.ref.stamp, budget: 2, qualified: true, active: true }, first, input, data.ref.stamp.createdAt, limits);
    assert.equal(preview.sourceInput, input); assert.equal(preview.snapshot.document.kind, 'atlas');
    if (preview.snapshot.document.kind !== 'atlas') throw new Error('Expected Atlas');
    const p = preview.snapshot.document.payload;
    assert.equal(atlasPlanSchema.parse(p, limits).ok, true); assert.deepEqual(p.stepsById[first]!.allocatedIds, ['63311', '24555', '28346']);
    assert.equal(p.stamp.leagueId.status, 'unknown'); assert.equal(p.stamp.mode.status, 'unknown'); assert.deepEqual(p.stepsById[first]!.maps, []);
    assert.deepEqual(p.stepsById[first]!.repair.missingIds, ['24555', '28346', '63311']);
  }
});
test('tree codes use the verified codecs and official export round trips exact IDs', () => {
  const link = encodeOfficialAtlasLink(['63311', '24555', '28346'])!;
  const decoded = importMastery(codecInput(link.split('/').at(-1)!), limits); assert.equal(decoded.kind, 'allocation');
  if (decoded.kind === 'allocation') assert.deepEqual(decoded.nodeIds, ['63311', '24555', '28346']);
  assert.equal(encodeOfficialAtlasLink(['synthetic-node']), null);
  assert.equal(codecInput('not a tree code'), 'not a tree code');
});
test('comparison of identical node IDs on changed source data keeps the stat delta visible', () => {
  const p = plan(); p.stepsById[first]!.allocatedIds = ['synthetic-bridge'];
  const changed = structuredClone(data.graph); changed.graphHash = parseId('hash', 'a'.repeat(64)); changed.nodes.find(n => n.nodeId === 'synthetic-bridge')!.stats[0]!.value = { status: 'known', value: 9, evidenceId: 'changed-source' };
  const other = createGraph(changed, known(data.costModel, 'synthetic-fixture'));
  const delta = transition(p.stepsById[first]!, p.stepsById[first]!, graph, other, 'changed tree');
  assert.equal(delta.empty, false); assert.equal(delta.stats[0]!.delta, 8); assert.deepEqual(delta.addedIds, []);
});
function plan(): AtlasPlan { return createPlan(data.ref, data.ref.stamp, first, 2); }
test('new and copied title suggestions are unique and stay within the Unicode name limit', () => {
  assert.equal(uniqueTitle('Untitled atlas plan', ['Untitled atlas plan', 'Untitled atlas plan (2)']), 'Untitled atlas plan (3)');
  const title = '😀'.repeat(120), next = uniqueTitle(title, [title]); assert.equal([...next].length, 120); assert.ok(next.endsWith(' (2)'));
});
const extras: Pick<AtlasEditorPort, 'parse' | 'importNew' | 'exportFile' | 'share' | 'exportRecovery'> = {
  parse: async input => importMastery(input, limits), importNew: async () => { throw new Error('unused'); }, exportFile: async () => {}, share: async () => 'https://example.invalid/synthetic', exportRecovery: async () => {},
};
async function session() { const repository = new SyntheticRepository(data), port = repository.port(extras), editor = new AtlasEditorSession(port, limits); await editor.create(plan()); return { repository, port, editor }; }

test('direct New creates a complete empty source-stamped single step with no fabricated cap', () => {
  const p = plan(); assert.equal(p.title, 'Untitled atlas plan'); assert.equal(p.stepsById[first]!.title, 'Step 1'); assert.deepEqual(p.stepsById[first]!.allocatedIds, []);
  assert.deepEqual(p.stamp, data.ref.stamp); assert.equal(p.stamp.leagueId.status, 'unknown'); assert.equal(data.costModel.maximumPoints.status, 'unknown'); assert.equal(atlasPlanSchema.parse(p, limits).ok, true);
});
test('quick Step copies the complete snapshot; Empty step retains source data and empties practical fields', () => {
  let p = plan(); p.stepsById[first]!.scarabs = [{ catalogId: 'synthetic-scarab', quantity: 0, provenance: [], price: { status: 'unknown', reason: 'No price.' } }]; p.stepsById[first]!.strategy = 'Original notes';
  p = editPlan(p, { kind: 'add', sourceId: first, newId: second }, limits);
  assert.deepEqual(p.stepsById[second]!.scarabs, p.stepsById[first]!.scarabs); assert.equal(p.stepsById[second]!.strategy, 'Original notes');
  p = editPlan(p, { kind: 'add', sourceId: second, newId: third, empty: true }, limits); assert.deepEqual(p.stepsById[third]!.scarabs, []); assert.equal(p.stepsById[third]!.strategy, '');
});
test('alternatives remain one sequence position and default selects one complete snapshot for Run', () => {
  let p = editPlan(plan(), { kind: 'alternative', sourceId: first, newId: second, groupId: 'choice' }, limits);
  p = editPlan(p, { kind: 'step', stepId: second, field: 'pointBudget', value: 9 }, limits);
  p = editPlan(p, { kind: 'default', positionId: first, stepId: second }, limits);
  assert.equal(p.sequencePositions.length, 1); assert.equal(selectedSteps(p).length, 1); assert.equal(selectedSteps(p)[0]!.pointBudget, 9); assert.equal(p.stepsById[first]!.pointBudget, 2);
  assert.throws(() => editPlan(p, { kind: 'default', positionId: first, stepId: third }, limits));
});
test('removing an option repairs selection and collapses a group; the last step is protected', () => {
  const p = editPlan(plan(), { kind: 'alternative', sourceId: first, newId: second, groupId: 'choice' }, limits), next = editPlan(p, { kind: 'remove', stepId: second }, limits);
  assert.equal(stepAfterRemoval(p, next, second), first); assert.equal(next.sequencePositions[0]!.kind, 'step'); assert.throws(() => editPlan(next, { kind: 'remove', stepId: first }, limits));
});
test('reorder preserves identities and snapshots while rejecting missing positions', () => {
  const p = editPlan(plan(), { kind: 'add', sourceId: first, newId: second }, limits), next = editPlan(p, { kind: 'reorder', positionIds: [second, first] }, limits);
  assert.deepEqual(stepIds(next), [second, first]); assert.deepEqual(next.stepsById, p.stepsById); assert.throws(() => editPlan(p, { kind: 'reorder', positionIds: [first] }, limits));
});
test('presets append empty structure, require authored increasing targets, and Replace is a full transaction', () => {
  const p = editPlan(plan(), { kind: 'preset', names: ['Early', 'Mid'], ids: [second, third], replace: false }, limits);
  assert.equal(stepIds(p).length, 3); assert.deepEqual(p.stepsById[second]!.allocatedIds, []);
  assert.throws(() => editPlan(plan(), { kind: 'preset', names: ['A', 'B'], ids: [second, third], targets: [8, 3], replace: false }, limits));
  const replaced = editPlan(p, { kind: 'preset', names: ['Only'], ids: [parseId('step', 'fresh')], replace: true }, limits); assert.equal(stepIds(replaced).length, 1);
});
test('manual overbudget allocations remain saveable; stale and disconnected requests fail', () => {
  const p = plan(), preview = previewAllocation(graph, [], 'synthetic-leaf', 2);
  const next = editPlan(p, { kind: 'allocation', stepId: first, beforeIds: [], afterIds: preview.allocatedIds, datasetHash: data.ref.contentHash }, limits, graph);
  assert.equal(pointSummary(graph, next.stepsById[first]!).over, 1);
  assert.throws(() => editPlan(next, { kind: 'allocation', stepId: first, beforeIds: [], afterIds: [], datasetHash: data.ref.contentHash }, limits, graph));
  assert.throws(() => editPlan(p, { kind: 'allocation', stepId: first, beforeIds: [], afterIds: ['synthetic-leaf'], datasetHash: data.ref.contentHash }, limits, graph));
});
test('practical rows deduplicate by catalog ID, preserve zero, and price Unknown stays explicit', () => {
  const c = data.catalogs.scarabs[0]!;
  let p = editPlan(plan(), { kind: 'row', stepId: first, list: 'scarabs', catalog: c }, limits);
  p = editPlan(p, { kind: 'row', stepId: first, list: 'scarabs', catalog: c, quantity: 0 }, limits);
  assert.equal(p.stepsById[first]!.scarabs.length, 1); assert.equal(rowPrice(p.stepsById[first]!.scarabs[0]!), 'Not used in this step');
  p = editPlan(p, { kind: 'quantity', stepId: first, catalogId: c.catalogId, quantity: 3 }, limits); assert.equal(rowPrice(p.stepsById[first]!.scarabs[0]!), 'Price unavailable');
  assert.throws(() => editPlan(p, { kind: 'quantity', stepId: first, catalogId: c.catalogId, quantity: -1 }, limits));
});
test('plan-wide instructions are stored once; Unicode field limits reject rather than truncate', () => {
  let p = editPlan(plan(), { kind: 'notes', scope: 'plan', instructions: { firstAction: 'Read once' } }, limits);
  assert.equal(p.instructions.firstAction, 'Read once'); assert.equal(p.stepsById[first]!.instructions.firstAction, '');
  p = editPlan(p, { kind: 'notes', scope: first, instructions: { firstAction: '🙂'.repeat(160) } }, limits);
  assert.equal([...p.stepsById[first]!.instructions.firstAction].length, 160);
  assert.throws(() => editPlan(p, { kind: 'notes', scope: first, instructions: { firstAction: '🙂'.repeat(161) } }, limits));
  assert.throws(() => editPlan(p, { kind: 'notes', scope: first, instructions: { details: 'x'.repeat(10001) } }, limits));
});
test('diff is read-only, Swap reverses removal/addition and text lists Remove before Allocate', () => {
  const p = plan(), a = p.stepsById[first]!, b = structuredClone(a); a.allocatedIds = ['synthetic-bridge', 'synthetic-left']; b.allocatedIds = ['synthetic-bridge', 'synthetic-right'];
  const original = JSON.stringify(p), d = transition(a, b, graph, graph, 'synthetic'), reverse = transition(b, a, graph, graph, 'synthetic');
  assert.deepEqual(d.removedIds, ['synthetic-left']); assert.deepEqual(d.addedIds, reverse.removedIds); assert.ok(d.text.indexOf('Remove') < d.text.indexOf('Allocate')); assert.equal(JSON.stringify(p), original);
  assert.equal(transition(a, a, graph, graph, 'synthetic').empty, true);
});
test('compare links only identical pinned coordinates and copying never replaces selected step', () => {
  assert.equal(sameCoordinates({ datasetHash: 'a', graphHash: 'b' }, { datasetHash: 'a', graphHash: 'b' }), true); assert.equal(sameCoordinates({ datasetHash: 'a', graphHash: 'b' }, { datasetHash: 'c', graphHash: 'b' }), false);
  const p = plan(), before = structuredClone(p.stepsById[first]);
  const next = editPlan(p, { kind: 'importStep', selected: first, newId: second, source: { ...p.stepsById[first]!, strategy: 'Right strategy' }, target: 'add' }, limits, graph);
  assert.deepEqual(next.stepsById[first], before); assert.equal(next.stepsById[second]!.strategy, 'Right strategy');
});
test('imports use the unsupported and wrong-Build dispatch without changing the input', async () => {
  const unsupported = 'https://poeplanner.com/atlas-tree/synthetic', build = 'https://www.pathofexile.com/passive-skill-tree/synthetic';
  const result = importMastery(unsupported, limits); assert.equal(result.kind, 'unsupported'); if (result.kind === 'unsupported') assert.equal(result.message, 'This atlas link format is not supported yet.');
  const other = importMastery(build, limits); assert.equal(other.kind, 'build'); if (other.kind === 'build') assert.equal(other.input, build);
  assert.deepEqual(['new', 'add', 'replace'].map(v => importLabel(v as 'new' | 'add' | 'replace')), ['Import as new plan', 'Add step', 'Replace step']);
});
test('self-contained export round trips Unknown stamps and excludes private notes and history by default', () => {
  const file = exportMasteryFile({ document: { kind: 'atlas', payload: plan() }, datasets: [data], privateNotes: [{ snapshot: 'local', text: 'Private' }] }, limits);
  const parsed = importMastery(file.text, limits); assert.equal(parsed.kind, 'snapshot');
  if (parsed.kind === 'snapshot') { assert.equal(parsed.snapshot.document.kind, 'atlas'); assert.equal(parsed.snapshot.privateNotes, undefined); assert.equal(parsed.snapshot.history, undefined); if (parsed.snapshot.document.kind === 'atlas') assert.equal(parsed.snapshot.document.payload.stamp.leagueId.status, 'unknown'); }
});
test('rapid edits serialize CAS saves and retain newest draft', async () => {
  const { editor, repository } = await session();
  editor.edit({ kind: 'title', title: 'First' }); editor.edit({ kind: 'title', title: 'Second' }); await editor.flush();
  assert.equal(editor.state.save, 'saved'); assert.equal(editor.state.plan!.title, 'Second'); assert.equal((await repository.read(editor.state.record!.source.objectId)).view.document.payload.title, 'Second'); assert.equal(editor.state.record!.history.events.length, 3); editor.dispose();
});
test('failed writes retain latest changes, stop queued writes and recover before navigation', async () => {
  const { editor, repository } = await session(); const id = editor.state.record!.source.objectId;
  repository.failNext = true; editor.edit({ kind: 'title', title: 'Unsaved first' }); editor.edit({ kind: 'title', title: 'Unsaved latest' }); await editor.flush();
  assert.equal(editor.state.save, 'failed'); assert.equal(editor.state.plan!.title, 'Unsaved latest'); assert.equal((await repository.read(id)).history.events.length, 1); assert.equal(await editor.back(), false);
  await editor.retry(); assert.equal(editor.state.save, 'saved'); assert.equal((await repository.read(id)).view.document.payload.title, 'Unsaved latest'); assert.equal((await repository.read(id)).history.events.length, 2); editor.dispose();
});
test('text edits coalesce on blur into one snapshot containing all fields', async () => {
  const { editor } = await session(); editor.edit({ kind: 'title', title: 'Typing 1' }, true); editor.edit({ kind: 'title', title: 'Typing 2' }, true);
  editor.edit({ kind: 'notes', scope: first, strategy: 'Notes in the same group' }, true); await editor.flush();
  assert.equal(editor.state.record!.history.events.length, 2); assert.equal(editor.state.plan!.stepsById[first]!.strategy, 'Notes in the same group'); editor.dispose();
});
test('undo restores allocation and practical fields together; new edits retain abandoned branch', async () => {
  const { editor } = await session(); editor.edit({ kind: 'alternative', sourceId: first, newId: second, groupId: 'choice' }); await editor.flush();
  editor.edit({ kind: 'notes', scope: second, strategy: 'Abandoned' }); await editor.flush(); const prior = editor.state.record!.history.events.at(-1)!.transactionId;
  await editor.historyAction('undo'); editor.edit({ kind: 'notes', scope: second, strategy: 'Active' }); await editor.flush();
  assert.equal(editor.state.plan!.stepsById[second]!.strategy, 'Active'); assert.ok(editor.state.record!.history.events.some(e => e.transactionId === prior)); assert.equal(editor.canRedo, false); editor.dispose();
});
test('historical previews block edits and Restore adds an undoable transaction without erasing later events', async () => {
  const { editor } = await session(); const created = editor.state.record!.history.events[0]!;
  editor.edit({ kind: 'title', title: 'Later' }); await editor.flush(); await editor.preview(created.transactionId);
  editor.edit({ kind: 'title', title: 'Must not save' }); assert.equal(editor.state.plan!.title, 'Later'); assert.equal(editor.state.preview!.view.document.payload.title, 'Untitled atlas plan');
  await editor.restorePreview(); assert.equal(editor.state.plan!.title, 'Untitled atlas plan'); assert.equal(editor.state.record!.history.events.length, 3); await editor.historyAction('undo'); assert.equal(editor.state.plan!.title, 'Later'); editor.dispose();
});
test('closing replay invalidates an in-flight preview and preserves selection and viewport', async () => {
  const { editor, port } = await session(); let release!: () => void; const ready = new Promise<void>(resolve => { release = resolve; });
  const original = port.preview; port.preview = async (id, tx) => { await ready; return original(id, tx); };
  const view = { x: 20, y: 30, scale: 1.5 }; editor.update({ viewports: { [first]: view } });
  const pending = editor.preview(editor.state.record!.history.events[0]!.transactionId); await new Promise(resolve => setTimeout(resolve, 0)); editor.returnCurrent(); release(); await pending;
  assert.equal(editor.state.preview, null); assert.equal(editor.state.selected, first); assert.deepEqual(editor.state.viewports[first], view); editor.dispose();
});
test('offline fixture storage reopens all snapshots, branches and trash', async () => {
  let json: string | null = null; const storage = { load: () => json, save: (value: string) => { json = value; } }, repo = new SyntheticRepository(data, storage), port = repo.port(extras);
  const created = await repo.create(plan()); await port.trash(created.source.objectId); const reopened = new SyntheticRepository(data, storage).port(extras);
  assert.ok((await reopened.list())[0]!.deletedAt); await reopened.restoreTrash(created.source.objectId); assert.equal((await reopened.read(created.source.objectId)).view.document.payload.stamp.leagueId.status, 'unknown');
});
test('service composition durably saves, reopens, branches, previews and restores', async () => {
  const root = await mkdtemp(join(tmpdir(), 'p10-documents-')); let documents = new DocumentStore(root, { schemas: { atlas: atlasPlanSchema }, limits, checkpointEvery: 2 }); await documents.init();
  const compose = () => atlasServicePort({
    read: async (id, revision) => ({ document: revision ? await documents.readRevision<AtlasPlan>(id, revision) : await documents.read<AtlasPlan>(id), data: null, warnings: [], steps: {} }),
    save: (request, label) => documents.write('atlas', request, { label: label ?? 'Edited plan' }),
  }, documents, { ...extras, metadata: async () => ({ ownership: 'owned', folderId: null, lastOpenedAt: '' }), move: async () => {}, createFolder: async () => {} });
  try {
    let port = compose(), editor = new AtlasEditorSession(port, limits); await editor.create(plan()); const id = editor.state.record!.source.objectId;
    editor.edit({ kind: 'title', title: 'Durable' }); await editor.flush(); await editor.historyAction('undo'); editor.edit({ kind: 'title', title: 'Branch' }); await editor.flush();
    const historical = editor.state.record!.history.events[0]!.transactionId; editor.dispose(); await documents.close();
    documents = new DocumentStore(root, { schemas: { atlas: atlasPlanSchema }, limits, checkpointEvery: 2 }); await documents.init(); port = compose(); editor = new AtlasEditorSession(port, limits); await editor.open(id);
    assert.equal(editor.state.plan!.title, 'Branch'); assert.equal(editor.state.record!.history.events.length, 3); await editor.preview(historical); assert.equal(editor.state.preview!.view.document.payload.title, 'Untitled atlas plan');
    await editor.restorePreview(); assert.equal(editor.state.record!.history.events.length, 4); await port.trash(id); assert.ok((await port.list())[0]!.deletedAt); await port.restoreTrash(id); editor.dispose();
  } finally { await documents.close(true); await rm(root, { recursive: true, force: true }); }
});
test('failed-save recovery stages the newest queued draft and reopens before Retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'p10-recovery-')); let fail = false;
  const options = { schemas: { atlas: atlasPlanSchema }, limits, checkpointEvery: 2, probe: (point: string) => { if (fail && point === 'beforeIndexCommit') throw new Error('Synthetic disk fault.'); } };
  let documents = new DocumentStore(root, options); await documents.init();
  const compose = () => atlasServicePort({ read: async (id, revision) => ({ document: revision ? await documents.readRevision<AtlasPlan>(id, revision) : await documents.read<AtlasPlan>(id), data: null, warnings: [], steps: {} }), save: (request, label) => documents.write('atlas', request, { label: label ?? 'Edited plan' }) }, documents,
    { ...extras, metadata: async () => ({ ownership: 'owned', folderId: null, lastOpenedAt: '' }), move: async () => {}, createFolder: async () => {} });
  try {
    let editor = new AtlasEditorSession(compose(), limits); await editor.create(plan()); const id = editor.state.record!.source.objectId;
    fail = true; editor.edit({ kind: 'title', title: 'Failed earlier draft' }); editor.edit({ kind: 'title', title: 'Latest recovery draft' }); await editor.flush();
    assert.equal(editor.state.save, 'failed'); assert.equal((documents.pendingSnapshot(id)!.request.payload as AtlasPlan).title, 'Latest recovery draft'); assert.equal(documents.history(id).events.length, 1);
    editor.dispose(); await documents.close(true); fail = false; documents = new DocumentStore(root, options); await documents.init();
    editor = new AtlasEditorSession(compose(), limits); await editor.open(id); assert.equal(editor.state.save, 'failed'); assert.equal(editor.state.plan!.title, 'Latest recovery draft');
    await editor.retry(); assert.equal(editor.state.save, 'saved'); assert.equal((await documents.read<AtlasPlan>(id)).payload.title, 'Latest recovery draft'); assert.equal(documents.history(id).events.length, 2); editor.dispose();
  } finally { await documents.close(true); await rm(root, { recursive: true, force: true }); }
});
test('reviewed grouping changes sequence structure without rewriting either snapshot', () => {
  const p = editPlan(plan(), { kind: 'add', sourceId: first, newId: second }, limits), original = structuredClone(p.stepsById);
  const next = editPlan(p, { kind: 'group', stepIds: [first, second], groupId: 'reviewed-choice', defaultStepId: second }, limits);
  assert.deepEqual(next.stepsById, original); assert.equal(next.sequencePositions.length, 1); assert.deepEqual(selectedSteps(next).map(s => s.stepId), [second]);
  assert.throws(() => editPlan(next, { kind: 'group', stepIds: [first, second], groupId: 'bad', defaultStepId: first }, limits));
});
test('dataset preview compares exact IDs and structural repair requires reviewed removals', () => {
  const p = plan(); p.stepsById[first]!.allocatedIds = ['synthetic-bridge', 'synthetic-left'];
  const target = structuredClone(data); target.graph.nodes = target.graph.nodes.filter(n => n.nodeId !== 'synthetic-left'); target.graph.nodes.forEach(n => { n.adjacentIds = n.adjacentIds.filter(id => id !== 'synthetic-left'); }); delete target.costModel.nodeCosts['synthetic-left'];
  const targetGraph = createGraph(target.graph, known(target.costModel, 'synthetic-fixture'));
  assert.equal(dataChangePreview(p, graph, targetGraph).find(row => row.id === 'synthetic-left')!.status, 'Missing in target data');
  assert.throws(() => changeTreeData(p, target.ref, targetGraph, [], limits));
  const next = changeTreeData(p, target.ref, targetGraph, ['synthetic-left'], limits); assert.deepEqual(next.stepsById[first]!.allocatedIds, ['synthetic-bridge']); assert.deepEqual(p.stepsById[first]!.allocatedIds, ['synthetic-bridge', 'synthetic-left']);
});
test('selected step and library settings survive a round trip to the library', async () => {
  const { editor } = await session(); editor.edit({ kind: 'add', sourceId: first, newId: second }); editor.select(second); editor.update({ query: 'retained', sort: 'Name', view: 'list' }); await editor.flush(); const id = editor.state.record!.source.objectId;
  await editor.back(); await editor.open(id); assert.equal(editor.state.selected, second); assert.equal(editor.state.query, 'retained'); assert.equal(editor.state.sort, 'Name'); assert.equal(editor.state.view, 'list'); editor.dispose();
});
test('save as copy gives a new identity and copy-source history without mutating its source', async () => {
  const { editor, repository } = await session(); const source = editor.state.record!, sourcePlan = structuredClone(editor.state.plan!);
  await editor.create({ ...sourcePlan, title: `${sourcePlan.title} copy` }, `Copy source revision ${source.source.revisionId}`);
  assert.notEqual(editor.state.record!.source.objectId, source.source.objectId); assert.deepEqual((await repository.read(source.source.objectId)).view.document.payload, sourcePlan);
  assert.ok(editor.state.record!.history.events[0]!.label.includes(source.source.revisionId)); assert.deepEqual(editor.state.plan!.dataset, sourcePlan.dataset); editor.dispose();
});
test('map rows store optional Tier and Purpose; same map and tier updates one row; priority is array order', () => {
  const c = data.catalogs.maps[0]!;
  let p = editPlan(plan(), { kind: 'row', stepId: first, list: 'maps', catalog: c, tier: 16 }, limits);
  p = editPlan(p, { kind: 'row', stepId: first, list: 'maps', catalog: c, tier: 16, quantity: 2 }, limits);
  p = editPlan(p, { kind: 'row', stepId: first, list: 'maps', catalog: c }, limits);
  assert.equal(p.stepsById[first]!.maps.length, 2); assert.equal(p.stepsById[first]!.maps[0]!.tier, 16); assert.equal(p.stepsById[first]!.maps[0]!.quantity, 2); assert.ok(!('tier' in p.stepsById[first]!.maps[1]!));
  p = editPlan(p, { kind: 'mapField', stepId: first, index: 1, tier: 5, purpose: 'Farm currency' }, limits);
  assert.equal(p.stepsById[first]!.maps[1]!.purpose, 'Farm currency');
  p = editPlan(p, { kind: 'moveMap', stepId: first, from: 1, to: 0 }, limits); assert.equal(p.stepsById[first]!.maps[0]!.tier, 5);
  p = editPlan(p, { kind: 'mapField', stepId: first, index: 0, tier: null, purpose: '' }, limits); assert.ok(!('tier' in p.stepsById[first]!.maps[0]!) && !('purpose' in p.stepsById[first]!.maps[0]!));
  assert.throws(() => editPlan(p, { kind: 'mapField', stepId: first, index: 0, tier: 0 }, limits)); assert.throws(() => editPlan(p, { kind: 'mapField', stepId: first, index: 0, tier: 1.5 }, limits));
});
