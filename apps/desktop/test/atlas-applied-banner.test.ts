import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextToast, type Toast } from '../src/renderer/atlas/optimizer/banner.js';

// The Applied banner (atlas-undo): its Undo may only ever undo its own change, so any later edit hides it at once.
const applied = { id: 'applied' }, typed = { id: 'typed' }, saved = { id: 'saved' };
const event = (transactionId: string, parentTransactionId: string | null) => ({ transactionId, parentTransactionId });
const state = (over: Record<string, unknown> = {}) => ({
  record: { source: { objectId: 'p1' }, history: { cursor: 't1', events: [event('t1', 't0')] } }, selected: 's1', save: 'saving', preview: null, plan: applied, ...over,
}) as never;
const pending: Toast = { text: 'Applied to your tree.', key: 'p1:s1', cursor: 't1', applied: null, plan: applied, undo: true };

test('typing while the Apply save is still pending hides the banner at once', () => {
  assert.equal(nextToast(state(), pending), pending, 'still saving, nothing else changed: kept');
  assert.equal(nextToast(state({ plan: typed }), pending), null, 'a text edit replaced the plan before the save landed: hidden');
  assert.equal(nextToast(state({ plan: typed, save: 'failed' }), pending), null, 'also when the save failed');
});

test('the banner is accepted once its own save lands, and dropped when another entry landed first', () => {
  const landed = state({ save: 'saved', plan: saved, record: { source: { objectId: 'p1' }, history: { cursor: 't2', events: [event('t1', 't0'), event('t2', 't1')] } } });
  const accepted = nextToast(landed, pending);
  assert.ok(accepted && accepted.applied === 't2' && accepted.plan === saved, 'accepted with its entry and the saved plan');
  const other = state({ save: 'saved', plan: saved, record: { source: { objectId: 'p1' }, history: { cursor: 't3', events: [event('t2', 't1'), event('t3', 't2')] } } });
  assert.equal(nextToast(other, pending), null, 'a later entry on top: dropped');
  assert.equal(nextToast(state({ save: 'saved' }), pending), pending, 'saved but no new entry yet: kept');
});

test('an accepted banner hides on any later change, on another step, and plain notices stay', () => {
  const ok: Toast = { ...pending, applied: 't2', plan: saved };
  const same = state({ save: 'saved', plan: saved, record: { source: { objectId: 'p1' }, history: { cursor: 't2', events: [] } } });
  assert.equal(nextToast(same, ok), ok);
  assert.equal(nextToast(state({ save: 'saving', plan: typed, record: { source: { objectId: 'p1' }, history: { cursor: 't2', events: [] } } }), ok), null, 'typing');
  assert.equal(nextToast(state({ selected: 's2' }), pending), null, 'another step');
  const notice: Toast = { ...pending, undo: false };
  assert.equal(nextToast(state({ plan: typed }), notice), notice, 'a plain notice is not tied to the plan');
});
