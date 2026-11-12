// Atlas wording: AI spend-cap status.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aiStatusView } from '../src/renderer/gates/ai/status.js';
import { AiDenied } from '../src/main/aiGate/gate.js';

test('AI spend cap: the app says AI service unavailable', () => {
  assert.equal(new AiDenied('AI_SERVICE_UNAVAILABLE').message, 'AI service unavailable');
  assert.equal(new AiDenied('AI_SERVICE_UNAVAILABLE').name, 'AiDenied', 'named, so the Atlas IPC passes its message to the app');
  assert.equal(aiStatusView({ status: 'denied', code: 'AI_SERVICE_UNAVAILABLE' }).title, 'AI service unavailable');
});
