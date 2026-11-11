import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isId, leagueStampSchema, observedProgressSchema, type Known, type ValidationLimits } from '@pom/mastery-contracts';
import { LOG_PARSER_VERSION } from '../../shared/journey/logEvent.js';
import { applyAtlasDelta, checkBaseline, emptyObserved, manualBaseline, projectBaseline, unknownBaseline,
  type AtlasRules, type TelemetryState } from '../../shared/journey/telemetry.js';
import { subscribeLog, type LogBatch, type LogCursor, type LogEnvelope, type LogStatus } from './logReader.js';

export type TelemetryOptions = {
  rules: AtlasRules;
  /** A patch-pinned zone catalog join, not a character-level approximation. */
  firstMapAreas?: Known<Readonly<Record<string, string>>>;
  onChange?: (state: TelemetryState) => void;
  /** Main's local transaction must persist state and reader cursor together before resolving. */
  commit?: (state: TelemetryState, cursor: LogCursor | null) => Promise<void>;
};
const same = (a: string | null, b: string) => a?.toLowerCase() === b.toLowerCase();
const time = (at: number) => new Date(at).toISOString();

/** Local observations only. No remote calls, receipt queues or gameplay writes. */
export class JourneyTelemetry {
  private value: TelemetryState;
  private subscription: { stop(): void; ready: Promise<void> } | null = null;
  private readerCursor: LogCursor | null = null;
  private queue: Promise<void> = Promise.resolve();
  private pendingArea: { id: string; evidenceId: string } | null = null;
  private readingEpoch = 0;
  constructor(private readonly options: TelemetryOptions, restored?: { state: TelemetryState; cursor: LogCursor | null }) {
    this.value = restored ? structuredClone(restored.state) : {
      context: { epoch: 0, selected: null, detected: null, state: 'unknown', generationId: null },
      observed: emptyObserved(), baseline: unknownBaseline(options.rules.dataset, 0), cursor: null, retiredGenerationIds: [] };
    this.readerCursor = restored?.cursor ? { ...restored.cursor } : null;
    // A previous process/session's character selection is not evidence of who is playing now.
    if (restored) this.loseContext();
  }
  state(): TelemetryState { return structuredClone(this.value); }
  checkpoint(): LogCursor | null { return this.readerCursor ? { ...this.readerCursor } : null; }
  canFollow(): boolean { return this.value.context.state === 'confirmed'; }
  canFollowAtlas(): boolean { return this.canFollow() && !this.value.baseline.needsChecking && this.value.baseline.count.status === 'known' && this.value.observed.firstMap.status === 'known'; }
  private changed(): void { this.value.observed = projectBaseline(this.value.baseline, this.value.observed); this.options.onChange?.(this.state()); }
  private loseContext(detected: string | null = null): void {
    this.pendingArea = null;
    const context = this.value.context;
    this.value.context = { ...context, epoch: context.epoch + 1, detected, state: detected ? 'changed' : 'unknown' };
    this.value.observed = emptyObserved();
    this.value.baseline = checkBaseline(unknownBaseline(this.options.rules.dataset, this.value.context.epoch), 'Character context needs checking.');
  }
  /** Selecting an old name leaves context Unknown until a fresh matching identity event. */
  selectCharacter(name: string): void {
    if (!name.trim()) throw new Error('Select a character.');
    this.loseContext(); this.value.context.selected = name; this.changed();
  }
  useNextDetectedCharacter(): void {
    this.loseContext(); this.value.context.selected = null; this.value.context.state = 'waiting_next'; this.changed();
  }
  /** Explicit Keep/Switch confirms the currently detected name only; Keep waits for fresh evidence if different. */
  resolveCharacter(choice: 'keep' | 'switch'): void {
    const detected = this.value.context.detected;
    if (choice === 'switch' && !detected) throw new Error('No detected character.');
    const selected = choice === 'switch' ? detected! : this.value.context.selected;
    if (!selected) throw new Error('No selected character.');
    this.loseContext(); this.value.context.selected = selected;
    if (detected && same(selected, detected)) { this.value.context.detected = detected; this.value.context.state = 'confirmed'; }
    this.changed();
  }
  setManualBaseline(count: number, evidenceAt: string): void {
    if (!this.canFollow()) throw new Error('Character not confirmed.');
    this.value.baseline = manualBaseline(this.options.rules.dataset, this.value.context.epoch, count, evidenceAt); this.changed();
  }
  declareAtMaps(anchorId: string, evidenceAt: string): void {
    this.value.observed.firstMap = { status: 'known', value: { anchorId, observedAt: evidenceAt, method: 'manual_declaration' }, evidenceId: `manual:${evidenceAt}` }; this.changed();
  }
  onStatus(status: LogStatus): void {
    if (status.kind !== 'gap' && status.kind !== 'error') return;
    this.loseContext(); this.changed();
  }
  /** Returns whether this event can be used as continuous selected-context live evidence. */
  observe(envelope: LogEnvelope): boolean {
    if (envelope.origin === 'seed' || this.value.retiredGenerationIds.includes(envelope.generationId)) return false;
    if (envelope.parserVersion !== LOG_PARSER_VERSION) { this.onStatus({ kind: 'gap', reason: 'parser_version' }); return false; }
    const previous = this.value.cursor;
    if (previous?.generationId === envelope.generationId && envelope.byteEnd <= previous.byteOffset) return false;
    if (previous && previous.generationId !== envelope.generationId) {
      this.value.retiredGenerationIds.push(previous.generationId);
      this.loseContext();
    }
    this.value.cursor = { generationId: envelope.generationId, byteOffset: envelope.byteEnd, eventId: envelope.eventId };
    this.value.context.generationId = envelope.generationId;
    // Seed/replay may be displayed by legacy Journey, but cannot establish a current session or receipts.
    if (envelope.origin !== 'live') { this.changed(); return false; }
    const event = envelope.event, context = this.value.context;
    if (event.t === 'level') {
      if (context.state === 'waiting_next') context.selected = event.char;
      if (context.selected && same(context.selected, event.char) && context.state !== 'changed') {
        context.state = 'confirmed'; context.detected = event.char;
        this.value.observed.characterLevel = { status: 'known', value: event.level, evidenceId: envelope.eventId };
      } else if (context.state === 'confirmed' || context.state === 'changed') this.loseContext(event.char);
      else context.detected = event.char;
    }
    if (!this.canFollow()) { this.changed(); return false; }
    if (event.t === 'area') {
      this.pendingArea = { id: event.id, evidenceId: envelope.eventId };
      this.value.observed.zoneId = { status: 'known', value: event.id, evidenceId: envelope.eventId };
      this.value.observed.areaLevel = { status: 'known', value: event.level, evidenceId: envelope.eventId };
    }
    if (event.t === 'instance') this.pendingArea = null;
    if (event.t === 'zone') {
      const maps = this.options.firstMapAreas, pending = this.pendingArea;
      if (pending && maps?.status === 'known' && maps.evidenceId && Object.hasOwn(maps.value, pending.id)) this.value.observed.firstMap = {
        status: 'known', value: { anchorId: maps.value[pending.id]!, method: 'zone_evidence', observedAt: time(event.at) }, evidenceId: envelope.eventId };
      this.pendingArea = null;
    }
    if (event.t === 'passive' && event.atlas) this.value.baseline = applyAtlasDelta(this.value.baseline, this.options.rules, {
      logNodeId: event.id, op: event.op, contextEpoch: this.value.context.epoch, evidenceId: envelope.eventId, evidenceAt: time(event.at) });
    this.value.observed.observedAt = time(event.at); this.changed();
    return true;
  }
  private consume(batch: LogBatch, readingEpoch: number): Promise<void> {
    const run = async () => {
      if (readingEpoch !== this.readingEpoch) return;
      const before = this.state(), beforeCursor = this.readerCursor;
      try {
        for (const status of batch.statuses) this.onStatus(status);
        // A batch with a gap has no continuous coverage. Do not reuse an identity preceding that gap.
        if (!batch.statuses.some(status => status.kind === 'gap' || status.kind === 'error')) {
          for (const envelope of batch.envelopes) this.observe(envelope);
        }
        this.readerCursor = batch.cursor;
        await this.options.commit?.(this.state(), this.checkpoint());
      } catch (error) {
        this.value = before; this.readerCursor = beforeCursor;
        this.onStatus({ kind: 'gap', reason: 'consumer_gap' });
        this.subscription?.stop(); this.subscription = null;
        throw error;
      }
    };
    const task = this.queue.then(run);
    this.queue = task.catch(() => undefined);
    return task;
  }
  async startReading(path: string, intervalMs = 500): Promise<void> {
    this.stopReading();
    const readingEpoch = ++this.readingEpoch;
    this.subscription = subscribeLog(path, batch => this.consume(batch, readingEpoch), { intervalMs, ...(this.readerCursor ? { checkpoint: this.readerCursor } : {}) });
    await this.subscription.ready;
  }
  stopReading(): void {
    this.readingEpoch++;
    if (this.subscription) { this.subscription.stop(); this.subscription = null; this.loseContext(); this.changed(); }
  }
  async flush(): Promise<void> { await this.queue; await this.options.commit?.(this.state(), this.checkpoint()); }
}

export type TelemetryCheckpoint = { state: TelemetryState; cursor: LogCursor | null };

/** Main supplies a private userData path. State and committed cursor share one flushed, atomic local snapshot. */
export class LocalTelemetryStore {
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly path: string, private readonly limits: ValidationLimits) {}
  private validate(value: unknown): TelemetryCheckpoint {
    if (!value || typeof value !== 'object') throw new Error('Invalid telemetry checkpoint.');
    const record = value as Record<string, unknown>, state = record.state as TelemetryState | undefined;
    const cursor = record.cursor as LogCursor | null;
    if (record.schemaVersion !== 1 || !state || !observedProgressSchema.parse(state.observed, this.limits).ok ||
      !state.context || !Number.isSafeInteger(state.context.epoch) || state.context.epoch < 0 ||
      !['unknown', 'waiting_next', 'confirmed', 'changed'].includes(state.context.state) ||
      ![state.context.selected, state.context.detected, state.context.generationId].every(v => v === null || typeof v === 'string') ||
      !Array.isArray(state.retiredGenerationIds) || !state.retiredGenerationIds.every(v => typeof v === 'string') ||
      !state.baseline || state.baseline.contextEpoch !== state.context.epoch || !state.baseline.dataset ||
      typeof state.baseline.dataset.datasetId !== 'string' || typeof state.baseline.dataset.variant !== 'string' ||
      !isId('hash', state.baseline.dataset.contentHash) || !leagueStampSchema.parse(state.baseline.dataset.stamp, this.limits).ok ||
      !['unknown', 'manualCount', 'completeSnapshot'].includes(state.baseline.kind) ||
      typeof state.baseline.needsChecking !== 'boolean' ||
      !(state.baseline.nodeSet === null || Array.isArray(state.baseline.nodeSet) && state.baseline.nodeSet.every(v => typeof v === 'string')) ||
      !(state.baseline.evidenceAt === null || typeof state.baseline.evidenceAt === 'string') ||
      !state.baseline.membership || typeof state.baseline.membership !== 'object' ||
      !Object.values(state.baseline.membership).every(v => ['unknown', 'allocated', 'unallocated'].includes(v)) ||
      !(cursor === null || cursor && typeof cursor.fileIdentity === 'string' && typeof cursor.generationId === 'string' &&
        typeof cursor.parserVersion === 'string' && Number.isSafeInteger(cursor.byteOffset) && cursor.byteOffset >= 0 &&
        /^[a-f0-9]{64}$/.test(cursor.headHash) && /^[a-f0-9]{64}$/.test(cursor.boundaryHash))) throw new Error('Invalid telemetry checkpoint.');
    if (!observedProgressSchema.parse(projectBaseline(state.baseline, emptyObserved()), this.limits).ok ||
      !(state.cursor === null || state.cursor && typeof state.cursor.generationId === 'string' && typeof state.cursor.eventId === 'string' &&
        Number.isSafeInteger(state.cursor.byteOffset) && state.cursor.byteOffset >= 0)) throw new Error('Invalid telemetry checkpoint.');
    return structuredClone({ state, cursor });
  }
  async load(): Promise<TelemetryCheckpoint | null> {
    try {
      if ((await stat(this.path)).size > this.limits.maxBytes) throw new Error('Telemetry checkpoint exceeds the local byte limit.');
      return this.validate(JSON.parse(await readFile(this.path, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  async commit(state: TelemetryState, cursor: LogCursor | null): Promise<void> {
    const checkpoint = this.validate({ schemaVersion: 1, state, cursor });
    const text = JSON.stringify({ schemaVersion: 1, ...checkpoint });
    if (Buffer.byteLength(text) > this.limits.maxBytes) return Promise.reject(new Error('Telemetry checkpoint exceeds the local byte limit.'));
    const write = async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const temp = `${this.path}.${randomUUID()}.tmp`;
      try {
        const fh = await open(temp, 'wx', 0o600);
        try { await fh.writeFile(text, 'utf8'); await fh.sync(); } finally { await fh.close(); }
        await rename(temp, this.path);
      } finally {
        await unlink(temp).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
      }
    };
    const task = this.queue.then(write); this.queue = task.catch(() => undefined); return task;
  }
}
