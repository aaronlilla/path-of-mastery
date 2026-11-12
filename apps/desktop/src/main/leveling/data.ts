/**
 * Loads resources/leveling/<league>/ into LevelingData and the engine gem table into a GemIndex. Plain fs, no electron,
 * so tests and the IPC layer share it. The league folder matching the engine's latest tree version wins; otherwise the
 * newest folder is used and a warning says so.
 */
import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildGemIndex, expandOffers, type EngineGemRecord, type GemIndex, type GemOffersFile } from '../../shared/leveling/offers.js';
import { parseRoute } from '../../shared/leveling/route.js';
import type { LevelingData, LevelingSkillCandidate, ZoneInfo } from '../../shared/leveling/types.js';

const readJson = async <T>(p: string): Promise<T> => JSON.parse(await readFile(p, 'utf8')) as T;

/** League folders ("3.29") under the leveling resources, newest first. */
export function leagueFolders(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const num = (s: string) => s.split('.').map(Number);
  return readdirSync(dir)
    .filter((d) => /^\d+\.\d+$/.test(d) && existsSync(join(dir, d, 'gem-offers.json')))
    .sort((a, b) => {
      const [x, y] = [num(a), num(b)];
      return (y[0]! - x[0]!) || (y[1]! - x[1]!);
    });
}

/** Tree version "3_29" to league "3.29". */
export const leagueOfTree = (treeVersion: string): string => treeVersion.replace(/_ruthless.*$|_alternate.*$/, '').replace('_', '.');

export interface LoadedLeveling {
  data: LevelingData;
  /** Set when the data is from another league than the one asked for. */
  warning?: string;
}

export async function loadLevelingData(resourcesDir: string, wantedLeague?: string): Promise<LoadedLeveling> {
  const folders = leagueFolders(resourcesDir);
  if (!folders.length) throw new Error(`no leveling data in ${resourcesDir}`);
  const league = wantedLeague && folders.includes(wantedLeague) ? wantedLeague : folders[0]!;
  const dir = join(resourcesDir, league);
  const [offersFile, zonesFile, skillsFile, extrasFile] = await Promise.all([
    readJson<GemOffersFile>(join(dir, 'gem-offers.json')),
    readJson<{ route: ZoneInfo[]; otherAreas: Omit<ZoneInfo, 'order'>[] }>(join(dir, 'zones.json')),
    readJson<{ skills: LevelingSkillCandidate[] }>(join(dir, 'leveling-skills.json')),
    readJson<{ quests: Record<string, { passives?: number; note?: string }> }>(join(dir, 'quest-extras.json')),
  ]);
  const routes: Record<number, string> = {};
  for (let a = 1; a <= 10; a++) routes[a] = await readFile(join(dir, 'routes', `act-${a}.txt`), 'utf8');
  const { offers, gems, starts } = expandOffers(offersFile);
  const zones: ZoneInfo[] = [...zonesFile.route, ...zonesFile.otherAreas.map((z, i) => ({ ...z, order: 1000 + i }))];
  const questZones: Record<string, string> = {};
  for (const s of parseRoute(routes, zones).steps) if (s.kind === 'handin') for (const q of s.questIds) questZones[q] ??= s.zone;
  const data: LevelingData = { league, offers, gems, zones, skills: skillsFile.skills, questExtras: extrasFile.quests, starts, routes, questZones };
  const warning = wantedLeague && league !== wantedLeague ? `Leveling data is from ${league}` : undefined;
  return { data, ...(warning ? { warning } : {}) };
}

/** Builds the gem index from the engine's data_gems.json. Slow (several MB of JSON): call it once, off the UI path. */
export async function loadGemIndex(engineDataDir: string, data: LevelingData): Promise<GemIndex> {
  const raw = await readJson<Record<string, EngineGemRecord>>(join(engineDataDir, 'data_gems.json'));
  return buildGemIndex(raw, Object.keys(data.offers));
}
