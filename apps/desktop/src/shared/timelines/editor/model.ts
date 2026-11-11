import { parseId, timelineSchema, type ActionId, type Clip, type ClipId, type LaneId, type LaneType,
  type LeagueStamp, type Timeline, type ValidationLimits } from '@pom/mastery-contracts';
import { contentHash, validated } from '../adapters/common.js';
// copyClip is only called inside placeClip, so this import cycle (sources.ts imports model.ts) is safe at load time.
import { copyClip } from './sources.js';

export type Range = Clip['range'];
export const laneLabels: Record<LaneType, string> = { build: 'Build', atlas: 'Atlas', filter: 'Loot Filter', notes: 'Notes', checklist: 'Checklist' };
export function newTimeline(stamp: LeagueStamp, title = 'Untitled timeline'): Timeline {
  return { schemaVersion: 1, title, stamp: structuredClone(stamp),
    lanes: (['build', 'atlas', 'filter', 'notes'] as const).map((type, order) => ({ laneId: parseId('lane', crypto.randomUUID()),
      type, title: laneLabels[type], order, muted: false, clipIds: [] })),
    clips: [], firstMapAnchor: null, editorMetadata: { previewLevel: 1, snap: true, showChunks: true }, credits: [] };
}
export function assertRange(range: Range): void {
  if (!Number.isInteger(range.start) || !Number.isInteger(range.endExclusive) || range.start < 1 ||
    range.endExclusive > 101 || range.start >= range.endExclusive) throw new Error('Choose a nonempty range within Levels 1-100.');
}
export const rangeLabel = (range: Range): string => `Levels ${range.start}-${range.endExclusive - 1}`;
export const overlaps = (a: Range, b: Range): boolean => a.start < b.endExclusive && b.start < a.endExclusive;
export function collisions(timeline: Timeline, clip: Clip): Clip[] {
  return timeline.clips.filter(other => other.clipId !== clip.clipId && other.laneId === clip.laneId && overlaps(other.range, clip.range));
}
export type PointRange = NonNullable<Clip['atlasPointRange']>;
export function assertPointRange(range: PointRange): void {
  if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.endExclusive) || range.start < 0 ||
    range.start >= range.endExclusive) throw new Error('Choose a nonempty Atlas point range.');
}
export const pointRangeLabel = (range: PointRange): string => `Atlas points ${range.start}-${range.endExclusive - 1}`;
export function excludedByCoverage(clip: Clip): ActionId[] {
  const points = clip.atlasPointRange;
  return clip.options.flatMap(option => option.actions.filter(action =>
    action.trigger.kind === 'level' && (action.trigger.level < clip.range.start || action.trigger.level >= clip.range.endExclusive) ||
    points !== undefined && (action.trigger.kind === 'atlasAllocated' && (action.trigger.points < points.start || action.trigger.points >= points.endExclusive) ||
      action.trigger.kind === 'firstMap' && points.start > 0)).map(action => action.actionId));
}
/** Inclusive point span of the pinned Atlas source (0 to its highest step target), used as the default sub-range. */
export function atlasSourceSpan(clip: Clip): { from: number; to: number } {
  const option = clip.options.find(row => row.optionId === clip.selectedOptionId) ?? clip.options[0];
  const snapshot = option?.source.fallbackSnapshot;
  const targets = snapshot?.kind === 'atlas' ? Object.values(snapshot.payload.stepsById).map(step => step.pointTarget) : [];
  const triggers = option?.actions.flatMap(action => action.trigger.kind === 'atlasAllocated' ? [action.trigger.points] : []) ?? [];
  return { from: 0, to: Math.max(0, ...targets, ...triggers) };
}
/** Applies inclusive UI numbers (Atlas points from/to); the full source span clears the sub-range. */
export function withAtlasPoints(clip: Clip, from: number, to: number): Clip {
  const span = atlasSourceSpan(clip);
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || from > to) throw new Error('Choose a nonempty Atlas point range.');
  return withAtlasPointRange(clip, from <= span.from && to >= span.to ? undefined : { start: from, endExclusive: to + 1 });
}
/** Sets (or, with undefined, clears) the Atlas point sub-range; the span of the pinned source is the default. Half-open. */
export function withAtlasPointRange(clip: Clip, range: PointRange | undefined): Clip {
  if (range) assertPointRange(range);
  const oldCoverage = new Set(excludedByCoverage(clip));
  const output = structuredClone(clip);
  if (range) output.atlasPointRange = { start: range.start, endExclusive: range.endExclusive }; else delete output.atlasPointRange;
  output.excludedActionIds = [...new Set([...clip.excludedActionIds.filter(id => !oldCoverage.has(id)), ...excludedByCoverage(output)])];
  return output;
}
/** Sets the clip's range and recomputes coverage exclusions. `previous` is the clip as it was before its triggers changed
 *  (a moved marker, scaled timing): only exclusions its coverage does not explain are the author's own and carry over. */
export function withCoverage(clip: Clip, range: Range, previous: Clip = clip): Clip {
  assertRange(range);
  const oldCoverage = new Set(excludedByCoverage(previous));
  const output = { ...structuredClone(clip), range: { ...range } };
  output.excludedActionIds = [...new Set([...clip.excludedActionIds.filter(id => !oldCoverage.has(id)), ...excludedByCoverage(output)])];
  return output;
}
export function nextFreeRange(timeline: Timeline, laneId: LaneId, range: Range, ignore?: ClipId): Range | null {
  assertRange(range);
  const width = range.endExclusive - range.start;
  const rows = timeline.clips.filter(clip => clip.laneId === laneId && clip.clipId !== ignore).sort((a, b) => a.range.start - b.range.start);
  let start = range.start;
  for (const clip of rows) if (overlaps({ start, endExclusive: start + width }, clip.range)) start = clip.range.endExclusive;
  return start + width <= 101 ? { start, endExclusive: start + width } : null;
}
/** `rename` gives the new id for actions whose id is known in advance (see copyClip); every other action id is namespaced by clip and option. */
export async function cloneClip(clip: Clip, clipId = parseId('clip', crypto.randomUUID()), laneId = clip.laneId, rename?: ReadonlyMap<ActionId, ActionId>): Promise<Clip> {
  const copy = structuredClone(clip), ids = new Map<ActionId, ActionId>();
  copy.clipId = clipId; copy.laneId = laneId;
  for (const option of copy.options) for (const action of option.actions) {
    const id = rename?.get(action.actionId) ?? parseId('action', `action:${await contentHash([clipId, option.optionId, action.actionId])}`);
    ids.set(action.actionId, id); action.actionId = id; action.clipId = clipId; action.laneId = laneId;
  }
  copy.instructionOverrides = copy.instructionOverrides.map(row => ({ ...row, actionId: ids.get(row.actionId)! }));
  copy.excludedActionIds = copy.excludedActionIds.map(id => ids.get(id)!);
  if (copy.keptActionIds) copy.keptActionIds = copy.keptActionIds.map(id => ids.get(id)!);
  return copy;
}
/** Puts a clip a source adapter just produced into a lane. Its action ids are already namespaced by clip and option, so they are kept:
 *  re-running cloneClip with the same clip id would namespace them a second time and break the match a later source update relies on. */
export function adoptClip(clip: Clip, laneId: Clip['laneId']): Clip {
  const copy = structuredClone(clip);
  copy.laneId = laneId;
  for (const option of copy.options) for (const action of option.actions) action.laneId = laneId;
  return copy;
}
/** Whether a timeline belongs in My timelines (true) or Old leagues / Archive (false). A timeline whose league is unknown (an
 *  imported fixture, a profile with no league picked) can never be called old, so it stays current. A timeline for a known
 *  league is current only while that same league is the active one. Reason text and evidence ids are never compared. */
export function inActiveLeague(league: LeagueStamp['leagueId'], active: LeagueStamp['leagueId'] | null): boolean {
  return !active || league.status !== 'known' || (active.status === 'known' && league.value === active.value);
}
/** Read-time migration. Every clip written by this build carries `disabled` (sourceClip sets false), so a clip
 *  without the field was saved by an older build. Those builds switched a clip off ("Enabled in Run") by excluding every one of
 *  its actions: such a clip (every action of every alternative excluded, not all of them explained by its range) reads as
 *  `disabled: true` with only its coverage exclusions kept; any other old clip reads as `disabled: false`. The next save
 *  persists it. A clip whose steps are all just outside its range is not "off" (Sol #129 case 1). */
export function migrateLegacyDisabled(timeline: Timeline): Timeline {
  if (timeline.clips.every(clip => clip.disabled !== undefined)) return timeline;
  return { ...timeline, clips: timeline.clips.map(clip => clip.disabled !== undefined ? clip
    : legacyOff(clip) ? { ...clip, disabled: true, excludedActionIds: excludedByCoverage(clip) } : { ...clip, disabled: false }) };
}
function legacyOff(clip: Clip): boolean {
  if (clip.disabled !== undefined) return false;
  const ids = clip.options.flatMap(option => option.actions.map(action => action.actionId)), excluded = new Set(clip.excludedActionIds);
  if (!ids.length || !ids.every(id => excluded.has(id))) return false;
  const covered = new Set(excludedByCoverage(clip));
  return ids.some(id => !covered.has(id));
}
export type CollisionChoice = 'replace_range' | 'next_free' | 'cancel';
export type Placement = { status: 'applied'; timeline: Timeline; excluded: ActionId[] }
  | { status: 'collision'; clips: Clip[] } | { status: 'cancelled' };
export async function placeClip(input: Timeline, inputClip: Clip, limits: ValidationLimits, choice?: CollisionChoice): Promise<Placement> {
  assertRange(inputClip.range);
  const timeline = structuredClone(input);
  let clip = structuredClone(inputClip);
  const lane = timeline.lanes.find(row => row.laneId === clip.laneId);
  if (!lane || clip.options.some(option => option.source.fallbackSnapshot.kind !== lane.type)) throw new Error('Choose a compatible lane for this source type.');
  if (choice === 'cancel') return { status: 'cancelled' };
  const hits = collisions(timeline, clip);
  if (hits.length && !choice) return { status: 'collision', clips: structuredClone(hits) };
  if (hits.length && choice === 'next_free') {
    const range = nextFreeRange(timeline, clip.laneId, clip.range, clip.clipId);
    if (!range) throw new Error('No free range fits this clip.');
    clip = withCoverage(clip, range);
  }
  const excluded: ActionId[] = [];
  if (hits.length && choice === 'replace_range') for (const hit of hits) {
    timeline.clips = timeline.clips.filter(row => row.clipId !== hit.clipId);
    const pieces: Range[] = [];
    if (hit.range.start < clip.range.start) pieces.push({ start: hit.range.start, endExclusive: clip.range.start });
    if (hit.range.endExclusive > clip.range.endExclusive) pieces.push({ start: clip.range.endExclusive, endExclusive: hit.range.endExclusive });
    if (!pieces.length) excluded.push(...hit.options.flatMap(option => option.actions.map(action => action.actionId)));
    for (const [i, range] of pieces.entries()) {
      const piece = withCoverage(i ? await copyClip(hit, limits) : hit, range);
      if (i) piece.excludedActionIds = [...new Set([...piece.excludedActionIds, ...piece.options.flatMap(option => option.actions.filter(action => action.trigger.kind !== 'level').map(action => action.actionId))])];
      excluded.push(...piece.excludedActionIds); timeline.clips.push(piece);
    }
  }
  timeline.clips = timeline.clips.filter(row => row.clipId !== clip.clipId);
  clip = withCoverage(clip, clip.range); timeline.clips.push(clip);
  for (const row of timeline.lanes) row.clipIds = timeline.clips.filter(clip => clip.laneId === row.laneId).sort((a, b) => a.range.start - b.range.start).map(clip => clip.clipId);
  return { status: 'applied', timeline: validated(timelineSchema, timeline, limits), excluded: [...new Set([...excluded, ...clip.excludedActionIds])] };
}

export type TimingChange = { actionId: ActionId; from: number; to: number };
export async function moveLevelMarker(clip: Clip, actionId: ActionId, level: number): Promise<Clip> {
  if (!Number.isInteger(level) || level < 1 || level > 100) throw new Error('Choose a trigger within Levels 1-100.');
  const output = structuredClone(clip), action = output.options.flatMap(option => option.actions).find(action => action.actionId === actionId);
  if (!action || action.trigger.kind !== 'level') throw new Error('Only authored Level markers can move on this ruler.');
  const requirement = action.requirements.find(requirement => requirement.kind === 'level' && level < requirement.minimum);
  if (requirement?.kind === 'level') throw new Error(`This action requires Level ${requirement.minimum}.`);
  if (action.requirements.some(requirement => requirement.kind === 'quest' || requirement.kind === 'areaLevel')) throw new Error('This marker has a hard quest or AreaLevel constraint.');
  action.trigger = { kind: 'level', level };
  action.contentHash = await contentHash({ trigger: action.trigger, instruction: action.instruction, requirements: action.requirements, critical: action.critical, stamp: action.stamp });
  return withCoverage(output, output.range, clip);
}
export async function previewResize(clip: Clip, range: Range, mode: Clip['timingMode']) {
  assertRange(range);
  const output = structuredClone(clip), changes: TimingChange[] = [];
  if (mode === 'scale_timing') {
    const oldSpan = Math.max(1, clip.range.endExclusive - clip.range.start - 1);
    const newSpan = Math.max(0, range.endExclusive - range.start - 1);
    for (const option of output.options) for (const action of option.actions) {
      if (action.trigger.kind !== 'level') continue;
      const from = action.trigger.level;
      const to = range.start + Math.round((from - clip.range.start) * newSpan / oldSpan);
      const levelRequirement = action.requirements.find(row => row.kind === 'level' && to < row.minimum);
      if (levelRequirement?.kind === 'level') return { ok: false as const, reason: `This action requires Level ${levelRequirement.minimum}.`, clip: structuredClone(clip), changes: [] };
      const semantic = action.requirements.find(row => row.kind === 'quest' || row.kind === 'areaLevel');
      if (to !== from && semantic) return { ok: false as const, reason: semantic.kind === 'quest' ? `This action requires quest ${semantic.questId}.`
        : `This action requires AreaLevel ${semantic.kind === 'areaLevel' ? semantic.minimum : ''}.`, clip: structuredClone(clip), changes: [] };
      if (to < 1 || to > 100) return { ok: false as const, reason: 'An authored action falls outside Levels 1-100.', clip: structuredClone(clip), changes: [] };
      if (to !== from) changes.push({ actionId: action.actionId, from, to });
      action.trigger = { kind: 'level', level: to };
      action.contentHash = await contentHash({ trigger: action.trigger, instruction: action.instruction, requirements: action.requirements, critical: action.critical, stamp: action.stamp });
    }
  }
  output.timingMode = mode;
  const resized = withCoverage(output, range, clip);
  return { ok: true as const, clip: resized, changes, excluded: excludedByCoverage(resized) };
}
export type Landmark = { level: number; label: string; approximate: boolean; trigger: string; evidenceId: string };
export function snapBoundary(raw: number, pixelsPerLevel: number, input: { enabled: boolean; alt: boolean; grid?: boolean; boundaries: number[]; landmarks: Landmark[] }): number {
  if (!Number.isFinite(raw) || !Number.isFinite(pixelsPerLevel) || pixelsPerLevel <= 0) throw new Error('The timeline position is invalid.');
  const clamped = Math.min(101, Math.max(1, raw));
  if (!input.enabled || input.alt) return Math.round(clamped);
  const authored = input.boundaries.map(level => ({ level, priority: 0 }));
  const grid = input.grid === false ? [] : [1, ...Array.from({ length: 20 }, (_, i) => (i + 1) * 5), 101].map(level => ({ level, priority: 2 }));
  const targets = [...authored, ...input.landmarks.map(row => ({ level: row.level, priority: 1 })), ...grid]
    .filter(row => row.level >= 1 && row.level <= 101 && Math.abs(row.level - clamped) * pixelsPerLevel <= 8)
    .sort((a, b) => Math.abs(a.level - clamped) - Math.abs(b.level - clamped) || a.priority - b.priority || a.level - b.level);
  return targets[0]?.level ?? Math.round(clamped);
}
export function removeClip(timeline: Timeline, id: ClipId): Timeline {
  const copy = structuredClone(timeline);
  return { ...copy, clips: copy.clips.filter(clip => clip.clipId !== id), lanes: copy.lanes.map(lane => ({ ...lane, clipIds: lane.clipIds.filter(clipId => clipId !== id) })) };
}
export function addLane(timeline: Timeline, type: LaneType): Timeline {
  const copy = structuredClone(timeline);
  return { ...copy, lanes: [...copy.lanes, { laneId: parseId('lane', crypto.randomUUID()), type, title: laneLabels[type], order: copy.lanes.length, muted: false, clipIds: [] }] };
}
export function removeLane(timeline: Timeline, id: LaneId): Timeline {
  const copy = structuredClone(timeline);
  return { ...copy, lanes: copy.lanes.filter(lane => lane.laneId !== id).map((lane, order) => ({ ...lane, order })), clips: copy.clips.filter(clip => clip.laneId !== id) };
}
export function reorderLane(timeline: Timeline, id: LaneId, order: number): Timeline {
  const copy = structuredClone(timeline), lanes = copy.lanes.sort((a, b) => a.order - b.order), index = lanes.findIndex(lane => lane.laneId === id);
  if (index < 0 || !Number.isInteger(order) || order < 0 || order >= lanes.length) throw new Error('Choose an available lane position.');
  const [lane] = lanes.splice(index, 1); lanes.splice(order, 0, lane!);
  return { ...copy, lanes: lanes.map((lane, order) => ({ ...lane, order })) };
}
