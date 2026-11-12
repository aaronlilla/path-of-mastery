import { parentPort } from 'node:worker_threads';
import { setImmediate } from 'node:timers/promises';
import { ExactSolverError } from '../../shared/atlas/solver/metric.js';
import { priorityEvaluation, validatePriorityResult, type PriorityResult, type RowSolution } from '../../shared/atlas/solver/priority.js';
import { MAX_RUN_MS, sameIdentity, solverIdentity, unpackGraph, validatePolicy,
  type HostMessage, type WorkerMessage } from '../../shared/atlas/solver/protocol.js';
import type { Hash } from '@pom/mastery-contracts';

if (!parentPort) throw new Error('Atlas path search requires a worker thread.');
const port = parentPort;
let cancelled = false, active: Extract<HostMessage, { type: 'start' }> | undefined;
port.on('message', (message: HostMessage) => {
  if (message.type === 'cancel') {
    if (active && message.cycle === active.cycle && sameIdentity(message.identity, active.identity)) cancelled = true;
    return;
  }
  if (active) return;
  active = message;
  void run(message);
});

async function run(message: Extract<HostMessage, { type: 'start' }>): Promise<void> {
  const startedAt = Date.now();
  const emit = (body: Omit<Extract<WorkerMessage, { type: 'candidate' | 'decision' | 'proof' }>, 'identity' | 'cycle'>
    | Omit<Extract<WorkerMessage, { type: 'stopped' }>, 'identity' | 'cycle'>
    | Omit<Extract<WorkerMessage, { type: 'error' }>, 'identity' | 'cycle'>) => {
    port.postMessage({ ...body, identity: message.identity, cycle: message.cycle } satisfies WorkerMessage);
  };
  const stopped = (reason: Extract<WorkerMessage, { type: 'stopped' }>['reason']) => emit({ type: 'stopped', reason,
    elapsedMs: Date.now() - startedAt, actions: reason === 'complete' || reason === 'cancelled' ? [] : ['Continue solving', 'Reduce targets', 'Cancel'],
    label: reason === 'complete' ? 'Shortest'
      : reason === 'time_limit' && message.policy.runMs === MAX_RUN_MS ? 'Best found in 10 seconds' : 'Best found so far' });
  try {
    validatePolicy(message.policy);
    if (!Number.isFinite(message.deadline) || message.deadline > startedAt + message.policy.runMs) throw new ExactSolverError('INVALID', 'Worker deadline is invalid.');
    const graph = unpackGraph(message.graph, message.limits), input = message.input;
    if (!sameIdentity(message.identity, solverIdentity(graph, input))) throw new ExactSolverError('INVALID', 'Worker request identity changed.');
    const cache = new Map<Hash, RowSolution>();
    if (message.resume) {
      validatePriorityResult(graph, input, message.resume, message.limits);
      for (const row of message.resume.decisions) if (row.solution) cache.set(row.request.inputHash, row.solution);
    }
    const firstPass = message.resume ? message.resume.pass + 1 : 0;
    const shouldCancel = () => cancelled || Date.now() >= message.deadline;
    let last: PriorityResult | undefined = message.resume;
    for (let offset = 0; offset < message.policy.maxPasses; offset++) {
      if (shouldCancel()) { stopped(cancelled ? 'cancelled' : 'time_limit'); return; }
      const pass = firstPass + offset;
      for (const result of priorityEvaluation(graph, input, message.limits, { pass, exact: pass > 0,
        cache, shouldCancel, elapsedMs: Date.now() - startedAt })) {
        if (shouldCancel()) { stopped(cancelled ? 'cancelled' : 'time_limit'); return; }
        // Initial row-by-row candidates are useful promptly. Subsequent passes
        // replace the whole evaluation atomically, including every later basis.
        if (!last?.complete || result.complete) {
          last = result;
          emit({ type: 'candidate', result }); emit({ type: 'decision', result });
          if (result.complete) emit({ type: 'proof', result });
        }
        await setImmediate();
      }
      if (last?.proof.kind === 'exact') { stopped('complete'); return; }
      const keep = new Set(last?.decisions.map(row => row.request.inputHash));
      for (const key of cache.keys()) if (!keep.has(key)) cache.delete(key);
      await setImmediate();
    }
    stopped('work_limit');
  } catch (error) {
    if (error instanceof ExactSolverError && error.code === 'CANCELLED') { stopped(cancelled ? 'cancelled' : 'time_limit'); return; }
    emit({ type: 'error', code: error instanceof ExactSolverError ? error.code : 'INVALID',
      message: error instanceof Error ? error.message : 'Could not find paths. Your tree is unchanged.' });
  }
}
