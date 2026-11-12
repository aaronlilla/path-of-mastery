import { app, ipcMain, type BrowserWindow } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LVL, type CandidateDto, type GuideRequest, type GuideResult, type SettingsPatch } from '../../shared/leveling/ipcTypes.js';
import type { GemIndex } from '../../shared/leveling/offers.js';
import { rankCandidates } from '../../shared/leveling/plan.js';
import type { LevelingData } from '../../shared/leveling/types.js';
import { LATEST_TREE_VERSION } from '../../shared/treeSets.js';
import type { Result } from '../../shared/library.js';
import { readClientLog, watchZoneEntries } from '../lootfilter/clientLog.js';
import { leagueOfTree, loadGemIndex, loadLevelingData } from './data.js';
import { LevelingStore } from './store.js';
import type { LootFilterStore } from '../lootfilter/store.js';
import { loadGameData } from '../lootfilter/buildData.js';
import { generateGuide } from './guideFor.js';
import { readLevelingOverride, writeLevelingOverride } from './override.js';

async function wrap<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Where the bundled leveling data lives: next to the app in a package, in resources/ in development. */
export function bundledLevelingDir(): string {
  if (app.isPackaged) return join(process.resourcesPath ?? '', 'leveling');
  return fileURLToPath(new URL('../../../resources/leveling', import.meta.url));
}

function hashOf(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 7) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

export function registerLevelingIpc(deps: { getWindow: () => BrowserWindow | null; lootStore: LootFilterStore }): { store: LevelingStore } {
  const store = new LevelingStore(join(app.getPath('userData'), 'leveling', 'progress.json'));
  const engineDir = () => process.env.POM_ENGINE_DATA ?? '';
  let loaded: Promise<{ data: LevelingData; idx: GemIndex; warning?: string }> | undefined;
  const load = () =>
    (loaded ??= (async () => {
      const { data, warning } = await loadLevelingData(bundledLevelingDir(), leagueOfTree(LATEST_TREE_VERSION));
      const idx = await loadGemIndex(engineDir(), data);
      return { data, idx, ...(warning ? { warning } : {}) };
    })());

  const filterOverride = () => readLevelingOverride(deps.lootStore);
  const setFilterOverride = (gemId: string) => writeLevelingOverride(deps.lootStore, gemId);

  const cache = new Map<string, { key: string; value: GuideResult }>();

  async function guide(req: GuideRequest): Promise<GuideResult> {
    let ready;
    try {
      ready = await load();
    } catch (e) {
      loaded = undefined;
      throw e;
    }
    const { data, idx, warning } = ready;
    const progress = { ...store.get(req.buildId), levelingSkill: (await filterOverride()) || undefined };
    const key = `${req.xml.length}:${hashOf(req.xml)}:${progress.leagueStart}:${progress.levelingSkill ?? ''}`;
    const hit = cache.get(req.buildId);
    if (hit && hit.key === key) return { ...hit.value, progress };
    const override = await filterOverride();
    const { guide: g, plan, lite, build, tree } = await generateGuide({ data, idx, engineDir: engineDir(), game: () => loadGameData(engineDir()) }, req.xml, override, progress.leagueStart);
    const nodeNames: Record<number, string> = {};
    for (const a of g.acts) {
      for (const s of a.steps) {
        if (s.kind === 'tree') for (const id of s.add) nodeNames[id] = tree?.name(id) ?? String(id);
        if (s.kind === 'lab') s.ascend.forEach((id, i) => (nodeNames[id] = s.ascendNames[i] ?? String(id)));
      }
    }
    const candidates: CandidateDto[] = rankCandidates(lite, data)
      .slice(0, 12)
      .map((c) => ({ gemId: c.candidate.gemId, name: data.gems[c.candidate.gemId]?.name ?? c.candidate.gemId, score: Math.round(c.score * 10) / 10, reason: c.reason, availLevel: c.availLevel }));
    const gems: GuideResult['gems'] = {};
    for (const [id, m] of Object.entries(data.gems)) gems[id] = { name: m.name, colour: m.colour };
    const value: GuideResult = {
      guide: g,
      plan,
      progress,
      candidates,
      build: { className: build.className, ascendancy: build.ascendancy, mainSkill: data.gems[build.mainSkillId]?.name ?? '', level: build.level, ruthless: build.ruthless },
      nodeNames,
      ...(tree ? {} : { treeNote: 'The passive tree data for this build is missing, so tree steps are left out.' }),
      ...(warning ? { warning } : {}),
      gems,
    };
    cache.set(req.buildId, { key, value });
    return value;
  }

  // ---- auto tick: follow Client.txt ----
  let watcher: { stop(): void } | null = null;
  async function startWatch(): Promise<void> {
    if (watcher) return;
    let path = process.env.POM_CLIENT_LOG ?? '';
    if (!path) {
      const info = await readClientLog('', { maxBytes: 1 });
      path = info.found ? info.path : '';
    }
    if (!path || watcher) return;
    watcher = watchZoneEntries(path, (name) => {
      const w = deps.getWindow();
      if (w && !w.isDestroyed()) w.webContents.send(LVL.ZONE, { name, at: Date.now() });
    });
  }
  function stopWatch(): void {
    watcher?.stop();
    watcher = null;
  }
  if (store.anyAutoTick()) void startWatch();

  ipcMain.handle(LVL.GUIDE, (_e, req: GuideRequest) => wrap(() => guide(req)));
  ipcMain.handle(LVL.TICK, (_e, buildId: string, stepIds: string[], done: boolean) => wrap(async () => store.tick(buildId, stepIds, done)));
  ipcMain.handle(LVL.SETTINGS, (_e, buildId: string, patch: SettingsPatch) =>
    wrap(async () => {
      const next = store.set(buildId, {
        ...(patch.autoTick !== undefined ? { autoTick: patch.autoTick } : {}),
        ...(patch.leagueStart !== undefined ? { leagueStart: patch.leagueStart } : {}),
      });
      if (patch.levelingSkill !== undefined) await setFilterOverride(patch.levelingSkill);
      next.levelingSkill = (await filterOverride()) || undefined;
      if (patch.autoTick) await startWatch();
      else if (patch.autoTick === false && !store.anyAutoTick()) stopWatch();
      return next;
    }),
  );
  return { store };
}
