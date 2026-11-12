// A read tool called twice in one answer with the same arguments, while the build has not changed, costs a model turn for
// nothing. The tool layer answers the second call with a short "you already have this" note instead of running it again.

/** Tools whose result only depends on the build and their arguments. */
export const READ_ONCE = new Set(['getBuildSummary', 'getPointBudget', 'getItems', 'getConfigOptions', 'getWarnings', 'getSkills', 'getStats', 'getTree', 'getNotes']);

export class ReadOnce {
  private epoch = 0;
  private readonly seen = new Map<string, Map<string, { epoch: number; state?: string; ref?: string }>>();

  private key(tool: string, args: Record<string, unknown>): string {
    return `${tool}|${JSON.stringify(args ?? {})}`;
  }

  /** The build changed (a change was applied): earlier reads no longer hold. */
  changed(): void {
    this.epoch++;
  }

  /** Remembers a read of this turn; `ref` is the stored result the model can cite, `state` a fingerprint of the build it read (Undo and the player's own edits change it). */
  note(turnId: string, tool: string, args: Record<string, unknown>, ref?: string, state?: string): void {
    if (!READ_ONCE.has(tool)) return;
    let m = this.seen.get(turnId);
    if (!m) this.seen.set(turnId, (m = new Map()));
    m.set(this.key(tool, args), { epoch: this.epoch, state, ...(ref ? { ref } : {}) });
  }

  /** The short answer for a repeat read, or null when the tool should run. */
  repeat(turnId: string, tool: string, args: Record<string, unknown>, state?: string): Record<string, unknown> | null {
    const hit = this.seen.get(turnId)?.get(this.key(tool, args));
    if (!hit || hit.epoch !== this.epoch || hit.state !== state) return null;
    return { alreadyHave: true, ...(hit.ref ? { ref: hit.ref } : {}), note: `You already hold this ${tool} result from earlier in this answer${hit.ref ? ` (ref ${hit.ref})` : ''} and the build has not changed since: use it, do not read it again.` };
  }

  done(turnId: string): void {
    this.seen.delete(turnId);
  }
}
