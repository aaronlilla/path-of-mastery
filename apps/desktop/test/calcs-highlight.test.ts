import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CalcViewSection } from '@pom/protocol';
import { cellIsStat, findStatCell } from '../src/shared/calcsLogic.js';

const row = (breakdown: string[]) => ({ label: 'Maximum Hit Taken', cells: breakdown.map(() => '1'), cellIdx: breakdown.map((_, i) => i), cols: breakdown.length, cellDetails: breakdown.map((b) => [{ breakdown: b }]), bgCol: null, color: null, textSize: null });
const sub = (label: string, rows: ReturnType<typeof row>[]) => ({ label, extra: null, collapsed: false, rows, columns: null });
const sec = (id: string, shown: boolean, subs: ReturnType<typeof sub>[]): CalcViewSection => ({ id, enabled: true, width: 1, group: 3, colour: null, shown, subSections: subs });

test('a stat id finds its cell by the breakdown behind it', () => {
  const view = [sec('Hidden', false, [sub('x', [row(['ChaosMaximumHitTaken'])])]), sec('Life', true, [sub('Life', [row(['Life'])]), sub('Maximum Hit Taken', [row(['PhysicalMaximumHitTaken', 'ChaosMaximumHitTaken'])])])];
  assert.deepEqual(findStatCell(view, 'ChaosMaximumHitTaken'), { sid: 'Life', sub: 1 });
  assert.equal(findStatCell(view, 'NoSuchStat'), null);
  assert.equal(cellIsStat(view[1]!.subSections[1]!.rows[0]!.cellDetails[1], 'ChaosMaximumHitTaken'), true);
});
