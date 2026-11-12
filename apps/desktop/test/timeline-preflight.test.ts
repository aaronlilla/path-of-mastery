import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseId, type Timeline } from '@pom/mastery-contracts';
import { build, limits, plan, ref, stamp } from '@pom/mastery-contracts/fixtures';
import { pinSource } from '../src/shared/timelines/adapters/common.js';
import { newTimeline, placeClip, preflightRun, sourceClip, startPosition } from '../src/shared/timelines/editor/index.js';
import { chunkOverlay, compileSchedule } from '../src/shared/timelines/scheduler/index.js';
import { registerTimelineIpc, TIMELINE_CHANNEL } from '../src/main/timelines/ipc.js';
import type { TimelineService } from '../src/main/timelines/service.js';
import { TimelineService as Service, type TimelineDocuments } from '../src/main/timelines/service.js';

async function readyTimeline(): Promise<Timeline> {
  const timeline = newTimeline(stamp()), payload = build();
  payload.guide = [{ actionId: parseId('action', 'fixture-guide'), contentHash: ref().payloadHash, trigger: { kind: 'level', level: 5 }, requirements: [], instruction: { firstAction: 'Read the synthetic guide.', details: '', whenReady: '' } }];
  const source = await pinSource(ref(), { kind: 'build', payload }, limits);
  const clip = await sourceClip(source, timeline.lanes[0]!.laneId, limits);
  const result = await placeClip(timeline, clip, limits);
  assert.equal(result.status, 'applied');
  return result.status === 'applied' ? result.timeline : timeline;
}
test('ready Run bypasses dialog without account, network, log setup or current league', async () => {
  const timeline = await readyTimeline(); timeline.editorMetadata.previewLevel = 99;
  const result = await preflightRun(timeline, { limits });
  assert.equal(result.ready, true);
  if (!result.ready) return;
  assert.notEqual(result.start.level, 99);
  assert.equal(result.start.mode, 'first_instruction');
  assert.equal(result.bundle.timeline.stamp.leagueId.status, 'unknown');
  assert.deepEqual(chunkOverlay(result.schedule), chunkOverlay(await compileSchedule({ timeline: result.bundle.timeline, options: { limits } })));
});
test('blockers distinguish unresolved alternatives, missing payload and genuinely incompatible required data', async () => {
  const timeline = await readyTimeline(), clip = timeline.clips[0]!;
  clip.selectedOptionId = null;
  const choice = await preflightRun(timeline, { limits });
  assert.equal(choice.ready, false); assert.equal(choice.blockers[0]!.kind, 'alternative');
  clip.selectedOptionId = clip.options[0]!.optionId;
  const data = await preflightRun(timeline, { limits, incompatible: [{ clipId: clip.clipId, reason: 'Required graph fixture-node is missing.' }] });
  assert.equal(data.blockers[0]!.message, 'Required graph fixture-node is missing.');
  clip.options[0]!.source.fallbackSnapshot = undefined as never;
  const missing = await preflightRun(timeline, { limits });
  assert.equal(missing.blockers[0]!.kind, 'source');
});
test('removed original remains usable through saved copy and immutable source pin', async () => {
  const timeline = await readyTimeline();
  timeline.credits = [{ source: timeline.clips[0]!.options[0]!.source.ref, origin: null, creatorName: 'Fixture creator', title: 'Fixture', status: 'original_removed' }];
  const result = await preflightRun(timeline, { limits });
  assert.equal(result.ready, true);
  if (result.ready) assert.equal(result.bundle.credits[0]!.status, 'original_removed');
});
test('explicit Run-only omission does not mutate editor and muted unresolved lanes do not block', async () => {
  const timeline = await readyTimeline(), source = await pinSource(ref(), { kind: 'notes', payload: { schemaVersion: 1, title: 'Note', stamp: stamp(), instructions: [{ firstAction: 'Read the note.', details: '', whenReady: '' }] } }, limits);
  const clip = await sourceClip(source, timeline.lanes[3]!.laneId, limits);
  const placement = await placeClip(timeline, clip, limits);
  assert.equal(placement.status, 'applied');
  if (placement.status !== 'applied') return;
  const input = placement.timeline;
  input.clips.find(row => row.clipId === clip.clipId)!.selectedOptionId = null;
  const before = structuredClone(input);
  const omitted = await preflightRun(input, { limits, omittedClipIds: [clip.clipId] });
  assert.equal(omitted.ready, true);
  if (omitted.ready) { assert.deepEqual(omitted.omittedClipIds, [clip.clipId]); assert.ok(!omitted.bundle.timeline.clips.some(row => row.clipId === clip.clipId)); }
  assert.deepEqual(input, before);
  input.lanes[3]!.muted = true;
  assert.equal((await preflightRun(input, { limits })).ready, true);
});
test('empty enabled instructions and competing Run are explicit blockers', async () => {
  const empty = await preflightRun(newTimeline(stamp()), { limits });
  assert.deepEqual(empty.blockers, [{ kind: 'empty', message: 'This timeline has no active instructions.' }]);
  const timeline = await readyTimeline(); timeline.lanes[0]!.muted = true;
  assert.equal((await preflightRun(timeline, { limits })).blockers[0]!.kind, 'empty');
  timeline.lanes[0]!.muted = false;
  assert.equal((await preflightRun(timeline, { limits, competingRun: true })).blockers[0]!.kind, 'competing');
});
test('Atlas requires semantic First map anchor, unknown baseline is allowed and points stay independent', async () => {
  const timeline = newTimeline(stamp()), source = await pinSource(ref(), { kind: 'atlas', payload: plan() }, limits);
  const clip = await sourceClip(source, timeline.lanes[1]!.laneId, limits, { anchorId: 'synthetic-map' });
  timeline.firstMapAnchor = { anchorId: 'synthetic-map', evidence: { status: 'unknown', reason: 'Manual At maps remains available.' } };
  const result = await placeClip(timeline, clip, limits); assert.equal(result.status, 'applied');
  if (result.status !== 'applied') return;
  const prepared = await preflightRun(result.timeline, { limits });
  assert.equal(prepared.ready, true);
  if (prepared.ready) {
    assert.equal(prepared.start.atlasPoints.status, 'unknown');
    assert.ok(prepared.schedule.chunks.every(chunk => chunk.coordinate === 'atlasAllocated'));
  }
  result.timeline.firstMapAnchor = null;
  assert.equal((await preflightRun(result.timeline, { limits })).blockers[0]!.kind, 'compatibility');
});
test('start chooses Resume, then selected reliable observations, then manual or first instruction, never playhead', async () => {
  const timeline = await readyTimeline(); timeline.editorMetadata.previewLevel = 70;
  const unknown = { status: 'unknown' as const, reason: 'Unverified baseline' };
  const observation = { reliable: true, selected: true, level: 25, atlasPoints: unknown };
  assert.equal(startPosition(timeline, { observation, manual: { level: 40, atlasPoints: unknown } }).level, 25);
  assert.equal(startPosition(timeline, { observation: { ...observation, selected: false }, manual: { level: 40, atlasPoints: unknown } }).level, 40);
  assert.equal(startPosition(timeline, { observation, resume: { level: 12, atlasPoints: unknown, mode: 'resume' } }).level, 12);
  assert.notEqual(startPosition(timeline, {}).level, 70);
});
test('frozen Run input detaches source and editor mutations', async () => {
  const timeline = await readyTimeline(), result = await preflightRun(timeline, { limits });
  assert.equal(result.ready, true);
  if (!result.ready) return;
  const before = structuredClone(result.bundle);
  timeline.title = 'Edited'; timeline.clips[0]!.options[0]!.actions[0]!.instruction.firstAction = 'Changed';
  assert.deepEqual(result.bundle, before);
});
test('main service starts ready Run once and rejects a Timeline changed during preflight', async () => {
  const timeline = await readyTimeline(), pin = ref();
  let current = pin.revisionId, startCalls = 0, mutate = false;
  const documents = { read: async () => ({ schemaVersion: 1, objectId: pin.objectId, kind: 'timeline', payload: timeline,
    revision: { schemaVersion: 1, revisionId: current, parentRevisionId: null, payloadHash: pin.payloadHash, stamp: timeline.stamp } }), revisionRef: () => ({ ...pin, revisionId: current }) } as unknown as TimelineDocuments;
  const service = new Service(documents, { limits, activeStamp: stamp, registerObject: async () => {}, flushSource: async source => source,
    runContext: async () => { if (mutate) current = parseId('revision', '88888888-8888-4888-8888-888888888888'); return { start: { observation: { reliable: true, selected: true, level: 25, atlasPoints: { status: 'unknown', reason: 'Unverified Atlas' } } } }; },
    startRun: async input => { startCalls++; return input.start.level; } });
  assert.equal(await service.run(pin.objectId, pin.revisionId), 25);
  assert.equal(startCalls, 1);
  mutate = true;
  await assert.rejects(service.run(pin.objectId, pin.revisionId), /Timeline changed\. Review the updated run\./);
  assert.equal(startCalls, 1);
});
test('main service returns actual blockers without creating a Run and never edits another object kind', async () => {
  const timeline = await readyTimeline(), pin = ref(); timeline.clips[0]!.selectedOptionId = null;
  let starts = 0, undos = 0, kind = 'timeline';
  const documents = { read: async () => ({ schemaVersion: 1, objectId: pin.objectId, kind, payload: timeline,
    revision: { schemaVersion: 1, revisionId: pin.revisionId, parentRevisionId: null, payloadHash: pin.payloadHash, stamp: timeline.stamp } }), revisionRef: () => pin,
    undo: async () => { undos++; } } as unknown as TimelineDocuments;
  const service = new Service(documents, { limits, activeStamp: stamp, registerObject: async () => {}, flushSource: async source => source,
    runContext: async () => ({}), startRun: async () => { starts++; } });
  const result = await service.run(pin.objectId, pin.revisionId) as { ready: boolean };
  assert.equal(result.ready, false); assert.equal(starts, 0);
  kind = 'build'; await assert.rejects(service.undo(pin.objectId, pin.revisionId), /own area/); assert.equal(undos, 0);
});
test('preflight identifies the exact hard requirement rather than starting malformed scaled guidance', async () => {
  const timeline = await readyTimeline();
  timeline.clips[0]!.options[0]!.actions[0]!.requirements = [{ kind: 'level', minimum: 20, provenance: 'Synthetic requirement' }];
  const result = await preflightRun(timeline, { limits });
  assert.equal(result.ready, false); assert.equal(result.blockers[0]!.message, 'This action requires Level 20.');
});

test('excluded instructions do not block the remaining usable Run guidance', async () => {
  const timeline = await readyTimeline(), clip = timeline.clips[0]!, invalid = structuredClone(clip.options[0]!.actions[0]!);
  invalid.actionId = parseId('action', 'excluded-hard-requirement');
  invalid.requirements = [{ kind: 'level', minimum: 20, provenance: 'Synthetic requirement' }];
  clip.options[0]!.actions.push(invalid); clip.excludedActionIds.push(invalid.actionId);
  const result = await preflightRun(timeline, { limits });
  assert.equal(result.ready, true);
  if (result.ready) assert.equal(result.schedule.actions.length, 1);
});
test('IPC rejects untrusted senders, unsupported fields, forged observations and unsafe positions', async () => {
  let handler!: (event: unknown, input: unknown) => Promise<unknown>, calls = 0;
  const dispose = registerTimelineIpc({ handle: (channel, fn) => { assert.equal(channel, TIMELINE_CHANNEL); handler = fn; }, removeHandler: () => {} },
    { list: async () => { calls++; return []; } } as unknown as TimelineService, event => event === 'trusted');
  for (const input of [{ schemaVersion: 1, method: 'list' }, { schemaVersion: 2, method: 'list' }, { schemaVersion: 1, method: 'list', includeTrash: 'yes' },
    { schemaVersion: 1, method: 'run', objectId: ref().objectId, expectedRevisionId: ref().revisionId, observation: { reliable: true } },
    { schemaVersion: 1, method: 'run', objectId: ref().objectId, expectedRevisionId: ref().revisionId, manualStart: { level: 101, atlasPoints: -1 } }]) {
    const result = await handler(input === undefined ? 'trusted' : input.method === 'list' && input.schemaVersion === 1 && Object.keys(input).length === 2 ? 'other' : 'trusted', input) as { ok: boolean };
    assert.equal(result.ok, false);
  }
  assert.equal(calls, 0);
  assert.equal((await handler('trusted', { schemaVersion: 1, method: 'list' }) as { ok: boolean }).ok, true);
  assert.equal(calls, 1); dispose();
});
