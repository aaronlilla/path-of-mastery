import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseManifest, ManifestParseError } from '../src/main/updater/manifestClient.js';
import { posixInstallScript, posixInstallTarget } from '../src/main/updater/installerLaunch.js';
import { posixClientLogCandidates, posixGameFolder } from '../src/main/gamePaths.js';

const slash = (p: string) => p.replace(/\\/g, '/');
const layer = (url: string) => ({ version: '1.0.0', sha256: 'a'.repeat(64), size: 1, url, signature: 'c2ln' });
const manifest = {
  channel: 'stable',
  generatedAt: 'x',
  layers: { engine: layer('win-engine'), interface: layer('ui'), app: layer('win-app') },
  platforms: { 'linux-x64': { engine: layer('linux-engine'), app: layer('linux-app') } },
};

test('a Mac or Linux client takes its own engine and app, and the shared interface', () => {
  const m = parseManifest(manifest, 'linux-x64');
  assert.deepEqual([m.layers.engine.url, m.layers.app.url, m.layers.interface.url], ['linux-engine', 'linux-app', 'ui']);
  assert.equal(parseManifest(manifest, 'win32-x64').layers.app.url, 'win-app');
  assert.throws(() => parseManifest(manifest, 'darwin-arm64'), ManifestParseError);
});

test('Mac and Linux game file locations', () => {
  assert.ok(posixClientLogCandidates('darwin', '/Users/a').map(slash).includes('/Users/a/Library/Caches/com.GGG.PathOfExile/Logs/Client.txt'));
  assert.ok(posixClientLogCandidates('linux', '/home/a').map(slash).includes('/home/a/.steam/steam/steamapps/common/Path of Exile/logs/Client.txt'));
  assert.equal(slash(posixGameFolder('darwin', '/Users/a', () => false)), '/Users/a/Library/Application Support/Path of Exile/Preferences');
  assert.equal(posixInstallTarget('darwin', '/Applications/Path of Mastery.app/Contents/MacOS/Path of Mastery'), '/Applications/Path of Mastery.app');
});

test('the Linux install helper replaces the AppImage, records the result and relaunches', { skip: spawnSync('sh', ['-c', 'true']).error !== undefined }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'pom-ml-'));
  const target = join(dir, 'Path of Mastery.AppImage');
  const installer = join(dir, 'app-2.0.0.AppImage');
  writeFileSync(target, '#!/bin/sh\necho old > "$(dirname "$0")/ran-old"\n');
  writeFileSync(installer, '#!/bin/sh\necho new > "$(dirname "$0")/ran-new"\n');
  const plan = { waitPid: 999999, installerPath: installer, relaunch: { exe: target, args: ['--x'] }, resultPath: join(dir, 'install-result.json'), version: "2.0.0" };
  const r = spawnSync('sh', ['-c', posixInstallScript(plan, 'linux', target)]);
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(readFileSync(plan.resultPath, 'utf8')).code, 0);
  assert.equal(readFileSync(target, 'utf8'), readFileSync(installer, 'utf8'));
  for (let i = 0; i < 20 && !existsSync(join(dir, 'ran-new')); i++) spawnSync('sleep', ['0.2']);
  assert.ok(existsSync(join(dir, 'ran-new')), 'the new build was started');
});
