import { backendConfig } from '../accounts/config.js';

/**
 * In an official build poe.ninja goes through the hosted backend, as poe.ninja's API docs ask of desktop apps. When
 * the backend fails (down, offline route) the same request, same headers, goes straight to poe.ninja, and the backend is
 * skipped for a while so a dead route does not double every request. A build without a backend always goes direct.
 */
export function ninjaBase(): string {
  const site = backendConfig()?.siteOrigin;
  return site ? `${site}/api/ninja/poe1/api` : NINJA_DIRECT_BASE;
}
export const NINJA_DIRECT_BASE = 'https://poe.ninja/poe1/api';
export const PROXY_RETRY_MS = 10 * 60_000;

type Res = { ok: boolean; status: number };

/** Wraps a fetch that is given ninjaBase() URLs. */
export function withNinjaFallback<A extends unknown[], R extends Res>(f: (url: string, ...rest: A) => Promise<R>, now: () => number = Date.now): (url: string, ...rest: A) => Promise<R> {
  let proxyDownAt = -Infinity;
  return async (url, ...rest) => {
    const proxy = ninjaBase();
    const direct = proxy !== NINJA_DIRECT_BASE && url.startsWith(proxy) ? NINJA_DIRECT_BASE + url.slice(proxy.length) : null;
    if (!direct) return f(url, ...rest);
    if (now() - proxyDownAt >= PROXY_RETRY_MS) {
      try {
        const r = await f(url, ...rest);
        if (r.ok || r.status === 304) return r;
      } catch {
        /* fall through to poe.ninja */
      }
      proxyDownAt = now();
    }
    return f(direct, ...rest);
  };
}
