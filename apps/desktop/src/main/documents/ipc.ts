import { parseId, type ObjectKind, type WriteDocumentRequest } from '@pom/mastery-contracts';
import { DocumentStore, DocumentStoreError, type EditOptions } from './store.js';

export const DOCUMENT_CHANNEL = 'mastery:documents';
type IpcRegistrar = { handle(channel: string, handler: (event: unknown, input: unknown) => Promise<unknown>): void; removeHandler(channel: string): void };
type IpcOptions = { isTrustedSender(event: unknown): boolean; chooseRecoveryDestination(): Promise<string | null> };

const fields: Record<string, string[]> = {
  list: ['includeTrash'], read: ['objectId', 'revisionId'], history: ['objectId'], preview: ['objectId', 'transactionId'],
  write: ['kind', 'request', 'edit'], draft: ['kind', 'request', 'edit'], undo: ['objectId', 'expectedRevisionId'],
  redo: ['objectId', 'expectedRevisionId'], restore: ['objectId', 'expectedRevisionId', 'sourceRevisionId', 'idempotencyKey'],
  trash: ['objectId', 'expectedRevisionId'], restoreTrash: ['objectId'], recovery: ['objectId'], retry: ['objectId'], exportRecovery: ['objectId'],
};

/** The mastery wiring supplies the main-window sender check and native save dialog, then calls this once. */
export function registerDocumentIpc(ipc: IpcRegistrar, store: DocumentStore, options: IpcOptions): () => void {
  ipc.handle(DOCUMENT_CHANNEL, async (event, input) => {
    try {
      if (!options.isTrustedSender(event)) throw new DocumentStoreError('INVALID', 'Document access is unavailable.');
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new DocumentStoreError('INVALID', 'Document request is invalid.');
      const call = input as Record<string, unknown>;
      if (call.schemaVersion !== 1 || typeof call.method !== 'string' || !Object.hasOwn(fields, call.method)) throw new DocumentStoreError('INVALID', 'Document request is unsupported.');
      const allowed = ['schemaVersion', 'method', ...fields[call.method]!];
      if (Object.keys(call).some(key => !allowed.includes(key))) throw new DocumentStoreError('INVALID', 'Document request has unsupported fields.');
      const id = () => parseId('object', call.objectId as string);
      const expected = () => parseId('revision', call.expectedRevisionId as string);
      const writeArgs = (): [ObjectKind, WriteDocumentRequest<unknown>, EditOptions] => {
        if (!['build', 'atlas', 'filter', 'timeline', 'notes', 'checklist'].includes(call.kind as string)) throw new DocumentStoreError('INVALID', 'Document type is unsupported.');
        return [call.kind as ObjectKind, call.request as WriteDocumentRequest<unknown>, call.edit as EditOptions];
      };
      let value: unknown;
      switch (call.method) {
        case 'list':
          if (call.includeTrash !== undefined && typeof call.includeTrash !== 'boolean') throw new DocumentStoreError('INVALID', 'Trash selection is invalid.');
          value = store.list(call.includeTrash === true); break;
        case 'read': value = call.revisionId === undefined ? await store.read(id()) : await store.readRevision(id(), parseId('revision', call.revisionId as string)); break;
        case 'history': value = store.history(id()); break;
        case 'preview': value = await store.preview(id(), parseId('transaction', call.transactionId as string)); break;
        case 'write': value = await store.write(...writeArgs()); break;
        case 'draft': value = await store.persistDraft(...writeArgs()); break;
        case 'undo': value = await store.undo(id(), expected()); break;
        case 'redo': value = await store.redo(id(), expected()); break;
        case 'restore':
          if (typeof call.idempotencyKey !== 'string') throw new DocumentStoreError('INVALID', 'Save key is invalid.');
          value = await store.restore(id(), expected(), parseId('revision', call.sourceRevisionId as string), call.idempotencyKey); break;
        case 'trash': value = await store.trash(id(), expected()); break;
        case 'restoreTrash': value = await store.restoreTrash(id()); break;
        case 'recovery': value = await store.recoverDraft(id()); break;
        case 'retry': value = await store.retry(id()); break;
        case 'exportRecovery': {
          const objectId = id();
          const destination = await options.chooseRecoveryDestination();
          if (destination) await store.exportRecovery(objectId, destination);
          value = { exported: destination !== null }; break;
        }
      }
      return { ok: true, value: value ?? null };
    } catch (error) {
      const failure = error instanceof DocumentStoreError ? error : error instanceof TypeError
        ? new DocumentStoreError('INVALID', 'Document request is invalid.')
        : new DocumentStoreError('STORAGE_FAILED', 'Document operation failed. Your pending changes are retained.');
      return { ok: false, error: { code: failure.code, message: failure.message } };
    }
  });
  return () => ipc.removeHandler(DOCUMENT_CHANNEL);
}
