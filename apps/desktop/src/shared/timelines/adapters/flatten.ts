import { parseId, revisionKey, revisionRefSchema, timelineBundleSchema, type Clip, type Lane, type RevisionRef, type SourceCredit,
  type TimelineBundle, type ValidationLimits } from '@pom/mastery-contracts';
import { canonicalJson, contentHash, TimelineSourceError, validated, verifySource } from './common.js';

export type FlattenRequest = {
  source: TimelineBundle;
  sourceRevision: RevisionRef;
  laneIds: readonly string[];
  insertionId: string;
  credit?: SourceCredit;
  ancestry: readonly RevisionRef[];
  limits: ValidationLimits;
};
export async function flattenTimeline(request: FlattenRequest) {
  request = structuredClone(request);
  if (request.ancestry.some(ref => ref.objectId === request.sourceRevision.objectId)) throw new TimelineSourceError('CYCLE', 'A Timeline cannot insert itself or an ancestor.');
  if (request.ancestry.length + 1 > request.limits.maxDepth) throw new TimelineSourceError('DEPTH', 'The Timeline source exceeds the insertion depth limit.');
  validated(revisionRefSchema, request.sourceRevision, request.limits);
  const source = validated(timelineBundleSchema, request.source, request.limits);
  if (await contentHash(source) !== request.sourceRevision.fallbackSnapshotHash) throw new TimelineSourceError('HASH_MISMATCH', 'The Timeline bundle does not match its source pin.');
  if (!request.insertionId || new Set(request.laneIds).size !== request.laneIds.length ||
    request.laneIds.some(id => !source.timeline.lanes.some(lane => lane.laneId === id))) throw new TimelineSourceError('INVALID', 'Choose each available lane at most once.');
  const namespace = [revisionKey(request.sourceRevision), request.insertionId];
  const renamed = async <K extends 'lane' | 'clip' | 'option' | 'action'>(kind: K, id: string) => parseId(kind, `${kind}:${await contentHash([...namespace, kind, id])}`);
  const lanes: Lane[] = [], clips: Clip[] = [];
  const wanted = new Set(request.laneIds);
  for (const lane of source.timeline.lanes.filter(lane => wanted.has(lane.laneId)).sort((a, b) => a.order - b.order)) {
    const laneId = await renamed('lane', lane.laneId), clipIds: Clip['clipId'][] = [];
    for (const oldId of lane.clipIds) {
      const old = source.timeline.clips.find(clip => clip.clipId === oldId);
      if (!old) throw new TimelineSourceError('INVALID', 'The lane references a missing clip.');
      const clipId = await renamed('clip', old.clipId);
      const optionIds = new Map(await Promise.all(old.options.map(async option => [option.optionId, await renamed('option', option.optionId)] as const)));
      const actionIds = new Map(await Promise.all(old.options.flatMap(option => option.actions).map(async action => [action.actionId, await renamed('action', action.actionId)] as const)));
      const options = await Promise.all(old.options.map(async option => {
        const frozen = await verifySource(option.source, request.limits);
        const optionId = optionIds.get(option.optionId)!;
        return { ...option, optionId, source: frozen, actions: option.actions.map(action => ({ ...action, actionId: actionIds.get(action.actionId)!, laneId, clipId, optionId })) };
      }));
      clipIds.push(clipId);
      const selected = old.selectedOptionId ?? source.choices.find(choice => choice.clipId === old.clipId)!.optionId;
      clips.push({ ...old, clipId, laneId, options, selectedOptionId: optionIds.get(selected)!,
        instructionOverrides: old.instructionOverrides.map(override => ({ ...override, actionId: actionIds.get(override.actionId)! })),
        excludedActionIds: old.excludedActionIds.map(id => actionIds.get(id)!),
        ...(old.keptActionIds ? { keptActionIds: old.keptActionIds.map(id => actionIds.get(id)!) } : {}) });
    }
    lanes.push({ ...lane, laneId, order: lanes.length, clipIds });
  }
  const needed = new Set(clips.flatMap(clip => clip.options.map(option => revisionKey(option.source.ref))));
  const dependencies = source.dependencies.filter(dependency => needed.has(revisionKey(dependency.ref)));
  for (let index = 0; index < dependencies.length; index++) for (const ref of dependencies[index]!.dependsOn) {
    const key = revisionKey(ref);
    if (needed.has(key)) continue;
    needed.add(key);
    const dependency = source.dependencies.find(row => revisionKey(row.ref) === key);
    if (!dependency) throw new TimelineSourceError('MISSING_PAYLOAD', 'A selected lane dependency is missing.');
    dependencies.push(dependency);
  }
  for (const dependency of dependencies) await verifySource({ ref: dependency.ref, fallbackSnapshot: dependency.snapshot }, request.limits);
  const credit: SourceCredit = request.credit ?? { source: request.sourceRevision, origin: null,
    creatorName: 'Unknown creator', title: source.timeline.title, status: 'available' };
  if (canonicalJson(credit.source) !== canonicalJson(request.sourceRevision)) throw new TimelineSourceError('INVALID', 'The Timeline credit does not match its source pin.');
  validated(timelineBundleSchema, { ...source, credits: [credit] }, request.limits);
  const credits = [...new Map([...source.credits, ...source.timeline.credits, credit].map(row => [canonicalJson(row), row])).values()];
  return { lanes, clips, dependencies, assets: source.assets, credits,
    firstMapAnchor: source.timeline.firstMapAnchor,
    choices: clips.flatMap(clip => clip.selectedOptionId === null ? [] : [{ clipId: clip.clipId, optionId: clip.selectedOptionId }]) };
}
