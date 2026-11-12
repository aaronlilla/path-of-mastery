import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProposalStore, mergeProposals } from '../src/main/assistant/proposals.js';

const base = { buildId: 'b', buildKey: 'k', removedIds: [], addedIds: [], title: 't', edits: [], kind: 'changes', removed: [], added: [], lines: [], gems: [], changes: [], origin: 'panel', baseHash: 'h' };

test('a second proposal of the answer folds into the first: edits, lines, and before from the first, after from the last', () => {
  const first = { ...base, baseHash: 'h1', addedIds: [1], added: ['Life'], lines: ['Swap Lifetap for Enlighten'], edits: [{ kind: 'a' }], changes: [{ statId: 'TotalEHP', label: 'Effective HP', before: 100, after: 80 }] } as never;
  const second = { ...base, baseHash: 'h2', addedIds: [2], added: ['Acuity'], lines: ['Equip a ring'], edits: [{ kind: 'b' }], changes: [{ statId: 'TotalEHP', label: 'Effective HP', before: 80, after: 90 }, { statId: 'Life', label: 'Life', before: 5, after: 6 }] } as never;
  const m = mergeProposals(first, second) as unknown as { baseHash: string; edits: unknown[]; lines: string[]; added: string[]; changes: Array<{ statId: string; before: number; after: number }> };
  assert.equal(m.baseHash, 'h1');
  assert.equal(m.edits.length, 2);
  assert.deepEqual(m.lines, ['Swap Lifetap for Enlighten', 'Equip a ring']);
  assert.deepEqual(m.added, ['Life', 'Acuity']);
  const ehp = m.changes.find((c) => c.statId === 'TotalEHP')!;
  assert.deepEqual([ehp.before, ehp.after], [100, 90]);
  assert.ok(m.changes.some((c) => c.statId === 'Life'));
});

test('undo then reapply: the merged proposal applies both edit sets from the post-undo build, and the earlier one cannot be applied again', () => {
  const store = new ProposalStore();
  const first = store.create({ ...(base as object), baseHash: 'base', edits: [{ kind: 'a' }], lines: ['one'] } as never);
  store.setStatus(first.id, 'applied');
  const second = store.create({ ...(base as object), baseHash: 'after-first', edits: [{ kind: 'b' }], lines: ['two'] } as never);
  // the service undid the first change: the build is back at its own text, whose hash the merged proposal now starts from
  store.mergeEarlier(second.id, first.id, 'after-undo');
  store.setStatus(first.id, 'dismissed');
  const taken = store.takeForApply(second.id);
  assert.equal(taken.proposal.baseHash, 'after-undo');
  assert.deepEqual(taken.edits, [{ kind: 'a' }, { kind: 'b' }]);
  assert.deepEqual(taken.proposal.lines, ['one', 'two']);
  assert.throws(() => store.takeForApply(first.id), /dismissed/);
});

test('merged tree change lists only the nodes that net changed: a node taken then given up is in neither list', () => {
  const first = { ...base, addedIds: [1, 2, 3, 4], added: ['A', 'B', 'C', 'D'] } as never;
  const second = { ...base, removedIds: [1, 2, 3], removed: ['A', 'B', 'C'], addedIds: [5], added: ['E'] } as never;
  const m = mergeProposals(first, second) as unknown as { addedIds: number[]; removedIds: number[]; added: string[]; removed: string[] };
  assert.deepEqual(m.addedIds, [4, 5]);
  assert.deepEqual(m.added, ['D', 'E']);
  assert.deepEqual(m.removedIds, []);
  assert.deepEqual(m.removed, []);
});
