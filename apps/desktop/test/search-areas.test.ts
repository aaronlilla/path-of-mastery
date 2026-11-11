import { test } from 'node:test';
import assert from 'node:assert/strict';
import { search, type SearchDoc } from '../src/renderer/search/searchIndex.js';
import { areaDocs, buildDocs, settingsDocs } from '../src/renderer/search/shellDocs.js';
import { NAV_AREAS } from '../src/renderer/areaGate.js';

const opened: string[] = [];
const noop = () => undefined;
// The palette's shell rows as App.tsx builds them with no build open: areas first, then the rest.
const DOCS: SearchDoc[] = [
  ...areaDocs((a) => opened.push(a)),
  ...buildDocs([], noop),
  ...settingsDocs(noop),
  { kind: 'Action', title: 'Build Library', meta: 'Screen', extra: 'builds home', run: noop },
  { kind: 'Action', title: 'Wealth: Bulk board', meta: 'Screen', extra: 'sell bulk trade', run: noop },
  { kind: 'Action', title: 'Wealth: Your loot filter, priced for your time', meta: 'Screen', extra: 'loot filter rate hide threshold suggestions', run: noop },
];

test('every enabled area is the top result for its own name, and Enter opens it', () => {
  for (const [q, id] of [['Atlas', 'atlas'], ['Builds', 'builds'], ['Wealth', 'wealth'], ['Loot Filter', 'filter'], ['atlas', 'atlas']] as const) {
    const top = search(q, DOCS).flat[0];
    assert.equal(top?.doc.title.toLowerCase(), q.toLowerCase(), `top row for ${q}`);
    assert.equal(top?.doc.kind, 'Area');
    opened.length = 0;
    top!.doc.run();
    assert.deepEqual(opened, [id]);
  }
});

test('area rows follow the area bar: switched-off Timelines and Marketplace are never offered', () => {
  assert.deepEqual(areaDocs(noop).map((d) => d.title), ['Builds', 'Atlas', 'Wealth', 'Loot Filter']);
  assert.deepEqual(areaDocs(noop).map((d) => d.meta), NAV_AREAS.map((_, i) => `Ctrl ${i + 1}`));
  for (const q of ['Timelines', 'Marketplace', 'timeline', 'market']) {
    assert.ok(!search(q, DOCS).flat.some((h) => /timeline|marketplace/i.test(h.doc.title)), q);
  }
});
