import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateFilter } from '../src/shared/lootfilter/generate.js';
import { LINK_PREFIX, makeRulePack, makeShareLink, placeRules, readRulePack, readShareLink } from '../src/shared/lootfilter/share.js';
import type { FilterSetup, Rule } from '../src/shared/lootfilter/types.js';
import { NEVERSINK_DIR } from './lootfilterHelpers.js';

const base = readFileSync(join(NEVERSINK_DIR, '2-SEMI-STRICT.filter'), 'utf8');
const setup: FilterSetup = { strictness: 3, style: 1, followBuild: false, use: ['ring'] };
const rules: Rule[] = [
  { id: 'a', name: 'Hide scrolls', source: 'guided', enabled: true, priority: 1, visibility: 'hide', targets: [{ conditions: [{ key: 'BaseType', op: '==', values: ['Scroll of Wisdom', 'Portal Scroll'] }] }] },
  { id: 'b', name: 'Loud divines', source: 'guided', enabled: true, priority: 2, visibility: 'show', style: { fg: [255, 0, 0], sound: { kind: 'custom', file: 'Divine.mp3', vol: 200 } }, targets: [{ conditions: [{ key: 'BaseType', op: '==', values: ['Divine Orb'] }] }] },
  { id: 'build:base:Vaal Regalia', name: 'Vaal Regalia', source: 'build', enabled: true, priority: -1000, visibility: 'show', targets: [{ conditions: [{ key: 'BaseType', op: '==', values: ['Vaal Regalia'] }] }] },
];
const gen = (rs: Rule[], s: FilterSetup) => generateFilter({ baseText: base, baseVersion: '8.20.1d', strictness: 2, style: s.style, rules: rs, now: new Date('2026-09-30T12:00:00Z') });

test('a share link carries the whole filter and reads back to the same rules and the same file', async () => {
  const link = await makeShareLink({ v: 1, name: 'Mapping', setup, rules });
  assert.ok(link.startsWith(LINK_PREFIX));
  assert.ok(!/[\s+/=]/.test(link.slice(LINK_PREFIX.length)), 'the code is safe to paste anywhere');
  const back = await readShareLink(link);
  assert.deepEqual(back, { v: 1, name: 'Mapping', setup, rules });
  assert.equal(gen(back!.rules, back!.setup).rulesHash, gen(rules, setup).rulesHash);
});

test('the bare code works as well as the full link, and garbage is refused', async () => {
  const link = await makeShareLink({ v: 1, name: 'x', setup, rules });
  assert.equal((await readShareLink(link.slice(LINK_PREFIX.length)))?.name, 'x');
  assert.equal(await readShareLink('hello world'), null);
  assert.equal(await readShareLink(LINK_PREFIX + 'AAAAAAAAAAAAAAAAAAAAAAAA'), null);
  assert.equal(await readShareLink(''), null);
});

test('a rule pack holds only the player\'s own rules and reads back whole', () => {
  const text = makeRulePack('My pack', rules);
  const pack = readRulePack(text)!;
  assert.equal(pack.name, 'My pack');
  assert.deepEqual(pack.rules.map((r) => r.id), ['a', 'b']);
  assert.deepEqual(pack.rules, rules.slice(0, 2));
});

test('a rule pack reader refuses other JSON and plain filter text', () => {
  assert.equal(readRulePack('{"kind":"other","version":1,"rules":[]}'), null);
  assert.equal(readRulePack('Show\n  BaseType == "Chaos Orb"\n'), null);
});

test('rules from a pack land above the existing ones, in their own order, with new ids', () => {
  const placed = placeRules(rules.slice(0, 2), 'p1', 10, 5);
  assert.deepEqual(placed.map((r) => [r.id, r.priority]), [['a-p1', 11], ['b-p1', 12]]);
  assert.ok(placed.every((r) => r.createdAt === 5));
});
