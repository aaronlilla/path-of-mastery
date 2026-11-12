import assert from 'node:assert/strict';
import test from 'node:test';
import type { Proposal, ThreadMessage } from '../../shared/assistant/types.js';
import { recapOf } from './useAssistant';

const card = { title: 'Swap gloves', changes: [{ statId: 'Life', label: 'Life', before: 4000, after: 4200 }] } as unknown as Proposal;

test('recap carries placeholder values and the state of a change card', () => {
  const messages: ThreadMessage[] = [
    { id: '1', role: 'assistant', createdAt: 1, text: 'Life is now {{rk1:life}}.' },
    { id: '2', role: 'receipt', createdAt: 2, proposal: card, undone: true },
  ];
  const recap = recapOf(messages, { rk1: { tool: 'diagnose', data: { life: 4200 } } })!;
  assert.match(recap, /Life is now 4,?200/);
  assert.doesNotMatch(recap, /\{\{/);
  assert.match(recap, /undone: Swap gloves/);
});
