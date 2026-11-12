import type { Hash, Known, LeagueStamp, RevisionRef, SourceCredit, StepId } from './stamp.js';

export type Provenance = { sourceId: string; sourceHash: Hash; field: string; fetchedAt: string };
export type Sourced<T> = { data: Known<T>; provenance: Provenance[] };
export type AssetRef = { assetId: string; contentHash: Hash; mediaType: 'image/png' | 'image/webp' | 'image/jpeg' };
export type DatasetRef = { datasetId: string; contentHash: Hash; variant: string; stamp: LeagueStamp };
export type AtlasStat = {
  statId: string;
  sourceText: string;
  aggregation: 'additive' | 'conditional' | 'nonadditive';
  value: Known<number>;
  unit: Known<string>;
  effectSchemaHash: Hash;
  provenance: Provenance[];
};
export type AtlasNode = { nodeId: string; name: string; adjacentIds: string[]; stats: AtlasStat[]; asset: AssetRef | null };
export type CatalogEntry = { catalogId: string; name: string; asset: AssetRef | null; provenance: Provenance[] };
export type AtlasDataset = {
  schemaVersion: 1;
  ref: DatasetRef;
  exportTag: Known<string>;
  exportCommit: Known<string>;
  exportFileHashes: Record<string, Hash>;
  gamePatch: Known<string>;
  cdnPatchId: Known<string>;
  schemaHash: Hash;
  schemaCommit: Known<string>;
  parserVersion: string;
  normalizerVersion: string;
  verificationReportHash: Hash;
  compatibility: Known<'verified'>;
  fieldProvenance: Record<string, Sourced<string>>;
  graph: { graphHash: Hash; rootId: string; nodes: AtlasNode[] };
  assets: AssetRef[];
  catalogs: { maps: CatalogEntry[]; scarabs: CatalogEntry[] };
  taxonomy: { revision: string; contentHash: Hash; targets: { targetId: string; nodeIds: string[]; verified: Known<boolean> }[] };
  costModel: { revision: string; contentHash: Hash; nodeCosts: Record<string, number>; maximumPoints: Known<number>; grantedPoints: Known<number>; provenance: Provenance[] };
};
export type Instructions = { firstAction: string; details: string; whenReady: string };
export type PriceObservation = { amount: number; currencyId: string; observedAt: string; provenance: Provenance[] };
/** `tier` and `purpose` are authored, optional map-row fields (added in contracts 0.2.0, wire schemaVersion stays 1).
 * `tier`: positive integer; absent = not set/unknown (never a game fact in code). `purpose`: plain text; absent = ''. Row order is priority. */
export type PracticalRow = { catalogId: string; quantity: number; provenance: Provenance[]; price: Known<PriceObservation>; tier?: number; purpose?: string };
export type AtlasStep = {
  stepId: StepId;
  title: string;
  allocatedIds: string[];
  effectSelections: Record<string, string>;
  pointBudget: number;
  pointTarget: number;
  maps: PracticalRow[];
  favouriteMaps: PracticalRow[];
  scarabs: PracticalRow[];
  strategy: string;
  instructions: Instructions;
  repair: { missingIds: string[]; disconnectedIds: string[] };
};
export type SequencePosition =
  | { kind: 'step'; positionId: string; stepId: StepId }
  | { kind: 'alternatives'; positionId: string; alternativeGroupId: string; optionStepIds: StepId[]; defaultStepId: StepId };
export type OptimizerPreferences = { targetIds: string[]; avoidNodeIds: string[]; retainCurrent: boolean; budget: number };
export type AtlasPlan = {
  schemaVersion: 1;
  title: string;
  stamp: LeagueStamp;
  dataset: DatasetRef;
  strategy: string;
  instructions: Instructions;
  stepsById: Record<string, AtlasStep>;
  sequencePositions: SequencePosition[];
  optimizerPreferences: OptimizerPreferences;
  credits: SourceCredit[];
  notes?: string;
};
export type SolverProof =
  | { kind: 'exact'; inputHash: Hash; graphHash: Hash; costModelHash: Hash; variant: string; minimumCost: number; certificateHash: Hash }
  | { kind: 'best_found'; inputHash: Hash; upperBound: number; elapsedMs: number }
  | { kind: 'unavailable'; reason: 'unknown_target' | 'unreachable_target' | 'unverified_taxonomy' };
export type TargetDecision = {
  targetId: string;
  priority: number;
  status: 'accepted' | 'skipped_proven' | 'fit_not_proven' | 'unavailable';
  acceptedBasisIds: string[];
  cost: Known<number>;
  shortfall: Known<number>;
};
export type AtlasProposal = {
  schemaVersion: 1;
  baseRevision: RevisionRef;
  sourceHash: Hash;
  graphHash: Hash;
  costModelHash: Hash;
  taxonomyHash: Hash;
  inputHash: Hash;
  solverVersion: string;
  variant: string;
  candidate: AtlasStep;
  addedIds: string[];
  removedIds: string[];
  cost: number;
  targetDecisions: TargetDecision[];
  provenance: 'Rule' | 'Optimizer' | 'AI';
  proof: SolverProof;
};
