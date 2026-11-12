import type { DatasetRef, Hash } from '@pom/mastery-contracts';
import { known, ordered, type AtlasGraph } from '../../shared/atlas/graph.js';
import { ExactSolverError, digest, type ExactLimits } from '../../shared/atlas/solver/metric.js';
import type { PriorityResult } from '../../shared/atlas/solver/priority.js';
import { solverInputHash, type SearchPolicy, type SolverInput, type WorkerMessage } from '../../shared/atlas/solver/protocol.js';
import type { PrepareRequest } from '../../shared/atlas/suggestions/choices.js';
import { AtlasSolverHost } from './solverHost.js';

export type OptimizerData = { graph: AtlasGraph; taxonomyHash: Hash; qualified: boolean };
export type OptimizerServiceOptions = {
  /** Resolves a pinned dataset through the Atlas registry. */
  data(ref: DatasetRef): OptimizerData;
  limits: ExactLimits; workerUrl?: URL; policy?: SearchPolicy;
};

/**
 * Main-side half of Optimize mechanics. The renderer sends choices; this service binds them to the exact source,
 * runs the solver worker and re-validates the result at Apply. Hashes never come from the renderer.
 * The mastery wiring exposes these methods over IPC and forwards `onMessage` events to the sender window.
 */
export class AtlasOptimizerService {
  private readonly host: AtlasSolverHost;
  private readonly inputs = new Map<Hash, OptimizerData>();
  private readonly listeners = new Set<(message: WorkerMessage) => void>();
  constructor(private readonly options: OptimizerServiceOptions) {
    this.host = new AtlasSolverHost({ limits: options.limits, ...(options.workerUrl ? { workerUrl: options.workerUrl } : {}),
      ...(options.policy ? { policy: options.policy } : {}), onMessage: message => this.listeners.forEach(listener => listener(message)) });
  }
  onMessage(listener: (message: WorkerMessage) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }

  /** Same request ID and same source give the same input hash; any source change gives a different one. */
  prepare(request: PrepareRequest): { input: SolverInput; qualified: boolean } {
    const data = this.options.data(request.dataset), { graph } = data;
    if (graph.costs.status !== 'known') throw new ExactSolverError('UNVERIFIED', 'The point cost model is unverified.');
    const body: SolverInput = { requestId: request.requestId, baseRevision: structuredClone(request.baseRevision),
      sourceHash: digest({ revisionId: request.baseRevision.revisionId, stepId: request.stepId, allocated: ordered(request.sourceAllocatedIds) }),
      taxonomyHash: data.taxonomyHash, variant: request.dataset.variant, inputHash: request.baseRevision.payloadHash,
      sourceAllocatedIds: ordered(request.sourceAllocatedIds), retainCurrent: request.retainCurrent, budget: request.budget,
      legalCostModel: known('nonnegative_additive' as const, graph.costs.evidenceId), preferredNodeGroups: request.rows.map(row => ordered(row.targetIds)),
      rows: request.rows.map(row => ({ targetId: row.targetId, targetIds: [...row.targetIds], taxonomy: structuredClone(row.taxonomy) })),
      avoidedTargetIds: ordered(request.avoidedTargetIds) };
    body.inputHash = solverInputHash(graph, body);
    this.inputs.set(body.inputHash, data);
    if (this.inputs.size > 64) this.inputs.delete(this.inputs.keys().next().value as Hash);
    return { input: body, qualified: data.qualified };
  }
  private data(input: SolverInput): OptimizerData {
    const data = this.inputs.get(input.inputHash);
    if (!data) throw new ExactSolverError('INVALID', 'The plan changed. Recalculate this preview.');
    return data;
  }
  find(input: SolverInput): void { this.host.find(this.data(input).graph, input); }
  preferencesChanged(input: SolverInput): void { this.host.preferencesChanged(this.data(input).graph, input); }
  continueSolving(): void { this.host.continueSolving(); }
  cancel(): void { this.host.cancel(); }
  /**
   * Apply gate. `current` is rebuilt from the plan as it is NOW with the run's request ID. Any change to the source,
   * budget or choices changes its hash, so a stale preview cannot be frozen. Freezing stops further work.
   */
  freeze(current: SolverInput): PriorityResult {
    try { return this.host.freeze(this.data(current).graph, current); }
    catch (error) {
      if (error instanceof ExactSolverError && error.code === 'INVALID' && /changed|identity|basis|match/i.test(error.message)) throw new ExactSolverError('INVALID', 'The plan changed. Recalculate this preview.');
      throw error;
    }
  }
  dispose(): void { this.host.dispose(); this.listeners.clear(); }
}
