// Model-based property test for Timelines source updates.
// Each case is a SEQUENCE of 2-5 creator revisions (steps moved, added, removed, restored, reworded in any order). Before the
// first update and between updates the author edits locally (moves markers, rewords steps, excludes steps, switches the clip
// off and on); some updates are followed by a save and reload through the real schema and read-time migration. Every update
// goes through the real preview -> resolve (random conflict choices) -> apply path, and after each one the real Run schedule
// (compileSchedule) is checked against an independent model:
//   - a local value survives unless the author chose "Use creator changes" for that action;
//   - anything the creator changes where the author has a local value is a conflict (Keep mine default), including a step the
//     author kept after a removal that a later revision restores;
//   - Run = the clip's steps inside its range at their final level, minus the author's exclusions still in force, nothing else;
//     a disabled clip contributes nothing.
// Old shapes are generated too: ids namespaced twice by the old Add clip path, and clips switched off by excluding every step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseId, timelineSchema, type Clip, type FrozenSource, type Instructions, type Timeline } from '@pom/mastery-contracts';
import { build, limits, ref, stamp } from '@pom/mastery-contracts/fixtures';
import { canonicalJson, pinSource, validated } from '../src/shared/timelines/adapters/common.js';
import { applySourceUpdate, cloneClip, migrateLegacyDisabled, moveLevelMarker, newTimeline, placeClip, previewSourceUpdate, resolveUpdateConflict, sourceClip, withCoverage } from '../src/shared/timelines/editor/index.js';
import { compileSchedule } from '../src/shared/timelines/scheduler/index.js';

const CASES = Number(process.env.TIMELINE_PROPERTY_CASES ?? 1500);
const SEED = Number(process.env.TIMELINE_PROPERTY_SEED ?? 20261017);

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
type Step = { id: string; level: number; inst: Instructions };
type Choice = 'keep_mine' | 'use_creator';
const FIELDS = ['firstAction', 'details', 'whenReady'] as const;
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

async function pin(steps: Step[], revisionId: string): Promise<FrozenSource> {
  const payload = build();
  payload.guide = steps.map(step => ({ actionId: parseId('action', step.id), contentHash: ref().payloadHash, trigger: { kind: 'level' as const, level: step.level },
    requirements: [], instruction: structuredClone(step.inst) }));
  return pinSource({ ...ref(), revisionId: parseId('revision', revisionId) }, { kind: 'build', payload }, limits);
}
// The model's three-way merge of one value: base = the creator's last known value, mine = the author's, theirs = the creator's new one.
function merge<T>(base: T, mine: T, theirs: T, key: string, choices: Map<string, Choice>): T {
  if (same(mine, theirs) || same(theirs, base)) return mine;
  if (same(mine, base)) return theirs;
  const choice = choices.get(key);
  assert.ok(choice, `the update must offer a conflict for ${key}`);
  return choice === 'keep_mine' ? mine : theirs;
}
// The model of one step in the clip: the creator's last known values (base), the author's level and wording, the author's exclusion,
// and whether it is kept locally after the creator removed it.
type ModelStep = { base: { level: number; inst: Instructions }; level: number; override: Instructions | null; excluded: boolean; kept: boolean };
// A kept step that a later revision restores has no creator value to merge against: every field that differs is a conflict.
const NONE = { level: -1, inst: { firstAction: '\u0000', details: '\u0000', whenReady: '\u0000' } };

async function runCase(seed: number) {
  const r = mulberry32(seed), int = (n: number) => Math.floor(r() * n), pick = <T>(list: T[]) => list[int(list.length)]!;
  const uuid = () => 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => '0123456789abcdef'[int(16)]!);
  let creator: Step[] = Array.from({ length: 3 + int(5) }, (_, k) => ({ id: `step-${k}`, level: 1 + int(40), inst: { firstAction: `Step ${k}.`, details: `Details ${k}.`, whenReady: '' } }));
  const everSeen = new Map(creator.map(step => [step.id, structuredClone(step)]));
  let source = await pin(creator, uuid());
  const base = newTimeline(stamp()), laneId = base.lanes[0]!.laneId;
  const start = 1 + int(30), endExclusive = Math.min(101, start + 1 + int(30)), inRange = (level: number) => level >= start && level < endExclusive;
  let clip = await sourceClip(source, laneId, limits, { range: { start, endExclusive } });
  const clipId = clip.clipId, optionId = clip.selectedOptionId!;
  const idOf = new Map<string, string>(), stepOf = new Map<string, string>();
  const learnIds = async (src: FrozenSource, steps: Step[]) => {
    const made = await sourceClip(src, laneId, limits, { clipId, optionId });
    steps.forEach((step, k) => { idOf.set(step.id, made.options[0]!.actions[k]!.actionId); stepOf.set(made.options[0]!.actions[k]!.actionId, step.id); });
  };
  await learnIds(source, creator);
  const legacyIds = r() < 0.25;
  if (legacyIds) clip = await cloneClip(clip, clipId, laneId); // the old Add clip path
  // Until the first update re-keys them, the clip's actions are found by position (step k is action k).
  let positional = legacyIds;
  const actionIdOf = (clip: Clip, stepId: string) => positional ? clip.options[0]!.actions[creator.findIndex(step => step.id === stepId)]!.actionId : idOf.get(stepId)!;

  const model = new Map<string, ModelStep>(creator.map(step => [step.id, { base: { level: step.level, inst: structuredClone(step.inst) }, level: step.level, override: null, excluded: false, kept: false }]));
  let disabled = false;

  // Local edits by the author on the clip (model updated alongside).
  const localEdits = async (clip: Clip, count: number) => {
    for (let n = 0; n < count && model.size; n++) { // a revision may remove every step
      const stepId = pick([...model.keys()]), m = model.get(stepId)!, id = actionIdOf(clip, stepId), roll = r();
      if (roll < 0.45 && !m.excluded) { const level = 1 + int(40); clip = await moveLevelMarker(clip, parseId('action', id), level); m.level = level; }
      else if (roll < 0.8) {
        const inst = { firstAction: `Mine ${stepId} ${int(1000)}.`, details: r() < 0.5 ? (m.override ?? m.base.inst).details : `My details ${stepId}.`, whenReady: '' };
        clip = { ...clip, instructionOverrides: [...clip.instructionOverrides.filter(row => row.actionId !== id), { actionId: parseId('action', id), instruction: inst }] };
        m.override = inst;
      } else if (inRange(m.level)) {
        m.excluded = !m.excluded;
        clip = { ...clip, excludedActionIds: m.excluded ? [...clip.excludedActionIds, parseId('action', id)] : clip.excludedActionIds.filter(row => row !== id) };
      }
    }
    return clip;
  };
  clip = await localEdits(clip, int(5));
  const shape = r(), explicitOff = shape < 0.15, legacyShape = !explicitOff && shape < 0.3;
  if (explicitOff) { clip = { ...clip, disabled: true }; disabled = true; }
  clip = withCoverage(clip, clip.range);
  if (legacyShape) { const { disabled: _new, ...old } = clip; clip = { ...old, excludedActionIds: clip.options.flatMap(option => option.actions.map(action => action.actionId)) }; }
  const placed = await placeClip(base, clip, limits);
  assert.equal(placed.status, 'applied');
  if (placed.status !== 'applied') return;
  // Read through the service's read-time migration: an old "off" clip (unless every step is just outside its range) reads as disabled.
  let timeline: Timeline = migrateLegacyDisabled(placed.timeline);
  if (legacyShape) {
    disabled = [...model.values()].some(m => inRange(m.level));
    for (const m of model.values()) m.excluded = false; // the old "off" exclusions meant off, not per-step exclusions
  }
  assert.equal(!!timeline.clips[0]!.disabled, disabled, 'a legacy "off" clip reads as disabled');

  const revisions = 2 + int(4);
  let conflictCount = 0, keptRestored = 0;
  for (let rev = 0; rev < revisions; rev++) {
    // A creator revision: remove, restore (a step from any earlier revision), move, reword, add.
    const next: Step[] = [];
    for (const step of creator) {
      if (r() < 0.2) continue;
      const copy = structuredClone(step);
      if (r() < 0.3) copy.level = 1 + int(40);
      if (r() < 0.3) { copy.inst.details = `Creator details ${step.id} r${rev}.`; if (r() < 0.4) copy.inst.firstAction = `Creator ${step.id} r${rev}.`; }
      next.push(copy);
    }
    for (const [id, step] of everSeen) if (!next.some(row => row.id === id) && !creator.some(row => row.id === id) && r() < 0.5) {
      const restored = structuredClone(step);
      if (r() < 0.5) restored.level = 1 + int(40);
      next.push(restored);
    }
    for (let k = 0, n = int(2); k < n; k++) next.push({ id: `new-${rev}-${k}`, level: 1 + int(40), inst: { firstAction: `New ${rev}.${k}.`, details: '', whenReady: '' } });
    for (const step of next) everSeen.set(step.id, structuredClone(step));
    const nextSource = await pin(next, uuid());
    await learnIds(nextSource, next);

    const before = timeline.clips[0]!;
    const latest = await sourceClip(nextSource, laneId, limits, { clipId, optionId });
    const preview = await previewSourceUpdate(before, latest.options[0]!, limits);
    const choices = new Map<string, Choice>();
    for (const conflict of preview.conflicts) choices.set(`${conflict.actionId}:${conflict.field}`, r() < 0.5 ? 'keep_mine' : 'use_creator');
    conflictCount += preview.conflicts.length;
    const resolved = preview.conflicts.reduce((value, conflict) => resolveUpdateConflict(value, conflict, choices.get(`${conflict.actionId}:${conflict.field}`)!), preview.clip);
    timeline = await applySourceUpdate(timeline, { ...preview, clip: resolved });
    positional = false;
    assert.equal(!!timeline.clips[0]!.disabled, disabled, 'Enabled in Run is carried exactly');

    if (process.env.TIMELINE_PROPERTY_DEBUG) console.log(JSON.stringify({ rev, start, endExclusive, legacyIds, legacyShape, disabled,
      model: [...model].map(([id, m]) => [id, m.base.level, m.level, !!m.override, m.excluded, m.kept]), next: next.map(s => [s.id, s.level]),
      conflicts: preview.conflicts.map(c => [stepOf.get(c.actionId) ?? c.actionId, c.field, c.theirs.slice(0, 30), choices.get(`${c.actionId}:${c.field}`)]),
      changes: preview.changes.map(c => [stepOf.get(c.actionId) ?? c.actionId, c.kind]),
      beforeActions: before.options[0]!.actions.map(a => [stepOf.get(a.actionId) ?? a.actionId.slice(0, 14), a.trigger.kind === 'level' ? a.trigger.level : -1]),
      beforeOverrides: before.instructionOverrides.map(o => stepOf.get(o.actionId) ?? o.actionId.slice(0, 14)), kept: (before.keptActionIds ?? []).map(k => stepOf.get(k)) }));
    // The model of the same update.
    for (const [stepId, m] of [...model]) {
      const id = idOf.get(stepId)!, theirs = next.find(step => step.id === stepId);
      const candidate = m.excluded && inRange(m.level); // an exclusion on a step outside the range at update time is a coverage one
      if (theirs) {
        const creatorBase = m.kept ? NONE : m.base;
        const creatorChanged = m.kept || !same(m.base.inst, theirs.inst) || m.base.level !== theirs.level;
        if (m.kept) keptRestored++;
        const mine = m.override ?? m.base.inst;
        const level = merge(creatorBase.level, m.level, theirs.level, `${id}:trigger`, choices);
        const inst = Object.fromEntries(FIELDS.map(field => [field, merge(creatorBase.inst[field], mine[field], theirs.inst[field], `${id}:${field}`, choices)])) as Instructions;
        if (candidate && creatorChanged) assert.ok(choices.has(`${id}:excluded`), `an author exclusion on a step the creator changed is a conflict (${stepId})`);
        const excluded = candidate && (!creatorChanged || choices.get(`${id}:excluded`) === 'keep_mine');
        model.set(stepId, { base: { level: theirs.level, inst: structuredClone(theirs.inst) }, level, override: same(inst, theirs.inst) ? null : inst, excluded, kept: false });
      } else if (m.kept) {
        model.set(stepId, { ...m, excluded: candidate }); // kept earlier and still absent: stays as it is
      } else {
        const modified = m.override !== null || m.level !== m.base.level;
        if (!modified) { model.delete(stepId); continue; }
        const key = `${id}:${m.override ? 'firstAction' : 'trigger'}`;
        assert.ok(choices.has(key), `removing a step the author modified is a conflict (${stepId})`);
        if (choices.get(key) === 'keep_mine') model.set(stepId, { ...m, excluded: candidate, kept: true });
        else model.delete(stepId);
      }
    }
    for (const step of next) if (!model.has(step.id)) model.set(step.id, { base: { level: step.level, inst: structuredClone(step.inst) }, level: step.level, override: null, excluded: false, kept: false });
    creator = next;

    // Run, checked against the model.
    const schedule = await compileSchedule({ timeline, options: { limits } });
    const got = new Map(schedule.actions.map(action => [stepOf.get(action.actionId) ?? action.actionId, { level: action.trigger.kind === 'level' ? action.trigger.level : -1, inst: action.instruction }]));
    const expected = new Map([...model].filter(([, m]) => !disabled && !m.excluded && inRange(m.level)).map(([stepId, m]) => [stepId, { level: m.level, inst: m.override ?? m.base.inst }]));
    assert.deepEqual([...got.keys()].sort(), [...expected.keys()].sort(), `revision ${rev + 1}: Run holds exactly the in-range steps minus the author's exclusions in force`);
    for (const [stepId, want] of expected) {
      assert.equal(got.get(stepId)!.level, want.level, `revision ${rev + 1}: level of ${stepId}`);
      assert.deepEqual({ ...got.get(stepId)!.inst }, { ...want.inst }, `revision ${rev + 1}: wording of ${stepId}`);
    }

    // Between updates: local edits, sometimes switching the clip off or on, sometimes a save and reload.
    let current = timeline.clips[0]!;
    current = await localEdits(current, int(4));
    if (r() < 0.15) { current = { ...current, disabled: !current.disabled }; disabled = !disabled; }
    timeline = { ...timeline, clips: [current] };
    if (r() < 0.4) timeline = migrateLegacyDisabled(validated(timelineSchema, JSON.parse(JSON.stringify(timeline)), limits));
  }
  return { legacyIds, legacyShape, disabled: explicitOff, revisions, conflicts: conflictCount, keptRestored };
}

test(`source update property: ${CASES} random update sequences (2-5 creator revisions with local edits, conflict choices and reloads) keep Run exactly as the model says`, async () => {
  const totals = { legacyIds: 0, legacyShape: 0, disabled: 0, revisions: 0, conflicts: 0, keptRestored: 0 };
  for (let i = 0; i < CASES; i++) {
    const seed = SEED + i;
    try {
      const out = await runCase(seed);
      if (out) { totals.legacyIds += +out.legacyIds; totals.legacyShape += +out.legacyShape; totals.disabled += +out.disabled; totals.revisions += out.revisions; totals.conflicts += out.conflicts; totals.keptRestored += out.keptRestored; }
    } catch (error) { if (process.env.TIMELINE_PROPERTY_DEBUG) console.log(error instanceof Error ? error.stack : error); throw new Error(`case seed ${seed} (TIMELINE_PROPERTY_SEED=${seed} TIMELINE_PROPERTY_CASES=1): ${error instanceof Error ? error.message : String(error)}`); }
  }
  console.log(`property: ${CASES} cases, ${totals.revisions} creator revisions applied, ${totals.conflicts} conflicts resolved, ${totals.keptRestored} kept steps restored by a later revision, ${totals.legacyIds} with old double-namespaced ids, ${totals.legacyShape} saved in the old "off" shape, ${totals.disabled} switched off`);
});
