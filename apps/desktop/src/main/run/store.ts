import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { completionReceiptSchema, localFinishRecordSchema, parseId, runSnapshotSchema, runStateSchema, timelineBundleSchema, type ValidationLimits } from '@pom/mastery-contracts';
import { acknowledgeBundle, observeSchedule, emptyLedger } from '../../shared/timelines/scheduler/index.js';
import { canonicalJson, contentHash, validated } from '../../shared/timelines/adapters/common.js';
import type { RunCheckpoint } from '../../shared/run/types.js';
import { acquireStoreOwner } from '../documents/owner.js';
import { hashBytes } from '../documents/blobs.js';
import { openDb, type KbDb } from '../kb/db.js';

export type RunStoreProbe = (point: 'beforeIndexCommit' | 'afterIndexCommit') => void;
export const emptyCheckpoint = (): RunCheckpoint => ({ schemaVersion: 1, activeRunId: null, sessions: [], countRuns: true, outbox: [], sent: [] });

export async function validateCheckpoint(input: RunCheckpoint, limits: ValidationLimits): Promise<void> {
  const bytes = canonicalJson(input);
  if (Buffer.byteLength(bytes) > limits.maxBytes || input.schemaVersion !== 1 || typeof input.countRuns !== 'boolean' ||
    !Array.isArray(input.sessions) || !Array.isArray(input.outbox) || !Array.isArray(input.sent)) throw new Error('Invalid Run checkpoint.');
  const ids = input.sessions.map(s => s.snapshot.runId);
  if (new Set(ids).size !== ids.length || input.activeRunId !== null && !ids.includes(input.activeRunId)) throw new Error('Invalid active Run.');
  for (const s of input.sessions) {
    validated(runSnapshotSchema, s.snapshot, limits); validated(runStateSchema, s.state, limits);
    validated(timelineBundleSchema, s.sourceBundle, limits);
    if (await contentHash(s.snapshot) !== s.state.snapshotHash || s.snapshot.runId !== s.state.runId ||
      canonicalJson(s.schedule.actions) !== canonicalJson(s.snapshot.actions) || canonicalJson(s.schedule.groups.map(({ bundleId, trigger, actionIds, fingerprint }) =>
        ({ bundleId, trigger, actionIds, fingerprint }))) !== canonicalJson(s.snapshot.bundles) ||
      s.schedule.schedulerVersion !== s.snapshot.schedulerVersion || !Number.isSafeInteger(s.presentationVersion) || s.presentationVersion < 1 ||
      !Number.isSafeInteger(s.historyIndex) || s.historyIndex < 0 || s.historyIndex >= s.history.length ||
      s.displayed.bundleId !== s.state.guideCursor.bundleId || canonicalJson(s.displayed) !== canonicalJson(s.history[s.historyIndex]) ||
      typeof s.detailsOpen !== 'boolean' || typeof s.autoReceiptConsumed !== 'boolean' ||
      s.modeBeforePause !== undefined && !['auto', 'manual'].includes(s.modeBeforePause) ||
      ![null, 'final_trigger_observed', 'player_confirmed'].includes(s.receiptMethod) || !Array.isArray(s.commands) ||
      new Set(s.commands.map(c => c.commandId)).size !== s.commands.length) throw new Error('Run snapshot and ledger disagree.');
    for (const bundle of [s.displayed, ...s.history, ...(s.catchUp ? [s.catchUp.target] : [])]) await acknowledgeBundle(bundle, s.schedule);
    if (!Array.isArray(s.retainedHashes) || !s.retainedHashes.includes(s.state.snapshotHash)) throw new Error('Run snapshot is not retained.');
    for (const hash of s.retainedHashes) parseId('hash', hash);
    if (s.state.reviewed.some(record => !s.snapshot.actions.some(action => action.actionId === record.actionId && action.contentHash === record.contentHash)) ||
      [...s.state.outstandingActionIds, ...s.state.skippedActionIds].some(id => !s.snapshot.actions.some(action => action.actionId === id)) ||
      new Set(s.state.reviewed.map(record => record.actionId)).size !== s.state.reviewed.length ||
      s.commands.some(c => typeof c.commandId !== 'string' || !c.commandId || !/^[a-f0-9]{64}$/.test(c.hash))) throw new Error('Invalid Run ledger.');
    // Replaying normalized evidence verifies order and deduplication without acknowledging anything.
    const ledger = observeSchedule(s.schedule, emptyLedger(), s.ledger.observations);
    if (canonicalJson(ledger) !== canonicalJson(s.ledger)) throw new Error('Invalid observation ledger.');
    if (s.finish) validated(localFinishRecordSchema, s.finish, limits);
  }
  for (const entry of input.outbox) {
    if (!entry.accountId?.trim()) throw new Error('Invalid receipt account.');
    validated(completionReceiptSchema, entry.receipt, limits);
  }
  if (!input.countRuns && input.outbox.length) throw new Error('Counting is disabled.');
  for (const entry of input.sent) if (!entry.accountId?.trim() || !entry.idempotencyKey?.trim()) throw new Error('Invalid receipt delivery record.');
  const keys = [...input.outbox.map(e => [e.accountId, e.receipt.idempotencyKey]), ...input.sent.map(e => [e.accountId, e.idempotencyKey])].map(canonicalJson);
  if (new Set(keys).size !== keys.length) throw new Error('Duplicate completion receipt.');
}

export class RunStore {
  readonly root: string;
  private db: KbDb | null = null;
  private releaseOwner: (() => Promise<void>) | null = null;
  private pending: RunCheckpoint | null = null;
  constructor(userData: string, private readonly limits: ValidationLimits, private readonly probe: RunStoreProbe = () => {}) {
    this.root = join(userData, 'mastery', 'runs');
  }
  async init(): Promise<RunCheckpoint> {
    if (this.db) throw new Error('Run store is already open.');
    await mkdir(this.root, { recursive: true });
    this.releaseOwner = await acquireStoreOwner(this.root);
    try {
      this.db = openDb(join(this.root, 'index.sqlite'));
      const version = this.db.get<{ user_version: number }>('PRAGMA user_version')!.user_version;
      if (version !== 0 && version !== 1) throw new Error('Run index version is unsupported.');
      this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS checkpoint(id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL, hash TEXT NOT NULL); PRAGMA user_version=1;');
      return await this.load();
    } catch (error) { this.db?.close(); this.db = null; await this.releaseOwner(); this.releaseOwner = null; throw error; }
  }
  async load(): Promise<RunCheckpoint> {
    if (!this.db) throw new Error('Run store is closed.');
    const row = this.db.get<{ body: string; hash: string }>('SELECT body,hash FROM checkpoint WHERE id=1');
    if (!row) return emptyCheckpoint();
    if (Buffer.byteLength(row.body) > this.limits.maxBytes || hashBytes(row.body) !== row.hash) throw new Error('Run checkpoint is damaged.');
    const value = JSON.parse(row.body) as RunCheckpoint;
    await validateCheckpoint(value, this.limits);
    return value;
  }
  async commit(input: RunCheckpoint): Promise<void> {
    if (!this.db) throw new Error('Run store is closed.');
    const value = structuredClone(input);
    await validateCheckpoint(value, this.limits);
    const body = canonicalJson(value);
    this.pending = value;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.run('INSERT INTO checkpoint(id,body,hash) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,hash=excluded.hash', [body, hashBytes(body)]);
      this.probe('beforeIndexCommit');
      this.db.exec('COMMIT');
      this.pending = null;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.probe('afterIndexCommit');
  }
  get hasPending(): boolean { return this.pending !== null; }
  recovery(): RunCheckpoint | null { return this.pending ? structuredClone(this.pending) : null; }
  async exportRecovery(destination: string): Promise<void> {
    if (!this.pending) throw new Error('No Run write needs recovery.');
    const file = await open(destination, 'wx', 0o600);
    try { await file.writeFile(canonicalJson(this.pending), 'utf8'); await file.sync(); } finally { await file.close(); }
  }
  async close(): Promise<void> {
    if (this.pending) throw new Error('Run progress could not be saved. Retry or export recovery.');
    this.db?.close(); this.db = null;
    await this.releaseOwner?.(); this.releaseOwner = null;
  }
}
