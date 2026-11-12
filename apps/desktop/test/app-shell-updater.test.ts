import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { AppShellUpdater, type AppUpdateStore, type PendingAppUpdate } from '../src/main/updater/appShellUpdater.js';
import { fetchDownloader } from '../src/main/updater/downloader.js';
import { generateTestKeypair, signLayer } from './testHelpers.js';

class MemoryAppUpdateStore implements AppUpdateStore {
  pending: PendingAppUpdate | null = null;
  async getPending() {
    return this.pending;
  }
  async setPending(update: PendingAppUpdate | null) {
    this.pending = update;
  }
}

async function setup() {
  const stagingDir = await mkdtemp(join(tmpdir(), 'pom-appshell-'));
  const { publicKey, privateKey } = generateTestKeypair();
  const installerContent = Buffer.from('fake installer bytes');
  const installerSourcePath = join(stagingDir, 'source-installer.exe');
  await writeFile(installerSourcePath, installerContent);
  const sha256 = createHash('sha256').update(installerContent).digest('hex');

  const store = new MemoryAppUpdateStore();
  const spawnedInstallers: string[] = [];
  const updater = new AppShellUpdater(
    {
      downloader: fetchDownloader,
      publicKey,
      stagingDir,
      store,
      spawnInstaller: async (installerPath) => {
        spawnedInstallers.push(installerPath);
      },
    },
    'v1',
  );

  return {
    updater,
    store,
    publicKey,
    stagingDir,
    spawnedInstallers,
    async signedLayer(version = 'v2', overrides: Partial<{ sha256: string }> = {}) {
      const fields = {
        version,
        sha256: overrides.sha256 ?? sha256,
        size: installerContent.length,
        url: `file://${installerSourcePath}`,
      };
      return signLayer('app', fields, privateKey);
    },
    async cleanup() {
      await rm(stagingDir, { recursive: true, force: true });
    },
  };
}

test('app shell updater: reports up to date when the manifest version matches the running app', async () => {
  const h = await setup();
  try {
    const outcome = await h.updater.checkAndDownload(await h.signedLayer('v1'));
    assert.deepEqual(outcome, { type: 'upToDate' });
    assert.equal(h.store.pending, null);
  } finally {
    await h.cleanup();
  }
});

test('app shell updater: downloads and marks a new version pending, without installing or restarting', async () => {
  const h = await setup();
  try {
    const outcome = await h.updater.checkAndDownload(await h.signedLayer('v2'));
    assert.deepEqual(outcome, { type: 'downloaded', version: 'v2' });
    assert.ok(h.store.pending);
    assert.equal(h.store.pending?.version, 'v2');
    assert.deepEqual(h.spawnedInstallers, [], 'must not install immediately');
  } finally {
    await h.cleanup();
  }
});

test('app shell updater: installPendingIfAny runs the installer and clears the pending marker on next launch', async () => {
  const h = await setup();
  try {
    await h.updater.checkAndDownload(await h.signedLayer('v2'));
    const result = await h.updater.installPendingIfAny();
    assert.equal(result, 'installed');
    assert.equal(h.spawnedInstallers.length, 1);
    assert.equal(h.store.pending, null, 'pending marker must be cleared once handed to the installer');
  } finally {
    await h.cleanup();
  }
});

test('app shell updater: installPendingIfAny is a no-op when nothing is pending', async () => {
  const h = await setup();
  try {
    const result = await h.updater.installPendingIfAny();
    assert.equal(result, 'none');
    assert.deepEqual(h.spawnedInstallers, []);
  } finally {
    await h.cleanup();
  }
});

test('app shell updater: a tampered installer is rejected and nothing is marked pending', async () => {
  const h = await setup();
  try {
    const outcome = await h.updater.checkAndDownload(await h.signedLayer('v2', { sha256: 'f'.repeat(64) }));
    assert.equal(outcome.type, 'updateFailed');
    if (outcome.type === 'updateFailed') {
      assert.equal(outcome.stillOnVersion, 'v1');
      assert.match(outcome.message, /sha256 mismatch/);
    }
    assert.equal(h.store.pending, null);
  } finally {
    await h.cleanup();
  }
});

test('app shell updater: a verified download is reused by the next check instead of downloading it again', async () => {
  const h = await setup();
  try {
    const layer = await h.signedLayer('v2');
    let downloads = 0;
    const counting = new AppShellUpdater(
      { downloader: { download: async (u, d, o) => { downloads++; await fetchDownloader.download(u, d, o); } }, publicKey: h.publicKey, stagingDir: h.stagingDir, store: h.store, spawnInstaller: async () => {} },
      'v1',
    );
    assert.deepEqual(await counting.checkAndDownload(layer), { type: 'downloaded', version: 'v2' });
    assert.deepEqual(await counting.checkAndDownload(layer), { type: 'downloaded', version: 'v2', reused: true });
    assert.equal(downloads, 1, 'the second check reused the verified file');
    // The file on disk was changed: it no longer verifies, so it is fetched again.
    await writeFile(h.store.pending!.installerPath, 'tampered');
    assert.deepEqual(await counting.checkAndDownload(layer), { type: 'downloaded', version: 'v2' });
    assert.equal(downloads, 2);
  } finally {
    await h.cleanup();
  }
});

test('app shell updater: launchOnQuit starts the pending installer with or without a relaunch, never for the running version', async () => {
  const h = await setup();
  try {
    assert.equal(h.updater.launchOnQuit(true), false, 'nothing pending');
    await h.updater.checkAndDownload(await h.signedLayer('v2'));
    const launches: unknown[] = [];
    const u = new AppShellUpdater({ downloader: fetchDownloader, publicKey: h.publicKey, stagingDir: h.stagingDir, store: h.store, spawnInstaller: (p, l) => void launches.push([p, l]) }, 'v1');
    await u.getPending();
    assert.equal(u.launchOnQuit(true), true);
    assert.deepEqual(launches, [[h.store.pending!.installerPath, { version: 'v2', relaunch: true }]]);
    assert.equal(u.launchOnQuit(false), true);
    assert.deepEqual(launches[1], [h.store.pending!.installerPath, { version: 'v2', relaunch: false }]);
    const already = new AppShellUpdater({ downloader: fetchDownloader, publicKey: h.publicKey, stagingDir: h.stagingDir, store: h.store, spawnInstaller: () => void (launches as unknown[]).push('x') }, 'v2');
    await already.getPending();
    assert.equal(already.launchOnQuit(true), false, 'the pending version is the one running');
    await u.discardPending();
    assert.equal(h.store.pending, null);
  } finally {
    await h.cleanup();
  }
});
