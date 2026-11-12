import { localBuildSourceSchema, type AtlasPlan, type BuildSnapshot, type FilterSnapshot, type FrozenSource, type LocalBuildSource,
  type ObjectId, type ObjectKind, type RevisionRef, type ValidationLimits } from '@pom/mastery-contracts';
import type { DocumentStore } from '../documents/store.js';
import { adaptAtlas, adaptBuild, adaptFilter, pinSource, projectFilter, projectGuide, validated,
  type AdapterContext, type SourceIdentity } from '../../shared/timelines/adapters/index.js';
import { planStages, type Stage } from '../../shared/lootfilter/stages.js';
import type { FilterDoc } from '../../shared/lootfilter/types.js';
import type { LevelingPlan } from '../../shared/leveling/types.js';
import { generateGuide, type GuideKit } from '../leveling/guideFor.js';

export type FreezeBuildRequest = {
  identity: SourceIdentity;
  buildXml: string;
  publicSnapshot: Omit<BuildSnapshot, 'guide'>;
  settings: LocalBuildSource['settings'];
  dataReferences: RevisionRef[];
  levelingSkill?: string;
  leagueStart: boolean;
  context: AdapterContext;
};
export async function freezeBuildSource(kit: GuideKit, request: FreezeBuildRequest) {
  const input = structuredClone(request);
  const generated = await generateGuide(kit, input.buildXml, input.levelingSkill, input.leagueStart);
  const guide = await projectGuide(generated, input.publicSnapshot.stamp);
  const publicSnapshot: BuildSnapshot = { ...input.publicSnapshot, guide };
  const localBuild = validated(localBuildSourceSchema, { schemaVersion: 1, stamp: publicSnapshot.stamp,
    buildXml: input.buildXml, guide, settings: input.settings, dataReferences: input.dataReferences,
    publicSnapshot }, input.context.limits);
  const source = await pinSource(input.identity, { kind: 'build', payload: publicSnapshot }, input.context.limits);
  const actions = await adaptBuild(source, input.context);
  return { source, localBuild, actions, generatedGuide: structuredClone(generated.guide) };
}
export async function freezeAtlasSource(identity: SourceIdentity, plan: AtlasPlan, context: AdapterContext,
  anchorId: string, choices: Parameters<typeof adaptAtlas>[3] = {}) {
  const input = structuredClone({ identity, plan, context, choices });
  const source = await pinSource(input.identity, { kind: 'atlas', payload: input.plan }, input.context.limits);
  return { source, actions: await adaptAtlas(source, input.context, anchorId, input.choices) };
}
export async function freezeFilterSource(identity: SourceIdentity, doc: FilterDoc, context: AdapterContext,
  input: { plan: LevelingPlan | null; stages?: readonly Stage[]; capabilities: FilterSnapshot['capabilities'] }) {
  const frozen = structuredClone({ identity, doc, context, input });
  const stages = frozen.input.stages ?? planStages(frozen.input.plan, frozen.doc.setup.build?.bounds);
  const source = await pinSource(frozen.identity, { kind: 'filter', payload: projectFilter(frozen.doc, stages, frozen.identity.stamp, frozen.input.capabilities) }, frozen.context.limits);
  return { source, actions: await adaptFilter(source, frozen.context), document: frozen.doc };
}
export const SOURCE_KINDS: readonly ObjectKind[] = ['build', 'atlas', 'filter', 'notes', 'checklist'];
/**
 * A Documents-store object as a Timeline source. The store's own RevisionRef hashes the stored file; a Timeline source is verified against the
 * canonical content hash of its snapshot (verifySource), so the source is pinned with that hash here. Pinning the store's ref instead makes every
 * Add to lane fail with "The saved source hash does not match its payload."
 */
export async function documentSource(documents: Pick<DocumentStore, 'read'>, objectId: ObjectId, limits: ValidationLimits): Promise<FrozenSource> {
  const doc = await documents.read<FrozenSource['fallbackSnapshot']['payload']>(objectId);
  if (!SOURCE_KINDS.includes(doc.kind)) throw new Error('This object is not a timeline source.');
  const snapshot = { kind: doc.kind, payload: doc.payload } as FrozenSource['fallbackSnapshot'];
  return pinSource({ objectId, revisionId: doc.revision.revisionId, payloadHash: doc.revision.payloadHash, stamp: doc.revision.stamp }, snapshot, limits);
}
export const filterFileCapabilities: FilterSnapshot['capabilities'] = { exportFile: true, installFile: true, automaticSelection: false };
export type TimelineSourcePolicy = ValidationLimits;
