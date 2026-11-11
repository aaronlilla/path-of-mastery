import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileSearch, luaPatternToRegExp, matchOrPattern, orPatterns, prepSearch } from '../src/renderer/tree/treeSearch.js';

const node = (name: string, lines: string[], type = 'Notable', recipe?: string[]) => ({ name, lines, type, recipe });
const hits = (q: string, n: ReturnType<typeof node>) => compileSearch(q)?.(n) ?? false;

test('words split on white space and quoted phrases stay whole', () => {
  assert.deepEqual(prepSearch('Maximum  Life'), ['maximum', 'life']);
  assert.deepEqual(prepSearch('"maximum life" fire'), ['maximum life', 'fire']);
  assert.equal(compileSearch('   '), null);
});

test('a plain word matches name, a stat line or the node type', () => {
  const n = node('Heart of Oak', ['+40 to maximum Life', '10% increased Fire Damage']);
  assert.ok(hits('oak', n));
  assert.ok(hits('life', n));
  assert.ok(hits('notable', n));
  assert.ok(!hits('cold', n));
  // every word has to match somewhere
  assert.ok(hits('life fire', n));
  assert.ok(!hits('life cold', n));
});

test('alternation: a|b and (a|b) mean either', () => {
  const n = node('Heart of Oak', ['+40 to maximum Life']);
  assert.ok(hits('life|mana', n));
  assert.ok(hits('mana|life', n));
  assert.ok(!hits('mana|chaos', n));
  const m = node('Elemental Focus', ['20% increased fire damage', '10% increased crit chance']);
  assert.ok(hits('(increased.fire|crit)', m));
  assert.deepEqual(orPatterns('a(b|c)d').sort(), ['abd', 'acd']);
});

test('a quoted phrase is one pattern', () => {
  const n = node('Heart of Oak', ['+40 to maximum Life']);
  assert.ok(hits('"maximum life"', n));
  assert.ok(!hits('"life maximum"', n));
  assert.ok(hits('"to maximum" oak', n));
});

test('Lua pattern characters behave like Lua, not like regular expressions', () => {
  assert.ok(matchOrPattern('+30 to dexterity', '+30'));
  assert.ok(matchOrPattern('abc123', '%d+'));
  assert.ok(!matchOrPattern('abc', '%d'));
  assert.ok(matchOrPattern('fire damage', '^fire'));
  assert.ok(!matchOrPattern('cold fire', '^fire'));
  assert.ok(matchOrPattern('aaab', 'a-b'));
  assert.equal(luaPatternToRegExp('%'), null);
  assert.equal(luaPatternToRegExp('(abc'), null);
});

test('a malformed pattern finds nothing, as in the original', () => {
  const n = node('Heart of Oak', ['+40 to maximum Life']);
  assert.ok(!hits('10%', n));
  assert.ok(!hits('(life', n));
});

test('oil: searches the anoint recipe', () => {
  const n = node('Heartseeker', ['crit'], 'Notable', ['TealOil', 'CrimsonOil', 'CrimsonOil']);
  assert.ok(hits('oil: teal', n));
  assert.ok(hits('oil: crimson', n));
  assert.ok(hits('oil: teal crimson', n));
  assert.ok(!hits('oil: golden', n));
  assert.ok(!hits('oil: teal', node('Plain', ['crit'])));
  assert.ok(!hits('crit oil:', node('Plain', ['crit'])));
});
