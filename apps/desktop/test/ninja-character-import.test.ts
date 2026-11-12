// Regression: a pasted poe.ninja character link imports that character.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyImportText } from '../src/shared/buildSites.js';
import { importFromText } from '../src/main/library/importer.js';
import { importPublicCharacter } from '../src/main/character/publicImport.js';
import { blankBuildXml } from '../src/shared/buildXml.js';

const URL1 = 'https://poe.ninja/poe1/builds/allflame/character/Someone-1234/ExampleCharacter';

test('a poe.ninja character page is a character link, not an unsupported link', () => {
  assert.deepEqual(classifyImportText(URL1), { kind: 'character-link', account: 'Someone-1234', character: 'ExampleCharacter' });
  assert.equal(classifyImportText('https://poe.ninja/poe1/builds/allflame/character/A%20B-1234/Char%20X').kind, 'character-link');
  assert.equal(classifyImportText('https://poe.ninja/poe1/pob/abc123').kind, 'link');
  assert.equal(classifyImportText('https://example.com/x').kind, 'unsupported-link');
});

test('importing a character link goes through the character import and the normal import path', async () => {
  let asked: string[] = [];
  const d = await importFromText(URL1, undefined, async (account, character) => {
    asked = [account, character];
    return blankBuildXml('Duelist', 100);
  });
  assert.deepEqual(asked, ['Someone-1234', 'ExampleCharacter']);
  assert.match(d.xml, /<PathOfBuilding/);
  await assert.rejects(importFromText(URL1), /not available here/);
  await assert.rejects(importFromText(URL1, undefined, async () => { throw new Error('private profile'); }), /Could not read that character from poe\.ninja\. private profile/);
});

test('importPublicCharacter lists the account, finds the character and applies it to a blank build', async () => {
  const calls: string[] = [];
  const svc = {
    list: async (source: string, realm: string, account: string) => { calls.push(`list ${source} ${realm} ${account}`); return { account: 'Someone#1234', characters: [{ name: 'ExampleCharacter', league: 'Allflame', class: 'Chieftain', level: 100, realm: 'pc' }] }; },
    fetch: async (req: { account: string; character: { name: string } }) => { calls.push(`fetch ${req.account} ${req.character.name}`); return { character: req.character }; },
    apply: async (xml: string) => { calls.push('apply'); return { xml, notes: [] }; },
  };
  const xml = await importPublicCharacter('Someone-1234', 'examplecharacter', svc as never);
  assert.match(xml, /<PathOfBuilding/);
  assert.deepEqual(calls, ['list name pc Someone-1234', 'fetch Someone#1234 ExampleCharacter', 'apply']);
  await assert.rejects(importPublicCharacter('Someone-1234', 'Nobody', svc as never), /has no character called Nobody/);
});
