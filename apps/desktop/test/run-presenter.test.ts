import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseId, type Action, type ActionId, type BundleId, type FrozenSource, type Trigger } from '@pom/mastery-contracts';
import { build, publishedRef, ref, runId, stamp } from '@pom/mastery-contracts/fixtures';
import type { RunView } from '../src/shared/run/types.js';
import {
  FEEDBACK_MAX, SUPPORT_TEXT, buttonOf, clearDraft, completionModel, emptyFeedback, feedbackProblem, feedbackRequest, jumpToMyLevel, jumpTarget, keyCommand,
  loadDraft, pointerDown, resolveLayout, saveDraft, skippedIfJump, stripModel, surfaceOf, textSizes, type FeedbackForm,
} from '../src/renderer/run/presenter.js';

// A small synthetic Run view: build lane (levels 1, 5, 12) plus an atlas lane at 10 points, all co-due at the first bundle.
const buildSource = ref();
const atlasSource = { ...ref(), revisionId: parseId('revision', '66666666-6666-4666-8666-666666666666') };
const action = (id: string, trigger: Trigger, source: typeof buildSource, text: string, critical = false): Action => ({
  schemaVersion: 1, actionId: parseId('action', id), contentHash: source.payloadHash, sourceRevision: source, laneId: parseId('lane', 'l'), clipId: parseId('clip', 'c'),
  optionId: parseId('option', 'o'), trigger, requirements: [], critical, instruction: { firstAction: text, details: `${text} details`, whenReady: '' }, stamp: stamp(),
});
function view(over: Partial<RunView> = {}): RunView {
  const actions = [
    action('a1', { kind: 'level', level: 1 }, buildSource, 'Kill Hillock'), action('a2', { kind: 'atlasAllocated', stepId: parseId('step', 's1'), points: 10 }, atlasSource, 'Take the first Atlas step'),
    action('a3', { kind: 'level', level: 5 }, buildSource, 'Get Frost Bomb', true), action('a4', { kind: 'level', level: 12 }, buildSource, 'Link Frost Bomb'),
  ];
  const bundles = [
    { bundleId: parseId('bundle', 'b1') as BundleId, trigger: { kind: 'level', level: 1 } as Trigger, actionIds: [actions[0]!.actionId, actions[1]!.actionId], fingerprint: build().stamp.createdAt as never },
    { bundleId: parseId('bundle', 'b2') as BundleId, trigger: { kind: 'level', level: 5 } as Trigger, actionIds: [actions[2]!.actionId], fingerprint: 'x' as never },
    { bundleId: parseId('bundle', 'b3') as BundleId, trigger: { kind: 'level', level: 12 } as Trigger, actionIds: [actions[3]!.actionId], fingerprint: 'y' as never },
  ];
  const dep = (r: typeof buildSource, kind: 'build' | 'atlas') => ({ ref: r, dependsOn: [], snapshot: { kind, payload: { title: kind } } as unknown as FrozenSource['fallbackSnapshot'] });
  const unknown = { status: 'unknown' as const, reason: 'none' };
  return { snapshot: { schemaVersion: 1, runId: runId, stamp: stamp(), timelineRevision: ref(), publishedOrigin: publishedRef(), choices: [], omittedClipIds: [], actions,
      bundles, dependencies: [dep(buildSource, 'build'), dep(atlasSource, 'atlas')], schedulerVersion: '1', settings: { schemaVersion: 1, stamp: stamp(), characterChunks: { kind: 'auto' }, atlasSplitPoints: 10, countRuns: true, globalNextBackEnabled: false } },
    state: { schemaVersion: 1, runId: runId, stamp: stamp(), snapshotHash: 'h' as never, guideCursor: { bundleId: bundles[0]!.bundleId, level: 1 },
      observedProgress: { characterLevel: unknown, zoneId: unknown, areaLevel: unknown, firstMap: unknown, atlas: { allocatedCount: unknown, nodeIds: unknown, coverage: 'unknown', available: unknown, unspent: unknown, earned: unknown }, observedAt: null },
      mode: 'manual', presentedBundleIds: [bundles[0]!.bundleId], reviewed: [], skippedActionIds: [], outstandingActionIds: actions.map(a => a.actionId), commandCursor: 0, eventCursor: null, startedAt: 'now', endedAt: null },
    displayed: bundles[0]!, presentationVersion: 3, detailsOpen: false, catchUp: null, finish: null, receiptMethod: null, pendingCriticalActionIds: [actions[2]!.actionId], countRuns: true,
    title: 'Synthetic timeline', chunks: bundles.map((b, i) => ({ bundleId: b.bundleId as string, label: actions.find(a => a.actionId === b.actionIds[0])?.instruction.firstAction ?? `Chunk ${i + 1}` })), ...over };
}

test('chrome events never start an instruction gesture; the surface does, by button', () => {
  assert.equal(pointerDown(0, 10, 10, 'chrome'), null);
  assert.equal(pointerDown(2, 10, 10, 'chrome'), null);
  const next = pointerDown(0, 10, 10, 'instruction')!, back = pointerDown(2, 10, 10, 'instruction')!;
  assert.deepEqual([next.command.kind === 'pointerDown' && next.command.button, back.command.kind === 'pointerDown' && back.command.button], ['next', 'back']);
  assert.equal(pointerDown(1, 0, 0, 'instruction'), null);
  assert.deepEqual([buttonOf(3), buttonOf(4)], ['back', 'next']);
  assert.equal(surfaceOf({ closest: s => (s === '[data-run-chrome]' ? {} : null) }), 'chrome');
  assert.equal(surfaceOf({ closest: () => null }), 'instruction');
});

test('keys: repeats and text inputs do not advance; Next carries the displayed bundle and version', () => {
  const v = view();
  const next = keyCommand(v, { key: ' ', repeat: false }, false);
  assert.ok(next && typeof next === 'object' && next.kind === 'next' && next.bundleId === v.displayed.bundleId && next.presentationVersion === 3);
  assert.equal(keyCommand(v, { key: ' ', repeat: true }, false), null);
  assert.equal(keyCommand(v, { key: ' ', repeat: false }, true), null);
  assert.equal(keyCommand(v, { key: 'Escape', repeat: false }, true), 'escape');
  const back = keyCommand(v, { key: 'F10', repeat: false, shiftKey: true }, false);
  assert.ok(back && typeof back === 'object' && back.kind === 'back');
  assert.equal(keyCommand(v, { key: 'l', repeat: false }, false), 'position');
  assert.equal(keyCommand(v, { key: 'w', repeat: false, ctrlKey: true }, false), 'close');
});

test('strip: 26/20 text sizes, orientation, lanes and the multi-lane acknowledgement line', () => {
  assert.deepEqual(textSizes({ textSize: 26 }), { main: 26, support: 20 });
  assert.equal(textSizes({ textSize: 32 }).support, SUPPORT_TEXT);
  assert.ok(SUPPORT_TEXT >= 20);
  assert.equal(resolveLayout('auto', 360, 600), 'vertical');
  assert.equal(resolveLayout('auto', 960, 144), 'horizontal');
  assert.equal(resolveLayout('horizontal', 360, 600), 'horizontal');
  const m = stripModel(view(), { title: 'Synthetic' });
  assert.equal(m.title, 'Synthetic');
  assert.equal(stripModel(view()).title, 'Synthetic timeline', 'without Run meta the title comes from the Run itself');
  assert.equal(m.stepOf, 'Chunk 1/3');
  assert.deepEqual(view().chunks.map(c => c.label), ['Kill Hillock', 'Get Frost Bomb', 'Link Frost Bomb']);
  assert.deepEqual(m.lanes.map(l => l.label), ['Build', 'Atlas']);
  assert.equal(m.acknowledges, 'Next acknowledges: Build + Atlas at Level 1');
  assert.equal(m.lanes[0]!.range, 'Levels 1-4');
  assert.equal(m.game, 'Game Unknown');
  assert.equal(m.guide, 'Guide 1');
  assert.equal(m.atlas, 'Allocated Atlas Unknown');
  assert.equal(m.pending, 1);
  assert.equal(m.mode, 'Manual position');
  assert.equal(m.lanes[0]!.firstAction, 'Kill Hillock');
});

test('long first actions stay whole (no truncation in the model); overflow count is separate', () => {
  const v = view();
  const long = 'Do this very long thing '.repeat(40);
  v.snapshot.actions[0]!.instruction.firstAction = long;
  assert.equal(stripModel(v).lanes[0]!.firstAction, long);
});

test('game level and guide position are shown separately; look-ahead keeps the observed level', () => {
  const v = view();
  v.state.observedProgress.characterLevel = { status: 'known', value: 4, evidenceId: 'e' };
  v.state.guideCursor.level = 12;
  const m = stripModel(v);
  assert.equal(m.game, 'Game Level 4'); assert.equal(m.guide, 'Guide 12');
});

test('position: quick grid jumps to the last bundle at or below the level and counts skips, never completions', () => {
  const v = view();
  assert.equal(jumpTarget(v, 7)!.bundleId, v.snapshot.bundles[1]!.bundleId);
  assert.equal(jumpTarget(v, 99)!.bundleId, v.snapshot.bundles[2]!.bundleId);
  assert.equal(skippedIfJump(v, 1), 0);
  assert.equal(skippedIfJump(v, 7), 2);
  v.state.reviewed = [{ actionId: v.snapshot.actions[0]!.actionId, contentHash: v.snapshot.actions[0]!.contentHash }];
  assert.equal(skippedIfJump(v, 7), 1);
  const none = jumpToMyLevel(v);
  assert.equal(none.ok, false);
  v.state.observedProgress.characterLevel = { status: 'known', value: 6, evidenceId: 'e' };
  const ok = jumpToMyLevel(v);
  assert.ok(ok.ok && ok.command.kind === 'jump' && ok.command.bundleId === v.snapshot.bundles[1]!.bundleId);
});

test('completion: no automatic finish; manual finish needs the explicit click; receipts come only from the service', () => {
  const v = view();
  v.state.endedAt = '2026-10-15T00:00:00.000Z';
  v.state.reviewed = v.snapshot.actions.slice(0, 3).map(a => ({ actionId: a.actionId, contentHash: a.contentHash }));
  v.state.outstandingActionIds = [v.snapshot.actions[3]!.actionId];
  let m = completionModel(v);
  assert.equal(m.title, 'Run ended');
  assert.equal(m.summary, 'Reviewed 3 actions. Skipped 0. Outstanding 1.');
  assert.equal(m.canConfirm, true); assert.equal(m.recorded, null);
  v.state.reviewed = v.snapshot.actions.map(a => ({ actionId: a.actionId, contentHash: a.contentHash }));
  v.state.outstandingActionIds = [];
  m = completionModel(v);
  assert.equal(m.title, 'Run complete');
  assert.equal(m.canConfirm, true); assert.equal(m.recorded, null, 'all reviewed is not a finish');
  v.receiptMethod = 'final_trigger_observed';
  m = completionModel(v);
  assert.equal(m.canConfirm, false); assert.match(m.recorded!, /game log/);
  v.receiptMethod = null; v.countRuns = false;
  assert.equal(completionModel(v).counting, 'Counting off');
  const open = view(); assert.equal(completionModel(open).canConfirm, false, 'a running Run cannot be confirmed finished');
});

test('feedback: reason required, Other needs text, 2000 cap, request holds only pinned IDs and text', () => {
  const v = view();
  const base = emptyFeedback(v.snapshot.actions[0]!.actionId);
  assert.equal(feedbackProblem(base), 'Pick what happened.');
  assert.equal(feedbackProblem({ ...base, reason: 'other' }), 'Describe what happened.');
  assert.equal(feedbackProblem({ ...base, reason: 'timing' }), null);
  assert.ok(feedbackProblem({ ...base, reason: 'timing', details: 'x'.repeat(FEEDBACK_MAX + 1) }));
  assert.equal(feedbackProblem({ ...base, reason: 'timing', actionId: null }), 'Pick the step that did not work.');
  const req = feedbackRequest(v, { ...base, reason: 'unclear', details: '  Gem was missing  ' }, 'key-1')!;
  assert.deepEqual(Object.keys(req).sort(), ['actionId', 'clipId', 'idempotencyKey', 'publishedRevision', 'reason', 'text']);
  assert.equal(req.text, 'Gem was missing');
  assert.equal(feedbackRequest(view({ snapshot: { ...v.snapshot, publishedOrigin: null } }), { ...base, reason: 'unclear' }, 'k'), null, 'own timelines have no creator to send to');
});

test('feedback draft stays in local storage only, survives close, and clears on send', () => {
  const mem = new Map<string, string>();
  const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
  const id = parseId('action', 'a1') as ActionId;
  const draft: FeedbackForm = { reason: 'timing', details: 'Too early', allowReplies: false, actionId: id };
  saveDraft(storage, draft);
  assert.deepEqual(loadDraft(storage, null), draft);
  clearDraft(storage);
  assert.deepEqual(loadDraft(storage, id), emptyFeedback(id));
  saveDraft(null, draft); loadDraft(null, id); // storage can be missing or throw
  assert.doesNotThrow(() => saveDraft({ setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } }, draft));
});
