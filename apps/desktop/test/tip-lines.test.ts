import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TooltipLine } from '@pom/protocol';
import { shownLines } from '../src/renderer/tipLines.js';

const line = (k: TooltipLine['k'], t = '', c: TooltipLine['segs'][number]['c'] = null): TooltipLine => ({ k, segs: [{ c, t }] });

test('a hover without Alt drops tips and the source line and the dividers they leave', () => {
  const lines = [line('title', 'Name'), line('big', 'Armour: 10'), line('sep'), line('tip', 'Tip'), line('sep'), line('big', 'Source: drops', 'source'), line('sep'), line('big', '+5 Life'), line('sep'), line('tip', 'Tip 2')];
  assert.deepEqual(shownLines(lines, false).map((l) => l.segs[0]!.t || '-'), ['Name', 'Armour: 10', '-', '+5 Life']);
  assert.equal(shownLines(lines, true), lines);
});
