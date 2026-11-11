// Journey IPC contract.
import type { CharacterRow, Realm } from '../characterImport.js';
import type { BudgetInfo, CharacterLink, CheckpointId, JourneyPlan, LiveState, PlanProgress, Policy } from './types.js';

export const JRN = {
  PLAN: 'pom:jrn-plan',
  PLAN_PROGRESS: 'pom:jrn-plan-progress',
  PIN: 'pom:jrn-pin',
  POLICY: 'pom:jrn-policy',
  CHARS: 'pom:jrn-chars',
  CHECK_GEMS: 'pom:jrn-check-gems',
  LINK: 'pom:jrn-link',
  LIVE: 'pom:jrn-live',
  SYNC: 'pom:jrn-sync',
  GAP_FILTER: 'pom:jrn-gap-filter',
  BEST: 'pom:jrn-best',
  BUDGET: 'pom:jrn-budget',
} as const;

export type JrnResult<T> = { ok: true; value: T } | { ok: false; error: string };

export type MatchState = 'match' | 'likely' | 'different';
export interface CharacterMatch {
  state: MatchState;
  reasons: string[];
}

export interface PlanRequest {
  buildKey: string;
  xml: string;
  overrides?: PlanOverrides;
}

/** What the player changed in the Route tab; part of the plan key. */
export interface PlanOverrides {
  policies?: Record<CheckpointId, Policy>;
  detourCap?: 0 | 8 | 16;
  mode?: 'ssf' | 'trade';
  /** decisionId -> index of the option the player picked. */
  pins?: Record<string, number>;
}

export interface PinRequest {
  buildKey: string;
  decisionId: string;
  option: number;
}

export interface PolicyRequest {
  buildKey: string;
  checkpoint: CheckpointId;
  policy?: Policy;
  detourCap?: 0 | 8 | 16;
  mode?: 'ssf' | 'trade';
}

export interface CharsRequest {
  realm: Realm;
  league?: string;
}

export type CharacterRowWithMatch = CharacterRow & { match: CharacterMatch };

export interface CheckGemsRequest {
  realm: Realm;
  character: string;
}

export interface GapFilterRequest {
  buildKey: string;
}

// ---- Best setup ----

export type BestMetric = 'dps' | 'ehp' | 'life' | 'balanced';

export interface BestSetupRequest {
  /** Which build to improve: the open build or a checkpoint of the plan. */
  buildKey: string;
  checkpoint?: CheckpointId;
  metric: BestMetric;
  /** The player's priority in their own words. */
  priority: string;
  claudeTokens: 0 | 30_000 | 60_000 | 120_000;
  useJev: boolean;
}

export interface BestSetupIteration {
  n: number;
  goalSummary: string;
  numbers: Record<string, number>;
  /** Gain over the best so far, as a fraction. */
  gain: number | null;
  revision?: { reason: string; accepted: boolean; jevP: number | null };
}

export type BestSetupEvent =
  | { type: 'started'; id: string }
  | { type: 'iteration'; id: string; iteration: BestSetupIteration }
  | { type: 'claude'; id: string; tokens: number; budget: number }
  | { type: 'done'; id: string; reason: 'max-iterations' | 'no-gain' | 'tokens' | 'time' | 'stopped' | 'revision-refused' | 'failed'; proposalId: string | null; error?: string }
  ;

export type BestSetupCommand = { op: 'start'; request: BestSetupRequest } | { op: 'stop'; id: string };

export interface JourneyBridge {
  plan(req: PlanRequest): Promise<JrnResult<JourneyPlan>>;
  onPlanProgress(cb: (p: PlanProgress) => void): () => void;
  pin(req: PinRequest): Promise<JrnResult<JourneyPlan>>;
  policy(req: PolicyRequest): Promise<JrnResult<JourneyPlan>>;
  chars(req: CharsRequest): Promise<JrnResult<{ rows: CharacterRowWithMatch[] }>>;
  checkGems(req: CheckGemsRequest): Promise<JrnResult<{ match: CharacterMatch }>>;
  link(link: CharacterLink | null): Promise<JrnResult<LiveState>>;
  onLive(cb: (s: LiveState) => void): () => void;
  sync(): Promise<JrnResult<LiveState>>;
  gapFilter(req: GapFilterRequest): Promise<JrnResult<{ path: string; written: true }>>;
  best(cmd: BestSetupCommand): Promise<JrnResult<{ id: string } | null>>;
  onBest(cb: (e: BestSetupEvent) => void): () => void;
  budget(): Promise<JrnResult<BudgetInfo>>;
}
