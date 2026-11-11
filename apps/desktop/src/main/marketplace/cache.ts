import { randomUUID } from 'node:crypto';
import { collectionSchema, leagueStampSchema, parseId, publicItemPayloadSchema, publishedRevisionRefSchema, savedItemSchema,
  type AssetRef, type Collection, type Hash, type LeagueStamp, type ObjectId, type PublicId, type PublicItemPayload,
  type PublishedRevisionRef, type SavedItem } from '@pom/mastery-contracts';
import { hashBytes } from '../documents/blobs.js';
import { MarketplaceStore, MarketplaceLocalError, validate } from './store.js';
import type { MarketplaceTransport } from './api.js';

export type SavedReference = { objectId: ObjectId; publicId: PublicId; selectedRevision: PublishedRevisionRef; stamp: LeagueStamp;
  cacheStatus: 'download_needed' | 'ready'; blob: Hash | null; originalRemoved: boolean; updatedRevision: PublishedRevisionRef | null };
export type AssetReader = (asset: AssetRef) => Promise<Uint8Array>;
const samePin = (a: PublishedRevisionRef, b: PublishedRevisionRef) => a.postId === b.postId && a.revisionId === b.revisionId && a.displayRevision === b.displayRevision;
export class PublicCache {
  constructor(readonly store: MarketplaceStore, private readonly api: MarketplaceTransport, private readonly assets?: AssetReader) {}
  list(): SavedReference[] { return this.store.list('saves'); }
  reference(id: ObjectId): SavedReference {
    parseId('object', id); const ref = this.store.get<SavedReference>('saves', id);
    if (!ref) throw new MarketplaceLocalError('INVALID', 'Saved item was not found.'); return ref;
  }
  async reserve(publicId: PublicId, selectedRevision: PublishedRevisionRef, stamp: LeagueStamp): Promise<SavedReference> {
    parseId('public', publicId); selectedRevision = validate(publishedRevisionRefSchema, selectedRevision, this.store.limits);
    stamp = validate(leagueStampSchema, stamp, this.store.limits);
    return this.store.serial(() => {
      const existing = this.list().find(ref => ref.publicId === publicId && samePin(ref.selectedRevision, selectedRevision));
      if (existing) return existing;
      const ref: SavedReference = { objectId: parseId('object', randomUUID()), publicId, selectedRevision, stamp,
        cacheStatus: 'download_needed', blob: null, originalRemoved: false, updatedRevision: null };
      this.store.transaction(() => this.store.put('saves', ref.objectId, ref)); return ref;
    });
  }
  private async prepare(id: ObjectId, input: unknown): Promise<{ saved: SavedItem; blob: Hash }> {
    const payload = validate(publicItemPayloadSchema, input, this.store.limits);
    const required = payload.document.kind === 'timeline' ? payload.document.payload.assets : [];
    for (const asset of required) {
      const stored = this.store.get<Hash>('assets', asset.contentHash);
      if (stored) { await this.store.blobs.read(stored); continue; }
      if (!this.assets) throw new MarketplaceLocalError('DOWNLOAD_NEEDED', 'Download needed.');
      const bytes = await this.assets(asset);
      if (bytes.byteLength > this.store.limits.maxBytes || hashBytes(bytes) !== asset.contentHash) throw new MarketplaceLocalError('INVALID', 'Asset hash does not match its content.');
      const blob = await this.store.blobs.put(Buffer.from(bytes).toString('base64'));
      this.store.transaction(() => this.store.put('assets', asset.contentHash, blob));
    }
    const sourceHash = hashBytes(JSON.stringify(payload.document));
    const old = this.reference(id);
    const prior = old.blob ? validate(savedItemSchema, JSON.parse(await this.store.blobs.read(old.blob)), this.store.limits) : null;
    const saved = validate(savedItemSchema, { schemaVersion: 1, objectId: id, stamp: old.stamp,
      selectedRevision: payload.publishedRevision, source: { objectId: prior?.source.objectId ?? parseId('object', randomUUID()),
        revisionId: payload.publishedRevision.revisionId, payloadHash: sourceHash, fallbackSnapshotHash: sourceHash, stamp: payload.stamp }, cachedPayload: payload }, this.store.limits);
    return { saved, blob: await this.store.blobs.put(JSON.stringify(saved)) };
  }
  async save(input: PublicItemPayload): Promise<SavedReference> {
    const payload = validate(publicItemPayloadSchema, input, this.store.limits);
    const ref = await this.reserve(payload.publicId, payload.publishedRevision, payload.stamp);
    await this.store.serial(async () => {
      const ready = await this.prepare(ref.objectId, payload);
      this.store.transaction(() => { this.store.put('saves', ref.objectId, { ...this.reference(ref.objectId), blob: ready.blob, cacheStatus: 'ready' });
        this.store.put('sources', ref.objectId, ready.saved.source); });
    });
    return this.reference(ref.objectId);
  }
  async download(id: ObjectId): Promise<SavedReference> {
    const pin = this.reference(id);
    const result = await this.api.request<PublicItemPayload>('item', { publicId: pin.publicId, revision: pin.selectedRevision.displayRevision }, null);
    if (!result.ok) {
      if (result.code === 'UNAVAILABLE') await this.store.serial(() => this.store.transaction(() => this.store.put('saves', id, { ...this.reference(id), originalRemoved: true })));
      return this.reference(id);
    }
    const payload = validate(publicItemPayloadSchema, result.value, this.store.limits);
    if (payload.publicId !== pin.publicId || !samePin(payload.publishedRevision, pin.selectedRevision)) throw new MarketplaceLocalError('INVALID', 'Downloaded revision does not match the saved reference.');
    await this.store.serial(async () => {
      const current = this.reference(id);
      if (!samePin(current.selectedRevision, pin.selectedRevision)) throw new MarketplaceLocalError('CONFLICT', 'The saved revision changed.');
      const ready = await this.prepare(id, payload);
      this.store.transaction(() => { this.store.put('saves', id, { ...current, blob: ready.blob, cacheStatus: 'ready' }); this.store.put('sources', id, ready.saved.source); });
    }); return this.reference(id);
  }
  async open(id: ObjectId): Promise<{ saved: SavedItem; originalRemoved: boolean }> {
    const ref = this.reference(id);
    if (!ref.blob || ref.cacheStatus !== 'ready') throw new MarketplaceLocalError('DOWNLOAD_NEEDED', 'Download needed.');
    const saved = validate(savedItemSchema, JSON.parse(await this.store.blobs.read(ref.blob)), this.store.limits);
    if (!samePin(saved.selectedRevision, ref.selectedRevision)) throw new MarketplaceLocalError('INVALID', 'Cached revision does not match its reference.');
    const assets = saved.cachedPayload.document.kind === 'timeline' ? saved.cachedPayload.document.payload.assets : [];
    for (const asset of assets) { const blob = this.store.get<Hash>('assets', asset.contentHash);
      if (!blob || hashBytes(Buffer.from(await this.store.blobs.read(blob), 'base64')) !== asset.contentHash) throw new MarketplaceLocalError('DOWNLOAD_NEEDED', 'Download needed.'); }
    return { saved, originalRemoved: ref.originalRemoved };
  }
  async previewUpdate(id: ObjectId): Promise<PublicItemPayload | null> {
    const ref = this.reference(id); const result = await this.api.request<PublicItemPayload>('item', { publicId: ref.publicId }, null);
    if (!result.ok) {
      if (result.code === 'UNAVAILABLE') await this.store.serial(() => this.store.transaction(() => this.store.put('saves', id, { ...this.reference(id), originalRemoved: true })));
      return null;
    }
    const payload = validate(publicItemPayloadSchema, result.value, this.store.limits);
    if (payload.publicId !== ref.publicId || payload.publishedRevision.postId !== ref.selectedRevision.postId) throw new MarketplaceLocalError('INVALID', 'Update belongs to another post.');
    await this.store.serial(() => this.store.transaction(() => this.store.put('saves', id, { ...this.reference(id), updatedRevision: samePin(ref.selectedRevision, payload.publishedRevision) ? null : payload.publishedRevision })));
    return payload;
  }
  async applyUpdate(id: ObjectId, expected: PublishedRevisionRef, input: PublicItemPayload): Promise<void> {
    const payload = validate(publicItemPayloadSchema, input, this.store.limits);
    await this.store.serial(async () => {
      const ref = this.reference(id);
      if (!samePin(expected, ref.selectedRevision) || !ref.updatedRevision || !samePin(ref.updatedRevision, payload.publishedRevision) || payload.publicId !== ref.publicId) {
        throw new MarketplaceLocalError('CONFLICT', 'Preview this update before applying it.');
      }
      const ready = await this.prepare(id, payload);
      this.store.transaction(() => {
        this.store.put('saves', id, { ...ref, selectedRevision: payload.publishedRevision, blob: ready.blob, cacheStatus: 'ready', updatedRevision: null });
        this.store.put('sources', id, ready.saved.source);
        for (const collection of this.collections()) {
          const membership = this.store.get<ObjectId[]>('members', collection.objectId) ?? [];
          if (membership.includes(id)) this.writeCollection(collection, membership);
        }
      });
    });
  }
  collections(): Collection[] { return this.store.list('collections'); }
  async createCollection(title: string, stamp: LeagueStamp): Promise<Collection> {
    if ([...title].length < 1 || [...title].length > 80 || !title.trim()) throw new MarketplaceLocalError('INVALID', 'Collection names need 1-80 characters.');
    const collection = validate(collectionSchema, { schemaVersion: 1, objectId: parseId('object', randomUUID()), title, stamp, members: [] }, this.store.limits);
    await this.store.serial(() => this.store.transaction(() => this.writeCollection(collection, []))); return collection;
  }
  private writeCollection(collection: Collection, ids: ObjectId[]): void {
    const members = ids.map(id => { const ref = this.reference(id); const source = this.store.get<SavedItem['source']>('sources', id);
      return source ? { publishedRevision: ref.selectedRevision, source } : null; }).filter((member): member is Collection['members'][number] => member !== null);
    this.store.put('collections', collection.objectId, { ...collection, members }); this.store.put('members', collection.objectId, ids);
  }
  async setMember(collectionId: ObjectId, saveId: ObjectId, present: boolean): Promise<void> {
    const opened = await this.open(saveId);
    await this.store.serial(() => this.store.transaction(() => {
      const collection = this.store.get<Collection>('collections', collectionId);
      if (!collection) throw new MarketplaceLocalError('INVALID', 'Collection was not found.');
      this.store.put('sources', saveId, opened.saved.source);
      const ids = new Set(this.store.get<ObjectId[]>('members', collectionId) ?? []); present ? ids.add(saveId) : ids.delete(saveId);
      this.writeCollection(collection, [...ids]);
    }));
  }
  async remove(id: ObjectId): Promise<SavedReference> {
    return this.store.serial(() => this.store.transaction(() => {
      const ref = this.reference(id);
      const memberships = this.collections().filter(collection => (this.store.get<ObjectId[]>('members', collection.objectId) ?? []).includes(id)).map(collection => collection.objectId);
      this.store.put('removed', id, ref); this.store.put('removed-members', id, memberships); this.store.remove('saves', id);
      for (const collection of this.collections()) this.writeCollection(collection, (this.store.get<ObjectId[]>('members', collection.objectId) ?? []).filter(member => member !== id));
      return ref;
    }));
  }
  async undoRemove(ref: SavedReference): Promise<void> {
    await this.store.serial(() => this.store.transaction(() => {
      if (this.store.get('saves', ref.objectId)) throw new MarketplaceLocalError('CONFLICT', 'This reference was already restored.');
      this.store.put('saves', ref.objectId, ref);
      for (const id of this.store.get<ObjectId[]>('removed-members', ref.objectId) ?? []) {
        const collection = this.store.get<Collection>('collections', id);
        if (collection) this.writeCollection(collection, [...new Set([...(this.store.get<ObjectId[]>('members', id) ?? []), ref.objectId])]);
      }
      this.store.remove('removed', ref.objectId); this.store.remove('removed-members', ref.objectId);
    }));
  }
}
