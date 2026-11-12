import { test } from 'node:test';
import assert from 'node:assert/strict';
import { search, type SearchDoc } from '../src/renderer/search/searchIndex.js';
import { buildDocs, settingsDocs } from '../src/renderer/search/shellDocs.js';
import type { BuildEntry } from '../src/shared/library.js';

const info = (cls: string, asc: string, skill: string) => ({ valid: true, level: 90, className: cls, ascendClassName: asc, mainSkill: skill }) as BuildEntry['info'];
const b = (name: string, folder: string, i: BuildEntry['info']): BuildEntry => ({ id: (folder ? folder + '/' : '') + name + '.xml', name, folder, mtimeMs: 0, size: 1, info: i });
const BUILDS = [
  b('Cyclone Slayer', '', info('Duelist', 'Slayer', 'Cyclone')),
  b('Righteous Fire Chieftain', '', info('Marauder', 'Chieftain', 'Righteous Fire')),
  b('Toxic Rain Pathfinder', 'League Starters', info('Ranger', 'Pathfinder', 'Toxic Rain')),
];
const noop = () => undefined;
const DOCS: SearchDoc[] = [
  ...buildDocs(BUILDS, noop),
  ...settingsDocs(noop),
  { kind: 'Action', title: 'Recently deleted', meta: '', extra: 'trash restore', run: noop },
  { kind: 'Action', title: 'New build', meta: 'Ctrl N', run: noop },
];
const titles = (q: string) => search(q, DOCS).flat.map((h) => h.doc.title);

test('a build is found by any word of its name', () => {
  assert.ok(titles('cyclone').includes('Cyclone Slayer'));
  assert.ok(titles('slayer').includes('Cyclone Slayer'));
  assert.ok(titles('Fire').includes('Righteous Fire Chieftain'));
  assert.ok(titles('pathfinder').includes('Toxic Rain Pathfinder'));
});

test('a build is found by its main skill and folder', () => {
  assert.ok(titles('toxic').includes('Toxic Rain Pathfinder'));
  assert.ok(titles('starters').includes('Toxic Rain Pathfinder'));
});

test('a setting is found by its name and by a related word', () => {
  assert.ok(titles('density').includes('Density'));
  assert.ok(titles('compact').includes('Density'));
  assert.ok(titles('proxy').includes('Proxy server'));
  assert.ok(titles('zoom').includes('UI scaling override'));
});

test('the look and the new Settings rows are found, and each opens its own section with its row', () => {
  const opened: Array<[string, string]> = [];
  const docs = settingsDocs((section, row) => opened.push([section, row]));
  const run = (q: string, title: string) => {
    const hit = search(q, docs).flat.find((h) => h.doc.title === title);
    assert.ok(hit, `${q} finds ${title}`);
    hit!.doc.run();
  };
  run('theme', 'Theme');
  run('dark', 'Mode');
  run('frosted', 'Glass');
  run('stone', 'Texture');
  run('check for update', 'Updates');
  run('claude desktop', 'Assistant and account');
  assert.deepEqual(opened, [['appearance', 'Theme'], ['appearance', 'Mode'], ['appearance', 'Glass'], ['appearance', 'Texture'], ['general', 'Updates'], ['account', 'Assistant and account']]);
});

test('commands are found by name', () => {
  assert.ok(titles('recently deleted').includes('Recently deleted'));
  assert.ok(titles('trash').includes('Recently deleted'));
});

test('no suggestion for a word unrelated to anything', () => {
  for (const q of ['zzzzqq', 'xylophone', 'banana', 'qwertyuiop']) assert.equal(search(q, DOCS).suggestion, '', q);
});

test('a suggestion appears for a near miss', () => {
  assert.equal(search('densiyt', DOCS).suggestion, 'density');
  assert.equal(search('proxx servr', DOCS).flat.length > 0, true);
});
