export type SignalCategory = 'debug' | 'untrusted' | 'timing' | 'background';
export type SignalSummary = { ruleVersion: string; categories: SignalCategory[]; observedAt: string; expiresAt: string };
export type SignalInput = { source: 'user' | 'run' | 'scheduler' | 'log'; debug?: boolean; trusted?: boolean; regularTiming?: boolean; focused?: boolean };

/** Main owns this collector. Renderer hints cannot add authority or retain activity. */
export function summarizeSignals(inputs: readonly SignalInput[], ruleVersion: string, now: number, ttlMs: number): SignalSummary {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(ruleVersion) || !Number.isSafeInteger(ttlMs) || ttlMs <= 0 || !Number.isFinite(now)) throw new Error('VALIDATION_FAILED');
  const categories = new Set<SignalCategory>();
  for (const input of inputs) {
    if (input.source !== 'user') continue;
    if (input.debug) categories.add('debug');
    if (input.trusted === false) categories.add('untrusted');
    if (input.regularTiming) categories.add('timing');
    if (input.focused === false) categories.add('background');
  }
  return { ruleVersion, categories: [...categories].sort(), observedAt: new Date(now).toISOString(), expiresAt: new Date(now + ttlMs).toISOString() };
}

export function signalState(summary: SignalSummary, now: number): 'clear' | 'uncertain' {
  const expiry = Date.parse(summary.expiresAt);
  if (!Number.isFinite(now) || !Number.isFinite(expiry) || expiry <= now) return 'uncertain';
  // Focus, timing and input method never independently require a challenge.
  return summary.categories.includes('debug') && summary.categories.includes('untrusted') ? 'uncertain' : 'clear';
}
