// An outside MCP client's proposal goes into the open build live, like the panel's. Without an open build it stays a card.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'external-live-apply.bundle.mjs');
buildSync({ entryPoints: [join(here, '../src/main/assistant/proposals.ts')], bundle: true, platform: 'node', format: 'esm', outfile: out, packages: 'external', logLevel: 'silent' });
const { liveApplies } = (await import(pathToFileURL(out).href)) as { liveApplies?: (p: unknown, open: string | undefined) => boolean };

const base = { status: 'pending', offer: false, buildKey: 'b1' };
test('external proposal for the open build applies live', () => {
  assert.equal(liveApplies!({ ...base, origin: 'external' }, 'b1'), true);
});
test('external proposal with no build open (or another one) stays a card', () => {
  assert.equal(liveApplies!({ ...base, origin: 'external' }, undefined), false);
  assert.equal(liveApplies!({ ...base, origin: 'external' }, 'b2'), false);
});
test('panel proposals still apply; offers and non-pending do not', () => {
  assert.equal(liveApplies!({ ...base, origin: 'panel' }, undefined), true);
  assert.equal(liveApplies!({ ...base, origin: 'panel', offer: true }, 'b1'), false);
  assert.equal(liveApplies!({ ...base, origin: 'external', status: 'applied' }, 'b1'), false);
});
