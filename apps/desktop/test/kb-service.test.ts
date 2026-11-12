import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppKb } from '../src/main/kb/appKb.js';
import { buildKb, type BuildOptions } from '../src/main/kb/build.js';
import { KbService, type KbUiStatus } from '../src/main/kb/service.js';
import { kbBadge } from '../src/shared/kbStatus.js';
import { fakeSources, noNet } from './kbHelpers.js';

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'kb-service-'));
  const app = { levelingDir: dir, lootfilterDir: dir, engineDataDir: dir };
  mkdirSync(join(dir, 'kb'), { recursive: true });
  await buildKb({ out: join(dir, 'kb', 'kb.sqlite'), cacheDir: join(dir, 'c0'), app, http: noNet, livePatch: '3.29.3.3', sources: fakeSources({}), force: true });
  const appKb = new AppKb({ resourcesDir: dir, userDataDir: dir });
  return { dir, app, appKb };
}

test('a newer live patch starts a background rebuild and pushes status', async () => {
  const { dir, app, appKb } = await setup();
  try {
    const builds: BuildOptions[] = [];
    const svc = new KbService({
      appKb,
      app,
      cacheDir: join(dir, 'cache'),
      http: noNet,
      central: false,
      live: async () => ({ livePatch: '3.29.4.0', newestThread: null }),
      build: async (o) => {
        builds.push(o);
        return buildKb({ ...o, sources: fakeSources({ ducats: 'Ducat of the Foul Kin' }), force: true });
      },
    });
    const pushes: KbUiStatus[] = [];
    svc.onStatus((s) => pushes.push(s));
    await svc.start();
    await svc.check();
    assert.equal(builds.length >= 1, true);
    assert.equal(builds[0]!.livePatch, '3.29.4.0');
    assert.equal(pushes.some((p) => p.refreshing), true, 'a refreshing status was pushed');
    const st = await svc.status();
    assert.equal(st.refreshing, false);
    assert.equal(st.lastError, null);
    assert.equal(st.livePatch, '3.29.4.0');
    assert.equal(st.dataPatch, '3.29.3.3');
    assert.equal(kbBadge(st).tone, 'behind');
    svc.stop();
    appKb.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a current KB is left alone and a failed rebuild keeps the old data', async () => {
  const { dir, app, appKb } = await setup();
  try {
    let builds = 0;
    let live = '3.29.3.3';
    const svc = new KbService({
      appKb,
      app,
      cacheDir: join(dir, 'cache'),
      http: noNet,
      central: false,
      live: async () => ({ livePatch: live, newestThread: null }),
      build: async () => {
        builds++;
        throw new Error('network down');
      },
    });
    await svc.start();
    await svc.check();
    assert.equal(builds, 0);
    assert.equal(kbBadge(await svc.status()).tone, 'ok');
    live = '3.29.5.0';
    await svc.check();
    assert.equal(builds, 1);
    const st = await svc.status();
    assert.equal(st.lastError, 'network down');
    assert.equal(st.dataPatch, '3.29.3.3');
    assert.equal(st.refreshing, false);
    svc.stop();
    appKb.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
