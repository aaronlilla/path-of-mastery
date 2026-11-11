import { randomUUID } from 'node:crypto';
import { atlasPlanSchema, buildSnapshotSchema, documentEnvelopeSchema, editTransactionSchema, filterSnapshotSchema,
  localBuildSourceSchema, parseId, sourceSnapshotSchema, timelineBundleSchema, writeDocumentResponseSchema,
  type DocumentEnvelope, type EditTransaction, type ObjectId, type ObjectKind, type RevisionId, type Schema, type WriteDocumentResponse } from '@pom/mastery-contracts';
import { DocumentStore } from '../documents/store.js';
import { MarketplaceStore, MarketplaceLocalError, validate } from './store.js';
import type { MarketplaceTransport } from './api.js';
import { PublicCache } from './cache.js';
import { MarketplaceOutbox } from './outbox.js';

export type SyncConflict = { id: string; account: string; local: DocumentEnvelope<unknown>; remote: DocumentEnvelope<unknown>; keptCopy: ObjectId | null };
export class MarketplaceSync {
  constructor(readonly store: MarketplaceStore, private readonly api: MarketplaceTransport, private readonly outbox: MarketplaceOutbox,
    private readonly cache: PublicCache, private readonly documents?: DocumentStore) {}
  private account(): string { const account = this.outbox.currentAccount(); if (!account) throw new MarketplaceLocalError('ACCOUNT_CHANGED', 'Sign in to sync.'); return account; }
  async enrollSave(id: ObjectId, expectedRowVersion?: number): Promise<string> {
    const account = this.account(), ref = this.cache.reference(id), key = randomUUID();
    await this.outbox.enqueue('saves', { action: 'write', saveId: id, publishedRevision: ref.selectedRevision, stamp: ref.stamp,
      expectedRowVersion: expectedRowVersion ?? this.store.get<number>('cloud-versions', `${account}:${id}`) ?? 0, cacheStatus: ref.cacheStatus, idempotencyKey: key }, key);
    await this.store.serial(() => this.store.transaction(() => this.store.put('enrollment', `${account}:${id}`, { account, objectId: id })));
    return key;
  }
  async enrollCollection(id: ObjectId, expectedRowVersion?: number): Promise<void> {
    const account = this.account();
    const collection = this.cache.collections().find(item => item.objectId === id);
    if (!collection) throw new MarketplaceLocalError('INVALID', 'Collection was not found.');
    const key = randomUUID();
    await this.outbox.enqueue('collections', { action: 'write', collectionId: id, title: collection.title, stamp: collection.stamp,
      expectedRowVersion: expectedRowVersion ?? this.store.get<number>('cloud-versions', `${account}:${id}`) ?? 0, idempotencyKey: key }, key);
    for (const saveId of this.store.get<ObjectId[]>('members', id) ?? []) {
      await this.enrollSave(saveId); const memberKey = randomUUID();
      await this.outbox.enqueue('collections', { action: 'member', collectionId: id, saveId, present: true, idempotencyKey: memberKey }, memberKey);
    }
  }
  conflicts(): SyncConflict[] { const account = this.outbox.currentAccount(); return account ? this.store.list<SyncConflict>('conflicts').filter(item => item.account === account) : []; }
  private schema(kind: ObjectKind, value: unknown): Schema<unknown> {
    if (!['atlas', 'timeline', 'build', 'filter', 'notes', 'checklist'].includes(kind)) throw new MarketplaceLocalError('INVALID', 'Unsupported document kind.');
    const schema: Schema<unknown> | null = kind === 'atlas' ? atlasPlanSchema : kind === 'timeline' ? timelineBundleSchema
      : kind === 'build' ? (value && typeof value === 'object' && 'buildXml' in value ? localBuildSourceSchema : buildSnapshotSchema)
      : kind === 'filter' ? filterSnapshotSchema : null;
    return schema ?? { parse(input, limits) { const result = sourceSnapshotSchema.parse({ kind, payload: input }, limits);
      return result.ok ? { ok: true, value: result.value.payload } : result; } };
  }
  async pushDocument(input: DocumentEnvelope<unknown>, expectedRevisionId: RevisionId | null, history: EditTransaction[] = [], idempotencyKey = randomUUID()): Promise<WriteDocumentResponse | SyncConflict> {
    const account = this.account();
    const local = validate(documentEnvelopeSchema(input.kind, this.schema(input.kind, input.payload)), input, this.store.limits);
    const payload = local.payload;
    const body = { action: 'write', kind: local.kind, objectId: local.objectId, expectedRevisionId, revisionId: local.revision.revisionId,
      payload, stamp: local.revision.stamp, history: history.map(item => validate(editTransactionSchema, item, this.store.limits)), idempotencyKey };
    const result = await this.api.request<unknown>('sync', body, account);
    if (this.outbox.currentAccount() !== account) throw new MarketplaceLocalError('ACCOUNT_CHANGED', 'The account changed during sync.');
    if (result.ok) return validate(writeDocumentResponseSchema, result.value, this.store.limits);
    if (result.code !== 'REVISION_CONFLICT') throw new Error(result.message);
    const latest = await this.api.request<{ items: unknown[] }>('sync', { action: 'read', objectId: local.objectId }, account);
    if (this.outbox.currentAccount() !== account) throw new MarketplaceLocalError('ACCOUNT_CHANGED', 'The account changed during sync.');
    if (!latest.ok || !Array.isArray(latest.value.items) || latest.value.items.length !== 1) throw new Error('The conflicting cloud revision is unavailable.');
    const row = latest.value.items[0] as Record<string, unknown>;
    const remote = validate(documentEnvelopeSchema(row.kind as ObjectKind, this.schema(row.kind as ObjectKind, row.payload)), { schemaVersion: row.schemaVersion, objectId: row.objectId, kind: row.kind,
      revision: row.revision, payload: row.payload }, this.store.limits);
    if (remote.objectId !== local.objectId || remote.kind !== local.kind) throw new MarketplaceLocalError('INVALID', 'Cloud conflict belongs to another object.');
    const conflict: SyncConflict = { id: randomUUID(), account, local, remote, keptCopy: null };
    await this.store.serial(() => this.store.transaction(() => this.store.put('conflicts', conflict.id, conflict)));
    // Both immutable snapshots are durable before a copy or review is offered.
    if (this.documents) {
      const objectId = parseId('object', randomUUID());
      await this.documents.write(local.kind, { objectId, expectedRevisionId: null, payload: local.payload,
        stamp: local.revision.stamp, idempotencyKey: conflict.id }, { label: 'Keep both cloud revisions' });
      conflict.keptCopy = objectId;
      await this.store.serial(() => this.store.transaction(() => this.store.put('conflicts', conflict.id, conflict)));
    }
    return conflict;
  }
}
