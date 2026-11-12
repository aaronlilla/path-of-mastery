/**
 * The record of real calls to pathofexile.com (and poe.ninja), for the "Connection check" detail, and the diagnostics
 * for answers that do not look the way the app expects. Everything stored here is safe to show and to copy: query
 * values are dropped, and every string passes through `redact`, which removes the session cookie and the account name
 * (in plain and URL-encoded form) wherever they turn up.
 */

import type { CallEntry, Diagnostic } from '../../shared/wealthDiag.js';
export type { CallEntry, Diagnostic };

const KEEP_QUERY = new Set(['league', 'realm', 'tabs', 'tabIndex', 'type', 'query']);
const HEADER_KEEP = /^(x-rate-limit-|retry-after$|x-ratelimit)/i;

export class CallLog {
  private n = 0;
  private calls: CallEntry[] = [];
  private diags: Diagnostic[] = [];
  private secrets: () => string[] = () => [];

  /** The values that must never appear: the cookie and the account name. */
  setSecrets(fn: () => string[]): void {
    this.secrets = fn;
  }

  redact(text: string): string {
    let out = text;
    for (const s of this.secrets()) {
      if (!s || s.length < 3) continue;
      const forms = new Set([s, encodeURIComponent(s), s.replace(/#/g, '%23'), s.split('#')[0] ?? s]);
      for (const f of forms) if (f.length >= 3) out = out.split(f).join('[hidden]');
    }
    return out;
  }

  /** Host and path, with only harmless query values kept. */
  static endpoint(url: string): string {
    try {
      const u = new URL(url);
      const q = [...u.searchParams.entries()].map(([k, v]) => `${k}=${KEEP_QUERY.has(k) ? (k === 'query' ? '…' : v) : '…'}`).join('&');
      return `${u.host}${u.pathname.replace(/\/fetch\/[^/]+$/, '/fetch/<ids>')}${q ? '?' + q : ''}`;
    } catch {
      return 'unknown endpoint';
    }
  }

  static headersOf(h: { forEach(cb: (v: string, k: string) => void): void }): Record<string, string> {
    const out: Record<string, string> = {};
    h.forEach((v, k) => {
      if (HEADER_KEEP.test(k)) out[k.toLowerCase()] = v;
    });
    return out;
  }

  record(e: Omit<CallEntry, 'id'>): CallEntry {
    const entry: CallEntry = {
      ...e,
      id: ++this.n,
      endpoint: this.redact(e.endpoint),
      headers: Object.fromEntries(Object.entries(e.headers).map(([k, v]) => [k, this.redact(v)])),
      limiter: { ...e.limiter, decision: this.redact(e.limiter.decision), limits: this.redact(e.limiter.limits) },
    };
    this.calls.push(entry);
    if (this.calls.length > 80) this.calls.shift();
    return entry;
  }

  /** Builds and stores a diagnostic from field names only. */
  diagnose(d: { endpoint: string; status: number; problem: string; missing: string[]; found: string[]; at: number }): Diagnostic {
    const clean = (xs: string[]) => xs.slice(0, 40).map((x) => this.redact(x));
    const missing = clean(d.missing);
    const found = clean(d.found);
    const endpoint = this.redact(d.endpoint);
    const problem = this.redact(d.problem);
    const text = [
      'Path of Mastery diagnostic (no cookie, no account name, no item data)',
      `Endpoint: ${endpoint}`,
      `HTTP status: ${d.status}`,
      `Problem: ${problem}`,
      `Missing fields: ${missing.length ? missing.join(', ') : 'none'}`,
      `Fields found: ${found.length ? found.join(', ') : 'none'}`,
      `Time: ${new Date(d.at).toISOString()}`,
    ].join('\n');
    const diag: Diagnostic = { id: ++this.n, at: d.at, endpoint, status: d.status, problem, missing, found, text: this.redact(text) };
    this.diags.push(diag);
    if (this.diags.length > 10) this.diags.shift();
    return diag;
  }

  list(): CallEntry[] {
    return this.calls.map((c) => ({ ...c }));
  }

  diagnostics(): Diagnostic[] {
    return this.diags.map((d) => ({ ...d }));
  }

  /** The whole check as text to paste. */
  text(): string {
    const lines = ['Path of Mastery connection check (no cookie, no account name)'];
    for (const c of this.calls) {
      lines.push(`${new Date(c.at).toISOString()} ${c.method} ${c.endpoint} -> ${c.status || 'no answer'} (${c.outcome}, ${c.ms} ms) policy ${c.policy}; limiter: ${c.limiter.decision}; limits ${c.limiter.limits || 'unknown'}; headers ${Object.keys(c.headers).length ? Object.entries(c.headers).map(([k, v]) => `${k}: ${v}`).join(' | ') : 'none'}`);
    }
    for (const d of this.diags) lines.push('', d.text);
    return this.redact(lines.join('\n'));
  }
}

// ---- shape checks ---------------------------------------------------------------------------------------------------

export interface ShapeProblem {
  problem: string;
  missing: string[];
  found: string[];
}

const keys = (v: unknown): string[] => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v as object) : []);
const typeName = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'a list' : typeof v === 'object' ? 'an object' : `a ${typeof v}`);

/** Stash tab answer: `{ numTabs, tabs?, items[] }`. Items need a type line and a frame type to be priced. */
export function checkStash(body: unknown): ShapeProblem | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { problem: `Expected an object, got ${typeName(body)}.`, missing: ['numTabs', 'items'], found: [] };
  const b = body as Record<string, unknown>;
  const missing: string[] = [];
  if (!Array.isArray(b.items)) missing.push('items');
  if (typeof b.numTabs !== 'number') missing.push('numTabs');
  if (missing.length) return { problem: `The stash answer lacks ${missing.map((m) => `"${m}"`).join(' and ')}.`, missing, found: keys(b) };
  const sample = (b.items as unknown[]).slice(0, 5);
  const need = ['typeLine', 'frameType'];
  const lacking = need.filter((f) => sample.length > 0 && sample.every((i) => !i || typeof i !== 'object' || !(f in (i as object))));
  if (lacking.length) return { problem: `Items in the stash answer lack ${lacking.map((m) => `"${m}"`).join(' and ')}, so they cannot be priced.`, missing: lacking, found: keys(sample[0]) };
  return null;
}

export function checkCharacters(body: unknown): ShapeProblem | null {
  if (!Array.isArray(body)) return { problem: `Expected a list of characters, got ${typeName(body)}.`, missing: ['(list)'], found: keys(body) };
  const need = ['name', 'league', 'level'];
  const lacking = need.filter((f) => body.length > 0 && body.every((c) => !c || typeof c !== 'object' || !(f in (c as object))));
  return lacking.length ? { problem: `Characters lack ${lacking.map((m) => `"${m}"`).join(', ')}.`, missing: lacking, found: keys(body[0]) } : null;
}

export function checkCharacterItems(body: unknown): ShapeProblem | null {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== 'object' || !Array.isArray(b.items)) return { problem: 'The character answer has no "items" list.', missing: ['items'], found: keys(body) };
  return null;
}

export function checkTradeSearch(body: unknown): ShapeProblem | null {
  const b = body as Record<string, unknown> | null;
  const missing: string[] = [];
  if (!b || typeof b.id !== 'string') missing.push('id');
  if (!b || !Array.isArray(b.result)) missing.push('result');
  return missing.length ? { problem: `The trade search answer lacks ${missing.map((m) => `"${m}"`).join(' and ')}.`, missing, found: keys(body) } : null;
}

export function checkTradeFetch(body: unknown): ShapeProblem | null {
  const b = body as Record<string, unknown> | null;
  if (!b || !Array.isArray(b.result)) return { problem: 'The trade fetch answer has no "result" list.', missing: ['result'], found: keys(body) };
  const sample = (b.result as unknown[]).filter((x) => x && typeof x === 'object').slice(0, 5) as Record<string, unknown>[];
  const lacking = ['id', 'listing', 'item'].filter((f) => sample.length > 0 && sample.every((r) => !(f in r)));
  return lacking.length ? { problem: `Listings lack ${lacking.map((m) => `"${m}"`).join(', ')}.`, missing: lacking, found: keys(sample[0]) } : null;
}
