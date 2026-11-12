import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultGameFolder, listFilterFiles, readFilterFile, writeFilterFile } from '../src/main/lootfilter/fileWriter.js';
import { generateFilter } from '../src/shared/lootfilter/generate.js';
import { NEVERSINK_DIR } from './lootfilterHelpers.js';

const base = readFileSync(join(NEVERSINK_DIR, '2-SEMI-STRICT.filter'), 'utf8');
const NAME = 'Path of Mastery.filter';
const gen = () => generateFilter({ baseText: base, baseVersion: '8.20.1d', strictness: 2, style: 0, rules: [], now: new Date('2026-09-30T12:00:00Z') });

function box() {
  const root = mkdtempSync(join(tmpdir(), 'pom-lf-folder-'));
  const game = join(root, 'OneDrive', 'Documents', 'My Games', 'Path of Exile');
  mkdirSync(game, { recursive: true });
  return { root, game, backups: { dir: join(root, 'backups'), keep: 3 } };
}

test('the folder is My Games/Path of Exile under the documents path it is given, OneDrive included', () => {
  assert.equal(defaultGameFolder(join('C:', 'Users', 'a', 'OneDrive', 'Documents')), join('C:', 'Users', 'a', 'OneDrive', 'Documents', 'My Games', 'Path of Exile'));
});

test('saving writes the file, saving again overwrites only our own file, and a different file is never touched', async () => {
  const b = box();
  try {
    const g = gen();
    const first = await writeFilterFile({ folder: b.game, fileName: NAME, fileText: g.fileText }, b.backups);
    assert.equal(first.kind, 'written');
    const again = await writeFilterFile({ folder: b.game, fileName: NAME, fileText: g.fileText, lastHash: first.kind === 'written' ? first.hash : undefined }, b.backups);
    assert.equal(again.kind, 'written');
    writeFileSync(join(b.game, 'Mine.filter'), 'Show\n');
    const foreign = await writeFilterFile({ folder: b.game, fileName: 'Mine.filter', fileText: g.fileText }, b.backups);
    assert.equal(foreign.kind, 'needs-confirm');
    assert.equal(readFileSync(join(b.game, 'Mine.filter'), 'utf8'), 'Show\n');
  } finally {
    rmSync(b.root, { recursive: true, force: true });
  }
});

test('the folder import lists .filter files, marks ours, and reads only plain file names', async () => {
  const b = box();
  try {
    await writeFilterFile({ folder: b.game, fileName: NAME, fileText: gen().fileText }, b.backups);
    writeFileSync(join(b.game, 'Mine.filter'), 'Show\n');
    writeFileSync(join(b.game, 'notes.txt'), 'x');
    const l = await listFilterFiles(b.game);
    assert.ok(l.ok);
    assert.deepEqual(l.ok && l.files.map((f) => `${f.name}:${f.ours}`).sort(), ['Mine.filter:false', `${NAME}:true`]);
    const r = await readFilterFile(b.game, 'Mine.filter');
    assert.deepEqual(r, { ok: true, name: 'Mine.filter', text: 'Show\n' });
    assert.equal((await readFilterFile(b.game, '..\secret.filter')).ok, false);
    assert.equal((await readFilterFile(b.game, 'notes.txt')).ok, false);
    assert.equal((await listFilterFiles(join(b.root, 'nope'))).ok, false);
  } finally {
    rmSync(b.root, { recursive: true, force: true });
  }
});

test('no code under src talks to the item filter endpoint', () => {
  const hits: string[] = [];
  const walk = (dir: string): void => {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(n) && /api\/item-filter|itemFilters?\(|saveItemFilter/.test(readFileSync(p, 'utf8'))) hits.push(p);
    }
  };
  walk(join(import.meta.dirname, '..', '..', 'src'));
  assert.deepEqual(hits, []);
});
