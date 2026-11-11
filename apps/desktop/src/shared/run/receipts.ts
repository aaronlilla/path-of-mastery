import type { CompletionReceipt, FinishMethod, ScheduledBundle } from '@pom/mastery-contracts';
import { contentHash } from '../timelines/adapters/common.js';
import { dueBundles, finalTriggerPredicate } from '../timelines/scheduler/index.js';
import type { ReceiptEntry, ReceiptEvidence, RunSession } from './types.js';

export async function finalEvidence(s: RunSession): Promise<ScheduledBundle | null> {
  const final = s.schedule.groups.at(-1);
  if (!final) return null;
  // Reviewed coverage cannot hide a final trigger from the evidence predicate.
  const due = await dueBundles(s.schedule, s.ledger);
  const candidate = due.find(bundle => final.actionIds.every(id => bundle.actionIds.includes(id))) ?? final;
  return await finalTriggerPredicate(candidate, s.schedule, s.ledger) ? candidate : null;
}
export const receiptEvidence = (receipt: CompletionReceipt): ReceiptEvidence =>
  ({ origin: 'live', context: 'continuous', observations: [{ trigger: structuredClone(receipt.finalTrigger), observedAt: receipt.evidenceSummary.observedAt }] });
export async function makeReceipt(s: RunSession, accountId: string | null, method: FinishMethod, at: string,
  countRuns: boolean): Promise<ReceiptEntry | null> {
  if (!accountId || !countRuns || !s.snapshot.publishedOrigin || !s.snapshot.actions.length) return null;
  const final = method === 'final_trigger_observed' ? await finalEvidence(s) : s.schedule.groups.at(-1);
  if (!final) return null;
  const pin = s.snapshot.publishedOrigin;
  const receipt: CompletionReceipt = { schemaVersion: 1, stamp: structuredClone(s.snapshot.stamp), publishedRevision: structuredClone(pin),
    method, finalTrigger: structuredClone(final.trigger), finalActionFingerprint: final.fingerprint,
    evidenceSummary: { kind: method === 'final_trigger_observed' ? 'log_trigger_match' : 'player_confirmation', observedAt: at },
    idempotencyKey: `finish:${await contentHash([accountId, pin.postId, pin.revisionId])}` };
  return method === 'final_trigger_observed' ? { accountId, receipt, evidence: receiptEvidence(receipt) } : { accountId, receipt };
}
