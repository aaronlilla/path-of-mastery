import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plainText } from '../src/shared/assistant/blocks.js';
import { parseInline, parseMarkdown, safeHref } from '../src/shared/assistant/markdown.js';
import { holdBackPartial, resolveOnly, type ResultStore } from '../src/shared/assistant/refs.js';
import { humanStat, statMeta } from '../src/shared/assistant/statLabels.js';

const store: ResultStore = { r1: { tool: 'previewEdit', data: { headline: [{ shown: '3.43M' }, { shown: '3.01M' }] } } };

test('a fenced code block is one block that keeps its lines, so it can scroll instead of wrapping', () => {
  const b = parseMarkdown('Here:\n```js\nconst a = 1;\n  const veryLongLineThatMustNotWrap = a + a + a + a + a + a + a + a + a + a + a + a;\n```\nDone.');
  assert.deepEqual(b.map((x) => x.k), ['p', 'code', 'p']);
  const code = b[1]!;
  assert.equal(code.k === 'code' && code.lang, 'js');
  assert.equal(code.k === 'code' && code.text.split('\n').length, 2);
});

test('an unfinished fence while streaming stays a code block, not raw backticks', () => {
  const b = parseMarkdown('Look\n```\nhalf');
  assert.equal(b[1]!.k, 'code');
  assert.equal(b[1]!.k === 'code' && b[1]!.open, true);
});

test('a pipe table becomes a table with a head and rows', () => {
  const b = parseMarkdown('| Item | DPS |\n|---|---:|\n| Paradoxica | 3.43M |\n| Rare | 3.01M |');
  assert.equal(b.length, 1);
  const t = b[0]!;
  assert.ok(t.k === 'table');
  if (t.k === 'table') {
    assert.deepEqual(t.head, ['Item', 'DPS']);
    assert.equal(t.rows.length, 2);
  }
});

test('headings and lists parse, and html is never interpreted', () => {
  const b = parseMarkdown('# Title\n- a\n- b\n\n1. one\n2. two\n\n<script>alert(1)</script>');
  assert.deepEqual(b.map((x) => x.k), ['h', 'ul', 'ol', 'p']);
  const p = b[3]!;
  assert.ok(p.k === 'p' && p.lines[0]!.includes('<script>'));
});

test('only http and https links are links', () => {
  assert.equal(safeHref('https://pathofexile.com/x'), true);
  assert.equal(safeHref('javascript:alert(1)'), false);
  assert.equal(safeHref('file:///c:/x'), false);
  const parts = parseInline('see [the wiki](https://poewiki.net) and [bad](javascript:alert(1))');
  assert.deepEqual(parts.filter((p) => p.t === 'link').map((p) => p.t === 'link' && p.href), ['https://poewiki.net']);
});

test('a placeholder inside a code block or inline code is filled, and one pointing at nothing is blank', () => {
  assert.equal(resolveOnly('A {{r1:headline[0].shown}} vs {{r1:headline[1].shown}} {{r1:nothing}}', store), 'A 3.43M vs 3.01M ');
});

test('a placeholder cut off mid-stream is held back', () => {
  assert.equal(holdBackPartial('wins by {{r1:head'), 'wins by ');
  assert.equal(holdBackPartial('wins by {{r1:headline[0].shown}} now'), 'wins by {{r1:headline[0].shown}} now');
  assert.equal(holdBackPartial('ends with {'), 'ends with ');
});

test('an engine stat id never reaches the screen as written', () => {
  assert.equal(statMeta('PoisonDamage').label, 'Poison damage');
  assert.equal(statMeta('CausticGroundDPS').label, 'Caustic ground DPS');
  assert.equal(statMeta('TotalPoisonDPS').label, 'Total poison DPS');
  assert.equal(humanStat('Life'), 'Life');
  assert.ok(!/[a-z][A-Z]/.test(statMeta('SomeUnlistedStatId').label));
});

test('a layout fence saved by an older version is dropped from the text', () => {
  assert.equal(plainText('Solid damage.\n```pom\n{"layout":"overview"}\n```\nMore.'), 'Solid damage.\n\nMore.');
  assert.equal(plainText('Half\n```pom\n{"lay'), 'Half');
});
