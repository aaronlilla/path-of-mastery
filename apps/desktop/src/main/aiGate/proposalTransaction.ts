import type { PreparedProposal, ProposalStore } from '../assistant/proposals.js';
import type { LfProposalStore } from '../assistant/lootTools.js';
import type { ToolContext } from '../assistant/tools.js';
import type { LfProposal } from '../../shared/lootfilter/ipcTypes.js';
import type { Proposal } from '../../shared/assistant/types.js';
import { AiDenied } from './gate.js';

/** Tool generation prepares cards; only the completed authorization may publish them. */
export function createProposalTransaction(source: ToolContext): {
  context: ToolContext; commit(): Proposal[]; discard(): void;
} {
  let state: 'pending' | 'committed' | 'discarded' = 'pending';
  const builds: PreparedProposal[] = [];
  const filters: LfProposal[] = [];
  const requirePending = () => { if (state !== 'pending') throw new AiDenied('CONNECTION_REVOKED'); };
  const proposals = source.proposals ? new Proxy(source.proposals, { get(store, property) {
    if (property !== 'create') throw new AiDenied('CONNECTION_REVOKED');
    return (input: Parameters<ProposalStore['create']>[0]) => {
      requirePending();
      const prepared = store.prepare(input); builds.push(prepared);
      const { baseHash: _baseHash, ...view } = prepared;
      return structuredClone(view);
    };
  } }) : undefined;
  const loot = source.loot?.proposals ? { ...source.loot, proposals: new Proxy(source.loot.proposals, { get(store, property) {
    if (property !== 'create') throw new AiDenied('CONNECTION_REVOKED');
    return (input: Parameters<LfProposalStore['create']>[0]) => {
      requirePending();
      const prepared = store.prepare(input); filters.push(prepared);
      return structuredClone(prepared);
    };
  } }) } : undefined;
  return {
    context: { ...source, ...(proposals ? { proposals } : {}), ...(loot ? { loot } : {}) },
    commit() {
      if (state === 'committed') return [];
      requirePending();
      const published = builds.map(proposal => source.proposals.commitPrepared(proposal));
      for (const proposal of filters) source.loot!.proposals.commitPrepared(proposal);
      state = 'committed';
      return published;
    },
    discard() {
      if (state !== 'pending') return;
      state = 'discarded';
      for (const proposal of builds) source.proposals.discardPrepared(proposal);
      for (const proposal of filters) source.loot!.proposals.discardPrepared(proposal);
    },
  };
}
