import { useSyncExternalStore } from 'react';
import type { FilterSetup, LabelStyle, Rule } from '../../../shared/lootfilter/types.js';

/**
 * A list of proposed rule changes waiting for the player's yes. Other screens (Build, Retier, imports) fill it with
 * `setProposals`, then send the player to the `diff` view, which shows each change with a before and an after.
 */

export interface LookState {
  name: string;
  style: LabelStyle;
  hidden?: boolean;
  /** A small tag beside a hidden label, like "Hidden at Strict". */
  tag?: string;
}

export interface ProposedChange {
  id: string;
  /** Group heading in the list, like "Currency". */
  group: string;
  /** What the change does, in plain words. */
  what: string;
  /** Why it is proposed. */
  why?: string;
  before: LookState;
  after: LookState;
  /** How many items it touches, when known. */
  affected?: number;
  /** The rule Apply adds. Its id and priority are set when it is added. A change that only moves a setting (strictness) has none. */
  rule?: Rule;
  /** Settings Apply changes along with the rule, like the strictness level. */
  setup?: Partial<FilterSetup>;
  /** A warning that needs the player to confirm, like hiding something valuable. The change starts unticked. */
  flag?: string;
  /** A note about another rule that already covers this. */
  conflict?: string;
  status: 'pending' | 'applied' | 'skipped';
}

export interface Proposal {
  id: string;
  /** Where it came from, like "Build", "Retier" or "Import". */
  source: string;
  /** The request in the player's words, or what the change is. It is the heading of the review. */
  title: string;
  changes: ProposedChange[];
  createdAt: number;
}

let proposals: Proposal[] = [];
const subs = new Set<() => void>();
const emit = (): void => subs.forEach((f) => f());

export function getProposals(): Proposal[] {
  return proposals;
}

export function setProposals(next: Proposal[]): void {
  proposals = next;
  emit();
}

export function addProposal(p: Proposal): void {
  setProposals([...proposals.filter((x) => x.id !== p.id), p]);
}

export function removeProposal(id: string): void {
  setProposals(proposals.filter((p) => p.id !== id));
}

export function setChangeStatus(proposalId: string, changeIds: string[], status: ProposedChange['status']): void {
  const ids = new Set(changeIds);
  setProposals(proposals.map((p) => (p.id === proposalId ? { ...p, changes: p.changes.map((c) => (ids.has(c.id) ? { ...c, status } : c)) } : p)));
}

export function subscribe(fn: () => void): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

export function useProposals(): Proposal[] {
  return useSyncExternalStore(subscribe, getProposals, getProposals);
}
