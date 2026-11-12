import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clearStagedEngine, readStagedEngine, writeStagedEngine } from '../src/main/updater/stagedEngine.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import type { OpenBuildState, UpdateLayer } from '@pom/protocol';
import { EngineHotSwapController } from '../src/main/updater/engineHotSwap.js';
import { fetchDownloader } from '../src/main/updater/downloader.js';
import { nodeChildProcessFactory } from '../src/main/nodeProcessAdapter.js';
import type { ProcessFactory, ProcessHandle } from '../src/shared/processHandle.js';
import { generateTestKeypair, signLayer } from './testHelpers.js';

const FIXTURE_PATH = fileURLToPath(new URL('./fixtures/fakeEngineHost.js', import.meta.url));

const BUILD_STATE: OpenBuildState = { buildId: 'b1', buildXml: '<Build/>', undoStack: [], redoStack: [] };

/** Wraps a ProcessHandle to record how many times kill() was called, without changing its behavior. */
function spyOnKill(handle: ProcessHandle): ProcessHandle & { killCount: number } {
  let killCount = 0;
  return {
    ...handle,
    get killCount() {
      return killCount;
    },
    kill: () => {
      killCount += 1;
      handle.kill();
    },
  };
}

interface Harness {
  controller: EngineHotSwapController;
  initialProcess: ReturnType<typeof spyOnKill>;
  createdProcesses: ReturnType<typeof spyOnKill>[];
  privateKey: ReturnType<typeof generateTestKeypair>['privateKey'];
  signedLayer(version?: string): Promise<UpdateLayer>;
  stagingDir: string;
  staged: Array<{ version: string; packPath: string }>;
  cleanup(): Promise<void>;
}

/**
 * Every process this harness creates (the initial one and any spawned by an
 * update) runs the fake engine fixture in the given FAKE_ENGINE_MODE, so one
 * harness setup exercises exactly one scenario end to end.
 */
async function setup(mode: 'ok' | 'fail-load' | 'fail-recalc' | 'silent' | 'crash' | 'slow'): Promise<Harness> {
  const stagingDir = await mkdtemp(join(tmpdir(), 'pom-hotswap-'));
  const { publicKey, privateKey } = generateTestKeypair();
  const createdProcesses: ReturnType<typeof spyOnKill>[] = [];
  const staged: Array<{ version: string; packPath: string }> = [];

  // Every process forks the same fixture entry point, mirroring how a real
  // hot-swap always forks the fixed engine-host bootstrap script; only the
  // env var pointing at the "native module" (here: an inert data file, see
  // packPath below) changes between the old and new engine.
  const trackedFactory: ProcessFactory = (opts) => {
    const proc = spyOnKill(nodeChildProcessFactory({ ...opts, env: { ...opts.env, FAKE_ENGINE_MODE: mode } }));
    createdProcesses.push(proc);
    return proc;
  };

  const initialProcess = trackedFactory({ modulePath: FIXTURE_PATH, env: {} }) as ReturnType<typeof spyOnKill>;

  const controller = new EngineHotSwapController(
    {
      downloader: fetchDownloader,
      publicKey,
      processFactory: trackedFactory,
      stagingDir,
      engineHostEntryPath: FIXTURE_PATH,
      verifyTimeoutMs: 2500,
      onStaged: async (st) => {
        staged.push(st);
        await writeStagedEngine(stagingDir, st);
      },
    },
    initialProcess,
    'v1',
  );

  // The "engine+data pack" itself is inert bytes in this test - the fixture
  // ignores it and takes its behavior from FAKE_ENGINE_MODE - so any content
  // works as long as its declared hash matches what's actually downloaded.
  const packSourcePath = join(stagingDir, 'source-pack.bin');
  const packContent = Buffer.from(`fake engine pack (${mode})`);
  await writeFile(packSourcePath, packContent);
  const sha256 = createHash('sha256').update(packContent).digest('hex');

  return {
    controller,
    stagingDir,
    staged,
    initialProcess,
    createdProcesses,
    privateKey,
    async signedLayer(version = 'v2') {
      const fields = { version, sha256, size: packContent.length, url: `file://${packSourcePath}` };
      return signLayer('engine', fields, privateKey);
    },
    async cleanup() {
      for (const proc of createdProcesses) proc.kill();
      await rm(stagingDir, { recursive: true, force: true });
    },
  };
}

test('engine hot-swap: a verified engine is staged for the next start; the running engine is not touched', async () => {
  const h = await setup('ok');
  try {
    const layer = await h.signedLayer();
    const outcome = await h.controller.applyUpdate(layer, BUILD_STATE);
    assert.deepEqual(outcome, { type: 'staged', version: 'v2' });
    assert.equal(h.controller.getCurrentVersion(), 'v1', 'the running engine keeps its version until the next start');
    assert.equal(h.controller.getStagedVersion(), 'v2');
    assert.equal(h.initialProcess.killCount, 0, 'open builds stay on the running engine');
    assert.equal(h.staged.length, 1);
    assert.equal(h.staged[0]?.version, 'v2');
    const read = await readStagedEngine(h.stagingDir);
    assert.equal(read?.version, 'v2', 'the next start finds the staged pack');
    await clearStagedEngine(h.stagingDir);
    assert.equal(await readStagedEngine(h.stagingDir), null);
  } finally {
    await h.cleanup();
  }
});

test('engine hot-swap: an empty open build does not fail verification; a ready engine is enough', async () => {
  const h = await setup('fail-load');
  try {
    const layer = await h.signedLayer();
    const outcome = await h.controller.applyUpdate(layer, { ...BUILD_STATE, buildXml: '' });
    assert.deepEqual(outcome, { type: 'staged', version: 'v2' });
  } finally {
    await h.cleanup();
  }
});

test('engine hot-swap: a cold start slower than the handoff deadline still gets the open build (the deadline starts at the ready announcement)', async () => {
  const h = await setup('slow');
  try {
    const layer = await h.signedLayer();
    const outcome = await h.controller.applyUpdate(layer, BUILD_STATE);
    assert.deepEqual(outcome, { type: 'staged', version: 'v2' });
  } finally {
    await h.cleanup();
  }
});

test('engine hot-swap: new engine rejecting the build handoff rolls back', async () => {
  const h = await setup('fail-load');
  try {
    const layer = await h.signedLayer();
    const outcome = await h.controller.applyUpdate(layer, BUILD_STATE);
    assert.equal(outcome.type, 'updateFailed');
    if (outcome.type === 'updateFailed') {
      assert.equal(outcome.stillOnVersion, 'v1');
      assert.match(outcome.message, /rejected build state/);
    }
    assert.equal(h.controller.getCurrentVersion(), 'v1', 'must stay on the old engine after a failed handoff');
    assert.equal(h.initialProcess.killCount, 0, 'old engine must not be killed on failure');
  } finally {
    await h.cleanup();
  }
});

test('engine hot-swap: new engine failing to recalculate rolls back and kills the new process', async () => {
  const h = await setup('fail-recalc');
  try {
    const layer = await h.signedLayer();
    const outcome = await h.controller.applyUpdate(layer, BUILD_STATE);
    assert.equal(outcome.type, 'updateFailed');
    if (outcome.type === 'updateFailed') {
      assert.equal(outcome.stillOnVersion, 'v1');
      assert.match(outcome.message, /failed to recalculate/);
    }
    assert.equal(h.controller.getCurrentVersion(), 'v1');
    assert.equal(h.initialProcess.killCount, 0);
    const newProcess = h.createdProcesses[1];
    assert.ok(newProcess);
    assert.equal(newProcess.killCount, 1, 'the failed new engine process should be torn down');
  } finally {
    await h.cleanup();
  }
});

test('engine hot-swap: a crashing new engine process is treated as a failure, not a hang', async () => {
  const h = await setup('crash');
  try {
    const layer = await h.signedLayer();
    const outcome = await h.controller.applyUpdate(layer, BUILD_STATE);
    assert.equal(outcome.type, 'updateFailed');
    if (outcome.type === 'updateFailed') {
      assert.equal(outcome.stillOnVersion, 'v1');
      assert.match(outcome.message, /exited/);
    }
    assert.equal(h.controller.getCurrentVersion(), 'v1');
  } finally {
    await h.cleanup();
  }
});

test('engine hot-swap: a silent new engine times out rather than hanging forever', async () => {
  const h = await setup('silent');
  try {
    const layer = await h.signedLayer();
    const outcome = await h.controller.applyUpdate(layer, BUILD_STATE);
    assert.equal(outcome.type, 'updateFailed');
    if (outcome.type === 'updateFailed') {
      assert.equal(outcome.stillOnVersion, 'v1');
      assert.match(outcome.message, /timed out/);
    }
  } finally {
    await h.cleanup();
  }
});

test('engine hot-swap: a tampered pack (bytes not matching the signed hash) is rejected before any process is spawned', async () => {
  const h = await setup('ok');
  try {
    const fields = {
      version: 'v2',
      sha256: 'f'.repeat(64), // deliberately wrong hash for the real fixture bytes
      size: 1,
      url: `file://${FIXTURE_PATH}`,
    };
    const layer = signLayer('engine', fields, h.privateKey);

    const outcome = await h.controller.applyUpdate(layer, BUILD_STATE);
    assert.equal(outcome.type, 'updateFailed');
    if (outcome.type === 'updateFailed') {
      assert.equal(outcome.stillOnVersion, 'v1');
      assert.match(outcome.message, /sha256 mismatch/);
    }
    assert.equal(h.controller.getCurrentVersion(), 'v1');
    // Only the initial process should exist - verification failed before a new one was spawned.
    assert.equal(h.createdProcesses.length, 1);
  } finally {
    await h.cleanup();
  }
});
