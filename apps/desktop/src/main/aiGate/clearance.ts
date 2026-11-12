// Human check for AI calls. The site answers HUMAN_CHECK_REQUIRED when a request has no cleared check;
// the main process then asks the renderer to show the network gate's dialog, verifies the provider token with the site, and the
// backend retries that one request once with the clearance headers. A passed check is cached until the site's expiry.
// Soft check: the site only asks when its risk rules trip, and a passed check clears the account for a
// server session window (6 h default) for all actions. So this runs rarely, once per trip; nothing here asks ahead of time.
import { createHash, randomUUID } from 'node:crypto';
import type { PendingIntent, RevisionRef } from '@pom/mastery-contracts';
import { hashJson, type AiActor } from './gate.js';

export type AiRoute = 'session' | 'authorize' | 'request' | 'pair' | 'revoke';
export type AiBinding = { requestHash: PendingIntent['requestHash']; sessionId: string | null; target: RevisionRef };

/** Mirrors what the site hands its clearance hook as `requestHash` for each route. */
export function aiBinding(route: AiRoute, body: unknown, installation: string, actor: AiActor): AiBinding | null {
  const b = (body ?? {}) as Record<string, any>;
  try {
    if (route === 'session' || (route === 'pair' && b.action !== 'list')) {
      const target = b.targets?.[0] as RevisionRef | undefined; if (!target) return null;
      const proofHash = actor.proof ? createHash('sha256').update(actor.proof, 'utf8').digest('hex') : null;
      return { requestHash: hashJson({ body, installationHash: installation, proofHash }), sessionId: null, target };
    }
    if (route === 'authorize' || route === 'request') {
      if (typeof b.sessionId !== 'string' || !b.request?.requestHash || !b.request?.target) return null;
      return { requestHash: b.request.requestHash, sessionId: b.sessionId, target: b.request.target as RevisionRef };
    }
  } catch { /* fall through */ }
  return null;
}

type Cleared = { clearanceId: string; intent: PendingIntent; expiresAt: number };
export const intentHeaders = (c: Cleared): Record<string, string> =>
  ({ 'x-pom-clearance': c.clearanceId, 'x-pom-network-intent': Buffer.from(JSON.stringify(c.intent)).toString('base64url') });

export function createAiClearances(d: { now?: () => number; cooldownMs?: number }) {
  const now = d.now ?? Date.now;
  const cache = new Map<string, Cleared>();
  const key = (account: string, b: AiBinding) => `${account}|${b.sessionId ?? ''}|${b.requestHash}`;
  let declinedUntil = 0;
  return {
    cached(account: string, b: AiBinding): Record<string, string> | null {
      const k = key(account, b), hit = cache.get(k);
      if (!hit) return null;
      if (hit.expiresAt <= now() + 2000) { cache.delete(k); return null; }
      return intentHeaders(hit);
    },
    /** The site refused this clearance (it ran out there): forget it so the next round asks for a fresh check. */
    drop(account: string, b: AiBinding): void { cache.delete(key(account, b)); },
    store(account: string, b: AiBinding, clearanceId: string, intent: PendingIntent, expiresAt: string): void {
      const at = Date.parse(expiresAt);
      if (Number.isFinite(at)) cache.set(key(account, b), { clearanceId, intent, expiresAt: at });
    },
    newIntent(account: string, b: AiBinding): PendingIntent {
      return { schemaVersion: 1, requestId: randomUUID(), idempotencyKey: randomUUID(), accountBinding: account, target: b.target,
        requestHash: b.requestHash, operation: 'external_edit', resumePolicy: 'return_to_review' };
    },
    /** After the person chose "Keep working locally", do not reopen the dialog for every retry of the same feature. */
    declined(): void { declinedUntil = now() + (d.cooldownMs ?? 60_000); },
    coolingDown(): boolean { return now() < declinedUntil; },
    /** A passed check now clears the whole account for the server's session window, so an earlier decline no longer applies. */
    passed(): void { declinedUntil = 0; },
    clear(): void { cache.clear(); declinedUntil = 0; },
  };
}
export type AiClearances = ReturnType<typeof createAiClearances>;
