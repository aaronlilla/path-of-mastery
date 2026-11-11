import { formatDelta } from './statLabels.js';
import type { Proposal, ShowRequest, ShowTarget } from './types.js';

const GEM_KINDS = new Set(['setGem', 'setGroup', 'addGem', 'removeGem', 'moveGem', 'orderGems', 'setGemSkill', 'addGroup', 'setMainGroup', 'setMainActiveSkill']);

/** Where an applied proposal shows: the tab and the part of it the change touched (its first edit decides). */
export function targetOf(p: Pick<Proposal, 'edits' | 'kind' | 'addedIds' | 'removedIds'>): ShowTarget {
  const nodes = p.addedIds.length ? p.addedIds : p.removedIds;
  // a tree change with gem fixes after it (kind 'changes') still shows on the tree
  const first = (p.edits[0] as { kind?: string } | undefined)?.kind;
  if ((p.kind === 'tree' || first === 'clickNode' || first === 'pickMastery') && nodes.length) return { tab: 'tree', nodeIds: nodes };
  for (const edit of p.edits) {
    const e = edit as { kind: string } & Record<string, unknown>;
    const n = (k: string) => (typeof e[k] === 'number' ? (e[k] as number) : 0);
    if ((e.kind === 'setItem' || e.kind === 'setSlotItem' || e.kind === 'setFlaskActive') && typeof e.slot === 'string') return { tab: 'items', slot: e.slot };
    if (e.kind === 'setJewel') return { tab: 'tree', nodeIds: [n('nodeId')] };
    // 0 means the last group or gem: an added one goes at the end unless `at` says where.
    if (e.kind === 'addGroup') return { tab: 'skills', gem: { group: n('at'), gem: 1 } };
    if (e.kind === 'addGem') return { tab: 'skills', gem: { group: n('group'), gem: n('at') } };
    if (e.kind === 'moveGem') return { tab: 'skills', gem: { group: n('group'), gem: n('to') } };
    if (GEM_KINDS.has(e.kind)) return { tab: 'skills', gem: { group: n('group'), gem: n('gem') || 1 } };
    if (e.kind === 'setConfig' && typeof e.key === 'string') return { tab: 'config', configKey: e.key };
    if (e.kind === 'setConfigs' && e.values && typeof e.values === 'object') {
      const key = Object.keys(e.values)[0];
      if (key) return { tab: 'config', configKey: key };
    }
  }
  return nodes.length ? { tab: 'tree', nodeIds: nodes } : { tab: 'calcs' };
}

/** The caption chip of an applied proposal: "Added by assistant", then what and its biggest stat change. */
export function showForApplied(p: Proposal): ShowRequest {
  const c = p.changes.find((x) => typeof x.before === 'number' && typeof x.after === 'number' && x.before !== x.after);
  const delta = c ? `, ${formatDelta(c.statId, c.before as number, c.after as number)} ${c.label}` : '';
  return { ...targetOf(p), head: p.removedIds.length && !p.addedIds.length ? 'Removed by assistant' : 'Added by assistant', text: `${p.title}${delta}`, proposalId: p.id };
}
