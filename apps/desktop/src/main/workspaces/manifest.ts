import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  copyProvenanceSchema, leagueStampSchema, parseId, revisionRefSchema, workspaceManifestSchema,
  type CopyProvenance, type DocumentEnvelope, type Hash, type LeagueStamp, type ObjectId, type ObjectKind,
  type RevisionRef, type Schema, type ScopeKey, type TransactionId, type ValidationLimits, type WorkspaceManifest,
} from '@pom/mastery-contracts';
import { DocumentStore } from '../documents/store.js';
import { hashBytes } from '../documents/blobs.js';
import { acquireStoreOwner } from '../documents/owner.js';
import { openDb, type KbDb } from '../kb/db.js';
import {
  compareData, copyStamp, identityKey, referenceKey, resolveData, scopeFromStamp, scopeKey,
  type CompatibilityCatalog, type CompatibilityReport, type DataReference, type DataRepair,
} from '../../shared/documents/compatibility.js';
import { inspectLegacy, legacyKey, validateLegacyEntry, type LegacyEntry, type LegacySidecar } from './legacyScopes.js';

export class WorkspaceError extends Error {
  constructor(readonly code: 'INVALID' | 'NOT_FOUND' | 'CONFLICT' | 'UNSAVED' | 'STORAGE_FAILED' | 'CLOSED', message: string) { super(message); }
}
export type VerifiedScope = {
  key: ScopeKey;
  stamp: LeagueStamp;
  kind: 'temporary' | 'permanent';
  catalogRevision: Hash;
  evidenceId: string;
};
export type CatalogObservation = { status: 'verified'; scope: VerifiedScope } | { status: 'unverified'; reason: string };
export type WorkspaceOptions = {
  limits: ValidationLimits;
  documents: DocumentStore;
  /** Must drain all accepted document/legacy writes and reject any unsaved draft. */
  flushDirty(): Promise<void>;
  now?: () => Date;
  probe?: (point: 'beforeWorkspaceCommit' | 'afterWorkspaceCommit') => void;
};
export type CopyAdapter = {
  references(payload: unknown): DataReference[];
  catalog(target: VerifiedScope): Promise<CompatibilityCatalog | null>;
  copy(payload: unknown, context: {
    name: string; stamp: LeagueStamp; provenance: CopyProvenance;
    mapping: Map<string, DataReference | null> | null;
  }): unknown;
};
export type CopyRequest = {
  source: RevisionRef;
  target: ScopeKey;
  dataMode: CopyProvenance['dataMode'];
  name: string;
  repairs: DataRepair[];
  idempotencyKey: string;
};
type State = {
  schemaVersion: 1;
  activeKey: string;
  scopes: { scope: VerifiedScope; manifest: WorkspaceManifest }[];
  legacy: LegacySidecar[];
  copies: { key: string; fingerprint: Hash; objectId: ObjectId; provenance: CopyProvenance; response: RevisionRef | null }[];
};
const kinds: ObjectKind[] = ['build', 'atlas', 'filter', 'timeline', 'notes', 'checklist'];
const emptyMembership = (): WorkspaceManifest['membership'] => ({ build: [], atlas: [], filter: [], timeline: [], notes: [], checklist: [] });

export class WorkspaceService {
  readonly root: string;
  private db: KbDb | null = null;
  private releaseOwner: (() => Promise<void>) | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private closing = false;
  private closeTask: Promise<void> | null = null;

  constructor(userData: string, private readonly options: WorkspaceOptions) { this.root = join(userData, 'mastery', 'workspaces'); }
  private now(): string { return (this.options.now?.() ?? new Date()).toISOString(); }
  private checkpoint(): TransactionId { return parseId('transaction', randomUUID()); }
  private validate<T>(schema: Schema<T>, input: unknown): T {
    const result = schema.parse(input, this.options.limits);
    if (!result.ok) throw new WorkspaceError('INVALID', 'Workspace data is invalid.');
    return structuredClone(result.value);
  }
  private verified(input: VerifiedScope): VerifiedScope {
    const stamp = this.validate(leagueStampSchema, input.stamp);
    const key = scopeFromStamp(stamp);
    if (!key || scopeKey(key) !== scopeKey(input.key) || !input.evidenceId?.trim() || !['temporary', 'permanent'].includes(input.kind)) throw new WorkspaceError('INVALID', 'Verified league scope is required.');
    parseId('hash', input.catalogRevision);
    return structuredClone({ ...input, stamp });
  }
  private fresh(scope: VerifiedScope): State['scopes'][number] {
    return { scope, manifest: {
      schemaVersion: 1, stamp: scope.stamp, activeScope: scope.key, catalogRevision: scope.catalogRevision,
      membership: emptyMembership(), retainedScopes: [], transactionCheckpoint: this.checkpoint(),
    } };
  }
  async init(initial?: VerifiedScope): Promise<void> {
    if (this.db || this.closing) throw new WorkspaceError('CLOSED', 'Workspace service is already initialized.');
    await mkdir(this.root, { recursive: true });
    this.releaseOwner = await acquireStoreOwner(this.root);
    try {
      this.db = openDb(join(this.root, 'index.sqlite'));
      const version = this.db.get<{ user_version: number }>('PRAGMA user_version')!.user_version;
      if (version !== 0 && version !== 1) throw new WorkspaceError('INVALID', 'Workspace index version is unsupported.');
      this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS workspace_state(id INTEGER PRIMARY KEY CHECK(id=1), state TEXT NOT NULL); PRAGMA user_version=1;');
      if (!this.db.get('SELECT id FROM workspace_state WHERE id=1')) {
        if (!initial) throw new WorkspaceError('NOT_FOUND', 'Connect to load this league.');
        const scope = this.verified(initial);
        this.commit({ schemaVersion: 1, activeKey: scopeKey(scope.key), scopes: [this.fresh(scope)], legacy: [], copies: [] });
      }
      this.state();
    } catch (error) {
      this.db?.close(); this.db = null;
      await this.releaseOwner(); this.releaseOwner = null;
      throw error;
    }
  }
  private state(): State {
    if (!this.db) throw new WorkspaceError('CLOSED', 'Workspace service is closed.');
    const row = this.db.get<{ state: string }>('SELECT state FROM workspace_state WHERE id=1');
    if (!row) throw new WorkspaceError('INVALID', 'Workspace index is unavailable.');
    const state = JSON.parse(row.state) as State;
    if (state.schemaVersion !== 1 || !Array.isArray(state.scopes) || !Array.isArray(state.legacy) || !Array.isArray(state.copies)) throw new WorkspaceError('INVALID', 'Workspace index is invalid.');
    const keys = new Set<string>();
    for (const item of state.scopes) {
      item.scope = this.verified(item.scope);
      item.manifest = this.validate(workspaceManifestSchema, item.manifest);
      const key = scopeKey(item.scope.key);
      const manifestScope = scopeFromStamp(item.manifest.stamp);
      if (keys.has(key) || scopeKey(item.manifest.activeScope) !== key || !manifestScope || scopeKey(manifestScope) !== key || item.manifest.catalogRevision !== item.scope.catalogRevision) throw new WorkspaceError('INVALID', 'Workspace scope identity is invalid.');
      keys.add(key);
    }
    if (!keys.has(state.activeKey)) throw new WorkspaceError('INVALID', 'Active workspace is unavailable.');
    for (const sidecar of state.legacy) {
      validateLegacyEntry(sidecar); parseId('object', sidecar.objectId); parseId('hash', sidecar.contentHash);
      this.validate(leagueStampSchema, sidecar.stamp);
      if (sidecar.schemaVersion !== 1 || sidecar.compatibility !== 'unverified' || (sidecar.storageScope && !keys.has(scopeKey(sidecar.storageScope)))) throw new WorkspaceError('INVALID', 'Legacy scope index is invalid.');
    }
    for (const copy of state.copies) {
      parseId('object', copy.objectId); parseId('hash', copy.fingerprint);
      this.validate(copyProvenanceSchema, copy.provenance);
      if (copy.response) this.validate(revisionRefSchema, copy.response);
    }
    return state;
  }
  private commit(state: State): void {
    const db = this.db!;
    const legacyIds = new Set(state.legacy.map(item => item.objectId));
    for (const item of state.scopes) {
      for (const kind of ['build', 'filter'] as const) item.manifest.membership[kind] = item.manifest.membership[kind].filter(id => !legacyIds.has(id));
    }
    for (const sidecar of state.legacy) {
      if (sidecar.storageScope && sidecar.kind !== 'wealth') {
        const scope = this.find(state, sidecar.storageScope);
        scope.manifest.membership[sidecar.kind].push(sidecar.objectId);
      }
    }
    for (const item of state.scopes) {
      item.manifest.retainedScopes = state.scopes.filter(other => scopeKey(other.scope.key) !== scopeKey(item.scope.key)).map(other => structuredClone(other.scope.key));
      item.manifest = this.validate(workspaceManifestSchema, item.manifest);
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      db.run('INSERT INTO workspace_state(id,state) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state', [JSON.stringify(state)]);
      this.options.probe?.('beforeWorkspaceCommit');
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    this.options.probe?.('afterWorkspaceCommit');
  }
  private queue<T>(work: () => Promise<T>): Promise<T> {
    if (!this.db || this.closing) return Promise.reject(new WorkspaceError('CLOSED', 'Workspace service is closed.'));
    const next = this.tail.then(work, work);
    this.tail = next.catch(() => {});
    return next;
  }
  private find(state: State, key: ScopeKey): State['scopes'][number] {
    const scope = state.scopes.find(item => scopeKey(item.scope.key) === scopeKey(key));
    if (!scope) throw new WorkspaceError('NOT_FOUND', 'League workspace is not available on this PC.');
    return scope;
  }
  active(): WorkspaceManifest { const state = this.state(); return structuredClone(state.scopes.find(item => scopeKey(item.scope.key) === state.activeKey)!.manifest); }
  manifest(key: ScopeKey): WorkspaceManifest { return structuredClone(this.find(this.state(), key).manifest); }
  archives(): VerifiedScope[] { const state = this.state(); return state.scopes.filter(item => scopeKey(item.scope.key) !== state.activeKey).map(item => structuredClone(item.scope)); }

  private async flush(): Promise<void> {
    try {
      await this.options.flushDirty();
      if (this.options.documents.hasUnsavedChanges) throw new Error('Unsaved document draft.');
    }
    catch { throw new WorkspaceError('UNSAVED', 'Could not switch leagues. Your latest changes are not saved.'); }
  }
  observeCatalog(input: CatalogObservation): Promise<{ status: 'switched' | 'unchanged' | 'permanent_retained' | 'catalog_unverified'; manifest: WorkspaceManifest }> {
    const observation = structuredClone(input);
    return this.queue(async () => {
      if (observation.status !== 'verified') return { status: 'catalog_unverified', manifest: this.active() };
      const next = this.verified(observation.scope);
      const state = this.state();
      const current = state.scopes.find(item => scopeKey(item.scope.key) === state.activeKey)!;
      if (current.scope.kind === 'permanent') return { status: 'permanent_retained', manifest: this.active() };
      if (next.kind !== 'temporary' || scopeKey(next.key) === state.activeKey || state.scopes.some(item => scopeKey(item.scope.key) === scopeKey(next.key))) return { status: 'unchanged', manifest: this.active() };
      await this.flush();
      const staged = this.state();
      staged.scopes.push(this.fresh(next)); staged.activeKey = scopeKey(next.key);
      this.commit(staged);
      return { status: 'switched', manifest: this.active() };
    });
  }
  select(key: ScopeKey): Promise<WorkspaceManifest> {
    const selected = structuredClone(key);
    return this.queue(async () => {
      this.find(this.state(), selected);
      if (scopeKey(selected) === scopeKey(this.active().activeScope)) return this.active();
      await this.flush();
      const state = this.state(); const target = this.find(state, selected);
      state.activeKey = scopeKey(selected); target.manifest.transactionCheckpoint = this.checkpoint();
      this.commit(state); return this.active();
    });
  }
  createScope(input: VerifiedScope): Promise<WorkspaceManifest> {
    const scope = this.verified(input);
    return this.queue(async () => {
      const state = this.state();
      if (!state.scopes.some(item => scopeKey(item.scope.key) === scopeKey(scope.key))) { state.scopes.push(this.fresh(scope)); this.commit(state); }
      return this.manifest(scope.key);
    });
  }
  enroll(key: ScopeKey, kind: ObjectKind, objectId: ObjectId): Promise<WorkspaceManifest> {
    const selected = structuredClone(key);
    return this.queue(async () => {
      parseId('object', objectId);
      if (!kinds.includes(kind)) throw new WorkspaceError('INVALID', 'Object type is unsupported.');
      const document = await this.options.documents.read(objectId);
      if (document.kind !== kind) throw new WorkspaceError('INVALID', 'Object type does not match the saved document.');
      const state = this.state(); const target = this.find(state, selected);
      const stampedScope = scopeFromStamp(document.revision.stamp);
      if (!stampedScope || scopeKey(stampedScope) !== scopeKey(selected)) throw new WorkspaceError('INVALID', 'The saved object belongs to another or Unknown league.');
      if (!target.manifest.membership[kind].includes(objectId)) {
        target.manifest.membership[kind].push(objectId); target.manifest.transactionCheckpoint = this.checkpoint(); this.commit(state);
      }
      return this.manifest(selected);
    });
  }
  indexLegacy(entries: LegacyEntry[]): Promise<LegacySidecar[]> {
    const inventory = structuredClone(entries);
    return this.queue(async () => {
      const state = this.state(); const indexed: LegacySidecar[] = [];
      for (const entry of inventory) {
        validateLegacyEntry(entry);
        let sidecar = state.legacy.find(item => legacyKey(item) === legacyKey(entry));
        if (!sidecar) {
          sidecar = await inspectLegacy(entry, this.options.limits, this.now());
          if (sidecar.storageScope && !state.scopes.some(item => scopeKey(item.scope.key) === scopeKey(sidecar!.storageScope!))) sidecar.storageScope = null;
          state.legacy.push(sidecar);
        }
        indexed.push(sidecar);
      }
      for (const item of state.scopes) item.manifest.transactionCheckpoint = this.checkpoint();
      this.commit(state); return structuredClone(indexed);
    });
  }
  legacy(scope?: ScopeKey | null): LegacySidecar[] {
    return structuredClone(this.state().legacy.filter(item => scope === undefined || (scope === null ? item.storageScope === null : item.storageScope !== null && scopeKey(item.storageScope) === scopeKey(scope))));
  }
  attributeLegacy(objectId: ObjectId, key: ScopeKey): Promise<LegacySidecar> {
    const selected = structuredClone(key);
    return this.queue(async () => {
      const state = this.state(); const target = this.find(state, selected);
      const sidecar = state.legacy.find(item => item.objectId === objectId);
      if (!sidecar) throw new WorkspaceError('NOT_FOUND', 'Legacy item is unavailable.');
      sidecar.storageScope = target.scope.key; sidecar.attributedAt = this.now();
      // Attribution is a storage choice. Original source evidence, including Unknown, is preserved.
      for (const item of state.scopes) item.manifest.transactionCheckpoint = this.checkpoint();
      this.commit(state); return structuredClone(sidecar);
    });
  }
  private async source(pin: RevisionRef): Promise<DocumentEnvelope<unknown>> {
    const parsed = this.validate(revisionRefSchema, pin);
    const actual = this.validate(revisionRefSchema, this.options.documents.revisionRef(parsed.objectId, parsed.revisionId));
    if (hashBytes(JSON.stringify(actual)) !== hashBytes(JSON.stringify(parsed))) throw new WorkspaceError('CONFLICT', 'Source revision does not match the saved snapshot.');
    return this.options.documents.readRevision(parsed.objectId, parsed.revisionId);
  }
  provenance(objectId: ObjectId): CopyProvenance | null {
    parseId('object', objectId);
    const copy = this.state().copies.find(item => item.objectId === objectId);
    return copy ? structuredClone(copy.provenance) : null;
  }
  async compatibility(pin: RevisionRef, target: ScopeKey, adapter: CopyAdapter): Promise<CompatibilityReport> {
    const source = await this.source(pin); const scope = this.find(this.state(), target).scope;
    const catalog = await adapter.catalog(structuredClone(scope));
    const available = catalog?.datasetVersion.status === 'known' && scope.stamp.datasetVersion.status === 'known'
      && catalog.datasetVersion.value === scope.stamp.datasetVersion.value;
    return compareData(adapter.references(structuredClone(source.payload)), available ? catalog : null);
  }
  copy(input: CopyRequest, adapter: CopyAdapter): Promise<RevisionRef> {
    const request = structuredClone(input);
    return this.queue(async () => {
      if (!request.name?.trim() || !request.idempotencyKey?.trim() || !['source_data', 'target_data'].includes(request.dataMode)) throw new WorkspaceError('INVALID', 'Copy request is invalid.');
      const source = await this.source(request.source);
      let state = this.state(); const target = this.find(state, request.target);
      const fingerprint = hashBytes(JSON.stringify(request));
      let reservation = state.copies.find(copy => copy.key === request.idempotencyKey);
      if (reservation && reservation.fingerprint !== fingerprint) throw new WorkspaceError('CONFLICT', 'Copy key was already used for another request.');
      if (reservation?.response) return structuredClone(reservation.response);
      if (!reservation) {
        reservation = { key: request.idempotencyKey, fingerprint, objectId: parseId('object', randomUUID()), provenance: { source: request.source, dataMode: request.dataMode }, response: null };
        state.copies.push(reservation); this.commit(state);
      }
      // A committed document may precede membership after a crash. Reuse its reserved ID on retry.
      const existing = this.options.documents.list(true).find(item => item.objectId === reservation!.objectId);
      let response: RevisionRef;
      if (existing) response = this.options.documents.history(existing.objectId).events[0]!.after;
      else {
        const refs = adapter.references(structuredClone(source.payload));
        compareData(refs, null);
        let mapping: Map<string, DataReference | null> | null = null;
        const stamp = copyStamp(source.revision.stamp, target.scope.stamp, request.dataMode, this.now());
        if (request.dataMode === 'target_data') {
          const catalog = await adapter.catalog(structuredClone(target.scope));
          if (!catalog || catalog.datasetVersion.status === 'unknown') throw new WorkspaceError('INVALID', 'Target data is not available.');
          if (target.scope.stamp.datasetVersion.status !== 'known' || catalog.datasetVersion.value !== target.scope.stamp.datasetVersion.value) throw new WorkspaceError('INVALID', 'Target dataset does not match the selected workspace.');
          mapping = resolveData(refs, catalog, request.repairs);
        } else if (request.repairs.length) throw new WorkspaceError('INVALID', 'Source-data copies cannot apply target-data repairs.');
        const provenance: CopyProvenance = { source: request.source, dataMode: request.dataMode };
        const payload = adapter.copy(structuredClone(source.payload), { name: request.name, stamp, provenance: structuredClone(provenance), mapping });
        if (mapping) {
          const expected = new Map([...mapping.values()].filter((ref): ref is DataReference => ref !== null).map(ref => [identityKey(ref), ref]));
          const actual = adapter.references(structuredClone(payload));
          compareData(actual, null);
          if (actual.length !== expected.size || actual.some(ref => {
            const targetRef = expected.get(identityKey(ref));
            return !targetRef || referenceKey(ref) !== referenceKey(targetRef);
          })) throw new WorkspaceError('INVALID', 'Copy adapter did not apply the reviewed ID repairs.');
        } else {
          const actual = adapter.references(structuredClone(payload));
          compareData(actual, null);
          const expected = new Set(refs.map(referenceKey));
          if (actual.length !== expected.size || actual.some(ref => !expected.has(referenceKey(ref)))) throw new WorkspaceError('INVALID', 'Source-data copy changed its data references.');
        }
        response = (await this.options.documents.write(source.kind, {
          objectId: reservation.objectId, expectedRevisionId: null, payload, stamp, idempotencyKey: request.idempotencyKey,
        }, { label: `Copy source revision ${request.source.revisionId}` })).revision;
      }
      state = this.state(); const destination = this.find(state, request.target);
      if (!destination.manifest.membership[source.kind].includes(response.objectId)) destination.manifest.membership[source.kind].push(response.objectId);
      destination.manifest.transactionCheckpoint = this.checkpoint();
      state.copies.find(copy => copy.key === request.idempotencyKey)!.response = response;
      this.commit(state); return structuredClone(response);
    });
  }
  close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.closing = true;
    this.closeTask = (async () => { await this.tail; this.db?.close(); this.db = null; await this.releaseOwner?.(); this.releaseOwner = null; })();
    return this.closeTask;
  }
}
