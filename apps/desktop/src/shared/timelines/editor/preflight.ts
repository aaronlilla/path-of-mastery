import { actionSchema, parseId, revisionKey, timelineBundleSchema, timelineSchema, type ClipId, type EmbeddedDependency,
  type Known, type Timeline, type TimelineBundle, type ValidationLimits } from '@pom/mastery-contracts';
import { selectedSteps } from '../../atlas/plan.js';
import { canonicalJson, validated, verifySource } from '../adapters/common.js';
import { compileSchedule, type Schedule } from '../scheduler/index.js';

export type RunBlocker = { kind: 'alternative' | 'source' | 'compatibility'; clipId: ClipId; message: string }
  | { kind: 'empty' | 'competing'; message: string };
export type RunStart = { level: number; atlasPoints: Known<number>; mode: 'resume' | 'observation' | 'manual' | 'first_instruction' };
export type PreflightContext = {
  limits: ValidationLimits; omittedClipIds?: ClipId[]; incompatible?: { clipId: ClipId; reason: string }[];
  competingRun?: boolean; dependencies?: EmbeddedDependency[];
  start?: { resume?: RunStart; observation?: { reliable: boolean; selected: boolean; level: number; atlasPoints: Known<number> }; manual?: { level: number; atlasPoints: Known<number> } };
};
export type PreflightResult = { ready: false; blockers: RunBlocker[]; activeLanes: number; mutedLanes: number }
  | { ready: true; blockers: []; activeLanes: number; mutedLanes: number; bundle: TimelineBundle; schedule: Schedule; omittedClipIds: ClipId[]; start: RunStart };
export function startPosition(timeline: Timeline, start: PreflightContext['start']): RunStart {
  if (start?.resume) return structuredClone(start.resume);
  const observation = start?.observation;
  if (observation?.reliable && observation.selected && Number.isInteger(observation.level) && observation.level >= 1 && observation.level <= 100)
    return { level: observation.level, atlasPoints: structuredClone(observation.atlasPoints), mode: 'observation' };
  if (start?.manual) {
    if (!Number.isInteger(start.manual.level) || start.manual.level < 1 || start.manual.level > 100) throw new Error('Choose a start within Levels 1-100.');
    if (start.manual.atlasPoints.status === 'known' && (!Number.isSafeInteger(start.manual.atlasPoints.value) || start.manual.atlasPoints.value < 0)) throw new Error('Choose a nonnegative Atlas baseline or Unknown.');
    return { ...structuredClone(start.manual), mode: 'manual' };
  }
  const levels = timeline.clips.filter(clip => !clip.disabled).flatMap(clip => clip.options.filter(option => option.optionId === clip.selectedOptionId).flatMap(option => option.actions
    .filter(action => !clip.excludedActionIds.includes(action.actionId) && action.trigger.kind === 'level' && action.trigger.level >= clip.range.start && action.trigger.level < clip.range.endExclusive)
    .flatMap(action => action.trigger.kind === 'level' ? [action.trigger.level] : [])));
  return { level: levels.length ? Math.min(...levels) : 1, atlasPoints: { status: 'unknown', reason: 'No Atlas baseline selected.' }, mode: 'first_instruction' };
}
export async function preflightRun(input: Timeline, context: PreflightContext): Promise<PreflightResult> {
  const timeline = structuredClone(input), blockers: RunBlocker[] = [];
  const mutedLanes = timeline.lanes.filter(lane => lane.muted).length, activeLanes = timeline.lanes.length - mutedLanes;
  const omitted = new Set(context.omittedClipIds ?? []);
  if ([...omitted].some(id => !timeline.clips.some(clip => clip.clipId === id))) throw new Error('An omitted clip is no longer in this Timeline. Review the updated run.');
  const activeIds = new Set(timeline.lanes.filter(lane => !lane.muted).flatMap(lane => lane.clipIds));
  // A clip turned off with "Enabled in Run" (clip.disabled) contributes nothing, like an omitted clip.
  const clips = timeline.clips.filter(clip => activeIds.has(clip.clipId) && !omitted.has(clip.clipId) && !clip.disabled);
  let count = 0;
  for (const clip of clips) {
    const option = clip.options.find(option => option.optionId === clip.selectedOptionId);
    if (!option) { blockers.push({ kind: 'alternative', clipId: clip.clipId, message: 'Choose one alternative' }); continue; }
    try { await verifySource(option.source, context.limits); }
    catch { blockers.push({ kind: 'source', clipId: clip.clipId, message: 'Source missing' }); continue; }
    const incompatible = context.incompatible?.find(row => row.clipId === clip.clipId);
    if (incompatible) { blockers.push({ kind: 'compatibility', clipId: clip.clipId, message: incompatible.reason }); continue; }
    const activeActions = option.actions.filter(action => !clip.excludedActionIds.includes(action.actionId) &&
      (action.trigger.kind !== 'level' || action.trigger.level >= clip.range.start && action.trigger.level < clip.range.endExclusive));
    const invalidAction = activeActions.find(action => !actionSchema.parse(action, context.limits).ok);
    if (invalidAction) { blockers.push({ kind: 'compatibility', clipId: clip.clipId, message: `Instruction ${invalidAction.actionId} has missing or invalid required data.` }); continue; }
    const invalidRequirement = activeActions.find(action => action.trigger.kind === 'level' && action.requirements.some(requirement => requirement.kind === 'level' && action.trigger.kind === 'level' && action.trigger.level < requirement.minimum));
    if (invalidRequirement) {
      const requirement = invalidRequirement.requirements.find(requirement => requirement.kind === 'level' && invalidRequirement.trigger.kind === 'level' && invalidRequirement.trigger.level < requirement.minimum)!;
      blockers.push({ kind: 'compatibility', clipId: clip.clipId, message: `This action requires Level ${requirement.kind === 'level' ? requirement.minimum : ''}.` }); continue;
    }
    if (option.source.fallbackSnapshot.kind === 'atlas') {
      if (!timeline.firstMapAnchor) { blockers.push({ kind: 'compatibility', clipId: clip.clipId, message: 'Choose a First map anchor.' }); continue; }
      try { selectedSteps(option.source.fallbackSnapshot.payload); }
      catch { blockers.push({ kind: 'alternative', clipId: clip.clipId, message: 'Choose one Atlas step alternative' }); continue; }
    }
    count += option.actions.filter(action => !clip.excludedActionIds.includes(action.actionId) &&
      (action.trigger.kind !== 'level' || action.trigger.level >= clip.range.start && action.trigger.level < clip.range.endExclusive)).length;
  }
  if (!count && !blockers.length) blockers.push({ kind: 'empty', message: 'This timeline has no active instructions.' });
  if (context.competingRun) blockers.push({ kind: 'competing', message: 'Keep current run / Replace with this timeline' });
  if (blockers.length) return { ready: false, blockers, activeLanes, mutedLanes };
  const resolved: Timeline = { ...timeline, lanes: timeline.lanes.filter(lane => !lane.muted).map((lane, order) => ({ ...lane, order, clipIds: lane.clipIds.filter(id => clips.some(clip => clip.clipId === id)) })),
    clips: clips.map(clip => {
      const option = clip.options.find(option => option.optionId === clip.selectedOptionId)!;
      const ids = new Set(option.actions.map(action => action.actionId));
      return { ...clip, options: [option], instructionOverrides: clip.instructionOverrides.filter(row => ids.has(row.actionId)), excludedActionIds: clip.excludedActionIds.filter(id => ids.has(id)),
        ...(clip.keptActionIds ? { keptActionIds: clip.keptActionIds.filter(id => ids.has(id)) } : {}) };
    }) };
  validated(timelineSchema, resolved, context.limits);
  const schedule = await compileSchedule({ timeline: resolved, options: { limits: context.limits } });
  const dependencies = await embeddedDependencies(resolved, context.limits, context.dependencies);
  const bundle = validated(timelineBundleSchema, { schemaVersion: 1, bundleId: parseId('bundle', crypto.randomUUID()), timeline: resolved, dependencies, assets: [],
    schedulerVersion: schedule.schedulerVersion, actionSchemaVersion: 1, choices: resolved.clips.map(clip => ({ clipId: clip.clipId, optionId: clip.selectedOptionId! })), credits: timeline.credits }, context.limits);
  return { ready: true, blockers: [], activeLanes, mutedLanes, bundle, schedule,
    omittedClipIds: [...omitted], start: startPosition(resolved, context.start) };
}
export async function embeddedDependencies(timeline: Timeline, limits: ValidationLimits, extra: EmbeddedDependency[] = []): Promise<EmbeddedDependency[]> {
  const rows = new Map<string, EmbeddedDependency>();
  for (const option of timeline.clips.flatMap(clip => clip.options)) {
    const frozen = await verifySource(option.source, limits), key = revisionKey(frozen.ref);
    const prior = rows.get(key);
    if (prior && canonicalJson(prior.snapshot) !== canonicalJson(frozen.fallbackSnapshot)) throw new Error('Two saved copies disagree about the same source revision.');
    rows.set(key, { ref: frozen.ref, snapshot: frozen.fallbackSnapshot, dependsOn: extra.find(row => revisionKey(row.ref) === key)?.dependsOn ?? [] });
  }
  for (const row of rows.values()) for (const ref of row.dependsOn) {
    const key = revisionKey(ref);
    if (rows.has(key)) continue;
    const dependency = extra.find(row => revisionKey(row.ref) === key);
    if (!dependency) throw new Error('A saved source dependency is missing.');
    await verifySource({ ref: dependency.ref, fallbackSnapshot: dependency.snapshot }, limits); rows.set(key, structuredClone(dependency));
  }
  return [...rows.values()];
}
