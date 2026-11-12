import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Rule } from '../src/shared/lootfilter/types.js';
import { generateFilter } from '../src/shared/lootfilter/generate.js';
import { parseBlocks } from '../src/shared/lootfilter/blocks.js';
import { validateFilter } from '../src/shared/lootfilter/syntax.js';
import { STRICTNESS } from '../src/shared/lootfilter/styles.js';
import { diagnose, diagSummary, matchCount, yourRulesView } from '../src/shared/lootfilter/yourRules.js';
import { NEVERSINK_DIR } from './lootfilterHelpers.js';

const base = (i: number): string => readFileSync(join(NEVERSINK_DIR, STRICTNESS[i]!.file), 'utf8');
const rule = (over: Partial<Rule> & { id: string }): Rule => ({ source: 'advanced', enabled: true, priority: 1, targets: [], ...over });
const rules: Rule[] = [
  rule({ id: 'boots', name: 'Boots from the build', source: 'build', priority: 3, visibility: 'show', style: { fs: 36 }, targets: [{ conditions: [{ key: 'Class', op: '==', values: ['Boots'] }, { key: 'BaseType', op: '==', values: ['Two-Toned Boots', 'Slink Boots'] }] }] }),
  rule({ id: 'links', name: 'Keep 4 or more links', priority: 2, visibility: 'show', style: { fs: 32 }, targets: [{ conditions: [{ key: 'LinkedSockets', op: '>=', values: ['4'] }, { key: 'Rarity', op: '', values: ['Normal', 'Magic'] }] }] }),
  rule({ id: 'gear', name: 'Hide white and blue gear after act 10', priority: 1, visibility: 'hide', targets: [{ conditions: [{ key: 'AreaLevel', op: '>=', values: ['68'] }, { key: 'Rarity', op: '<=', values: ['Magic'] }, { key: 'Class', op: '==', values: ['Body Armours', 'Helmets', 'Gloves', 'Boots'] }] }] }),
];
const g = generateFilter({ baseText: base(2), baseVersion: '8.20.1d', strictness: 2, style: 0, rules, now: new Date('2026-09-30T12:00:00Z') });
const blocks = parseBlocks(g.text).blocks;
const universe = [
  { name: 'Two-Toned Boots', class: 'Boots' },
  { name: 'Slink Boots', class: 'Boots' },
  { name: 'Astral Plate', class: 'Body Armours' },
];

test('Your rules shows only the player blocks, without rule ids, and maps lines both ways', () => {
  const v = yourRulesView(g.text, g.baseStartLine, 'My filter', 'Kaelen');
  assert.deepEqual(v.lines.slice(0, 3), ['# Your rules · My filter', '# Build: Kaelen', '']);
  assert.ok(v.lines[3]!.startsWith('Show # Boots from the build'), v.lines[3]);
  assert.ok(!v.lines.join('\n').includes('pom:rule='));
  assert.equal(v.lines.filter((l) => /^(Show|Hide)\b/.test(l)).length, g.userBlocks);
  assert.ok(v.span);
  for (const b of blocks.filter((x) => x.ruleId)) {
    const shown = v.fromFile(b.line)!;
    assert.ok(/^(Show|Hide)\b/.test(v.lines[shown - 1]!), `block at file line ${b.line} lands on a header line`);
    assert.equal(v.toFile(shown), b.line);
  }
  assert.equal(v.fromFile(g.baseStartLine + 3), null);
});

test('with no block rules the view is only the title', () => {
  const none = generateFilter({ baseText: base(2), baseVersion: '8.20.1d', strictness: 2, style: 0, rules: [], now: new Date() });
  const v = yourRulesView(none.text, none.baseStartLine, 'x');
  assert.deepEqual(v.lines, ['# Your rules · x', '']);
  assert.equal(v.span, null);
});

test('diagnostics: what each block matches, the Hide skipped by the Show above it, and the file check', () => {
  const v = yourRulesView(g.text, g.baseStartLine, 'My filter');
  const d = diagnose({ blocks, issues: validateFilter(g.text).issues, rules, baseStartLine: g.baseStartLine, bytes: g.bytes, universe, lineOf: v.fromFile, scope: 'rules' });
  const hideAt = v.lines.findIndex((l) => l.startsWith('Hide #')) + 1;
  const showLinksAt = v.lines.findIndex((l) => l.startsWith('Show # Keep 4')) + 1;
  const skip = d.find((x) => x.kind === 'warning' && x.text.includes('links'));
  const bootsSkip = d.find((x) => x.kind === 'warning' && x.text.includes('Two-Toned'));
  assert.equal(bootsSkip?.text.startsWith('This Hide skips items called Two-Toned Boots or Slink Boots'), true);
  assert.ok(skip, 'a warning for the Hide');
  assert.equal(skip.line, hideAt);
  assert.equal(skip.text, `This Hide skips items with 4 or more links, because the Show at line ${showLinksAt} is above it.`);
  const boots = d.find((x) => x.kind === 'info' && x.line === v.lines.findIndex((l) => l.startsWith('Show # Boots')) + 1);
  assert.equal(boots?.text, 'Matches 2 item types from your build.');
  assert.equal(d[d.length - 1]!.kind, 'ok');
  assert.match(d[d.length - 1]!.text, /^No errors\. The file fits the 1 MB limit/);
  assert.equal(diagSummary(d), '0 errors · 2 warnings');
});

test('matchCount counts only the item types the BaseType and Class lines let through', () => {
  assert.equal(matchCount({ conditions: [{ key: 'BaseType', op: '==', values: ['Slink Boots'] }] }, universe), 1);
  assert.equal(matchCount({ conditions: [{ key: 'Class', op: '==', values: ['Boots', 'Body Armours'] }] }, universe), 3);
  assert.equal(matchCount({ conditions: [{ key: 'LinkedSockets', op: '>=', values: ['4'] }] }, universe), null);
});
