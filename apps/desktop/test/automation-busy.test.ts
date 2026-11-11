import { test } from 'node:test';
import assert from 'node:assert/strict';
import { begin, end, track, busyCount } from '../src/renderer/automationBusy.js';

test('counter rises and falls, never below zero', () => {
  const g = globalThis as { __pomBusy?: number };
  assert.equal(busyCount(), 0);
  begin(); begin();
  assert.equal(g.__pomBusy, 2);
  end(); end(); end();
  assert.equal(busyCount(), 0);
});

test('track counts a promise until it settles, also on rejection', async () => {
  const ok = track(new Promise((r) => setTimeout(() => r(1), 10)));
  assert.equal(busyCount(), 1);
  await ok;
  assert.equal(busyCount(), 0);
  await assert.rejects(track(Promise.reject(new Error('x'))));
  assert.equal(busyCount(), 0);
});
