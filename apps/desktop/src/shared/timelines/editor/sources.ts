import { parseId, type ActionId, type Clip, type ClipOption, type FrozenSource, type LaneId, type Timeline, type Trigger, type ValidationLimits } from '@pom/mastery-contracts';
import { adaptAtlas, adaptBuild, adaptFilter, adaptText, verifySource } from '../adapters/index.js';
import { cloneClip, withCoverage, type Range } from './model.js';

export function suggestedRange(option: Pick<ClipOption, 'actions'>): Range {
  const levels = option.actions.flatMap(action => action.trigger.kind === 'level' ? [action.trigger.level] : []);
  return levels.length ? { start: Math.min(...levels), endExclusive: Math.max(...levels) + 1 } : { start: 1, endExclusive: 101 };
}
export async function sourceClip(source: FrozenSource, laneId: LaneId, limits: ValidationLimits,
  settings: { range?: Range; anchorId?: string; textTriggers?: Trigger[]; clipId?: Clip['clipId']; optionId?: ClipOption['optionId']; atlasChoices?: Record<string, import('@pom/mastery-contracts').StepId> } = {}): Promise<Clip> {
  const frozen = await verifySource(source, limits);
  const clipId = settings.clipId ?? parseId('clip', crypto.randomUUID()), optionId = settings.optionId ?? parseId('option', crypto.randomUUID());
  const context = { laneId, clipId, optionId, limits };
  const actions = frozen.fallbackSnapshot.kind === 'build' ? await adaptBuild(frozen, context)
    : frozen.fallbackSnapshot.kind === 'atlas' ? await adaptAtlas(frozen, context, settings.anchorId ?? 'first-map', settings.atlasChoices)
    : frozen.fallbackSnapshot.kind === 'filter' ? await adaptFilter(frozen, context)
    : await adaptText(frozen, context, settings.textTriggers);
  const option: ClipOption = { optionId, title: frozen.fallbackSnapshot.payload.title, source: frozen, actions };
  const clip: Clip = { clipId, laneId, options: [option], selectedOptionId: optionId, range: settings.range ?? suggestedRange(option),
    instructionOverrides: [], timingMode: 'keep_instruction_timing', chunkOverride: { kind: 'auto' }, excludedActionIds: [], disabled: false };
  return withCoverage(await cloneClip(clip, clipId), clip.range);
}
/** Copies a clip under another clip id (Duplicate, Paste, Choose source). Each action gets the id sourceClip gives that source step under the new
 *  clip id, so a later source update for the copy matches its actions and keeps local timing and wording. Actions the source no longer
 *  produces (kept after an earlier update) fall back to cloneClip's namespaced id. */
export async function copyClip(clip: Clip, limits: ValidationLimits, settings: { clipId?: Clip['clipId']; laneId?: LaneId } = {}): Promise<Clip> {
  const clipId = settings.clipId ?? parseId('clip', crypto.randomUUID()), laneId = settings.laneId ?? clip.laneId, rename = new Map<ActionId, ActionId>();
  for (const option of clip.options) {
    const firstMap = option.actions.find(action => action.trigger.kind === 'firstMap')?.trigger;
    const anchorId = firstMap?.kind === 'firstMap' ? firstMap.anchorId : undefined;
    try {
      const before = (await sourceClip(option.source, clip.laneId, limits, { clipId: clip.clipId, optionId: option.optionId, anchorId })).options[0]!.actions;
      const after = (await sourceClip(option.source, laneId, limits, { clipId, optionId: option.optionId, anchorId })).options[0]!.actions;
      if (before.length !== after.length) continue;
      const own = new Set(option.actions.map(action => action.actionId));
      before.forEach((action, index) => { if (own.has(action.actionId)) rename.set(action.actionId, after[index]!.actionId); });
    } catch { /* a source that cannot be re-adapted keeps cloneClip's ids */ }
  }
  return cloneClip(clip, clipId, laneId, rename);
}
export function sendDefaults(timelines: { id: string; timeline: Timeline; lastUsed: number; activeLeague: boolean }[], source: FrozenSource,
  preferences: { recentId?: string; openAfterAdding?: boolean } = {}) {
  const compatible = timelines.filter(row => row.activeLeague && row.timeline.lanes.some(lane => lane.type === source.fallbackSnapshot.kind));
  const target = compatible.find(row => row.id === preferences.recentId) ?? [...compatible].sort((a, b) => b.lastUsed - a.lastUsed)[0];
  return { timelineId: target?.id ?? null, laneId: target?.timeline.lanes.find(lane => lane.type === source.fallbackSnapshot.kind)?.laneId ?? null,
    openAfterAdding: preferences.openAfterAdding ?? true, createNew: !target };
}
