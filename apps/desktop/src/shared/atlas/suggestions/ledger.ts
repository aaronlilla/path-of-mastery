export const QUALIFIED_VISIBLE_MS = 5_000;
export const IGNORES_TO_SUPPRESS = 2;
/** Per-plan, stored locally. Structural warnings never pass through this ledger. */
export type LedgerState = { dismissed: string[]; ignores: Record<string, number> };
export interface LedgerStorage { load(planId: string): LedgerState | null; save(planId: string, state: LedgerState): void }
export const emptyLedger = (): LedgerState => ({ dismissed: [], ignores: {} });

/**
 * Remembers which advice the player keeps passing over.
 * - Dismiss suppresses at once.
 * - An ignore counts only when the row stayed visible for 5 s AND the player then made an unrelated committed edit
 *   or closed the workspace. Moving the pointer away counts for nothing.
 * - Two counted ignores of the same rule + target + intent suppress it until Reset.
 */
export class SuppressionLedger {
  private since = new Map<string, number>();
  private state: LedgerState;
  constructor(private readonly planId: string, private readonly storage: LedgerStorage | null, private readonly now: () => number) {
    this.state = structuredClone(storage?.load(planId) ?? emptyLedger());
  }
  snapshot(): LedgerState { return structuredClone(this.state); }
  suppressed(key: string): boolean { return this.state.dismissed.includes(key) || (this.state.ignores[key] ?? 0) >= IGNORES_TO_SUPPRESS; }
  ignoresOf(key: string): number { return this.state.ignores[key] ?? 0; }
  /** Call with the keys on screen after every render of the rail. Rows that left the screen stop their clock. */
  shown(keys: readonly string[]): void {
    const t = this.now(), live = new Set(keys);
    for (const key of [...this.since.keys()]) if (!live.has(key)) this.since.delete(key);
    for (const key of keys) if (!this.since.has(key)) this.since.set(key, t);
  }
  /** `related` is the key the edit applied (or null); that row was acted on, so it is not an ignore. */
  unrelatedEdit(related: string | null = null): string[] { return this.settle(related); }
  workspaceClosed(): string[] { return this.settle(null); }
  private settle(related: string | null): string[] {
    const t = this.now(), counted: string[] = [];
    for (const [key, at] of this.since) {
      if (key === related) { delete this.state.ignores[key]; this.since.set(key, t); continue; }
      if (t - at >= QUALIFIED_VISIBLE_MS) { this.state.ignores[key] = (this.state.ignores[key] ?? 0) + 1; counted.push(key); this.since.set(key, t); }
    }
    if (counted.length) this.persist();
    return counted;
  }
  dismiss(key: string): void { if (!this.state.dismissed.includes(key)) { this.state.dismissed.push(key); this.since.delete(key); this.persist(); } }
  applied(key: string): void { delete this.state.ignores[key]; this.persist(); }
  reset(): void { this.state = emptyLedger(); this.persist(); }
  private persist(): void { this.storage?.save(this.planId, structuredClone(this.state)); }
}
