// Preview numbers show only for the build they were computed for; otherwise a waiting state, never live or old numbers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previewEngine, resolvePreview } from '../src/renderer/preview/pvResult.js';
import { PREVIEW_COMMANDS } from '../src/shared/preview.js';

test('explanations of preview numbers are read from the preview engine', async () => {
  const seen: Array<[string, string, object]> = [];
  const live = { buildId: 'b1', version: 3, call: async (_c: string, _p?: object) => ({ live: true }) as unknown };
  const pv = previewEngine(live, '<xml/>', async (c, x, p) => (seen.push([c, x, p]), { result: { table: 'pv' } }));
  assert.deepEqual(await pv.call('calcsMods', { detail: { breakdown: 'Life' } }), { table: 'pv' });
  await pv.call('getBreakdowns', {});
  assert.deepEqual(seen.map((s) => [s[0], s[1]]), [['calcsMods', '<xml/>'], ['getBreakdowns', '<xml/>']]);
  assert.notEqual(pv.buildId, live.buildId);
  for (const c of ['getBreakdowns', 'calcsMods']) assert.ok((PREVIEW_COMMANDS as readonly string[]).includes(c));
});

test('preview numbers are shown only for the key they were computed for', () => {
  const res = { key: 'A', val: { life: 100 } };
  assert.equal(resolvePreview(res, 'A', true).state, 'ready');
  assert.deepEqual(resolvePreview(res, 'A', true).val, { life: 100 });
  // the build changed: the old result must not show
  assert.deepEqual(resolvePreview(res, 'B', true), { val: null, state: 'computing' });
  // nothing back yet
  assert.deepEqual(resolvePreview(null, 'A', true), { val: null, state: 'computing' });
  // the call failed
  assert.deepEqual(resolvePreview({ key: 'A', val: null }, 'A', true), { val: null, state: 'unavailable' });
  assert.equal(resolvePreview(res, 'A', false).state, 'off');
});
