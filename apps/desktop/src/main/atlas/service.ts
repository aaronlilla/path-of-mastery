import { atlasPlanSchema, parseId, writeDocumentRequestSchema, type AtlasPlan, type DatasetRef, type DocumentEnvelope,
  type LeagueStamp, type ObjectId, type RevisionId, type StepId, type ValidationLimits, type WriteDocumentRequest } from '@pom/mastery-contracts';
import { DocumentStore } from '../documents/store.js';
import { AtlasRegistry, type AtlasCatalogView } from './registry.js';
import { AtlasDomainError, ordered } from '../../shared/atlas/graph.js';
import { previewAllocation, previewRemoval } from '../../shared/atlas/allocation.js';
import { createPlan, inspectStep, validatePlan } from '../../shared/atlas/plan.js';
import { canonicalJson } from '../kb/sources/atlas.js';

export const ATLAS_DOCUMENT_SCHEMA = atlasPlanSchema;
export type AtlasDocumentView = { document: DocumentEnvelope<AtlasPlan>; data: AtlasCatalogView | null;
  warnings: string[]; steps: Record<string, ReturnType<typeof inspectStep>> };

export class AtlasService {
  constructor(readonly documents: DocumentStore, readonly registry: AtlasRegistry, private readonly limits: ValidationLimits) {}

  async create(input: { dataset: DatasetRef; stamp: LeagueStamp; budget: number; title?: string; idempotencyKey: string; objectId: ObjectId }) {
    const plan = createPlan(input.dataset, input.stamp, parseId('step', `step:${input.objectId}`), input.budget, input.title);
    return this.save({ objectId: input.objectId, expectedRevisionId: null, payload: plan, stamp: input.stamp, idempotencyKey: input.idempotencyKey }, 'Created plan');
  }

  async save(input: WriteDocumentRequest<AtlasPlan>, label = 'Edited plan') {
    const parsed = writeDocumentRequestSchema(atlasPlanSchema).parse(input, this.limits);
    if (!parsed.ok) throw new AtlasDomainError('INVALID', 'Atlas save request is invalid.');
    const request = structuredClone(parsed.value), plan = validatePlan(request.payload, this.limits);
    if (canonicalJson(request.stamp) !== canonicalJson(plan.stamp)) throw new AtlasDomainError('INVALID', 'Plan and revision stamps must match.');
    const data = this.registry.get(plan.dataset);
    for (const step of Object.values(plan.stepsById)) step.repair = inspectStep(data.graph, step, data.catalogs).repair;
    request.payload = plan;
    // Keep every referenced pack before a revision can become durable. Retention never prunes history.
    await this.registry.retain(`document:${request.objectId}`, [plan.dataset]);
    return this.documents.write('atlas', request, { label });
  }

  async read(objectId: ObjectId, revisionId?: RevisionId): Promise<AtlasDocumentView> {
    const document = revisionId ? await this.documents.readRevision<AtlasPlan>(objectId, revisionId) : await this.documents.read<AtlasPlan>(objectId);
    if (document.kind !== 'atlas') throw new AtlasDomainError('INVALID', 'Document is not an Atlas plan.');
    const plan = validatePlan(document.payload, this.limits);
    const steps: AtlasDocumentView['steps'] = Object.create(null) as AtlasDocumentView['steps'];
    let data: AtlasCatalogView;
    try { data = this.registry.get(plan.dataset); }
    catch (error) {
      if (!(error instanceof AtlasDomainError) || error.code !== 'NOT_FOUND') throw error;
      return { document, data: null, steps, warnings: [error.message] };
    }
    for (const step of Object.values(plan.stepsById)) steps[step.stepId] = inspectStep(data.graph, step, data.catalogs);
    return { document, data, steps, warnings: [
      ...(data.liveCompatibility.status === 'unknown' ? [data.statusText] : []),
      ...Object.values(steps).flatMap(step => [
        ...(step.repair.missingIds.length ? [`Missing ${step.repair.missingIds.length} node IDs.`] : []),
        ...(step.repair.disconnectedIds.length ? ['Allocated nodes need a connected path.'] : []),
        ...(step.overBudget.status === 'known' && step.overBudget.value > 0 ? [`${step.overBudget.value} points over your budget.`] : []),
        ...(step.unverifiedEffectIds.length ? ['Effect selections are unverified.'] : []),
        ...(step.missingMapIds.length || step.missingScarabIds.length ? ['Some practical rows are unavailable in this catalog.'] : []),
      ]),
    ] };
  }

  list() { return this.documents.list().filter(row => row.kind === 'atlas'); }

  async allocate(input: { objectId: ObjectId; expectedRevisionId: RevisionId; stepId: StepId; nodeId: string; idempotencyKey: string }) {
    const view = await this.read(input.objectId, input.expectedRevisionId), plan = structuredClone(view.document.payload), step = plan.stepsById[input.stepId];
    if (!step || !view.data) throw new AtlasDomainError('NOT_FOUND', 'Step tree data is unavailable.');
    const preview = previewAllocation(view.data.graph, step.allocatedIds, input.nodeId, step.pointBudget);
    step.allocatedIds = preview.allocatedIds; step.repair = preview.repair;
    const saved = await this.save({ objectId: input.objectId, expectedRevisionId: input.expectedRevisionId, payload: plan,
      stamp: plan.stamp, idempotencyKey: input.idempotencyKey }, `Allocated ${preview.addedIds.length} nodes`);
    return { saved, preview };
  }

  async unallocate(input: { objectId: ObjectId; expectedRevisionId: RevisionId; stepId: StepId; nodeId: string;
    idempotencyKey: string; confirmedRemovedIds?: string[] }) {
    const view = await this.read(input.objectId, input.expectedRevisionId), plan = structuredClone(view.document.payload), step = plan.stepsById[input.stepId];
    if (!step || !view.data) throw new AtlasDomainError('NOT_FOUND', 'Step tree data is unavailable.');
    const preview = previewRemoval(view.data.graph, step.allocatedIds, input.nodeId);
    if (preview.cascadeIds.length && canonicalJson(ordered(input.confirmedRemovedIds ?? [])) !== canonicalJson(preview.removedIds)) {
      return { needsConfirmation: true as const, preview };
    }
    step.allocatedIds = preview.allocatedIds; step.repair = preview.repair;
    const saved = await this.save({ objectId: input.objectId, expectedRevisionId: input.expectedRevisionId, payload: plan,
      stamp: plan.stamp, idempotencyKey: input.idempotencyKey }, `Removed ${preview.removedIds.length} nodes`);
    return { needsConfirmation: false as const, saved, preview };
  }
}
