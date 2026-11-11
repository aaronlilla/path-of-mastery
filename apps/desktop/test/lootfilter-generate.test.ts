import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Rule } from '../src/shared/lootfilter/types.js';
import { generateFilter, parseHeader, rulesSignature, expandExceptions, hashText } from '../src/shared/lootfilter/generate.js';
import { blockStyle, normalizeNewlines, parseBlocks, tagKey } from '../src/shared/lootfilter/blocks.js';
import { validateFilter } from '../src/shared/lootfilter/syntax.js';
import { STRICTNESS } from '../src/shared/lootfilter/styles.js';
import { NEVERSINK_DIR } from './lootfilterHelpers.js';

const NOW = new Date('2026-09-30T12:00:00Z');
const VERSION = '8.20.1d';
const base = (i: number): string => readFileSync(join(NEVERSINK_DIR, STRICTNESS[i]!.file), 'utf8');

function rule(over: Partial<Rule> & { id: string }): Rule {
  return { source: 'advanced', enabled: true, priority: 1, targets: [], ...over };
}
const gen = (rules: Rule[], strictness = 2, style = 0) => generateFilter({ baseText: base(strictness), baseVersion: VERSION, strictness, style, rules, now: NOW });

const hideChaos = rule({ id: 'r1', priority: 1, visibility: 'hide', targets: [{ conditions: [{ key: 'BaseType', op: '==', values: ['Chaos Orb'] }] }] });

test('with no rules the base text is carried over byte for byte', () => {
  const r = gen([]);
  const baseNorm = normalizeNewlines(base(2));
  assert.ok(r.text.endsWith(baseNorm), 'the NeverSink text is the tail of the file');
  assert.equal(r.userBlocks, 0);
  assert.equal(r.restyledBlocks, 0);
  assert.equal(r.fileText.includes('\r\n'), true);
  assert.equal(r.fileText.replace(/\r\n/g, '\n'), r.text);
});

test('header carries base version, strictness, style and a rules hash that we can read back', () => {
  const r = gen([hideChaos]);
  const h = parseHeader(r.fileText);
  assert.ok(h);
  assert.equal(h.format, 1);
  assert.equal(h.baseVersion, VERSION);
  assert.equal(h.strictness, 2);
  assert.equal(h.strictnessName, 'Semi-Strict');
  assert.equal(h.style, 'Standard');
  assert.equal(h.rulesHash, r.rulesHash);
  assert.equal(h.rules, 1);
  assert.equal(h.needsReview, 0);
  assert.equal(h.generated, '2026-09-30T12:00:00.000Z');
  assert.equal(parseHeader(base(2)), null, 'a NeverSink file has no header of ours');
});

test('the rules hash changes with the rules and ignores disabled rules and labels', () => {
  const a = rulesSignature([hideChaos], 2, 0);
  assert.notEqual(a, rulesSignature([{ ...hideChaos, visibility: 'show' }], 2, 0));
  assert.notEqual(a, rulesSignature([hideChaos], 3, 0));
  assert.notEqual(a, rulesSignature([hideChaos], 2, 1));
  assert.equal(a, rulesSignature([hideChaos, { ...hideChaos, id: 'off', enabled: false }], 2, 0));
  assert.equal(a, rulesSignature([{ ...hideChaos, name: 'a new label', why: 'x' }], 2, 0));
});

test('user rules sit above the base, highest priority first', () => {
  const lo = rule({ id: 'lo', priority: 1, visibility: 'hide', targets: [{ conditions: [{ key: 'BaseType', op: '==', values: ['Chaos Orb'] }] }] });
  const hi = rule({
    id: 'hi',
    priority: 5,
    style: { fs: 40, fg: [1, 2, 3] },
    targets: [{ conditions: [{ key: 'BaseType', op: '==', values: ['Chaos Orb'] }] }],
  });
  const r = gen([lo, hi]);
  const blocks = parseBlocks(r.text).blocks;
  const iHi = blocks.findIndex((b) => b.ruleId === 'hi');
  const iLo = blocks.findIndex((b) => b.ruleId === 'lo');
  const firstBase = blocks.findIndex((b) => b.tag);
  assert.ok(iHi >= 0 && iLo >= 0);
  assert.ok(iHi < iLo, 'higher priority is written first so it matches first');
  assert.ok(iLo < firstBase, 'all user rules are above NeverSink');
  assert.equal(blocks[iHi]!.kind, 'Show');
  assert.equal(blocks[iLo]!.kind, 'Hide');
  assert.deepEqual(blockStyle(blocks[iHi]!).fg, [1, 2, 3]);
  assert.equal(r.userBlocks, 2);
  assert.equal(validateFilter(r.text).errors, 0);
});

test('a tier rule restyles that tier in place, by its tag, and nothing else', () => {
  const t4 = { type: 'currency', tier: 't4chaos' };
  const r = gen([rule({ id: 'ts', targets: [{ tag: t4 }], style: { fs: 33, bg: [1, 2, 3, 200], sound: null } })]);
  const before = parseBlocks(base(2)).blocks;
  const after = parseBlocks(r.text).blocks.filter((b) => !b.ruleId);
  assert.equal(after.length, before.length, 'no block added or lost');
  let changed = 0;
  for (let i = 0; i < before.length; i++) {
    const b = before[i]!;
    const a = after[i]!;
    const same = JSON.stringify(blockStyle(b)) === JSON.stringify(blockStyle(a)) && b.kind === a.kind;
    if (b.tag && tagKey(b.tag) === tagKey(t4)) {
      assert.equal(blockStyle(a).fs, 33);
      assert.deepEqual(blockStyle(a).bg, [1, 2, 3, 200]);
      assert.equal(blockStyle(a).sound, null);
      assert.deepEqual(blockStyle(a).fg, blockStyle(b).fg, 'fields the rule does not set are kept');
      assert.deepEqual(a.conditions, b.conditions, 'conditions are untouched');
      changed++;
    } else assert.ok(same, `block at ${b.line} should be untouched`);
  }
  assert.equal(changed, 1);
  assert.equal(r.restyledBlocks, 1);
  assert.equal(r.userBlocks, 0);
  assert.equal(validateFilter(r.text).errors, 0);
});

test('hiding a tier switches its blocks to Hide; showing one back adds the look the rule gives', () => {
  const hid = gen([rule({ id: 'h', visibility: 'hide', targets: [{ tag: { type: 'currency', tier: 't4chaos' } }] })]);
  const b = parseBlocks(hid.text).blocks.find((x) => x.tag && x.tag.tier === 't4chaos' && x.tag.type === 'currency')!;
  assert.equal(b.kind, 'Hide');
  assert.equal(blockStyle(b).fs, undefined, 'a Hide block carries no look');
  const shown = gen([rule({ id: 's', visibility: 'show', style: { fs: 40, fg: [9, 9, 9] }, targets: [{ tag: { type: 'currency', tier: 't9armour' } }] })]);
  const s = parseBlocks(shown.text).blocks.find((x) => x.tag && x.tag.tier === 't9armour' && x.tag.type === 'currency')!;
  assert.equal(s.kind, 'Show');
  assert.equal(blockStyle(s).fs, 40);
  assert.equal(validateFilter(shown.text).errors, 0);
});

test('matching another tier copies its current look', () => {
  const r = gen([rule({ id: 'm', visibility: 'show', styleFrom: { type: 'currency', tier: 't1exalted' }, targets: [{ conditions: [{ key: 'BaseType', op: '==', values: ['Vaal Orb'] }] }] })]);
  const blocks = parseBlocks(r.text).blocks;
  const mine = blocks.find((b) => b.ruleId === 'm')!;
  const src = blocks.find((b) => b.tag?.tier === 't1exalted' && b.tag.type === 'currency')!;
  assert.deepEqual(blockStyle(mine), blockStyle(src));
});

test('a rule whose tag vanished is flagged needs review, kept out of the file and named in the header', () => {
  const gone = rule({ id: 'gone', targets: [{ tag: { type: 'currency', tier: 't99doesnotexist' } }], style: { fs: 40 } });
  const r = gen([gone, hideChaos]);
  assert.deepEqual(r.needsReview.map((n) => [n.ruleId, n.kind]), [['gone', 'tag-missing']]);
  assert.equal(parseBlocks(r.text).blocks.filter((b) => b.ruleId === 'gone').length, 0);
  const h = parseHeader(r.text)!;
  assert.equal(h.needsReview, 1);
  assert.equal(h.rules, 1, 'the good rule still counts');
  assert.match(r.text, /# needs review: rule gone:/);
  assert.equal(validateFilter(r.text).errors, 0);
});

test('exceptions become plain blocks: items matching an exception are left out', () => {
  // Hide white and magic gear except Two-Toned Boots, and except any item with 4 or more links.
  const sets = expandExceptions(
    [
      { key: 'Class', op: '==', values: ['Boots', 'Helmets'] },
      { key: 'Rarity', op: '', values: ['Normal', 'Magic'] },
    ],
    [[{ key: 'BaseType', op: '==', values: ['Two-Toned Boots'] }], [{ key: 'LinkedSockets', op: '>=', values: ['4'] }]],
  )!;
  assert.ok(sets.length >= 1);
  // Every block must say not Two-Toned Boots and fewer than 4 links, in some form.
  for (const s of sets) {
    const text = JSON.stringify(s);
    assert.match(text, /Two-Toned Boots/);
    assert.match(text, /LinkedSockets/);
  }
  const r = gen([
    rule({
      id: 'ex',
      visibility: 'hide',
      targets: [{ conditions: [{ key: 'Class', op: '==', values: ['Boots'] }, { key: 'Rarity', op: '', values: ['Normal', 'Magic'] }] }],
      except: [[{ key: 'BaseType', op: '==', values: ['Two-Toned Boots'] }], [{ key: 'LinkedSockets', op: '>=', values: ['4'] }]],
    }),
  ]);
  assert.equal(validateFilter(r.text).errors, 0);
  assert.ok(r.userBlocks >= 1);
});

test('a BaseType exception on an exact BaseType list just removes the name', () => {
  const sets = expandExceptions(
    [{ key: 'BaseType', op: '==', values: ['Chaos Orb', 'Divine Orb'] }],
    [[{ key: 'BaseType', op: '==', values: ['Divine Orb'] }]],
  )!;
  assert.deepEqual(sets, [[{ key: 'BaseType', op: '==', values: ['Chaos Orb'] }]]);
  assert.deepEqual(expandExceptions([{ key: 'BaseType', op: '==', values: ['Divine Orb'] }], [[{ key: 'BaseType', op: '==', values: ['Divine Orb'] }]]), []);
});

test('an exception with no plain negation is flagged, not guessed', () => {
  const r = gen([
    rule({
      id: 'cx',
      visibility: 'hide',
      targets: [{ conditions: [{ key: 'Class', op: '==', values: ['Boots'] }] }],
      except: [[{ key: 'Sockets', op: '>=', values: ['5GGG'] }]],
    }),
  ]);
  assert.deepEqual(r.needsReview.map((n) => n.kind), ['except-complex']);
});

test('put back to normal cancels lower rules on the same tier and the same base types', () => {
  const t = { type: 'currency', tier: 't4chaos' };
  const low = rule({ id: 'low', priority: 1, visibility: 'hide', targets: [{ tag: t }, { conditions: [{ key: 'BaseType', op: '==', values: ['Chaos Orb', 'Vaal Orb'] }] }] });
  const reset = rule({ id: 'back', priority: 2, reset: true, targets: [{ tag: t }, { conditions: [{ key: 'BaseType', op: '==', values: ['Chaos Orb'] }] }] });
  const r = gen([low, reset]);
  const blocks = parseBlocks(r.text).blocks;
  const t4 = blocks.find((b) => b.tag && tagKey(b.tag) === tagKey(t))!;
  assert.equal(t4.kind, 'Show', 'the tier hide is cancelled');
  const mine = blocks.filter((b) => b.ruleId === 'low');
  assert.equal(mine.length, 1);
  assert.deepEqual(mine[0]!.conditions[0]!.values, ['Vaal Orb'], 'only the base types the reset does not name remain');
});

test('a whole-filter style restyles every lit tier and the result is still valid', () => {
  for (const style of [1, 2, 3]) {
    const r = gen([], 2, style);
    assert.ok(r.restyledBlocks === 0, 'the style is not a rule');
    assert.equal(validateFilter(r.text).errors, 0, `style ${style}`);
    assert.notEqual(r.text.slice(r.baseStartLine), normalizeNewlines(base(2)).slice(0, r.text.length - r.baseStartLine));
  }
  const dark = parseBlocks(gen([], 2, 1).text).blocks.find((b) => b.tag?.tier === 't4chaos' && b.tag.type === 'currency')!;
  assert.ok(blockStyle(dark).bg![0]! < 100, 'the orange t4 background is darkened');
});

test('five strictness levels times several rule sets all pass the syntax checker and keep NeverSink block structure', () => {
  const sets: Rule[][] = [
    [],
    [hideChaos],
    [
      hideChaos,
      rule({ id: 'g1', priority: 2, visibility: 'hide', targets: [{ conditions: [{ key: 'Class', op: '==', values: ['Body Armours'] }, { key: 'Rarity', op: '', values: ['Normal'] }, { key: 'ItemLevel', op: '>=', values: ['60'] }] }] }),
      rule({ id: 't', priority: 3, targets: [{ tag: { type: 'divination', tier: 't1' } }], style: { fs: 45, fg: [255, 0, 0], beam: { colour: 'Red' }, icon: { size: 0, colour: 'Red', shape: 'Star' }, sound: { kind: 'builtin', id: 6, vol: 300 } } }),
      rule({ id: 'c', priority: 4, visibility: 'show', style: { sound: { kind: 'custom', file: 'Map.mp3', vol: 100 } }, targets: [{ conditions: [{ key: 'BaseType', op: '==', values: ['Divine Orb'] }] }], continue: true }),
    ],
  ];
  let files = 0;
  for (let lvl = 0; lvl < 5; lvl++) {
    const baseBlocks = parseBlocks(base(lvl)).blocks;
    const baseTags = baseBlocks.map((b) => (b.tag ? tagKey(b.tag) : '-')).join(',');
    for (const rules of sets) {
      const r = gen(rules, lvl);
      const v = validateFilter(r.fileText);
      assert.equal(v.errors, 0, `level ${lvl}: ${JSON.stringify(v.issues.slice(0, 3))}`);
      const out = parseBlocks(r.text).blocks;
      const baseOut = out.filter((b) => !b.ruleId);
      assert.equal(baseOut.length, baseBlocks.length, 'same number of NeverSink blocks');
      assert.equal(baseOut.map((b) => (b.tag ? tagKey(b.tag) : '-')).join(','), baseTags, 'same tags in the same order');
      assert.ok(r.bytes < 1024 * 1024);
      files++;
    }
  }
  assert.equal(files, 15);
});

test('hashText is stable and differs for different input', () => {
  assert.equal(hashText('abc'), hashText('abc'));
  assert.notEqual(hashText('abc'), hashText('abd'));
  assert.equal(hashText('abc').length, 16);
});
