import { parseId, type AtlasDataset, type AtlasPlan, type DocumentEnvelope, type EditTransaction, type ObjectId, type RevisionRef, type TransactionId } from '@pom/mastery-contracts';
import { createGraph, known } from '../../../shared/atlas/graph.js';
import { createCanvasModel } from '../canvas/model.js';
import { historyPath, redoTransaction } from '../../../shared/documents/history.js';
import type { AtlasEditorPort, EditorRecord } from './session.js';

type Stored = { id: ObjectId; current: RevisionRef; payload: AtlasPlan; events: EditTransaction[]; snapshots: Record<string, AtlasPlan>; cursor: TransactionId; tip: TransactionId; folder: string | null; opened: string; deleted: string | null };
export type FixtureStorage = { load: () => string | null; save: (json: string) => void };
export class SyntheticRepository {
  private objects: Stored[];
  failNext = false;
  readonly folders: { id: string; title: string }[] = [];
  constructor(readonly data: AtlasDataset, private readonly storage?: FixtureStorage) { this.objects = JSON.parse(storage?.load() ?? '[]') as Stored[]; }
  private persist() { if (this.failNext) { this.failNext = false; throw new Error('Synthetic storage fault.'); } this.storage?.save(JSON.stringify(this.objects)); }
  private object(id: ObjectId) { const value = this.objects.find(o => o.id === id); if (!value) throw new Error('Missing synthetic object.'); return value; }
  private pin(id: ObjectId, payload: AtlasPlan): RevisionRef { return { objectId: id, revisionId: parseId('revision', crypto.randomUUID()), stamp: structuredClone(payload.stamp), payloadHash: this.data.ref.contentHash, fallbackSnapshotHash: this.data.ref.contentHash }; }
  private record(object: Stored, source = object.current, payload = object.payload): EditorRecord {
    const graph = createGraph(this.data.graph, known(this.data.costModel, 'synthetic-fixture'));
    const canvas = createCanvasModel({ datasetHash: this.data.ref.contentHash, graph, geometry: Object.fromEntries(this.data.graph.nodes.map((node, index) => [node.nodeId, { position: known({ x: index * 90 - 180, y: index % 2 === 0 ? 0 : 90 }, 'synthetic-fixture') }])) });
    const document: DocumentEnvelope<AtlasPlan> = { schemaVersion: 1, objectId: object.id, kind: 'atlas', revision: { revisionId: source.revisionId, parentRevisionId: null, schemaVersion: 1, payloadHash: source.payloadHash, stamp: source.stamp }, payload: structuredClone(payload) };
    return { source: structuredClone(source), view: { document, data: { ref: this.data.ref, qualification: 'unverified', isCurrent: false, liveCompatibility: { status: 'unknown', reason: 'Synthetic fixture.' }, statusText: 'Live compatibility unverified', warnings: [], exportTag: this.data.exportTag, cdnPatchId: 'synthetic', costs: known(this.data.costModel, 'synthetic-fixture'), graph, catalogs: this.data.catalogs, taxonomy: this.data.taxonomy, catalogMetadata: {}, geometry: {}, sourceLayout: { groups: {}, constants: {}, sprites: {}, bounds: {} }, nodeMetadata: {}, assets: [] }, warnings: [], steps: {} }, canvas,
      history: { events: structuredClone(object.events), cursor: object.cursor, tip: object.tip }, ownership: 'owned', folderId: object.folder, lastOpenedAt: object.opened, deletedAt: object.deleted };
  }
  async create(payload: AtlasPlan, label = 'Created plan') {
    const id = parseId('object', crypto.randomUUID()), source = this.pin(id, payload), tx = parseId('transaction', crypto.randomUUID());
    const event: EditTransaction = { schemaVersion: 1, transactionId: tx, parentTransactionId: null, branchId: crypto.randomUUID(), before: source, after: source, commands: [], stamp: payload.stamp, createdAt: new Date().toISOString(), label };
    const object: Stored = { id, current: source, payload: structuredClone(payload), events: [event], snapshots: { [source.revisionId]: structuredClone(payload) }, cursor: tx, tip: tx, folder: null, opened: new Date().toISOString(), deleted: null };
    this.objects.push(object); try { this.persist(); } catch (error) { this.objects.pop(); throw error; } return this.record(object);
  }
  async read(id: ObjectId, revision?: RevisionRef['revisionId']) {
    const object = this.object(id);
    if (revision) { const event = object.events.find(e => e.after.revisionId === revision); if (!event) throw new Error('Missing revision.'); return this.record(object, event.after, object.snapshots[revision]!); }
    return this.record(object);
  }
  async save(request: Parameters<AtlasEditorPort['save']>[0], label: string) {
    const object = this.object(request.objectId);
    if (object.current.revisionId !== request.expectedRevisionId) throw new Error('Conflict.');
    if (this.failNext) { this.failNext = false; throw new Error('Synthetic storage fault.'); }
    const previous = structuredClone(object), source = this.pin(object.id, request.payload), tx = parseId('transaction', crypto.randomUUID());
    const branch = object.cursor === object.tip ? object.events.find(e => e.transactionId === object.tip)!.branchId : crypto.randomUUID();
    const event: EditTransaction = { schemaVersion: 1, transactionId: tx, parentTransactionId: object.cursor, branchId: branch, before: object.current, after: source, commands: [], stamp: request.stamp, createdAt: new Date().toISOString(), label };
    object.current = source; object.payload = structuredClone(request.payload); object.events.push(event); object.snapshots[source.revisionId] = structuredClone(request.payload); object.cursor = tx; object.tip = tx;
    try { this.persist(); } catch (error) { Object.assign(object, previous); throw error; } return this.record(object);
  }
  async moveHistory(id: ObjectId, source: RevisionRef, direction: 'undo' | 'redo') {
    const object = this.object(id); if (object.current.revisionId !== source.revisionId) throw new Error('Conflict.');
    const active = object.events.find(e => e.transactionId === object.cursor)!;
    const target = direction === 'undo' ? object.events.find(e => e.transactionId === active.parentTransactionId) : redoTransaction(object.events, object.cursor, object.tip);
    if (target) { const before = structuredClone(object); object.payload = structuredClone(object.snapshots[target.after.revisionId]!); object.current = this.pin(id, object.payload); object.cursor = target.transactionId; try { this.persist(); } catch (e) { Object.assign(object, before); throw e; } }
    return this.record(object);
  }
  port(extras: Pick<AtlasEditorPort, 'parse' | 'importNew' | 'exportFile' | 'share' | 'exportRecovery'>): AtlasEditorPort {
    return { ...extras, list: async () => this.objects.map(o => this.record(o)), read: (id, revision) => this.read(id, revision), create: (plan, label) => this.create(plan, label), save: (request, label) => this.save(request, label),
      undo: (id, pin) => this.moveHistory(id, pin, 'undo'), redo: (id, pin) => this.moveHistory(id, pin, 'redo'),
      restore: async (id, source, revision) => this.save({ objectId: id, expectedRevisionId: source.revisionId, payload: structuredClone(this.object(id).snapshots[revision.revisionId]!), stamp: revision.stamp, idempotencyKey: crypto.randomUUID() }, 'Restored revision'),
      preview: async (id, tx) => { const object = this.object(id), event = historyPath(object.events, tx).at(-1)!; return this.record(object, event.after, object.snapshots[event.after.revisionId]!); },
      trash: async id => { this.object(id).deleted = new Date().toISOString(); this.persist(); }, restoreTrash: async id => { this.object(id).deleted = null; this.persist(); },
      move: async (id, folder) => { this.object(id).folder = folder; this.persist(); }, createFolder: async title => { this.folders.push({ id: crypto.randomUUID(), title }); },
    };
  }
}
