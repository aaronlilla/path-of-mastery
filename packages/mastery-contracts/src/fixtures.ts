import {
  parseId, type Action, type AtlasDataset, type AtlasPlan, type AtlasProposal, type AtlasStep,
  type BuildSnapshot, type CompletionReceipt, type LeagueStamp, type PublicItemPayload,
  type PublishedRevisionRef, type RevisionRef, type RunSnapshot, type RunState, type TimelineBundle,
  type ValidationLimits,
} from './index.js';

export const limits: ValidationLimits = { maxBytes: 1000000, maxDepth: 64, maxNodes: 50000, maxArrayLength: 5000, maxStringLength: 20000 };
export const publicId = parseId('public', '11111111-1111-4111-8111-111111111111');
export const objectId = parseId('object', '22222222-2222-4222-8222-222222222222');
export const revisionId = parseId('revision', '33333333-3333-4333-8333-333333333333');
export const postId = parseId('post', '44444444-4444-4444-8444-444444444444');
export const runId = parseId('run', '55555555-5555-4555-8555-555555555555');
export const hash = parseId('hash', 'a'.repeat(64));
export const timestamp = '2026-01-01T00:00:00.000Z';
export const instructions = { firstAction: 'Read the synthetic instruction.', details: 'Fixture details.', whenReady: 'Continue when ready.' };
export function stamp(): LeagueStamp {
  return {
    leagueId: { status: 'unknown', reason: 'Fixture scope is unknown.' },
    realm: { status: 'unknown', reason: 'No realm supplied.' },
    mode: { status: 'unknown', reason: 'No mode supplied.' },
    patchVersion: { status: 'unknown', reason: 'No game patch supplied.' },
    datasetVersion: { status: 'unknown', reason: 'Not applicable to this synthetic fixture.' },
    createdAt: timestamp,
  };
}
export function ref(): RevisionRef { return { objectId, revisionId, payloadHash: hash, stamp: stamp(), fallbackSnapshotHash: hash }; }
export function publishedRef(): PublishedRevisionRef { return { postId, revisionId, displayRevision: 1 as PublishedRevisionRef['displayRevision'] }; }
export function build(): BuildSnapshot {
  return { schemaVersion: 1, title: 'Synthetic build', stamp: stamp(), treeNodes: ['fixture-node'], skills: [], gear: [], configuration: [],
    guide: [], calculatedStats: { status: 'unknown', reason: 'No calculation was run.' }, notes: 'Optional authored notes.' };
}
export function step(): AtlasStep {
  return { stepId: parseId('step', 'fixture-step'), title: 'Synthetic step', allocatedIds: ['fixture-root'], effectSelections: {},
    pointBudget: 0, pointTarget: 0, maps: [], favouriteMaps: [], scarabs: [{ catalogId: 'fixture-scarab', quantity: 0, provenance: [], price: { status: 'unknown', reason: 'No observed price.' } }],
    strategy: 'Synthetic strategy.', instructions: { ...instructions }, repair: { missingIds: [], disconnectedIds: [] } };
}
export function plan(): AtlasPlan {
  return { schemaVersion: 1, title: 'Synthetic plan', stamp: stamp(), dataset: { datasetId: 'fixture-dataset', contentHash: hash, variant: 'fixture-variant', stamp: stamp() },
    strategy: 'Synthetic strategy.', instructions: { ...instructions }, stepsById: { 'fixture-step': step() },
    sequencePositions: [{ kind: 'step', positionId: 'fixture-position', stepId: parseId('step', 'fixture-step') }],
    optimizerPreferences: { targetIds: [], avoidNodeIds: [], retainCurrent: false, budget: 0 }, credits: [], notes: 'Optional plan notes.' };
}
export function action(): Action {
  return { schemaVersion: 1, actionId: parseId('action', 'fixture-action'), contentHash: hash, sourceRevision: ref(), laneId: parseId('lane', 'fixture-lane'),
    clipId: parseId('clip', 'fixture-clip'), optionId: parseId('option', 'fixture-option'), trigger: { kind: 'level', level: 1 }, requirements: [], critical: true,
    instruction: { ...instructions }, stamp: stamp() };
}
export function bundle(): TimelineBundle {
  const source = { kind: 'build' as const, payload: build() };
  return { schemaVersion: 1, bundleId: parseId('bundle', 'fixture-bundle'), timeline: {
    schemaVersion: 1, title: 'Synthetic timeline', stamp: stamp(), lanes: [{ laneId: parseId('lane', 'fixture-lane'), type: 'build', title: 'Build', order: 0, muted: false, clipIds: [parseId('clip', 'fixture-clip')] }],
    clips: [{ clipId: parseId('clip', 'fixture-clip'), laneId: parseId('lane', 'fixture-lane'), range: { start: 1, endExclusive: 101 },
      options: [{ optionId: parseId('option', 'fixture-option'), title: 'Synthetic option', source: { ref: ref(), fallbackSnapshot: structuredClone(source) }, actions: [action()] }],
      selectedOptionId: parseId('option', 'fixture-option'), instructionOverrides: [], timingMode: 'keep_instruction_timing', chunkOverride: { kind: 'auto' }, excludedActionIds: [] }],
    firstMapAnchor: null, editorMetadata: { previewLevel: 1, snap: true, showChunks: true }, credits: [], notes: 'Optional timeline notes.',
  }, dependencies: [{ ref: ref(), snapshot: structuredClone(source), dependsOn: [] }], assets: [], schedulerVersion: 'fixture-scheduler-v1', actionSchemaVersion: 1,
    choices: [{ clipId: parseId('clip', 'fixture-clip'), optionId: parseId('option', 'fixture-option') }], credits: [] };
}
export function publicPayload(): PublicItemPayload {
  return { schemaVersion: 1, publicId, publishedRevision: publishedRef(), visibility: 'public', stamp: stamp(), title: 'Synthetic public timeline',
    creator: { displayName: 'Fixture creator', identityVerified: false }, description: [{ kind: 'paragraph', content: [{ kind: 'text', text: 'Fixture description.' }] }],
    document: { kind: 'timeline', payload: bundle() }, credits: [{ source: ref(), origin: publishedRef(), creatorName: 'Fixture creator', title: 'Synthetic source', status: 'original_removed' }],
    votes: { up: 0, down: 0, net: 0 }, finishes: { finalTriggerObserved: 0, playerConfirmed: 0 }, publishedAt: timestamp,
    history: [{ revision: ref(), label: 'Fixture checkpoint', createdAt: timestamp, snapshot: { kind: 'atlas', payload: plan() } }] };
}
export function dataset(): AtlasDataset {
  return { schemaVersion: 1, ref: plan().dataset, exportTag: { status: 'unknown', reason: 'No export.' }, exportCommit: { status: 'unknown', reason: 'No export.' }, exportFileHashes: {},
    gamePatch: stamp().patchVersion, cdnPatchId: { status: 'unknown', reason: 'No CDN build.' }, schemaHash: hash, schemaCommit: { status: 'unknown', reason: 'No schema commit.' },
    parserVersion: 'fixture-v1', normalizerVersion: 'fixture-v1', verificationReportHash: hash, compatibility: { status: 'unknown', reason: 'Synthetic data is not game compatibility evidence.' }, fieldProvenance: {},
    graph: { graphHash: hash, rootId: 'fixture-root', nodes: [{ nodeId: 'fixture-root', name: 'Synthetic root', adjacentIds: [], stats: [], asset: null }] }, assets: [],
    catalogs: { maps: [], scarabs: [] }, taxonomy: { revision: 'fixture-v1', contentHash: hash, targets: [] },
    costModel: { revision: 'fixture-v1', contentHash: hash, nodeCosts: { 'fixture-root': 0 }, maximumPoints: { status: 'unknown', reason: 'No sourced maximum.' }, grantedPoints: { status: 'unknown', reason: 'No sourced grant.' }, provenance: [] } };
}
export function proposal(): AtlasProposal {
  return { schemaVersion: 1, baseRevision: ref(), sourceHash: hash, graphHash: hash, costModelHash: hash, taxonomyHash: hash, inputHash: hash,
    solverVersion: 'fixture-v1', variant: 'fixture-variant', candidate: step(), addedIds: [], removedIds: [], cost: 0, targetDecisions: [], provenance: 'Optimizer',
    proof: { kind: 'exact', inputHash: hash, graphHash: hash, costModelHash: hash, variant: 'fixture-variant', minimumCost: 0, certificateHash: hash } };
}
export function runSnapshot(): RunSnapshot {
  return { schemaVersion: 1, runId, stamp: stamp(), timelineRevision: ref(), publishedOrigin: publishedRef(), choices: bundle().choices, omittedClipIds: [], actions: [action()],
    bundles: [{ bundleId: parseId('bundle', 'fixture-bundle'), trigger: { kind: 'level', level: 1 }, actionIds: [action().actionId], fingerprint: hash }], dependencies: bundle().dependencies,
    schedulerVersion: 'fixture-v1', settings: { schemaVersion: 1, stamp: stamp(), characterChunks: { kind: 'auto' }, atlasSplitPoints: 10, countRuns: true, globalNextBackEnabled: false } };
}
export function runState(): RunState {
  const unknown = { status: 'unknown' as const, reason: 'Not observed.' };
  return { schemaVersion: 1, runId, stamp: stamp(), snapshotHash: hash, guideCursor: { bundleId: null, level: 1 },
    observedProgress: { characterLevel: unknown, zoneId: unknown, areaLevel: unknown, firstMap: unknown, atlas: { allocatedCount: unknown, nodeIds: unknown, coverage: 'unknown', available: unknown, unspent: unknown, earned: unknown }, observedAt: null },
    mode: 'manual', presentedBundleIds: [], reviewed: [], skippedActionIds: [], outstandingActionIds: [action().actionId], commandCursor: 0, eventCursor: null, startedAt: timestamp, endedAt: null,
    characterBinding: 'Local fixture character', logPath: 'C:/fixture/Client.txt' };
}
export function receipt(): CompletionReceipt {
  return { schemaVersion: 1, stamp: stamp(), publishedRevision: publishedRef(), method: 'final_trigger_observed', finalTrigger: { kind: 'level', level: 1 },
    finalActionFingerprint: hash, evidenceSummary: { kind: 'log_trigger_match', observedAt: timestamp }, idempotencyKey: 'fixture-receipt' };
}
