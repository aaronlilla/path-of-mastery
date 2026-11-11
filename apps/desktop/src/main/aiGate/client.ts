import type { ApiResult, ValidationLimits } from '@pom/mastery-contracts';
import { AiDenied, type AiBackend, type AiActor } from './gate.js';
import type { AiRoute } from './clearance.js';

export function createAiBackend(d: {
  baseUrl: string; installation: string; accountId(): string | null; token(): Promise<string | null>;
  appHeaders(route: string, body: unknown, accountId: string): Promise<Record<string, string>>;
  /** A still-valid cleared human check for this request, if one is cached. */
  clearanceHeaders?(route: AiRoute, body: unknown, actor: AiActor): Promise<Record<string, string>>;
  /** Called when the site answers HUMAN_CHECK_REQUIRED: shows the check, resolves with the clearance headers, or null if the person declined. The request is retried once. */
  humanCheck?(route: AiRoute, body: unknown, actor: AiActor): Promise<Record<string, string> | null>;
  /** What the retry returned. askingAgain: the check was refused again and the person is asked for a fresh one (the request is kept). */
  humanCheckOutcome?(route: AiRoute, body: unknown, actor: AiActor, result: ApiResult<unknown>, askingAgain: boolean): void;
  limits: ValidationLimits; fetch?: typeof fetch; allowLoopback?: boolean;
}): AiBackend {
  const base = new URL(d.baseUrl);
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/'
    || (base.protocol !== 'https:' && !(d.allowLoopback && base.protocol === 'http:' && base.hostname === '127.0.0.1'))
    || !/^[a-f0-9]{64}$/.test(d.installation)) throw new AiDenied('VALIDATION_FAILED');
  const backend: AiBackend = {
    async post<T>(route: Parameters<AiBackend['post']>[0], body: unknown, actor: Parameters<AiBackend['post']>[2], signal?: AbortSignal): Promise<ApiResult<T>> {
      const first = await attempt<T>(route, body, actor, signal, undefined);
      if (first.ok || first.code !== 'HUMAN_CHECK_REQUIRED' || !d.humanCheck || route === 'revoke') return first;
      // Each round needs a person to pass a fresh check and press Continue, so this is not a retry loop that could leak access; the
      // cap only bounds a site that keeps refusing valid clearances.
      let result: ApiResult<T> = first;
      for (let round = 1; ; round++) {
        let cleared: Record<string, string> | null = null;
        try { cleared = await d.humanCheck(route, body, actor); } catch { cleared = null; }
        if (!cleared || !Object.keys(cleared).length) return result;
        result = await attempt<T>(route, body, actor, signal, cleared);
        const again = !result.ok && result.code === 'HUMAN_CHECK_REQUIRED' && round < 5 && !signal?.aborted;
        d.humanCheckOutcome?.(route, body, actor, result, again);
        if (!again) return result;
      }
    },
  };
  async function attempt<T>(route: Parameters<AiBackend['post']>[0], body: unknown, actor: Parameters<AiBackend['post']>[2], signal: AbortSignal | undefined, cleared: Record<string, string> | undefined): Promise<ApiResult<T>> {
    {
      const account = d.accountId();
      if (!account) return { ok: false, code: 'SIGN_IN_REQUIRED', message: 'Sign in to use the assistant' };
      const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
      const current = () => {
        if (account !== d.accountId() || signal?.aborted) throw new AiDenied('CONNECTION_REVOKED');
        if (requestSignal.aborted) throw new AiDenied('ENTITLEMENT_UNAVAILABLE');
      };
      try {
        current();
        const token = await d.token();
        current();
        if (!token) return { ok: false, code: 'SIGN_IN_REQUIRED', message: 'Sign in to use the assistant' };
        const app = actor.clientId === null || route === 'revoke' || (route === 'pair' && (body as { action?: string }).action === 'allow');
        const headers = { ...(cleared ?? await d.clearanceHeaders?.(route, body, actor)),
          ...(app ? await d.appHeaders(route, body, account) : {}),
          'content-type': 'application/json', Authorization: `Bearer ${token}`, 'x-pom-installation': d.installation,
          ...(actor.proof ? { 'x-pom-client-proof': actor.proof } : {}) };
        current();
        const res = await (d.fetch ?? fetch)(new URL(`/api/ai/${route}`, base), {
          method: 'POST', redirect: 'error', headers, body: JSON.stringify(body),
          signal: requestSignal,
        });
        const reader = res.body?.getReader(); if (!reader) throw new AiDenied('ENTITLEMENT_UNAVAILABLE');
        const chunks: Uint8Array[] = []; let size = 0;
        const cancel = () => { void reader.cancel().catch(() => undefined); };
        requestSignal.addEventListener('abort', cancel, { once: true });
        try {
          while (true) {
            current();
            const { done, value } = await reader.read();
            current();
            if (done) break;
            size += value.byteLength;
            if (size > d.limits.maxBytes) { await reader.cancel(); throw new AiDenied('LIMIT_EXCEEDED'); }
            chunks.push(value);
          }
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ApiResult<T>;
          current();
          if (!res.ok && (!result || result.ok !== false)) throw new AiDenied('ENTITLEMENT_UNAVAILABLE');
          return result;
        } catch (error) {
          await reader.cancel().catch(() => undefined); throw error;
        } finally { requestSignal.removeEventListener('abort', cancel); reader.releaseLock(); }
      } catch (e) {
        if (!(e instanceof AiDenied)) console.error(`[aiGate] /api/ai/${route} failed:`, e);
        const code = e instanceof AiDenied ? e.code : 'ENTITLEMENT_UNAVAILABLE';
        return { ok: false, code, message: 'Could not authorize this request.' };
      }
    }
  }
  return backend;
}
