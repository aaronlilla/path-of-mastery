// The advice-quality rules (long answers, unchecked "weakest" claims, a problem left after a buy) stay in the prompt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { systemPrompt } from '../src/main/assistant/prompts.js';

test('the prompt caps the answer, bans unchecked comparisons and asks for the next fix', () => {
  const p = systemPrompt({ tools: [] });
  assert.match(p, /Under 110 words in all/);
  assert.match(p, /weakest, best, lowest or wasted only after you read every thing you compare/);
  assert.match(p, /fix it in the same turn with the app's tools/);
});
