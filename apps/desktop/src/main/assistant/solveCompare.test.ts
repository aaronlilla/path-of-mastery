import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDelta } from '../../shared/assistant/statLabels.js';
import { changeRows, pickChanges } from './tools.js';

// Best setup > Compare, Ground Slam Champion: "Full DPS 0 -> 1.75M +1752273.72" while the build has 480k Combined DPS.
test('a result card shows the sidebar EHP in place of the solver EHP', async () => {
  const { withSidebarEhp } = await import('./solve.js');
  const snap = { results: [{ targets: [{ name: 'EHP', metric: 'ehp', value: 75000, shown: 75000 }] }] } as never;
  const out = withSidebarEhp(snap, 0, 33100) as { results: Array<{ targets: Array<{ shown: number }> }> };
  assert.equal(out.results[0]!.targets[0]!.shown, 33100);
  assert.equal(withSidebarEhp(out as never, 0, 33100), null);
});

test('compare never shows a raw delta or a Full DPS of 0 for a build with damage', () => {
  const picked = pickChanges(
    [
      { statId: 'FullDPS', before: 0, after: 1752273.72 },
      { statId: 'CombinedDPS', before: 479500, after: 1752273.72 },
    ],
    8,
  );
  assert.deepEqual(picked.map((c) => c.statId), ['CombinedDPS']);
  assert.equal(formatDelta('TotalDPS', 0, 1752273.72), '+1.75M');
  for (const r of changeRows(picked)) assert.ok(!/\d{5,}/.test(r.change ?? ''), `raw number in ${r.change}`);
});
