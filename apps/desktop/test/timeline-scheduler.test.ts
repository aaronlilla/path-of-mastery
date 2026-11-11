import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseId, runSnapshotSchema, type AtlasPlan, type Clip, type Lane, type LaneType,
  type SourceSnapshot, type Timeline, type Trigger } from '@pom/mastery-contracts';
import { build, limits, plan, ref, runSnapshot, stamp, step } from '@pom/mastery-contracts/fixtures';
import { instruction, makeAction, pinSource } from '../src/shared/timelines/adapters/common.js';
import { adaptAtlas } from '../src/shared/timelines/adapters/atlas.js';
import { acknowledgeBundle, atlasWindows, characterWindows, chunkOverlay, compileSchedule, criticalOverflow, dueBundles,
  emptyLedger, finalTriggerPredicate, medianActiveSecondsPerLevel, observeSchedule, previewGroups, unreviewedActions,
  type CompileOptions, type LevelInterval, type TriggerObservation } from '../src/shared/timelines/scheduler/index.js';

type LaneFixture = { lane: Lane; clip: Clip };
async function laneFixture(name: string, type: LaneType, triggers: Trigger[], range = { start: 1, endExclusive: 101 }, atlas?: AtlasPlan): Promise<LaneFixture> {
  const context = { laneId: parseId('lane', `lane-${name}`), clipId: parseId('clip', `clip-${name}`), optionId: parseId('option', `option-${name}`), limits };
  const sourceSnapshot: SourceSnapshot = type === 'build' ? { kind: 'build', payload: build() }
    : type === 'atlas' ? { kind: 'atlas', payload: atlas ?? plan() }
    : type === 'filter' ? { kind: 'filter', payload: { schemaVersion: 1, title: 'Synthetic filter', stamp: stamp(), stages: [],
      capabilities: { exportFile: true, installFile: false, automaticSelection: false } } }
    : { kind: type, payload: { schemaVersion: 1, title: 'Synthetic text', stamp: stamp(), instructions: triggers.map(() => instruction('Read the fixture.')) } };
  const source = await pinSource(ref(), sourceSnapshot, limits);
  const actions = await Promise.all(triggers.map((trigger, i) => makeAction(source, context, `${name}:${i}`, trigger,
    instruction(`Read ${name} action ${i}.`, 'Exact fixture details.'), [], true)));
  const clip: Clip = { clipId: context.clipId, laneId: context.laneId, range, options: [{ optionId: context.optionId, title: name, source, actions }],
    selectedOptionId: context.optionId, instructionOverrides: [], timingMode: 'keep_instruction_timing', chunkOverride: { kind: 'auto' }, excludedActionIds: [] };
  return { lane: { laneId: context.laneId, type, title: name, order: 0, muted: false, clipIds: [clip.clipId] }, clip };
}
function timeline(...fixtures: LaneFixture[]): Timeline {
  return { schemaVersion: 1, title: 'Synthetic scheduler trace', stamp: stamp(),
    lanes: fixtures.map((fixture, order) => ({ ...fixture.lane, order })), clips: fixtures.map(fixture => fixture.clip),
    firstMapAnchor: { anchorId: 'maps-fixture', evidence: { status: 'unknown', reason: 'Synthetic anchor is not game data.' } },
    editorMetadata: { previewLevel: 100, snap: true, showChunks: true }, credits: [] };
}
const compile = (input: Timeline, options: Partial<CompileOptions> = {}) => compileSchedule({ timeline: input, options: { limits, ...options } });
const level = (level: number): Trigger => ({ kind: 'level', level });
const area = (level: number, areaId?: string): Trigger => ({ kind: 'areaLevel', level, ...(areaId ? { areaId } : {}) });
const maps: Trigger = { kind: 'firstMap', anchorId: 'maps-fixture' };
const allocated = (points: number, stepId = 'step-b'): Trigger => ({ kind: 'atlasAllocated', points, stepId: parseId('step', stepId) });
function event(sequence: number, trigger: Trigger, overrides: Partial<TriggerObservation> = {}): TriggerObservation {
  return { eventId: `event-${sequence}`, sequence, transitionId: `transition-${sequence}`, contextEpoch: 'context-1',
    observedAt: `2026-10-11T00:00:${String(sequence).padStart(2, '0')}Z`, trigger, method: 'log', reliable: true, continuous: true,
    selectedContext: true, ...(trigger.kind === 'firstMap' ? { sourceEvidenceId: 'synthetic-zone-source' } : {}), ...overrides };
}
const pace = (...seconds: number[]): LevelInterval[] => seconds.map((elapsedSeconds, i) =>
  ({ fromLevel: i + 1, toLevel: i + 2, elapsedSeconds, inactivitySeconds: [], reliable: true }));
function atlasPlan(targets = [25, 38, 20]): AtlasPlan {
  const value = plan();
  value.stepsById = {};
  value.sequencePositions = targets.map((pointTarget, index) => {
    const stepId = parseId('step', `step-${String.fromCharCode(97 + index)}`);
    value.stepsById[stepId] = { ...step(), stepId, pointTarget, pointBudget: pointTarget };
    return { kind: 'step', positionId: stepId, stepId };
  });
  return value;
}

test('Auto uses capped early spans, exact 68-73/74-79, four late levels and a 96-100 tail', () => {
  assert.deepEqual(characterWindows(), [
    { start: 1, endExclusive: 11 }, { start: 11, endExclusive: 21 }, { start: 21, endExclusive: 31 },
    { start: 31, endExclusive: 41 }, { start: 41, endExclusive: 51 }, { start: 51, endExclusive: 61 }, { start: 61, endExclusive: 68 },
    { start: 68, endExclusive: 74 }, { start: 74, endExclusive: 80 }, { start: 80, endExclusive: 84 },
    { start: 84, endExclusive: 88 }, { start: 88, endExclusive: 92 }, { start: 92, endExclusive: 96 }, { start: 96, endExclusive: 101 },
  ]);
});

test('landmarks retain minimum four and maximum ten, with short boundary fragments merged', () => {
  const windows = characterWindows({ landmarks: [2, 4, 7, 8, 17, 19, 66, 67] });
  assert.deepEqual(windows[0], { start: 1, endExclusive: 7 });
  assert.ok(windows.every(window => window.endExclusive - window.start >= 4));
  assert.ok(windows.filter(window => window.start < 68).every(window => window.endExclusive - window.start <= 10));
  assert.equal(windows[windows.findIndex(window => window.start === 68) - 1]!.endExclusive, 68);
});

test('every early landmark location and override keeps complete, nonoverlapping minimum-four coverage', () => {
  for (let landmark = 1; landmark <= 101; landmark++) for (const size of [4, 6, 8, 10] as const) {
    const windows = characterWindows({ landmarks: [landmark], size });
    assert.equal(windows[0]!.start, 1);
    assert.equal(windows.at(-1)!.endExclusive, 101);
    windows.forEach((window, index) => {
      assert.ok(window.endExclusive - window.start >= 4, `${landmark}/${size}`);
      assert.ok(window.endExclusive - window.start <= (window.start < 68 ? 10 : window.start < 80 ? 6 : 5));
      if (index) assert.equal(windows[index - 1]!.endExclusive, window.start);
    });
  }
});

test('pace waits for three reliable intervals, subtracts inactivity over ten minutes and uses the median', () => {
  assert.equal(medianActiveSecondsPerLevel(pace(30, 30)), null);
  const intervals = pace(30, 1230, 40, 6000);
  intervals[1]!.inactivitySeconds = [1200];
  intervals[3]!.reliable = false;
  assert.equal(medianActiveSecondsPerLevel(intervals), 30);
  assert.equal(medianActiveSecondsPerLevel(pace(30, 40, 50, 60)), 45);
  assert.equal(medianActiveSecondsPerLevel(pace(30, 40, 600)), 40);
  const edge = pace(610, 610, 610); edge.forEach(interval => interval.inactivitySeconds = [600]);
  assert.equal(medianActiveSecondsPerLevel(edge), 610);
  assert.equal(medianActiveSecondsPerLevel([{ ...pace(10)[0]!, toLevel: 4 }, ...pace(20, 20)]), null);
  assert.equal(medianActiveSecondsPerLevel([{ ...pace(10)[0]!, inactivitySeconds: [1000] }, ...pace(20, 20)]), null);
});

test('240-second early target quantizes to 4/6/8/10 while middle and late Auto phases stay fixed', () => {
  for (const [seconds, size] of [[60, 4], [40, 6], [30, 8], [10, 10]]) {
    const windows = characterWindows({ pace: pace(seconds!, seconds!, seconds!) });
    assert.equal(windows[0]!.endExclusive - 1, size);
    assert.deepEqual(windows.find(window => window.start === 68), { start: 68, endExclusive: 74 });
    assert.deepEqual(windows.find(window => window.start === 80), { start: 80, endExclusive: 84 });
  }
  assert.equal(characterWindows({ pace: pace(30, 30) })[0]!.endExclusive, 11);
});

test('short clip coverage stays inside a containing window without filler or lost exact actions', async () => {
  const fixture = await laneFixture('short', 'build', [level(67), level(68)], { start: 67, endExclusive: 69 });
  const schedule = await compile(timeline(fixture));
  assert.deepEqual(schedule.chunks.map(chunk => chunk.coordinate === 'level' ? [chunk.window, chunk.coverage] : null), [
    [{ start: 61, endExclusive: 68 }, { start: 67, endExclusive: 68 }],
    [{ start: 68, endExclusive: 74 }, { start: 68, endExclusive: 69 }],
  ]);
  assert.deepEqual(schedule.actions.map(action => action.trigger), [level(67), level(68)]);
  assert.equal(schedule.groups.length, 2);
});

test('per-clip override and settings share chunk math and never rewrite authored triggers', async () => {
  const a = await laneFixture('build', 'build', [level(3), level(9)]);
  const b = await laneFixture('note', 'notes', [level(3)]);
  a.clip.chunkOverride = { kind: 'levels', size: 4 };
  const schedule = await compile(timeline(a, b), { characterChunks: { kind: 'fixed', size: 8 } });
  assert.deepEqual(schedule.chunks.filter(chunk => chunk.clipId === a.clip.clipId)[0], {
    chunkId: 'level:clip-build:1:5', laneId: a.lane.laneId, clipId: a.clip.clipId, coordinate: 'level',
    window: { start: 1, endExclusive: 5 }, coverage: { start: 1, endExclusive: 5 }, actionIds: [parseId('action', 'build:0')],
  });
  const noteChunk = schedule.chunks.find(chunk => chunk.clipId === b.clip.clipId)!;
  assert.ok(noteChunk.coordinate === 'level' && noteChunk.window.endExclusive === 9);
  assert.deepEqual(schedule.actions.map(action => action.trigger), [level(3), level(9), level(3)]);
});

test('presented chunks retain identity and boundaries across pacing/settings changes and serialized resume', async () => {
  const input = timeline(await laneFixture('build', 'build', [level(1), level(12), level(67), level(100)]));
  const before = await compile(input);
  const presented = JSON.parse(JSON.stringify([before.chunks[0], before.chunks[2]]));
  const after = await compile(input, { pace: pace(60, 60, 60), presentedChunks: presented });
  for (const frozen of presented) assert.deepEqual(after.chunks.find(chunk => chunk.chunkId === frozen.chunkId), frozen);
  assert.deepEqual(before.groups, after.groups.map(group => ({ ...group, chunkIds: before.groups.find(old => old.bundleId === group.bundleId)!.chunkIds })));
  assert.ok(after.chunks.some(chunk => chunk.coordinate === 'level' && chunk.window.start === 11 && chunk.window.endExclusive === 15));
});

test('equal Level triggers across lanes form one pinned bundle acknowledged by one Next', async () => {
  const schedule = await compile(timeline(await laneFixture('build', 'build', [level(10)]), await laneFixture('note', 'notes', [level(10)])));
  assert.equal(schedule.groups.length, 1);
  assert.equal(schedule.groups[0]!.actionIds.length, 2);
  const ledger = observeSchedule(schedule, emptyLedger(), [event(1, level(10))]);
  const due = await dueBundles(schedule, ledger);
  assert.equal(due.length, 1);
  assert.equal((await acknowledgeBundle(due[0]!, schedule)).length, 2);
  assert.deepEqual(await dueBundles(schedule, ledger, await acknowledgeBundle(due[0]!, schedule)), []);
});

test('matching numerals do not confirm AreaLevel; confirmed co-transition joins Build + Filter + Note', async () => {
  const schedule = await compile(timeline(await laneFixture('build', 'build', [level(70)]),
    await laneFixture('filter', 'filter', [area(70, 'fixture-area')]), await laneFixture('note', 'notes', [level(70)])));
  let ledger = observeSchedule(schedule, emptyLedger(), [event(1, level(70), { transitionId: 'co-due' })]);
  assert.deepEqual((await dueBundles(schedule, ledger))[0]!.actionIds, [parseId('action', 'build:0'), parseId('action', 'note:0')]);
  ledger = observeSchedule(schedule, ledger, [event(2, area(70, 'fixture-area'), { transitionId: 'co-due' })]);
  const due = await dueBundles(schedule, ledger);
  assert.equal(due.length, 1);
  assert.deepEqual(due[0]!.actionIds, [parseId('action', 'build:0'), parseId('action', 'filter:0'), parseId('action', 'note:0')]);
  assert.equal((await acknowledgeBundle(due[0]!, schedule)).length, 3);
  const different = observeSchedule(schedule, emptyLedger(), [event(1, level(70)), event(2, area(70, 'fixture-area'))]);
  assert.equal((await dueBundles(schedule, different)).length, 2);
});

test('due order follows first observed transition, then visible lane order, never incomparable numerals', async () => {
  const schedule = await compile(timeline(await laneFixture('build', 'build', [level(99)]),
    await laneFixture('filter', 'filter', [area(2)]), await laneFixture('note', 'notes', [{ kind: 'zone', zoneId: 'fixture-zone' }])));
  const ledger = observeSchedule(schedule, emptyLedger(), [event(1, area(2)), event(2, level(99)), event(3, { kind: 'zone', zoneId: 'fixture-zone' })]);
  assert.deepEqual((await dueBundles(schedule, ledger)).map(bundle => bundle.trigger.kind), ['areaLevel', 'level', 'zone']);
  const tie = observeSchedule(schedule, emptyLedger(), [event(1, area(2), { transitionId: 'same' }), event(2, level(99), { transitionId: 'same' })]);
  assert.deepEqual((await dueBundles(schedule, tie))[0]!.actionIds, [parseId('action', 'build:0'), parseId('action', 'filter:0')]);
});

test('Atlas splits each chosen step every ten allocated points including respec spans', () => {
  const id = parseId('step', 'step-a');
  assert.deepEqual(atlasWindows(id, 0, 25, limits.maxArrayLength), [
    { stepId: id, fromPoints: 0, toPoints: 10 }, { stepId: id, fromPoints: 10, toPoints: 20 }, { stepId: id, fromPoints: 20, toPoints: 25 },
  ]);
  assert.deepEqual(atlasWindows(id, 38, 20, limits.maxArrayLength).map(window => [window.fromPoints, window.toPoints]), [[38, 28], [28, 20]]);
  assert.deepEqual(atlasWindows(id, 5, 5, limits.maxArrayLength), [{ stepId: id, fromPoints: 5, toPoints: 5 }]);
  assert.throws(() => atlasWindows(id, -1, 10, limits.maxArrayLength));
});

test('Atlas adapter actions sit at exact point transitions, never duplicate into filler chunks', async () => {
  const fixture = await laneFixture('atlas', 'atlas', [], { start: 90, endExclusive: 101 }, atlasPlan());
  const option = fixture.clip.options[0]!;
  option.actions = await adaptAtlas(option.source, { laneId: fixture.lane.laneId, clipId: fixture.clip.clipId, optionId: option.optionId, limits }, 'maps-fixture');
  const schedule = await compile(timeline(fixture), { pace: pace(60, 60, 60) });
  assert.ok(schedule.chunks.every(chunk => chunk.coordinate === 'atlasAllocated'));
  assert.deepEqual(schedule.chunks.map(chunk => chunk.coordinate === 'atlasAllocated' ? [chunk.window.fromPoints, chunk.window.toPoints] : []),
    [[0, 10], [10, 20], [20, 25], [25, 35], [35, 38], [38, 28], [28, 20]]);
  assert.equal(schedule.chunks.flatMap(chunk => chunk.actionIds).length, schedule.actions.length);
  assert.deepEqual(schedule.actions, option.actions);
});

test('Atlas point sub-range limits chunks and actions to the half-open window without touching character levels', async () => {
  const fixture = await laneFixture('atlas', 'atlas', [maps, allocated(3, 'step-a'), allocated(10, 'step-a'), allocated(30), allocated(35)], undefined, atlasPlan());
  const whole = await compile(timeline(fixture));
  assert.equal(whole.actions.length, 5);
  fixture.clip.atlasPointRange = { start: 5, endExclusive: 31 };
  const schedule = await compile(timeline(fixture));
  assert.deepEqual(schedule.actions.map(action => action.trigger), [allocated(10, 'step-a'), allocated(30)]);
  assert.equal(schedule.excludedActionIds.length, 3);
  assert.deepEqual(schedule.chunks.map(chunk => chunk.coordinate === 'atlasAllocated' ? [chunk.window.fromPoints, chunk.window.toPoints] : []),
    [[5, 15], [15, 25], [25, 30], [30, 20]]);
  assert.deepEqual(schedule.chunks.map(chunk => chunk.actionIds.length), [1, 0, 1, 0]);
  assert.ok(schedule.chunks.every(chunk => chunk.coordinate === 'atlasAllocated'));
  fixture.clip.atlasPointRange = { start: 0, endExclusive: 4 };
  const head = await compile(timeline(fixture));
  assert.deepEqual(head.actions.map(action => action.trigger), [maps, allocated(3, 'step-a')]);
  assert.deepEqual(head.chunks.map(chunk => chunk.coordinate === 'atlasAllocated' ? [chunk.window.fromPoints, chunk.window.toPoints] : []), [[0, 3]]);
  fixture.clip.atlasPointRange = { start: 3, endExclusive: 3 };
  await assert.rejects(compile(timeline(fixture)));
});

test('Atlas activates only at sourced First map or explicit At maps; character/AreaLevel do not advance points', async () => {
  const schedule = await compile(timeline(await laneFixture('build', 'build', [level(25)]),
    await laneFixture('atlas', 'atlas', [maps, allocated(25)], undefined, atlasPlan())));
  let ledger = observeSchedule(schedule, emptyLedger(), [event(1, allocated(25)), event(2, level(25)), event(3, area(100))]);
  assert.deepEqual((await dueBundles(schedule, ledger)).map(bundle => bundle.trigger.kind), ['level']);
  ledger = observeSchedule(schedule, ledger, [event(4, maps, { method: 'manual', sourceEvidenceId: undefined })]);
  assert.equal((await dueBundles(schedule, ledger)).flatMap(bundle => bundle.actionIds).length, 3);
  const unsourced = observeSchedule(schedule, emptyLedger(), [event(1, maps, { sourceEvidenceId: undefined }), event(2, allocated(25))]);
  assert.equal((await dueBundles(schedule, unsourced)).length, 0);
});

test('Atlas remains queued separately from a co-transition level and respec never replays Reviewed', async () => {
  const schedule = await compile(timeline(await laneFixture('build', 'build', [level(25)]),
    await laneFixture('atlas', 'atlas', [allocated(25)], undefined, atlasPlan())));
  const initial = observeSchedule(schedule, emptyLedger(), [event(1, maps), event(2, level(25), { transitionId: 'same' }), event(3, allocated(25), { transitionId: 'same' })]);
  const due = await dueBundles(schedule, initial);
  assert.equal(due.length, 2);
  const reviewed = (await Promise.all(due.map(bundle => acknowledgeBundle(bundle, schedule)))).flat();
  const respec = observeSchedule(schedule, initial, [event(4, allocated(5)), event(5, allocated(25))]);
  assert.deepEqual(await dueBundles(schedule, respec, reviewed), []);
  assert.deepEqual(respec.confirmations, initial.confirmations);
});

test('quest requirements need their exact evidence, never zone arrival or automatic checklist completion', async () => {
  const fixture = await laneFixture('check', 'checklist', [level(10), { kind: 'manual', sequenceId: 'fixture-manual', ordinal: 1 }]);
  fixture.clip.options[0]!.actions[0]!.requirements = [{ kind: 'quest', questId: 'fixture-quest', evidenceRequired: 'quest-complete' },
    { kind: 'level', minimum: 10, provenance: 'Synthetic requirement' }];
  const schedule = await compile(timeline(fixture));
  let ledger = observeSchedule(schedule, emptyLedger(), [event(1, level(10)), event(2, { kind: 'zone', zoneId: 'fixture-quest' }),
    event(3, { kind: 'quest', questId: 'fixture-quest', evidenceRequired: 'arrival' })]);
  assert.deepEqual(await dueBundles(schedule, ledger), []);
  ledger = observeSchedule(schedule, ledger, [event(4, { kind: 'quest', questId: 'fixture-quest', evidenceRequired: 'quest-complete' })]);
  assert.equal((await dueBundles(schedule, ledger)).length, 1);
  assert.equal(unreviewedActions(schedule, []).length, 2);
});

test('critical overflow retains all exact pending actions through catch-up, regardless of visibility', async () => {
  const schedule = await compile(timeline(await laneFixture('build', 'build', Array.from({ length: 6 }, (_, i) => level(i + 10)))));
  const ledger = observeSchedule(schedule, emptyLedger(), [event(1, level(90))]);
  assert.equal((await dueBundles(schedule, ledger)).flatMap(bundle => bundle.actionIds).length, 6);
  assert.equal(criticalOverflow(schedule, [], schedule.actions.slice(0, 2).map(action => action.actionId)).length, 4);
  const reviewed = [{ actionId: schedule.actions[0]!.actionId, contentHash: schedule.actions[0]!.contentHash }];
  assert.equal(criticalOverflow(schedule, reviewed, []).length, 5);
  assert.deepEqual(criticalOverflow(schedule, reviewed, [])[0]!.trigger, level(11));
});

test('content changes keep the semantic ID but invalidate Reviewed and the bundle fingerprint', async () => {
  const fixture = await laneFixture('build', 'build', [level(10)]), input = timeline(fixture);
  const original = await compile(input);
  input.clips[0]!.instructionOverrides = [{ actionId: original.actions[0]!.actionId, instruction: instruction('Read the changed instruction.') }];
  const edited = await compile(input);
  assert.equal(edited.actions[0]!.actionId, original.actions[0]!.actionId);
  assert.notEqual(edited.actions[0]!.contentHash, original.actions[0]!.contentHash);
  assert.notEqual(edited.groups[0]!.bundleId, original.groups[0]!.bundleId);
  assert.equal(unreviewedActions(edited, await acknowledgeBundle(original.groups[0]!, original)).length, 1);
});

test('muted/omitted/excluded/out-of-coverage actions remain explicit without mutating any pinned source', async () => {
  const a = await laneFixture('build', 'build', [level(1), level(10), level(30)], { start: 5, endExclusive: 21 });
  a.clip.excludedActionIds = [a.clip.options[0]!.actions[1]!.actionId];
  const b = await laneFixture('note', 'notes', [level(1)]); b.lane.muted = true;
  const c = await laneFixture('check', 'checklist', [level(1)]);
  const input = timeline(a, b, c), before = structuredClone(input);
  const schedule = await compile(input, { omittedClipIds: [c.clip.clipId] });
  assert.equal(schedule.actions.length, 0);
  assert.equal(schedule.excludedActionIds.length, 3);
  assert.deepEqual(input, before);
});

test('unresolved choice, malformed payload/hash and changed presented chunks reject at scheduler ingress', async () => {
  const fixture = await laneFixture('build', 'build', [level(1)]);
  const input = structuredClone(timeline(fixture));
  input.clips[0]!.selectedOptionId = null;
  await assert.rejects(compile(input), /alternative/);
  input.clips[0]!.selectedOptionId = fixture.clip.selectedOptionId;
  input.clips[0]!.options[0]!.source.fallbackSnapshot.payload.title = 'Changed without repinning';
  await assert.rejects(compile(input), /hash/);
  const schedule = await compile(timeline(fixture));
  const changed = structuredClone(schedule.chunks[0]!); changed.actionIds = [];
  await assert.rejects(compile(timeline(fixture), { presentedChunks: [changed] }), /presented chunk/);
});

test('RunSnapshot projection consumes ScheduledBundle contracts without scheduler extension fields', async () => {
  const fixture = await laneFixture('build', 'build', [level(1), level(10)]);
  const schedule = await compile(timeline(fixture));
  const snapshot = { ...runSnapshot(), actions: schedule.actions,
    dependencies: [{ ref: fixture.clip.options[0]!.source.ref, snapshot: fixture.clip.options[0]!.source.fallbackSnapshot, dependsOn: [] }],
    choices: [{ clipId: schedule.actions[0]!.clipId, optionId: schedule.actions[0]!.optionId }],
    bundles: schedule.groups.map(({ bundleId, trigger, actionIds, fingerprint }) => ({ bundleId, trigger, actionIds, fingerprint })), schedulerVersion: schedule.schedulerVersion };
  const parsed = runSnapshotSchema.parse(snapshot, limits);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
});

test('repeated pace samples cannot satisfy the three reliable interval minimum', () => {
  const interval = pace(30)[0]!;
  assert.equal(medianActiveSecondsPerLevel([interval, structuredClone(interval), structuredClone(interval)]), null);
});

test('changed authored instructions with a stale supplied hash cannot inherit Reviewed', async () => {
  const fixture = await laneFixture('build', 'build', [level(10)]);
  const original = await compile(timeline(fixture));
  fixture.clip.options[0]!.actions[0]!.instruction.details = 'Changed authored details.';
  const changed = await compile(timeline(fixture));
  assert.notEqual(changed.actions[0]!.contentHash, original.actions[0]!.contentHash);
  assert.equal(unreviewedActions(changed, await acknowledgeBundle(original.groups[0]!, original)).length, 1);
});

test('final trigger requires every exact mixed predicate, not Level 100, Reviewed coverage, seed, gap or another context', async () => {
  const schedule = await compile(timeline(await laneFixture('build', 'build', [level(70)]), await laneFixture('filter', 'filter', [area(72, 'fixture-area')])));
  const good = observeSchedule(schedule, emptyLedger(), [event(1, level(70), { transitionId: 'final' }), event(2, area(72, 'fixture-area'), { transitionId: 'final' })]);
  const final = (await dueBundles(schedule, good))[0]!;
  assert.equal(await finalTriggerPredicate(final, schedule, good), true);
  const onlyLevel = observeSchedule(schedule, emptyLedger(), [event(1, level(70))]);
  assert.equal(await finalTriggerPredicate(final, schedule, onlyLevel), false);
  for (const observations of [
    [event(1, level(100))], [event(1, level(70), { method: 'seed' }), event(2, area(72, 'fixture-area'))],
    [event(1, level(70)), event(2, area(72, 'other-area'))],
    [event(1, level(70)), event(2, area(72, 'fixture-area'), { continuous: false })],
    [event(1, level(70)), event(2, area(72, 'fixture-area'), { contextEpoch: 'another-context' })],
    [event(1, level(70)), event(2, area(72, 'fixture-area'), { selectedContext: false })],
  ]) assert.equal(await finalTriggerPredicate(final, schedule, observeSchedule(schedule, emptyLedger(), observations)), false);
  assert.equal(await finalTriggerPredicate({ ...final, fingerprint: parseId('hash', 'b'.repeat(64)) }, schedule, good), false);
  assert.equal(await finalTriggerPredicate({ ...final, actionIds: [] }, schedule, good), false);
});

test('manual maps activation works for scheduling but cannot qualify final Atlas log evidence', async () => {
  const schedule = await compile(timeline(await laneFixture('atlas', 'atlas', [allocated(25)], undefined, atlasPlan())));
  const manual = observeSchedule(schedule, emptyLedger(), [event(1, maps, { method: 'manual' }), event(2, allocated(25))]);
  const final = (await dueBundles(schedule, manual))[0]!;
  assert.equal(await finalTriggerPredicate(final, schedule, manual), false);
  const log = observeSchedule(schedule, emptyLedger(), [event(1, maps), event(2, allocated(25))]);
  assert.equal(await finalTriggerPredicate(final, schedule, log), true);
  const wrongStep = observeSchedule(schedule, emptyLedger(), [event(1, maps), event(2, allocated(25, 'step-c'))]);
  assert.equal(await finalTriggerPredicate(final, schedule, wrongStep), false);
});

test('manual preview respects visible lane order and keeps Atlas out until maps, without changing observations', async () => {
  const schedule = await compile(timeline(await laneFixture('build', 'build', [level(10)]),
    await laneFixture('atlas', 'atlas', [maps], undefined, atlasPlan()), await laneFixture('note', 'notes', [level(1)])));
  assert.deepEqual(previewGroups(schedule, false).map(group => group.trigger.kind), ['level', 'level']);
  assert.deepEqual(previewGroups(schedule, true).map(group => group.trigger.kind), ['level', 'level', 'firstMap']);
  assert.deepEqual(emptyLedger(), { seenEventIds: [], observations: [], confirmations: [] });
});

test('deterministic serialized event trace agrees with the editor overlay and has one co-due acknowledgment', async () => {
  const input = timeline(await laneFixture('build', 'build', [level(1), level(68), level(80), level(96)]),
    await laneFixture('note', 'notes', [level(68)]), await laneFixture('filter', 'filter', [area(68)]),
    await laneFixture('atlas', 'atlas', [maps, allocated(25)], undefined, atlasPlan()));
  const before = structuredClone(input), schedule = await compile(input);
  const overlay = chunkOverlay(schedule);
  const trace = [event(1, level(1)), event(2, level(68), { transitionId: 'co' }), event(3, area(68), { transitionId: 'co' }),
    event(4, maps), event(5, allocated(25)), event(6, level(80)), event(7, level(96))];
  let ledger = emptyLedger();
  for (const observation of trace) ledger = observeSchedule(schedule, JSON.parse(JSON.stringify(ledger)), [observation]);
  assert.deepEqual(ledger, observeSchedule(schedule, emptyLedger(), trace));
  assert.deepEqual(observeSchedule(schedule, ledger, trace), ledger);
  const bundles = await dueBundles(schedule, ledger);
  assert.deepEqual(bundles.map(bundle => bundle.trigger.kind), ['level', 'level', 'firstMap', 'atlasAllocated', 'level', 'level']);
  assert.equal(bundles[1]!.actionIds.length, 3);
  for (const bundle of bundles) for (const chunkId of bundle.chunkIds) assert.ok(overlay.some(chunk => chunk.chunkId === chunkId));
  const reviewed = (await Promise.all(bundles.map(bundle => acknowledgeBundle(bundle, schedule)))).flat();
  assert.equal(reviewed.length, schedule.actions.length);
  assert.deepEqual(await dueBundles(schedule, ledger, reviewed), []);
  assert.deepEqual(chunkOverlay(schedule), overlay);
  assert.deepEqual(input, before);
  assert.throws(() => observeSchedule(schedule, ledger, [event(1, level(2), { eventId: 'out-of-order' })]), /ordered/);
});

test('stale displayed bundles cannot acknowledge changed actions', async () => {
  const fixture = await laneFixture('build', 'build', [level(10)]);
  const original = await compile(timeline(fixture));
  fixture.clip.options[0]!.actions[0]!.instruction.details = 'A changed instruction must be presented first.';
  const changed = await compile(timeline(fixture));
  await assert.rejects(async () => acknowledgeBundle(original.groups[0]!, changed), /displayed bundle/);
});

test('manual level look-ahead is not a game observation', async () => {
  const schedule = await compile(timeline(await laneFixture('build', 'build', [level(10)])));
  const ledger = observeSchedule(schedule, emptyLedger(), [event(1, level(10), { method: 'manual' })]);
  assert.deepEqual(await dueBundles(schedule, ledger), []);
});

test('unselected Atlas step IDs cannot produce unassigned instructions', async () => {
  const input = timeline(await laneFixture('atlas', 'atlas', [allocated(25, 'missing-step')], undefined, atlasPlan()));
  await assert.rejects(compile(input), /selected Atlas step/);
});

test('catch-up does not turn different authored level triggers into one co-due bundle', async () => {
  const schedule = await compile(timeline(await laneFixture('build', 'build', [level(10)]), await laneFixture('note', 'notes', [level(11)])));
  const ledger = observeSchedule(schedule, emptyLedger(), [event(1, level(90))]);
  assert.equal((await dueBundles(schedule, ledger)).length, 2);
});

test('invalid sizes and an Atlas span beyond the caller chunk limit fail before generating windows', () => {
  assert.throws(() => characterWindows({ size: 2 as 4 }), /size/);
  assert.throws(() => atlasWindows(parseId('step', 'step-a'), 0, 25, 2), /limit/);
  assert.throws(() => atlasWindows(parseId('step', 'step-a'), 0, Number.MAX_SAFE_INTEGER, limits.maxArrayLength), /limit/);
});

test('observing an earlier bundle cannot satisfy the pinned final predicate', async () => {
  const schedule = await compile(timeline(await laneFixture('build', 'build', [level(10), level(80)])));
  const ledger = observeSchedule(schedule, emptyLedger(), [event(1, level(10))]);
  assert.equal(await finalTriggerPredicate(schedule.groups[0]!, schedule, ledger), false);
});
