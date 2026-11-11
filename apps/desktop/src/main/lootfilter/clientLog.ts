import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AreaVisit, ClientLogInfo } from '../../shared/lootfilter/ipcTypes.js';
import { parseLogLine, type LogEvent } from '../../shared/journey/logEvent.js';
import { posixClientLogCandidates } from '../gamePaths.js';
import { readLogTail, subscribeLog } from '../journey/logReader.js';

/**
 * What the game's Client.txt tells us: every area the player entered, with its area level and when. It does NOT
 * record item drops or pickups, so nothing here knows what dropped.
 */

/** Reads area visits from log text, oldest first. A "Generating level" line gives the level; the next "You have entered" line names it. */
export function parseAreas(text: string): AreaVisit[] {
  return areasFromEvents(text.split(/\r?\n/).map(line => parseLogLine(line)));
}

function areasFromEvents(events: (LogEvent | null)[]): AreaVisit[] {
  const out: AreaVisit[] = [];
  let pending: { at: number; id: string; level: number } | null = null;
  let lines = 0;
  for (const event of events) {
    if (event?.t === 'area') {
      if (pending) out.push({ at: pending.at, id: pending.id, name: pending.id, level: pending.level });
      pending = { at: event.at, id: event.id, level: event.level };
      lines = 0;
      continue;
    }
    if (!pending) continue;
    if (event?.t === 'zone') {
      out.push({ at: pending.at, id: pending.id, name: event.name, level: pending.level });
      pending = null;
    } else if (++lines > 6) {
      out.push({ at: pending.at, id: pending.id, name: pending.id, level: pending.level });
      pending = null;
    }
  }
  if (pending) out.push({ at: pending.at, id: pending.id, name: pending.id, level: pending.level });
  return out;
}

export function clientLogCandidates(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== 'win32') return posixClientLogCandidates(platform);
  const pf86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const pf = env.ProgramFiles ?? 'C:\\Program Files';
  const rel = join('Path of Exile', 'logs', 'Client.txt');
  return [
    join(pf86, 'Steam', 'steamapps', 'common', rel),
    join(pf, 'Steam', 'steamapps', 'common', rel),
    join(pf86, 'Grinding Gear Games', rel),
    join(pf, 'Grinding Gear Games', rel),
    join('C:\\', 'Games', 'Steam', 'steamapps', 'common', rel),
    join('D:\\', 'SteamLibrary', 'steamapps', 'common', rel),
    join('D:\\', 'Steam', 'steamapps', 'common', rel),
    join('E:\\', 'SteamLibrary', 'steamapps', 'common', rel),
  ];
}

async function exists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

/** Reads the end of the log (the last `maxBytes`), which is plenty for the recent areas. */
export async function readClientLog(configured: string, opts: { maxBytes?: number; candidates?: string[] } = {}): Promise<ClientLogInfo> {
  const tried = configured ? [configured] : opts.candidates ?? clientLogCandidates();
  let path = '';
  for (const c of tried) {
    if (await exists(c)) {
      path = c;
      break;
    }
  }
  if (!path) return { found: false, path: configured, areas: [], note: configured ? `There is no file at ${configured}.` : 'Client.txt was not found in the usual game folders. Choose it in Settings.' };
  const max = opts.maxBytes ?? 4 * 1024 * 1024;
  const tail = await readLogTail(path, max);
  return { found: true, path, areas: areasFromEvents(tail.envelopes.map(e => e.event)).slice(-300), modifiedAt: tail.modifiedAt };
}

/** The zone name in a "You have entered X." line, or null. */
export function zoneEntered(line: string): string | null {
  const event = parseLogLine(line);
  return event?.t === 'zone' ? event.name : null;
}

/**
 * Follows the end of Client.txt and calls `onEvent` for every line Journey uses (zones, area levels, level-ups, deaths,
 * passive points) written after the watch started. Uses the shared cursor reader; stop() removes only this consumer.
 */
export function watchLog(path: string, onEvent: (e: LogEvent) => void, intervalMs = 500): { stop(): void } {
  let stopped = false;
  const sub = subscribeLog(path, batch => {
    for (const envelope of batch.envelopes) if (!stopped && envelope.origin === 'live') onEvent(envelope.event);
  }, { intervalMs });
  return { stop: () => { stopped = true; sub.stop(); } };
}

/** Calls `onZone` for every "You have entered" line written after the watch started (the Leveling tab's auto tick). */
export function watchZoneEntries(path: string, onZone: (name: string) => void, intervalMs = 500): { stop(): void } {
  return watchLog(path, (e) => e.t === 'zone' && onZone(e.name), intervalMs);
}
