// Regression: asked for the spell suppression cap or effect, the model typed "100%" / "40%"
// because no tool result held them, so the answer was suppressed and asked for again. Game constants must come from tool data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addConstantCaps, statMap, type ToolContext } from '../src/main/assistant/tools.js';
import { formatStat } from '../src/shared/assistant/statLabels.js';
import { auditText, checkedPlain, type ResultStore } from '../src/shared/assistant/refs.js';
import { systemPrompt } from '../src/main/assistant/prompts.js';

test('the suppression cap and effect are stats a tool returns, with a percent sign', async () => {
  const out: Record<string, number | string | boolean | null> = { SpellSuppressionChance: 100, SpellSuppressionEffect: 40 };
  addConstantCaps(out, { SuppressionChanceCap: 100 });
  assert.equal(out.SpellSuppressionChanceMax, 100);
  assert.equal(formatStat('SpellSuppressionChanceMax', 100), '100%');
  assert.equal(formatStat('SpellSuppressionEffect', 40), '40%');
  assert.equal(formatStat('SpellSuppressionChance', 100), '100%');
  // statMap feeds getStats: the cap shows up there too.
  const ctx = { engine: { send: async () => ({ stats: [{ id: 'SpellSuppressionChance', value: 100 }] }) } } as unknown as ToolContext;
  assert.equal((await statMap(ctx, 'b1')).SpellSuppressionChanceMax, 100);
});

test('a placeholder to the cap draws the value; the typed cap is still refused', () => {
  const store: ResultStore = { rk1: { tool: 'getStats', data: { stats: [{ id: 'SpellSuppressionChanceMax', value: 100, shown: '100%' }] } } };
  assert.equal(checkedPlain('The cap is {{rk1:stats[SpellSuppressionChanceMax].shown}}.', store), 'The cap is 100%.');
  assert.equal(auditText('The cap is {{rk1:stats[SpellSuppressionChanceMax].shown}}.', (r) => store[r]).typed.length, 0);
  assert.deepEqual(auditText('The cap is 100%.', (r) => store[r]).typed, ['100%']);
});

test('the instructions name caps beyond resistances and keystone values', () => {
  const p = systemPrompt({ tools: ['getStats'] } as never);
  assert.match(p, /SpellSuppressionChanceMax/);
  assert.match(p, /keystone/i);
});
