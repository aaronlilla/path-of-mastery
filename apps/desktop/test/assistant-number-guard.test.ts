// Numbers come only from tool results. An answer with typed
// digits or references that hold nothing is not shown; it is asked for again once, and a hole is never drawn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { auditText, checkedPlain, dropBadSentences, type ResultStore } from '../src/shared/assistant/refs.js';

const store: ResultStore = {
  rk1: { tool: 'getBreakdown', data: { pool: { shown: '6877' }, mult: { shown: '0.28' }, result: { shown: '24562' } } },
  rw9: { tool: 'getWealth', data: { items: [{ name: 'Divine Orb', shown: '76 div' }, { name: 'The Apothecary', shown: '30.6 div' }] } },
};
const get = (ref: string) => store[ref];

// The shape of the case 12 reply: numbered steps and figures from a what-if no tool result backs.
const CASE_12 = 'Step 1 the pool you can spend: {{rk1:pool.shown}}. Step 2 divide by {{rk1:mult.shown}} to get {{rk1:result.shown}}. With the mod removed your fire max hit drops from 24.6k to 4,495 and effective HP to 13.7k. You are missing 125 fire resistance on your gear.';
// The shape of the case 36 reply: references that point at nothing.
const CASE_36 = 'Your three most valuable stacks: Divine Orb {{rw9:items[0].shown}}, worth {{rw9:items[0].total}}. The Apothecary: {{rw9:items[1].shown}}, worth {{rw9:items[1].worthIt}}.';

test('typed digits in an answer are found, placeholders are not counted as typed', () => {
  const a = auditText(CASE_12, get);
  assert.deepEqual(a.dangling, []);
  assert.ok(a.typed.includes('24.6k') && a.typed.includes('4,495') && a.typed.includes('13.7k') && a.typed.includes('125'), a.typed.join(' | '));
  assert.ok(a.typed.includes('1') && a.typed.includes('2'), 'numbered steps are typed digits too');
  assert.equal(auditText('Fire max hit is {{rk1:result.shown}}. Nothing else.', get).typed.length, 0);
  assert.equal(auditText('Code `T16` and ```\n12 34\n``` stay out of it, tier T1 and 6L are names.', get).typed.length, 0);
});

test('references that hold nothing are found, and drawn as a dash, never as a hole', () => {
  const a = auditText(CASE_36, get);
  assert.deepEqual(a.dangling, ['{{rw9:items[0].total}}', '{{rw9:items[1].worthIt}}']);
  assert.equal(a.typed.length, 0);
  const drawn = checkedPlain(CASE_36, store);
  assert.match(drawn, /Divine Orb 76 div, worth –\. The Apothecary: 30\.6 div, worth –\./);
  assert.equal(checkedPlain('gone {{nope:x}} ref', store), 'gone – ref');
});

test('the service drops the bad sentence, asks again once only when nothing is left, with a reset of what was shown, and keeps one run per turn', () => {
  const svc = readFileSync(new URL('../../src/main/assistant/service.ts', import.meta.url), 'utf8');
  assert.match(svc, /dropBadSentences\(event\.text, get\)[\s\S]*attempt < 1/);
  assert.match(svc, /push\(\{ type: 'reset', turnId, reason: 'numbers' \}\)/);
  assert.match(svc, /this\.runs\.get\(turnId\) === run/);
  const ui = readFileSync(new URL('../../src/renderer/assistant/useAssistant.ts', import.meta.url), 'utf8');
  assert.match(ui, /case 'reset':/);
});

// The loot panel's model wrote {{ref.path}} with a dot; the number was drawn as a hole.
test('a placeholder written with a dot after the ref reads the same value, and unreadable braces are asked for again', () => {
  assert.equal(checkedPlain('It costs {{rw9.items[1].shown}}.', store), 'It costs 30.6 div.');
  assert.deepEqual(auditText('It costs {{rw9.items[1].shown}}.', get), { typed: [], dangling: [], mismatched: [] });
  assert.deepEqual(auditText('It costs {{ no reference here }}.', get).dangling, ['{{ no reference here }}']);
});

// "Chaos Orb" was drawn with the Mageblood row's quantity and value.
const stash: ResultStore = {
  rs1: { tool: 'getWealth', data: { items: [{ name: 'Divine Orb', quantity: '76', shown: '76 div' }, { name: 'The Apothecary', quantity: '1', shown: '29.86 div' }, { name: 'Mageblood', quantity: '1', shown: '29.76 div' }, { name: 'Chaos Orb', quantity: '9,011', shown: '24.9 div' }] } },
};
const stashGet = (ref: string) => stash[ref];
test('a placeholder next to an item name must read that item: another row is not drawn and the answer is asked for again', () => {
  const wrong = '- **Chaos Orb**: {{rs1:items[2].quantity}} held, worth {{rs1:items[2].shown}} in total.';
  assert.equal(auditText(wrong, stashGet).mismatched.length, 2);
  assert.equal(checkedPlain(wrong, stash), '- **Chaos Orb**: – held, worth – in total.');
  const right = '- **Chaos Orb**: {{rs1:items[3].quantity}} held, worth {{rs1:items[3].shown}} in total. Mageblood is {{rs1:items[2].shown}}, ahead of Chaos Orb at {{rs1:items[3].shown}}.';
  assert.equal(auditText(right, stashGet).mismatched.length, 0);
  assert.match(checkedPlain(right, stash), /Chaos Orb\*\*: 9,011 held, worth 24.9 div/);
  assert.equal(auditText('The total is {{rs1:items[2].shown}}.', stashGet).mismatched.length, 0);
});

// The model called the bare name findLootItems and was told no such tool exists.
import { systemPrompt, lootSystemPrompt } from '../src/main/assistant/prompts.js';
test('both system prompts name the tools with their full mcp__pom__ name', () => {
  assert.match(systemPrompt({ tools: ['getBreakdown', 'lookupPrice'] }), /mcp__pom__<name>, for example mcp__pom__getBreakdown/);
  assert.match(lootSystemPrompt({ tools: ['findLootItems', 'getLootFilter'] }), /mcp__pom__<name>, for example mcp__pom__findLootItems/);
});

test('one typed digit drops that sentence, the rest is shown; nothing left gives null', () => {
  assert.equal(dropBadSentences('Fire max hit is {{rk1:result.shown}}. You are missing 125 fire resistance. Swap the belt.', get), 'Fire max hit is {{rk1:result.shown}}. Swap the belt.');
  assert.equal(dropBadSentences('You are missing 125 fire resistance.', get), null);
});
