import { randomUUID } from 'node:crypto';
import { MUTATING_COMMANDS, type CommandName, type CommandParams, type CommandResult, type EngineEvent, type EngineResponse, type EngineStatus, type StatDiff } from '@pom/protocol';
import type { ProcessHandle } from '../shared/processHandle.js';

/**
 * Work done ahead of the Items tab (`itemRank` or `itemsInfo` with `background: true`, sent by the renderer's
 * pre-ranking). It is not in the protocol's types: only the renderer's pre-ranking and this class know it.
 */
export type BackgroundRank = CommandParams<'itemRank'> & { background?: boolean; epoch?: number };
export const STALE_RANK = 'stale: the build changed';
/** Background ranking goes to the engine this many calculations at a time (one per ranking worker, about 15 ms)... */
export const BG_CHUNK = 8;
/** ...and only once no other engine call has been waiting for this long, so a click's follow-up calls go first too. */
export const BG_GRACE_MS = 40;

interface PendingRequest {
  resolve(result: CommandResult<CommandName>): void;
  reject(error: Error): void;
  /** The engine process it was sent to. */
  process: ProcessHandle;
}

/**
 * Engine events that are not in the protocol's types yet (they go through the same channel): a build's calculation
 * changed without its text changing (`recalc` after the timeless tables are installed), and a build the engine closed
 * (closed, or dropped as the least recently used). `calcRev` counts a build's calculations: it moves with every edit and
 * every recalculation, so a cache keyed by it (not by the build text alone) is never stale.
 */
export type BuildEngineEvent = { type: 'calcRev'; buildId: string; calcRev: number } | { type: 'sessionClosed'; buildId: string };

/**
 * Owns the request/response correlation on top of a raw ProcessHandle so
 * the IPC bridge can just `await connection.send(command, params)` instead
 * of juggling message ids itself. Also fans out unsolicited `status`
 * messages from the engine host as EngineEvents.
 */
export class EngineConnection {
  private readonly pending = new Map<string, PendingRequest>();
  private statusListeners: Array<(event: EngineEvent) => void> = [];
  /** Engine calls other than background ranking still waiting for their answer, and when the last one came back. */
  private fg = 0;
  private fgAt = 0;
  /** Edits sent per build: background ranking for a build stops once this moves (see `rankInBackground`). */
  private readonly edits = new Map<string, number>();
  /** Changes sent and not yet answered, on any build (see `revision`). */
  private writing = 0;
  /** Background pieces waiting for their turn; one runs at a time. */
  private readonly bgWaiting: Array<() => void> = [];
  private bgBusy = false;
  private bgTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private process: ProcessHandle) {
    this.attach(process);
  }

  /** Listens to an engine process; when it exits, what it was asked and never answered fails instead of hanging. */
  private attach(process: ProcessHandle): void {
    process.onMessage((message) => this.handleMessage(message));
    process.onExit(() => {
      for (const [id, p] of this.pending) {
        if (p.process !== process) continue;
        this.pending.delete(id);
        p.reject(new Error('the engine stopped'));
      }
    });
  }

  onEvent(listener: (event: EngineEvent) => void): () => void {
    this.statusListeners.push(listener);
    return () => {
      this.statusListeners = this.statusListeners.filter((l) => l !== listener);
    };
  }

  replaceProcess(process: ProcessHandle): void {
    this.process = process;
    this.attach(process);
  }

  /**
   * Moves whenever the build's text may have changed: every change sent for it, and a new build answered with its id (an
   * engine restart numbers builds from 1 again). Null while any change is still unanswered, so a caller never trusts a
   * reading taken while one is in flight. The scoped AI gate uses it to skip re-reading an unchanged build.
   */
  revision(buildId: string): number | null {
    return this.writing ? null : (this.edits.get(buildId) ?? 0);
  }

  send<K extends CommandName>(command: K, params: CommandParams<K>): Promise<CommandResult<K>> {
    const sent = this.dispatch(command, params);
    if (MUTATING_COMMANDS.has(command) || command === 'recalc') {
      this.writing++;
      sent.then((result) => {
        this.writing--;
        const made = (result as { buildId?: unknown } | undefined)?.buildId;
        if (typeof made === 'string') this.edits.set(made, (this.edits.get(made) ?? 0) + 1);
      }, () => this.writing--);
    }
    return sent;
  }

  private dispatch<K extends CommandName>(command: K, params: CommandParams<K>): Promise<CommandResult<K>> {
    const buildId = (params as { buildId?: string } | undefined)?.buildId;
    // A recalculation changes the numbers too, though not the build text.
    if (buildId && (MUTATING_COMMANDS.has(command) || command === 'recalc')) this.edits.set(buildId, (this.edits.get(buildId) ?? 0) + 1);
    if ((params as { background?: boolean } | undefined)?.background) {
      if (command === 'itemRank') return this.rankInBackground(params as BackgroundRank) as Promise<CommandResult<K>>;
      return this.inTurn(() => this.post(command, params));
    }
    this.fg++;
    const done = () => {
      this.fg--;
      this.fgAt = Date.now();
      this.pump();
    };
    const sent = this.post(command, params);
    sent.then(done, done);
    return sent;
  }

  /**
   * Background ranking: each candidate is split into one calculation per slot (the engine keeps the best of a candidate's
   * slots, so the best of the pieces is the same value) and sent `BG_CHUNK` at a time, each piece only while no other call
   * waits. The engine works a piece out on its own threads (`itemRankBackground`), so a click is answered while one runs;
   * waiting for quiet keeps the cores for the click too (measured: without it a click's worst case was 5-10 ms longer).
   * Once the build is edited the
   * rest is dropped: the values would belong to the new build, not the one asked about.
   */
  private async rankInBackground(p: BackgroundRank): Promise<CommandResult<'itemRank'> & { epoch: number }> {
    const edits = () => this.edits.get(p.buildId) ?? 0;
    const epoch = p.epoch ?? edits();
    const units: Array<{ i: number; c: BackgroundRank['candidates'][number] }> = [];
    p.candidates.forEach((c, i) => {
      // A flask is calculated in one slot only, the first free flask slot.
      if (c.flask || c.base || c.slots.length <= 1) units.push({ i, c });
      else for (const slot of c.slots) units.push({ i, c: { ...c, slots: [slot] } });
    });
    const values: Array<number | null> = p.candidates.map(() => null);
    for (let k = 0; k < units.length; k += BG_CHUNK) {
      const chunk = units.slice(k, k + BG_CHUNK);
      const r = await this.inTurn(() => {
        if (edits() !== epoch) throw new Error(STALE_RANK);
        return this.post('itemRank', { buildId: p.buildId, stat: p.stat, candidates: chunk.map((u) => u.c) });
      });
      chunk.forEach((u, j) => {
        const v = r.values[j] ?? null;
        const best = values[u.i] ?? null;
        if (v !== null && (best === null || v > best)) values[u.i] = v;
      });
    }
    return { values, epoch };
  }

  /** Runs one background piece once it is its turn (see `pump`). */
  private async inTurn<T>(fn: () => Promise<T>): Promise<T> {
    await new Promise<void>((go) => {
      this.bgWaiting.push(go);
      this.pump();
    });
    try {
      return await fn();
    } finally {
      this.bgBusy = false;
      this.pump();
    }
  }

  /** Lets the next background piece go when nothing else is waiting on the engine. */
  private pump(): void {
    if (this.bgBusy || !this.bgWaiting.length || this.fg > 0) return;
    const wait = this.fgAt + BG_GRACE_MS - Date.now();
    if (wait > 0) {
      this.bgTimer ??= setTimeout(() => {
        this.bgTimer = null;
        this.pump();
      }, wait);
      return;
    }
    this.bgBusy = true;
    this.bgWaiting.shift()!();
  }

  private post<K extends CommandName>(command: K, params: CommandParams<K>): Promise<CommandResult<K>> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as PendingRequest['resolve'], reject, process: this.process });
      this.process.postMessage({ kind: 'engine-request', request: { id, command, params } });
    });
  }

  private handleMessage(message: unknown): void {
    const envelope = message as { kind?: string; response?: EngineResponse; status?: EngineStatus; type?: string };
    if (envelope?.kind === 'engine-response' && envelope.response) {
      const response = envelope.response;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      if (response.ok) {
        pending.resolve(response.result);
      } else {
        pending.reject(new Error(response.error.message));
      }
      return;
    }
    if (envelope?.type === 'status' && envelope.status) {
      this.emit({ type: 'status', status: envelope.status });
    }
    const diffEvent = message as { type?: string; statDiff?: StatDiff };
    if (diffEvent?.type === 'statDiff' && diffEvent.statDiff) {
      this.emit({ type: 'statDiff', statDiff: diffEvent.statDiff });
    }
    const build = message as Partial<BuildEngineEvent>;
    if ((build?.type === 'calcRev' || build?.type === 'sessionClosed') && typeof build.buildId === 'string') {
      this.emit(build as unknown as EngineEvent);
    }
  }

  private emit(event: EngineEvent): void {
    for (const listener of this.statusListeners) listener(event);
  }
}
