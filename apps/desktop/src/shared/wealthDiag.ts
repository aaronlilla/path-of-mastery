/** The connection check's records: what the app called, what came back, and answers it did not recognise. Safe to show and copy. */

export interface CallEntry {
  id: number;
  /** Epoch ms the request was sent. */
  at: number;
  method: string;
  /** Host and path only; query values for account, character and anything unknown are removed. */
  endpoint: string;
  policy: string;
  /** HTTP status; 0 when nothing answered. */
  status: number;
  ms: number;
  /** The rate-limit and retry headers seen on the answer, as sent. */
  headers: Record<string, string>;
  /** What the limiter decided before the request: sent at once, or waited this long, and the limits it holds after the answer. */
  limiter: { waitedMs: number; decision: string; limits: string };
  /** 'ok', 'shape mismatch', 'rate limited', 'refused', 'not found', 'server error', 'no answer'. */
  outcome: string;
}

export interface Diagnostic {
  id: number;
  at: number;
  endpoint: string;
  status: number;
  /** One sentence: what did not match. */
  problem: string;
  /** Field names the app needed and did not find. */
  missing: string[];
  /** Field names that were there (names only, never values). */
  found: string[];
  /** The text to copy. */
  text: string;
}

