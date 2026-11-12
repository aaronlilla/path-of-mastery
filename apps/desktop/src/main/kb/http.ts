import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Polite HTTP for the KB: one identifiable User-Agent with a contact, conditional requests from an on-disk cache
 * (ETag / Last-Modified), a minimum gap per host, and back-off on 429 / 5xx. Public pages only.
 */

export const KB_UA = 'PathOfMasteryKB/0.1 (+https://github.com/aaronlilla/path-of-mastery)';

const DEFAULT_GAP_MS: Record<string, number> = {
  'www.pathofexile.com': 1100,
  'www.poewiki.net': 1000,
  'poe.ninja': 1000,
};

export interface HttpResult {
  status: number;
  body: string;
  etag?: string;
  lastModified?: string;
  /** True when the server said 304 (or we served the cache after an error). */
  fromCache: boolean;
  fetchedAt: string;
}

interface CacheEntry { url: string; etag?: string; lastModified?: string; body: string; fetchedAt: string }

export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;

export class PoliteHttp {
  private last = new Map<string, number>();
  constructor(
    private readonly opts: { cacheDir?: string; fetch?: FetchLike; gapMs?: Record<string, number>; log?: (m: string) => void; timeoutMs?: number } = {},
  ) {}

  private async wait(url: string): Promise<void> {
    const host = new URL(url).host;
    const gap = this.opts.gapMs?.[host] ?? DEFAULT_GAP_MS[host] ?? 250;
    const at = this.last.get(host) ?? 0;
    const delay = at + gap - Date.now();
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    this.last.set(host, Date.now());
  }

  private cacheFile(url: string): string | null {
    if (!this.opts.cacheDir) return null;
    return join(this.opts.cacheDir, 'http', createHash('sha1').update(url).digest('hex') + '.json');
  }

  private async readCache(url: string): Promise<CacheEntry | null> {
    const f = this.cacheFile(url);
    if (!f) return null;
    try {
      return JSON.parse(await readFile(f, 'utf8')) as CacheEntry;
    } catch {
      return null;
    }
  }

  private async writeCache(e: CacheEntry): Promise<void> {
    const f = this.cacheFile(e.url);
    if (!f) return;
    await mkdir(join(this.opts.cacheDir!, 'http'), { recursive: true });
    await writeFile(f, JSON.stringify(e));
  }

  /** GET text with a conditional request. `maxAgeMs`: serve the cache without asking when it is that fresh. */
  async text(url: string, o: { maxAgeMs?: number; accept?: string } = {}): Promise<HttpResult> {
    const cached = await this.readCache(url);
    if (cached && o.maxAgeMs && Date.now() - Date.parse(cached.fetchedAt) < o.maxAgeMs) {
      return { status: 200, body: cached.body, etag: cached.etag, lastModified: cached.lastModified, fromCache: true, fetchedAt: cached.fetchedAt };
    }
    const headers: Record<string, string> = { 'User-Agent': KB_UA, Accept: o.accept ?? '*/*' };
    if (cached?.etag) headers['If-None-Match'] = cached.etag;
    if (cached?.lastModified) headers['If-Modified-Since'] = cached.lastModified;
    const res = await this.request(url, headers);
    const now = new Date().toISOString();
    if (res.status === 304 && cached) {
      await this.writeCache({ ...cached, fetchedAt: now });
      return { status: 200, body: cached.body, etag: cached.etag, lastModified: cached.lastModified, fromCache: true, fetchedAt: now };
    }
    if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
    const body = await res.text();
    const etag = res.headers.get('etag') ?? undefined;
    const lastModified = res.headers.get('last-modified') ?? undefined;
    await this.writeCache({ url, etag, lastModified, body, fetchedAt: now });
    return { status: res.status, body, etag, lastModified, fromCache: false, fetchedAt: now };
  }

  async json<T>(url: string, o: { maxAgeMs?: number } = {}): Promise<{ data: T } & Omit<HttpResult, 'body'>> {
    const r = await this.text(url, { ...o, accept: 'application/json' });
    return { ...r, data: JSON.parse(r.body) as T };
  }

  /** GET bytes (CDN bundles). No conditional cache here: callers cache by patch. */
  async bytes(url: string): Promise<Uint8Array> {
    const res = await this.request(url, { 'User-Agent': KB_UA });
    if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  private async request(url: string, headers: Record<string, string>): Promise<Response> {
    const f = this.opts.fetch ?? (globalThis.fetch as FetchLike);
    for (let attempt = 0; ; attempt++) {
      await this.wait(url);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 60_000);
      let res: Response;
      try {
        res = await f(url, { headers, signal: ctrl.signal });
      } catch (e) {
        clearTimeout(timer);
        if (attempt >= 2) throw e;
        this.opts.log?.(`retry ${url}: ${(e as Error).message}`);
        await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
        continue;
      }
      clearTimeout(timer);
      if ((res.status === 429 || res.status >= 500) && attempt < 2) {
        const ra = Number(res.headers.get('retry-after'));
        const delay = Number.isFinite(ra) && ra > 0 ? Math.min(ra, 120) * 1000 : 5000 * (attempt + 1);
        this.opts.log?.(`HTTP ${res.status} on ${url}; backing off ${delay} ms`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      return res;
    }
  }
}
