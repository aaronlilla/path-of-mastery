import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatView } from '../src/shared/assistant/types.js';
import type { ProviderStatus } from '../src/shared/assistant/types.js';

const ready: ProviderStatus = { id: 'claude', state: 'ready' } as ProviderStatus;
const out: ProviderStatus = { id: 'claude', state: 'loggedOut' } as ProviderStatus;

test('before the first provider check answers, the chat shows neither the thread nor a provider screen', () => {
  assert.equal(chatView(null, 'claude', 'ready'), 'checking');
  assert.equal(chatView(null, 'claude', 'unavailable'), 'checking');
});

test('a provider that is not ready shows its screen; a ready one shows the thread unless the engine is down', () => {
  assert.equal(chatView([out], 'claude', 'ready'), 'provider');
  assert.equal(chatView([ready], 'claude', 'ready'), 'thread');
  assert.equal(chatView([ready], 'claude', 'loading'), 'thread');
  assert.equal(chatView([ready], 'claude', 'unavailable'), 'engine');
});

test('a provider the check did not report on falls through to the thread, as before', () => {
  assert.equal(chatView([ready], 'codex', 'ready'), 'thread');
});
