import type { EditTransaction, RevisionCheckpoint, RevisionRef, TransactionId } from '@pom/mastery-contracts';

export function historyPath(events: readonly EditTransaction[], tip: TransactionId): EditTransaction[] {
  const byId = new Map(events.map(event => [event.transactionId, event]));
  if (byId.size !== events.length) throw new Error('Duplicate history transaction.');
  const path: EditTransaction[] = [];
  const seen = new Set<TransactionId>();
  let id: TransactionId | null = tip;
  while (id !== null) {
    if (seen.has(id)) throw new Error('History contains a cycle.');
    seen.add(id);
    const event = byId.get(id);
    if (!event) throw new Error('History transaction is missing.');
    path.push(event);
    id = event.parentTransactionId;
  }
  return path.reverse();
}

export function redoTransaction(events: readonly EditTransaction[], cursor: TransactionId, tip: TransactionId): EditTransaction | null {
  const path = historyPath(events, tip);
  const index = path.findIndex(event => event.transactionId === cursor);
  if (index < 0) throw new Error('History cursor is outside the active branch.');
  return path[index + 1] ?? null;
}

export function replayRevision(events: readonly EditTransaction[], checkpoints: readonly RevisionCheckpoint[], target: TransactionId): RevisionRef {
  const path = historyPath(events, target);
  let start = 0;
  let revision = path[0]!.after;
  for (let index = path.length - 1; index >= 0; index--) {
    const event = path[index]!;
    const checkpoint = checkpoints.find(entry => entry.transactionId === event.transactionId);
    if (!checkpoint) continue;
    if (JSON.stringify(checkpoint.revision) !== JSON.stringify(event.after)) throw new Error('Checkpoint does not match its transaction.');
    revision = checkpoint.revision;
    start = index + 1;
    break;
  }
  for (const event of path.slice(start)) revision = event.after;
  return revision;
}

/** A caller flushes on blur or when its idle timer reaches dueAt. */
export class TextEditGroup<T> {
  private pending: { before: T; after: T; dueAt: number } | null = null;

  push(before: T, after: T, now: number): { before: T; after: T } | null {
    const ready = this.flush(now);
    this.pending = { before: this.pending?.before ?? before, after, dueAt: now + 500 };
    return ready;
  }

  get dueAt(): number | null { return this.pending?.dueAt ?? null; }

  flush(now: number, blur = false): { before: T; after: T } | null {
    if (!this.pending || (!blur && now < this.pending.dueAt)) return null;
    const { before, after } = this.pending;
    this.pending = null;
    return { before, after };
  }
}
