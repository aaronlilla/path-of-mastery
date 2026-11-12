import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSnapshotSchema, parseId, timelineSchema, type Clip, type FrozenSource, type Timeline } from '@pom/mastery-contracts';
import { build, limits, plan, ref, stamp } from '@pom/mastery-contracts/fixtures';
import { contentHash, instruction, pinSource, validated, verifySource } from '../src/shared/timelines/adapters/common.js';
import { addLane, adoptClip, applySourceUpdate, cloneClip, copyClip, excludedByCoverage, inActiveLeague, migrateLegacyDisabled, moveLevelMarker, newTimeline, nextFreeRange, placeClip, previewResize, previewSourceUpdate, rangeLabel, removeClip, reorderLane,
  preflightRun, resolveUpdateConflict, UNMATCHED_IN_UPDATE, sendDefaults, snapBoundary, sourceClip, withAtlasPoints, withCoverage, atlasSourceSpan } from '../src/shared/timelines/editor/index.js';
import { compileSchedule } from '../src/shared/timelines/scheduler/index.js';
import { DocumentStore } from '../src/main/documents/store.js';
import { TimelineService } from '../src/main/timelines/service.js';
import { documentSource } from '../src/main/timelines/sources.js';

async function fixture() {
  const payload = build();
  payload.guide = [1, 5, 5, 10, 20].map((level, index) => ({ actionId: parseId('action', `authored-${index}`), contentHash: ref().payloadHash,
    trigger: { kind: 'level' as const, level }, requirements: [], instruction: instruction(`Read action ${index}.`) }));
  const source = await pinSource(ref(), { kind: 'build', payload }, limits);
  const timeline = newTimeline(stamp());
  const clip = await sourceClip(source, timeline.lanes[0]!.laneId, limits, { range: { start: 1, endExclusive: 21 } });
  const placed = await placeClip(timeline, clip, limits);
  assert.equal(placed.status, 'applied');
  return { timeline: placed.status === 'applied' ? placed.timeline : timeline, clip, source };
}
test('half-open ranges accept adjacency and level 100; other lanes overlap', async () => {
  const { timeline, clip } = await fixture();
  assert.equal(rangeLabel({ start: 96, endExclusive: 101 }), 'Levels 96-100');
  const adjacent = withCoverage(await cloneClip(clip), { start: 21, endExclusive: 41 });
  assert.equal((await placeClip(timeline, adjacent, limits)).status, 'applied');
  await assert.rejects(placeClip(timeline, { ...clip, range: { start: 1, endExclusive: 102 } }, limits), /Levels 1-100/);
  const secondLane = addLane(timeline, 'build');
  const crossLane = await cloneClip(clip, undefined, secondLane.lanes.at(-1)!.laneId);
  assert.equal((await placeClip(secondLane, crossLane, limits)).status, 'applied');
});
test('collision defaults to review, Cancel preserves input, Replace range splits and retains sources/actions', async () => {
  const { timeline, clip } = await fixture(), before = structuredClone(timeline);
  const incoming = withCoverage(await cloneClip(clip), { start: 6, endExclusive: 11 });
  assert.equal((await placeClip(timeline, incoming, limits)).status, 'collision');
  assert.equal((await placeClip(timeline, incoming, limits, 'cancel')).status, 'cancelled');
  const result = await placeClip(timeline, incoming, limits, 'replace_range');
  assert.equal(result.status, 'applied');
  if (result.status !== 'applied') return;
  assert.deepEqual(result.timeline.clips.map(row => row.range).sort((a, b) => a.start - b.start), [{ start: 1, endExclusive: 6 }, { start: 6, endExclusive: 11 }, { start: 11, endExclusive: 21 }]);
  for (const piece of result.timeline.clips) assert.deepEqual(piece.options[0]!.source, clip.options[0]!.source);
  assert.equal(result.timeline.clips.reduce((n, clip) => n + clip.options[0]!.actions.length, 0), 15);
  assert.ok(result.excluded.length > 0);
  assert.deepEqual(timeline, before);
  assert.equal(timelineSchema.parse(result.timeline, limits).ok, true);
});
test('Replace range trims either edge, covers a whole clip, and handles multiple collisions', async () => {
  const { timeline, clip } = await fixture();
  for (const range of [{ start: 1, endExclusive: 6 }, { start: 10, endExclusive: 21 }, { start: 1, endExclusive: 21 }]) {
    const incoming = withCoverage(await cloneClip(clip), range), result = await placeClip(timeline, incoming, limits, 'replace_range');
    assert.equal(result.status, 'applied');
    if (result.status === 'applied') assert.equal(result.timeline.clips.length, range.endExclusive - range.start === 20 ? 1 : 2);
  }
  const right = withCoverage(await cloneClip(clip), { start: 25, endExclusive: 41 });
  const two = await placeClip(timeline, right, limits); assert.equal(two.status, 'applied');
  if (two.status !== 'applied') return;
  const both = await placeClip(two.timeline, withCoverage(await cloneClip(clip), { start: 7, endExclusive: 35 }), limits, 'replace_range');
  assert.equal(both.status, 'applied');
  if (both.status === 'applied') assert.deepEqual(both.timeline.clips.map(clip => clip.range).sort((a, b) => a.start - b.start), [{ start: 1, endExclusive: 7 }, { start: 7, endExclusive: 35 }, { start: 35, endExclusive: 41 }]);
});
test('next free moves forward deterministically, rejects overflow and preserves authored levels', async () => {
  const { timeline, clip } = await fixture();
  const incoming = await cloneClip(clip), result = await placeClip(timeline, incoming, limits, 'next_free');
  assert.equal(result.status, 'applied');
  if (result.status === 'applied') {
    const moved = result.timeline.clips.find(row => row.clipId === incoming.clipId)!;
    assert.deepEqual(moved.range, { start: 21, endExclusive: 41 });
    assert.deepEqual(moved.options[0]!.actions.map(action => action.trigger), clip.options[0]!.actions.map(action => action.trigger));
    assert.equal(moved.excludedActionIds.length, 5);
  }
  assert.deepEqual(nextFreeRange(timeline, clip.laneId, { start: 90, endExclusive: 101 }), { start: 90, endExclusive: 101 });
  assert.equal(nextFreeRange({ ...timeline, clips: [{ ...clip, range: { start: 1, endExclusive: 101 } }] }, clip.laneId, { start: 90, endExclusive: 101 }), null);
});
test('Keep instruction timing preserves sources, requirements and triggers; excludes are explicit and reversible', async () => {
  const { clip } = await fixture(), before = structuredClone(clip);
  const preview = await previewResize(clip, { start: 6, endExclusive: 21 }, 'keep_instruction_timing');
  assert.equal(preview.ok, true);
  if (!preview.ok) return;
  assert.deepEqual(preview.clip.options, clip.options); assert.equal(preview.excluded.length, 3);
  assert.deepEqual(withCoverage(preview.clip, clip.range).excludedActionIds, []);
  assert.deepEqual(clip, before);
});
test('Scale timing uses monotonic integer rounding with stable ties and previewed changes', async () => {
  const { clip } = await fixture();
  const preview = await previewResize(clip, { start: 1, endExclusive: 11 }, 'scale_timing');
  assert.equal(preview.ok, true);
  if (!preview.ok) return;
  assert.deepEqual(preview.clip.options[0]!.actions.map(action => action.trigger.kind === 'level' && action.trigger.level), [1, 3, 3, 5, 10]);
  assert.equal(preview.changes.length, 4);
  assert.notEqual(preview.clip.options[0]!.actions[1]!.contentHash, clip.options[0]!.actions[1]!.contentHash);
});
test('invalid scaling is atomic and keeps hard level, quest, AreaLevel and Atlas-point constraints', async () => {
  const { clip } = await fixture();
  clip.options[0]!.actions[4]!.requirements = [{ kind: 'level', minimum: 20, provenance: 'synthetic constraint' }];
  const result = await previewResize(clip, { start: 1, endExclusive: 11 }, 'scale_timing');
  assert.equal(result.ok, false);
  if (!result.ok) { assert.equal(result.reason, 'This action requires Level 20.'); assert.deepEqual(result.clip, clip); }
  clip.options[0]!.actions[4]!.requirements = [];
  clip.options[0]!.actions[0]!.trigger = { kind: 'areaLevel', level: 12 };
  clip.options[0]!.actions[1]!.trigger = { kind: 'atlasAllocated', points: 20, stepId: parseId('step', 'synthetic') };
  const semantic = await previewResize(clip, { start: 1, endExclusive: 11 }, 'scale_timing');
  assert.equal(semantic.ok, true);
  assert.deepEqual(semantic.clip.options[0]!.actions.slice(0, 2).map(action => action.trigger), clip.options[0]!.actions.slice(0, 2).map(action => action.trigger));
  clip.options[0]!.actions[4]!.requirements = [{ kind: 'quest', questId: 'synthetic', evidenceRequired: 'source' }];
  assert.equal((await previewResize(clip, { start: 1, endExclusive: 11 }, 'scale_timing')).ok, false);
});
test('snap uses eight-pixel capture, nearest target, authored boundary tie, Alt bypass and no guessed landmarks', () => {
  const settings = { enabled: true, alt: false, boundaries: [9], landmarks: [] };
  assert.equal(snapBoundary(9.5, 12, settings), 9);
  assert.equal(snapBoundary(9.6, 12, settings), 10);
  assert.equal(snapBoundary(9.6, 12, { ...settings, alt: true }), 10);
  assert.equal(snapBoundary(1.5, 20, { ...settings, boundaries: [2] }), 2);
  assert.equal(snapBoundary(68, 12, settings), 68);
});
test('stage-marker edits move only authored Level triggers and respect hard constraints without source writes', async () => {
  const { clip } = await fixture(), before = structuredClone(clip), action = clip.options[0]!.actions[0]!;
  const moved = await moveLevelMarker(clip, action.actionId, 7);
  assert.deepEqual(moved.options[0]!.actions[0]!.trigger, { kind: 'level', level: 7 }); assert.deepEqual(clip, before);
  moved.options[0]!.actions[0]!.requirements = [{ kind: 'level', minimum: 7, provenance: 'Synthetic' }];
  await assert.rejects(moveLevelMarker(moved, action.actionId, 6), /requires Level 7/);
  moved.options[0]!.actions[0]!.trigger = { kind: 'areaLevel', level: 7 };
  await assert.rejects(moveLevelMarker(moved, action.actionId, 8), /Only authored Level/);
});
test('Send defaults use recent compatible active-league timeline, four empty lanes and remembered Open', async () => {
  const { timeline, source } = await fixture();
  assert.equal(newTimeline(stamp()).lanes.length, 4);
  assert.equal(newTimeline(stamp()).editorMetadata.previewLevel, 1);
  const rows = [{ id: 'old', timeline, activeLeague: false, lastUsed: 30 }, { id: 'recent', timeline, activeLeague: true, lastUsed: 20 }, { id: 'other', timeline, activeLeague: true, lastUsed: 10 }];
  assert.equal(sendDefaults(rows, source).timelineId, 'recent');
  assert.equal(sendDefaults(rows, source, { recentId: 'other', openAfterAdding: false }).openAfterAdding, false);
  assert.equal(sendDefaults([], source).createNew, true);
});
test('three-way source update preserves mine per field, accepts independent creator edits, and leaves source immutable', async () => {
  const { clip, source } = await fixture(), before = structuredClone(source);
  const id = clip.options[0]!.actions[0]!.actionId;
  clip.instructionOverrides = [{ actionId: id, instruction: instruction('My first action.') }];
  const latest = structuredClone(clip.options[0]!);
  latest.actions[0]!.instruction = instruction('Creator first action.', 'Creator details');
  latest.source = await pinSource({ ...source.ref, revisionId: parseId('revision', '88888888-8888-4888-8888-888888888888') }, source.fallbackSnapshot, limits);
  const result = await previewSourceUpdate(clip, latest, limits);
  assert.equal(result.defaultChoice, 'keep_mine');
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.clip.instructionOverrides[0]!.instruction.firstAction, 'My first action.');
  assert.equal(result.clip.instructionOverrides[0]!.instruction.details, 'Creator details');
  const creator = resolveUpdateConflict(result.clip, result.conflicts[0]!, 'use_creator');
  assert.equal(creator.instructionOverrides[0]!.instruction.firstAction, 'Creator first action.');
  assert.equal(resolveUpdateConflict(creator, result.conflicts[0]!, 'keep_mine').instructionOverrides[0]!.instruction.firstAction, 'My first action.');
  assert.deepEqual(source, before);
});
test('lane reorder, remove and duplicate retain stable pins and valid memberships', async () => {
  const { timeline, clip } = await fixture();
  const reordered = reorderLane(timeline, clip.laneId, 3);
  assert.equal(reordered.lanes.at(-1)!.laneId, clip.laneId);
  assert.equal(timelineSchema.parse(removeClip(reordered, clip.clipId), limits).ok, true);
});
test('newer source uses the existing action namespace and preserves a local name and removed custom instruction', async () => {
  const { clip, source } = await fixture();
  clip.options[0]!.title = 'My clip name';
  const removed = clip.options[0]!.actions.at(-1)!;
  clip.instructionOverrides = [{ actionId: removed.actionId, instruction: instruction('My retained instruction.') }];
  const snapshot = structuredClone(source.fallbackSnapshot);
  assert.equal(snapshot.kind, 'build');
  if (snapshot.kind !== 'build') return;
  snapshot.payload.guide.pop(); snapshot.payload.guide[0]!.instruction.details = 'New creator details';
  const latestSource = await pinSource({ ...source.ref, revisionId: parseId('revision', '88888888-8888-4888-8888-888888888888') }, snapshot, limits);
  const latestClip = await sourceClip(latestSource, clip.laneId, limits, { clipId: clip.clipId, optionId: clip.selectedOptionId! });
  assert.equal(latestClip.options[0]!.actions[0]!.actionId, clip.options[0]!.actions[0]!.actionId);
  const preview = await previewSourceUpdate(clip, latestClip.options[0]!, limits);
  assert.equal(preview.clip.options[0]!.title, 'My clip name');
  assert.ok(preview.clip.options[0]!.actions.some(action => action.actionId === removed.actionId));
  assert.ok(preview.conflicts.some(conflict => conflict.theirs === 'Removed by creator'));
  assert.equal(preview.clip.instructionOverrides[0]!.instruction.firstAction, 'My retained instruction.');
});
test('a creator update that raises a hard requirement blocks locally scaled timing', async () => {
  const { clip } = await fixture();
  const scaled = await previewResize(clip, { start: 1, endExclusive: 11 }, 'scale_timing');
  assert.equal(scaled.ok, true);
  const latest = structuredClone(clip.options[0]!);
  latest.actions.at(-1)!.requirements = [{ kind: 'level', minimum: 20, provenance: 'Synthetic update' }];
  const preview = await previewSourceUpdate(scaled.clip, latest, limits);
  assert.deepEqual(preview.blockers, ['This action requires Level 20.']);
});
test('stale source-update Apply cannot overwrite a clip edited after preview', async () => {
  const { timeline, clip } = await fixture(), latest = structuredClone(clip.options[0]!);
  const preview = await previewSourceUpdate(clip, latest, limits);
  timeline.clips[0]!.range.endExclusive = 31;
  await assert.rejects(applySourceUpdate(timeline, preview), /This clip changed/);
  assert.equal(timeline.clips[0]!.range.endExclusive, 31);
});

test('creator timing conflict resolution refreshes the action hash and coverage before Apply', async () => {
  const { timeline, clip } = await fixture();
  clip.options[0]!.actions[1]!.trigger = { kind: 'level', level: 6 };
  const latest = structuredClone(clip.options[0]!);
  latest.actions[1]!.trigger = { kind: 'level', level: 30 };
  timeline.clips = [clip];
  const preview = await previewSourceUpdate(clip, latest, limits);
  const conflict = preview.conflicts.find(row => row.field === 'trigger')!;
  assert.ok(conflict);
  preview.clip = resolveUpdateConflict(preview.clip, conflict, 'use_creator');
  const applied = await applySourceUpdate(timeline, preview), action = applied.clips[0]!.options[0]!.actions[1]!;
  assert.equal(action.contentHash, await contentHash({ trigger: action.trigger, instruction: action.instruction,
    requirements: action.requirements, critical: action.critical, stamp: action.stamp }));
  assert.ok(applied.clips[0]!.excludedActionIds.includes(action.actionId));
});
test('the real document store persists one drag transaction, Undo/Redo and branch edits without source mutation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'p13-store-'));
  const documents = new DocumentStore(directory, { limits, schemas: { timeline: timelineSchema }, checkpointEvery: 2 });
  await documents.init();
  try {
    const service = new TimelineService(documents, { limits, activeStamp: stamp, registerObject: async () => {}, flushSource: async source => source,
      runContext: async () => ({}), startRun: async input => input });
    const created = await service.create();
    const id = created.revision.objectId, { source } = await fixture();
    const document = await service.read(id);
    const added = await service.send({ objectId: id, expectedRevisionId: created.revision.revisionId, source, laneId: document.payload.lanes[0]!.laneId, idempotencyKey: 'add' });
    assert.equal(added.status, 'applied');
    const afterAdd = await service.read(id), original = structuredClone(afterAdd.payload);
    const resize = await previewResize(afterAdd.payload.clips[0]!, { start: 1, endExclusive: 31 }, 'keep_instruction_timing');
    const saved = await service.save({ objectId: id, expectedRevisionId: afterAdd.revision.revisionId, payload: { ...afterAdd.payload, clips: [resize.clip] }, stamp: afterAdd.payload.stamp, idempotencyKey: 'drag' }, 'Resize clip');
    assert.equal(documents.history(id).events.length, 3);
    const undone = await service.undo(id, saved.revision.revisionId);
    assert.deepEqual((await service.read(id)).payload, original);
    const redone = await service.redo(id, undone.revision.revisionId);
    assert.equal((await service.read(id)).payload.clips[0]!.range.endExclusive, 31);
    await service.undo(id, redone.revision.revisionId);
    const branch = await service.read(id);
    await service.save({ objectId: id, expectedRevisionId: branch.revision.revisionId, payload: { ...branch.payload, title: 'Branch' }, stamp: branch.payload.stamp, idempotencyKey: 'branch' }, 'Rename timeline');
    assert.equal(new Set(documents.history(id).events.map(transaction => transaction.branchId)).size, 2);
    assert.deepEqual(source, (await fixture()).source);
    const exported = await service.exportFile(id);
    assert.ok(exported.includes('pathofmastery'));
    const imported = await service.importFile(exported, 'import');
    assert.deepEqual((await service.read(imported.revision.objectId)).payload.clips, (await service.read(id)).payload.clips);
  } finally { await documents.close(true); await rm(directory, { recursive: true, force: true }); }
});

async function atlasFixture() {
  const payload = plan();
  const [stepId] = Object.keys(payload.stepsById);
  payload.stepsById[stepId!]!.pointTarget = 20;
  const source = await pinSource(ref(), { kind: 'atlas', payload }, limits);
  const timeline = newTimeline(stamp());
  timeline.firstMapAnchor = { anchorId: 'first-map', evidence: { status: 'unknown', reason: 'Synthetic anchor.' } };
  const atlasLane = timeline.lanes.find(lane => lane.type === 'atlas')!;
  const clip = await sourceClip(source, atlasLane.laneId, limits, { anchorId: 'first-map' });
  return { timeline, clip, atlasLane };
}
test('Atlas point sub-range is half-open, excludes outside actions, clears at the full span and survives placement', async () => {
  const { timeline, clip } = await atlasFixture();
  const span = atlasSourceSpan(clip);
  assert.equal(span.from, 0);
  assert.ok(span.to >= 20);
  const narrowed = withAtlasPoints(clip, 5, 9);
  assert.deepEqual(narrowed.atlasPointRange, { start: 5, endExclusive: 10 });
  const outside = narrowed.options[0]!.actions.filter(action => action.trigger.kind === 'firstMap' ||
    action.trigger.kind === 'atlasAllocated' && (action.trigger.points < 5 || action.trigger.points > 9)).map(action => action.actionId);
  assert.ok(outside.length > 0);
  for (const id of outside) assert.ok(narrowed.excludedActionIds.includes(id));
  const placed = await placeClip(timeline, narrowed, limits);
  assert.equal(placed.status, 'applied');
  if (placed.status === 'applied') assert.deepEqual(placed.timeline.clips[0]!.atlasPointRange, { start: 5, endExclusive: 10 });
  const widened = withAtlasPoints(narrowed, span.from, span.to);
  assert.equal('atlasPointRange' in widened, false);
  assert.deepEqual(widened.excludedActionIds, []);
  assert.throws(() => withAtlasPoints(clip, 9, 5), /Atlas point range/);
  assert.throws(() => withAtlasPoints(clip, -1, 5), /Atlas point range/);
});
test('Atlas point sub-range is rejected on a non-Atlas lane and resize keeps it', async () => {
  const { timeline, clip } = await atlasFixture();
  const narrowed = withAtlasPoints(clip, 2, 8);
  const wrong = { ...narrowed, laneId: timeline.lanes.find(lane => lane.type === 'build')!.laneId };
  await assert.rejects(placeClip(timeline, wrong, limits));
  const resized = await previewResize(narrowed, { start: 10, endExclusive: 40 }, 'keep_instruction_timing');
  assert.ok(resized.ok);
  assert.deepEqual(resized.clip.atlasPointRange, { start: 2, endExclusive: 9 });
});

test('a Documents-store Build becomes a source that verifies; the store ref alone does not (Add to lane hash mismatch)', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ft-source-'));
  const documents = new DocumentStore(directory, { limits, schemas: { timeline: timelineSchema, build: buildSnapshotSchema }, checkpointEvery: 2 });
  await documents.init();
  try {
    const payload = build(), objectId = parseId('object', crypto.randomUUID());
    await documents.write('build', { objectId, expectedRevisionId: null, payload, stamp: payload.stamp, idempotencyKey: 'build' }, { label: 'Frozen from library' });
    const doc = await documents.read<typeof payload>(objectId);
    // The store's own ref hashes its stored file, so verifying a source made from it fails: this was the bug.
    await assert.rejects(() => verifySource({ ref: documents.revisionRef(objectId, doc.revision.revisionId), fallbackSnapshot: { kind: 'build', payload: doc.payload } }, limits), /hash does not match/);
    const source = await documentSource(documents, objectId, limits);
    assert.deepEqual(await verifySource(source, limits), source);
    assert.equal(source.ref.revisionId, doc.revision.revisionId);
    assert.equal(source.ref.objectId, objectId);
  } finally { await documents.close(true); await rm(directory, { recursive: true, force: true }); }
});
test('Delete moves a timeline to Recently deleted with its deletion time, and Restore brings the same document back', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ft-trash-'));
  const documents = new DocumentStore(directory, { limits, schemas: { timeline: timelineSchema }, checkpointEvery: 2 });
  await documents.init();
  try {
    const service = new TimelineService(documents, { limits, activeStamp: stamp, registerObject: async () => {}, flushSource: async source => source,
      runContext: async () => ({}), startRun: async input => input });
    const keep = await service.create('Keep Plan'), gone = await service.create('Trash Plan');
    await service.trash(gone.revision.objectId, gone.revision.revisionId);
    assert.deepEqual((await service.list()).map(row => row.payload.title), ['Keep Plan']);
    const all = await service.list(true), trashed = all.filter(row => row.trashedAt);
    assert.deepEqual(trashed.map(row => row.payload.title), ['Trash Plan']);
    assert.match(trashed[0]!.trashedAt!, /^\d{4}-\d\d-\d\dT/);
    assert.equal(all.find(row => row.payload.title === 'Keep Plan')!.trashedAt, null);
    await service.restoreTrash(gone.revision.objectId);
    assert.deepEqual((await service.list()).map(row => row.payload.title).sort(), ['Keep Plan', 'Trash Plan']);
    assert.equal((await service.read(gone.revision.objectId)).revision.revisionId, gone.revision.revisionId);
    assert.ok(keep);
  } finally { await documents.close(true); await rm(directory, { recursive: true, force: true }); }
});

// Applies a creator edit (new details on action 0) to `clip` inside `timeline` the way TimelinesHost offers it, and returns the applied clip.
async function applyCreatorEdit(timeline: Timeline, clip: Clip, source: FrozenSource) {
  const snapshot = structuredClone(source.fallbackSnapshot);
  if (snapshot.kind !== 'build') throw new Error('build fixture');
  snapshot.payload.guide[0]!.instruction.details = 'New creator details';
  const latestSource = await pinSource({ ...source.ref, revisionId: parseId('revision', '77777777-7777-4777-8777-777777777777') }, snapshot, limits);
  const latest = await sourceClip(latestSource, clip.laneId, limits, { clipId: clip.clipId, optionId: clip.selectedOptionId!, anchorId: 'first-map' });
  const preview = await previewSourceUpdate(clip, latest.options[0]!, limits);
  const applied = await applySourceUpdate(timeline, preview);
  return { preview, applied: applied.clips.find(row => row.clipId === clip.clipId)! };
}
async function editorTimeline(source: FrozenSource) {
  const timeline = newTimeline(stamp()), laneId = timeline.lanes[0]!.laneId;
  // Add to lane -> Add clip: the editor gets a fresh sourceClip and adopts it into the chosen lane.
  const added = adoptClip(await sourceClip(source, laneId, limits, { range: { start: 1, endExclusive: 21 }, anchorId: 'first-map' }), laneId);
  const placed = await placeClip(timeline, added, limits);
  assert.equal(placed.status, 'applied');
  return { timeline: placed.status === 'applied' ? placed.timeline : timeline, added };
}
test('a source update on a clip added through the editor matches every action and keeps a locally moved Level marker', async () => {
  const { source } = await fixture();
  const { timeline, added } = await editorTimeline(source);
  const marker = added.options[0]!.actions[3]!;
  assert.deepEqual(marker.trigger, { kind: 'level', level: 10 });
  const moved = await moveLevelMarker(added, marker.actionId, 12);
  timeline.clips = timeline.clips.map(row => row.clipId === moved.clipId ? moved : row);
  const { preview, applied } = await applyCreatorEdit(timeline, moved, source);
  assert.deepEqual(preview.changes.map(row => row.kind), ['changed'], 'only the edited action changes; no phantom added/removed rows');
  assert.deepEqual(preview.conflicts, []);
  assert.deepEqual(applied.options[0]!.actions.find(row => row.actionId === marker.actionId)!.trigger, { kind: 'level', level: 12 });
  assert.equal(applied.options[0]!.actions[0]!.instruction.details, 'New creator details');
  assert.notEqual(applied.options[0]!.source.ref.revisionId, added.options[0]!.source.ref.revisionId);
});
test('Duplicate, Paste and Choose source copies get the action ids a later source update expects, and keep moved markers', async () => {
  const { source } = await fixture();
  const { timeline, added } = await editorTimeline(source);
  for (const settings of [{}, { laneId: added.laneId }, { clipId: parseId('clip', crypto.randomUUID()) }]) {
    const copy = await copyClip(added, limits, settings);
    assert.notEqual(copy.clipId, added.clipId);
    const expected = await sourceClip(source, copy.laneId, limits, { clipId: copy.clipId, optionId: copy.selectedOptionId!, anchorId: 'first-map' });
    assert.deepEqual(copy.options[0]!.actions.map(a => a.actionId), expected.options[0]!.actions.map(a => a.actionId));
    const marker = copy.options[0]!.actions[3]!, moved = await moveLevelMarker(copy, marker.actionId, 14);
    const withCopy = { ...structuredClone(timeline), clips: [...timeline.clips, moved] };
    const { preview, applied } = await applyCreatorEdit(withCopy, moved, source);
    assert.deepEqual(preview.changes.map(row => row.kind), ['changed']);
    assert.deepEqual(applied.options[0]!.actions.find(row => row.actionId === marker.actionId)!.trigger, { kind: 'level', level: 14 });
  }
  // The old double-namespacing path really does break the match: this is the defect the copies avoid.
  const legacy = await cloneClip(added);
  const expected = await sourceClip(source, legacy.laneId, limits, { clipId: legacy.clipId, optionId: legacy.selectedOptionId! });
  assert.notDeepEqual(legacy.options[0]!.actions.map(a => a.actionId), expected.options[0]!.actions.map(a => a.actionId));
});

test('library league scope: unknown leagues stay in My timelines, a known league is current only while it is the active one', () => {
  const unknown = (reason: string) => ({ status: 'unknown' as const, reason });
  const known = (value: string, evidenceId = 'official-leagues') => ({ status: 'known' as const, value, evidenceId });
  // The fix-run fixtures and a fresh profile carry unknown leagues with different reason text: still current.
  assert.equal(inActiveLeague(unknown('Fixture scope is unknown.'), unknown('No verified league is selected.')), true);
  assert.equal(inActiveLeague(unknown('Fixture scope is unknown.'), known('Mercenaries')), true);
  assert.equal(inActiveLeague(known('Mercenaries', 'a'), known('Mercenaries', 'b')), true);
  assert.equal(inActiveLeague(known('Ancient League'), known('Mercenaries')), false);
  assert.equal(inActiveLeague(known('Ancient League'), unknown('No verified league is selected.')), false);
  assert.equal(inActiveLeague(known('Ancient League'), null), true, 'before the active stamp loads nothing is hidden');
});

test('a clip saved by the old Add clip path (ids namespaced twice) keeps its moved marker and its wording through a source update', async () => {
  const { source } = await fixture();
  const timeline = newTimeline(stamp()), laneId = timeline.lanes[0]!.laneId;
  const fresh = await sourceClip(source, laneId, limits, { range: { start: 1, endExclusive: 21 }, anchorId: 'first-map' });
  const legacy = await cloneClip(fresh, fresh.clipId, laneId); // what pom-app's Add clip saved before adoptClip
  const step = legacy.options[0]!.actions[3]!;
  let saved = await moveLevelMarker(legacy, step.actionId, 12);
  saved = { ...saved, instructionOverrides: [{ actionId: saved.options[0]!.actions[1]!.actionId, instruction: instruction('My own wording.') }] };
  const placed = await placeClip(timeline, saved, limits);
  assert.equal(placed.status, 'applied');
  if (placed.status !== 'applied') return;
  const { preview, applied } = await applyCreatorEdit(placed.timeline, saved, source);
  assert.deepEqual(preview.changes.map(row => row.kind), ['changed'], 'no phantom added/removed rows');
  assert.deepEqual(preview.conflicts, []);
  const actions = applied.options[0]!.actions;
  assert.equal(actions.length, 5);
  assert.deepEqual(actions[3]!.trigger, { kind: 'level', level: 12 }, 'the locally moved marker keeps Level 12');
  assert.equal(actions[0]!.instruction.details, 'New creator details');
  assert.equal(applied.instructionOverrides.find(row => row.actionId === actions[1]!.actionId)?.instruction.firstAction, 'My own wording.');
});
test('the right-hand piece of a Replace range split keeps its moved marker through a source update', async () => {
  const { timeline, clip, source } = await fixture();
  const incoming = await sourceClip(source, clip.laneId, limits, { range: { start: 8, endExclusive: 12 } });
  const split = await placeClip(timeline, incoming, limits, 'replace_range');
  assert.equal(split.status, 'applied');
  if (split.status !== 'applied') return;
  const right = split.timeline.clips.find(row => row.range.start === 12)!;
  const expected = await sourceClip(source, right.laneId, limits, { clipId: right.clipId, optionId: right.selectedOptionId! });
  assert.deepEqual(right.options[0]!.actions.map(a => a.actionId), expected.options[0]!.actions.map(a => a.actionId));
  const marker = right.options[0]!.actions[4]!, moved = await moveLevelMarker(right, marker.actionId, 18);
  const withMoved = { ...split.timeline, clips: split.timeline.clips.map(row => row.clipId === moved.clipId ? moved : row) };
  const { preview, applied } = await applyCreatorEdit(withMoved, moved, source);
  assert.deepEqual(preview.changes.map(row => row.kind), ['changed']);
  assert.deepEqual(applied.options[0]!.actions.find(row => row.actionId === marker.actionId)!.trigger, { kind: 'level', level: 18 });
});
test('a local action the update cannot match is a Keep mine conflict, never a silent reset', async () => {
  const { timeline, clip, source } = await fixture();
  const stray = { ...structuredClone(clip.options[0]!.actions[3]!), actionId: parseId('action', 'action:stray-local-step'), trigger: { kind: 'level' as const, level: 14 } };
  stray.instruction = instruction('A step only this clip knows.');
  const local = structuredClone(clip); local.options[0]!.actions.push(stray);
  timeline.clips = timeline.clips.map(row => row.clipId === local.clipId ? local : row);
  const snapshot = structuredClone(source.fallbackSnapshot);
  if (snapshot.kind !== 'build') throw new Error('build fixture');
  snapshot.payload.guide[0]!.instruction.details = 'New creator details';
  const latestSource = await pinSource({ ...source.ref, revisionId: parseId('revision', '66666666-6666-4666-8666-666666666666') }, snapshot, limits);
  const latest = await sourceClip(latestSource, local.laneId, limits, { clipId: local.clipId, optionId: local.selectedOptionId! });
  const preview = await previewSourceUpdate(local, latest.options[0]!, limits);
  const conflict = preview.conflicts.find(row => row.actionId === stray.actionId)!;
  assert.equal(conflict.theirs, UNMATCHED_IN_UPDATE);
  assert.ok(!preview.changes.some(row => row.actionId === stray.actionId), 'it is not reported as a creator removal');
  const kept = await applySourceUpdate(timeline, { ...preview, clip: resolveUpdateConflict(preview.clip, conflict, 'keep_mine') });
  assert.deepEqual(kept.clips.find(row => row.clipId === local.clipId)!.options[0]!.actions.find(row => row.actionId === stray.actionId)?.trigger, { kind: 'level', level: 14 });
  const dropped = await applySourceUpdate(timeline, { ...preview, clip: resolveUpdateConflict(preview.clip, conflict, 'use_creator') });
  assert.ok(!dropped.clips.find(row => row.clipId === local.clipId)!.options[0]!.actions.some(row => row.actionId === stray.actionId));
});

test('a creator removal of a step the author re-timed is a Keep mine conflict; unmodified removals stay plain removals', async () => {
  const { timeline, clip, source } = await fixture();
  const moved = await moveLevelMarker(clip, clip.options[0]!.actions[3]!.actionId, 13); // Level 10 -> 13 locally
  timeline.clips = timeline.clips.map(row => row.clipId === moved.clipId ? moved : row);
  const snapshot = structuredClone(source.fallbackSnapshot);
  if (snapshot.kind !== 'build') throw new Error('build fixture');
  snapshot.payload.guide = snapshot.payload.guide.filter((_, index) => index !== 3 && index !== 4); // creator removes the moved step and an untouched one
  const latestSource = await pinSource({ ...source.ref, revisionId: parseId('revision', '55555555-5555-4555-8555-555555555555') }, snapshot, limits);
  const latest = await sourceClip(latestSource, moved.laneId, limits, { clipId: moved.clipId, optionId: moved.selectedOptionId! });
  const preview = await previewSourceUpdate(moved, latest.options[0]!, limits);
  const movedId = moved.options[0]!.actions[3]!.actionId, untouchedId = moved.options[0]!.actions[4]!.actionId;
  assert.deepEqual(preview.changes.filter(row => row.kind === 'removed').map(row => row.actionId).sort(), [movedId, untouchedId].sort());
  const conflicts = preview.conflicts.filter(row => row.theirs === 'Removed by creator');
  assert.deepEqual(conflicts.map(row => row.actionId), [movedId], 'only the locally re-timed step is a conflict');
  assert.equal(preview.defaultChoice, 'keep_mine');
  const kept = await applySourceUpdate(timeline, { ...preview, clip: resolveUpdateConflict(preview.clip, conflicts[0]!, 'keep_mine') });
  const keptActions = kept.clips.find(row => row.clipId === moved.clipId)!.options[0]!.actions;
  assert.deepEqual(keptActions.find(row => row.actionId === movedId)?.trigger, { kind: 'level', level: 13 });
  assert.ok(!keptActions.some(row => row.actionId === untouchedId), 'the untouched removed step is removed');
  const dropped = await applySourceUpdate(timeline, { ...preview, clip: resolveUpdateConflict(preview.clip, conflicts[0]!, 'use_creator') });
  assert.ok(!dropped.clips.find(row => row.clipId === moved.clipId)!.options[0]!.actions.some(row => row.actionId === movedId), 'Use creator removes it');
});

// ---- State carried across a source update: one test per kind (coverage, user exclusions, mute, overrides, markers, choices, lanes).
async function creatorRevision(source: FrozenSource, revisionId: string, mutate: (guide: Extract<FrozenSource['fallbackSnapshot'], { kind: 'build' }>['payload']['guide']) => void) {
  const snapshot = structuredClone(source.fallbackSnapshot);
  if (snapshot.kind !== 'build') throw new Error('build fixture');
  mutate(snapshot.payload.guide);
  return pinSource({ ...source.ref, revisionId: parseId('revision', revisionId) }, snapshot, limits);
}
async function updateWith(timeline: Timeline, clip: Clip, latestSource: FrozenSource) {
  timeline.clips = timeline.clips.map(row => row.clipId === clip.clipId ? clip : row);
  const latest = await sourceClip(latestSource, clip.laneId, limits, { clipId: clip.clipId, optionId: clip.selectedOptionId! });
  const preview = await previewSourceUpdate(clip, latest.options[0]!, limits);
  return { preview, apply: async (resolved = preview.clip) => (await applySourceUpdate(timeline, { ...preview, clip: resolved })).clips.find(row => row.clipId === clip.clipId)! };
}
test('carried state / coverage: a step the creator moves into the range is included, one moved out is excluded', async () => {
  const { timeline, clip, source } = await fixture(); // range 1-20; guide levels 1, 5, 5, 10, 20
  const narrow = withCoverage(clip, { start: 1, endExclusive: 16 }); // 1-15: the Level 20 step is excluded by coverage
  const late = narrow.options[0]!.actions[4]!.actionId, early = narrow.options[0]!.actions[1]!.actionId;
  assert.ok(narrow.excludedActionIds.includes(late));
  const latestSource = await creatorRevision(source, '44444444-4444-4444-8444-444444444441', guide => { guide[4]!.trigger = { kind: 'level', level: 14 }; guide[1]!.trigger = { kind: 'level', level: 18 }; });
  const applied = await (await updateWith(timeline, narrow, latestSource)).apply();
  assert.ok(!applied.excludedActionIds.includes(late), 'moved to Level 14: inside 1-15, no longer excluded');
  assert.ok(applied.excludedActionIds.includes(early), 'moved to Level 18: outside 1-15, now excluded');
});
test('carried state / user exclusion: an exclusion the author made survives an update that does not touch the step', async () => {
  const { timeline, clip, source } = await fixture();
  const mine = clip.options[0]!.actions[2]!.actionId, user = { ...clip, excludedActionIds: [...clip.excludedActionIds, mine] };
  const latestSource = await creatorRevision(source, '44444444-4444-4444-8444-444444444442', guide => { guide[0]!.instruction.details = 'New creator details'; });
  const { preview, apply } = await updateWith(timeline, user, latestSource);
  assert.ok(!preview.conflicts.some(row => row.actionId === mine));
  assert.ok((await apply()).excludedActionIds.includes(mine));
});
test('carried state / user exclusion vs creator change: a conflict, Keep mine keeps it excluded, Use creator brings it back', async () => {
  const { timeline, clip, source } = await fixture();
  const mine = clip.options[0]!.actions[2]!.actionId, user = { ...clip, excludedActionIds: [...clip.excludedActionIds, mine] };
  const latestSource = await creatorRevision(source, '44444444-4444-4444-8444-444444444443', guide => { guide[2]!.instruction.details = 'Creator rewrote this step'; });
  const { preview, apply } = await updateWith(timeline, user, latestSource);
  const conflict = preview.conflicts.find(row => row.actionId === mine && row.field === 'excluded')!;
  assert.ok(conflict, 'the excluded step the creator changed is a conflict');
  assert.ok((await apply(resolveUpdateConflict(preview.clip, conflict, 'keep_mine'))).excludedActionIds.includes(mine));
  assert.ok(!(await apply(resolveUpdateConflict(preview.clip, conflict, 'use_creator'))).excludedActionIds.includes(mine));
});
test('carried state / disabled: the explicit Enabled in Run flag survives an update that adds a step, and Run schedules nothing', async () => {
  const { timeline, clip, source } = await fixture();
  const off: Clip = { ...clip, disabled: true };
  const latestSource = await creatorRevision(source, '44444444-4444-4444-8444-444444444444', guide => { guide.push({ ...structuredClone(guide[0]!), actionId: parseId('action', 'authored-new'), trigger: { kind: 'level', level: 7 } }); });
  const applied = await (await updateWith(timeline, off, latestSource)).apply();
  assert.equal(applied.options[0]!.actions.length, 6);
  assert.equal(applied.disabled, true);
  assert.ok(!applied.options[0]!.actions.some(action => applied.excludedActionIds.includes(action.actionId) && action.trigger.kind === 'level' && action.trigger.level < 20), 'the flag is not turned into per-step exclusions');
  const schedule = await compileSchedule({ timeline: { ...timeline, clips: [applied] }, options: { limits } });
  assert.equal(schedule.actions.length, 0, 'a disabled clip contributes nothing to Run');
});
test('Sol #129 case 1: a clip whose steps were all out of range gets the step the creator moves inside (never inferred as disabled)', async () => {
  const { timeline, clip, source } = await fixture(); // guide levels 1, 5, 5, 10, 20
  const narrow = withCoverage(clip, { start: 2, endExclusive: 5 }); // Levels 2-4: every step is out of range
  assert.ok(narrow.options[0]!.actions.every(action => narrow.excludedActionIds.includes(action.actionId)));
  const latestSource = await creatorRevision(source, '44444444-4444-4444-8444-444444444449', guide => { guide[1]!.trigger = { kind: 'level', level: 3 }; });
  const applied = await (await updateWith(timeline, narrow, latestSource)).apply();
  const moved = applied.options[0]!.actions[1]!.actionId;
  assert.ok(!applied.excludedActionIds.includes(moved));
  const schedule = await compileSchedule({ timeline: { ...timeline, clips: [applied] }, options: { limits } });
  assert.deepEqual(schedule.actions.map(action => action.actionId), [moved]);
});
test('Sol #129 case 2: Use creator on a timing conflict recomputes coverage after the choice', async () => {
  const { timeline, clip, source } = await fixture(); // range 1-20
  const narrow = withCoverage(clip, { start: 1, endExclusive: 16 });
  const step = narrow.options[0]!.actions[3]!.actionId; // Level 10
  const moved = await moveLevelMarker(narrow, step, 18); // the author moves it out of 1-15: excluded by coverage
  assert.ok(moved.excludedActionIds.includes(step));
  const latestSource = await creatorRevision(source, '44444444-4444-4444-8444-44444444444a', guide => { guide[3]!.trigger = { kind: 'level', level: 12 }; });
  const { preview, apply } = await updateWith(timeline, moved, latestSource);
  const conflict = preview.conflicts.find(row => row.actionId === step && row.field === 'trigger')!;
  assert.ok(conflict);
  const creator = await apply(resolveUpdateConflict(preview.clip, conflict, 'use_creator'));
  assert.deepEqual(creator.options[0]!.actions[3]!.trigger, { kind: 'level', level: 12 });
  assert.ok(!creator.excludedActionIds.includes(step), 'Level 12 is inside 1-15: in Run');
  const mine = await apply(resolveUpdateConflict(preview.clip, conflict, 'keep_mine'));
  assert.deepEqual(mine.options[0]!.actions[3]!.trigger, { kind: 'level', level: 18 });
  assert.ok(mine.excludedActionIds.includes(step), 'Level 18 stays outside 1-15');
});
test("carried state / overrides: the author's wording on a step the creator did not touch survives the update", async () => {
  const { timeline, clip, source } = await fixture();
  const id = clip.options[0]!.actions[2]!.actionId, own = { ...clip, instructionOverrides: [{ actionId: id, instruction: instruction('My wording.') }] };
  const latestSource = await creatorRevision(source, '44444444-4444-4444-8444-444444444445', guide => { guide[0]!.instruction.details = 'New creator details'; });
  const applied = await (await updateWith(timeline, own, latestSource)).apply();
  assert.equal(applied.instructionOverrides.find(row => row.actionId === id)?.instruction.firstAction, 'My wording.');
});
test('carried state / markers: a locally moved marker keeps its level when the creator edits other steps', async () => {
  const { timeline, clip, source } = await fixture();
  const id = clip.options[0]!.actions[3]!.actionId, moved = await moveLevelMarker(clip, id, 12);
  const latestSource = await creatorRevision(source, '44444444-4444-4444-8444-444444444446', guide => { guide[0]!.instruction.details = 'New creator details'; });
  const applied = await (await updateWith(timeline, moved, latestSource)).apply();
  assert.deepEqual(applied.options[0]!.actions.find(row => row.actionId === id)!.trigger, { kind: 'level', level: 12 });
});
test('carried state / choices: name, chosen alternative, other alternatives, range, timing, chunks and Atlas points are kept', async () => {
  const { timeline, clip, source } = await fixture();
  const other = await sourceClip(source, clip.laneId, limits, { range: clip.range });
  const chosen: Clip = { ...clip, options: [{ ...clip.options[0]!, title: 'My clip name' }, { ...other.options[0]!, title: 'Alternative' }], chunkOverride: { kind: 'levels', size: 6 }, timingMode: 'scale_timing' };
  const latestSource = await creatorRevision(source, '44444444-4444-4444-8444-444444444447', guide => { guide[0]!.instruction.details = 'New creator details'; });
  const applied = await (await updateWith(timeline, chosen, latestSource)).apply();
  assert.equal(applied.selectedOptionId, chosen.selectedOptionId);
  assert.equal(applied.options[0]!.title, 'My clip name');
  assert.deepEqual(applied.options[1], chosen.options[1], 'the other alternative is untouched');
  assert.deepEqual([applied.range, applied.chunkOverride, applied.timingMode, applied.atlasPointRange], [chosen.range, chosen.chunkOverride, chosen.timingMode, chosen.atlasPointRange]);
});
test('carried state / lanes: lane mute, order and membership are untouched by applying an update', async () => {
  const { timeline, clip, source } = await fixture();
  timeline.lanes = timeline.lanes.map((lane, index) => index === 0 ? { ...lane, muted: true } : lane);
  const latestSource = await creatorRevision(source, '44444444-4444-4444-8444-444444444448', guide => { guide[0]!.instruction.details = 'New creator details'; });
  const latest = await sourceClip(latestSource, clip.laneId, limits, { clipId: clip.clipId, optionId: clip.selectedOptionId! });
  const after = await applySourceUpdate(timeline, await previewSourceUpdate(clip, latest.options[0]!, limits));
  assert.deepEqual(after.lanes, timeline.lanes);
});

// ---- Clips switched off by older builds (every action excluded, no disabled field) read as disabled.
test('legacy off: a clip with every action excluded and no disabled field reads as disabled with only coverage exclusions; others are untouched', async () => {
  const { timeline, clip } = await fixture(); // range 1-20, guide levels 1, 5, 5, 10, 20
  const all = clip.options[0]!.actions.map(action => action.actionId), { disabled: _written, ...bare } = clip; // older builds wrote no field
  assert.equal(_written, false, 'this build always writes the flag');
  const legacy: Clip = { ...bare, excludedActionIds: all };
  const migrated = migrateLegacyDisabled({ ...timeline, clips: [legacy] }).clips[0]!;
  assert.equal(migrated.disabled, true);
  assert.deepEqual(migrated.excludedActionIds, excludedByCoverage(legacy), 'the "off" exclusions are cleared; only the range ones stay');
  // Not off: every step is outside the range (Sol #129 case 1), already carries the field, or only some steps are excluded.
  const outside = withCoverage(bare, { start: 2, endExclusive: 5 });
  assert.ok(outside.options[0]!.actions.every(action => outside.excludedActionIds.includes(action.actionId)));
  assert.deepEqual(migrateLegacyDisabled({ ...timeline, clips: [outside] }).clips[0], { ...outside, disabled: false });
  const some: Clip = { ...bare, excludedActionIds: all.slice(1) };
  assert.deepEqual(migrateLegacyDisabled({ ...timeline, clips: [some] }).clips[0], { ...some, disabled: false });
  // A clip written by this build carries the flag, so an author's exclusions are never read as "off", even when they cover every step.
  const current: Clip = { ...clip, excludedActionIds: all };
  assert.deepEqual(migrateLegacyDisabled({ ...timeline, clips: [current] }).clips[0], current);
});
test('legacy off: the service reads a saved legacy clip as disabled, the next save persists it, and an update keeps it out of Run', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ft-legacy-off-'));
  const documents = new DocumentStore(directory, { limits, schemas: { timeline: timelineSchema }, checkpointEvery: 2 });
  await documents.init();
  try {
    const service = new TimelineService(documents, { limits, activeStamp: stamp, registerObject: async () => {}, flushSource: async source => source,
      runContext: async () => ({}), startRun: async input => input });
    const { timeline, clip, source } = await fixture();
    const { disabled: _written, ...bare } = clip;
    const legacy: Timeline = { ...timeline, clips: [{ ...bare, excludedActionIds: clip.options[0]!.actions.map(action => action.actionId) }] };
    const objectId = parseId('object', '33333333-3333-4333-8333-333333333333');
    const written = await documents.write('timeline', { objectId, expectedRevisionId: null, payload: legacy, stamp: legacy.stamp, idempotencyKey: 'legacy-off' }, { label: 'Saved by an older build' });
    assert.equal((await documents.read<Timeline>(objectId)).payload.clips[0]!.disabled, undefined, 'stored in the old shape');
    const read = await service.read(objectId);
    assert.equal(read.payload.clips[0]!.disabled, true, 'the service reads it as switched off');
    await service.save({ objectId, expectedRevisionId: written.revision.revisionId, payload: { ...read.payload, title: 'Renamed' }, stamp: read.payload.stamp, idempotencyKey: 'next-save' }, 'Rename timeline');
    const stored = (await documents.read<Timeline>(objectId)).payload.clips[0]!;
    assert.equal(stored.disabled, true, 'the next save persists the flag');
    assert.deepEqual(stored.excludedActionIds, excludedByCoverage(stored));
    // The creator adds a step: the clip stays off and Run gets nothing from it.
    const off = (await service.read(objectId)).payload;
    const latestSource = await creatorRevision(source, '22222222-2222-4222-8222-222222222222', guide => { guide.push({ ...structuredClone(guide[0]!), actionId: parseId('action', 'authored-new'), trigger: { kind: 'level', level: 7 } }); });
    const latest = await sourceClip(latestSource, off.clips[0]!.laneId, limits, { clipId: off.clips[0]!.clipId, optionId: off.clips[0]!.selectedOptionId! });
    const applied = await applySourceUpdate(off, await previewSourceUpdate(off.clips[0]!, latest.options[0]!, limits));
    assert.equal(applied.clips[0]!.disabled, true);
    assert.equal((await compileSchedule({ timeline: applied, options: { limits } })).actions.length, 0);
  } finally { await documents.close(true); await rm(directory, { recursive: true, force: true }); }
});

test('Sol #237: a step kept with Keep mine after a removal and restored by a later revision is a conflict, Keep mine keeps the local level', async () => {
  const { timeline, clip, source } = await fixture(); // guide levels 1, 5, 5, 10, 20
  const step = clip.options[0]!.actions[3]!.actionId;
  const moved = await moveLevelMarker(clip, step, 13); // the author moves Level 10 -> 13
  timeline.clips = [moved];
  // Revision 2 removes the step: the author keeps it (Keep mine is the default).
  const removedSource = await creatorRevision(source, '11111111-1111-4111-8111-111111111112', guide => { guide.splice(3, 1); });
  const removedLatest = await sourceClip(removedSource, moved.laneId, limits, { clipId: moved.clipId, optionId: moved.selectedOptionId! });
  const removal = await previewSourceUpdate(moved, removedLatest.options[0]!, limits);
  assert.ok(removal.conflicts.some(row => row.actionId === step && row.theirs === 'Removed by creator'));
  const afterRemoval = await applySourceUpdate(timeline, removal);
  const kept = afterRemoval.clips[0]!;
  assert.deepEqual(kept.options[0]!.actions.find(row => row.actionId === step)!.trigger, { kind: 'level', level: 13 });
  assert.deepEqual(kept.keptActionIds, [step], 'the step is marked as kept locally');
  // Run plays the kept step at the author's level, also after the author switches to another alternative (the kept mark belongs
  // to the first one, which Run leaves out).
  const run = await preflightRun(afterRemoval, { limits });
  assert.ok(run.ready && run.schedule.actions.some(row => row.actionId === step), 'Run schedules the kept step');
  const otherOption = await sourceClip(removedSource, kept.laneId, limits, { clipId: kept.clipId });
  const switched = { ...afterRemoval, clips: [{ ...kept, options: [...kept.options, otherOption.options[0]!], selectedOptionId: otherOption.selectedOptionId }] };
  const runOther = await preflightRun(validated(timelineSchema, switched, limits), { limits });
  assert.ok(runOther.ready && !runOther.schedule.actions.some(row => row.actionId === step), 'Run on the other alternative works and leaves the kept step out');
  // A later save and reload keeps it as it is; revision 3 restores the step at Level 11.
  const reloaded = validated(timelineSchema, JSON.parse(JSON.stringify(afterRemoval)), limits);
  const restoredSource = await creatorRevision(source, '11111111-1111-4111-8111-111111111113', guide => { guide[3]!.trigger = { kind: 'level', level: 11 }; });
  const restoredLatest = await sourceClip(restoredSource, kept.laneId, limits, { clipId: kept.clipId, optionId: kept.selectedOptionId! });
  const restore = await previewSourceUpdate(reloaded.clips[0]!, restoredLatest.options[0]!, limits);
  const conflict = restore.conflicts.find(row => row.actionId === step && row.field === 'trigger')!;
  assert.ok(conflict, 'restoring a kept step whose level the author changed is a conflict');
  const mine = (await applySourceUpdate(reloaded, restore)).clips[0]!; // Keep mine is the default
  assert.deepEqual(mine.options[0]!.actions.find(row => row.actionId === step)!.trigger, { kind: 'level', level: 13 });
  assert.equal(mine.keptActionIds?.length ?? 0, 0, 'restored: no longer kept locally');
  const creator = (await applySourceUpdate(reloaded, { ...restore, clip: resolveUpdateConflict(restore.clip, conflict, 'use_creator') })).clips[0]!;
  assert.deepEqual(creator.options[0]!.actions.find(row => row.actionId === step)!.trigger, { kind: 'level', level: 11 });
  // Restored at the creator's old Level 10: still a conflict (the author's 13 differs from the restored value).
  const oldLevel = await creatorRevision(source, '11111111-1111-4111-8111-111111111115', () => {});
  const oldLatest = await sourceClip(oldLevel, kept.laneId, limits, { clipId: kept.clipId, optionId: kept.selectedOptionId! });
  assert.ok((await previewSourceUpdate(reloaded.clips[0]!, oldLatest.options[0]!, limits)).conflicts.some(row => row.actionId === step && row.field === 'trigger'));
  // Restored at the author's own Level 13 with the same wording: nothing differs, nothing to ask.
  const sameSource = await creatorRevision(source, '11111111-1111-4111-8111-111111111114', guide => { guide[3]!.trigger = { kind: 'level', level: 13 }; });
  const sameLatest = await sourceClip(sameSource, kept.laneId, limits, { clipId: kept.clipId, optionId: kept.selectedOptionId! });
  const quiet = await previewSourceUpdate(reloaded.clips[0]!, sameLatest.options[0]!, limits);
  assert.ok(!quiet.conflicts.some(row => row.actionId === step));
  assert.deepEqual((await applySourceUpdate(reloaded, quiet)).clips[0]!.options[0]!.actions.find(row => row.actionId === step)!.trigger, { kind: 'level', level: 13 });
  // A copy of the clip (Duplicate / Paste / Choose source) keeps the kept mark; the restoring revision is the same conflict for the
  // copy, never a second copy of the step next to the kept one.
  const copy = await copyClip(reloaded.clips[0]!, limits);
  const copiedStep = copy.keptActionIds![0]!;
  assert.deepEqual(copy.options[0]!.actions.find(row => row.actionId === copiedStep)!.trigger, { kind: 'level', level: 13 });
  const copyLatest = await sourceClip(restoredSource, copy.laneId, limits, { clipId: copy.clipId, optionId: copy.selectedOptionId! });
  const copyRestore = await previewSourceUpdate(copy, copyLatest.options[0]!, limits);
  assert.ok(copyRestore.conflicts.some(row => row.field === 'trigger' && row.mine === JSON.stringify({ kind: 'level', level: 13 })), 'the copy offers the timing conflict');
  assert.deepEqual(copyRestore.changes.filter(row => row.kind === 'added'), [], 'the restored step is not added a second time');
  const copyApplied = (await applySourceUpdate({ ...reloaded, clips: [copy] }, copyRestore)).clips[0]!;
  const levels = copyApplied.options[0]!.actions.map(row => row.trigger.kind === 'level' ? row.trigger.level : -1).sort((a, b) => a - b);
  assert.deepEqual(levels, [1, 5, 5, 13, 20], 'one step at the author\'s Level 13, no duplicate at the creator\'s Level 11');
  assert.equal(copyApplied.keptActionIds?.length ?? 0, 0);
});
