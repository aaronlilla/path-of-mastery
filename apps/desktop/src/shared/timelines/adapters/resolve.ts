import type { FrozenSource, SourceCredit, SourceSnapshot, ValidationLimits } from '@pom/mastery-contracts';
import { contentHash, TimelineSourceError, verifySource } from './common.js';

export async function resolvePinnedSource(source: FrozenSource, credit: SourceCredit | null,
  lookup: ((ref: FrozenSource['ref']) => Promise<{ status: 'available'; snapshot: SourceSnapshot } | { status: 'removed' | 'unavailable' }>) | null,
  limits: ValidationLimits) {
  const frozen = await verifySource(source, limits);
  const result = lookup ? await lookup(structuredClone(frozen.ref)).catch(() => ({ status: 'unavailable' as const })) : { status: 'unavailable' as const };
  if (result.status === 'available' && await contentHash(result.snapshot) !== frozen.ref.fallbackSnapshotHash) {
    throw new TimelineSourceError('HASH_MISMATCH', 'The fetched revision does not match the pinned source.');
  }
  return { source: frozen, usingFallback: result.status !== 'available',
    credit: credit ? { ...structuredClone(credit), status: result.status === 'removed' ? 'original_removed' as const : credit.status } : null };
}
