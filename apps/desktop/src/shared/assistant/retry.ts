import type { ThreadMessage } from './types.js';

/** Retry asks the last question again: it drops what the failed attempt left after the question, but keeps the cards that already went into the build. */
export function afterRetry(messages: ThreadMessage[], questionAt: number): ThreadMessage[] {
  return [...messages.slice(0, questionAt + 1), ...messages.slice(questionAt + 1).filter((m) => (m.role === 'proposal' && m.proposal?.status === 'applied') || m.role === 'receipt')];
}
