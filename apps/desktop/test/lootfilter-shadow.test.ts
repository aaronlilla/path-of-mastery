import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBlocks } from '../src/shared/lootfilter/blocks.js';
import { findShadows, blockImplies } from '../src/shared/lootfilter/shadow.js';

const blocks = (t: string) => parseBlocks(t).blocks;

test('a Hide that the Show above it already covers is reported as partly skipped, in plain words', () => {
  const b = blocks(`Show # Keep 4 or more links
\tLinkedSockets >= 4
\tRarity Normal Magic
\tSetFontSize 32

Hide # Hide white and blue gear after act 10
\tAreaLevel >= 68
\tRarity <= Magic
\tClass == "Body Armours" "Helmets"
\tSetFontSize 18
`);
  const f = findShadows(b);
  assert.equal(f.length, 1);
  assert.equal(f[0]!.kind, 'partial');
  assert.equal(f[0]!.block.line, 6);
  assert.equal(f[0]!.by.line, 1);
  assert.equal(f[0]!.takes, 'items with 4 or more links');
});

test('a block whose items are all caught by an earlier block is hidden', () => {
  const b = blocks(`Show # Divine and Chaos
\tBaseType == "Divine Orb" "Chaos Orb"
\tSetFontSize 40

Hide # Chaos again
\tBaseType == "Chaos Orb"
`);
  const f = findShadows(b);
  assert.equal(f.length, 1);
  assert.equal(f[0]!.kind, 'hidden');
  assert.equal(f[0]!.by.line, 1);
});

test('narrower earlier blocks do not hide wider later ones', () => {
  const b = blocks(`Show
\tBaseType == "Chaos Orb"
\tStackSize >= 10

Hide
\tBaseType == "Chaos Orb"
`);
  assert.equal(findShadows(b).filter((x) => x.kind === 'hidden').length, 0);
  assert.equal(blockImplies(b[1]!, b[0]!), false, 'a plain Chaos Orb is not always a stack of 10');
  assert.equal(blockImplies(b[0]!, b[1]!), true, 'a stack of 10 Chaos Orbs is a Chaos Orb');
});

test('blocks with Continue, blocks that cannot meet, and same-kind pairs are left alone', () => {
  const cont = blocks(`Show
\tBaseType == "Chaos Orb"
\tContinue

Hide
\tBaseType == "Chaos Orb"
`);
  assert.equal(findShadows(cont).length, 0);
  const apart = blocks(`Show
\tItemLevel >= 80

Hide
\tItemLevel <= 70
`);
  assert.equal(findShadows(apart).length, 0, 'no item is both level 80 and level 70');
  const sameKind = blocks(`Show
\tLinkedSockets >= 4

Show
\tRarity Normal
`);
  assert.equal(findShadows(sameKind).length, 0);
});

test('number and rarity ranges are compared, not just matched word for word', () => {
  const b = blocks(`Show
\tLinkedSockets >= 3
\tRarity <= Rare

Hide
\tLinkedSockets >= 5
\tRarity Normal Magic
`);
  const f = findShadows(b);
  assert.equal(f[0]?.kind, 'hidden', '5 links is 3 or more, and normal or magic is rare or lower');
});

test('with the class of each base known, a Show for one item does not count against a Hide for a class it is not in', () => {
  const b = blocks(`Show # Scroll
\tBaseType == "Scroll of Wisdom"
\tSetFontSize 45

Hide # Gear
\tClass == "Body Armours" "Helmets"
\tRarity <= Magic
`);
  const classes: Record<string, string> = { 'Scroll of Wisdom': 'Stackable Currency', 'Astral Plate': 'Body Armours' };
  assert.equal(findShadows(b).length, 1, 'without classes the checker cannot rule the overlap out');
  assert.equal(findShadows(b, { classOf: (n) => classes[n] }).length, 0, 'with classes it can');
  const gear = blocks(`Show # Plate
\tBaseType == "Astral Plate"

Hide # Gear
\tClass == "Body Armours" "Helmets"
`);
  assert.equal(findShadows(gear, { classOf: (n) => classes[n] }).length, 1, 'a body armour base still overlaps');
});

test('a Show that lists a gem under its class hides a later Hide of that gem by name, once the class is known', () => {
  const b = blocks(`Show # Gem
\tClass == "Support Gems"
\tBaseType == "Close Combat Support"

Hide # Same gem
\tBaseType == "Close Combat Support"
`);
  assert.equal(findShadows(b)[0]?.kind, 'partial', 'without the class the checker only sees a partial overlap');
  const f = findShadows(b, { classOf: (n) => (n === 'Close Combat Support' ? 'Support Gems' : undefined) });
  assert.equal(f[0]?.kind, 'hidden');
});
