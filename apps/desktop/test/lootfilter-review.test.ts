import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Block, Rule } from '../src/shared/lootfilter/types.js';
import { parseBlocks } from '../src/shared/lootfilter/blocks.js';
import { candidateBlocks, conflictFor } from '../src/shared/lootfilter/review.js';

const existing: Block[] = parseBlocks(`Show # Broadhead Arrow Quiver
\tBaseType == "Broadhead Arrow Quiver"
\tRarity Normal Magic Rare
\tSetFontSize 34

Show # Keep 4 or more links
\tLinkedSockets >= 4
`).blocks;
const names = ['Show Broadhead Arrow Quiver', 'Show links'];
const rule = (over: Partial<Rule>): Rule => ({ id: 'p1', name: 'Hide normal and magic shields and quivers in maps', source: 'advanced', enabled: true, priority: 0, targets: [], ...over });
const conflict = (r: Rule, socketable = true) => conflictFor(existing, r, (b) => b.line, (b) => (b === existing[0] ? 'Broadhead Arrow Quiver' : 'Keep 4 or more links'), (b) => (b === existing[0] ? 'build' : ''), () => socketable);

test('a proposed Hide that an earlier Show partly catches says which rule keeps winning and why', () => {
  const c = conflict(rule({ visibility: 'hide', targets: [{ conditions: [{ key: 'Class', op: '==', values: ['Quivers', 'Shields'] }, { key: 'Rarity', op: '<=', values: ['Magic'] }, { key: 'AreaLevel', op: '>=', values: ['68'] }] }] }));
  assert.ok(c);
  assert.equal(c.kind, 'partial');
  assert.equal(c.text, 'Conflicts with your build rule “Show Broadhead Arrow Quiver” (line 1). Your rule stays above, so items called Broadhead Arrow Quiver still show.');
});

test('a proposal an earlier rule already covers is reported as unreachable', () => {
  const c = conflict(rule({ visibility: 'show', targets: [{ conditions: [{ key: 'BaseType', op: '==', values: ['Broadhead Arrow Quiver'] }, { key: 'Rarity', op: '', values: ['Magic'] }] }] }));
  assert.equal(c?.kind, 'hidden');
  assert.match(c!.text, /^Nothing would reach this: your build rule “Show Broadhead Arrow Quiver” \(line 1\)/);
});

test('a proposal nothing above touches, or one that restyles a tier, has no conflict', () => {
  const scroll = rule({ visibility: 'hide', targets: [{ conditions: [{ key: 'BaseType', op: '==', values: ['Scroll of Wisdom'] }] }] });
  assert.equal(conflict(scroll, false), null, 'a scroll cannot have four links');
  assert.equal(conflict(scroll, true)?.kind, 'partial', 'but an item that can is told about the rule above');
  assert.equal(conflict(rule({ visibility: 'hide', targets: [{ tag: { type: 'currency', tier: 't4chaos' } }] })), null);
  assert.equal(candidateBlocks(rule({ targets: [{ tag: { type: 'currency', tier: 't4chaos' } }] })).length, 0);
});
