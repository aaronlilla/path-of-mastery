/**
 * Entry point run inside the engine host process - an Electron
 * `utilityProcess` in production, a plain `child_process.fork` in tests
 * (see engineProcessAdapter.ts / the hot-swap tests). It never runs inside
 * the renderer.
 *
 * Two message shapes cross this boundary:
 *  - EngineRequest/EngineResponse (packages/protocol/commands.ts): the
 *    renderer-facing command surface, forwarded verbatim by main.
 *  - HostControlMessage (below): hot-swap plumbing used only between main
 *    and this process, never seen by the renderer.
 */
import { MUTATING_COMMANDS, type BuildEdit, type ClickBlocked, type CommandParams, type EngineRequest, type EngineResponse, type EngineStatus, type StatDelta, type StatDiff, type StatScalar, type StatValue, type TreeState } from '@pom/protocol';
import { loadNativeEngine, type NativeEngineModule, type NativeLoadResult } from './nativeLoader.js';
import type { HostControlMessage, HostControlResponse } from './controlProtocol.js';
import { setConfigInputs } from '../shared/buildFacts.js';
import { partyFromEngine, partyFromState, partyToEngine, writeParty } from '../shared/partyXml.js';
import { applyHostEdit, isHostEdit } from '../shared/hostEdits.js';

/**
 * Builds kept open in the engine. Over the cap, the draft or scratch copy used longest ago is closed first; the
 * player's open build and builds a window shows (`keep`) are never closed for room. With nothing left to close, the
 * new open is refused.
 */
const MAX_OPEN_BUILDS = 6;

export interface EngineHostConfig {
  nativeModulePath?: string;
}

export interface HostIo {
  send(message: unknown): void;
  onMessage(handler: (message: unknown) => void): void;
}

export class EngineHostRuntime {
  private load: NativeLoadResult;
  private buildXml: string | undefined;
  /** Current stats of each open session, kept up to date from the engine's diffs. */
  private readonly stats = new Map<string, Record<string, StatScalar>>();
  private configCatalogCache: unknown;
  private gemCatalogCache: unknown;
  private statMetaCache: unknown;
  /**
   * Each open build's calculation count (`calcRev`): it moves with every edit and every recalculation, and comes back
   * with `getStats` and `recalc` and in a `calcRev` event after a recalculation, so caches can be keyed by it.
   */
  private readonly calcRevs = new Map<string, number>();
  /** Builds a window shows: never closed for room. */
  private readonly kept = new Set<string>();
  /** The player's open build; a newer one takes its place and this one may then be closed for room. */
  private openBuild: string | undefined;

  constructor(
    private readonly io: HostIo,
    config: EngineHostConfig,
  ) {
    this.load = loadNativeEngine(config.nativeModulePath);
    io.onMessage((message) => this.handleMessage(message));
    // The item lists are built on a thread of their own now, so the Items tab does not wait a second for them later.
    if (this.load.ok) this.load.engine.itemCatalogPrewarm?.();
  }

  status(): EngineStatus {
    if (this.load.ok) {
      return { state: 'ready', engineVersion: this.load.engine.version };
    }
    return { state: 'unavailable', reason: this.load.reason };
  }

  announceStatus(): void {
    this.io.send({ type: 'status', status: this.status() });
  }

  private handleMessage(message: unknown): void {
    if (!message || typeof message !== 'object') return;
    const msg = message as { kind?: string };
    if (msg.kind === 'control') {
      this.handleControl(message as HostControlMessage);
    } else if (msg.kind === 'engine-request') {
      this.handleEngineRequest((message as { kind: 'engine-request'; request: EngineRequest }).request);
    }
  }

  private handleControl(message: HostControlMessage): void {
    const reply = (response: HostControlResponse) => this.io.send({ kind: 'control-response', response });
    switch (message.type) {
      case 'loadBuildState': {
        this.buildXml = message.state.buildXml;
        reply({ type: 'loadBuildStateAck', ok: true });
        return;
      }
      case 'recalculate': {
        if (!this.load.ok) {
          reply({ type: 'recalculateResult', ok: false, error: this.load.reason });
          return;
        }
        if (this.buildXml === undefined) {
          reply({ type: 'recalculateResult', ok: false, error: 'no build loaded' });
          return;
        }
        try {
          this.load.engine.recalculate(this.buildXml);
          reply({ type: 'recalculateResult', ok: true });
        } catch (err) {
          reply({ type: 'recalculateResult', ok: false, error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
      case 'ping': {
        reply({ type: 'pong' });
        return;
      }
    }
  }

  /** A build the engine no longer has: its caches elsewhere (the Items tab's ranking) can go. */
  private closed(buildId: string): void {
    this.calcRevs.delete(buildId);
    this.kept.delete(buildId);
    if (this.openBuild === buildId) this.openBuild = undefined;
    this.io.send({ type: 'sessionClosed', buildId });
  }

  private handleEngineRequest(request: EngineRequest): void {
    if (!this.load.ok) {
      const response: EngineResponse = {
        id: request.id,
        command: request.command,
        ok: false,
        error: { message: `engine not available: ${this.load.reason}`, code: 'ENGINE_UNAVAILABLE' },
      };
      this.io.send({ kind: 'engine-response', response });
      return;
    }
    const engine = this.load.engine;
    // A build that is being used is the last to be closed.
    const used = (request.params as { buildId?: string } | undefined)?.buildId;
    if (used && this.stats.has(used)) {
      const kept = this.stats.get(used)!;
      this.stats.delete(used);
      this.stats.set(used, kept);
    }
    if (used && MUTATING_COMMANDS.has(request.command)) this.calcRevs.set(used, (this.calcRevs.get(used) ?? 0) + 1);
    const send = (response: EngineResponse) => this.io.send({ kind: 'engine-response', response });
    const fail = (code: string, message: string) =>
      send({ id: request.id, command: request.command, ok: false, error: { message, code } } as EngineResponse);
    try {
      switch (request.command) {
        case 'loadBuild': {
          if (!engine.loadBuild) return fail('NOT_IMPLEMENTED', 'this engine has no session support');
          const { buildXml, keep } = request.params as CommandParams<'loadBuild'>;
          const loaded = JSON.parse(engine.loadBuild(partyToEngine(buildXml))) as { buildId: string; stats: Record<string, StatScalar> };
          this.stats.set(loaded.buildId, loaded.stats);
          // Only the newest few builds stay open in the engine; drafts and scratch copies make room, oldest first.
          const evictable = () => [...this.stats.keys()].find((id) => id !== loaded.buildId && id !== this.openBuild && !this.kept.has(id));
          while (this.stats.size > MAX_OPEN_BUILDS) {
            const oldest = evictable();
            const victim = oldest ?? loaded.buildId;
            this.stats.delete(victim);
            engine.closeBuild?.(victim);
            this.closed(victim);
            if (!oldest) {
              return fail('TOO_MANY_BUILDS', `the engine already holds ${MAX_OPEN_BUILDS} builds that are in use (the open build and the ones Compare shows); close a compared build and try again`);
            }
          }
          if (keep === 'open') this.openBuild = loaded.buildId;
          else if (keep === 'shown') this.kept.add(loaded.buildId);
          return send({ id: request.id, command: 'loadBuild', ok: true, result: { buildId: loaded.buildId } } as EngineResponse);
        }
        case 'getStats': {
          const { buildId } = request.params as CommandParams<'getStats'>;
          const stats = this.stats.get(buildId);
          if (!stats) return fail('UNKNOWN_BUILD', `unknown build id ${buildId}`);
          const list: StatValue[] = Object.entries(stats).map(([id, value]) => ({ id, label: id, value }));
          return send({ id: request.id, command: 'getStats', ok: true, result: { stats: list, calcRev: this.calcRevs.get(buildId) ?? 0 } } as EngineResponse);
        }
        case 'toggleNode': {
          if (!engine.toggleNode || !engine.finish) return fail('NOT_IMPLEMENTED', 'this engine has no session support');
          const { buildId, nodeId } = request.params as CommandParams<'toggleNode'>;
          const started = performance.now();
          const first = JSON.parse(engine.toggleNode(buildId, nodeId)) as SessionDiff;
          const engineMs = performance.now() - started;
          // engineMs: time inside the engine call, for measuring what the process hops add.
          send({ id: request.id, command: 'toggleNode', ok: true, result: { statDiff: this.applyDiff(buildId, first), engineMs } } as EngineResponse);
          if (!first.complete) {
            // The FullDPS rows run after the reply is on its way, so the click's own stats aren't held up by them.
            setImmediate(() => {
              try {
                const rest = engine.finish?.(buildId);
                if (rest) this.io.send({ type: 'statDiff', statDiff: this.applyDiff(buildId, JSON.parse(rest) as SessionDiff) });
              } catch {
                // A failed FullDPS pass leaves the previous FullDPS values in place; the click itself already succeeded.
              }
            });
          }
          return;
        }
        case 'previewNode': {
          if (!engine.previewNode) return fail('NOT_IMPLEMENTED', 'this engine has no session support');
          const { buildId, nodeId } = request.params as CommandParams<'previewNode'>;
          const preview = JSON.parse(engine.previewNode(buildId, nodeId)) as SessionDiff;
          const changed: StatDelta[] = preview.changed.map(([statId, before, after]) => ({ statId, label: statId, before, after }));
          return send({ id: request.id, command: 'previewNode', ok: true, result: { statDiff: { buildId, changed } } } as EngineResponse);
        }
        case 'edit':
        case 'undo':
        case 'redo': {
          if (!engine.edit || !engine.undo || !engine.redo || !engine.finish) return fail('NOT_IMPLEMENTED', 'this engine has no edit support');
          const { buildId } = request.params as { buildId: string };
          let text: string | null;
          if (request.command === 'edit') {
            const { edit } = request.params as CommandParams<'edit'>;
            if (edit.kind === 'addNodes' || edit.kind === 'removeNodes') return fail('BAD_EDIT', `${edit.kind} only previews; it changes no build text`);
            text = engine.edit(buildId, this.editJson(engine, buildId, edit));
          } else {
            text = request.command === 'undo' ? engine.undo(buildId) : engine.redo(buildId);
          }
          const first = text ? (JSON.parse(text) as SessionDiff & { blocked?: ClickBlocked; blockedClass?: number }) : null;
          if (first?.blocked) {
            send({ id: request.id, command: 'edit', ok: true, result: { statDiff: { buildId, changed: [] }, blocked: first.blocked, ...(first.blockedClass !== undefined ? { blockedClass: first.blockedClass } : {}) } } as EngineResponse);
            return;
          }
          const statDiff = first ? this.applyDiff(buildId, first) : null;
          send({ id: request.id, command: request.command, ok: true, result: { statDiff: request.command === 'edit' ? statDiff ?? { buildId, changed: [] } : statDiff, ...(request.command === 'edit' ? { fullDpsPending: !!first && !first.complete } : {}) } } as EngineResponse);
          this.afterReply(buildId, first ? !first.complete : false);
          return;
        }
        case 'previewEdit': {
          if (!engine.previewEdit) return fail('NOT_IMPLEMENTED', 'this engine has no edit support');
          const { buildId, edit, full } = request.params as CommandParams<'previewEdit'>;
          if (edit.kind === 'addNodes' && !engine.previewAddNodes) return fail('NOT_IMPLEMENTED', 'this engine cannot count extra nodes');
          if (edit.kind === 'removeNodes' && !engine.previewRemoveNodes) return fail('NOT_IMPLEMENTED', 'this engine cannot take nodes out for one calculation');
          return send({ id: request.id, command: 'previewEdit', ok: true, result: this.previewOne(engine, buildId, edit, full) } as EngineResponse);
        }
        case 'previewEdits': {
          if (!engine.previewEdit) return fail('NOT_IMPLEMENTED', 'this engine has no edit support');
          const { buildId, edits, full } = request.params as CommandParams<'previewEdits'>;
          const results = edits.map((edit) => {
            try {
              return this.previewOne(engine, buildId, edit, full);
            } catch (e) {
              return { error: e instanceof Error ? e.message : String(e) };
            }
          });
          return send({ id: request.id, command: 'previewEdits', ok: true, result: { results } } as EngineResponse);
        }
        case 'history': {
          if (!engine.history) return fail('NOT_IMPLEMENTED', 'this engine has no edit support');
          const { buildId } = request.params as CommandParams<'history'>;
          return send({ id: request.id, command: 'history', ok: true, result: JSON.parse(engine.history(buildId)) } as EngineResponse);
        }
        case 'treeState': {
          if (!engine.treeState) return fail('NOT_IMPLEMENTED', 'this engine has no tree state');
          const { buildId } = request.params as CommandParams<'treeState'>;
          return send({ id: request.id, command: 'treeState', ok: true, result: { tree: JSON.parse(engine.treeState(buildId)) as TreeState } } as EngineResponse);
        }
        case 'calcs': {
          if (!engine.calcs) return fail('NOT_IMPLEMENTED', 'this engine has no calcs export');
          const { buildId, buffMode } = request.params as CommandParams<'calcs'>;
          return send({ id: request.id, command: 'calcs', ok: true, result: { sections: JSON.parse(engine.calcs(buildId, buffMode ?? null)) } } as EngineResponse);
        }
        case 'calcsView': {
          if (!engine.calcsView) return fail('NOT_IMPLEMENTED', 'this engine has no calcs view export');
          const { buildId, collapsed } = request.params as CommandParams<'calcsView'>;
          return send({ id: request.id, command: 'calcsView', ok: true, result: JSON.parse(engine.calcsView(buildId, collapsed ? JSON.stringify(collapsed) : undefined)) } as EngineResponse);
        }
        case 'fightSim': {
          if (!engine.fightSim) return fail('NOT_IMPLEMENTED', 'this engine has no fight simulator');
          const { buildId, options } = request.params as CommandParams<'fightSim'>;
          return send({ id: request.id, command: 'fightSim', ok: true, result: JSON.parse(engine.fightSim(buildId, JSON.stringify(options))) } as EngineResponse);
        }
        case 'spectreCatalog': {
          if (!engine.spectreCatalog) return fail('NOT_IMPLEMENTED', 'this engine has no spectre catalog');
          return send({ id: request.id, command: 'spectreCatalog', ok: true, result: { spectres: JSON.parse(engine.spectreCatalog()) } } as EngineResponse);
        }
        case 'calcsMods': {
          if (!engine.calcsMods) return fail('NOT_IMPLEMENTED', 'this engine has no calcs mods export');
          const { buildId, detail } = request.params as CommandParams<'calcsMods'>;
          return send({ id: request.id, command: 'calcsMods', ok: true, result: { table: JSON.parse(engine.calcsMods(buildId, JSON.stringify(detail))) } } as EngineResponse);
        }
        case 'nodePowerStart': {
          if (!engine.nodePowerStart) return fail('NOT_IMPLEMENTED', 'this engine has no node power');
          const { buildId, maxDepth, stat } = request.params as CommandParams<'nodePowerStart'>;
          return send({ id: request.id, command: 'nodePowerStart', ok: true, result: { total: engine.nodePowerStart(buildId, maxDepth, stat) } } as EngineResponse);
        }
        case 'nodePowerStep': {
          if (!engine.nodePowerStep) return fail('NOT_IMPLEMENTED', 'this engine has no node power');
          const { buildId, budgetMs } = request.params as CommandParams<'nodePowerStep'>;
          return send({ id: request.id, command: 'nodePowerStep', ok: true, result: JSON.parse(engine.nodePowerStep(buildId, budgetMs)) } as EngineResponse);
        }
        case 'optimizeStart': {
          if (!engine.optimizeStart) return fail('NOT_IMPLEMENTED', 'this engine has no optimizer');
          const { buildId, objective } = request.params as CommandParams<'optimizeStart'>;
          return send({ id: request.id, command: 'optimizeStart', ok: true, result: JSON.parse(engine.optimizeStart(buildId, objective)) } as EngineResponse);
        }
        case 'optimizeStep': {
          if (!engine.optimizeStep) return fail('NOT_IMPLEMENTED', 'this engine has no optimizer');
          const { buildId, budgetMs } = request.params as CommandParams<'optimizeStep'>;
          return send({ id: request.id, command: 'optimizeStep', ok: true, result: JSON.parse(engine.optimizeStep(buildId, budgetMs)) } as EngineResponse);
        }
        case 'pathSolve': {
          if (!engine.pathSolve) return fail('NOT_IMPLEMENTED', 'this engine has no smart pathing');
          const { buildId, wanted, avoided } = request.params as CommandParams<'pathSolve'>;
          return send({ id: request.id, command: 'pathSolve', ok: true, result: JSON.parse(engine.pathSolve(buildId, wanted, avoided)) } as EngineResponse);
        }
        case 'timelessStatus': {
          if (!engine.timelessStatus) return fail('NOT_IMPLEMENTED', 'this engine has no timeless jewel search');
          return send({ id: request.id, command: 'timelessStatus', ok: true, result: JSON.parse(engine.timelessStatus()) } as EngineResponse);
        }
        case 'timelessSetDataDir': {
          if (!engine.timelessSetDataDir) return fail('NOT_IMPLEMENTED', 'this engine has no timeless jewel search');
          engine.timelessSetDataDir((request.params as CommandParams<'timelessSetDataDir'>).dir);
          return send({ id: request.id, command: 'timelessSetDataDir', ok: true, result: {} } as EngineResponse);
        }
        case 'timelessInfo': {
          if (!engine.timelessInfo) return fail('NOT_IMPLEMENTED', 'this engine has no timeless jewel search');
          const { buildId } = request.params as CommandParams<'timelessInfo'>;
          return send({ id: request.id, command: 'timelessInfo', ok: true, result: JSON.parse(engine.timelessInfo(buildId)) } as EngineResponse);
        }
        case 'timelessMods': {
          if (!engine.timelessMods) return fail('NOT_IMPLEMENTED', 'this engine has no timeless jewel search');
          const { buildId, jewelType } = request.params as CommandParams<'timelessMods'>;
          return send({ id: request.id, command: 'timelessMods', ok: true, result: { mods: JSON.parse(engine.timelessMods(buildId, jewelType)) } } as EngineResponse);
        }
        case 'timelessStart': {
          if (!engine.timelessStart) return fail('NOT_IMPLEMENTED', 'this engine has no timeless jewel search');
          const { buildId, search } = request.params as CommandParams<'timelessStart'>;
          return send({ id: request.id, command: 'timelessStart', ok: true, result: JSON.parse(engine.timelessStart(buildId, JSON.stringify(search))) } as EngineResponse);
        }
        case 'timelessStep': {
          if (!engine.timelessStep) return fail('NOT_IMPLEMENTED', 'this engine has no timeless jewel search');
          const { buildId, budgetMs } = request.params as CommandParams<'timelessStep'>;
          return send({ id: request.id, command: 'timelessStep', ok: true, result: JSON.parse(engine.timelessStep(buildId, budgetMs)) } as EngineResponse);
        }
        case 'timelessRows': {
          if (!engine.timelessRows) return fail('NOT_IMPLEMENTED', 'this engine has no timeless jewel search');
          const { buildId, from, count } = request.params as CommandParams<'timelessRows'>;
          return send({ id: request.id, command: 'timelessRows', ok: true, result: JSON.parse(engine.timelessRows(buildId, from, count)) } as EngineResponse);
        }
        case 'timelessFallback': {
          if (!engine.timelessFallback) return fail('NOT_IMPLEMENTED', 'this engine has no timeless jewel search');
          const { buildId, jewelType, stat } = request.params as CommandParams<'timelessFallback'>;
          return send({ id: request.id, command: 'timelessFallback', ok: true, result: JSON.parse(engine.timelessFallback(buildId, jewelType, stat)) } as EngineResponse);
        }
        case 'recalc': {
          if (!engine.recalc) return fail('NOT_IMPLEMENTED', 'this engine cannot recalculate a build');
          const { buildId } = request.params as CommandParams<'recalc'>;
          const d = JSON.parse(engine.recalc(buildId)) as SessionDiff;
          const calcRev = (this.calcRevs.get(buildId) ?? 0) + 1;
          this.calcRevs.set(buildId, calcRev);
          this.io.send({ type: 'calcRev', buildId, calcRev });
          return send({ id: request.id, command: 'recalc', ok: true, result: { statDiff: this.applyDiff(buildId, d), calcRev } } as EngineResponse);
        }
        case 'timelessCancel': {
          const { buildId } = request.params as CommandParams<'timelessCancel'>;
          engine.timelessCancel?.(buildId);
          return send({ id: request.id, command: 'timelessCancel', ok: true, result: {} } as EngineResponse);
        }
        case 'solveStart': {
          if (!engine.solveStart) return fail('NOT_IMPLEMENTED', 'this engine has no build solver');
          const { buildId, goal, options } = request.params as CommandParams<'solveStart'>;
          return send({ id: request.id, command: 'solveStart', ok: true, result: JSON.parse(engine.solveStart(buildId, JSON.stringify(goal), options ? JSON.stringify(options) : undefined)) } as EngineResponse);
        }
        case 'solveStep': {
          if (!engine.solveStep) return fail('NOT_IMPLEMENTED', 'this engine has no build solver');
          const { solveId, budgetMs } = request.params as CommandParams<'solveStep'>;
          return send({ id: request.id, command: 'solveStep', ok: true, result: JSON.parse(engine.solveStep(solveId, budgetMs)) } as EngineResponse);
        }
        case 'solveCancel': {
          const { solveId } = request.params as CommandParams<'solveCancel'>;
          engine.solveCancel?.(solveId);
          return send({ id: request.id, command: 'solveCancel', ok: true, result: {} } as EngineResponse);
        }
        case 'solveAddLeads': {
          if (!engine.solveAddLeads) return fail('NOT_IMPLEMENTED', 'this engine cannot add leads to a running solve');
          const { solveId, leads } = request.params as CommandParams<'solveAddLeads'>;
          return send({ id: request.id, command: 'solveAddLeads', ok: true, result: JSON.parse(engine.solveAddLeads(solveId, JSON.stringify(leads))) } as EngineResponse);
        }
        case 'solveResult': {
          if (!engine.solveResult) return fail('NOT_IMPLEMENTED', 'this engine has no build solver');
          const { solveId, index, id } = request.params as CommandParams<'solveResult'>;
          if (id !== undefined) {
            if (!engine.solveResultById) return fail('NOT_IMPLEMENTED', 'this engine cannot fetch a solve result by id');
            return send({ id: request.id, command: 'solveResult', ok: true, result: JSON.parse(engine.solveResultById(solveId, id)) } as EngineResponse);
          }
          return send({ id: request.id, command: 'solveResult', ok: true, result: JSON.parse(engine.solveResult(solveId, index ?? 0)) } as EngineResponse);
        }
        case 'optimizeCancel': {
          const { buildId } = request.params as CommandParams<'optimizeCancel'>;
          engine.optimizeCancel?.(buildId);
          return send({ id: request.id, command: 'optimizeCancel', ok: true, result: {} } as EngineResponse);
        }
        case 'exportedBuffs': {
          if (!engine.exportedBuffs) return fail('NOT_IMPLEMENTED', 'this engine has no export support');
          const { buildId } = request.params as CommandParams<'exportedBuffs'>;
          return send({ id: request.id, command: 'exportedBuffs', ok: true, result: { blocks: JSON.parse(engine.exportedBuffs(buildId)) } } as EngineResponse);
        }
        case 'mainSkill': {
          if (!engine.mainSkill) return fail('NOT_IMPLEMENTED', 'this engine has no main skill export');
          const { buildId } = request.params as CommandParams<'mainSkill'>;
          return send({ id: request.id, command: 'mainSkill', ok: true, result: JSON.parse(engine.mainSkill(buildId)) } as EngineResponse);
        }
        case 'getBuildXml': {
          if (!engine.buildXml) return fail('NOT_IMPLEMENTED', 'this engine has no session support');
          const { buildId } = request.params as CommandParams<'getBuildXml'>;
          return send({ id: request.id, command: 'getBuildXml', ok: true, result: { buildXml: partyFromEngine(engine.buildXml(buildId)) } } as EngineResponse);
        }
        case 'configCatalog': {
          if (!engine.configCatalog) return fail('NOT_IMPLEMENTED', 'this engine has no configuration data');
          // Static for the engine's lifetime: parsed once, then the same object is sent again.
          this.configCatalogCache ??= JSON.parse(engine.configCatalog());
          return send({ id: request.id, command: 'configCatalog', ok: true, result: { catalog: this.configCatalogCache } } as EngineResponse);
        }
        case 'configState': {
          if (!engine.configState) return fail('NOT_IMPLEMENTED', 'this engine has no configuration data');
          const { buildId } = request.params as CommandParams<'configState'>;
          return send({ id: request.id, command: 'configState', ok: true, result: { state: JSON.parse(engine.configState(buildId)) } } as EngineResponse);
        }
        case 'configMods': {
          if (!engine.configMods) return fail('NOT_IMPLEMENTED', 'this engine has no mod browser data');
          const { buildId } = request.params as CommandParams<'configMods'>;
          // The tree version rarely changes between calls; the engine keeps the parsed tree, the list is rebuilt per call.
          return send({ id: request.id, command: 'configMods', ok: true, result: JSON.parse(engine.configMods(buildId)) } as EngineResponse);
        }
        case 'gemCatalog': {
          if (!engine.gemCatalog) return fail('NOT_IMPLEMENTED', 'this engine has no gem data');
          this.gemCatalogCache ??= JSON.parse(engine.gemCatalog());
          return send({ id: request.id, command: 'gemCatalog', ok: true, result: { gems: this.gemCatalogCache } } as EngineResponse);
        }
        case 'statMeta': {
          if (!engine.statMeta) return fail('NOT_IMPLEMENTED', 'this engine has no stat metadata');
          this.statMetaCache ??= JSON.parse(engine.statMeta());
          return send({ id: request.id, command: 'statMeta', ok: true, result: { stats: this.statMetaCache } } as EngineResponse);
        }
        case 'gemPower': {
          if (!engine.gemPower) return fail('NOT_IMPLEMENTED', 'this engine has no gem power');
          const { buildId, group, field, gemIds, gem } = request.params as CommandParams<'gemPower'>;
          const r = JSON.parse(engine.gemPower(buildId, group, field, JSON.stringify(gemIds), gem ?? 0));
          return send({ id: request.id, command: 'gemPower', ok: true, result: r } as EngineResponse);
        }
        case 'skillsState': {
          if (!engine.skillsState) return fail('NOT_IMPLEMENTED', 'this engine has no skills data');
          const { buildId } = request.params as CommandParams<'skillsState'>;
          return send({ id: request.id, command: 'skillsState', ok: true, result: { state: JSON.parse(engine.skillsState(buildId)) } } as EngineResponse);
        }
        case 'itemInfo': {
          if (!engine.itemInfo) return fail('NOT_IMPLEMENTED', 'this engine has no item support');
          const p = request.params as CommandParams<'itemInfo'>;
          const options = JSON.stringify({ dbMode: p.dbMode, slotNum: p.slotNum, sanitise: p.sanitise });
          return send({ id: request.id, command: 'itemInfo', ok: true, result: { item: JSON.parse(engine.itemInfo(p.buildId ?? null, p.itemText, options)) } } as EngineResponse);
        }
        case 'itemsInfo': {
          if (!engine.itemsInfo) return fail('NOT_IMPLEMENTED', 'this engine has no item support');
          const p = request.params as CommandParams<'itemsInfo'> & { background?: boolean };
          // The background ranking's reads run on the engine's workers; this thread goes on with other calls meanwhile.
          if (p.background && engine.itemsInfoBackground) {
            engine.itemsInfoBackground(p.buildId ?? null, JSON.stringify(p.texts)).then(
              (t) => send({ id: request.id, command: 'itemsInfo', ok: true, result: { items: JSON.parse(t) } } as EngineResponse),
              (e: Error) => fail('ENGINE_ERROR', e.message),
            );
            return;
          }
          return send({ id: request.id, command: 'itemsInfo', ok: true, result: { items: JSON.parse(engine.itemsInfo(p.buildId ?? null, JSON.stringify(p.texts))) } } as EngineResponse);
        }
        case 'itemCatalog': {
          if (!engine.itemCatalog) return fail('NOT_IMPLEMENTED', 'this engine has no item support');
          return send({ id: request.id, command: 'itemCatalog', ok: true, result: { catalog: JSON.parse(engine.itemCatalog()) } } as EngineResponse);
        }
        case 'itemCraft': {
          if (!engine.itemCraft) return fail('NOT_IMPLEMENTED', 'this engine has no item support');
          const p = request.params as CommandParams<'itemCraft'>;
          return send({ id: request.id, command: 'itemCraft', ok: true, result: { text: engine.itemCraft(p.base, p.rarity, p.title ?? null) } } as EngineResponse);
        }
        case 'itemPool': {
          if (!engine.itemPool) return fail('NOT_IMPLEMENTED', 'this engine has no item support');
          const p = request.params as CommandParams<'itemPool'>;
          return send({ id: request.id, command: 'itemPool', ok: true, result: { pool: JSON.parse(engine.itemPool(p.itemText, p.kind)) } } as EngineResponse);
        }
        case 'modPool': {
          if (!engine.modPool) return fail('NOT_IMPLEMENTED', 'this engine has no mod pools');
          const p = request.params as CommandParams<'modPool'>;
          const options = JSON.stringify({ influences: p.influences ?? [], extraTags: p.extraTags ?? [] });
          return send({ id: request.id, command: 'modPool', ok: true, result: { pool: JSON.parse(engine.modPool(p.base, p.itemLevel, options)) } } as EngineResponse);
        }
        case 'resolveImportedClusters': {
          if (!engine.resolveImportedClusters) return fail('NOT_IMPLEMENTED', 'this engine cannot resolve imported cluster jewels');
          const p = request.params as CommandParams<'resolveImportedClusters'>;
          return send({ id: request.id, command: 'resolveImportedClusters', ok: true, result: JSON.parse(engine.resolveImportedClusters(p.xml, JSON.stringify(p.hashesEx), JSON.stringify(p.jewelData))) } as EngineResponse);
        }
        case 'itemNormalise': {
          if (!engine.itemNormalise) return fail('NOT_IMPLEMENTED', 'this engine has no item support');
          const p = request.params as CommandParams<'itemNormalise'>;
          return send({ id: request.id, command: 'itemNormalise', ok: true, result: { text: engine.itemNormalise(p.itemText) } } as EngineResponse);
        }
        case 'itemAffix': {
          if (!engine.itemAffix) return fail('NOT_IMPLEMENTED', 'this engine has no item support');
          const p = request.params as CommandParams<'itemAffix'>;
          return send({ id: request.id, command: 'itemAffix', ok: true, result: { text: engine.itemAffix(p.itemText, JSON.stringify(p.choice)) } } as EngineResponse);
        }
        case 'powerStats': {
          if (!engine.powerStats) return fail('NOT_IMPLEMENTED', 'this engine has no item support');
          return send({ id: request.id, command: 'powerStats', ok: true, result: { stats: JSON.parse(engine.powerStats()) } } as EngineResponse);
        }
        case 'itemRank': {
          if (!engine.itemRank) return fail('NOT_IMPLEMENTED', 'this engine has no item support');
          const p = request.params as CommandParams<'itemRank'> & { background?: boolean };
          if (p.background && engine.itemRankBackground) {
            engine.itemRankBackground(p.buildId, p.stat, JSON.stringify(p.candidates)).then(
              (t) => send({ id: request.id, command: 'itemRank', ok: true, result: { values: JSON.parse(t) } } as EngineResponse),
              (e: Error) => fail('ENGINE_ERROR', e.message),
            );
            return;
          }
          return send({ id: request.id, command: 'itemRank', ok: true, result: { values: JSON.parse(engine.itemRank(p.buildId, p.stat, JSON.stringify(p.candidates))) } } as EngineResponse);
        }
        case 'itemFlask': {
          if (!engine.itemFlask) return fail('NOT_IMPLEMENTED', 'this engine has no flask support');
          const p = request.params as CommandParams<'itemFlask'>;
          return send({ id: request.id, command: 'itemFlask', ok: true, result: { lines: JSON.parse(engine.itemFlask(p.buildId, p.itemText)) } } as EngineResponse);
        }
        case 'buildFlags': {
          if (!engine.buildFlags) return fail('NOT_IMPLEMENTED', 'this engine has no flag support');
          const p = request.params as CommandParams<'buildFlags'>;
          return send({ id: request.id, command: 'buildFlags', ok: true, result: { flags: JSON.parse(engine.buildFlags(p.buildId, JSON.stringify(p.names))) } } as EngineResponse);
        }
        case 'gemTip': {
          if (!engine.gemTip) return fail('NOT_IMPLEMENTED', 'this engine has no skill tooltips');
          const p = request.params as CommandParams<'gemTip'>;
          return send({ id: request.id, command: 'gemTip', ok: true, result: { tip: JSON.parse(engine.gemTip(p.buildId ?? null, p.skillId, p.level)) } } as EngineResponse);
        }
        case 'getBreakdowns': {
          if (!engine.breakdowns) return fail('NOT_IMPLEMENTED', 'this engine has no breakdown support');
          const { buildId, buffMode } = request.params as CommandParams<'getBreakdowns'>;
          return send({ id: request.id, command: 'getBreakdowns', ok: true, result: { breakdowns: JSON.parse(engine.breakdowns(buildId, buffMode ?? null)) } } as EngineResponse);
        }
        case 'closeBuild': {
          const { buildId } = request.params as CommandParams<'closeBuild'>;
          engine.closeBuild?.(buildId);
          this.stats.delete(buildId);
          this.closed(buildId);
          return send({ id: request.id, command: 'closeBuild', ok: true, result: {} } as EngineResponse);
        }
        default:
          return fail('NOT_IMPLEMENTED', `command ${request.command} is not implemented for the native engine yet`);
      }
    } catch (err) {
      return fail('ENGINE_ERROR', err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * After a reply is on its way: the FullDPS rows the edit left (sent as a `statDiff` event), then freeing the
   * finished calcs and building what the next click needs, so none of that holds up the edit's own stats.
   */
  private afterReply(buildId: string, pendingFullDps: boolean): void {
    const engine = this.load.ok ? this.load.engine : undefined;
    if (!engine) return;
    setImmediate(() => {
      try {
        if (pendingFullDps) {
          const rest = engine.finish?.(buildId);
          if (rest) this.io.send({ type: 'statDiff', statDiff: this.applyDiff(buildId, JSON.parse(rest) as SessionDiff) });
        }
      } catch {
        // A failed FullDPS pass leaves the previous FullDPS values in place; the edit itself already succeeded.
      }
      try {
        engine.collect?.(buildId);
        engine.prepare?.(buildId);
      } catch {
        // Only a speed-up for the next click.
      }
    });
  }

  /** One `previewEdit` result: the stats the edit would change (with the FullDPS rows when `full`), nothing changed. */
  private previewOne(engine: NativeEngineModule, buildId: string, edit: BuildEdit, full?: boolean) {
    let preview: SessionDiff & { blocked?: ClickBlocked; blockedClass?: number };
    if (edit.kind === 'addNodes') {
      preview = JSON.parse(engine.previewAddNodes!(buildId, JSON.stringify(edit.xml ? { nodes: edit.nodeIds, xml: edit.xml } : edit.nodeIds))) as SessionDiff;
    } else if (edit.kind === 'removeNodes') {
      preview = JSON.parse(engine.previewRemoveNodes!(buildId, JSON.stringify(edit.nodeIds))) as SessionDiff;
    } else {
      preview = JSON.parse(engine.previewEdit!(buildId, this.editJson(engine, buildId, edit))) as SessionDiff & { blocked?: ClickBlocked; blockedClass?: number };
    }
    let changed: StatDelta[] = (preview.changed ?? []).map(([statId, before, after]) => ({ statId, label: statId, before, after }));
    if (full && !preview.blocked && preview.complete === false && engine.finishPreview) {
      // The FullDPS rows the preview left out, merged over the preview's own changes.
      const rest = engine.finishPreview(buildId);
      if (rest) {
        const more = (JSON.parse(rest) as SessionDiff).changed.map(([statId, before, after]): StatDelta => ({ statId, label: statId, before, after }));
        const ids = new Set(more.map((c) => c.statId));
        changed = [...changed.filter((c) => !ids.has(c.statId)), ...more];
      }
    }
    return { statDiff: { buildId, changed }, ...(preview.blocked ? { blocked: preview.blocked } : {}), ...(preview.blockedClass !== undefined ? { blockedClass: preview.blockedClass } : {}) };
  }

  /** The edit as the engine takes it: a party or config-set edit becomes the build text with that part replaced. */
  private editJson(engine: { buildXml?(id: string): string }, buildId: string, edit: BuildEdit): string {
    if (edit.kind === 'setParty') {
      if (!engine.buildXml) throw new Error('this engine has no session support');
      return JSON.stringify({ kind: 'setXml', xml: writeParty(engine.buildXml(buildId), partyFromState(edit.party)) });
    }
    if (isHostEdit(edit)) {
      if (!engine.buildXml) throw new Error('this engine has no session support');
      // `amend` (a follow-up to the user's own edit) is kept, so one Ctrl Z takes back both.
      return JSON.stringify({ kind: 'setXml', xml: applyHostEdit(engine.buildXml(buildId), edit), ...((edit as { amend?: boolean }).amend ? { amend: true } : {}) });
    }
    if (edit.kind === 'setConfigs') {
      if (!engine.buildXml) throw new Error('this engine has no session support');
      return JSON.stringify({ kind: 'setXml', xml: setConfigInputs(engine.buildXml(buildId), edit.values) });
    }
    // Text that comes from a tab is in the file's form; the engine gets party effects that are off as it reads them.
    if ('xml' in edit && typeof edit.xml === 'string') return JSON.stringify({ ...edit, xml: partyToEngine(edit.xml) });
    return JSON.stringify(edit);
  }

  /** Applies an engine diff to the kept stats and turns it into the protocol's StatDiff. */
  private applyDiff(buildId: string, diff: SessionDiff): StatDiff {
    const stats = this.stats.get(buildId) ?? {};
    const changed: StatDelta[] = diff.changed.map(([statId, before, after]) => {
      if (after === null) delete stats[statId];
      else stats[statId] = after;
      return { statId, label: statId, before, after };
    });
    this.stats.set(buildId, stats);
    return { buildId, changed };
  }
}

/** A crates/napi diff: `[statId, before, after]` per changed stat. */
interface SessionDiff {
  changed: Array<[string, StatScalar, StatScalar]>;
  complete: boolean;
}

/**
 * Electron's `utilityProcess.fork()` gives the child `process.parentPort`
 * (postMessage/on('message'), messages arriving as `{ data }`); a plain
 * `child_process.fork()` (used only by the fake-engine test fixtures) gives
 * the classic `process.send`/`process.on('message')` pair with the raw
 * payload. Support both so this same entry point can run for real under
 * Electron without the fixtures needing Electron installed.
 */
function bootstrapIo(): HostIo | undefined {
  const parentPort = (process as unknown as { parentPort?: NodeJS.EventEmitter & { postMessage(m: unknown): void } })
    .parentPort;
  if (parentPort) {
    return {
      send: (message) => parentPort.postMessage(message),
      onMessage: (handler) => parentPort.on('message', (event: { data: unknown }) => handler(event.data)),
    };
  }
  if (typeof process.send === 'function') {
    return {
      send: (message) => process.send?.(message),
      onMessage: (handler) => process.on('message', handler),
    };
  }
  return undefined;
}

const io = bootstrapIo();
if (io) {
  const config: EngineHostConfig = {
    nativeModulePath: process.env.POM_NATIVE_ENGINE_PATH,
  };
  const runtime = new EngineHostRuntime(io, config);
  runtime.announceStatus();
}
