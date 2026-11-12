import { apiResultSchema,networkClearanceSchema,pendingIntentSchema,isId,type ApiResult,type NetworkClearance,type PendingIntent,type ValidationLimits } from '@pom/mastery-contracts';
export type GateChallenge = { challengeId: string; nonce: string; contextHash: string; provider: string; requestHash: string; expiresAt: string };
export type ChallengeView = { challenge: GateChallenge; presentation: { url: string; accessibleUrl: string | null } };
export type NetworkClientOptions = { origin: string; localTest?: boolean; limits: ValidationLimits;
  sessionId: string | null; clientId: string | null; headers(body: unknown): Promise<Record<string,string>>; fetch?: typeof fetch };
/** Kept in main. Auth/channel proofs and provider response tokens never enter URLs, settings or logs. */
export function createNetworkClient(options: NetworkClientOptions) {
  const origin = new URL(options.origin);
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash
    || (origin.protocol !== 'https:' && !(options.localTest && origin.protocol === 'http:' && ['127.0.0.1','[::1]'].includes(origin.hostname)))) throw new Error('VALIDATION_FAILED');
  const resultSchema = apiResultSchema<unknown>({ parse: value => ({ ok: true,value }) });
  async function post(operation: string,body: unknown): Promise<ApiResult<unknown>> {
    try {
      const res = await (options.fetch ?? fetch)(`${origin.origin}/api/network/${operation}`,{ method: 'POST',
        headers: { ...await options.headers(body),'content-type': 'application/json' },body: JSON.stringify(body),signal: AbortSignal.timeout(10000),redirect: 'error' });
      const reader = res.body?.getReader(); if (!reader) throw new Error('UNAVAILABLE');
      const chunks: Uint8Array[] = []; let bytes = 0;
      try {
        while (true) { const next = await reader.read(); if (next.done) break; bytes += next.value.length;
          if (bytes > options.limits.maxBytes) { await reader.cancel(); throw new Error('UNAVAILABLE'); } chunks.push(next.value); }
      } finally { reader.releaseLock(); }
      const buffer = new Uint8Array(bytes); let at = 0; for (const chunk of chunks) { buffer.set(chunk,at); at += chunk.length; }
      const value: unknown = JSON.parse(new TextDecoder('utf-8',{ fatal: true }).decode(buffer)); const parsed = resultSchema.parse(value,options.limits);
      if (!parsed.ok) throw new Error('UNAVAILABLE'); return parsed.value;
    } catch { return { ok: false,code: 'HUMAN_CHECK_REQUIRED',message: 'The check is unavailable. Try again later.' }; }
  }
  function base(intent: PendingIntent) {
    if (!pendingIntentSchema.parse(intent,options.limits).ok) throw new Error('VALIDATION_FAILED');
    return { intent,sessionId: options.sessionId,clientId: options.clientId };
  }
  async function challenge(intent: PendingIntent,accessible = false): Promise<ApiResult<ChallengeView>> {
    const result = await post('challenge',{ ...base(intent),accessible }); if (!result.ok) return result;
    const view = result.value as ChallengeView; const c = view?.challenge;
    try {
      if (!c || !isId('object',c.challengeId) || !isId('object',c.nonce) || !isId('hash',c.contextHash)
        || c.requestHash !== intent.requestHash || Date.parse(c.expiresAt) <= Date.now() || !Number.isFinite(Date.parse(c.expiresAt))) throw new Error('UNAVAILABLE');
      for (const url of [view.presentation.url,view.presentation.accessibleUrl]) if (url !== null) {
        const target = new URL(url); if (target.protocol !== 'https:' || target.username || target.password) throw new Error('UNAVAILABLE');
      }
      return { ok: true,value: view };
    } catch { return { ok: false,code: 'HUMAN_CHECK_REQUIRED',message: 'The check is unavailable. Try again later.' }; }
  }
  async function verify(intent: PendingIntent,challenge: GateChallenge,token: string): Promise<ApiResult<NetworkClearance>> {
    const result = await post('verify',{ ...base(intent),challenge,token }); if (!result.ok) return result;
    const parsed = networkClearanceSchema.parse(result.value,options.limits);
    return parsed.ok ? { ok: true,value: parsed.value } : { ok: false,code: 'HUMAN_CHECK_REQUIRED',message: 'Could not finish the check. Try again.' };
  }
  async function admit(intent: PendingIntent,clearance: NetworkClearance): Promise<NetworkClearance> {
    if (clearance.status !== 'clear') return { status: 'unavailable',retryAt: null };
    const result = await post('admit',{ ...base(intent),clearanceId: clearance.clearanceId });
    if (!result.ok) return { status: 'unavailable',retryAt: result.retryAt ?? null };
    const value = result.value as { clearance?: unknown; resumePolicy?: unknown };
    const parsed = networkClearanceSchema.parse(value.clearance,options.limits);
    return parsed.ok && value.resumePolicy === intent.resumePolicy ? parsed.value : { status: 'unavailable',retryAt: null };
  }
  return { challenge,verify,admit,revoke: () => post('revoke',{}) };
}
