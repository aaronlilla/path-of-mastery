import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpGgg, newGggLimiter } from '../src/main/wealth/ggg.js';

// The proxy setting swaps globalThis.fetch after the Wealth service exists; the GGG client must call the swapped one.
test('the GGG client calls the fetch that is current when it is used, not the one at construction', async () => {
  const original = globalThis.fetch;
  let t = 5_000_000;
  const ggg = new HttpGgg({ cookie: () => 'abcdef0123456789abcdef0123456789', userAgent: 'PathOfMastery/test (contact: example)', limiter: newGggLimiter(() => t, async (ms: number) => void (t += ms)) });
  const seen: string[] = [];
  globalThis.fetch = (async (url: string) => {
    seen.push(String(url));
    throw new Error('proxy unreachable');
  }) as unknown as typeof fetch;
  try {
    await assert.rejects(() => ggg.stashTab('Kaelen#4821', 'Standard', 0, true), (e: unknown) => (e as { kind?: string }).kind === 'down');
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(seen.length, 1);
  assert.ok(seen[0]!.startsWith('https://www.pathofexile.com/character-window/get-stash-items'));
});
