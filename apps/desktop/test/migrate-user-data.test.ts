// The old pob-v2 data folder is copied into the new one once, never changed, never overwritten. Temp dirs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateOldUserData } from '../src/main/migrateUserData.js';

const put = (root: string, rel: string, text: string) => {
  const p = join(root, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, text);
};
const setup = () => {
  const root = mkdtempSync(join(tmpdir(), 'pom-migrate-'));
  const oldDir = join(root, 'old');
  const newDir = join(root, 'new');
  put(oldDir, 'Builds/a.xml', 'A');
  put(oldDir, 'Builds/b.xml', 'B');
  put(oldDir, 'Recently deleted/c.xml', 'C');
  put(oldDir, 'settings.json', '{"x":1}');
  put(oldDir, 'builds-path.txt', 'D:\\mine');
  put(oldDir, 'Cache/junk', 'junk');
  put(oldDir, 'GPUCache/junk', 'junk');
  return { oldDir, newDir };
};
const snap = (d: string) => readdirSync(d, { recursive: true }).map(String).sort().join('|');

test('copies the player files once, skips caches, leaves the old folder alone', () => {
  const { oldDir, newDir } = setup();
  const before = snap(oldDir);
  assert.ok(migrateOldUserData(oldDir, newDir) > 0);
  assert.equal(readFileSync(join(newDir, 'Builds/b.xml'), 'utf8'), 'B');
  assert.equal(readFileSync(join(newDir, 'Recently deleted/c.xml'), 'utf8'), 'C');
  assert.equal(readFileSync(join(newDir, 'settings.json'), 'utf8'), '{"x":1}');
  assert.equal(readFileSync(join(newDir, 'builds-path.txt'), 'utf8'), 'D:\\mine');
  assert.ok(!existsSync(join(newDir, 'Cache')) && !existsSync(join(newDir, 'GPUCache')));
  assert.equal(snap(oldDir), before);
  // second run: the marker stops it, even after the player deletes a copied build
  writeFileSync(join(oldDir, 'Builds/new-in-old.xml'), 'N');
  assert.equal(migrateOldUserData(oldDir, newDir), 0);
  assert.ok(!existsSync(join(newDir, 'Builds/new-in-old.xml')));
});

test('a new folder that already holds a build gets nothing copied', () => {
  const { oldDir, newDir } = setup();
  put(newDir, 'Builds/mine.xml', 'M');
  assert.equal(migrateOldUserData(oldDir, newDir), 0);
  assert.equal(readdirSync(join(newDir, 'Builds')).join(), 'mine.xml');
  assert.ok(!existsSync(join(newDir, 'settings.json')));
});

test('never overwrites a file the new folder already has; missing old folder is a no-op', () => {
  const { oldDir, newDir } = setup();
  put(newDir, 'settings.json', 'NEW');
  migrateOldUserData(oldDir, newDir);
  assert.equal(readFileSync(join(newDir, 'settings.json'), 'utf8'), 'NEW');
  assert.equal(migrateOldUserData(join(oldDir, 'nope'), join(newDir, 'x')), 0);
});

test('copies sharedItems.json (the list the accounts/ sync record points at)', () => {
  const { oldDir, newDir } = setup();
  put(oldDir, 'sharedItems.json', '[1]');
  put(oldDir, 'accounts/sharedItems.sync.json', 'S');
  migrateOldUserData(oldDir, newDir);
  assert.equal(readFileSync(join(newDir, 'sharedItems.json'), 'utf8'), '[1]');
  assert.equal(readFileSync(join(newDir, 'accounts/sharedItems.sync.json'), 'utf8'), 'S');
});

test('a failed item is retried on the next start even though Builds is now filled', () => {
  const { oldDir, newDir } = setup();
  mkdirSync(join(newDir, 'settings.json'), { recursive: true }); // makes the settings.json copy throw
  migrateOldUserData(oldDir, newDir);
  assert.ok(!existsSync(join(newDir, 'migrated-from-old-folder.txt')));
  rmSync(join(newDir, 'settings.json'), { recursive: true });
  assert.ok(migrateOldUserData(oldDir, newDir) > 0);
  assert.equal(readFileSync(join(newDir, 'settings.json'), 'utf8'), '{"x":1}');
  assert.ok(existsSync(join(newDir, 'migrated-from-old-folder.txt')));
});

const putSecrets = (oldDir: string) => {
  put(oldDir, 'Local State', 'OLDKEY');
  put(oldDir, 'accounts/session.bin', 'S');
  put(oldDir, 'accounts/pending.bin', 'P');
  put(oldDir, 'accounts/sharedItems.sync.json', 'SYNC');
  put(oldDir, 'wealth/session.bin', 'W');
  put(oldDir, 'wealth/other.json', 'O');
  put(oldDir, 'mastery/identity/installation.txt', 'ID');
  put(oldDir, 'mastery/identity/app-key.bin', 'K');
  put(oldDir, 'mastery/other.json', 'M');
};

test('no Local State in the new folder: it is copied with the encrypted files', () => {
  const { oldDir, newDir } = setup();
  putSecrets(oldDir);
  migrateOldUserData(oldDir, newDir);
  assert.equal(readFileSync(join(newDir, 'Local State'), 'utf8'), 'OLDKEY');
  assert.equal(readFileSync(join(newDir, 'accounts/session.bin'), 'utf8'), 'S');
  assert.equal(readFileSync(join(newDir, 'wealth/session.bin'), 'utf8'), 'W');
  assert.equal(readFileSync(join(newDir, 'mastery/identity/app-key.bin'), 'utf8'), 'K');
});

test('new folder already has its own Local State: encrypted files stay behind, the rest is copied', () => {
  const { oldDir, newDir } = setup();
  putSecrets(oldDir);
  put(newDir, 'Local State', 'NEWKEY');
  migrateOldUserData(oldDir, newDir);
  assert.equal(readFileSync(join(newDir, 'Local State'), 'utf8'), 'NEWKEY');
  for (const gone of ['accounts/session.bin', 'accounts/pending.bin', 'wealth/session.bin', 'mastery/identity']) {
    assert.ok(!existsSync(join(newDir, gone)), gone);
  }
  assert.equal(readFileSync(join(newDir, 'accounts/sharedItems.sync.json'), 'utf8'), 'SYNC');
  assert.equal(readFileSync(join(newDir, 'wealth/other.json'), 'utf8'), 'O');
  assert.equal(readFileSync(join(newDir, 'mastery/other.json'), 'utf8'), 'M');
  assert.equal(readFileSync(join(newDir, 'Builds/b.xml'), 'utf8'), 'B');
});

test('a retry after a half-done copy still brings the encrypted files (the copied Local State is ours)', () => {
  const { oldDir, newDir } = setup();
  putSecrets(oldDir);
  put(newDir, 'Local State', 'OLDKEY');
  put(newDir, 'migration-started.txt', '');
  migrateOldUserData(oldDir, newDir);
  assert.equal(readFileSync(join(newDir, 'accounts/session.bin'), 'utf8'), 'S');
});

test('a half-copied folder gets its missing files filled in, existing ones kept', () => {
  const { oldDir, newDir } = setup();
  put(newDir, 'Builds/a.xml', 'KEPT');
  put(newDir, 'migration-started.txt', '');
  migrateOldUserData(oldDir, newDir);
  assert.equal(readFileSync(join(newDir, 'Builds/a.xml'), 'utf8'), 'KEPT');
  assert.equal(readFileSync(join(newDir, 'Builds/b.xml'), 'utf8'), 'B');
});
