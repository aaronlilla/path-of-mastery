import assert from 'node:assert/strict';
import { test } from 'node:test';
import { turnFailure } from '../src/main/assistant/cli.js';
import { AiDenied } from '../src/main/aiGate/gate.js';

const quiet = <T>(f: () => T): T => { const log = console.error; console.error = () => undefined; try { return f(); } finally { console.error = log; } };

test('a thrown non-gate error is not shown as "Can\'t reach Path of Mastery"', () => {
  const e = quiet(() => turnFailure(new TypeError('Cannot read properties of undefined (reading \'id\')\n    at x'), 'test'));
  assert.equal(e.code, 'failed');
  assert.equal(e.message, "Something went wrong: Cannot read properties of undefined (reading 'id')");
});

test('a gate denial passes through, a network failure keeps the can\'t-reach code', () => {
  assert.equal(turnFailure(new AiDenied('AI_ACCESS_REQUIRED'), 'test').code, 'AI_ACCESS_REQUIRED');
  const net = quiet(() => turnFailure(new TypeError('fetch failed'), 'test'));
  assert.equal(net.code, 'ENTITLEMENT_UNAVAILABLE');
});
