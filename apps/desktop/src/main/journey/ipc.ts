/** Electron wiring of the Journey service (DESIGN.md 7.2, 7.3). The service itself is in service.ts. */
import { app, ipcMain, type BrowserWindow } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CharsRequest, CheckGemsRequest, GapFilterRequest, PinRequest, PlanRequest, PolicyRequest, BestSetupCommand } from '../../shared/journey/ipcTypes.js';
import { JRN, type JrnResult } from '../../shared/journey/ipcTypes.js';
import { JRNX } from '../../shared/journey/liveExtra.js';
import type { BudgetInfo, CharacterLink, JourneyPlan } from '../../shared/journey/types.js';
import { LATEST_TREE_VERSION } from '../../shared/treeSets.js';
import { sampleWindow } from '../character/sample.js';
import { leagueOfTree, loadGemIndex, loadLevelingData } from '../leveling/data.js';
import type { GuideKit } from '../leveling/guideFor.js';
import type { LevelingStore } from '../leveling/store.js';
import { loadGameData } from '../lootfilter/buildData.js';
import { readClientLog } from '../lootfilter/clientLog.js';
import type { LootFilterStore } from '../lootfilter/store.js';
import { GGG_DEFAULT_LIMITS, RateLimiter } from '../wealth/rateLimiter.js';
import type { WealthService } from '../wealth/service.js';
import { makeBuildSource } from './guideSource.js';
import { kbSeedFromEnv } from './kbEnv.js';
import { JourneyService } from './service.js';

/** What the planner side plugs in. Absent members answer "not available yet". */
export interface JourneyBackend {
  plan?(req: PlanRequest): Promise<JourneyPlan>;
  pin?(req: PinRequest): Promise<JourneyPlan>;
  policy?(req: PolicyRequest): Promise<JourneyPlan>;
  gapFilter?(req: GapFilterRequest, live: JourneyService): Promise<{ path: string; written: true }>;
  best?(cmd: BestSetupCommand): Promise<{ id: string } | null>;
  budget?(base: BudgetInfo): BudgetInfo;
}

async function wrap<T>(fn: () => Promise<T> | T): Promise<JrnResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

const missing = (what: string): Error => new Error(`${what} is not available in this build yet.`);

export function registerJourneyIpc(deps: { getWindow: () => BrowserWindow | null; wealth: WealthService; lootStore: LootFilterStore; levelingStore: LevelingStore; backend?: JourneyBackend }): JourneyService {
  const sample = process.env.POM_CHARACTER_SAMPLE;
  const sampleAccount = 'Kaelen#4821';
  const engineDir = (): string => process.env.POM_ENGINE_DATA ?? '';
  const levelingDir = app.isPackaged ? join(process.resourcesPath ?? '', 'leveling') : fileURLToPath(new URL('../../../resources/leveling', import.meta.url));

  let loaded: ReturnType<typeof loadKit> | undefined;
  const loadKit = async () => {
    const { data } = await loadLevelingData(levelingDir, leagueOfTree(LATEST_TREE_VERSION));
    const idx = await loadGemIndex(engineDir(), data);
    const kit: GuideKit = { data, idx, engineDir: engineDir(), game: () => loadGameData(engineDir()) };
    return kit;
  };
  const kit = (): ReturnType<typeof loadKit> => (loaded ??= loadKit());

  const limiter = sample ? new RateLimiter({ now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), minGapMs: 0, margin: 2, defaults: GGG_DEFAULT_LIMITS }) : null;

  const svc = new JourneyService({
    dir: join(app.getPath('userData'), 'journey'),
    kb: kbSeedFromEnv(async () => (await kit()).data),
    loadBuild: makeBuildSource({ kit, engineDir: engineDir(), leagueStart: (k) => deps.levelingStore.get(k).leagueStart }),
    ticks: { get: (k) => deps.levelingStore.get(k).ticked, tick: (k, ids, done) => deps.levelingStore.tick(k, ids, done).ticked },
    win: sample ? sampleWindow(sample, sampleAccount) : (p, q, c) => deps.wealth.characterWindow(p, q, c),
    session: () => (sample ? { connected: true, account: sampleAccount } : deps.wealth.importAccess()),
    limiter: limiter ?? deps.wealth.characterLimiter(),
    logPath: async () => {
      const env = process.env.POM_CLIENT_LOG;
      if (env) return env;
      const st = await deps.lootStore.load();
      const info = await readClientLog(st.settings.clientLogPath, { maxBytes: 1 });
      return info.found ? info.path : '';
    },
    push: (s) => {
      const w = deps.getWindow();
      if (w && !w.isDestroyed()) w.webContents.send(JRN.LIVE, s);
    },
  });
  void svc.init();

  const h = <A extends unknown[], T>(ch: string, fn: (...a: A) => Promise<T> | T): void => {
    ipcMain.handle(ch, (_e, ...a: unknown[]) => wrap(() => fn(...(a as A))));
  };
  h(JRNX.SET_BUILD, (b: { buildKey: string; name: string; xml: string }) => svc.setBuild(b));
  h(JRNX.TICK, (ids: string[], done: boolean) => {
    svc.live.tick(ids, done);
    return svc.state();
  });
  h(JRNX.OFFPLAN, (node: number, op: 'keep' | 'refund') => {
    svc.live.offPlan(node, op);
    return svc.state();
  });
  h(JRNX.DISMISS_TOWN, () => {
    svc.live.dismissTown();
    return svc.state();
  });
  h(JRNX.GET_LINK, () => svc.live.getLink());
  h(JRNX.STATE, () => svc.state());
  h(JRN.CHARS, (r: CharsRequest) => svc.chars(r));
  h(JRN.CHECK_GEMS, (r: CheckGemsRequest) => svc.checkGems(r));
  h(JRN.LINK, (l: CharacterLink | null) => svc.setLink(l));
  h(JRN.SYNC, () => svc.syncNow());
  h(JRN.BUDGET, () => (deps.backend?.budget ? deps.backend.budget(svc.budget()) : svc.budget()));
  h(JRN.PLAN, (r: PlanRequest) => (deps.backend?.plan ? deps.backend.plan(r) : Promise.reject(missing('The route planner'))));
  h(JRN.PIN, (r: PinRequest) => (deps.backend?.pin ? deps.backend.pin(r) : Promise.reject(missing('The route planner'))));
  h(JRN.POLICY, (r: PolicyRequest) => (deps.backend?.policy ? deps.backend.policy(r) : Promise.reject(missing('The route planner'))));
  h(JRN.GAP_FILTER, (r: GapFilterRequest) => (deps.backend?.gapFilter ? deps.backend.gapFilter(r, svc) : Promise.reject(missing('Updating the filter for your gaps'))));
  h(JRN.BEST, (c: BestSetupCommand) => (deps.backend?.best ? deps.backend.best(c) : Promise.reject(missing('Best setup'))));
  return svc;
}
