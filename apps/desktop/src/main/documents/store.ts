import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  documentEnvelopeSchema, editTransactionSchema, parseId, revisionCheckpointSchema, revisionRefSchema,
  writeDocumentRequestSchema, writeDocumentResponseSchema,
  type DocumentEnvelope, type EditCommand, type EditTransaction, type Hash, type ObjectId,
  type ObjectKind, type RevisionCheckpoint, type RevisionId, type RevisionRef, type Schema,
  type TransactionId, type ValidationLimits, type WriteDocumentRequest, type WriteDocumentResponse,
} from '@pom/mastery-contracts';
import { openDb, type KbDb } from '../kb/db.js';
import { redoTransaction, replayRevision } from '../../shared/documents/history.js';
import { BlobStore, flushDirectory, hashBytes, type FaultProbe } from './blobs.js';
import { acquireStoreOwner } from './owner.js';

export class DocumentStoreError extends Error {
  constructor(readonly code: 'CONFLICT' | 'NOT_FOUND' | 'INVALID' | 'STORAGE_FAILED' | 'UNSAVED' | 'CLOSED', message: string) { super(message); }
}

export type EditOptions = { label: string; commands?: EditCommand[] };
export type PendingDocument = { schemaVersion: 1; kind: ObjectKind; request: WriteDocumentRequest<unknown>; edit: EditOptions; historyTarget?: TransactionId };
export type StoreOptions = {
  limits: ValidationLimits;
  schemas: Partial<Record<ObjectKind, Schema<unknown>>>;
  checkpointEvery: number;
  probe?: FaultProbe;
  now?: () => Date;
};
type ObjectRow = { id: string; kind: ObjectKind; revision: RevisionId; cursor: TransactionId; tip: TransactionId; row_version: number; trashed_at: string | null };
type RevisionRow = { ref: string; blob: Hash };
type RecordRow = { record: string };
type RetentionOwner = { kind: 'run'; id: string } | { kind: 'save'; id: string };

export class DocumentStore {
  readonly root: string;
  readonly blobs: BlobStore;
  private db!: KbDb;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private closing = false;
  private closeTask: Promise<void> | null = null;
  private releaseOwner: (() => Promise<void>) | null = null;
  private readonly pending = new Map<ObjectId, PendingDocument>();
  readonly recoveryIssues: { objectId: ObjectId; code: 'INVALID' }[] = [];

  constructor(userData: string, private readonly options: StoreOptions) {
    this.root = join(userData, 'mastery');
    this.blobs = new BlobStore(join(this.root, 'blobs'), options.probe);
    if (!Number.isSafeInteger(options.checkpointEvery) || options.checkpointEvery < 1) throw new DocumentStoreError('INVALID', 'Checkpoint interval must be positive.');
  }

  async init(): Promise<void> {
    if (this.releaseOwner || this.closed) throw new DocumentStoreError('CLOSED', 'Document store is already initialized.');
    await this.blobs.init();
    await mkdir(join(this.root, 'drafts'), { recursive: true });
    this.releaseOwner = await acquireStoreOwner(this.root);
    try {
      this.db = openDb(join(this.root, 'index.sqlite'));
      const version = this.db.get<{ user_version: number }>('PRAGMA user_version')!.user_version;
      if (version !== 0 && version !== 1) throw new DocumentStoreError('INVALID', 'Document index version is unsupported.');
      this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS objects(id TEXT PRIMARY KEY, kind TEXT NOT NULL, revision TEXT NOT NULL,
        cursor TEXT NOT NULL, tip TEXT NOT NULL, row_version INTEGER NOT NULL, trashed_at TEXT);
      CREATE TABLE IF NOT EXISTS revisions(id TEXT PRIMARY KEY, object_id TEXT NOT NULL, ref TEXT NOT NULL,
        blob TEXT NOT NULL, parent TEXT);
      CREATE TABLE IF NOT EXISTS edits(id TEXT PRIMARY KEY, object_id TEXT NOT NULL, record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS checkpoints(id TEXT PRIMARY KEY, object_id TEXT NOT NULL, record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests(object_id TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL,
        response TEXT NOT NULL, PRIMARY KEY(object_id,key));
      CREATE TABLE IF NOT EXISTS retained(owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL, blob TEXT NOT NULL,
        PRIMARY KEY(owner_kind,owner_id,blob));
      CREATE INDEX IF NOT EXISTS revision_objects ON revisions(object_id);
      CREATE INDEX IF NOT EXISTS edit_objects ON edits(object_id);
      CREATE INDEX IF NOT EXISTS checkpoint_objects ON checkpoints(object_id);
      PRAGMA user_version=1;`);
    } catch (error) {
      this.db?.close();
      await this.releaseOwner();
      this.releaseOwner = null;
      throw error;
    }
    for (const name of await readdir(join(this.root, 'drafts'))) {
      if (!name.endsWith('.json')) continue;
      let id: ObjectId;
      try { id = parseId('object', name.slice(0, -5)); } catch { continue; }
      try { await this.recoverDraft(id); }
      catch { this.recoveryIssues.push({ objectId: id, code: 'INVALID' }); }
    }
  }

  get driver(): KbDb['driver'] { return this.db.driver; }
  private now(): string { return (this.options.now?.() ?? new Date()).toISOString(); }
  private schema(kind: ObjectKind): Schema<unknown> {
    const schema = this.options.schemas[kind];
    if (!schema) throw new DocumentStoreError('INVALID', 'No payload schema is registered for this document type.');
    return schema;
  }
  private validate<T>(schema: Schema<T>, value: unknown): T {
    const result = schema.parse(value, this.options.limits);
    if (!result.ok) throw new DocumentStoreError('INVALID', 'Document validation failed.');
    return structuredClone(result.value);
  }
  private validatePending(input: PendingDocument): PendingDocument {
    if (!input || input.schemaVersion !== 1 || Object.keys(input).some(key => !['schemaVersion', 'kind', 'request', 'edit', 'historyTarget'].includes(key))) throw new DocumentStoreError('INVALID', 'Recovery draft is invalid.');
    const request = this.validate(writeDocumentRequestSchema(this.schema(input.kind)), input.request);
    if (!input.edit || Object.keys(input.edit).some(key => !['label', 'commands'].includes(key))) throw new DocumentStoreError('INVALID', 'Edit metadata is invalid.');
    const hash = hashBytes(JSON.stringify(request.payload));
    const pin: RevisionRef = { objectId: request.objectId, revisionId: parseId('revision', randomUUID()), payloadHash: hash, fallbackSnapshotHash: hash, stamp: request.stamp };
    const metadata = this.validate(editTransactionSchema, {
      schemaVersion: 1, transactionId: parseId('transaction', randomUUID()), parentTransactionId: null, branchId: 'draft',
      before: pin, after: pin, commands: input.edit.commands ?? [{ kind: 'replaceSnapshot', snapshot: pin }], stamp: request.stamp, createdAt: this.now(), label: input.edit.label,
    });
    const pending: PendingDocument = { schemaVersion: 1, kind: input.kind, request, edit: { label: metadata.label } };
    if (input.edit.commands !== undefined) pending.edit.commands = metadata.commands;
    if (input.historyTarget !== undefined) pending.historyTarget = parseId('transaction', input.historyTarget);
    if (Buffer.byteLength(JSON.stringify(pending)) > this.options.limits.maxBytes) throw new DocumentStoreError('INVALID', 'Recovery draft exceeds the configured size limit.');
    return pending;
  }
  private row(id: ObjectId, includeTrash = false): ObjectRow {
    parseId('object', id);
    const row = this.db.get<ObjectRow>('SELECT * FROM objects WHERE id=?', [id]);
    if (!row || (!includeTrash && row.trashed_at)) throw new DocumentStoreError('NOT_FOUND', 'Document is unavailable.');
    return row;
  }
  private queue<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed || this.closing) return Promise.reject(new DocumentStoreError('CLOSED', 'Document store is closed.'));
    const result = this.tail.then(work);
    this.tail = result.catch(() => {});
    return result;
  }
  /** Index writes so far (tried or done). This process owns the index alone, so an unmoved count means no row changed. */
  get writeCount(): number { return this.writes; }
  private writes = 0;
  private commit(work: () => void): void {
    this.writes++;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      work();
      this.options.probe?.('beforeIndexCommit');
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* SQLite can roll back automatically on SQLITE_FULL. */ }
      throw error;
    }
    this.options.probe?.('afterIndexCommit');
  }

  async read<T = unknown>(id: ObjectId): Promise<DocumentEnvelope<T>> {
    const row = this.row(id);
    return this.readRevision<T>(id, row.revision);
  }

  async readRevision<T = unknown>(id: ObjectId, revisionId: RevisionId): Promise<DocumentEnvelope<T>> {
    parseId('object', id);
    parseId('revision', revisionId);
    const row = this.db.get<RevisionRow>('SELECT ref,blob FROM revisions WHERE id=? AND object_id=?', [revisionId, id]);
    if (!row) throw new DocumentStoreError('NOT_FOUND', 'Revision is unavailable.');
    const ref = this.validate(revisionRefSchema, JSON.parse(row.ref));
    const object = this.row(id, true);
    const envelope = this.validate(documentEnvelopeSchema(object.kind, this.schema(object.kind)), JSON.parse(await this.blobs.read(row.blob)));
    if (envelope.objectId !== id || ref.objectId !== id || ref.revisionId !== revisionId || envelope.revision.revisionId !== revisionId ||
      envelope.revision.payloadHash !== hashBytes(JSON.stringify(envelope.payload)) ||
      ref.fallbackSnapshotHash !== row.blob || ref.payloadHash !== envelope.revision.payloadHash ||
      JSON.stringify(ref.stamp) !== JSON.stringify(envelope.revision.stamp)) {
      throw new DocumentStoreError('STORAGE_FAILED', 'Revision does not match its snapshot.');
    }
    return envelope as DocumentEnvelope<T>;
  }

  list(includeTrash = false): { objectId: ObjectId; kind: ObjectKind; revisionId: RevisionId; trashedAt: string | null }[] {
    return this.db.all<ObjectRow>(`SELECT * FROM objects ${includeTrash ? '' : 'WHERE trashed_at IS NULL'} ORDER BY id`)
      .map(row => ({ objectId: parseId('object', row.id), kind: row.kind, revisionId: row.revision, trashedAt: row.trashed_at }));
  }

  write<T>(kind: ObjectKind, input: WriteDocumentRequest<T>, edit: EditOptions): Promise<WriteDocumentResponse> {
    let pending: PendingDocument;
    try {
      pending = this.validatePending({ schemaVersion: 1, kind, request: input, edit });
    } catch (error) { return Promise.reject(error); }
    return this.queue(() => this.savePending(pending));
  }

  private async savePending(pending: PendingDocument): Promise<WriteDocumentResponse> {
    try {
      const response = pending.historyTarget ? await this.moveHistoryNow(pending) : await this.writeNow(pending);
      this.pending.delete(pending.request.objectId);
      // A stale recovery draft is harmless; the committed request receipt wins on retry.
      await rm(join(this.root, 'drafts', `${pending.request.objectId}.json`), { force: true }).catch(() => {});
      return response;
    } catch (error) {
      this.pending.set(pending.request.objectId, pending);
      if (error instanceof DocumentStoreError) throw error;
      throw new DocumentStoreError('STORAGE_FAILED', 'Your latest changes are not saved.');
    }
  }

  private receipt(pending: PendingDocument): WriteDocumentResponse | null {
    const { request } = pending;
    const receipt = this.db.get<{ fingerprint: string; response: string }>('SELECT fingerprint,response FROM requests WHERE object_id=? AND key=?', [request.objectId, request.idempotencyKey]);
    if (!receipt) return null;
    if (receipt.fingerprint !== hashBytes(JSON.stringify(pending))) throw new DocumentStoreError('CONFLICT', 'This save key belongs to different changes.');
    return this.validate(writeDocumentResponseSchema, JSON.parse(receipt.response));
  }

  private async writeNow(pending: PendingDocument): Promise<WriteDocumentResponse> {
    const { kind, request, edit } = pending;
    const fingerprint = hashBytes(JSON.stringify(pending));
    const receipt = this.receipt(pending);
    if (receipt) return receipt;
    const current = this.db.get<ObjectRow>('SELECT * FROM objects WHERE id=?', [request.objectId]);
    if ((current?.revision ?? null) !== request.expectedRevisionId || current?.trashed_at || (current && current.kind !== kind)) {
      throw new DocumentStoreError('CONFLICT', 'The document changed. Review both versions before saving.');
    }
    const revisionId = parseId('revision', randomUUID());
    const payloadHash = hashBytes(JSON.stringify(request.payload));
    const envelope = this.validate(documentEnvelopeSchema(kind, this.schema(kind)), {
      schemaVersion: 1, objectId: request.objectId, kind, payload: request.payload,
      revision: { schemaVersion: 1, revisionId, parentRevisionId: request.expectedRevisionId, payloadHash, stamp: request.stamp },
    });
    const bytes = JSON.stringify(envelope);
    const ref: RevisionRef = { objectId: request.objectId, revisionId, payloadHash, stamp: request.stamp, fallbackSnapshotHash: hashBytes(bytes) };
    const transactionId = parseId('transaction', randomUUID());
    const tipRecord = current && current.cursor === current.tip ? this.db.get<RecordRow>('SELECT record FROM edits WHERE id=? AND object_id=?', [current.tip, request.objectId]) : null;
    const branchId = tipRecord ? this.validate(editTransactionSchema, JSON.parse(tipRecord.record)).branchId : randomUUID();
    const before = current ? this.revisionRef(request.objectId, current.revision) : ref;
    const event = this.validate(editTransactionSchema, {
      schemaVersion: 1, transactionId, parentTransactionId: current?.cursor ?? null, branchId,
      before, after: ref, commands: edit.commands ?? [{ kind: 'replaceSnapshot', snapshot: ref }],
      stamp: request.stamp, createdAt: this.now(), label: edit.label,
    });
    for (const command of event.commands) {
      const pin = command.kind === 'restoreRevision' ? command.source : command.kind === 'replaceSnapshot' ? command.snapshot : null;
      if (!pin) continue;
      if (pin.objectId !== request.objectId || (pin.revisionId !== ref.revisionId &&
        JSON.stringify(this.revisionRef(pin.objectId, pin.revisionId)) !== JSON.stringify(pin))) {
        throw new DocumentStoreError('INVALID', 'History snapshot belongs to a different revision.');
      }
    }
    const checkpoint = this.validate(revisionCheckpointSchema, { schemaVersion: 1, transactionId, revision: ref, stamp: request.stamp });
    await this.blobs.put(bytes);
    const response = this.validate(writeDocumentResponseSchema, { revision: ref, rowVersion: (current?.row_version ?? 0) + 1 });
    this.commit(() => {
      const latest = this.db.get<ObjectRow>('SELECT * FROM objects WHERE id=?', [request.objectId]);
      if ((latest?.revision ?? null) !== request.expectedRevisionId || latest?.row_version !== current?.row_version) throw new DocumentStoreError('CONFLICT', 'The document changed before saving.');
      this.db.run('INSERT INTO revisions(id,object_id,ref,blob,parent) VALUES (?,?,?,?,?)', [revisionId, request.objectId, JSON.stringify(ref), ref.fallbackSnapshotHash, request.expectedRevisionId]);
      this.db.run('INSERT INTO edits(id,object_id,record) VALUES (?,?,?)', [transactionId, request.objectId, JSON.stringify(event)]);
      const count = this.db.get<{ n: number }>('SELECT count(*) AS n FROM edits WHERE object_id=?', [request.objectId])!.n;
      if (!current || count % this.options.checkpointEvery === 0) this.db.run('INSERT INTO checkpoints(id,object_id,record) VALUES (?,?,?)', [transactionId, request.objectId, JSON.stringify(checkpoint)]);
      this.db.run(`INSERT INTO objects(id,kind,revision,cursor,tip,row_version) VALUES (?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor,tip=excluded.tip,row_version=excluded.row_version`,
      [request.objectId, kind, revisionId, transactionId, transactionId, response.rowVersion]);
      this.db.run('INSERT INTO requests(object_id,key,fingerprint,response) VALUES (?,?,?,?)', [request.objectId, request.idempotencyKey, fingerprint, JSON.stringify(response)]);
    });
    return response;
  }

  revisionRef(id: ObjectId, revisionId: RevisionId): RevisionRef {
    parseId('object', id); parseId('revision', revisionId);
    const row = this.db.get<RevisionRow>('SELECT ref,blob FROM revisions WHERE id=? AND object_id=?', [revisionId, id]);
    if (!row) throw new DocumentStoreError('NOT_FOUND', 'Revision is unavailable.');
    return this.validate(revisionRefSchema, JSON.parse(row.ref));
  }

  history(id: ObjectId): { events: EditTransaction[]; checkpoints: RevisionCheckpoint[]; cursor: TransactionId; tip: TransactionId } {
    const row = this.row(id, true);
    return {
      cursor: row.cursor, tip: row.tip,
      events: this.db.all<RecordRow>('SELECT record FROM edits WHERE object_id=? ORDER BY rowid', [id]).map(row => this.validate(editTransactionSchema, JSON.parse(row.record))),
      checkpoints: this.db.all<RecordRow>('SELECT record FROM checkpoints WHERE object_id=? ORDER BY rowid', [id]).map(row => this.validate(revisionCheckpointSchema, JSON.parse(row.record))),
    };
  }

  async preview<T = unknown>(id: ObjectId, transactionId: TransactionId): Promise<DocumentEnvelope<T>> {
    const history = this.history(id);
    const ref = replayRevision(history.events, history.checkpoints, transactionId);
    return this.readRevision<T>(id, ref.revisionId);
  }

  undo(id: ObjectId, expectedRevisionId: RevisionId): Promise<WriteDocumentResponse> { return this.moveHistory(id, expectedRevisionId, 'undo'); }
  redo(id: ObjectId, expectedRevisionId: RevisionId): Promise<WriteDocumentResponse> { return this.moveHistory(id, expectedRevisionId, 'redo'); }

  private moveHistory(id: ObjectId, expected: RevisionId, direction: 'undo' | 'redo'): Promise<WriteDocumentResponse> {
    return this.queue(async () => {
      const current = this.row(id);
      if (current.revision !== expected) throw new DocumentStoreError('CONFLICT', 'The document changed.');
      const history = this.history(id);
      const cursor = history.events.find(event => event.transactionId === current.cursor)!;
      const target = direction === 'redo' ? redoTransaction(history.events, current.cursor, current.tip)
        : history.events.find(event => event.transactionId === cursor.parentTransactionId);
      if (!target) return this.validate(writeDocumentResponseSchema, { revision: this.revisionRef(id, expected), rowVersion: current.row_version });
      const source = await this.readRevision(id, target.after.revisionId);
      return this.savePending({ schemaVersion: 1, kind: source.kind, historyTarget: target.transactionId,
        request: { objectId: id, expectedRevisionId: expected, payload: source.payload, stamp: source.revision.stamp, idempotencyKey: randomUUID() },
        edit: { label: direction === 'undo' ? 'Undo' : 'Redo' },
      });
    });
  }

  private async moveHistoryNow(pending: PendingDocument): Promise<WriteDocumentResponse> {
      const receipt = this.receipt(pending);
      if (receipt) return receipt;
      const { objectId: id, expectedRevisionId: expected } = pending.request;
      const current = this.row(id);
      if (expected === null || current.revision !== expected) throw new DocumentStoreError('CONFLICT', 'The document changed.');
      const history = this.history(id);
      const target = history.events.find(event => event.transactionId === pending.historyTarget);
      if (!target) throw new DocumentStoreError('INVALID', 'History target is unavailable.');
      const source = await this.readRevision(id, target.after.revisionId);
      const revisionId = parseId('revision', randomUUID());
      const envelope: DocumentEnvelope<unknown> = { ...source, revision: { ...source.revision, revisionId, parentRevisionId: expected } };
      const hash = await this.blobs.put(JSON.stringify(envelope));
      const ref: RevisionRef = { ...target.after, revisionId, fallbackSnapshotHash: hash };
      const response = this.validate(writeDocumentResponseSchema, { revision: ref, rowVersion: current.row_version + 1 });
      this.commit(() => {
        if (this.row(id).revision !== expected) throw new DocumentStoreError('CONFLICT', 'The document changed.');
        this.db.run('INSERT INTO revisions(id,object_id,ref,blob,parent) VALUES (?,?,?,?,?)', [revisionId, id, JSON.stringify(ref), hash, expected]);
        this.db.run('UPDATE objects SET revision=?,cursor=?,row_version=? WHERE id=?', [revisionId, target.transactionId, response.rowVersion, id]);
        this.db.run('INSERT INTO requests(object_id,key,fingerprint,response) VALUES (?,?,?,?)', [id, pending.request.idempotencyKey, hashBytes(JSON.stringify(pending)), JSON.stringify(response)]);
      });
      return response;
  }

  async restore(id: ObjectId, expected: RevisionId, sourceRevision: RevisionId, idempotencyKey: string): Promise<WriteDocumentResponse> {
    const source = await this.readRevision(id, sourceRevision);
    return this.write(source.kind, { objectId: id, expectedRevisionId: expected, payload: source.payload, stamp: source.revision.stamp, idempotencyKey },
      { label: 'Restored revision', commands: [{ kind: 'restoreRevision', source: this.revisionRef(id, sourceRevision) }] });
  }

  trash(id: ObjectId, expected: RevisionId): Promise<void> {
    return this.queue(async () => this.commit(() => {
      if (this.row(id).revision !== expected) throw new DocumentStoreError('CONFLICT', 'The document changed.');
      this.db.run('UPDATE objects SET trashed_at=?,row_version=row_version+1 WHERE id=?', [this.now(), id]);
    }));
  }

  restoreTrash(id: ObjectId): Promise<void> {
    return this.queue(async () => this.commit(() => {
      this.row(id, true);
      this.db.run('UPDATE objects SET trashed_at=NULL,row_version=row_version+1 WHERE id=?', [id]);
    }));
  }

  pendingSnapshot(id: ObjectId): PendingDocument | null { return structuredClone(this.pending.get(id) ?? null); }
  get hasUnsavedChanges(): boolean { return this.pending.size > 0; }

  async persistDraft(kind: ObjectKind, input: WriteDocumentRequest<unknown>, edit: EditOptions): Promise<void> {
    const draft = this.validatePending({ schemaVersion: 1, kind, request: input, edit });
    await this.queue(async () => {
      this.pending.set(input.objectId, draft);
      const path = join(this.root, 'drafts', `${input.objectId}.json`);
      const temp = `${path}.${randomUUID()}.tmp`;
      const file = await open(temp, 'wx');
      try { this.options.probe?.('draftWrite'); await file.writeFile(JSON.stringify(draft)); await file.sync(); }
      finally { await file.close(); }
      await rename(temp, path);
      await flushDirectory(join(this.root, 'drafts'));
    });
  }

  async recoverDraft(id: ObjectId): Promise<PendingDocument | null> {
    parseId('object', id);
    if (this.pending.has(id)) return this.pendingSnapshot(id);
    let draft: PendingDocument;
    try {
      const path = join(this.root, 'drafts', `${id}.json`);
      if ((await stat(path)).size > this.options.limits.maxBytes) throw new DocumentStoreError('INVALID', 'Recovery draft exceeds the configured size limit.');
      draft = JSON.parse(await readFile(path, 'utf8')) as PendingDocument;
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    if (draft.schemaVersion !== 1 || draft.request.objectId !== id) throw new DocumentStoreError('INVALID', 'Recovery draft is invalid.');
    draft = this.validatePending(draft);
    if (this.receipt(draft)) return null;
    this.pending.set(id, draft);
    return structuredClone(draft);
  }

  async exportRecovery(id: ObjectId, path: string): Promise<void> {
    const pending = await this.recoverDraft(id);
    if (!pending) throw new DocumentStoreError('NOT_FOUND', 'No pending changes are available.');
    const file = await open(path, 'wx');
    try { await file.writeFile(JSON.stringify(pending)); await file.sync(); } finally { await file.close(); }
  }

  async retry(id: ObjectId): Promise<WriteDocumentResponse> {
    const pending = await this.recoverDraft(id);
    if (!pending) throw new DocumentStoreError('NOT_FOUND', 'No pending changes are available.');
    return this.queue(() => this.savePending(pending));
  }

  retain(owner: RetentionOwner, hashes: readonly Hash[]): Promise<void> {
    return this.queue(async () => {
      if (owner.kind === 'run') parseId('run', owner.id); else parseId('object', owner.id);
      for (const hash of hashes) await this.blobs.read(hash);
      this.commit(() => {
        this.db.run('DELETE FROM retained WHERE owner_kind=? AND owner_id=?', [owner.kind, owner.id]);
        for (const hash of new Set(hashes)) this.db.run('INSERT INTO retained(owner_kind,owner_id,blob) VALUES (?,?,?)', [owner.kind, owner.id, hash]);
      });
    });
  }

  retainedRoots(): Hash[] {
    // Every revision, including trash and abandoned branches, stays recoverable. No automatic GC.
    return [...new Set(this.db.all<{ blob: Hash }>('SELECT blob FROM revisions UNION SELECT blob FROM retained').map(row => row.blob))];
  }

  async recoveryInventory(): Promise<{ name: string; hash: Hash | null; complete: boolean; bytes: number }[]> {
    const roots = new Set(this.retainedRoots());
    return (await this.blobs.scan()).filter(blob => !blob.complete || !blob.hash || !roots.has(blob.hash));
  }

  async exportOrphan(name: string, destination: string): Promise<void> {
    if (!(await this.recoveryInventory()).some(blob => blob.name === name)) throw new DocumentStoreError('NOT_FOUND', 'Recovery snapshot is unavailable.');
    const bytes = await readFile(join(this.blobs.root, name));
    const file = await open(destination, 'wx');
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  }

  close(discardPending = false): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.closeTask) return this.closeTask;
    this.closing = true;
    this.closeTask = (async () => {
      await this.tail;
      if (this.hasUnsavedChanges && !discardPending) throw new DocumentStoreError('UNSAVED', 'Your latest changes are not saved.');
      this.db.close();
      await this.releaseOwner?.();
      this.releaseOwner = null;
      this.closed = true;
    })().catch(error => { this.closeTask = null; this.closing = false; throw error; });
    return this.closeTask;
  }
}
