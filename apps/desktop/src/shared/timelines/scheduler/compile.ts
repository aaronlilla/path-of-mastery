import { actionSchema, parseId, timelineSchema, type Action, type Clip, type Trigger } from '@pom/mastery-contracts';
import { selectedSteps } from '../../atlas/plan.js';
import { canonicalJson, contentHash, validated, verifySource } from '../adapters/common.js';
import { atlasWindows, characterWindows } from './windows.js';
import type { ActionGroup, CompileInput, Schedule, SchedulerChunk } from './types.js';

export const SCHEDULER_VERSION = '1.0.0';
export const triggerKey = (trigger: Trigger): string => canonicalJson(trigger);

async function selectedActions(clip: Clip, input: CompileInput): Promise<Action[]> {
  const option = clip.options.find(option => option.optionId === clip.selectedOptionId);
  if (!option) throw new Error('Choose a clip alternative before scheduling.');
  await verifySource(option.source, input.options.limits);
  const overrides = new Map(clip.instructionOverrides.map(override => [override.actionId, override.instruction]));
  return Promise.all(option.actions.filter(action => !clip.excludedActionIds.includes(action.actionId) &&
    (action.trigger.kind !== 'level' || action.trigger.level >= clip.range.start && action.trigger.level < clip.range.endExclusive) &&
    (!clip.atlasPointRange || action.trigger.kind === 'firstMap' && clip.atlasPointRange.start === 0 ||
      action.trigger.kind === 'atlasAllocated' && action.trigger.points >= clip.atlasPointRange.start && action.trigger.points < clip.atlasPointRange.endExclusive ||
      action.trigger.kind !== 'firstMap' && action.trigger.kind !== 'atlasAllocated'))
    .map(async action => {
      const instruction = overrides.get(action.actionId) ?? action.instruction;
      const body = { trigger: action.trigger, instruction, requirements: action.requirements, critical: action.critical, stamp: action.stamp };
      return validated(actionSchema, { ...action, instruction, contentHash: await contentHash(body) }, input.options.limits);
    }));
}

/** Clamps a step's point span into the clip's half-open Atlas point window; null when the whole step falls outside it. */
function clipAtlasSpan(from: number, to: number, range?: { start: number; endExclusive: number }): { from: number; to: number } | null {
  if (!range) return { from, to };
  const last = range.endExclusive - 1;
  if (Math.max(from, to) < range.start || Math.min(from, to) > last) return null;
  const clamp = (value: number) => Math.min(last, Math.max(range.start, value));
  return { from: clamp(from), to: clamp(to) };
}

export async function compileSchedule(input: CompileInput): Promise<Schedule> {
  input = structuredClone(input);
  const timeline = validated(timelineSchema, input.timeline, input.options.limits);
  const actions: Action[] = [], chunks: SchedulerChunk[] = [];
  const laneOrder = new Map(timeline.lanes.map(lane => [lane.laneId, lane.order]));
  const lanes = [...timeline.lanes].sort((a, b) => a.order - b.order);
  const excluded = new Set(timeline.clips.flatMap(clip => clip.excludedActionIds));
  for (const lane of lanes) {
    if (lane.muted) continue;
    for (const clipId of lane.clipIds) {
      if (input.options.omittedClipIds?.includes(clipId)) continue;
      const clip = timeline.clips.find(clip => clip.clipId === clipId)!;
      if (clip.disabled) { for (const action of clip.options.find(option => option.optionId === clip.selectedOptionId)?.actions ?? []) excluded.add(action.actionId); continue; }
      const enabled = await selectedActions(clip, input);
      const option = clip.options.find(option => option.optionId === clip.selectedOptionId)!;
      for (const action of option.actions) if (!enabled.some(enabled => enabled.actionId === action.actionId)) excluded.add(action.actionId);
      actions.push(...enabled);
      if (actions.length > input.options.limits.maxArrayLength) throw new Error('Scheduled action count exceeds the configured limit.');
      const presented = input.options.presentedChunks?.filter(chunk => chunk.clipId === clipId) ?? [];
      if (lane.type === 'atlas') {
        if (option.source.fallbackSnapshot.kind !== 'atlas' || !timeline.firstMapAnchor) throw new Error('An Atlas lane needs a saved Atlas plan and First map anchor.');
        let points = 0;
        for (const [stepIndex, step] of selectedSteps(option.source.fallbackSnapshot.payload, input.options.atlasChoices?.[clipId]).entries()) {
          const span = clipAtlasSpan(points, step.pointTarget, clip.atlasPointRange);
          points = step.pointTarget;
          if (!span) continue;
          const windows = atlasWindows(step.stepId, span.from, span.to, input.options.limits.maxArrayLength - chunks.length);
          for (const [index, window] of windows.entries()) {
            const actionIds = enabled.filter(action => stepIndex === 0 && index === 0 && action.trigger.kind === 'firstMap' ||
              action.trigger.kind === 'atlasAllocated' && action.trigger.stepId === step.stepId &&
              (window.fromPoints <= window.toPoints
                ? action.trigger.points >= window.fromPoints && (action.trigger.points < window.toPoints || index === windows.length - 1 && action.trigger.points === window.toPoints)
                : action.trigger.points <= window.fromPoints && (action.trigger.points > window.toPoints || index === windows.length - 1 && action.trigger.points === window.toPoints)))
              .map(action => action.actionId);
            chunks.push({ chunkId: `atlas:${clipId}:${step.stepId}:${window.fromPoints}:${window.toPoints}`, laneId: lane.laneId, clipId,
              coordinate: 'atlasAllocated', window, anchorId: timeline.firstMapAnchor.anchorId, actionIds });
          }
        }
        if (enabled.some(action => !chunks.some(chunk => chunk.clipId === clipId && chunk.actionIds.includes(action.actionId)))) {
          throw new Error('An instruction does not match a selected Atlas step and point span.');
        }
      } else {
        const size = clip.chunkOverride.kind === 'levels' ? clip.chunkOverride.size
          : input.options.characterChunks?.kind === 'fixed' ? input.options.characterChunks.size : undefined;
        const windows = characterWindows({ size, pace: input.options.pace, landmarks: input.options.landmarks,
          presented: presented.flatMap(chunk => chunk.coordinate === 'level' ? [chunk.window] : []) });
        for (const window of windows) {
          if (window.start >= clip.range.endExclusive || window.endExclusive <= clip.range.start) continue;
          if (chunks.length >= input.options.limits.maxArrayLength) throw new Error('Chunk count exceeds the configured limit.');
          chunks.push({ chunkId: `level:${clipId}:${window.start}:${window.endExclusive}`, laneId: lane.laneId, clipId,
            coordinate: 'level', window, coverage: { start: Math.max(window.start, clip.range.start), endExclusive: Math.min(window.endExclusive, clip.range.endExclusive) },
            actionIds: enabled.filter(action => action.trigger.kind === 'level' && action.trigger.level >= window.start &&
              action.trigger.level < window.endExclusive).map(action => action.actionId) });
        }
      }
    }
  }
  if (new Set(actions.map(action => action.actionId)).size !== actions.length) throw new Error('Scheduled action IDs must be unique.');
  for (const frozen of input.options.presentedChunks ?? []) {
    const index = chunks.findIndex(chunk => chunk.chunkId === frozen.chunkId);
    if (index < 0 || canonicalJson(chunks[index]) !== canonicalJson(frozen)) throw new Error('A presented chunk cannot change in a pinned schedule.');
    chunks[index] = structuredClone(frozen);
  }
  const byTrigger = new Map<string, Action[]>();
  for (const action of actions) {
    const key = triggerKey(action.trigger), group = byTrigger.get(key) ?? [];
    group.push(action);
    byTrigger.set(key, group);
  }
  const groups: ActionGroup[] = [];
  for (const grouped of byTrigger.values()) {
    const fingerprint = await contentHash(grouped.map(action => ({ actionId: action.actionId, contentHash: action.contentHash, trigger: action.trigger })));
    groups.push({ bundleId: parseId('bundle', `schedule:${fingerprint}`), trigger: structuredClone(grouped[0]!.trigger),
      actionIds: grouped.map(action => action.actionId), fingerprint,
      chunkIds: chunks.filter(chunk => chunk.actionIds.some(id => grouped.some(action => action.actionId === id))).map(chunk => chunk.chunkId),
      laneOrder: Math.min(...grouped.map(action => laneOrder.get(action.laneId)!)), authoredOrder: actions.indexOf(grouped[0]!) });
  }
  const atlasIds = new Set(chunks.filter(chunk => chunk.coordinate === 'atlasAllocated').flatMap(chunk => chunk.actionIds));
  groups.sort((a, b) => Number(a.actionIds.some(id => atlasIds.has(id))) - Number(b.actionIds.some(id => atlasIds.has(id))) ||
    a.laneOrder - b.laneOrder || a.authoredOrder - b.authoredOrder);
  return { schedulerVersion: SCHEDULER_VERSION, actions, chunks, groups, excludedActionIds: [...excluded] };
}

export function chunkOverlay(schedule: Schedule): SchedulerChunk[] {
  return structuredClone(schedule.chunks);
}
