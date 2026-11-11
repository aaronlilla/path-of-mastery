import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

/**
 * The native calc engine (a future crates/napi build) is loaded by path from
 * config, never bundled or assumed. Until that build exists this must fail
 * honestly - the engine host reports 'unavailable', it never fabricates
 * stats or falls back to a JS reimplementation.
 */
export interface NativeEngineModule {
  /** Recalculates the given build and returns opaque JSON the caller interprets. */
  recalculate(buildXml: string): unknown;
  version: string;
  /** Session functions (crates/napi); each returns JSON text. Optional so older engines still load. */
  loadBuild?(buildXml: string): string;
  toggleNode?(buildId: string, nodeId: number): string;
  previewNode?(buildId: string, nodeId: number): string;
  finish?(buildId: string): string | null;
  closeBuild?(buildId: string): void;
  edit?(buildId: string, editJson: string): string;
  previewEdit?(buildId: string, editJson: string): string;
  previewAddNodes?(buildId: string, nodeIdsJson: string): string;
  previewRemoveNodes?(buildId: string, nodeIdsJson: string): string;
  finishPreview?(buildId: string): string | null;
  undo?(buildId: string): string | null;
  redo?(buildId: string): string | null;
  history?(buildId: string): string;
  treeState?(buildId: string): string;
  /** The Calcs tab sections (JSON) from the live calculation. */
  calcs?(buildId: string, buffMode?: string | null): string;
  /** The Calcs tab with its popup data (JSON); `collapsed` is a JSON object of collapse-state overrides. */
  calcsView?(buildId: string, collapsed?: string): string;
  /** The modifier table of one popup entry (JSON text, `null` when it has none). */
  calcsMods?(buildId: string, detail: string): string;
  /** One boss fight of the open build (JSON in and out, see FightResult in the protocol). */
  fightSim?(buildId: string, optionsJson: string): string;
  /** Every minion the Spectre Library can hold (JSON `[{id, name}]`). */
  spectreCatalog?(): string;
  /** `{"player": {stat: table}, "minion": {...} | null}` (JSON): the breakdown tables of a separate Calcs-mode calculation. */
  breakdowns?(buildId: string, buffMode?: string | null): string;
  /** `{name, flags, skillTypes}` (JSON) of the main skill after the calculation. */
  mainSkill?(buildId: string): string;
  exportedBuffs?(buildId: string): string;
  buildXml?(buildId: string): string;
  collect?(buildId: string): void;
  prepare?(buildId: string): void;
  /** Node Power run: `nodePowerStart` returns the node count, `nodePowerStep` works for about `budgetMs` and returns JSON. */
  nodePowerStart?(buildId: string, maxDepth: number | null, stat: string | null): number;
  nodePowerStep?(buildId: string, budgetMs: number): string;
  /** Optimize pathing run, same shape. */
  optimizeStart?(buildId: string, objective: string): string;
  optimizeStep?(buildId: string, budgetMs: number): string;
  optimizeCancel?(buildId: string): void;
  /** Smart pathing, JSON out: `{nodeIds}` or `{unreachable}`. */
  pathSolve?(buildId: string, wanted: number[], avoided: number[]): string;
  /** Build solver (JSON in and out, see SolveGoal / SolveSnapshot in the protocol). */
  solveStart?(buildId: string, goalJson: string, optionsJson?: string): string;
  solveStep?(solveId: string, budgetMs: number): string;
  solveCancel?(solveId: string): void;
  solveAddLeads?(solveId: string, leadsJson: string): string;
  solveResult?(solveId: string, index: number): string;
  solveResultById?(solveId: string, id: string): string;
  /** Find Timeless Jewel: data folder, dialog lists and the stepped search (JSON text). */
  timelessStatus?(): string;
  timelessSetDataDir?(dir: string | null): void;
  timelessInfo?(buildId: string): string;
  timelessMods?(buildId: string, jewelType: number): string;
  timelessStart?(buildId: string, paramsJson: string): string;
  timelessStep?(buildId: string, budgetMs: number): string;
  timelessRows?(buildId: string, from: number, count: number): string;
  timelessCancel?(buildId: string): void;
  recalc?(buildId: string): string;
  timelessFallback?(buildId: string, jewelType: number, stat: string): string;
  /** Configuration and Skills tab data (crates/pipeline `tabdata`); each returns JSON text. */
  configCatalog?(): string;
  configState?(buildId: string): string;
  gemCatalog?(): string;
  statMeta?(): string;
  configMods?(buildId: string): string;
  skillsState?(buildId: string): string;
  gemPower?(buildId: string, group: number, field: string, gemIdsJson: string, replace: number): string;
  itemInfo?(buildId: string | null, itemText: string, options?: string | null): string;
  itemsInfo?(buildId: string | null, texts: string): string;
  itemCatalog?(): string;
  itemCraft?(baseName: string, rarity: string, title?: string | null): string;
  itemPool?(itemText: string, kind: string): string;
  modPool?(base: string, itemLevel: number, options?: string | null): string;
  itemNormalise?(itemText: string): string;
  resolveImportedClusters?(buildXml: string, hashesEx: string, jewelData: string): string;
  itemAffix?(itemText: string, choice: string): string;
  powerStats?(): string;
  itemRank?(buildId: string, stat: string, candidates: string): string;
  /** `itemRank` and `itemsInfo` worked out on the engine's own threads (the background ranking). */
  itemRankBackground?(buildId: string, stat: string, candidates: string): Promise<string>;
  itemsInfoBackground?(buildId: string | null, texts: string): Promise<string>;
  itemCatalogPrewarm?(): void;
  itemFlask?(buildId: string, itemText: string): string;
  buildFlags?(buildId: string, names: string): string;
  gemTip?(buildId: string | null, skillId: string, level: number): string;
}

export type NativeLoadResult =
  | { ok: true; engine: NativeEngineModule }
  | { ok: false; reason: string };

const require = createRequire(import.meta.url);

/** A downloaded engine pack is named by its update (engine-1.2.3.pack), and require() reads any file that does not end in .node as JavaScript; .node and script files (test doubles) are required as before. */
function loadNative(path: string): unknown {
  if (/\.(node|[cm]?js)$/i.test(path)) return require(path);
  const m = { exports: {} } as NodeJS.Module;
  process.dlopen(m, path);
  return m.exports;
}

export function loadNativeEngine(nativeModulePath: string | undefined): NativeLoadResult {
  if (!nativeModulePath) {
    return { ok: false, reason: 'no native engine module path configured' };
  }
  if (!existsSync(nativeModulePath)) {
    return { ok: false, reason: `native engine module not found at ${nativeModulePath}` };
  }
  try {
    const mod = loadNative(nativeModulePath) as Partial<NativeEngineModule>;
    if (typeof mod.recalculate !== 'function' || typeof mod.version !== 'string') {
      return { ok: false, reason: `module at ${nativeModulePath} does not implement the expected native engine interface` };
    }
    return { ok: true, engine: mod as NativeEngineModule };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `failed to load native engine module: ${message}` };
  }
}
