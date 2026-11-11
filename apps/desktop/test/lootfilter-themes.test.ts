import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateFilter } from '../src/shared/lootfilter/generate.js';
import { blockStyle, parseBlocks } from '../src/shared/lootfilter/blocks.js';
import { validateFilter } from '../src/shared/lootfilter/syntax.js';
import { STRICTNESS, applyStylePreset, STYLES } from '../src/shared/lootfilter/styles.js';
import { SECTIONS, isNamedType, sectionOfType, themeScopeOfType } from '../src/shared/lootfilter/sections.js';
import { buildCatalog } from '../src/shared/lootfilter/catalog.js';
import type { Block, Rule } from '../src/shared/lootfilter/types.js';
import { NEVERSINK_DIR } from './lootfilterHelpers.js';

const NOW = new Date('2026-09-30T12:00:00Z');
const text = readFileSync(join(NEVERSINK_DIR, STRICTNESS[2]!.file), 'utf8');
const gen = (o: { style?: number; styleCurrency?: number; styleGear?: number }) =>
  generateFilter({ baseText: text, baseVersion: '8.20.1d', strictness: 2, style: o.style ?? 0, ...(o.styleCurrency !== undefined ? { styleCurrency: o.styleCurrency } : {}), ...(o.styleGear !== undefined ? { styleGear: o.styleGear } : {}), rules: [], now: NOW });

const baseBlocks = parseBlocks(text).blocks;
/** The written block for a base block: the same tag, in the same order of appearance. */
function pairs(out: string): { base: Block; made: Block }[] {
  const made = parseBlocks(out).blocks.filter((b) => !b.ruleId);
  const tail = made.slice(made.length - baseBlocks.length);
  return baseBlocks.map((b, i) => ({ base: b, made: tail[i]! }));
}
const same = (a: Block, b: Block): boolean => JSON.stringify(blockStyle(a)) === JSON.stringify(blockStyle(b));

test('Minimal is a black label with no border and no beam, as its description says', () => {
  assert.equal(STYLES[2]!.blurb, 'Black label, no border, no beams. Text only.');
  const s = applyStylePreset({ fg: [255, 255, 255], bg: [240, 90, 35, 255], bd: [255, 255, 255], fs: 40, beam: { colour: 'Red' }, icon: { size: 0, colour: 'Red', shape: 'Star' } }, 2);
  assert.deepEqual(s.bg, [0, 0, 0, 255]);
  assert.deepEqual(s.bd, [0, 0, 0, 0]);
  assert.equal(s.beam, null, 'PlayEffect None');
  assert.equal(s.fs, 40, 'the size is not touched');
  assert.deepEqual(s.fg, [240, 90, 35], 'the text keeps the colour the tier is known by');
});

test('currency only restyles currency blocks and leaves everything else as NeverSink has it', () => {
  const out = gen({ styleCurrency: 2 });
  assert.equal(validateFilter(out.text).errors, 0, 'the syntax checker accepts the file');
  let currencyChanged = 0;
  for (const { base, made } of pairs(out.text)) {
    const scope = themeScopeOfType(base.tag?.type);
    if (scope === 'currency') {
      if (!same(base, made)) currencyChanged++;
    } else assert.ok(same(base, made), `block at line ${base.line} (${base.tag?.type}) must be untouched`);
  }
  assert.ok(currencyChanged > 50, `currency blocks restyled: ${currencyChanged}`);
});

test('gear only restyles gear blocks and leaves currency alone', () => {
  const out = gen({ styleGear: 3 });
  assert.equal(validateFilter(out.text).errors, 0);
  let gearChanged = 0;
  for (const { base, made } of pairs(out.text)) {
    const scope = themeScopeOfType(base.tag?.type);
    if (scope === 'gear') {
      if (!same(base, made)) gearChanged++;
    } else assert.ok(same(base, made), `block at line ${base.line} (${base.tag?.type}) must be untouched`);
  }
  assert.ok(gearChanged >= 5, `gear blocks restyled: ${gearChanged}`);
});

test('a scope style wins over the whole-filter style inside its scope only', () => {
  const out = gen({ style: 1, styleCurrency: 3 });
  const whole = gen({ style: 1 });
  const cur = gen({ style: 3 });
  const a = pairs(out.text);
  const w = pairs(whole.text);
  const c = pairs(cur.text);
  for (let i = 0; i < a.length; i++) {
    const scope = themeScopeOfType(a[i]!.base.tag?.type);
    assert.ok(same(a[i]!.made, scope === 'currency' ? c[i]!.made : w[i]!.made), `line ${a[i]!.base.line} (${scope})`);
  }
  assert.equal(validateFilter(out.text).errors, 0);
});

test('the header and the rules hash change with a scope style', () => {
  const a = gen({ style: 0 });
  const b = gen({ style: 0, styleCurrency: 2 });
  assert.notEqual(a.rulesHash, b.rulesHash);
  assert.match(b.text, /# style: Standard \(currency Minimal\)/);
});

test('every NeverSink type belongs to a named section, and a section only names types that exist or are marked as such', () => {
  const cat = buildCatalog(baseBlocks);
  const loose = cat.types.filter((t) => !isNamedType(t.type)).map((t) => t.type);
  assert.deepEqual(loose, [], 'types no section names');
  const ids = new Set<string>();
  for (const s of SECTIONS) {
    assert.ok(!ids.has(s.id), `duplicate section id ${s.id}`);
    ids.add(s.id);
  }
  assert.equal(sectionOfType('currency').name, 'General currency');
  assert.equal(sectionOfType('divination').name, 'Divination cards');
  assert.equal(sectionOfType('currency->trial->omen').name, 'Omens');
});

test('stacked tiering off comments out only the stacked-currency blocks, and the file still checks clean', () => {
  const on = generateFilter({ baseText: text, baseVersion: '8.20.1d', strictness: 2, style: 0, rules: [], now: NOW });
  const off = generateFilter({ baseText: text, baseVersion: '8.20.1d', strictness: 2, style: 0, stackedTiering: false, rules: [], now: NOW });
  assert.equal(validateFilter(off.text).errors, 0);
  assert.notEqual(on.rulesHash, off.rulesHash);
  const live = (t: string) => parseBlocks(t).blocks.filter((b) => b.tag && /^currency->stacked/.test(b.tag.type)).length;
  assert.ok(live(on.text) > 20, `stacked blocks on: ${live(on.text)}`);
  assert.equal(live(off.text), 0, 'every stacked currency block is switched off');
  const total = (t: string) => parseBlocks(t).blocks.length;
  assert.ok(total(on.text) - total(off.text) >= live(on.text), 'nothing else went missing');
  // Regular currency tiers are not stacked tiers.
  assert.equal(parseBlocks(off.text).blocks.filter((b) => b.tag?.type === 'currency').length, parseBlocks(on.text).blocks.filter((b) => b.tag?.type === 'currency').length);
});

test('a tier the player added writes nothing until it has an item, then writes one block with its look', () => {
  const mk = (names: string[]): Rule => ({ id: 'ct1', name: 'F tier · Yours', source: 'advanced', enabled: true, priority: 5, visibility: 'show', customTier: { type: 'currency' }, style: { fg: [1, 2, 3], fs: 40 }, targets: [{ conditions: names.length ? [{ key: 'BaseType', op: '==', values: names }] : [] }] });
  const empty = generateFilter({ baseText: text, baseVersion: '8.20.1d', strictness: 2, style: 0, rules: [mk([])], now: NOW });
  const plain = generateFilter({ baseText: text, baseVersion: '8.20.1d', strictness: 2, style: 0, rules: [], now: NOW });
  assert.equal(empty.userBlocks, 0);
  assert.equal(empty.text.includes('pom:rule=ct1'), false);
  assert.equal(parseBlocks(empty.text).blocks.length, parseBlocks(plain.text).blocks.length);
  const filled = generateFilter({ baseText: text, baseVersion: '8.20.1d', strictness: 2, style: 0, rules: [mk(['Chaos Orb', 'Regal Orb'])], now: NOW });
  assert.equal(filled.userBlocks, 1);
  assert.equal(validateFilter(filled.text).errors, 0);
  const mine = parseBlocks(filled.text).blocks.find((b) => b.ruleId === 'ct1');
  assert.ok(mine);
  assert.deepEqual(mine!.conditions.find((c) => c.key === 'BaseType')!.values, ['Chaos Orb', 'Regal Orb']);
  assert.equal(blockStyle(mine!).fs, 40);
});
