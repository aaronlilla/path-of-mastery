import { parseId, type AtlasPlan, type ObjectId, type RevisionRef } from '@pom/mastery-contracts';
import type { AtlasService } from '../../../main/atlas/service.js';
import type { DocumentStore } from '../../../main/documents/store.js';
import { createCanvasModel } from '../canvas/model.js';
import type { AtlasEditorPort, EditorRecord } from './session.js';

export type AtlasLifecycleHost = Pick<AtlasEditorPort, 'move' | 'createFolder' | 'exportRecovery' | 'parse' | 'importNew' | 'exportFile' | 'share'> & {
  metadata(id: ObjectId): Promise<Pick<EditorRecord, 'ownership' | 'folderId' | 'lastOpenedAt'>>;
  enroll?(record: EditorRecord): Promise<void>;
};
// Compose in main or the fixture service. The app exposes these operations through its trusted bridge.
export function atlasServicePort(atlas: Pick<AtlasService, 'read' | 'save'>, documents: Pick<DocumentStore, 'list' | 'history' | 'revisionRef' | 'undo' | 'redo' | 'restore' | 'preview' | 'trash' | 'restoreTrash' | 'persistDraft' | 'pendingSnapshot'>, host: AtlasLifecycleHost): AtlasEditorPort {
  const read = async (id: ObjectId, revision?: RevisionRef['revisionId']): Promise<EditorRecord> => {
    const view = await atlas.read(id, revision), document = view.document, meta = await host.metadata(id);
    return { view, source: documents.revisionRef(id, document.revision.revisionId), history: documents.history(id), ...meta,
      recovery: revision ? undefined : documents.pendingSnapshot(id)?.request.payload as AtlasPlan | undefined,
      deletedAt: documents.list(true).find(row => row.objectId === id)?.trashedAt ?? null,
      canvas: view.data ? createCanvasModel({ datasetHash: view.data.ref.contentHash, graph: view.data.graph, geometry: view.data.geometry, nodeMetadata: view.data.nodeMetadata, layout: view.data.sourceLayout }) : undefined };
  };
  return { ...host, read,
    list: async () => Promise.all(documents.list(true).filter(row => row.kind === 'atlas').map(row => read(row.objectId, row.revisionId))),
    save: async (request, label) => { await atlas.save(request, label); return read(request.objectId); },
    create: async (payload: AtlasPlan, label: string) => { const id = parseId('object', crypto.randomUUID()); await atlas.save({ objectId: id, expectedRevisionId: null, payload, stamp: payload.stamp, idempotencyKey: crypto.randomUUID() }, label); const result = await read(id); await host.enroll?.(result); return result; },
    undo: async (id, source) => { await documents.undo(id, source.revisionId); return read(id); },
    redo: async (id, source) => { await documents.redo(id, source.revisionId); return read(id); },
    restore: async (id, source, revision) => { await documents.restore(id, source.revisionId, revision.revisionId, crypto.randomUUID()); return read(id); },
    preview: async (id, transaction) => { const snapshot = await documents.preview<AtlasPlan>(id, transaction); return read(id, snapshot.revision.revisionId); },
    trash: async id => { const current = await read(id); await documents.trash(id, current.source.revisionId); },
    restoreTrash: id => documents.restoreTrash(id),
    stageRecovery: (request, label) => documents.persistDraft('atlas', request, { label }),
  };
}
