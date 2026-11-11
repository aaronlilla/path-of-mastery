import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile, mkdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BuildStore, StoreError, sanitizeName } from '../src/main/library/buildStore.js';
import { DEFAULT_SETTINGS } from '../src/shared/library.js';
import { sanitizeSettings, SettingsStore } from '../src/main/library/settingsStore.js';
import { blankBuildXml, getNotes, readBuildInfo, setNotes } from '../src/shared/buildXml.js';
import { codeColour, parseNotes, serializeNotes } from '../src/shared/notesColour.js';

async function fresh(): Promise<{ store: BuildStore; dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'pom-store-'));
  const store = new BuildStore(join(dir, 'Builds'), join(dir, 'Trash'));
  await store.init();
  return { store, dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const XML = blankBuildXml('Witch', 12);

test('blank builds read back as the class they were made for', () => {
  const info = readBuildInfo(blankBuildXml('Shadow', 7));
  assert.equal(info.className, 'Shadow');
  assert.equal(info.level, 7);
  assert.equal(info.valid, true);
  assert.equal(info.ascendClassName, '');
  assert.equal(info.treeVersion, '3_29');
});

test('names are made safe and never empty', () => {
  assert.equal(sanitizeName('a/b\\c:d*e?f"g<h>i|j'), 'a b c d e f g h i j');
  assert.equal(sanitizeName('  ..hello..  '), 'hello');
  assert.equal(sanitizeName(''), 'Unnamed build');
  assert.equal(sanitizeName('CON'), 'CON build');
});

test('a 120-character name is kept in full', () => {
  const long = 'Very long build name ' + 'x'.repeat(99);
  assert.equal(long.length, 120);
  assert.equal(sanitizeName(long), long);
  assert.equal(sanitizeName('y'.repeat(150)).length, 120);
});

test('create, list, read and save a build', async () => {
  const { store, cleanup } = await fresh();
  try {
    const a = await store.create('', 'Cyclone Slayer', XML);
    assert.equal(a.id, 'Cyclone Slayer.xml');
    const dup = await store.create('', 'Cyclone Slayer', XML);
    assert.equal(dup.name, 'Cyclone Slayer (2)');
    const listing = await store.list();
    assert.equal(listing.builds.length, 2);
    assert.equal(listing.builds[0]!.info.className, 'Witch');
    const opened = await store.read(a.id);
    assert.equal(opened.xml, XML);
    await store.write(a.id, setNotes(XML, 'hello'));
    assert.equal(getNotes((await store.read(a.id)).xml), 'hello');
    await assert.rejects(store.write('Missing.xml', XML), (e: unknown) => e instanceof StoreError && e.code === 'ENOENT');
  } finally {
    await cleanup();
  }
});

test('ids cannot climb out of the builds folder', async () => {
  const { store, cleanup } = await fresh();
  try {
    await assert.rejects(store.read('../secret.xml'), (e: unknown) => e instanceof StoreError && e.code === 'EINVAL');
    await assert.rejects(store.read('a/../../secret.xml'), (e: unknown) => e instanceof StoreError && e.code === 'EINVAL');
    await assert.rejects(store.createFolder('', '..'), StoreError);
    await assert.rejects(store.create('../out', 'x', XML), StoreError);
  } finally {
    await cleanup();
  }
});

test('folders: create, nest, count, rename, delete', async () => {
  const { store, cleanup } = await fresh();
  try {
    await store.createFolder('', 'League Starters');
    await store.createFolder('League Starters', 'Archive');
    await store.create('League Starters/Archive', 'Old', XML);
    await store.create('League Starters', 'New', XML);
    let l = await store.list();
    assert.deepEqual(l.folders.map((f) => [f.path, f.count]), [['League Starters', 2], ['League Starters/Archive', 1]]);
    await assert.rejects(store.createFolder('', 'League Starters'), (e: unknown) => e instanceof StoreError && e.code === 'EEXIST');
    await assert.rejects(store.removeFolder('League Starters', false), (e: unknown) => e instanceof StoreError && e.code === 'ENOTEMPTY');
    const renamed = await store.renameFolder('League Starters', 'Mercenaries');
    assert.equal(renamed.path, 'Mercenaries');
    l = await store.list();
    assert.deepEqual(l.builds.map((b) => b.id).sort(), ['Mercenaries/Archive/Old.xml', 'Mercenaries/New.xml']);
    await store.removeFolder('Mercenaries', true);
    assert.equal((await store.list()).builds.length, 0);
  } finally {
    await cleanup();
  }
});

test('rename, duplicate and move, including name clashes', async () => {
  const { store, cleanup } = await fresh();
  try {
    const a = await store.create('', 'A', XML);
    const b = await store.create('', 'B', XML);
    await assert.rejects(store.renameBuild(a.id, 'B'), (e: unknown) => e instanceof StoreError && e.code === 'EEXIST');
    const r = await store.renameBuild(a.id, 'Renamed');
    assert.equal(r.id, 'Renamed.xml');
    const d = await store.duplicate(r.id);
    assert.equal(d.name, 'Renamed (copy)');
    await store.createFolder('', 'F');
    await store.create('F', 'B', XML);
    await assert.rejects(store.move(b.id, 'F', false), /already in F/);
    const kept = await store.move(b.id, 'F', true);
    assert.equal(kept.id, 'F/B (2).xml');
  } finally {
    await cleanup();
  }
});

test('delete goes to Recently deleted and Undo brings it back, even into a folder that is gone', async () => {
  const { store, dir, cleanup } = await fresh();
  try {
    await store.createFolder('', 'F');
    const b = await store.create('F', 'Keep me', XML);
    const t = await store.remove(b.id);
    assert.equal((await store.list()).builds.length, 0);
    assert.equal((await store.list()).trashCount, 1);
    assert.equal(existsSync(join(dir, 'Builds', 'F', 'Keep me.xml')), false);
    await store.removeFolder('F', true);
    const back = await store.restore(t.token);
    assert.equal(back.id, 'F/Keep me.xml');
    assert.equal((await store.read(back.id)).xml, XML);
    assert.equal((await store.list()).trashCount, 0);
  } finally {
    await cleanup();
  }
});

test('Recently deleted keeps builds for 30 days and then drops them', async () => {
  const { store, cleanup } = await fresh();
  try {
    const t = await store.remove((await store.create('', 'Old', XML)).id);
    assert.equal(await store.purgeExpiredTrash(Date.now() + 29 * 86_400_000), 0);
    assert.equal((await store.listTrash()).length, 1);
    assert.equal(await store.purgeExpiredTrash(Date.now() + 31 * 86_400_000), 1);
    assert.equal((await store.listTrash()).length, 0);
    await assert.rejects(store.restore(t.token), /gone/);
  } finally {
    await cleanup();
  }
});

test('files that are not builds are listed as such and never crash the listing', async () => {
  const { store, dir, cleanup } = await fresh();
  try {
    await writeFile(join(dir, 'Builds', 'junk.xml'), 'not xml at all', 'utf8');
    await writeFile(join(dir, 'Builds', 'readme.txt'), 'ignored', 'utf8');
    await mkdir(join(dir, 'Builds', '.hidden'), { recursive: true });
    const l = await store.list();
    assert.equal(l.builds.length, 1);
    assert.equal(l.builds[0]!.info.valid, false);
  } finally {
    await cleanup();
  }
});

test('the library list reflects a changed file even when it was cached', async () => {
  const { store, dir, cleanup } = await fresh();
  try {
    const a = await store.create('', 'A', blankBuildXml('Witch', 10));
    assert.equal((await store.list()).builds[0]!.info.level, 10);
    const file = join(dir, 'Builds', 'A.xml');
    await writeFile(file, blankBuildXml('Witch', 55), 'utf8');
    await utimes(file, new Date(), new Date(Date.now() + 5000));
    assert.equal((await store.list()).builds.find((b) => b.id === a.id)!.info.level, 55);
  } finally {
    await cleanup();
  }
});

// ---- Notes ---------------------------------------------------------------------------------

test('notes: only the Notes element changes, and the upstream layout is kept', () => {
  const xml = '<PathOfBuilding>\n\t<Build level="1" />\n\t<Notes>\n\t\t\n\t</Notes>\n\t<TreeView a="1" />\n</PathOfBuilding>';
  assert.equal(getNotes(xml), '');
  const out = setNotes(xml, 'line one\nline <two> & "three"');
  assert.equal(out, '<PathOfBuilding>\n\t<Build level="1" />\n\t<Notes>\n\t\tline one\nline &lt;two&gt; &amp; "three"\n\t</Notes>\n\t<TreeView a="1" />\n</PathOfBuilding>');
  assert.equal(getNotes(out), 'line one\nline <two> & "three"');
  assert.equal(setNotes(out, ''), xml);
});

test('notes: a file with Windows line endings keeps them', () => {
  const xml = '<PathOfBuilding>\r\n\t<Build level="1" />\r\n\t<Notes>\r\n\t\tfirst\r\nsecond\r\n\t</Notes>\r\n</PathOfBuilding>';
  assert.equal(getNotes(xml), 'first\nsecond');
  assert.equal(setNotes(xml, 'first\nsecond'), xml, 'writing the same notes back changes nothing');
  assert.equal(setNotes(xml, 'a\nb'), '<PathOfBuilding>\r\n\t<Build level="1" />\r\n\t<Notes>\r\n\t\ta\r\nb\r\n\t</Notes>\r\n</PathOfBuilding>');
});

test('notes: a build with no Notes element gets one', () => {
  const xml = '<PathOfBuilding>\n\t<Build level="1" />\n\t<TreeView a="1" />\n</PathOfBuilding>';
  const out = setNotes(xml, 'hi');
  assert.equal(getNotes(out), 'hi');
  assert.ok(out.indexOf('<Notes>') < out.indexOf('<TreeView'));
  assert.equal(readBuildInfo(out).valid, true);
});

test('notes: colour codes go in and out of the text unchanged', () => {
  const text = '^xFFFF77Rare line^7 plain ^3magic digit^xD02090 chaos\nnext line';
  assert.deepEqual(parseNotes(text).map((s) => [s.text, s.code]), [['Rare line', '^xFFFF77'], [' plain ', null], ['magic digit', '^3'], [' chaos\nnext line', '^xD02090']]);
  assert.equal(serializeNotes(parseNotes(text)), text);
  assert.equal(serializeNotes(parseNotes('no codes here')), 'no codes here');
  assert.equal(codeColour('^xFFFF77'), 'var(--rarity-rare)');
  assert.equal(codeColour('^x123456'), '#123456');
  assert.equal(codeColour('^7'), null);
  assert.equal(codeColour(null), null);
});

// ---- Settings ------------------------------------------------------------------------------

test('settings: unknown keys and wrong types are dropped, numbers are clamped', () => {
  const s = sanitizeSettings({ theme: 'nope', defaultLevel: 500, defaultGemQuality: -4, density: 'compact', evil: 1, buildNameInTitle: 'yes' });
  assert.equal(s.theme, 'obsidian');
  assert.equal(s.defaultLevel, 100);
  assert.equal(s.defaultGemQuality, 0);
  assert.equal(s.density, 'compact');
  assert.equal(s.buildNameInTitle, true, 'a string is not a boolean, so the default stays');
  assert.equal('evil' in s, false);
  assert.deepEqual(sanitizeSettings(null), DEFAULT_SETTINGS);
});

test('settings are saved to disk and read back', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pom-settings-'));
  try {
    const path = join(dir, 'settings.json');
    await new SettingsStore(path).set({ theme: 'umber', defaultLevel: 90 });
    const again = await new SettingsStore(path).get();
    assert.equal(again.theme, 'umber');
    assert.equal(again.defaultLevel, 90);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).theme, 'umber');
    await writeFile(path, '{ broken', 'utf8');
    assert.deepEqual(await new SettingsStore(path).get(), DEFAULT_SETTINGS);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the stat list shows full numbers by default, like the original (useCompactValues is off)", () => {
  assert.equal(DEFAULT_SETTINGS.compactNumbers, false);
});

test('settings: a failed write throws and does not leave the unsaved value in the cache', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pom-settings-'));
  try {
    const path = join(dir, 'settings.json');
    await mkdir(path); // the file's place is a folder, so the write fails
    const store = new SettingsStore(path);
    await assert.rejects(store.set({ defaultLevel: 40 }));
    assert.notEqual((await store.get()).defaultLevel, 40);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('list: an unreadable builds folder throws instead of showing an empty library', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pom-list-'));
  try {
    const store = new BuildStore(join(dir, 'Builds'), join(dir, 'trash'));
    await store.init();
    await rm(join(dir, 'Builds'), { recursive: true, force: true });
    await writeFile(join(dir, 'Builds'), 'a file, not a folder', 'utf8');
    await assert.rejects(store.list(), /cannot be read/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
