import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Block, Rule } from '../src/shared/lootfilter/types.js';
import { blockStyle, parseBlocks, tagKey } from '../src/shared/lootfilter/blocks.js';
import { generateFilter } from '../src/shared/lootfilter/generate.js';
import { importFilter } from '../src/shared/lootfilter/importFilter.js';
import { STRICTNESS } from '../src/shared/lootfilter/styles.js';
import { validateFilter } from '../src/shared/lootfilter/syntax.js';
import { NEVERSINK_DIR } from './lootfilterHelpers.js';

const file = (i: number): string => readFileSync(join(NEVERSINK_DIR, STRICTNESS[i]!.file), 'utf8');
const bases = new Map<number, Block[]>();
const baseBlocks = (i: number): Block[] => {
  if (!bases.has(i)) bases.set(i, parseBlocks(file(i)).blocks);
  return bases.get(i)!;
};
const gen = (rules: Rule[], strictness = 2, style = 0) => generateFilter({ baseText: file(strictness), baseVersion: '8.20.1d', strictness, style, rules, now: new Date('2026-10-01T00:00:00Z') });

/** What the game would do with a file: every block's kind, tag, conditions and look, with rule ids and comments ignored. */
const shape = (text: string): string[] =>
  parseBlocks(text).blocks.map((b) => JSON.stringify([b.kind, b.tag ? tagKey(b.tag) : '', b.conditions, blockStyle(b), b.continue]));

const mine: Rule[] = [
  { id: 'a', source: 'guided', enabled: true, priority: 3, visibility: 'hide', targets: [{ conditions: [{ key: 'BaseType', op: '==', values: ['Chaos Orb'] }] }] },
  { id: 'b', source: 'advanced', enabled: true, priority: 2, visibility: 'show', style: { fs: 40, fg: [1, 2, 3], beam: { colour: 'Red' } }, targets: [{ conditions: [{ key: 'Class', op: '==', values: ['Boots'] }, { key: 'ItemLevel', op: '>=', values: ['80'] }] }] },
  { id: 'c', source: 'guided', enabled: true, priority: 1, visibility: 'hide', targets: [{ tag: { type: 'currency', tier: 't4chaos' } }] },
  { id: 'd', source: 'advanced', enabled: true, priority: 0, style: { fs: 33, sound: null }, targets: [{ tag: { type: 'divination', tier: 't1' } }] },
];

test('importing our own file gives rules that write the same filter back', () => {
  const first = gen(mine);
  const r = importFilter(first.text, baseBlocks);
  assert.equal(r.recognised, true);
  assert.equal(r.strictness, 2);
  assert.equal(r.rawBlocks, 0, r.flags.join('; '));
  assert.equal(r.tierRules, 2, 'the two restyled tiers');
  assert.equal(r.conditionRules, 2, 'the two condition blocks');
  const again = gen(r.rules);
  assert.deepEqual(shape(again.text), shape(first.text));
  assert.equal(validateFilter(again.text).errors, 0);
});

test('a plain NeverSink file imports as no rules at all', () => {
  const r = importFilter(file(3), baseBlocks);
  assert.equal(r.strictness, 3);
  assert.equal(r.rules.length, 0);
  assert.equal(r.baseVersion, '8.20.1d');
});

test('a hand-edited file: changed tiers and new blocks map, odd blocks are kept verbatim and flagged', () => {
  let text = file(2).replace(/\r\n/g, '\n');
  // change one tier's font size, hide another tier, add our own block and a block with a line we do not edit
  text = text.replace(/(Show # %H6 \$type->currency \$tier->t4chaos\n(?:.*\n)*?\tSetFontSize )45/, '$132');
  text = text.replace('Show # %HS4 $type->currency $tier->t5alchemy', 'Hide # %HS4 $type->currency $tier->t5alchemy');
  text = 'Show\n\tBaseType == "Mirror Shard"\n\tSetFontSize 45\n\tSetTextColor 255 0 0\n\nShow\n\tClass == "Maps"\n\tSomeFutureKeyword 3\n\n' + text;
  const r = importFilter(text, baseBlocks);
  assert.equal(r.tierRules, 2);
  assert.equal(r.conditionRules, 1);
  assert.equal(r.rawBlocks, 1);
  assert.match(r.flags[0]!, /SomeFutureKeyword/);
  const t4 = r.rules.find((x) => x.targets[0]?.tag?.tier === 't4chaos')!;
  assert.equal(t4.style?.fs, 32);
  const t5 = r.rules.find((x) => x.targets[0]?.tag?.tier === 't5alchemy')!;
  assert.equal(t5.visibility, 'hide');
  const out = gen(r.rules);
  assert.match(out.text, /SomeFutureKeyword 3/, 'the raw block is written as it was');
  const blocks = parseBlocks(out.text).blocks;
  const first = blocks.findIndex((b) => b.conditions.some((c) => c.key === 'BaseType' && c.values.includes('Mirror Shard') && c.op === '=='));
  const raw = blocks.findIndex((b) => b.lines.some((l) => l.key === 'SomeFutureKeyword'));
  assert.ok(first >= 0 && first < raw, 'file order is kept: the first block still wins');
});

test('a block tagged for a tier NeverSink no longer has is kept raw, not dropped', () => {
  const text = file(2).replace(/\r\n/g, '\n') + '\nShow # $type->currency $tier->t99gone\n\tBaseType == "Chaos Orb"\n\tSetFontSize 40\n';
  const r = importFilter(text, baseBlocks);
  assert.equal(r.rawBlocks, 1);
  assert.match(r.flags[0]!, /t99gone/);
});

test('a style named in our header does not turn every tier into a rule', () => {
  const dark = gen([], 2, 1);
  const r = importFilter(dark.text, baseBlocks);
  assert.equal(r.style, 1);
  assert.equal(r.rules.length, 0);
});
