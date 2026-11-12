import { randomUUID } from 'node:crypto';
import { parseId, revisionRefSchema, runSettingsSnapshotSchema, runSnapshotSchema, timelineBundleSchema,
  type CompletionReceipt, type RevisionRef, type RunId, type RunSettingsSnapshot, type RunSnapshot,
  type PublishedRevisionRef, type TimelineBundle, type ValidationLimits } from '@pom/mastery-contracts';
import { canonicalJson, contentHash, validated, verifySource } from '../../shared/timelines/adapters/common.js';
import { compileSchedule, observeSchedule, emptyLedger, type LevelInterval, type TriggerObservation } from '../../shared/timelines/scheduler/index.js';
import { applyCommand, applyObservations, createSession, endSession, reconcile, runView } from '../../shared/run/reducer.js';
import { parseCommand } from '../../shared/run/input.js';
import { finalEvidence, makeReceipt, receiptEvidence } from '../../shared/run/receipts.js';
import type { ReceiptEvidence, RunCheckpoint, RunSession, RunView } from '../../shared/run/types.js';
import type { TelemetryState } from '../../shared/journey/telemetry.js';
import type { DocumentStore } from '../documents/store.js';
import { RunStore, emptyCheckpoint } from './store.js';

export type StartRun = { bundle: TimelineBundle; timelineRevision: RevisionRef; publishedOrigin?: PublishedRevisionRef | null;
  settings?: RunSettingsSnapshot; omittedClipIds?: TimelineBundle['timeline']['clips'][number]['clipId'][] };
export type RunServiceOptions = { limits: ValidationLimits; documents: Pick<DocumentStore, 'blobs' | 'retain'>;
  now?: () => number; onChange?: (view: RunView | null) => void; raiseWindow?: () => void };

export class RunService {
  private value: RunCheckpoint = emptyCheckpoint();
  private queue: Promise<unknown> = Promise.resolve();
  private ready = false;
  private closing = false;
  private accountId: string | null = null;
  private lastTelemetry: { runId: RunId; snapshotHash: string; fingerprint: string } | null = null;
  private readonly runtimeId = randomUUID();
  constructor(readonly store: RunStore, private readonly options: RunServiceOptions) {}
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private enqueue<T>(work: () => Promise<T>, recovery = false): Promise<T> {
    if (!this.ready || this.closing) return Promise.reject(new Error('Run service is closed.'));
    const task = this.queue.then(async () => {
      if (this.store.hasPending && !recovery) throw new Error('Run progress could not be saved. Retry or export recovery.');
      return work();
    });
    this.queue = task.catch(() => undefined); return task;
  }
  async init(): Promise<void> {
    if (this.ready) throw new Error('Run service is already open.');
    this.value = await this.store.init();
    for (const s of this.value.sessions) {
      s.gesture = null; s.detailsOpen = false; s.lastNextAt = null;
      // Old log evidence stays visible but cannot become a new process's receipt evidence.
      const last = s.ledger.observations.at(-1);
      if (last) s.ledger = observeSchedule(s.schedule, s.ledger, [{ ...last, sequence: last.sequence + 1,
        eventId: `resume:${this.runtimeId}`, transitionId: `resume:${this.runtimeId}`, method: 'seed', reliable: false, continuous: false }]);
    }
    this.ready = true;
  }
  private active(value = this.value): RunSession {
    const session = value.sessions.find(s => s.snapshot.runId === value.activeRunId);
    if (!session) throw new Error('No active Run.');
    return session;
  }
  view(): RunView | null { return this.value.activeRunId ? runView(this.active(), this.value.countRuns) : null; }
  firstMapAnchor(): string | null { return this.active().sourceBundle.timeline.firstMapAnchor?.anchorId ?? null; }
  savedRuns(): { runId: RunId; revision: RevisionRef; state: RunView['state'] }[] {
    return this.value.sessions.map(s => structuredClone({ runId: s.snapshot.runId, revision: s.snapshot.timelineRevision, state: s.state }));
  }
  private async commit(next: RunCheckpoint): Promise<void> {
    await this.store.commit(next); this.value = next;
    this.options.onChange?.(this.view());
  }
  private async freeze(input: StartRun): Promise<RunSession> {
    const bundle = validated(timelineBundleSchema, input.bundle, this.options.limits);
    const revision = validated(revisionRefSchema, input.timelineRevision, this.options.limits);
    if (canonicalJson(revision.stamp) !== canonicalJson(bundle.timeline.stamp)) throw new Error('Timeline stamp does not match its revision.');
    const settings = validated(runSettingsSnapshotSchema, input.settings ?? { schemaVersion: 1, stamp: bundle.timeline.stamp,
      characterChunks: { kind: 'auto' }, atlasSplitPoints: 10, countRuns: this.value.countRuns, globalNextBackEnabled: false }, this.options.limits);
    for (const dependency of bundle.dependencies) await verifySource({ ref: dependency.ref, fallbackSnapshot: dependency.snapshot }, this.options.limits);
    const omitted = [...new Set(input.omittedClipIds ?? [])];
    if (omitted.some(id => !bundle.timeline.clips.some(clip => clip.clipId === id))) throw new Error('Omitted clip is not in this timeline.');
    const schedule = await compileSchedule({ timeline: bundle.timeline, options: { limits: this.options.limits, omittedClipIds: omitted,
      characterChunks: settings.characterChunks } });
    const snapshot: RunSnapshot = validated(runSnapshotSchema, { schemaVersion: 1, runId: parseId('run', randomUUID()), stamp: bundle.timeline.stamp,
      timelineRevision: revision, publishedOrigin: input.publishedOrigin ?? null,
      choices: bundle.choices.filter(choice => !omitted.includes(choice.clipId)), omittedClipIds: omitted,
      actions: schedule.actions, bundles: schedule.groups.map(({ bundleId, trigger, actionIds, fingerprint }) => ({ bundleId, trigger, actionIds, fingerprint })),
      dependencies: bundle.dependencies, schedulerVersion: schedule.schedulerVersion, settings }, this.options.limits);
    return createSession(snapshot, schedule, await contentHash(snapshot), new Date(this.now()).toISOString(), bundle);
  }
  private async retain(session: RunSession): Promise<void> {
    const hashes = [await this.options.documents.blobs.put(canonicalJson(session.snapshot))];
    hashes.push(await this.options.documents.blobs.put(canonicalJson(session.sourceBundle)));
    for (const dependency of session.snapshot.dependencies) hashes.push(await this.options.documents.blobs.put(canonicalJson(dependency.snapshot)));
    session.retainedHashes = [...new Set([...session.retainedHashes, ...hashes])];
    await this.options.documents.retain({ kind: 'run', id: session.snapshot.runId }, session.retainedHashes);
  }
  private sameIntent(s: RunSession, input: StartRun): boolean {
    return canonicalJson(s.snapshot.timelineRevision) === canonicalJson(input.timelineRevision) &&
      canonicalJson(s.snapshot.publishedOrigin) === canonicalJson(input.publishedOrigin ?? null);
  }
  start(input: StartRun, choice: 'keep' | 'replace' | null = null): Promise<RunView> {
    input = structuredClone(input);
    return this.enqueue(async () => {
      if (this.value.activeRunId) {
        const current = this.active();
        if (this.sameIntent(current, input) || choice === 'keep') { this.options.raiseWindow?.(); return runView(current, this.value.countRuns); }
        if (choice !== 'replace') throw new Error('A Run is already open. Keep it or replace it.');
        // Complete the old Run save barrier before writing or exposing any replacement.
        await this.store.commit(this.value);
      }
      const session = await this.freeze(input), next = structuredClone(this.value);
      if (next.activeRunId) endSession(this.active(next), new Date(this.now()).toISOString());
      await this.retain(session);
      next.sessions.push(session); next.activeRunId = session.snapshot.runId;
      await this.commit(next); this.options.raiseWindow?.(); return runView(session, this.value.countRuns);
    });
  }
  resume(runId: RunId): Promise<RunView> {
    parseId('run', runId);
    return this.enqueue(async () => {
      if (this.value.activeRunId && this.value.activeRunId !== runId) throw new Error('A Run is already open. Close it before resuming another.');
      const next = structuredClone(this.value), session = next.sessions.find(s => s.snapshot.runId === runId);
      if (!session) throw new Error('Saved Run is unavailable.');
      next.activeRunId = runId; await this.commit(next); this.options.raiseWindow?.(); return runView(session, this.value.countRuns);
    });
  }
  runAgain(expectedRunId: RunId): Promise<RunView> {
    parseId('run', expectedRunId);
    return this.enqueue(async () => {
      const current = this.active();
      if (current.snapshot.runId !== expectedRunId) throw new Error('Run changed. Review the current Run.');
      if (!current.state.endedAt) throw new Error('Finish this Run before starting it again.');
      await this.store.commit(this.value);
      const session = await this.freeze({ bundle: current.sourceBundle, timelineRevision: current.snapshot.timelineRevision,
        publishedOrigin: current.snapshot.publishedOrigin, omittedClipIds: current.snapshot.omittedClipIds,
        settings: { ...current.snapshot.settings, countRuns: this.value.countRuns } });
      await this.retain(session);
      const next = structuredClone(this.value);
      next.sessions.push(session); next.activeRunId = session.snapshot.runId;
      await this.commit(next); this.options.raiseWindow?.(); return runView(session, this.value.countRuns);
    });
  }
  async command(input: unknown): Promise<RunView> {
    const command = parseCommand(input, this.options.limits);
    return this.enqueue(async () => {
      const current = this.active(), hash = await contentHash(command), previous = current.commands.find(c => c.commandId === command.commandId);
      if (previous) {
        if (previous.hash !== hash) throw new Error('Run command ID was reused.');
        return runView(current, this.value.countRuns);
      }
      const next = structuredClone(this.value), s = await applyCommand(current, command, this.now());
      s.commands.push({ commandId: command.commandId, hash });
      next.sessions[next.sessions.findIndex(v => v.snapshot.runId === s.snapshot.runId)] = s;
      if (command.kind === 'confirmFinished') {
        const entry = await makeReceipt(s, this.accountId, 'player_confirmed', new Date(this.now()).toISOString(), next.countRuns);
        this.queueReceipt(next, entry);
        if (entry) s.receiptMethod ??= 'player_confirmed';
      }
      await this.commit(next); return runView(s, this.value.countRuns);
    });
  }
  private queueReceipt(next: RunCheckpoint, entry: Awaited<ReturnType<typeof makeReceipt>>): void {
    if (!entry || next.outbox.some(e => e.accountId === entry.accountId && e.receipt.idempotencyKey === entry.receipt.idempotencyKey) ||
      next.sent.some(e => e.accountId === entry.accountId && e.idempotencyKey === entry.receipt.idempotencyKey)) return;
    next.outbox.push(entry);
  }
  private async autoReceipt(next: RunCheckpoint, s: RunSession, at: string): Promise<void> {
    if (s.autoReceiptConsumed || !await finalEvidence(s)) return;
    // Qualification is consumed even while signed out or opted out. Later events cannot silently backfill it.
    s.autoReceiptConsumed = true;
    const entry = await makeReceipt(s, this.accountId, 'final_trigger_observed', at, next.countRuns);
    this.queueReceipt(next, entry);
    if (entry) { s.receiptMethod ??= 'final_trigger_observed'; if (s.finish) s.finish.finishMethod ??= 'final_trigger_observed'; }
  }
  observe(observations: readonly TriggerObservation[], telemetry?: TelemetryState): Promise<void> {
    observations = structuredClone(observations); telemetry = telemetry ? structuredClone(telemetry) : undefined;
    return this.enqueue(async () => {
      if (!this.value.activeRunId) return;
      const next = structuredClone(this.value), current = this.active(next);
      const fresh = observations.filter(event => !current.ledger.seenEventIds.includes(event.eventId));
      if (!fresh.length && !telemetry) return;
      let s = await applyObservations(current, fresh);
      if (telemetry) {
        s.state.observedProgress = structuredClone(telemetry.observed); s.state.eventCursor = structuredClone(telemetry.cursor);
        if (telemetry.context.selected) s.state.characterBinding = telemetry.context.selected;
        if (telemetry.context.state !== 'confirmed') s.state.mode = 'manual';
        await reconcile(s);
      }
      next.sessions[next.sessions.findIndex(v => v.snapshot.runId === s.snapshot.runId)] = s;
      const last = fresh.at(-1);
      if (last?.method === 'log') await this.autoReceipt(next, s, last.observedAt);
      await this.commit(next);
    });
  }
  // The qualified projection is the only telemetry ingress; IPC cannot submit evidence.
  acceptTelemetry(telemetry: TelemetryState): Promise<void> {
    telemetry = structuredClone(telemetry);
    return this.enqueue(async () => {
      if (!this.value.activeRunId) return;
      const next = structuredClone(this.value), s = this.active(next), cursor = telemetry.cursor;
      const fingerprint = canonicalJson(telemetry);
      if (this.lastTelemetry?.runId === s.snapshot.runId && this.lastTelemetry.snapshotHash === s.state.snapshotHash &&
        this.lastTelemetry.fingerprint === fingerprint) return;
      const observed = telemetry.observed, at = observed.observedAt ?? new Date(this.now()).toISOString();
      const reliable = telemetry.context.state === 'confirmed';
      let sequence = (s.ledger.observations.at(-1)?.sequence ?? -1) + 1;
      const transitionId = cursor?.eventId ?? `context:${telemetry.context.epoch}:${sequence}`;
      const events: TriggerObservation[] = [];
      const add = (trigger: TriggerObservation['trigger'], evidenceId: string, log: boolean, sourceEvidenceId?: string) => {
        events.push({ eventId: `${transitionId}:${events.length}:${evidenceId}`, sequence: sequence++, transitionId,
          contextEpoch: `${this.runtimeId}:${telemetry.context.epoch}`, observedAt: at, trigger,
          method: log ? 'log' : 'manual', reliable, continuous: reliable, selectedContext: reliable, ...(sourceEvidenceId ? { sourceEvidenceId } : {}) });
      };
      if (observed.characterLevel.status === 'known' && canonicalJson(observed.characterLevel) !== canonicalJson(s.state.observedProgress.characterLevel))
        add({ kind: 'level', level: observed.characterLevel.value }, observed.characterLevel.evidenceId, observed.characterLevel.evidenceId === cursor?.eventId);
      if (observed.zoneId.status === 'known' && canonicalJson(observed.zoneId) !== canonicalJson(s.state.observedProgress.zoneId))
        add({ kind: 'zone', zoneId: observed.zoneId.value }, observed.zoneId.evidenceId, observed.zoneId.evidenceId === cursor?.eventId);
      if (observed.areaLevel.status === 'known' && canonicalJson(observed.areaLevel) !== canonicalJson(s.state.observedProgress.areaLevel))
        add({ kind: 'areaLevel', level: observed.areaLevel.value, ...(observed.zoneId.status === 'known' ? { areaId: observed.zoneId.value } : {}) },
          observed.areaLevel.evidenceId, observed.areaLevel.evidenceId === cursor?.eventId);
      if (observed.firstMap.status === 'known' && canonicalJson(observed.firstMap) !== canonicalJson(s.state.observedProgress.firstMap))
        add({ kind: 'firstMap', anchorId: observed.firstMap.value.anchorId }, observed.firstMap.evidenceId,
          observed.firstMap.value.method === 'zone_evidence' && observed.firstMap.evidenceId === cursor?.eventId, observed.firstMap.evidenceId);
      if (observed.atlas.allocatedCount.status === 'known' && !telemetry.baseline.needsChecking &&
        canonicalJson(observed.atlas.allocatedCount) !== canonicalJson(s.state.observedProgress.atlas.allocatedCount)) {
        const count = observed.atlas.allocatedCount;
        const steps = [...new Set(s.schedule.groups.flatMap(g => g.trigger.kind === 'atlasAllocated' ? [g.trigger.stepId] : []))];
        for (const stepId of steps) add({ kind: 'atlasAllocated', stepId, points: count.value }, count.evidenceId, count.evidenceId === cursor?.eventId);
      }
      if (!reliable || telemetry.baseline.needsChecking && !events.length) events.push({ eventId: `barrier:${transitionId}:${sequence}`, sequence: sequence++, transitionId,
        contextEpoch: `${this.runtimeId}:${telemetry.context.epoch}`, observedAt: at, trigger: s.displayed.trigger, method: 'seed', reliable: false, continuous: false, selectedContext: false });
      s.ledger = observeSchedule(s.schedule, s.ledger, events);
      s.state.observedProgress = observed; s.state.eventCursor = cursor;
      if (telemetry.context.selected) s.state.characterBinding = telemetry.context.selected;
      if (!reliable) s.state.mode = 'manual';
      await reconcile(s);
      if (events.at(-1)?.method === 'log') await this.autoReceipt(next, s, at);
      await this.commit(next);
      this.lastTelemetry = { runId: s.snapshot.runId, snapshotHash: s.state.snapshotHash, fingerprint };
    });
  }
  switchPreview(input: StartRun): Promise<{ unchanged: string[]; changed: string[]; added: string[]; removed: string[] }> {
    input = structuredClone(input);
    return this.enqueue(async () => {
      const replacement = await this.freeze(input), previous = this.active().snapshot.actions, actions = replacement.snapshot.actions;
      return { unchanged: actions.filter(a => previous.some(b => b.actionId === a.actionId && b.contentHash === a.contentHash && canonicalJson(b.trigger) === canonicalJson(a.trigger))).map(a => a.actionId),
        changed: actions.filter(a => previous.some(b => b.actionId === a.actionId && (b.contentHash !== a.contentHash || canonicalJson(b.trigger) !== canonicalJson(a.trigger)))).map(a => a.actionId),
        added: actions.filter(a => !previous.some(b => b.actionId === a.actionId)).map(a => a.actionId), removed: previous.filter(a => !actions.some(b => b.actionId === a.actionId)).map(a => a.actionId) };
    });
  }
  useEditedVersion(input: StartRun, expectedSnapshotHash: string): Promise<RunView> {
    input = structuredClone(input);
    return this.enqueue(async () => {
      const current = this.active();
      if (current.state.snapshotHash !== expectedSnapshotHash) throw new Error('Run changed. Review the updated version.');
      const replacement = await this.freeze(input);
      replacement.snapshot.runId = current.snapshot.runId;
      replacement.retainedHashes = [...current.retainedHashes];
      replacement.state.runId = current.snapshot.runId; replacement.state.snapshotHash = await contentHash(replacement.snapshot);
      replacement.state.reviewed = current.state.reviewed.filter(record => replacement.snapshot.actions.some(action => action.actionId === record.actionId &&
        action.contentHash === record.contentHash && current.snapshot.actions.some(old => old.actionId === action.actionId && canonicalJson(old.trigger) === canonicalJson(action.trigger))));
      replacement.state.outstandingActionIds = replacement.snapshot.actions.filter(a => !replacement.state.reviewed.some(r => r.actionId === a.actionId)).map(a => a.actionId);
      replacement.state.observedProgress = structuredClone(current.state.observedProgress); replacement.state.eventCursor = current.state.eventCursor;
      replacement.state.startedAt = current.state.startedAt; replacement.state.mode = 'manual';
      replacement.state.commandCursor = current.state.commandCursor; replacement.commands = structuredClone(current.commands);
      const oldIds = current.displayed.actionIds;
      const forwardIds = current.schedule.groups.slice(current.schedule.groups.findIndex(g =>
        g.actionIds.some(id => oldIds.includes(id))) + 1).flatMap(g => g.actionIds);
      const target = replacement.schedule.groups.find(g => g.actionIds.some(id => oldIds.includes(id))) ??
        replacement.schedule.groups.find(g => g.actionIds.some(id => forwardIds.includes(id))) ??
        replacement.schedule.groups.find(g => g.trigger.kind === current.displayed.trigger.kind &&
          (g.trigger.kind !== 'level' || g.trigger.level >= current.state.guideCursor.level)) ?? replacement.schedule.groups.at(-1)!;
      replacement.displayed = target; replacement.history = [target]; replacement.state.presentedBundleIds = [target.bundleId];
      replacement.state.guideCursor = { bundleId: target.bundleId, level: current.state.guideCursor.level };
      replacement.presentationVersion = current.presentationVersion + 1;
      // Evaluate only fresh evidence for the replacement pin; original receipts remain in the outbox.
      replacement.ledger = emptyLedger();
      await this.retain(replacement);
      const next = structuredClone(this.value); next.sessions[next.sessions.findIndex(s => s.snapshot.runId === current.snapshot.runId)] = replacement;
      await this.commit(next); return runView(replacement, this.value.countRuns);
    });
  }
  setAccount(accountId: string | null): Promise<void> {
    if (accountId !== null && !accountId.trim()) return Promise.reject(new Error('Invalid receipt account.'));
    return this.enqueue(async () => { this.accountId = accountId; });
  }
  setCounting(enabled: boolean): Promise<void> {
    if (typeof enabled !== 'boolean') return Promise.reject(new Error('Invalid counting preference.'));
    return this.enqueue(async () => {
      const next = structuredClone(this.value); next.countRuns = enabled;
      if (!enabled) next.outbox = [];
      await this.commit(next);
    });
  }
  updateFutureChunks(characterChunks: RunSettingsSnapshot['characterChunks'], pace: readonly LevelInterval[] = []): Promise<RunView> {
    characterChunks = structuredClone(characterChunks); pace = structuredClone(pace);
    return this.enqueue(async () => {
      const next = structuredClone(this.value), s = this.active(next);
      if (s.gesture) throw new Error('Finish the pointer gesture before changing Run chunks.');
      const settings = validated(runSettingsSnapshotSchema, { ...s.snapshot.settings, characterChunks }, this.options.limits);
      const presentedActions = new Set(s.history.flatMap(bundle => bundle.actionIds));
      const presentedChunks = s.schedule.chunks.filter(chunk => chunk.actionIds.some(id => presentedActions.has(id)));
      const schedule = await compileSchedule({ timeline: s.sourceBundle.timeline, options: { limits: this.options.limits,
        omittedClipIds: s.snapshot.omittedClipIds, characterChunks, pace, presentedChunks } });
      if (canonicalJson(schedule.actions) !== canonicalJson(s.snapshot.actions)) throw new Error('Chunk settings cannot change instructions.');
      s.schedule = schedule; s.snapshot.settings = settings;
      s.state.snapshotHash = await contentHash(s.snapshot);
      await this.retain(s); await this.commit(next); return runView(s, this.value.countRuns);
    });
  }
  queuedReceipts(): CompletionReceipt[] {
    return structuredClone(this.value.outbox.filter(e => e.accountId === this.accountId).map(e => e.receipt));
  }
  deliverReceipts(send: (receipt: CompletionReceipt, accountId: string, evidence?: ReceiptEvidence) => Promise<void>): Promise<void> {
    return this.enqueue(async () => {
      const account = this.accountId;
      if (!account || !this.value.countRuns) return;
      for (const entry of this.value.outbox.filter(e => e.accountId === account)) {
        const evidence = entry.receipt.method === 'final_trigger_observed' ? structuredClone(entry.evidence ?? receiptEvidence(entry.receipt)) : undefined;
        await send(structuredClone(entry.receipt), account, evidence);
        const next = structuredClone(this.value);
        next.outbox = next.outbox.filter(e => e.accountId !== account || e.receipt.idempotencyKey !== entry.receipt.idempotencyKey);
        next.sent.push({ accountId: account, idempotencyKey: entry.receipt.idempotencyKey });
        await this.commit(next);
      }
    });
  }
  closeRun(): Promise<void> {
    return this.enqueue(async () => { const next = structuredClone(this.value); next.activeRunId = null; await this.commit(next); });
  }
  retry(): Promise<void> {
    return this.enqueue(async () => { const pending = this.store.recovery(); if (pending) await this.commit(pending); }, true);
  }
  async flush(): Promise<void> { await this.queue; if (this.store.hasPending) throw new Error('Run progress could not be saved. Retry or export recovery.'); }
  async close(): Promise<void> {
    if (this.closing) throw new Error('Run service is closing.');
    this.closing = true;
    try { await this.flush(); await this.store.close(); this.ready = false; }
    finally { this.closing = false; }
  }
}
