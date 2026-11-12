import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DEFAULT_SETTINGS, LANGUAGE_CODES, type AppSettings } from '../../shared/library.js';

/** Keeps only keys we know, with the type the default has, so a hand-edited file can't break the app. */
export function sanitizeSettings(raw: unknown): AppSettings {
  const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  if (raw && typeof raw === 'object') {
    for (const [k, def] of Object.entries(DEFAULT_SETTINGS)) {
      const v = (raw as Record<string, unknown>)[k];
      if (typeof v === typeof def) out[k] = v;
    }
  }
  const s = out as unknown as AppSettings;
  s.defaultLevel = Math.max(1, Math.min(100, Math.round(s.defaultLevel)));
  s.defaultGemQuality = Math.max(0, Math.min(23, Math.round(s.defaultGemQuality)));
  s.defaultAffixQuality = Math.max(0, Math.min(100, Math.round(s.defaultAffixQuality)));
  const oneOf = <T extends string>(v: T, allowed: readonly T[], d: T): T => (allowed.includes(v) ? v : d);
  s.theme = oneOf(s.theme, ['obsidian', 'midnight', 'verdigris', 'nocturne', 'saffron', 'umber'], 'obsidian');
  s.mode = oneOf(s.mode, ['light', 'dark', 'system'], 'dark');
  s.glass = oneOf(s.glass, ['liquid', 'clear', 'frosted'], 'liquid');
  s.texture = oneOf(s.texture, ['off', 'subtle', 'stone'], 'subtle');
  s.density = oneOf(s.density, ['comfortable', 'compact'], 'comfortable');
  s.libraryView = oneOf(s.libraryView, ['grid', 'list'], 'grid');
  s.librarySort = oneOf(s.librarySort, ['edited', 'name', 'class', 'level'], 'edited');
  s.language = oneOf(s.language, ['system', ...LANGUAGE_CODES], 'system');
  s.uiScale = oneOf(s.uiScale, ['system', '90', '100', '110', '125', '150'], 'system');
  s.starfield = oneOf(s.starfield, ['Full', 'Calm', 'Off'], 'Calm');
  s.nodePowerColours = oneOf(s.nodePowerColours, ['red-blue', 'red-green', 'green-blue'], 'red-blue');
  s.proxyKind = oneOf(s.proxyKind, ['http', 'socks5'], 'http');
  s.connectionProtocol = oneOf(s.connectionProtocol, ['auto', 'ipv4', 'ipv6'], 'auto');
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  s.statOrder = strings(s.statOrder);
  s.pinnedStats = strings(s.pinnedStats).slice(0, 2);
  return s;
}

export class SettingsStore {
  private cache: AppSettings | null = null;
  private readonly listeners = new Set<(s: AppSettings) => void>();

  constructor(private readonly path: string) {}

  async get(): Promise<AppSettings> {
    if (this.cache) return this.cache;
    let raw: unknown = null;
    try {
      raw = JSON.parse(await readFile(this.path, 'utf8'));
    } catch {
      /* first run or unreadable: defaults */
    }
    this.cache = sanitizeSettings(raw);
    return this.cache;
  }

  /** Called with the saved settings after every change (the main process applies the ones it owns). */
  onChange(l: (s: AppSettings) => void): void {
    this.listeners.add(l);
  }

  async set(patch: Partial<AppSettings>): Promise<AppSettings> {
    const next = sanitizeSettings({ ...(await this.get()), ...patch });
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = this.path + '.tmp';
    await writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
    await rename(tmp, this.path);
    this.cache = next; // only once it is on disk: a failed write must not leave unsaved settings looking saved
    for (const l of this.listeners) l(next);
    return next;
  }
}
