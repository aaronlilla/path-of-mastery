import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { InterfaceSwapController, type RendererController } from '../src/main/updater/interfaceSwap.js';
import { fetchDownloader } from '../src/main/updater/downloader.js';
import { generateTestKeypair, signLayer } from './testHelpers.js';

interface FakeRenderer extends RendererController {
  calls: string[];
  currentBundle: string;
  currentState: unknown;
  verifyReadyResult: boolean;
  failLoadFor?: string;
}

function makeFakeRenderer(initialBundle: string): FakeRenderer {
  const renderer: FakeRenderer = {
    calls: [],
    currentBundle: initialBundle,
    currentState: { scrollTop: 0 },
    verifyReadyResult: true,
    async captureState() {
      renderer.calls.push('captureState');
      return renderer.currentState;
    },
    async loadBundle(indexHtmlPath) {
      renderer.calls.push(`loadBundle:${indexHtmlPath}`);
      if (renderer.failLoadFor && indexHtmlPath.includes(renderer.failLoadFor)) {
        throw new Error(`fake load failure for ${indexHtmlPath}`);
      }
      renderer.currentBundle = indexHtmlPath;
    },
    async verifyReady() {
      renderer.calls.push('verifyReady');
      return renderer.verifyReadyResult;
    },
    async restoreState(state) {
      renderer.calls.push('restoreState');
      renderer.currentState = state;
    },
  };
  return renderer;
}

async function setup() {
  const stagingDir = await mkdtemp(join(tmpdir(), 'pom-ifaceswap-'));
  const { publicKey, privateKey } = generateTestKeypair();
  const archiveContent = Buffer.from('fake interface bundle archive');
  const archiveSourcePath = join(stagingDir, 'source-archive.bin');
  await writeFile(archiveSourcePath, archiveContent);
  const sha256 = createHash('sha256').update(archiveContent).digest('hex');

  const extractedIndexPaths: string[] = [];
  const deps = {
    downloader: fetchDownloader,
    publicKey,
    stagingDir,
    async extractBundle(_archivePath: string, destDir: string) {
      const indexPath = join(destDir, 'index.html');
      extractedIndexPaths.push(indexPath);
      return indexPath;
    },
  };

  const renderer = makeFakeRenderer('/app/bundles/v1/index.html');
  const controller = new InterfaceSwapController(deps, renderer, 'v1', '/app/bundles/v1/index.html');

  return {
    controller,
    renderer,
    privateKey,
    stagingDir,
    extractedIndexPaths,
    async signedLayer(version = 'v2', overrides: Partial<{ sha256: string; size: number }> = {}) {
      const fields = {
        version,
        sha256: overrides.sha256 ?? sha256,
        size: overrides.size ?? archiveContent.length,
        url: `file://${archiveSourcePath}`,
      };
      return signLayer('interface', fields, privateKey);
    },
    async cleanup() {
      await rm(stagingDir, { recursive: true, force: true });
    },
  };
}

test('interface swap: happy path captures state, swaps the bundle, and restores state', async () => {
  const h = await setup();
  try {
    const layer = await h.signedLayer();
    const outcome = await h.controller.applyUpdate(layer);
    assert.deepEqual(outcome, { type: 'switched', version: 'v2' });
    assert.equal(h.controller.getCurrentVersion(), 'v2');
    assert.deepEqual(h.renderer.calls, ['captureState', `loadBundle:${h.extractedIndexPaths[0]}`, 'verifyReady', 'restoreState']);
    assert.deepEqual(h.renderer.currentState, { scrollTop: 0 }, 'the captured state must be exactly what gets restored');
  } finally {
    await h.cleanup();
  }
});

test('interface swap: a bundle that fails to report ready rolls back to the previous bundle and restores state', async () => {
  const h = await setup();
  try {
    h.renderer.verifyReadyResult = false;
    const layer = await h.signedLayer();
    const outcome = await h.controller.applyUpdate(layer);

    assert.equal(outcome.type, 'updateFailed');
    if (outcome.type === 'updateFailed') {
      assert.equal(outcome.stillOnVersion, 'v1');
      assert.match(outcome.message, /did not report ready/);
    }
    assert.equal(h.controller.getCurrentVersion(), 'v1');
    assert.deepEqual(h.renderer.calls, [
      'captureState',
      `loadBundle:${h.extractedIndexPaths[0]}`,
      'verifyReady',
      'loadBundle:/app/bundles/v1/index.html',
      'restoreState',
    ]);
    assert.equal(h.renderer.currentBundle, '/app/bundles/v1/index.html', 'must end up back on the original bundle');
    assert.deepEqual(h.renderer.currentState, { scrollTop: 0 }, 'state must still be restored even after a rollback');
  } finally {
    await h.cleanup();
  }
});

test('interface swap: a bundle whose loadBundle throws also rolls back and restores state', async () => {
  const h = await setup();
  try {
    h.renderer.failLoadFor = 'index.html';
    // Only fail the *new* bundle load, not the rollback load of the old one.
    const originalLoad = h.renderer.loadBundle.bind(h.renderer);
    h.renderer.loadBundle = async (path: string) => {
      if (path === '/app/bundles/v1/index.html') {
        h.renderer.calls.push(`loadBundle:${path}`);
        h.renderer.currentBundle = path;
        return;
      }
      await originalLoad(path);
    };

    const layer = await h.signedLayer();
    const outcome = await h.controller.applyUpdate(layer);

    assert.equal(outcome.type, 'updateFailed');
    if (outcome.type === 'updateFailed') {
      assert.equal(outcome.stillOnVersion, 'v1');
      assert.match(outcome.message, /fake load failure/);
    }
    assert.equal(h.renderer.currentBundle, '/app/bundles/v1/index.html');
    assert.deepEqual(h.renderer.currentState, { scrollTop: 0 });
  } finally {
    await h.cleanup();
  }
});

test('interface swap: a tampered archive is rejected before the renderer is ever touched', async () => {
  const h = await setup();
  try {
    const layer = await h.signedLayer('v2', { sha256: 'f'.repeat(64) });
    const outcome = await h.controller.applyUpdate(layer);

    assert.equal(outcome.type, 'updateFailed');
    if (outcome.type === 'updateFailed') {
      assert.equal(outcome.stillOnVersion, 'v1');
      assert.match(outcome.message, /sha256 mismatch/);
    }
    assert.deepEqual(h.renderer.calls, [], 'renderer must not be touched when verification fails');
    assert.equal(h.controller.getCurrentVersion(), 'v1');
  } finally {
    await h.cleanup();
  }
});
