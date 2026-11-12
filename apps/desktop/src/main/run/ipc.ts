import type { RunService } from './service.js';
import { parseId, type EmbeddedDependency, type RunSnapshot, type ValidationLimits } from '@pom/mastery-contracts';
import { parseCommand } from '../../shared/run/input.js';
import { validatePreferences, type WindowPreferences } from './window.js';
import type { RunLogHost } from './log.js';
import type { Monitor } from '../../shared/run/window.js';

export const RUN_CHANNEL = 'mastery:run';
type Registrar = { handle(channel: string, handler: (event: unknown, input: unknown) => Promise<unknown>): void; removeHandler(channel: string): void };
export type RunSender = { sender: { id: number }; senderFrame: { url: string; parent: unknown } | null };
export function isRunSender(event: unknown, windowId: number | null, entryUrl: string): boolean {
  const e = event as RunSender | undefined;
  return windowId !== null && e?.sender?.id === windowId && e.senderFrame?.parent === null && e.senderFrame.url === entryUrl;
}
export function registerRunIpc(ipc: Registrar, service: RunService, options: {
  isTrustedRunSender(event: unknown): boolean; limits: ValidationLimits;
  closeWindow?: () => Promise<void>;
  windowSettings?: () => WindowPreferences | null;
  saveWindowSettings?: (preferences: WindowPreferences) => Promise<void>;
  configureHotkeys?: (next: string, back: string) => void;
  disableHotkeys?: () => void;
  chooseRecoveryDestination?: () => Promise<string | null>;
  log?: RunLogHost;
  openTimeline?: (snapshot: RunSnapshot) => Promise<void>;
  openSource?: (source: EmbeddedDependency) => Promise<void>;
  monitors?: () => Monitor[];
  /** Public-side calls (vote, feedback, publish, detected Client.txt). The callback validates `call` itself. */
  services?: (call: unknown) => Promise<unknown>;
}): () => void {
  ipc.handle(RUN_CHANNEL, async (event, input) => {
    try {
      if (!options.isTrustedRunSender(event)) return { ok: false, code: 'FORBIDDEN' };
      if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, code: 'INVALID' };
      const call = input as Record<string, unknown>;
      const fields: Record<string, string[]> = { view: [], command: ['command'], runAgain: ['runId'], close: [], retry: [], exportRecovery: [],
        counting: ['enabled'], chunks: ['characterChunks'], windowSettings: [], saveWindowSettings: ['preferences'],
        configureHotkeys: ['next', 'back'], disableHotkeys: [], logState: [], logControl: ['control'], openTimeline: [], openSource: ['actionId'], monitors: [], service: ['call'] };
      if (call.schemaVersion !== 1 || typeof call.method !== 'string' || !Object.hasOwn(fields, call.method) ||
        Object.keys(call).some(k => !['schemaVersion', 'method', ...fields[call.method as string]!].includes(k)) ||
        new TextEncoder().encode(JSON.stringify(call)).length > options.limits.maxBytes) return { ok: false, code: 'INVALID' };
      if (call.method === 'view') return { ok: true, value: service.view() };
      if (call.method === 'openTimeline') {
        const view = service.view();
        if (!view || !options.openTimeline) return { ok: false, code: 'UNAVAILABLE' };
        await options.openTimeline(view.snapshot); return { ok: true, value: null };
      }
      if (call.method === 'openSource') {
        const actionId = parseId('action', call.actionId as string), snapshot = service.view()?.snapshot;
        const action = snapshot?.actions.find(a => a.actionId === actionId);
        const source = action ? snapshot?.dependencies.find(d => d.ref.objectId === action.sourceRevision.objectId && d.ref.revisionId === action.sourceRevision.revisionId) : undefined;
        if (!source || !options.openSource) return { ok: false, code: 'UNAVAILABLE' };
        await options.openSource(source); return { ok: true, value: null };
      }
      if (call.method === 'monitors') return { ok: true, value: options.monitors?.() ?? [] };
      if (call.method === 'service') {
        if (!options.services) return { ok: false, code: 'UNAVAILABLE' };
        return { ok: true, value: await options.services(call.call) };
      }
      if (call.method === 'logState') return { ok: true, value: options.log?.state() ?? null };
      if (call.method === 'logControl') {
        if (!options.log) return { ok: false, code: 'UNAVAILABLE' };
        return { ok: true, value: await options.log.call(call.control) };
      }
      if (call.method === 'runAgain') return { ok: true, value: await service.runAgain(parseId('run', call.runId as string)) };
      if (call.method === 'counting') {
        if (typeof call.enabled !== 'boolean') return { ok: false, code: 'INVALID' };
        await service.setCounting(call.enabled); return { ok: true, value: service.view() };
      }
      if (call.method === 'chunks') return { ok: true, value: await service.updateFutureChunks(call.characterChunks as Parameters<RunService['updateFutureChunks']>[0]) };
      if (call.method === 'close') {
        if (!options.closeWindow) return { ok: false, code: 'UNAVAILABLE' };
        await options.closeWindow(); return { ok: true, value: null };
      }
      if (call.method === 'retry') { await service.retry(); return { ok: true, value: service.view() }; }
      if (call.method === 'exportRecovery') {
        if (!options.chooseRecoveryDestination) return { ok: false, code: 'UNAVAILABLE' };
        const destination = await options.chooseRecoveryDestination();
        if (destination) await service.store.exportRecovery(destination);
        return { ok: true, value: { exported: destination !== null } };
      }
      if (call.method === 'windowSettings') return { ok: true, value: options.windowSettings?.() ?? null };
      if (call.method === 'saveWindowSettings') {
        if (!options.saveWindowSettings) return { ok: false, code: 'UNAVAILABLE' };
        validatePreferences(call.preferences as WindowPreferences);
        await options.saveWindowSettings(call.preferences as WindowPreferences); return { ok: true, value: options.windowSettings?.() ?? null };
      }
      if (call.method === 'configureHotkeys') {
        if (!options.configureHotkeys) return { ok: false, code: 'UNAVAILABLE' };
        if (typeof call.next !== 'string' || typeof call.back !== 'string') return { ok: false, code: 'INVALID' };
        options.configureHotkeys(call.next, call.back); return { ok: true, value: null };
      }
      if (call.method === 'disableHotkeys') { options.disableHotkeys?.(); return { ok: true, value: null }; }
      const command = parseCommand(call.command, options.limits);
      return { ok: true, value: await service.command(command) };
    } catch { return { ok: false, code: service.store.hasPending ? 'SAVE_FAILED' : 'RUN_REQUEST_FAILED' }; }
  });
  return () => ipc.removeHandler(RUN_CHANNEL);
}
