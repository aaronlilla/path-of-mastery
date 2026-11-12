import { parseId, type AtlasPlan, type DatasetRef, type LeagueStamp, type WriteDocumentRequest } from '@pom/mastery-contracts';
import { DocumentStoreError } from '../documents/store.js';
import { AtlasDomainError } from '../../shared/atlas/graph.js';
import { AtlasService } from './service.js';
import type { AtlasCatalogView } from './registry.js';

export const ATLAS_CHANNEL = 'mastery:atlas';
type Registrar = { handle(channel: string, handler: (event: unknown, input: unknown) => Promise<unknown>): void; removeHandler(channel: string): void };
const fields: Record<string, string[]> = {
  catalogs: [], catalog: ['dataset'], list: [], read: ['objectId', 'revisionId'], create: ['objectId', 'dataset', 'stamp', 'budget', 'title', 'idempotencyKey'],
  save: ['request', 'label'], allocate: ['objectId', 'expectedRevisionId', 'stepId', 'nodeId', 'idempotencyKey'],
  unallocate: ['objectId', 'expectedRevisionId', 'stepId', 'nodeId', 'idempotencyKey', 'confirmedRemovedIds'],
};
function catalogPayload(data: AtlasCatalogView) {
  return { ...data, graph: { graphHash: data.graph.graphHash, rootId: data.graph.rootId,
    nodes: [...data.graph.nodes.values()].map(node => ({ ...node, adjacentIds: [...data.graph.adjacent.get(node.nodeId)!] })) } };
}

export function registerAtlasIpc(ipc: Registrar, service: AtlasService, options: { isTrustedSender(event: unknown): boolean }): () => void {
  ipc.handle(ATLAS_CHANNEL, async (event, input) => {
    try {
      if (!options.isTrustedSender(event)) throw new AtlasDomainError('INVALID', 'Atlas access is unavailable.');
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AtlasDomainError('INVALID', 'Atlas request is invalid.');
      const call = input as Record<string, unknown>;
      if (call.schemaVersion !== 1 || typeof call.method !== 'string' || !Object.hasOwn(fields, call.method) ||
        Object.keys(call).some(key => !['schemaVersion', 'method', ...fields[call.method as string]!].includes(key))) throw new AtlasDomainError('INVALID', 'Atlas request is unsupported.');
      const text = (field: string) => {
        if (typeof call[field] !== 'string' || !call[field]) throw new AtlasDomainError('INVALID', 'Atlas request field is invalid.');
        return call[field] as string;
      };
      const objectId = () => parseId('object', text('objectId'));
      let value: unknown;
      switch (call.method) {
        case 'catalogs': value = service.registry.available(); break;
        case 'catalog': value = catalogPayload(service.registry.get(call.dataset as DatasetRef)); break;
        case 'list': value = service.list(); break;
        case 'read': {
          const view = await service.read(objectId(), call.revisionId === undefined ? undefined : parseId('revision', text('revisionId')));
          value = { ...view, data: view.data ? catalogPayload(view.data) : null }; break;
        }
        case 'create':
          if (typeof call.budget !== 'number' || (call.title !== undefined && typeof call.title !== 'string')) throw new AtlasDomainError('INVALID', 'Atlas creation fields are invalid.');
          value = await service.create({ objectId: objectId(), dataset: call.dataset as DatasetRef, stamp: call.stamp as LeagueStamp,
            budget: call.budget, title: call.title as string | undefined, idempotencyKey: text('idempotencyKey') }); break;
        case 'save':
          if (call.label !== undefined && typeof call.label !== 'string') throw new AtlasDomainError('INVALID', 'Edit label is invalid.');
          value = await service.save(call.request as WriteDocumentRequest<AtlasPlan>, call.label as string | undefined); break;
        case 'allocate': case 'unallocate': {
          const args = { objectId: objectId(), expectedRevisionId: parseId('revision', text('expectedRevisionId')),
            stepId: parseId('step', text('stepId')), nodeId: text('nodeId'), idempotencyKey: text('idempotencyKey') };
          if (call.method === 'allocate') value = await service.allocate(args);
          else {
            if (call.confirmedRemovedIds !== undefined && (!Array.isArray(call.confirmedRemovedIds) || call.confirmedRemovedIds.some(id => typeof id !== 'string'))) throw new AtlasDomainError('INVALID', 'Cascade confirmation is invalid.');
            value = await service.unallocate({ ...args, confirmedRemovedIds: call.confirmedRemovedIds as string[] | undefined });
          }
          break;
        }
      }
      return { ok: true, value };
    } catch (error) {
      const failure = error instanceof AtlasDomainError || error instanceof DocumentStoreError ? error
        : error instanceof TypeError ? new AtlasDomainError('INVALID', 'Atlas request is invalid.')
        : new DocumentStoreError('STORAGE_FAILED', 'Atlas operation failed. Your saved plan is preserved.');
      return { ok: false, error: { code: failure.code, message: failure.message } };
    }
  });
  return () => ipc.removeHandler(ATLAS_CHANNEL);
}
