import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildCatalog } from '../src/shared/lootfilter/catalog.js';
import { parseBlocks, blockStyle } from '../src/shared/lootfilter/blocks.js';
import { generateFilter } from '../src/shared/lootfilter/generate.js';
import { evaluateItem } from '../src/shared/lootfilter/evaluate.js';
import { compileGuided, guidedSentence, newGuidedRule, selectItems } from '../src/shared/lootfilter/guided.js';
import { validateFilter } from '../src/shared/lootfilter/syntax.js';
import type { Clause, GuidedMeta } from '../src/shared/lootfilter/types.js';
import { NEVERSINK_DIR } from './lootfilterHelpers.js';

const text = readFileSync(join(NEVERSINK_DIR, '2-SEMI-STRICT.filter'), 'utf8');
const parsed = parseBlocks(text);
const cat = buildCatalog(parsed.blocks);
const gen = (g: GuidedMeta[]) =>
  generateFilter({ baseText: text, parsed, baseVersion: '8.20.1d', strictness: 2, style: 0, rules: g.map((m, i) => newGuidedRule('g' + i, m, cat, i + 1, 0)) });
const look = (r: ReturnType<typeof gen>, name: string) => {
  const it = cat.byName.get(name)!;
  return evaluateItem(parseBlocks(r.text).blocks, { name, ...(it.class ? { class: it.class } : {}), ...(it.rarity ? { rarity: it.rarity } : {}), itemLevel: 80, stackSize: 1, areaLevel: 83, identified: true, corrupted: false });
};

test('hiding an item hides exactly that item and the filter stays valid', () => {
  const r = gen([{ sel: [{ t: 'item', name: 'Chaos Orb' }], exc: [], act: 'hide' }]);
  assert.equal(validateFilter(r.text).errors, 0);
  assert.equal(look(r, 'Chaos Orb').visible, false);
  assert.equal(look(r, 'Divine Orb').visible, true);
});

test('hiding a tier except one item keeps that item visible', () => {
  const tier = cat.types.find((t) => t.type === 'currency')!.tiers.find((t) => t.items.includes('Chaos Orb'))!;
  const sel: Clause[] = [{ t: 'tier', type: tier.type, tier: tier.tier }];
  const r = gen([{ sel, exc: [{ t: 'item', name: 'Chaos Orb' }], act: 'hide' }]);
  assert.equal(validateFilter(r.text).errors, 0);
  const other = tier.items.find((n) => n !== 'Chaos Orb' && cat.byName.get(n)?.tier === tier.tier)!;
  assert.equal(look(r, other).visible, false, `${other} is hidden with its tier`);
  assert.equal(look(r, 'Chaos Orb').visible, true, 'the exception stays visible');
});

test('loud and stand out copy the section tiers, so a loud card looks like a top card', () => {
  const sel: Clause[] = [{ t: 'item', name: 'The Doctor' }];
  const loud = compileGuided({ sel, exc: [], act: 'loud' }, cat);
  assert.ok(loud.styleFrom && loud.styleFrom.type === 'divination');
  const r = gen([{ sel: [{ t: 'item', name: 'Rain of Chaos' }], exc: [], act: 'loud' }]);
  const rain = look(r, 'Rain of Chaos');
  const top = look(gen([]), 'The Doctor');
  assert.deepEqual(rain.style.bg, top.style.bg);
});

test('put back to normal cancels an earlier hide on the same item', () => {
  const r = gen([
    { sel: [{ t: 'item', name: 'Chaos Orb' }], exc: [], act: 'hide' },
    { sel: [{ t: 'item', name: 'Chaos Orb' }], exc: [], act: 'reset' },
  ]);
  assert.equal(look(r, 'Chaos Orb').visible, true);
});

test('a gear rule compiles to conditions the checker accepts', () => {
  const g: Clause = { t: 'gear', rar: { normal: 1, magic: 1 }, cls: { boots: 1, gloves: 1 }, il: 60, lk: 0, q: 10, cor: 'no' };
  const r = gen([{ sel: [g], exc: [{ t: 'gear', rar: {}, cls: {}, il: 1, lk: 4 }], act: 'hide' }]);
  assert.equal(validateFilter(r.text).errors, 0);
  assert.ok(r.userBlocks >= 1);
  assert.match(r.text, /Class == Boots Gloves|Class == "Boots" "Gloves"|Class == Boots "Gloves"/);
});

test('words and counts: sentences name the picks, and selectItems counts real catalog items', () => {
  const m: GuidedMeta = { sel: [{ t: 'item', name: 'Divine Orb' }, { t: 'item', name: 'Chaos Orb' }], exc: [], act: 'standout' };
  assert.equal(guidedSentence(m, cat), 'Make stand out: Divine Orb and Chaos Orb.');
  assert.equal(selectItems(cat, m.sel, [{ t: 'item', name: 'Chaos Orb' }]).length, 1);
  const tier = cat.types.find((t) => t.type === 'currency')!.tiers[0]!;
  assert.equal(selectItems(cat, [{ t: 'tier', type: 'currency', tier: tier.tier }], []).every((i) => i.tier === tier.tier), true);
  assert.ok(blockStyle(parsed.blocks[0]!) !== undefined);
});

test('Make stand out always carries a minimap icon and no sound or beam', () => {
  const r = gen([{ sel: [{ t: 'item', name: 'Orb of Alteration' }], exc: [], act: 'standout' }]);
  const block = r.text.split(/\n(?=Show|Hide)/).find((b) => b.includes('"Orb of Alteration"')) ?? '';
  assert.match(block, /MinimapIcon/);
  assert.doesNotMatch(block, /PlayEffect (?!None)/);
});
