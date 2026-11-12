import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunWindowHost, WindowPlacementStore, type Bounds, type RunNativeWindow, type WindowPreferences } from '../src/main/run/window.js';

// A placement store whose disk write can be held back, like fsync on a loaded machine.
class SlowStore extends WindowPlacementStore {
  gate: Promise<void> | null = null;
  override async save(input: WindowPreferences): Promise<void> { const g = this.gate; if (g) await g; return super.save(input); }
}
const monitors = () => [{ id: 'm', name: 'm', primary: true, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }];

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'run-race-'));
  const placement = new SlowStore(join(dir, 'placement.json'));
  let bounds: Bounds = { x: 0, y: 0, width: 960, height: 144 }, destroyed = false;
  const native: RunNativeWindow = { webContents: { id: 7, send: () => {}, setWindowOpenHandler: () => {}, on: () => {} },
    loadURL: async () => {}, show: () => {}, focus: () => {}, isDestroyed: () => destroyed, destroy: () => { destroyed = true; },
    setAlwaysOnTop: () => {}, setBounds: value => { bounds = value; }, getBounds: () => bounds, on: () => {} };
  const host = new RunWindowHost({ create: options => { destroyed = false; bounds = { x: options.x, y: options.y, width: options.width, height: options.height }; return native; },
    entryUrl: 'file:///run.html', preload: '/p.cjs', monitors, placement, flush: async () => {}, closeRun: async () => {}, onError: error => { throw error; } });
  return { host, placement, dir, bounds: () => bounds, setNative: (b: Bounds) => { bounds = b; } };
}

test('a slow older bounds save cannot overwrite newer window settings (the page was told a stale height and never grew)', async () => {
  const h = await harness();
  try {
    await h.host.open(1);
    h.setNative({ x: 0, y: 0, width: 960, height: 302 }); // the window was 302 high; a resize event starts a save of that snapshot
    let release!: () => void; h.placement.gate = new Promise<void>(r => { release = r; });
    const stale = h.host.saveBounds();
    h.placement.gate = null;
    await h.host.setPreferences({ ...h.host.settings()!, bounds: { x: 0, y: 0, width: 960, height: 144 } }); // newer: back to 144
    release(); await stale;
    assert.equal(h.bounds().height, 144);
    assert.equal(h.host.settings()!.bounds.height, 144, 'the settings reported to the page match the real window');
  } finally { await rm(h.dir, { recursive: true, force: true }); }
});

test('a bounds save started by a window that was closed and reopened does not replace the new window settings', async () => {
  const h = await harness();
  try {
    await h.host.open(1);
    h.setNative({ x: 0, y: 0, width: 960, height: 640 });
    let release!: () => void; h.placement.gate = new Promise<void>(r => { release = r; });
    const stale = h.host.saveBounds();
    h.placement.gate = null;
    await h.host.close(); await h.host.open(1); // new window opens at the reference 144
    release(); await stale;
    assert.equal(h.host.settings()!.bounds.height, 144);
  } finally { await rm(h.dir, { recursive: true, force: true }); }
});

test('settings() reports the real window size even if the stored copy is older', async () => {
  const h = await harness();
  try {
    await h.host.open(1); h.setNative({ x: 0, y: 0, width: 960, height: 190 });
    assert.equal(h.host.settings()!.bounds.height, 190);
  } finally { await rm(h.dir, { recursive: true, force: true }); }
});
