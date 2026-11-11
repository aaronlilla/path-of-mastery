import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { flushDirectory } from '../documents/blobs.js';
import type { Bounds, Monitor, WindowPreferences } from '../../shared/run/window.js';
export type { Bounds, Monitor, WindowPreferences } from '../../shared/run/window.js';

export function referenceSize(lanes: number, size: WindowPreferences['size'] = 'standard', vertical = false): { width: number; height: number } {
  if (!Number.isSafeInteger(lanes) || lanes < 1) throw new Error('Run needs at least one lane.');
  return vertical ? { width: 360, height: 600 } : { width: size === 'compact' ? 640 : size === 'large' ? 1200 : 960,
    height: lanes === 1 ? 144 : Math.min(376, 220 + (lanes - 2) * 52) };
}
const intersection = (a: Bounds, b: Bounds) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
export function clampBounds(bounds: Bounds, monitors: readonly Monitor[], preferredId?: string): { bounds: Bounds; monitorId: string; rehomed: boolean } {
  if (!monitors.length || [bounds, ...monitors.map(m => m.workArea)].some(b => ![b.x, b.y, b.width, b.height].every(Number.isFinite) || b.width <= 0 || b.height <= 0))
    throw new Error('Monitor bounds are unavailable.');
  const primary = monitors.find(m => m.primary) ?? monitors[0]!;
  const preferred = monitors.find(m => m.id === preferredId);
  const visible = [...monitors].sort((a, b) => intersection(bounds, b.workArea) - intersection(bounds, a.workArea))[0]!;
  const monitor = preferred ?? (preferredId ? primary : intersection(bounds, visible.workArea) > 0 ? visible : primary);
  const area = monitor.workArea, width = Math.min(bounds.width, area.width), height = Math.min(bounds.height, area.height);
  return { bounds: { width, height, x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - height)) }, monitorId: monitor.id,
    rehomed: !!preferredId && !preferred };
}
export function defaultPreferences(monitor: Monitor, lanes: number): WindowPreferences {
  return { bounds: { x: monitor.workArea.x, y: monitor.workArea.y, ...referenceSize(lanes) }, monitorId: monitor.id,
    alwaysOnTop: true, size: 'standard', orientation: 'auto', textSize: 26, opacity: .95, sound: false };
}
export function validatePreferences(value: WindowPreferences): void {
  if (!value || !value.bounds || typeof value.monitorId !== 'string' || !value.monitorId ||
    ![value.bounds.x, value.bounds.y, value.bounds.width, value.bounds.height].every(Number.isFinite) || value.bounds.width <= 0 || value.bounds.height <= 0 ||
    typeof value.alwaysOnTop !== 'boolean' || typeof value.sound !== 'boolean' || !['compact', 'standard', 'large'].includes(value.size) ||
    !['auto', 'horizontal', 'vertical'].includes(value.orientation) || ![26, 32].includes(value.textSize) ||
    !Number.isFinite(value.opacity) || value.opacity < .6 || value.opacity > 1) throw new Error('Invalid Run window settings.');
}
export class WindowPlacementStore {
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly path: string) {}
  async load(): Promise<WindowPreferences | null> {
    try { const value = JSON.parse(await readFile(this.path, 'utf8')) as WindowPreferences; validatePreferences(value); return value; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  save(input: WindowPreferences): Promise<void> {
    validatePreferences(input); const value = structuredClone(input);
    const task = this.queue.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const temp = `${this.path}.${randomUUID()}.tmp`, file = await open(temp, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
      await rename(temp, this.path); await flushDirectory(dirname(this.path));
    });
    this.queue = task.catch(() => undefined); return task;
  }
}

export const runWindowOptions = (bounds: Bounds, preload: string) => ({ ...bounds, show: false, frame: false, transparent: true,
  backgroundColor: '#00000000', alwaysOnTop: true, webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false } });
export type RunNativeWindow = {
  webContents: { id: number; send(channel: string, payload: unknown): void; setWindowOpenHandler(handler: () => { action: 'deny' }): void;
    on(event: 'will-navigate', callback: (event: { preventDefault(): void }, url: string) => void): void };
  loadURL(url: string): Promise<void>; show(): void; focus(): void; isDestroyed(): boolean; destroy(): void;
  setAlwaysOnTop(value: boolean): void; setBounds(bounds: Bounds): void; getBounds(): Bounds;
  on(event: 'close', callback: (event: { preventDefault(): void }) => void): void;
  on(event: 'move' | 'resize', callback: () => void): void;
};
export type WindowHostOptions = {
  create(options: ReturnType<typeof runWindowOptions>): RunNativeWindow;
  entryUrl: string; preload: string; monitors(): Monitor[]; placement: WindowPlacementStore;
  flush(): Promise<void>; closeRun(): Promise<void>; onError(error: unknown): void;
};
export class RunWindowHost {
  private window: RunNativeWindow | null = null;
  private preferences: WindowPreferences | null = null;
  private closing: Promise<void> | null = null;
  private opening: Promise<void> | null = null;
  private revision = 0; // bumped on every change of this.preferences: a slower, older save must not write its snapshot over a newer one
  constructor(private readonly options: WindowHostOptions) {}
  senderId(): number | null { return this.window && !this.window.isDestroyed() ? this.window.webContents.id : null; }
  /** The window settings with the position and size the window really has right now (a save still in flight can hold older numbers). */
  settings(): WindowPreferences | null {
    if (!this.preferences) return null;
    const value = structuredClone(this.preferences);
    if (this.window && !this.window.isDestroyed()) value.bounds = { ...this.window.getBounds() };
    return value;
  }
  raise(): void { if (this.window && !this.window.isDestroyed()) { this.window.show(); this.window.focus(); } }
  open(lanes: number): Promise<void> {
    if (this.opening) return this.opening;
    if (this.senderId() !== null) { this.raise(); return Promise.resolve(); }
    const task = this.openWindow(lanes); this.opening = task;
    return task.finally(() => { this.opening = null; });
  }
  private async openWindow(lanes: number): Promise<void> {
    const monitors = this.options.monitors(), primary = monitors.find(m => m.primary) ?? monitors[0];
    if (!primary) throw new Error('Monitor bounds are unavailable.');
    const saved = await this.options.placement.load();
    // A saved position is kept, but the strip always opens at its reference size for this timeline's lanes (144 / 220 + 52 per lane / 360x600).
    const prefs = saved ? { ...saved, bounds: { ...saved.bounds, ...referenceSize(lanes, saved.size, saved.orientation === 'vertical') } } : defaultPreferences(primary, lanes);
    const clamped = clampBounds(prefs.bounds, monitors, prefs.monitorId);
    this.preferences = { ...prefs, bounds: clamped.bounds, monitorId: clamped.monitorId }; this.revision++;
    const window = this.options.create(runWindowOptions(clamped.bounds, this.options.preload)); this.window = window;
    window.setAlwaysOnTop(prefs.alwaysOnTop);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => { if (url !== this.options.entryUrl) event.preventDefault(); });
    window.on('close', event => { event.preventDefault(); void this.close().catch(error => this.options.onError(error)); });
    for (const event of ['move', 'resize'] as const) window.on(event, () => {
      if (!this.closing) void this.saveBounds().catch(error => this.options.onError(error));
    });
    try { await window.loadURL(this.options.entryUrl); await this.options.placement.save(this.preferences); window.show(); }
    catch (error) { window.destroy(); this.window = null; throw error; }
  }
  send(view: unknown): void { if (this.window && !this.window.isDestroyed()) this.window.webContents.send('mastery:run:changed', view); }
  async setPreferences(preferences: WindowPreferences): Promise<void> {
    validatePreferences(preferences);
    const clamped = clampBounds(preferences.bounds, this.options.monitors(), preferences.monitorId);
    const next = { ...preferences, bounds: clamped.bounds, monitorId: clamped.monitorId };
    await this.options.placement.save(next); this.preferences = next; this.revision++;
    this.window?.setAlwaysOnTop(next.alwaysOnTop); this.window?.setBounds(next.bounds);
    // Background opacity and text sizes are view data; native opacity would also fade the text.
    this.send({ kind: 'windowPreferences', preferences: next, rehomed: clamped.rehomed });
  }
  async monitorsChanged(): Promise<void> {
    if (this.preferences) await this.setPreferences({ ...this.preferences, bounds: this.window?.getBounds() ?? this.preferences.bounds });
  }
  async saveBounds(): Promise<void> {
    if (!this.preferences || !this.window || this.window.isDestroyed()) return;
    const window = this.window, revision = ++this.revision;
    const { bounds, monitorId } = clampBounds(window.getBounds(), this.options.monitors());
    const next = { ...this.preferences, bounds, monitorId };
    await this.options.placement.save(next);
    // The save can take long on a loaded disk. If the window was closed and reopened, or the settings changed again meanwhile,
    // this snapshot is stale: keep the file write (the queue keeps the order) but do not let it replace the current settings.
    if (this.window === window && this.revision === revision) this.preferences = next;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    const task = (async () => {
      await this.options.flush();
      await this.saveBounds();
      await this.options.closeRun();
      this.window?.destroy(); this.window = null;
    })();
    this.closing = task;
    return task.finally(() => { this.closing = null; });
  }
  async mainClose(choice: 'keep_run_open' | 'close_both'): Promise<void> {
    await this.options.flush();
    if (choice === 'close_both') await this.close();
  }
}
