import { parseId, type WriteDocumentRequest, type Timeline } from '@pom/mastery-contracts';
import { TimelineService } from './service.js';

export const TIMELINE_CHANNEL = 'mastery:timelines';
type Registrar = { handle(channel: string, handler: (event: unknown, input: unknown) => Promise<unknown>): void; removeHandler(channel: string): void };
const fields: Record<string, string[]> = { list: ['includeTrash'], read: ['objectId', 'revisionId'], create: ['title', 'idempotencyKey', 'objectId'], save: ['request', 'label'],
  send: ['objectId', 'expectedRevisionId', 'source', 'laneId', 'range', 'choice', 'idempotencyKey'], import: ['text', 'idempotencyKey', 'objectId'], export: ['objectId'], share: ['objectId'],
  run: ['objectId', 'expectedRevisionId', 'omittedClipIds', 'manualStart', 'replaceCurrent'], addLanes: ['objectId', 'expectedRevisionId', 'bundle', 'sourceRevision', 'laneIds', 'insertionId', 'idempotencyKey'], undo: ['objectId', 'expectedRevisionId'], redo: ['objectId', 'expectedRevisionId'], trash: ['objectId', 'expectedRevisionId'], restoreTrash: ['objectId'] };
export function registerTimelineIpc(ipc: Registrar, service: TimelineService, isTrustedSender: (event: unknown) => boolean): () => void {
  ipc.handle(TIMELINE_CHANNEL, async (event, input) => {
    try {
      if (!isTrustedSender(event)) throw new Error('Timeline access is unavailable.');
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Timeline request is invalid.');
      const call = input as Record<string, unknown>;
      if (call.schemaVersion !== 1 || typeof call.method !== 'string' || !Object.hasOwn(fields, call.method) ||
        Object.keys(call).some(key => !['schemaVersion', 'method', ...fields[call.method as string]!].includes(key))) throw new Error('Timeline request is unsupported.');
      const id = () => parseId('object', call.objectId as string), expected = () => parseId('revision', call.expectedRevisionId as string);
      const text = (key: string) => { if (typeof call[key] !== 'string' || !call[key].trim()) throw new Error('Timeline request is invalid.'); return call[key] as string; };
      const bool = (key: string) => { if (call[key] !== undefined && typeof call[key] !== 'boolean') throw new Error('Timeline request is invalid.'); return call[key] === true; };
      let value: unknown;
      switch (call.method) {
        case 'list': value = await service.list(bool('includeTrash')); break;
        case 'read': value = await service.read(id(), call.revisionId === undefined ? undefined : parseId('revision', call.revisionId as string)); break;
        case 'create': value = await service.create(call.title === undefined ? undefined : text('title'), text('idempotencyKey'), call.objectId === undefined ? undefined : id()); break;
        case 'save': value = await service.save(call.request as WriteDocumentRequest<Timeline>, text('label')); break;
        case 'send': {
          if (call.choice !== undefined && !['replace_range', 'next_free', 'cancel'].includes(call.choice as string)) throw new Error('Choose a collision action.');
          value = await service.send({ objectId: id(), expectedRevisionId: expected(), laneId: parseId('lane', call.laneId as string), source: call.source as Parameters<TimelineService['send']>[0]['source'],
            range: call.range as Parameters<TimelineService['send']>[0]['range'], choice: call.choice as Parameters<TimelineService['send']>[0]['choice'], idempotencyKey: text('idempotencyKey') }); break;
        }
        case 'import': value = await service.importFile(text('text'), text('idempotencyKey'), call.objectId === undefined ? undefined : id()); break;
        case 'export': value = await service.exportFile(id()); break;
        case 'share': value = await service.share(id()); break;
        case 'addLanes': {
          if (!Array.isArray(call.laneIds) || call.laneIds.some(value => typeof value !== 'string')) throw new Error('Choose lanes to add.');
          value = await service.addLanes(id(), expected(), { source: call.bundle as Parameters<TimelineService['addLanes']>[2]['source'],
            sourceRevision: call.sourceRevision as Parameters<TimelineService['addLanes']>[2]['sourceRevision'], laneIds: call.laneIds as string[],
            insertionId: text('insertionId') }, text('idempotencyKey')); break;
        }
        case 'run': {
          if (call.omittedClipIds !== undefined && !Array.isArray(call.omittedClipIds)) throw new Error('Choose clips to omit.');
          let start: Parameters<TimelineService['run']>[2];
          if (call.manualStart !== undefined) {
            const manual = call.manualStart as { level: number; atlasPoints: number | null };
            if (!manual || typeof manual !== 'object' || Object.keys(manual).some(key => !['level', 'atlasPoints'].includes(key)) || !Number.isInteger(manual.level) || manual.level < 1 || manual.level > 100 ||
              manual.atlasPoints !== null && (!Number.isSafeInteger(manual.atlasPoints) || manual.atlasPoints < 0)) throw new Error('Choose a valid manual Run position.');
            start = { start: { manual: { level: manual.level, atlasPoints: manual.atlasPoints === null ? { status: 'unknown', reason: 'No Atlas baseline selected.' } : { status: 'known', value: manual.atlasPoints, evidenceId: 'manual-baseline' } } } };
          }
          value = await service.run(id(), expected(), { ...start, replaceCurrent: bool('replaceCurrent'), omittedClipIds: (call.omittedClipIds as string[] | undefined)?.map(value => parseId('clip', value)) }); break;
        }
        case 'undo': value = await service.undo(id(), expected()); break;
        case 'redo': value = await service.redo(id(), expected()); break;
        case 'trash': value = await service.trash(id(), expected()); break;
        case 'restoreTrash': value = await service.restoreTrash(id()); break;
      }
      return { ok: true, value: value ?? null };
    } catch (error) {
      const stale = error instanceof Error && ['Timeline changed. Review the updated run.', 'Timeline changed. Review the updated placement.'].includes(error.message);
      return { ok: false, error: { code: stale ? 'CONFLICT' : 'TIMELINE_FAILED', message: stale ? error.message : 'Could not complete the timeline action. Review the timeline or retry; pending edits are retained.' } };
    }
  });
  return () => ipc.removeHandler(TIMELINE_CHANNEL);
}
