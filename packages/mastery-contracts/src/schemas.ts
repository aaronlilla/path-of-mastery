import * as v from './validation.js';
import { check } from './validation.js';
import { isSafeHttpsUrl } from './links.js';
import { isId, type Id, type IdentityKind, type Known, type LeagueStamp, type PublishedRevisionRef, type Revision, type RevisionRef, type SourceCredit } from './stamp.js';
import type { AssetRef, AtlasDataset, AtlasNode, AtlasPlan, AtlasProposal, AtlasStat, AtlasStep, CatalogEntry, DatasetRef, Instructions, OptimizerPreferences, PracticalRow, PriceObservation, Provenance, SequencePosition, SolverProof, Sourced, TargetDecision } from './atlas.js';
import type { Action, BuildSnapshot, ChunkOverride, Clip, ClipOption, EmbeddedDependency, FilterSnapshot, FrozenSource, Lane, LocalBuildSource, Requirement, SourceSnapshot, TextSnapshot, Timeline, TimelineBundle, Trigger } from './timeline.js';
import type { CompletionReceipt, LocalFinishRecord, ObservedProgress, RunSettingsSnapshot, RunSnapshot, RunState, ScheduledBundle } from './run.js';
import type { AiAuthorizationRequest, ApiFailure, ApiResult, EntitlementDecision, NetworkClearance, PairedClient, PendingIntent } from './gate.js';
import { BUDGET_BANDS } from './marketplace.js';
import type { Collection, FeedRequest, FeedbackRequest, ListingMetadata, MarketplacePost, PublicDocument, PublicHistoryEntry, PublicInline, PublicItemPayload, PublicRichText, PublicTextBlock, PublishRequest, ReportRequest, ResolvePublicItemRequest, SavedItem, VoteRequest } from './marketplace.js';
import type { CopyProvenance, DocumentEnvelope, EditCommand, EditTransaction, ObjectKind, RevisionCheckpoint, ScopeKey, WorkspaceManifest, WriteDocumentRequest, WriteDocumentResponse } from './document.js';

const { object: o, array: a, record: r, nullable: n, optional: opt, enumeration: e, tagged: t, refine: refine, unique, version, boolean: b, text } = v;
const s = v.string();
const uint = v.number(0, Number.MAX_SAFE_INTEGER, true);
const positive = v.number(1, Number.MAX_SAFE_INTEGER, true);
const level = v.number(1, 100, true);
const num = v.number();
const timestamp = refine(s, (value, path) => {
  check(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(value) && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value.replace(/Z$/, value.includes('.') ? 'Z' : '.000Z'), path, 'Expected a valid UTC timestamp.');
});
function id<K extends IdentityKind>(kind: K): v.Node<Id<K>> {
  return { read(value, path) { check(isId(kind, value), path, 'Invalid identity codec.'); return value; } };
}
const hash = id('hash');
export function knownNode<T>(value: v.Node<T>): v.Node<Known<T>> {
  return t('status', {
    known: o({ status: e('known'), value, evidenceId: s }),
    unknown: o({ status: e('unknown'), reason: s }),
  });
}
const ks = knownNode(s);
const kn = knownNode(num);
const ku = knownNode(uint);
const modeNode = o({ economy: e('trade', 'ssf'), hardcore: b, ruthless: b });
export const leagueStampNode: v.Node<LeagueStamp> = o({ leagueId: ks, realm: ks, mode: knownNode(modeNode), patchVersion: ks, datasetVersion: ks, createdAt: timestamp });
export const revisionRefNode: v.Node<RevisionRef> = o({ objectId: id('object'), revisionId: id('revision'), payloadHash: hash, stamp: leagueStampNode, fallbackSnapshotHash: hash });
const revisionNode: v.Node<Revision> = o({ revisionId: id('revision'), parentRevisionId: n(id('revision')), schemaVersion: version, payloadHash: hash, stamp: leagueStampNode });
export const publishedRevisionRefNode: v.Node<PublishedRevisionRef> = o({ postId: id('post'), revisionId: id('revision'), displayRevision: positive as v.Node<PublishedRevisionRef['displayRevision']> });
const creditNode: v.Node<SourceCredit> = o({ source: revisionRefNode, origin: n(publishedRevisionRefNode), creatorName: s, title: s, status: e('available', 'original_removed') });
const instructionsNode: v.Node<Instructions> = o({ firstAction: v.string(160, false), details: v.string(10000, false), whenReady: text });
const provenanceNode: v.Node<Provenance> = o({ sourceId: s, sourceHash: hash, field: s, fetchedAt: timestamp });
const assetNode: v.Node<AssetRef> = o({ assetId: s, contentHash: hash, mediaType: e('image/png', 'image/webp', 'image/jpeg') });
const datasetRefNode: v.Node<DatasetRef> = o({ datasetId: s, contentHash: hash, variant: s, stamp: leagueStampNode });
const statNode: v.Node<AtlasStat> = o({ statId: s, sourceText: s, aggregation: e('additive', 'conditional', 'nonadditive'), value: kn, unit: ks, effectSchemaHash: hash, provenance: a(provenanceNode) });
const atlasNode: v.Node<AtlasNode> = o({ nodeId: s, name: s, adjacentIds: a(s), stats: a(statNode), asset: n(assetNode) });
const catalogNode: v.Node<CatalogEntry> = o({ catalogId: s, name: s, asset: n(assetNode), provenance: a(provenanceNode) });
const sourcedStringNode: v.Node<Sourced<string>> = o({ data: ks, provenance: a(provenanceNode) });
const atlasDatasetNode: v.Node<AtlasDataset> = refine(o<AtlasDataset>({
  schemaVersion: version, ref: datasetRefNode, exportTag: ks, exportCommit: ks, exportFileHashes: r(hash), gamePatch: ks,
  cdnPatchId: ks, schemaHash: hash, schemaCommit: ks, parserVersion: s, normalizerVersion: s, verificationReportHash: hash,
  compatibility: knownNode(e('verified')), fieldProvenance: r(sourcedStringNode),
  graph: o({ graphHash: hash, rootId: s, nodes: a(atlasNode, 1) }), assets: a(assetNode),
  catalogs: o({ maps: a(catalogNode), scarabs: a(catalogNode) }),
  taxonomy: o({ revision: s, contentHash: hash, targets: a(o({ targetId: s, nodeIds: a(s), verified: knownNode(b) })) }),
  costModel: o({ revision: s, contentHash: hash, nodeCosts: r(v.number(0)), maximumPoints: ku, grantedPoints: ku, provenance: a(provenanceNode) }),
}), (dataset, path) => {
  const nodeIds = dataset.graph.nodes.map(node => node.nodeId);
  unique(nodeIds, path);
  const ids = new Set(nodeIds);
  check(ids.has(dataset.graph.rootId), path, 'Graph root is missing.');
  check(dataset.graph.nodes.every(node => node.adjacentIds.every(adjacent => ids.has(adjacent))), path, 'Graph adjacency references an unknown node.');
  check(nodeIds.every(nodeId => Object.hasOwn(dataset.costModel.nodeCosts, nodeId)), path, 'Node cost metadata is missing.');
});
const priceNode: v.Node<PriceObservation> = o({ amount: v.number(0), currencyId: s, observedAt: timestamp, provenance: a(provenanceNode) });
const practicalNode: v.Node<PracticalRow> = o<PracticalRow>({ catalogId: s, quantity: uint, provenance: a(provenanceNode), price: knownNode(priceNode), tier: opt(positive), purpose: opt(text) });
const stepNode: v.Node<AtlasStep> = refine(o<AtlasStep>({
  stepId: id('step'), title: s, allocatedIds: a(s), effectSelections: r(s), pointBudget: uint, pointTarget: uint,
  maps: a(practicalNode), favouriteMaps: a(practicalNode), scarabs: a(practicalNode), strategy: text, instructions: instructionsNode,
  repair: o({ missingIds: a(s), disconnectedIds: a(s) }),
}), (step, path) => unique(step.allocatedIds, path));
const positionNode: v.Node<SequencePosition> = t('kind', {
  step: o({ kind: e('step'), positionId: s, stepId: id('step') }),
  alternatives: refine(o({ kind: e('alternatives'), positionId: s, alternativeGroupId: s, optionStepIds: a(id('step'), 1), defaultStepId: id('step') }), (group, path) => {
    unique(group.optionStepIds, path);
    check(group.optionStepIds.includes(group.defaultStepId), path, 'Alternative default must identify one option.');
  }),
});
const optimizerNode: v.Node<OptimizerPreferences> = o({ targetIds: a(s), avoidNodeIds: a(s), retainCurrent: b, budget: uint });
export const atlasPlanNode: v.Node<AtlasPlan> = refine(o<AtlasPlan>({
  schemaVersion: version, title: s, stamp: leagueStampNode, dataset: datasetRefNode, strategy: text, instructions: instructionsNode,
  stepsById: r(stepNode), sequencePositions: a(positionNode, 1), optimizerPreferences: optimizerNode, credits: a(creditNode), notes: opt(text),
}), (plan, path) => {
  check(Object.keys(plan.stepsById).length > 0, path, 'An Atlas plan requires a step.');
  unique(plan.sequencePositions.map(position => position.positionId), path);
  for (const [key, step] of Object.entries(plan.stepsById)) check(key === step.stepId, path, 'Step record key does not match its ID.');
  const sequenceIds = plan.sequencePositions.flatMap(position => position.kind === 'step' ? [position.stepId] : position.optionStepIds);
  check(sequenceIds.every(stepId => Object.hasOwn(plan.stepsById, stepId)), path, 'Sequence references a missing step.');
});
const proofNode: v.Node<SolverProof> = t('kind', {
  exact: o({ kind: e('exact'), inputHash: hash, graphHash: hash, costModelHash: hash, variant: s, minimumCost: v.number(0), certificateHash: hash }),
  best_found: o({ kind: e('best_found'), inputHash: hash, upperBound: v.number(0), elapsedMs: v.number(0) }),
  unavailable: o({ kind: e('unavailable'), reason: e('unknown_target', 'unreachable_target', 'unverified_taxonomy') }),
});
const decisionNode: v.Node<TargetDecision> = o({ targetId: s, priority: positive, status: e('accepted', 'skipped_proven', 'fit_not_proven', 'unavailable'), acceptedBasisIds: a(s), cost: knownNode(v.number(0)), shortfall: knownNode(v.number(0)) });
const proposalNode: v.Node<AtlasProposal> = refine(o<AtlasProposal>({
  schemaVersion: version, baseRevision: revisionRefNode, sourceHash: hash, graphHash: hash, costModelHash: hash, taxonomyHash: hash,
  inputHash: hash, solverVersion: s, variant: s, candidate: stepNode, addedIds: a(s), removedIds: a(s), cost: v.number(0),
  targetDecisions: a(decisionNode), provenance: e('Rule', 'Optimizer', 'AI'), proof: proofNode,
}), (proposal, path) => {
  if (proposal.proof.kind !== 'unavailable') check(proposal.proof.inputHash === proposal.inputHash, path, 'Proof is bound to a different input.');
  if (proposal.proof.kind === 'exact') check(proposal.proof.graphHash === proposal.graphHash && proposal.proof.costModelHash === proposal.costModelHash && proposal.proof.minimumCost === proposal.cost && proposal.proof.variant === proposal.variant, path, 'Exact proof does not match the candidate metadata.');
});
export const triggerNode: v.Node<Trigger> = t('kind', {
  level: o({ kind: e('level'), level }),
  areaLevel: o({ kind: e('areaLevel'), areaId: opt(s), level: uint }),
  zone: o({ kind: e('zone'), zoneId: s }),
  quest: o({ kind: e('quest'), questId: s, evidenceRequired: s }),
  firstMap: o({ kind: e('firstMap'), anchorId: s }),
  atlasAllocated: o({ kind: e('atlasAllocated'), stepId: id('step'), points: uint }),
  manual: o({ kind: e('manual'), sequenceId: s, ordinal: uint }),
});
const requirementNode: v.Node<Requirement> = t('kind', {
  level: o({ kind: e('level'), minimum: level, provenance: s }),
  quest: o({ kind: e('quest'), questId: s, evidenceRequired: s }),
  areaLevel: o({ kind: e('areaLevel'), minimum: uint, provenance: s }),
  atlasAllocated: o({ kind: e('atlasAllocated'), minimum: uint, provenance: s }),
});
const actionNode: v.Node<Action> = o({
  schemaVersion: version, actionId: id('action'), contentHash: hash, sourceRevision: revisionRefNode,
  laneId: id('lane'), clipId: id('clip'), optionId: id('option'), trigger: triggerNode, requirements: a(requirementNode),
  critical: b, instruction: instructionsNode, stamp: leagueStampNode,
});
const primitiveNode: v.Node<string | number | boolean> = { read(value, path) {
  check(typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)), path, 'Expected a text, number or boolean setting.');
  return value;
} };
const buildNode: v.Node<BuildSnapshot> = o<BuildSnapshot>({
  schemaVersion: version, title: s, stamp: leagueStampNode, treeNodes: a(s),
  skills: a(o({ skillId: s, name: s, level: ku, asset: n(assetNode) })),
  gear: a(o({ slotId: s, itemId: s, name: s, modifiers: a(s), asset: n(assetNode) })),
  configuration: a(o({ settingId: s, value: primitiveNode })),
  guide: a(o({ actionId: id('action'), contentHash: hash, trigger: triggerNode, requirements: a(requirementNode), instruction: instructionsNode })),
  calculatedStats: knownNode(o({ engineVersion: s, sourceHash: hash, assumptions: a(s), values: a(o({ statId: s, value: num, unit: s })) })),
  notes: opt(text),
  buildCode: opt(refine(s, (code, path) => check(/^[A-Za-z0-9_=+/-]+$/.test(code), path, 'A build code uses only base64 letters.'))),
  className: opt(v.string(40)), ascendancy: opt(v.string(40)),
});
const localBuildNode: v.Node<LocalBuildSource> = o({ schemaVersion: version, stamp: leagueStampNode, buildXml: s,
  guide: a(o({ actionId: id('action'), contentHash: hash, trigger: triggerNode, requirements: a(requirementNode), instruction: instructionsNode })),
  settings: o({ stamp: leagueStampNode, configuration: a(o({ settingId: s, value: primitiveNode })) }),
  dataReferences: a(revisionRefNode), publicSnapshot: buildNode,
});
const areaRangeNode = refine(o({ start: uint, endExclusive: uint }), (range, path) => check(range.start < range.endExclusive, path, 'AreaLevel range must be nonempty.'));
const filterNode: v.Node<FilterSnapshot> = o<FilterSnapshot>({ schemaVersion: version, title: s, stamp: leagueStampNode,
  stages: a(o({ stageId: s, areaLevel: areaRangeNode, rules: a(s), instruction: instructionsNode })),
  capabilities: o({ exportFile: b, installFile: b, automaticSelection: b }), notes: opt(text),
});
const textSnapshotNode: v.Node<TextSnapshot> = o<TextSnapshot>({ schemaVersion: version, title: s, stamp: leagueStampNode, instructions: a(instructionsNode), notes: opt(text) });
const sourceNode: v.Node<SourceSnapshot> = t('kind', {
  build: o({ kind: e('build'), payload: buildNode }), atlas: o({ kind: e('atlas'), payload: atlasPlanNode }),
  filter: o({ kind: e('filter'), payload: filterNode }), notes: o({ kind: e('notes'), payload: textSnapshotNode }),
  checklist: o({ kind: e('checklist'), payload: textSnapshotNode }),
});
const frozenSourceNode: v.Node<FrozenSource> = o({ ref: revisionRefNode, fallbackSnapshot: sourceNode });
const chunkNode: v.Node<ChunkOverride> = t('kind', {
  auto: o({ kind: e('auto') }), levels: o({ kind: e('levels'), size: e(4, 6, 8, 10) }),
  atlas: o({ kind: e('atlas'), mode: e('per_step'), splitAtAllocatedPoints: e(10) }),
});
const optionNode: v.Node<ClipOption> = o({ optionId: id('option'), title: s, source: frozenSourceNode, actions: a(actionNode) });
const rangeNode = refine(o({ start: level, endExclusive: v.number(2, 101, true) }), (range, path) => check(range.start < range.endExclusive, path, 'Character-level range must be nonempty.'));
const pointRangeNode = refine(o({ start: uint, endExclusive: positive }), (range, path) => check(range.start < range.endExclusive, path, 'Atlas point range must be nonempty.'));
const clipNode: v.Node<Clip> = refine(o<Clip>({ clipId: id('clip'), laneId: id('lane'), range: rangeNode, options: a(optionNode, 1), selectedOptionId: n(id('option')),
  instructionOverrides: a(o({ actionId: id('action'), instruction: instructionsNode })), timingMode: e('keep_instruction_timing', 'scale_timing'),
  chunkOverride: chunkNode, excludedActionIds: a(id('action')),
  atlasPointRange: opt(pointRangeNode), disabled: opt(b),
  keptActionIds: opt(a(id('action'))),
}), (clip, path) => {
  unique(clip.options.map(option => option.optionId), path);
  check(clip.selectedOptionId === null || clip.options.some(option => option.optionId === clip.selectedOptionId), path, 'Selected option is missing.');
  for (const option of clip.options) {
    unique(option.actions.map(action => action.actionId), path);
    check(option.actions.every(action => action.clipId === clip.clipId && action.laneId === clip.laneId && action.optionId === option.optionId && sameRef(action.sourceRevision, option.source.ref)), path, 'Action context does not match its pinned clip source.');
  }
  const actionIds = new Set(clip.options.flatMap(option => option.actions.map(action => action.actionId)));
  unique(clip.instructionOverrides.map(override => override.actionId), path);
  unique(clip.excludedActionIds, path);
  unique(clip.keptActionIds ?? [], path);
  check(clip.instructionOverrides.every(override => actionIds.has(override.actionId)) && clip.excludedActionIds.every(actionId => actionIds.has(actionId))
    && (clip.keptActionIds ?? []).every(actionId => actionIds.has(actionId)), path, 'Clip annotations reference an unknown action.');
});
const laneNode: v.Node<Lane> = o({ laneId: id('lane'), type: e('build', 'atlas', 'filter', 'notes', 'checklist'), title: s, order: uint, muted: b, clipIds: a(id('clip')) });
export const timelineNode: v.Node<Timeline> = refine(o<Timeline>({
  schemaVersion: version, title: s, stamp: leagueStampNode, lanes: a(laneNode), clips: a(clipNode),
  firstMapAnchor: n(o({ anchorId: s, evidence: knownNode(t<{ kind: 'zone'; zoneId: string } | { kind: 'manual' }>('kind', { zone: o({ kind: e('zone'), zoneId: s }), manual: o({ kind: e('manual') }) })) })),
  editorMetadata: o({ previewLevel: level, snap: b, showChunks: b }), credits: a(creditNode), notes: opt(text),
}), (timeline, path) => {
  unique(timeline.lanes.map(lane => lane.laneId), path);
  unique(timeline.lanes.map(lane => lane.order), path);
  unique(timeline.clips.map(clip => clip.clipId), path);
  for (const lane of timeline.lanes) {
    unique(lane.clipIds, path);
    const clips = timeline.clips.filter(clip => clip.laneId === lane.laneId).sort((left, right) => left.range.start - right.range.start);
    check(clips.length === lane.clipIds.length && clips.every(clip => lane.clipIds.includes(clip.clipId)), path, 'Lane clip membership is inconsistent.');
    check(clips.every(clip => clip.atlasPointRange === undefined || lane.type === 'atlas'), path, 'Atlas point range requires an atlas lane.');
    check(clips.every(clip => clip.options.every(option => option.source.fallbackSnapshot.kind === lane.type)), path, 'Clip source type does not match its lane.');
    check(clips.every((clip, index) => index === 0 || clips[index - 1]!.range.endExclusive <= clip.range.start), path, 'Ordinary clips overlap in one lane.');
  }
  check(timeline.clips.every(clip => timeline.lanes.some(lane => lane.laneId === clip.laneId)), path, 'Clip lane is missing.');
  const actions = timeline.clips.flatMap(clip => clip.options.flatMap(option => option.actions));
  unique(actions.map(action => action.actionId), path);
  check(actions.every(action => action.trigger.kind !== 'firstMap' || timeline.firstMapAnchor?.anchorId === action.trigger.anchorId), path, 'First-map action has no matching anchor.');
});
const dependencyNode: v.Node<EmbeddedDependency> = o({ ref: revisionRefNode, snapshot: sourceNode, dependsOn: a(revisionRefNode) });
export function revisionKey(ref: RevisionRef): string { return `${ref.objectId}/${ref.revisionId}`; }
function sameRef(left: RevisionRef, right: RevisionRef): boolean {
  return revisionKey(left) === revisionKey(right) && left.payloadHash === right.payloadHash && left.fallbackSnapshotHash === right.fallbackSnapshotHash
    && JSON.stringify(left.stamp) === JSON.stringify(right.stamp);
}
function validateDependencies(dependencies: EmbeddedDependency[], path: string): void {
  unique(dependencies.map(dependency => revisionKey(dependency.ref)), path);
  const byKey = new Map(dependencies.map(dependency => [revisionKey(dependency.ref), dependency]));
  const indegree = new Map<string, number>();
  const parents = new Map<string, string[]>();
  for (const dependency of dependencies) {
    const key = revisionKey(dependency.ref);
    unique(dependency.dependsOn.map(revisionKey), path);
    indegree.set(key, dependency.dependsOn.length);
    for (const ref of dependency.dependsOn) {
      const target = byKey.get(revisionKey(ref));
      check(target && sameRef(target.ref, ref), path, 'Required dependency snapshot is missing or has different metadata.');
      const items = parents.get(revisionKey(ref)) ?? [];
      items.push(key);
      parents.set(revisionKey(ref), items);
    }
  }
  const queue = [...indegree].filter(([, count]) => count === 0).map(([key]) => key);
  let processed = 0;
  while (processed < queue.length) {
    for (const parent of parents.get(queue[processed++]!) ?? []) {
      indegree.set(parent, indegree.get(parent)! - 1);
      if (indegree.get(parent) === 0) queue.push(parent);
    }
  }
  if (processed !== dependencies.length) v.fail(path, 'Dependency graph contains a cycle.', 'CYCLIC_PAYLOAD');
}
export const timelineBundleNode: v.Node<TimelineBundle> = refine(o<TimelineBundle>({
  schemaVersion: version, bundleId: id('bundle'), timeline: timelineNode, dependencies: a(dependencyNode), assets: a(assetNode),
  schedulerVersion: s, actionSchemaVersion: version, choices: a(o({ clipId: id('clip'), optionId: id('option') })), credits: a(creditNode),
}), (bundle, path) => {
  validateDependencies(bundle.dependencies, path);
  unique(bundle.choices.map(choice => choice.clipId), path);
  check(bundle.choices.length === bundle.timeline.clips.length, path, 'Each clip requires one resolved alternative.');
  for (const clip of bundle.timeline.clips) {
    check(bundle.choices.some(choice => choice.clipId === clip.clipId && clip.options.some(option => option.optionId === choice.optionId)
      && (clip.selectedOptionId === null || clip.selectedOptionId === choice.optionId)), path, 'Resolved clip choice is invalid.');
    for (const option of clip.options) {
      const dependency = bundle.dependencies.find(item => sameRef(item.ref, option.source.ref));
      check(dependency && JSON.stringify(dependency.snapshot) === JSON.stringify(option.source.fallbackSnapshot), path, 'Clip fallback does not match its embedded dependency.');
    }
  }
});

const scopeNode: v.Node<ScopeKey> = o({ leagueId: s, realm: s, mode: modeNode });
const workspaceNode: v.Node<WorkspaceManifest> = o({ schemaVersion: version, stamp: leagueStampNode, activeScope: scopeNode, catalogRevision: hash,
  membership: o({ build: a(id('object')), atlas: a(id('object')), filter: a(id('object')), timeline: a(id('object')), notes: a(id('object')), checklist: a(id('object')) }),
  retainedScopes: a(scopeNode), transactionCheckpoint: id('transaction'),
});
const commandNode: v.Node<EditCommand> = t('kind', {
  setTitle: o({ kind: e('setTitle'), title: s }), replaceSnapshot: o({ kind: e('replaceSnapshot'), snapshot: revisionRefNode }),
  restoreRevision: o({ kind: e('restoreRevision'), source: revisionRefNode }), applyProposal: o({ kind: e('applyProposal'), proposalHash: hash }),
});
const transactionNode: v.Node<EditTransaction> = o({ schemaVersion: version, transactionId: id('transaction'), parentTransactionId: n(id('transaction')), branchId: s,
  before: revisionRefNode, after: revisionRefNode, commands: a(commandNode, 1), stamp: leagueStampNode, createdAt: timestamp, label: s,
});
const checkpointNode: v.Node<RevisionCheckpoint> = o({ schemaVersion: version, transactionId: id('transaction'), revision: revisionRefNode, stamp: leagueStampNode });
const copyNode: v.Node<CopyProvenance> = o({ source: revisionRefNode, dataMode: e('source_data', 'target_data') });
const settingsNode: v.Node<RunSettingsSnapshot> = o({ schemaVersion: version, stamp: leagueStampNode,
  characterChunks: t('kind', { auto: o({ kind: e('auto') }), fixed: o({ kind: e('fixed'), size: e(4, 6, 8, 10) }) }), atlasSplitPoints: e(10), countRuns: b, globalNextBackEnabled: b,
});
const scheduledBundleNode: v.Node<ScheduledBundle> = o({ bundleId: id('bundle'), trigger: triggerNode, actionIds: a(id('action'), 1), fingerprint: hash });
const runSnapshotNode: v.Node<RunSnapshot> = refine(o<RunSnapshot>({ schemaVersion: version, runId: id('run'), stamp: leagueStampNode, timelineRevision: revisionRefNode,
  publishedOrigin: n(publishedRevisionRefNode), choices: a(o({ clipId: id('clip'), optionId: id('option') })), omittedClipIds: a(id('clip')),
  actions: a(actionNode), bundles: a(scheduledBundleNode), dependencies: a(dependencyNode), schedulerVersion: s, settings: settingsNode,
}), (snapshot, path) => {
  validateDependencies(snapshot.dependencies, path);
  unique(snapshot.actions.map(action => action.actionId), path);
  unique(snapshot.bundles.map(bundle => bundle.bundleId), path);
  check(snapshot.actions.every(action => snapshot.dependencies.some(dependency => sameRef(dependency.ref, action.sourceRevision))), path, 'Run action source is not embedded.');
  unique(snapshot.bundles.flatMap(bundle => bundle.actionIds), path);
  check(snapshot.bundles.every(bundle => bundle.actionIds.every(actionId => snapshot.actions.some(action => action.actionId === actionId))), path, 'Scheduled bundle references an unknown action.');
});
const observedNode: v.Node<ObservedProgress> = o({ characterLevel: knownNode(level), zoneId: ks, areaLevel: ku,
  firstMap: knownNode(o({ anchorId: s, observedAt: timestamp, method: e('zone_evidence', 'manual_declaration') })),
  atlas: o({ allocatedCount: ku, nodeIds: knownNode(a(s)), coverage: e('unknown', 'manual_baseline_and_deltas', 'complete_snapshot', 'gap'), available: ku, unspent: ku, earned: ku }),
  observedAt: n(timestamp),
});
const runStateNode: v.Node<RunState> = o<RunState>({ schemaVersion: version, runId: id('run'), stamp: leagueStampNode, snapshotHash: hash,
  guideCursor: o({ bundleId: n(id('bundle')), level }), observedProgress: observedNode, mode: e('manual', 'auto', 'paused'),
  presentedBundleIds: a(id('bundle')), reviewed: a(o({ actionId: id('action'), contentHash: hash })), skippedActionIds: a(id('action')), outstandingActionIds: a(id('action')),
  commandCursor: uint, eventCursor: n(o({ generationId: s, byteOffset: uint, eventId: s })), startedAt: timestamp, endedAt: n(timestamp), characterBinding: opt(s), logPath: opt(s),
});
const finishNode: v.Node<LocalFinishRecord> = o({ schemaVersion: version, runId: id('run'), stamp: leagueStampNode, reviewedCount: uint, skippedCount: uint, outstandingCount: uint, finishMethod: n(e('final_trigger_observed', 'player_confirmed')), endedAt: timestamp });
const receiptNode: v.Node<CompletionReceipt> = refine(o<CompletionReceipt>({ schemaVersion: version, stamp: leagueStampNode, publishedRevision: publishedRevisionRefNode,
  method: e('final_trigger_observed', 'player_confirmed'), finalTrigger: triggerNode, finalActionFingerprint: hash,
  evidenceSummary: o({ kind: e('log_trigger_match', 'player_confirmation'), observedAt: timestamp }), idempotencyKey: s,
}), (receipt, path) => check((receipt.method === 'final_trigger_observed') === (receipt.evidenceSummary.kind === 'log_trigger_match'), path, 'Receipt method and evidence summary disagree.'));
// The server still answers with the old name of AI_ACCESS_REQUIRED until it is updated; it is read as the new one.
const aiAccess = <T extends string>(node: v.Node<T>): v.Node<T> => ({ read: (value, path, ctx) => node.read(value === 'PRO_REQUIRED' ? 'AI_ACCESS_REQUIRED' : value, path, ctx) });
const denied = aiAccess(e('SIGN_IN_REQUIRED', 'AI_ACCESS_REQUIRED', 'ENTITLEMENT_UNAVAILABLE', 'HUMAN_CHECK_REQUIRED', 'CONNECTION_REVOKED', 'AI_SERVICE_UNAVAILABLE'));
const entitlementNode: v.Node<EntitlementDecision> = t('status', {
  authorized: o({ status: e('authorized'), authorizationId: s, expiresAt: timestamp, requestHash: hash, scopes: a(s) }),
  denied: o({ status: e('denied'), code: denied }),
});
const clearanceNode: v.Node<NetworkClearance> = t('status', {
  clear: o({ status: e('clear'), clearanceId: s, expiresAt: timestamp, requestHash: hash }),
  human_check_required: o({ status: e('human_check_required'), challengeId: s, expiresAt: timestamp, requestHash: hash }),
  unavailable: o({ status: e('unavailable'), retryAt: n(timestamp) }),
});
const targetNode: v.Node<RevisionRef | PublishedRevisionRef> = { read(value, path, ctx) {
  check(value !== null && typeof value === 'object', path, 'Expected a revision target.');
  return Object.hasOwn(value, 'postId') ? publishedRevisionRefNode.read(value, path, ctx) : revisionRefNode.read(value, path, ctx);
} };
const intentNode: v.Node<PendingIntent> = refine(o<PendingIntent>({ schemaVersion: version, requestId: s, idempotencyKey: s, accountBinding: s, target: targetNode, requestHash: hash,
  operation: e('read', 'vote', 'save', 'publish', 'report', 'feedback', 'checkout', 'external_edit'), resumePolicy: e('once', 'return_to_review'),
}), (intent, path) => check(intent.resumePolicy === (['read', 'vote', 'save'].includes(intent.operation) ? 'once' : 'return_to_review'), path, 'This operation requires an explicit final action after review.'));
const authorizationRequestNode: v.Node<AiAuthorizationRequest> = o({ requestId: s, requestHash: hash, target: revisionRefNode, scope: s, clientId: n(s) });
const clientNode: v.Node<PairedClient> = o({ clientId: s, scopes: a(s), status: e('paired', 'revoked'), expiresAt: timestamp });
const inlineNode: v.Node<PublicInline> = t('kind', {
  text: o({ kind: e('text'), text }), strong: o({ kind: e('strong'), text }), emphasis: o({ kind: e('emphasis'), text }), code: o({ kind: e('code'), text }),
  link: o({ kind: e('link'), text, href: refine(s, (url, path) => check(isSafeHttpsUrl(url), path, 'Only HTTPS links without credentials are supported.')) }),
});
const blockNode: v.Node<PublicTextBlock> = t('kind', {
  paragraph: o({ kind: e('paragraph'), content: a(inlineNode) }), list_item: o({ kind: e('list_item'), content: a(inlineNode) }),
  heading: o({ kind: e('heading'), level: e(1, 2, 3), content: a(inlineNode) }),
});
export const publicRichTextNode: v.Node<PublicRichText> = a(blockNode);
export const publicDocumentNode: v.Node<PublicDocument> = t('kind', {
  build: o({ kind: e('build'), payload: buildNode }), atlas: o({ kind: e('atlas'), payload: atlasPlanNode }), timeline: o({ kind: e('timeline'), payload: timelineBundleNode }),
});
export const MAX_LISTING_TAGS = 10, MAX_TAG_LENGTH = 30, MAX_MECHANICS = 64;
const listingNode: v.Node<ListingMetadata> = refine(o<ListingMetadata>({
  budget: e(...BUDGET_BANDS), leagueStarter: b,
  tags: a(v.string(MAX_TAG_LENGTH)), video: n(refine(s, (url, path) => check(isSafeHttpsUrl(url), path, 'Only HTTPS links without credentials are supported.'))),
  className: n(v.string(40)), ascendancy: n(v.string(40)), mechanics: a(v.string(64)),
}), (listing, path) => {
  check(listing.tags.length <= MAX_LISTING_TAGS, path, 'Use up to 10 tags.');
  check(listing.mechanics.length <= MAX_MECHANICS, path, 'Too many mechanics.');
  unique(listing.tags.map(tag => tag.toLocaleLowerCase()), path);
  unique(listing.mechanics, path);
});
const historyNode: v.Node<PublicHistoryEntry> = o({ revision: revisionRefNode, label: s, createdAt: timestamp, snapshot: publicDocumentNode });
export const publicItemPayloadNode: v.Node<PublicItemPayload> = refine(o<PublicItemPayload>({ schemaVersion: version, publicId: id('public'), publishedRevision: publishedRevisionRefNode,
  visibility: e('public', 'unlisted'), stamp: leagueStampNode, title: s, creator: o({ displayName: s, identityVerified: b }), description: publicRichTextNode,
  document: publicDocumentNode, credits: a(creditNode), votes: o<PublicItemPayload['votes']>({ up: uint, down: uint, net: v.number(-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, true), revision: opt(uint) as v.Node<number>, myVote: opt(e(-1, 0, 1)) as v.Node<-1 | 0 | 1> }),
  finishes: o({ finalTriggerObserved: uint, playerConfirmed: uint }), publishedAt: timestamp, history: opt(a(historyNode)), listing: opt(listingNode),
}), (payload, path) => check(payload.votes.net === payload.votes.up - payload.votes.down, path, 'Net vote count is inconsistent.'));
const postNode: v.Node<MarketplacePost> = o({ schemaVersion: version, postId: id('post'), publicId: id('public'), sourceObjectId: id('object'), stamp: leagueStampNode,
  status: e('draft', 'pending', 'published', 'rejected', 'removed'), visibility: e('public', 'unlisted'), currentRevision: n(publishedRevisionRefNode), rowVersion: uint as v.Node<MarketplacePost['rowVersion']>,
});
const savedNode: v.Node<SavedItem> = o({ schemaVersion: version, objectId: id('object'), stamp: leagueStampNode, selectedRevision: publishedRevisionRefNode, source: revisionRefNode, cachedPayload: publicItemPayloadNode });
const collectionNode: v.Node<Collection> = o({ schemaVersion: version, objectId: id('object'), title: s, stamp: leagueStampNode, members: a(o({ publishedRevision: publishedRevisionRefNode, source: revisionRefNode })) });
const resolveNode: v.Node<ResolvePublicItemRequest> = o<ResolvePublicItemRequest>({ publicId: id('public'), revision: opt(positive) });
const feedNode: v.Node<FeedRequest> = o({ scope: leagueStampNode, type: e('all', 'build', 'atlas', 'timeline'), sort: e('hot', 'top', 'new', 'old', 'rising'), window: e('24_hours', '7_days', '30_days', 'league', 'all_time'), search: text, cursor: n(s) });
const publishNode: v.Node<PublishRequest> = o({ source: revisionRefNode, visibility: e('public', 'unlisted'), payload: publicDocumentNode, description: publicRichTextNode, includeNotes: b, includeHistory: b, idempotencyKey: s });
const voteNode: v.Node<VoteRequest> = o({ postId: id('post'), direction: e(-1, 0, 1), idempotencyKey: s });
const feedbackNode: v.Node<FeedbackRequest> = o({ publishedRevision: publishedRevisionRefNode, clipId: id('clip'), actionId: id('action'), reason: s, text, idempotencyKey: s });
const reportNode: v.Node<ReportRequest> = o({ postId: id('post'), reason: s, text, idempotencyKey: s });
const failureNode: v.Node<ApiFailure> = o<ApiFailure>({ ok: { read(value, path) { check(value === false, path, 'Expected a failed result.'); return false; } },
  code: aiAccess(e('VALIDATION_FAILED', 'UNSUPPORTED_VERSION', 'LIMIT_EXCEEDED', 'CYCLIC_PAYLOAD', 'INVALID_LINK', 'UNAVAILABLE', 'REVISION_CONFLICT',
    'SIGN_IN_REQUIRED', 'AI_ACCESS_REQUIRED', 'ENTITLEMENT_UNAVAILABLE', 'HUMAN_CHECK_REQUIRED', 'CONNECTION_REVOKED', 'AI_SERVICE_UNAVAILABLE', 'RATE_LIMITED', 'MODERATION_REJECTED',
    'FEATURE_PAUSED', 'MAINTENANCE', 'PROTECTED')),
  message: s, retryAt: opt(timestamp),
});
const writeResponseNode: v.Node<WriteDocumentResponse> = o({ revision: revisionRefNode, rowVersion: uint as v.Node<WriteDocumentResponse['rowVersion']> });
function nestedSchema<T>(payloadSchema: v.Schema<T>): v.Node<T> {
  return { read(value, path, ctx) {
    const result = payloadSchema.parse(value, ctx.limits);
    if (!result.ok) {
      const issue = result.issues[0]!;
      v.fail(`${path}${issue.path.slice(1)}`, issue.message, issue.code);
    }
    return result.value;
  } };
}
export function documentEnvelopeSchema<T, K extends ObjectKind>(kind: K, payloadSchema: v.Schema<T>): v.Schema<DocumentEnvelope<T, K>> {
  return v.schema(o<DocumentEnvelope<T, K>>({ schemaVersion: version, objectId: id('object'), kind: e(kind), revision: revisionNode, payload: nestedSchema(payloadSchema) }));
}
export function writeDocumentRequestSchema<T>(payloadSchema: v.Schema<T>): v.Schema<WriteDocumentRequest<T>> {
  return v.schema(o<WriteDocumentRequest<T>>({ objectId: id('object'), expectedRevisionId: n(id('revision')), payload: nestedSchema(payloadSchema), stamp: leagueStampNode, idempotencyKey: s }));
}
export function apiResultSchema<T>(payloadSchema: v.Schema<T>): v.Schema<ApiResult<T>> {
  return v.schema({ read(value, path, ctx) {
    check(value !== null && typeof value === 'object', path, 'Expected an API result.');
    if ((value as Record<string, unknown>).ok === false) return failureNode.read(value, path, ctx);
    return o({ ok: { read(input: unknown, field: string) { check(input === true, field, 'Expected a successful result.'); return true as const; } }, value: nestedSchema(payloadSchema) }).read(value, path, ctx);
  } });
}

export const leagueStampSchema = v.schema(leagueStampNode);
export const revisionRefSchema = v.schema(revisionRefNode);
export const revisionSchema = v.schema(revisionNode);
export const publishedRevisionRefSchema = v.schema(publishedRevisionRefNode);
export const workspaceManifestSchema = v.schema(workspaceNode);
export const editTransactionSchema = v.schema(transactionNode);
export const revisionCheckpointSchema = v.schema(checkpointNode);
export const copyProvenanceSchema = v.schema(copyNode);
export const atlasDatasetSchema = v.schema(atlasDatasetNode);
export const atlasPlanSchema = v.schema(atlasPlanNode);
export const atlasStepSchema = v.schema(stepNode);
export const atlasProposalSchema = v.schema(proposalNode);
export const triggerSchema = v.schema(triggerNode);
export const actionSchema = v.schema(actionNode);
export const buildSnapshotSchema = v.schema(buildNode);
export const localBuildSourceSchema = v.schema(localBuildNode);
export const filterSnapshotSchema = v.schema(filterNode);
export const sourceSnapshotSchema = v.schema(sourceNode);
export const clipSchema = v.schema(clipNode);
export const timelineSchema = v.schema(timelineNode);
export const timelineBundleSchema = v.schema(timelineBundleNode);
export const runSettingsSnapshotSchema = v.schema(settingsNode);
export const runSnapshotSchema = v.schema(runSnapshotNode);
export const runStateSchema = v.schema(runStateNode);
export const observedProgressSchema = v.schema(observedNode);
export const localFinishRecordSchema = v.schema(finishNode);
export const completionReceiptSchema = v.schema(receiptNode);
export const entitlementDecisionSchema = v.schema(entitlementNode);
export const networkClearanceSchema = v.schema(clearanceNode);
export const pendingIntentSchema = v.schema(intentNode);
export const aiAuthorizationRequestSchema = v.schema(authorizationRequestNode);
export const pairedClientSchema = v.schema(clientNode);
export const publicRichTextSchema = v.schema(publicRichTextNode);
export const publicDocumentSchema = v.schema(publicDocumentNode);
export const publicItemPayloadSchema = v.schema(publicItemPayloadNode);
export const listingMetadataSchema = v.schema(listingNode);
export const marketplacePostSchema = v.schema(postNode);
export const savedItemSchema = v.schema(savedNode);
export const collectionSchema = v.schema(collectionNode);
export const resolvePublicItemRequestSchema = v.schema(resolveNode);
export const feedRequestSchema = v.schema(feedNode);
export const publishRequestSchema = v.schema(publishNode);
export const voteRequestSchema = v.schema(voteNode);
export const feedbackRequestSchema = v.schema(feedbackNode);
export const reportRequestSchema = v.schema(reportNode);
export const apiFailureSchema = v.schema(failureNode);
export const writeDocumentResponseSchema = v.schema(writeResponseNode);
