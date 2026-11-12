import { Worker } from 'node:worker_threads';
import type { AtlasGraph } from '../../shared/atlas/graph.js';
import { digest, ExactSolverError, type ExactLimits } from '../../shared/atlas/solver/metric.js';
import { validatePriorityResult, type PriorityResult } from '../../shared/atlas/solver/priority.js';
import { MAX_RUN_MS, PREFERENCE_DEBOUNCE_MS, packGraph, sameIdentity, solverIdentity, solverInputHash, validatePolicy,
  type HostMessage, type SearchPolicy, type SolverIdentity, type SolverInput, type WorkerMessage } from '../../shared/atlas/solver/protocol.js';

export type SolverHostOptions = {
  limits: ExactLimits; onMessage: (message: WorkerMessage) => void;
  workerUrl?: URL; policy?: SearchPolicy;
};
type Job = {
  graph: AtlasGraph; input: SolverInput; identity: SolverIdentity; cycle: number; startedAt: number;
  stopped: boolean; worker: Worker; timer?: ReturnType<typeof setTimeout>; result?: PriorityResult; validated?: string;
};

// The mastery wiring bundles solver.worker.ts and may supply the packaged worker URL here.
// One host owns one active job. Termination cancels synchronous DP immediately.
export class AtlasSolverHost {
  private job?: Job;
  private pending?: ReturnType<typeof setTimeout>;
  private cycle = 0;
  private disposed = false;
  private readonly policy: SearchPolicy;
  constructor(private readonly options: SolverHostOptions) {
    this.policy = structuredClone(options.policy ?? { runMs: MAX_RUN_MS, maxPasses: 10_000 });
    validatePolicy(this.policy);
  }
  get candidate(): PriorityResult | undefined { return this.job?.result && structuredClone(this.job.result); }
  find(graph: AtlasGraph, input: SolverInput): void {
    this.assertOpen();
    if (solverInputHash(graph, input) !== input.inputHash) throw new ExactSolverError('INVALID', 'Solver input identity changed.');
    this.cancel();
    this.launch(structuredClone(graph), structuredClone(input));
  }
  preferencesChanged(graph: AtlasGraph, input: SolverInput): void {
    this.assertOpen();
    if (solverInputHash(graph, input) !== input.inputHash) throw new ExactSolverError('INVALID', 'Solver input identity changed.');
    solverIdentity(graph, input);
    this.cancel();
    const snapshot = { graph: structuredClone(graph), input: structuredClone(input) };
    this.pending = setTimeout(() => { this.pending = undefined; this.find(snapshot.graph, snapshot.input); }, PREFERENCE_DEBOUNCE_MS);
  }
  continueSolving(): void {
    this.assertOpen();
    const job = this.job;
    if (!job || !job.stopped || job.result?.proof.kind === 'exact') throw new ExactSolverError('INVALID', 'There is no stopped search to continue.');
    const resume = job.result && structuredClone(job.result);
    this.cancel(); this.launch(job.graph, job.input, resume);
  }
  freeze(graph: AtlasGraph, currentInput: SolverInput): PriorityResult {
    this.assertOpen();
    const result = this.candidate;
    if (!result || !result.complete) throw new ExactSolverError('INVALID', 'The priority evaluation is not complete.');
    validatePriorityResult(graph, currentInput, result, this.options.limits);
    if (!result.withinBudget) throw new ExactSolverError('INVALID', 'This preview exceeds the point budget.');
    this.cancel(); return result;
  }
  cancel(): void {
    if (this.pending) { clearTimeout(this.pending); this.pending = undefined; }
    const job = this.job; this.job = undefined;
    if (!job) return;
    if (job.timer) clearTimeout(job.timer);
    void job.worker.terminate();
  }
  dispose(): void { this.cancel(); this.disposed = true; }
  private assertOpen(): void { if (this.disposed) throw new ExactSolverError('INVALID', 'The path search host is closed.'); }

  private launch(graph: AtlasGraph, input: SolverInput, resume?: PriorityResult): void {
    const identity = solverIdentity(graph, input);
    const compact = packGraph(graph);
    const worker = new Worker(this.options.workerUrl ?? new URL('./solver.worker.js', import.meta.url));
    const job: Job = { graph, input, identity, cycle: ++this.cycle, startedAt: Date.now(), stopped: false, worker,
      ...(resume ? { result: resume } : {}) };
    this.job = job;
    const fail = (message: string) => {
      if (this.job !== job || job.stopped) return;
      this.acceptResponse({ type: 'error', identity, cycle: job.cycle, code: 'WORKER_FAILED', message });
    };
    worker.on('message', (message: WorkerMessage) => this.acceptResponse(message));
    worker.on('error', error => fail(error.message));
    worker.on('exit', code => { if (!job.stopped) fail(`Path search worker exited before completing (${code}).`); });
    job.timer = setTimeout(() => {
      if (this.job !== job || job.stopped) return;
      this.acceptResponse({ type: 'stopped', identity, cycle: job.cycle, reason: 'time_limit', elapsedMs: Date.now() - job.startedAt,
        actions: ['Continue solving', 'Reduce targets', 'Cancel'], label: this.policy.runMs === MAX_RUN_MS ? 'Best found in 10 seconds' : 'Best found so far' });
    }, this.policy.runMs);
    const message: HostMessage = { type: 'start', identity, cycle: job.cycle, graph: compact, input,
      limits: this.options.limits, policy: this.policy, deadline: job.startedAt + this.policy.runMs, ...(resume ? { resume } : {}) };
    const offsets = compact.offsets.buffer, adjacent = compact.adjacent.buffer;
    if (!(offsets instanceof ArrayBuffer) || !(adjacent instanceof ArrayBuffer)) throw new ExactSolverError('INVALID', 'Worker graph buffers must be transferable.');
    worker.postMessage(message, [offsets, adjacent]);
  }

  // A response is useful only for the current immutable input and search cycle.
  // Kept public to exercise queued/stale delivery without an Electron surface.
  acceptResponse(message: WorkerMessage): boolean {
    const job = this.job;
    if (!job || job.stopped || message.cycle !== job.cycle || !sameIdentity(message.identity, job.identity)) return false;
    if (message.type === 'candidate' || message.type === 'decision' || message.type === 'proof') {
      // candidate, decision and proof of one pass carry the same result: validate it once, not three times on the main thread.
      const hash = digest(message.result);
      if (hash !== job.validated) {
        try { validatePriorityResult(job.graph, job.input, message.result, this.options.limits); }
        catch (error) {
          return this.acceptResponse({ type: 'error', identity: job.identity, cycle: job.cycle, code: 'INVALID',
            message: error instanceof Error ? error.message : 'Path search returned an invalid candidate.' });
        }
        job.validated = hash;
      }
      if (message.type === 'candidate') job.result = structuredClone(message.result);
    } else {
      job.stopped = true;
      if (job.timer) clearTimeout(job.timer);
      void job.worker.terminate();
    }
    this.options.onMessage(structuredClone(message));
    return true;
  }
}
