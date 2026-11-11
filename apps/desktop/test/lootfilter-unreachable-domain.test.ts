import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contradiction } from '../src/shared/lootfilter/preflight.js';
import type { Block } from '../src/shared/lootfilter/types.js';

const blockWith = (key: string, op: string, v: string): Block => ({ conditions: [{ key, op, values: [v] }] }) as unknown as Block;

test('a numeric condition outside what the game can give is a rule no item can reach', () => {
  assert.ok(contradiction(blockWith('ItemLevel', '>', '100')), 'item level tops out at 100');
  assert.ok(contradiction(blockWith('LinkedSockets', '>=', '7')), 'six links is the most');
  assert.equal(contradiction(blockWith('ItemLevel', '>=', '84')), null);
  assert.equal(contradiction(blockWith('LinkedSockets', '>=', '6')), null);
});
