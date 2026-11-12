import type { Action, ActionId, Clip, ClipOption, Instructions, ValidationLimits } from '@pom/mastery-contracts';
import { threeWayMerge } from '../../documents/merge.js';
import { canonicalJson, contentHash, verifySource } from '../adapters/common.js';
import { excludedByCoverage, withCoverage } from './model.js';
import { sourceClip } from './sources.js';

export type UpdateConflict = { actionId: ActionId; field: keyof Instructions | 'trigger' | 'excluded'; mine: string; theirs: string; retainedAction?: Action; retainedInstruction?: Instructions };
/** The `theirs` text of a conflict for a local action the update could not match to any step of the new version. */
export const UNMATCHED_IN_UPDATE = 'Not matched in the new version';
const RESTORED = { trigger: { kind: 'restored', level: -1 } as unknown as Action['trigger'], instruction: { firstAction: '\u0000', details: '\u0000', whenReady: '\u0000' } as Instructions };
const sameStep = (a: Action, b: Action) => a.trigger.kind === b.trigger.kind && a.critical === b.critical
  && canonicalJson(a.instruction) === canonicalJson(b.instruction) && canonicalJson(a.requirements) === canonicalJson(b.requirements);
/** Gives the selected option's actions the ids sourceClip gives the same steps today. Clips saved by older builds (Add clip namespaced
 *  ids twice) or split by Replace range carry other ids for the same steps; they are recognised by position and content against the
 *  clip's own pinned source, and their overrides and exclusions follow them. Actions that still match nothing are returned as unmatched. */
function rekeyToSource(clip: Clip, authored: Action[], latest: Action[]): { clip: Clip; unmatched: Set<ActionId> } {
  const output = structuredClone(clip), option = output.options.find(row => row.optionId === output.selectedOptionId)!;
  const ids = new Set(option.actions.map(action => action.actionId)), known = new Set(authored.map(action => action.actionId)), rename = new Map<ActionId, ActionId>();
  authored.forEach((step, index) => {
    const action = option.actions[index];
    if (action && action.actionId !== step.actionId && !known.has(action.actionId) && !ids.has(step.actionId) && sameStep(action, step)) rename.set(action.actionId, step.actionId);
  });
  // A kept step in a copied clip (Duplicate, Paste, Choose source) carries cloneClip's id, not the one sourceClip gives the restored
  // step: a new step of the latest version with the same content is that step coming back, so it takes that id (never a duplicate).
  const latestIds = new Set(latest.map(action => action.actionId)), taken = new Set<ActionId>();
  for (const keptId of output.keptActionIds ?? []) {
    const action = option.actions.find(row => row.actionId === keptId);
    if (!action || latestIds.has(keptId)) continue;
    const back = latest.find(next => !ids.has(next.actionId) && !known.has(next.actionId) && !taken.has(next.actionId) && sameStep(action, next));
    if (back) { rename.set(keptId, back.actionId); taken.add(back.actionId); }
  }
  const id = (value: ActionId) => rename.get(value) ?? value;
  for (const action of option.actions) action.actionId = id(action.actionId);
  output.instructionOverrides = output.instructionOverrides.map(row => ({ ...row, actionId: id(row.actionId) }));
  output.excludedActionIds = output.excludedActionIds.map(id);
  if (output.keptActionIds) output.keptActionIds = output.keptActionIds.map(id);
  // Actions the author kept after a creator removal are not in the pinned source by design: they are local, not unmatched.
  const kept = new Set(output.keptActionIds ?? []);
  const unmatched = new Set(option.actions.filter(action => !known.has(action.actionId) && !kept.has(action.actionId)).map(action => action.actionId));
  return { clip: output, unmatched };
}
export async function previewSourceUpdate(input: Clip, latest: ClipOption, limits: ValidationLimits) {
  const selected = input.options.find(option => option.optionId === input.selectedOptionId);
  if (!selected) throw new Error('Choose one alternative before updating this clip.');
  await verifySource(latest.source, limits);
  if (latest.source.fallbackSnapshot.kind !== selected.source.fallbackSnapshot.kind) throw new Error('Choose a source of the same lane type.');
  const firstMap = selected.actions.find(action => action.trigger.kind === 'firstMap')?.trigger;
  const authored = await sourceClip(selected.source, input.laneId, limits, { clipId: input.clipId, optionId: selected.optionId, anchorId: firstMap?.kind === 'firstMap' ? firstMap.anchorId : undefined });
  const { clip, unmatched } = rekeyToSource(input, authored.options[0]!.actions, latest.actions);
  const original = clip.options.find(option => option.optionId === clip.selectedOptionId)!;
  const conflicts: UpdateConflict[] = [], overrides: Clip['instructionOverrides'] = [], changes: { actionId: ActionId; kind: 'added' | 'removed' | 'changed' }[] = [], blockers: string[] = [];
  const options = structuredClone(clip.options), target = options.find(option => option.optionId === clip.selectedOptionId)!;
  const updatedActions: Action[] = [];
  // An action the author kept after an earlier creator removal has no creator value to merge against: when a later revision
  // restores the step, every field where the author's value differs from the restored one is a conflict, Keep mine by default.
  // The RESTORED sentinel is a merge base equal to neither side, which makes threeWayMerge report exactly those.
  const kept = new Set(clip.keptActionIds ?? []), nextKept: ActionId[] = [];
  for (const next of latest.actions) {
    const base = original.actions.find(action => action.actionId === next.actionId), restored = kept.has(next.actionId);
    const creatorInstruction = restored ? RESTORED.instruction : base?.instruction;
    const mine = clip.instructionOverrides.find(row => row.actionId === next.actionId)?.instruction ?? base?.instruction;
    const merged = base && mine && creatorInstruction ? threeWayMerge(creatorInstruction, mine, next.instruction) : { value: next.instruction, conflicts: [] };
    for (const conflict of merged.conflicts) conflicts.push({ actionId: next.actionId, field: conflict.path[0] as keyof Instructions, mine: String(conflict.mine), theirs: String(conflict.theirs) });
    if (canonicalJson(merged.value) !== canonicalJson(next.instruction)) overrides.push({ actionId: next.actionId, instruction: merged.value });
    // Creator changes compare the creator's old timing with the new one; a Level marker the author moved locally is not a creator change.
    const authoredTrigger = restored ? RESTORED.trigger : authored.options[0]!.actions.find(action => action.actionId === next.actionId)?.trigger;
    if (!base) changes.push({ actionId: next.actionId, kind: 'added' });
    else if (canonicalJson(creatorInstruction) !== canonicalJson(next.instruction) || canonicalJson(authoredTrigger ?? base.trigger) !== canonicalJson(next.trigger) || canonicalJson(base.requirements) !== canonicalJson(next.requirements)) changes.push({ actionId: next.actionId, kind: 'changed' });
    const timing = base && authoredTrigger ? threeWayMerge(authoredTrigger, base.trigger, next.trigger) : { value: next.trigger, conflicts: [] };
    const trigger = timing.value;
    if (timing.conflicts.length) conflicts.push({ actionId: next.actionId, field: 'trigger', mine: canonicalJson(base!.trigger), theirs: canonicalJson(next.trigger) });
    if (trigger.kind === 'level') for (const requirement of next.requirements) if (requirement.kind === 'level' && trigger.level < requirement.minimum) blockers.push(`This action requires Level ${requirement.minimum}.`);
    const body = { trigger, instruction: next.instruction, requirements: next.requirements, critical: next.critical, stamp: next.stamp };
    updatedActions.push({ ...structuredClone(next), ...body, laneId: clip.laneId, clipId: clip.clipId, optionId: target.optionId, sourceRevision: latest.source.ref, contentHash: await contentHash(body) });
  }
  for (const base of original.actions) if (!latest.actions.some(action => action.actionId === base.actionId)) {
    const mine = clip.instructionOverrides.find(row => row.actionId === base.actionId);
    if (kept.has(base.actionId)) {
      // Kept after an earlier removal and still absent: the author already chose to keep it; it stays as it is.
      const body = { trigger: base.trigger, instruction: base.instruction, requirements: base.requirements, critical: base.critical, stamp: latest.source.ref.stamp };
      updatedActions.push({ ...structuredClone(base), ...body, sourceRevision: latest.source.ref, contentHash: await contentHash(body) });
      if (mine) overrides.push(structuredClone(mine));
      nextKept.push(base.actionId);
      continue;
    }
    if (unmatched.has(base.actionId)) {
      // Never reset silently: an action whose step cannot be identified stays (Keep mine) unless the author chooses the creator's version.
      const body = { trigger: base.trigger, instruction: base.instruction, requirements: base.requirements, critical: base.critical, stamp: latest.source.ref.stamp };
      const retainedAction = { ...structuredClone(base), ...body, sourceRevision: latest.source.ref, contentHash: await contentHash(body) };
      conflicts.push({ actionId: base.actionId, field: 'trigger', mine: `${canonicalJson(base.trigger)} ${(mine?.instruction ?? base.instruction).firstAction}`, theirs: UNMATCHED_IN_UPDATE, retainedAction, retainedInstruction: mine ? structuredClone(mine.instruction) : undefined });
      updatedActions.push(retainedAction); if (mine) overrides.push(structuredClone(mine));
      continue;
    }
    changes.push({ actionId: base.actionId, kind: 'removed' });
    // Removing an action the author modified (own wording, or timing moved away from the creator's) is a conflict with
    // Keep mine selected; an unmodified removed action is a plain removal.
    const authoredTrigger = authored.options[0]!.actions.find(action => action.actionId === base.actionId)?.trigger;
    const retimed = !!authoredTrigger && canonicalJson(authoredTrigger) !== canonicalJson(base.trigger);
    if (mine || retimed) {
      const body = { trigger: base.trigger, instruction: base.instruction, requirements: base.requirements, critical: base.critical, stamp: latest.source.ref.stamp };
      const retainedAction = { ...structuredClone(base), ...body, sourceRevision: latest.source.ref, contentHash: await contentHash(body) };
      if (mine) conflicts.push({ actionId: base.actionId, field: 'firstAction', mine: mine.instruction.firstAction, theirs: 'Removed by creator', retainedAction, retainedInstruction: structuredClone(mine.instruction) });
      else conflicts.push({ actionId: base.actionId, field: 'trigger', mine: `${base.trigger.kind === 'level' ? `Level ${base.trigger.level}` : canonicalJson(base.trigger)}: ${base.instruction.firstAction}`, theirs: 'Removed by creator', retainedAction });
      updatedActions.push(retainedAction); if (mine) overrides.push(structuredClone(mine));
      nextKept.push(base.actionId); // Keep mine (the default) marks it kept locally; Use creator removes it and this mark
    }
  }
  target.source = structuredClone(latest.source);
  target.title = threeWayMerge(original.source.fallbackSnapshot.payload.title, original.title, latest.title).value;
  target.actions = updatedActions;
  const otherIds = new Set(options.filter(option => option.optionId !== target.optionId).flatMap(option => option.actions.map(action => action.actionId)));
  // Exclusions: only the author's own exclusions (those the old coverage does not explain) carry over; coverage exclusions are
  // recomputed from the clip's range, here and again in applySourceUpdate after conflicts are resolved. "Enabled in Run" is the
  // explicit clip.disabled flag and is carried as is. An author exclusion on a step the creator changed is a conflict:
  // Keep mine leaves it excluded, Use creator brings it back.
  const oldCoverage = new Set(excludedByCoverage(clip)), survivors = new Set([...otherIds, ...updatedActions.map(action => action.actionId)]);
  const userExcluded = clip.excludedActionIds.filter(id => !oldCoverage.has(id) && survivors.has(id));
  for (const id of userExcluded) if (changes.some(change => change.actionId === id && change.kind === 'changed')) {
    const action = updatedActions.find(row => row.actionId === id)!;
    conflicts.push({ actionId: id, field: 'excluded', mine: `Excluded from Run: ${action.instruction.firstAction}`, theirs: 'Changed by creator' });
  }
  const keptActionIds = [...(clip.keptActionIds ?? []).filter(id => otherIds.has(id)), ...nextKept];
  const draft: Clip = { ...structuredClone(clip), options, range: { ...clip.range },
    instructionOverrides: [...clip.instructionOverrides.filter(row => otherIds.has(row.actionId)), ...overrides],
    excludedActionIds: userExcluded, ...(keptActionIds.length || clip.keptActionIds ? { keptActionIds } : {}) };
  const output: Clip = { ...draft, excludedActionIds: [...new Set([...userExcluded, ...excludedByCoverage(draft)])] };
  return { clip: output, baseHash: await contentHash(input), conflicts, changes, blockers, userExcluded, defaultChoice: 'keep_mine' as const };
}
export async function applySourceUpdate(timeline: import('@pom/mastery-contracts').Timeline, preview: Awaited<ReturnType<typeof previewSourceUpdate>>) {
  const current = timeline.clips.find(clip => clip.clipId === preview.clip.clipId);
  if (!current || await contentHash(current) !== preview.baseHash) throw new Error('This clip changed. Preview the update again.');
  const blockers = updateBlockers(preview.clip);
  if (blockers.length) throw new Error(blockers.join('\n'));
  const resolved = structuredClone(preview.clip);
  for (const option of resolved.options) for (const action of option.actions) {
    action.contentHash = await contentHash({ trigger: action.trigger, instruction: action.instruction,
      requirements: action.requirements, critical: action.critical, stamp: action.stamp });
  }
  // Coverage is recomputed AFTER conflict resolution (a "Use creator" timing choice can move a step in or out of the range).
  // The author's exclusions are the ones the preview carried, minus any a conflict choice gave back to the creator.
  const ids = new Set(resolved.options.flatMap(option => option.actions.map(action => action.actionId)));
  // A wording override that equals the creator's wording after the choices (every field resolved to the creator's) is no longer the
  // author's: drop it, so the step does not count as locally modified later (a later removal would wrongly ask Keep mine).
  const instructionOf = new Map(resolved.options.flatMap(option => option.actions.map(action => [action.actionId, action.instruction] as const)));
  resolved.instructionOverrides = resolved.instructionOverrides.filter(row => ids.has(row.actionId) && canonicalJson(row.instruction) !== canonicalJson(instructionOf.get(row.actionId)));
  const user = preview.userExcluded.filter(id => ids.has(id) && resolved.excludedActionIds.includes(id));
  resolved.excludedActionIds = [...new Set([...user, ...excludedByCoverage(resolved)])];
  const copy = structuredClone(timeline);
  return { ...copy, clips: copy.clips.map(clip => clip.clipId === current.clipId ? resolved : clip) };
}
export function updateBlockers(clip: Clip): string[] {
  return [...new Set(clip.options.flatMap(option => option.actions.flatMap(action =>
    action.trigger.kind === 'level' ? action.requirements.flatMap(requirement =>
      requirement.kind === 'level' && action.trigger.kind === 'level' && action.trigger.level < requirement.minimum
        ? [`This action requires Level ${requirement.minimum}.`] : []) : [])))];
}
export function resolveUpdateConflict(clip: Clip, conflict: UpdateConflict, choice: 'keep_mine' | 'use_creator'): Clip {
  const output = structuredClone(clip);
  const option = output.options.find(option => option.optionId === output.selectedOptionId)!;
  if (conflict.theirs === 'Removed by creator' || conflict.theirs === UNMATCHED_IN_UPDATE) {
    if (choice === 'keep_mine') {
      if (conflict.retainedAction && !option.actions.some(action => action.actionId === conflict.actionId)) option.actions.push(structuredClone(conflict.retainedAction));
      if (conflict.retainedInstruction && !output.instructionOverrides.some(row => row.actionId === conflict.actionId)) output.instructionOverrides.push({ actionId: conflict.actionId, instruction: structuredClone(conflict.retainedInstruction) });
      return withCoverage(output, output.range);
    }
    option.actions = option.actions.filter(action => action.actionId !== conflict.actionId);
    if (output.keptActionIds) output.keptActionIds = output.keptActionIds.filter(id => id !== conflict.actionId);
    output.instructionOverrides = output.instructionOverrides.filter(row => row.actionId !== conflict.actionId);
    output.excludedActionIds = output.excludedActionIds.filter(id => id !== conflict.actionId);
  } else if (conflict.field === 'excluded') {
    if (choice === 'use_creator') output.excludedActionIds = output.excludedActionIds.filter(id => id !== conflict.actionId);
    if (choice === 'keep_mine' && !output.excludedActionIds.includes(conflict.actionId)) output.excludedActionIds.push(conflict.actionId);
  } else if (conflict.field === 'trigger') {
    const action = option.actions.find(action => action.actionId === conflict.actionId);
    if (action) action.trigger = JSON.parse(choice === 'keep_mine' ? conflict.mine : conflict.theirs) as Action['trigger'];
  } else {
    const row = output.instructionOverrides.find(row => row.actionId === conflict.actionId);
    if (row) row.instruction[conflict.field] = choice === 'keep_mine' ? conflict.mine : conflict.theirs;
  }
  return output;
}
