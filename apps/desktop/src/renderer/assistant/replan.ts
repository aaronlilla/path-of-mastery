/** A Solve update waiting to go to the AI as a turn of its own. */
export interface Replan {
  key: string;
  text: string;
}

/**
 * Sends the waiting Solve update as a turn. The update is cleared only after that turn has started: when the AI gate
 * blocks (`start` resolves false) it stays queued and a later call sends it. `sent` marks the key at once so a push that
 * arrives while the start is pending cannot send it twice.
 */
export function flushReplanUpdate(waiting: { current: Replan | null }, sent: { current: string }, turnLive: boolean, start: (text: string) => Promise<boolean>): void {
  const r = waiting.current;
  if (!r || turnLive || sent.current === r.key) return;
  const before = sent.current;
  sent.current = r.key;
  void start(r.text).then((started) => {
    if (!started) {
      if (sent.current === r.key) sent.current = before;
    } else if (waiting.current === r) waiting.current = null;
  });
}
