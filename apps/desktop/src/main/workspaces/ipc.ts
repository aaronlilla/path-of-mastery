import { parseId, revisionRefSchema, type RevisionRef, type ScopeKey, type ValidationLimits } from '@pom/mastery-contracts';
import { WorkspaceError, WorkspaceService, type CopyAdapter, type CopyRequest } from './manifest.js';
import type { DataIdentity, DataRepair } from '../../shared/documents/compatibility.js';

export const WORKSPACE_CHANNEL = 'mastery:workspaces';
type IpcRegistrar = { handle(channel: string, handler: (event: unknown, input: unknown) => Promise<unknown>): void; removeHandler(channel: string): void };
type IpcOptions = {
  isTrustedSender(event: unknown): boolean;
  limits: ValidationLimits;
  copyAdapter(source: RevisionRef): CopyAdapter;
};
const fields: Record<string, string[]> = {
  active: [], archives: [], manifest: ['scope'], select: ['scope'], legacy: ['scope'],
  attributeLegacy: ['objectId', 'scope'], provenance: ['objectId'], compatibility: ['source', 'target'], copy: ['request'],
};
function record(input: unknown, allowed: string[], required = allowed): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) throw new TypeError('Expected a request record.');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) throw new TypeError('Request fields are invalid.');
  return value;
}
function text(input: unknown): string { if (typeof input !== 'string' || !input.trim()) throw new TypeError('Expected text.'); return input; }
function scope(input: unknown): ScopeKey {
  const value = record(input, ['leagueId', 'realm', 'mode']);
  const mode = record(value.mode, ['economy', 'hardcore', 'ruthless']);
  if (!['trade', 'ssf'].includes(mode.economy as string) || typeof mode.hardcore !== 'boolean' || typeof mode.ruthless !== 'boolean') throw new TypeError('Scope mode is invalid.');
  return { leagueId: text(value.leagueId), realm: text(value.realm), mode: { economy: mode.economy as 'trade' | 'ssf', hardcore: mode.hardcore, ruthless: mode.ruthless } };
}
function identity(input: unknown): DataIdentity {
  const value = record(input, ['namespace', 'id']);
  return { namespace: text(value.namespace), id: text(value.id) };
}
function repair(input: unknown): DataRepair {
  const value = record(input, ['source', 'action', 'target'], ['source', 'action']);
  if (value.action === 'replace') return { source: identity(value.source), action: 'replace', target: identity(value.target) };
  if ((value.action !== 'remove' && value.action !== 'accept_effect') || Object.hasOwn(value, 'target')) throw new TypeError('Repair action is invalid.');
  return { source: identity(value.source), action: value.action };
}
function bounded(input: unknown, limits: ValidationLimits): void {
  for (const name of ['maxBytes', 'maxDepth', 'maxNodes', 'maxArrayLength', 'maxStringLength'] as const) {
    if (!Number.isSafeInteger(limits[name]) || limits[name] < 1) throw new TypeError('Request limits are invalid.');
  }
  let count = 0;
  const ancestors = new Set<object>();
  const visit = (value: unknown, depth: number): void => {
    if (++count > limits.maxNodes || depth > limits.maxDepth) throw new TypeError('Request exceeds the configured structure limit.');
    if (typeof value === 'string') { if (value.length > limits.maxStringLength) throw new TypeError('Request text is too long.'); return; }
    if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
    if (!value || typeof value !== 'object' || ancestors.has(value)) throw new TypeError('Request must contain JSON data.');
    const array = Array.isArray(value);
    if ((!array && Object.getPrototypeOf(value) !== Object.prototype) || (array && value.length > limits.maxArrayLength) || Object.getOwnPropertySymbols(value).length) throw new TypeError('Request structure is invalid.');
    ancestors.add(value);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (array && key === 'length') continue;
      if (!descriptor.enumerable || !('value' in descriptor) || ['__proto__', 'constructor', 'prototype', 'toJSON'].includes(key) || key.length > limits.maxStringLength) throw new TypeError('Request fields are invalid.');
      visit(descriptor.value, depth + 1);
    }
    ancestors.delete(value);
  };
  visit(input, 0);
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') > limits.maxBytes) throw new TypeError('Request is too large.');
}

/** The mastery wiring supplies the main-window sender check and trusted domain copy adapters. */
export function registerWorkspaceIpc(ipc: IpcRegistrar, service: WorkspaceService, options: IpcOptions): () => void {
  ipc.handle(WORKSPACE_CHANNEL, async (event, input) => {
    try {
      if (!options.isTrustedSender(event)) throw new WorkspaceError('INVALID', 'Workspace access is unavailable.');
      bounded(input, options.limits);
      const call = record(input, ['schemaVersion', 'method', ...Object.values(fields).flat()], ['schemaVersion', 'method']);
      if (call.schemaVersion !== 1 || typeof call.method !== 'string' || !Object.hasOwn(fields, call.method)) throw new TypeError('Request version or method is unsupported.');
      record(call, ['schemaVersion', 'method', ...fields[call.method]!], call.method === 'legacy' ? ['schemaVersion', 'method'] : ['schemaVersion', 'method', ...fields[call.method]!]);
      const pin = (value: unknown): RevisionRef => {
        const result = revisionRefSchema.parse(value, options.limits);
        if (!result.ok) throw new TypeError('Source revision is invalid.');
        return result.value;
      };
      let value: unknown;
      switch (call.method) {
        case 'active': value = service.active(); break;
        case 'archives': value = service.archives(); break;
        case 'manifest': value = service.manifest(scope(call.scope)); break;
        case 'select': value = await service.select(scope(call.scope)); break;
        case 'legacy': value = service.legacy(call.scope === undefined ? undefined : call.scope === null ? null : scope(call.scope)); break;
        case 'attributeLegacy': value = await service.attributeLegacy(parseId('object', text(call.objectId)), scope(call.scope)); break;
        case 'provenance': value = service.provenance(parseId('object', text(call.objectId))); break;
        case 'compatibility': {
          const source = pin(call.source);
          value = await service.compatibility(source, scope(call.target), options.copyAdapter(source)); break;
        }
        case 'copy': {
          const raw = record(call.request, ['source', 'target', 'dataMode', 'name', 'repairs', 'idempotencyKey']);
          if (!['source_data', 'target_data'].includes(raw.dataMode as string) || !Array.isArray(raw.repairs)) throw new TypeError('Copy mode or repairs are invalid.');
          const request: CopyRequest = {
            source: pin(raw.source), target: scope(raw.target), dataMode: raw.dataMode as CopyRequest['dataMode'],
            name: text(raw.name), repairs: raw.repairs.map(repair), idempotencyKey: text(raw.idempotencyKey),
          };
          value = await service.copy(request, options.copyAdapter(request.source)); break;
        }
      }
      return { ok: true, value };
    } catch (error) {
      const failure = error instanceof WorkspaceError ? error : error instanceof TypeError
        ? new WorkspaceError('INVALID', 'Workspace request is invalid.')
        : new WorkspaceError('STORAGE_FAILED', 'Could not save the workspace. Previous saved libraries are retained.');
      return { ok: false, error: { code: failure.code, message: failure.message } };
    }
  });
  return () => ipc.removeHandler(WORKSPACE_CHANNEL);
}
