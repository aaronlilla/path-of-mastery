import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseUpdatePolicyDoc, type UpdatePolicyDoc } from '@pom/protocol/updatePolicy';
import type { FetchLike } from './manifestClient.js';

/**
 * The server-side update policy: `updatePolicy` of the remote config document
 * (`GET /api/app/config`). Unsigned, so it is only ever used to hold back, pause, block or require a version the signed
 * manifest already allows (protocol updateDecision). Fail safe: never fetched = null = the signed manifest alone decides;
 * a failed or malformed fetch keeps the last good policy (memory, then the cache file), indefinitely, offline included.
 */
export class UpdatePolicySource {
  private doc: UpdatePolicyDoc | null = null;
  private etag: string | undefined;

  constructor(private readonly o: { url: string | null; cacheFile?: string; fetchImpl?: FetchLike; timeoutMs?: number; log?: (m: string) => void }) {}

  current(): UpdatePolicyDoc | null {
    return this.doc;
  }

  /** The last good policy from the cache file (call once at start, before the first check). */
  async load(): Promise<void> {
    if (!this.o.cacheFile) return;
    try {
      const c = JSON.parse(await readFile(this.o.cacheFile, 'utf8')) as { policy?: unknown; etag?: string };
      this.doc = c.policy === undefined ? null : parseUpdatePolicyDoc(c.policy);
      this.etag = typeof c.etag === 'string' ? c.etag : undefined;
    } catch { /* none yet */ }
  }

  /**
   * Fetches the config document (If-None-Match). One deadline (3 s) covers the whole exchange, headers, body and parse:
   * the request is aborted and the race lost when it passes, so a stalled body can never hold a check. Returns whether the
   * policy changed.
   */
  async refresh(): Promise<{ ok: boolean; changed: boolean }> {
    if (!this.o.url) return { ok: false, changed: false };
    const before = JSON.stringify(this.doc);
    const abort = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, no) => {
      timer = setTimeout(() => {
        abort.abort();
        no(new Error('timed out'));
      }, this.o.timeoutMs ?? 3000);
    });
    try {
      const f = this.o.fetchImpl ?? (fetch as unknown as FetchLike);
      const headers: Record<string, string> = this.etag ? { 'If-None-Match': this.etag } : {};
      const url = this.o.url;
      const { r, body } = await Promise.race([
        (async () => {
          const r = await f(url, { headers, signal: abort.signal });
          if (r.status === 304) return { r, body: null };
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return { r, body: (await r.json()) as { updatePolicy?: unknown } };
        })(),
        deadline,
      ]);
      if (r.status === 304) return { ok: true, changed: false };
      this.doc = parseUpdatePolicyDoc(body?.updatePolicy ?? {});
      this.etag = r.headers?.get('etag') ?? undefined;
      if (this.o.cacheFile) {
        await mkdir(dirname(this.o.cacheFile), { recursive: true }).catch(() => {});
        await writeFile(this.o.cacheFile, JSON.stringify({ policy: this.doc, etag: this.etag, fetchedAt: new Date().toISOString() }), 'utf8').catch(() => {});
      }
      return { ok: true, changed: JSON.stringify(this.doc) !== before };
    } catch (e) {
      abort.abort();
      this.o.log?.(`update policy not refreshed (${e instanceof Error ? e.message : String(e)}); keeping ${this.doc ? 'the last good one' : 'the signed manifest alone'}`);
      return { ok: false, changed: false };
    } finally {
      clearTimeout(timer);
      deadline.catch(() => {});
    }
  }
}
