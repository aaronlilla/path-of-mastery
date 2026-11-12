import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const output = resolve(here, '../../../../dist-test/p14');
const load = path => import(pathToFileURL(resolve(output, path)).href);
const { parseId } = await load('packages/mastery-contracts/src/index.js');
const { build, ref, stamp, plan, limits } = await load('packages/mastery-contracts/test/fixtures/v1.js');
const { instruction, makeAction, pinSource } = await load('apps/desktop/src/shared/timelines/adapters/common.js');
const { adaptAtlas } = await load('apps/desktop/src/shared/timelines/adapters/atlas.js');
const { compileSchedule, chunkOverlay, previewGroups, emptyLedger, observeSchedule, dueBundles, acknowledgeBundle,
  criticalOverflow, finalTriggerPredicate } = await load('apps/desktop/src/shared/timelines/scheduler/index.js');

async function fixture(name, kind, triggers, payload) {
  const context = { laneId: parseId('lane', name), clipId: parseId('clip', `${name}-clip`), optionId: parseId('option', `${name}-option`), limits };
  const source = await pinSource(ref(), { kind, payload }, limits);
  const actions = kind === 'atlas' ? await adaptAtlas(source, context, 'synthetic-maps')
    : await Promise.all(triggers.map((trigger, index) => makeAction(source, context, `${name}:${index}`, trigger,
      instruction(`Read ${name} ${index}.`), [], true)));
  return { lane: { laneId: context.laneId, type: kind, title: name, order: 0, muted: false, clipIds: [context.clipId] },
    clip: { clipId: context.clipId, laneId: context.laneId, range: { start: 1, endExclusive: 101 },
      options: [{ optionId: context.optionId, title: name, source, actions }], selectedOptionId: context.optionId,
      instructionOverrides: [], timingMode: 'keep_instruction_timing', chunkOverride: { kind: 'auto' }, excludedActionIds: [] } };
}

const atlas = plan();
const first = atlas.stepsById['fixture-step'];
first.pointTarget = 25; first.pointBudget = 25;
atlas.stepsById['next-step'] = { ...structuredClone(first), stepId: parseId('step', 'next-step'), pointTarget: 38, pointBudget: 38 };
atlas.sequencePositions.push({ kind: 'step', positionId: 'next-step', stepId: parseId('step', 'next-step') });
const lanes = await Promise.all([
  fixture('build', 'build', [{ kind: 'level', level: 68 }, { kind: 'level', level: 80 }], build()),
  fixture('filter', 'filter', [{ kind: 'areaLevel', level: 70, areaId: 'synthetic-area' }], {
    schemaVersion: 1, title: 'Synthetic filter', stamp: stamp(), stages: [], capabilities: { exportFile: true, installFile: false, automaticSelection: false } }),
  fixture('note', 'notes', [{ kind: 'level', level: 68 }], { schemaVersion: 1, title: 'Synthetic note', stamp: stamp(), instructions: [instruction('Read the note.')] }),
  fixture('atlas', 'atlas', [], atlas),
]);
const timeline = { schemaVersion: 1, title: 'Offline scheduler scenario', stamp: stamp(),
  lanes: lanes.map(({ lane }, order) => ({ ...lane, order })), clips: lanes.map(({ clip }) => clip),
  firstMapAnchor: { anchorId: 'synthetic-maps', evidence: { status: 'unknown', reason: 'Synthetic fixture, not game evidence.' } },
  editorMetadata: { previewLevel: 100, snap: true, showChunks: true }, credits: [] };
const original = structuredClone(timeline);
const schedule = await compileSchedule({ timeline, options: { limits } });
const overlay = chunkOverlay(schedule);
let ledger = emptyLedger();

const manualTarget = previewGroups(schedule, false)[0];
assert.equal(manualTarget.trigger.kind, 'level');
assert.equal((await acknowledgeBundle(manualTarget, schedule)).length, 2);
assert.equal(ledger.observations.length, 0);
console.log('PASS: manual preview acknowledges a bundle without setting game progress.');

const event = (sequence, trigger, transitionId = `transition-${sequence}`) => ({ sequence, trigger, transitionId,
  eventId: `event-${sequence}`, contextEpoch: 'synthetic-context', observedAt: `2026-10-11T00:00:0${sequence}Z`,
  method: 'log', reliable: true, continuous: true, selectedContext: true,
  ...(trigger.kind === 'firstMap' ? { sourceEvidenceId: 'synthetic-zone-evidence' } : {}) });
const events = [event(1, { kind: 'level', level: 68 }, 'co-due'), event(2, { kind: 'areaLevel', level: 70, areaId: 'synthetic-area' }, 'co-due')];
ledger = observeSchedule(schedule, ledger, events);
const coDue = (await dueBundles(schedule, ledger))[0];
assert.equal(coDue.actionIds.length, 3);
const reviewed = await acknowledgeBundle(coDue, schedule);
assert.equal((await dueBundles(schedule, ledger, reviewed)).length, 0);
assert.deepEqual(observeSchedule(schedule, ledger, events), ledger);
console.log('PASS: one Next reviews Build, Filter and Note; duplicate events leave the ledger unchanged.');

assert.equal(criticalOverflow(schedule, reviewed, []).length,
  schedule.actions.filter(action => action.critical && !reviewed.some(record => record.actionId === action.actionId)).length);
assert.equal(await finalTriggerPredicate(schedule.groups.at(-1), schedule, ledger), false);
ledger = observeSchedule(schedule, ledger, [event(3, { kind: 'firstMap', anchorId: 'synthetic-maps' }),
  event(4, { kind: 'atlasAllocated', stepId: parseId('step', 'next-step'), points: 25 })]);
const remaining = await dueBundles(schedule, ledger, reviewed);
assert.deepEqual(remaining.map(bundle => bundle.trigger.kind), ['firstMap', 'atlasAllocated']);
assert.equal(await finalTriggerPredicate(schedule.groups.at(-1), schedule, ledger), true);
assert.ok(criticalOverflow(schedule, reviewed, []).length > 0);
console.log('PASS: Atlas waits for maps, stays separate and qualifies its final trigger without clearing outstanding actions.');

const frozen = overlay.filter(chunk => chunk.coordinate === 'level' && chunk.window.start === 68);
const changed = await compileSchedule({ timeline, options: { limits, presentedChunks: frozen,
  pace: [1, 2, 3].map(fromLevel => ({ fromLevel, toLevel: fromLevel + 1, elapsedSeconds: 60, inactivitySeconds: [], reliable: true })) } });
for (const chunk of frozen) assert.deepEqual(chunkOverlay(changed).find(current => current.chunkId === chunk.chunkId), chunk);
for (const bundle of remaining) for (const chunkId of bundle.chunkIds) assert.ok(overlay.some(chunk => chunk.chunkId === chunkId));
assert.deepEqual(chunkOverlay(schedule), overlay);
assert.deepEqual(timeline, original);
console.log('PASS: editor and Run use identical chunk IDs; presented chunks survive a pace change; pinned sources stay unchanged.');
console.log('Manual service scenario: 4 passed, 0 failed. Sources are synthetic and unverified.');
