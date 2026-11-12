// A pasted Mobalytics PoE 1 build link or poedb.tw build link imports the build. Samples are real answers saved from the sites.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyImportText } from '../src/shared/buildSites.js';
import { fetchMobalyticsCode, buildCodeFromMobalytics } from '../src/main/library/mobalytics.js';
import { importFromText } from '../src/main/library/importer.js';

const MOB = 'https://mobalytics.gg/poe/builds/fubgun-winter-orb-elementalist';
const mobAnswer = readFileSync('test/fixtures/mobalytics-poe1.json', 'utf8');
const poedbRaw = readFileSync('test/fixtures/poedb-raw.txt', 'utf8');

test('Mobalytics PoE 1 and poedb links are build-site links; PoE 2 and guide links are not', () => {
  const m = classifyImportText(MOB + '/?ref=x');
  assert.equal(m.kind, 'link');
  assert.equal(m.kind === 'link' && m.match.id, 'fubgun-winter-orb-elementalist');
  assert.equal(classifyImportText('https://poedb.tw/pob/eQVFNoqVZrza').kind, 'link');
  assert.equal(classifyImportText('https://mobalytics.gg/poe-2/builds/x').kind, 'unsupported-link');
  assert.equal(classifyImportText('https://mobalytics.gg/poe/guides/x').kind, 'unsupported-link');
});

test('the Mobalytics answer yields the build code, and errors read plainly', async () => {
  assert.ok(buildCodeFromMobalytics(mobAnswer).startsWith('eNrs'));
  let posted = '';
  const code = await fetchMobalyticsCode('fubgun-winter-orb-elementalist', async (url, body, referer) => {
    posted = `${url} ${referer} ${body}`;
    return mobAnswer;
  });
  assert.equal(code, buildCodeFromMobalytics(mobAnswer));
  assert.match(posted, /api\/poe\/v1\/graphql\/query .*\/poe\/builds\/fubgun-winter-orb-elementalist .*"slug":"fubgun-winter-orb-elementalist"/);
  assert.throws(() => buildCodeFromMobalytics(JSON.stringify({ data: { poe: { documents: { userGeneratedDocumentBySlug: { error: 'NOT_FOUND', errorMessage: 'x', data: null } } } } })), /no build at that link/);
  assert.throws(() => buildCodeFromMobalytics('<html>'), /other than JSON/);
});

test('a poedb link is read through its /raw route', async () => {
  let asked = '';
  const d = await importFromText('https://poedb.tw/pob/eQVFNoqVZrza', async (url) => ((asked = url), poedbRaw));
  assert.equal(asked, 'https://poedb.tw/pob/eQVFNoqVZrza/raw');
  assert.equal(d.source, 'poedb');
  assert.ok(d.info.valid);
});
