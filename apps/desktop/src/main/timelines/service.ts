import { randomUUID } from 'node:crypto';
import { parseId, timelineSchema, timelineBundleSchema, type DocumentEnvelope, type FrozenSource, type LaneId,
  type LeagueStamp, type ObjectId, type RevisionId, type Timeline, type TimelineBundle, type ValidationLimits, type WriteDocumentRequest } from '@pom/mastery-contracts';
import type { DocumentStore } from '../documents/store.js';
import { canonicalJson, validated, verifySource } from '../../shared/timelines/adapters/common.js';
import { flattenTimeline, type FlattenRequest } from '../../shared/timelines/adapters/flatten.js';
import { exportTimelineFile, importTimelineFile, prepareTimelineShare } from '../../shared/timelines/formats.js';
import { SCHEDULER_VERSION } from '../../shared/timelines/scheduler/index.js';
import { embeddedDependencies, migrateLegacyDisabled, newTimeline, placeClip, preflightRun, sourceClip, type CollisionChoice, type PreflightContext, type Range } from '../../shared/timelines/editor/index.js';

export type TimelineDocuments = Pick<DocumentStore, 'write' | 'read' | 'readRevision' | 'list' | 'revisionRef' | 'undo' | 'redo' | 'trash' | 'restoreTrash'>;
export type TimelineServiceOptions = {
  limits: ValidationLimits; activeStamp(): LeagueStamp;
  registerObject(objectId: ObjectId, stamp: LeagueStamp): Promise<void>;
  flushSource(source: FrozenSource): Promise<FrozenSource>;
  runContext(timeline: Timeline): Promise<Omit<PreflightContext, 'limits' | 'omittedClipIds'>>;
  startRun(input: Extract<Awaited<ReturnType<typeof preflightRun>>, { ready: true }> & { revision: import('@pom/mastery-contracts').RevisionRef; replaceCurrent: boolean }): Promise<unknown>;
};
export class TimelineService {
  constructor(private readonly documents: TimelineDocuments, private readonly options: TimelineServiceOptions) {}
  async read(id: ObjectId, revisionId?: RevisionId): Promise<DocumentEnvelope<Timeline>> {
    const document = revisionId ? await this.documents.readRevision<Timeline>(id, revisionId) : await this.documents.read<Timeline>(id);
    if (document.kind !== 'timeline') throw new Error('Open this object in its own area.');
    // Clips switched off by older builds (every action excluded) read as disabled: true; the next save persists it.
    return { ...document, payload: migrateLegacyDisabled(validated(timelineSchema, document.payload, this.options.limits)) };
  }
  async list(includeTrash = false) {
    return Promise.all(this.documents.list(includeTrash).filter(row => row.kind === 'timeline').map(async row => ({ ...(await this.read(row.objectId, row.revisionId)), trashedAt: row.trashedAt })));
  }
  async save(request: WriteDocumentRequest<Timeline>, label: string) {
    const existing = request.expectedRevisionId !== null ? await this.read(request.objectId) : null;
    const payload = validated(timelineSchema, request.payload, this.options.limits);
    if (canonicalJson(payload.stamp) !== canonicalJson(request.stamp) || existing && canonicalJson(existing.payload.stamp) !== canonicalJson(payload.stamp)) throw new Error('This edit cannot change the Timeline league stamp. Create a copy instead.');
    const result = await this.documents.write('timeline', { ...request, payload }, { label });
    await this.options.registerObject(request.objectId, request.stamp);
    return result;
  }
  async create(title = 'Untitled timeline', idempotencyKey: string = randomUUID(), objectId = parseId('object', randomUUID())) {
    const stamp = this.options.activeStamp();
    return this.save({ objectId, expectedRevisionId: null, payload: newTimeline(stamp, title), stamp, idempotencyKey }, 'New timeline');
  }
  async send(input: { objectId: ObjectId; expectedRevisionId: RevisionId; source: FrozenSource; laneId: LaneId; range?: Range; choice?: CollisionChoice; idempotencyKey: string }) {
    const document = await this.read(input.objectId);
    if (document.revision.revisionId !== input.expectedRevisionId) throw new Error('Timeline changed. Review the updated placement.');
    const source = await verifySource(await this.options.flushSource(structuredClone(input.source)), this.options.limits);
    const clip = await sourceClip(source, input.laneId, this.options.limits, { range: input.range, anchorId: document.payload.firstMapAnchor?.anchorId ?? 'first-map' });
    const timeline = structuredClone(document.payload);
    if (source.fallbackSnapshot.kind === 'atlas' && !timeline.firstMapAnchor) timeline.firstMapAnchor = { anchorId: 'first-map', evidence: { status: 'unknown', reason: 'Declare At maps manually or use a verified route event.' } };
    const placement = await placeClip(timeline, clip, this.options.limits, input.choice);
    if (placement.status !== 'applied') return placement;
    const saved = await this.save({ objectId: input.objectId, expectedRevisionId: input.expectedRevisionId, payload: placement.timeline, stamp: document.payload.stamp, idempotencyKey: input.idempotencyKey }, 'Add clip');
    return { ...placement, saved };
  }
  async addLanes(objectId: ObjectId, expectedRevisionId: RevisionId, request: Omit<FlattenRequest, 'limits' | 'ancestry'>, idempotencyKey: string) {
    const document = await this.read(objectId);
    if (document.revision.revisionId !== expectedRevisionId) throw new Error('Timeline changed. Review the updated placement.');
    if (request.sourceRevision.objectId === objectId) throw new Error('A Timeline cannot insert itself.');
    const result = await flattenTimeline({ ...request, ancestry: [this.documents.revisionRef(objectId, expectedRevisionId)], limits: this.options.limits });
    const timeline: Timeline = { ...document.payload, lanes: [...document.payload.lanes, ...result.lanes.map((lane, index) => ({ ...lane, order: document.payload.lanes.length + index }))],
      clips: [...document.payload.clips, ...result.clips], credits: [...document.payload.credits, ...result.credits], firstMapAnchor: document.payload.firstMapAnchor ?? result.firstMapAnchor };
    return this.save({ objectId, expectedRevisionId, payload: timeline, stamp: timeline.stamp, idempotencyKey }, 'Add lanes');
  }
  async bundle(objectId: ObjectId, revisionId?: RevisionId): Promise<TimelineBundle> {
    const document = await this.read(objectId, revisionId), timeline = document.payload;
    const context = await this.options.runContext(timeline);
    return validated(timelineBundleSchema, { schemaVersion: 1, bundleId: parseId('bundle', randomUUID()), timeline,
      dependencies: await embeddedDependencies(timeline, this.options.limits, context.dependencies), assets: [], schedulerVersion: SCHEDULER_VERSION, actionSchemaVersion: 1,
      choices: timeline.clips.map(clip => { if (!clip.selectedOptionId) throw new Error('Choose one alternative before exporting.'); return { clipId: clip.clipId, optionId: clip.selectedOptionId }; }), credits: timeline.credits }, this.options.limits);
  }
  async exportFile(objectId: ObjectId) { return exportTimelineFile({ bundle: await this.bundle(objectId) }, this.options.limits); }
  async share(objectId: ObjectId) { return prepareTimelineShare({ bundle: await this.bundle(objectId) }, this.options.limits); }
  async importFile(text: string, idempotencyKey: string, objectId = parseId('object', randomUUID())) {
    const { bundle } = importTimelineFile(text, this.options.limits);
    for (const dependency of bundle.dependencies) await verifySource({ ref: dependency.ref, fallbackSnapshot: dependency.snapshot }, this.options.limits);
    return this.save({ objectId, expectedRevisionId: null, payload: migrateLegacyDisabled(bundle.timeline), stamp: bundle.timeline.stamp, idempotencyKey }, 'Import timeline');
  }
  async run(objectId: ObjectId, expectedRevisionId: RevisionId, input: { omittedClipIds?: import('@pom/mastery-contracts').ClipId[]; start?: PreflightContext['start']; replaceCurrent?: boolean } = {}) {
    const document = await this.read(objectId);
    if (document.revision.revisionId !== expectedRevisionId) throw new Error('Timeline changed. Review the updated run.');
    const context = await this.options.runContext(document.payload);
    const prepared = await preflightRun(document.payload, { ...context, limits: this.options.limits, omittedClipIds: input.omittedClipIds,
      start: input.start?.manual ? { ...context.start, observation: undefined, manual: input.start.manual } : context.start,
      competingRun: context.competingRun && !input.replaceCurrent });
    if (!prepared.ready) return prepared;
    const current = await this.read(objectId);
    if (current.revision.revisionId !== expectedRevisionId) throw new Error('Timeline changed. Review the updated run.');
    return this.options.startRun({ ...prepared, revision: this.documents.revisionRef(objectId, expectedRevisionId), replaceCurrent: input.replaceCurrent === true });
  }
  async undo(objectId: ObjectId, expectedRevisionId: RevisionId) { await this.read(objectId); return this.documents.undo(objectId, expectedRevisionId); }
  async redo(objectId: ObjectId, expectedRevisionId: RevisionId) { await this.read(objectId); return this.documents.redo(objectId, expectedRevisionId); }
  async trash(objectId: ObjectId, expectedRevisionId: RevisionId) { await this.read(objectId); return this.documents.trash(objectId, expectedRevisionId); }
  async restoreTrash(objectId: ObjectId) {
    const row = this.documents.list(true).find(row => row.objectId === objectId);
    if (!row || row.kind !== 'timeline') throw new Error('Open this object in its own area.');
    return this.documents.restoreTrash(objectId);
  }
}
