import { BrowserWindow, ipcMain } from 'electron';
import { IPC } from '../shared/ipc.js';
import type { SolveGoal } from '@pom/protocol';
import type { AssistantContextInfo, AssistantPrefs, AssistantPush, ProviderId, SendRequest, SolveCpu, Thread } from '../shared/assistant/types.js';
import type { Result } from '../shared/library.js';
import type { AssistantService } from './assistant/service.js';
import { loadPatterns } from './assistant/buildPatterns.js';
import { evidenceFor } from '../shared/assistant/solveQuestions.js';

async function wrap<T>(fn: () => Promise<T> | T): Promise<Result<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    const code = e && typeof e === 'object' && 'code' in e ? String((e as { code: unknown }).code) : undefined;
    return { ok: false, error: e instanceof Error ? e.message : String(e), ...(code ? { code } : {}) };
  }
}

/** `ready` is the service as it finishes loading: the handlers exist from the start and each waits for it. */
export function registerAssistantIpc(ready: Promise<AssistantService>, getWindow: () => BrowserWindow | null): void {
  const handle = <A extends unknown[], T>(channel: string, fn: (service: AssistantService, ...args: A) => Promise<T> | T) => {
    ipcMain.handle(channel, (event, ...args) => wrap(async () => {
      const window = getWindow();
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
        const error = new Error('This connection ended.');
        Object.assign(error, { code: 'CONNECTION_REVOKED' }); throw error;
      }
      return fn(await ready, ...(args as A));
    }));
  };
  void ready.then((service) =>
    service.onPush((p: AssistantPush) => {
      const w = getWindow();
      if (w && !w.webContents.isDestroyed()) w.webContents.send(IPC.ASSISTANT_PUSH, p);
    }),
  );

  handle(IPC.ASSISTANT_STATUS, (service) => service.status());
  handle(IPC.ASSISTANT_SEND, (service, req: SendRequest) => service.send(req));
  handle(IPC.ASSISTANT_STOP, (service, turnId: string) => service.stopTurn(turnId));
  handle(IPC.ASSISTANT_CONTEXT, (service, info: AssistantContextInfo | null) => service.setContext(info));
  handle(IPC.ASSISTANT_APPLY, (service, id: string) => service.applyProposal(id));
  handle(IPC.ASSISTANT_DISMISS, (service, id: string) => service.dismissProposal(id) ?? null);
  handle(IPC.ASSISTANT_UNDO, (service, id: string) => service.undoProposal(id));
  handle(IPC.ASSISTANT_THREAD_GET, (service, key: string) => service.loadThread(key));
  handle(IPC.ASSISTANT_THREAD_SET, (service, key: string, thread: Thread) => service.saveThread(key, thread));
  handle(IPC.ASSISTANT_THREAD_CLEAR, (service, key: string) => service.clearThread(key));
  handle(IPC.ASSISTANT_PREFS_GET, (service) => service.getPrefs());
  handle(IPC.ASSISTANT_PREFS_SET, (service, patch: Partial<AssistantPrefs>) => service.setPrefs(patch));
  handle(IPC.ASSISTANT_CONNECTOR, (service) => service.connectorInfo());
  handle(IPC.ASSISTANT_CONNECTOR_INSTALL, (service) => service.installConnector());
  handle(IPC.ASSISTANT_CONNECTOR_RESTART, (service) => service.restartDesktop());
  handle(IPC.ASSISTANT_PROPOSALS, (service, key: string) => service.proposalStatuses(key));
  handle(IPC.ASSISTANT_LOGIN, (service, id: ProviderId) => service.openLogin(id));
  handle(IPC.ASSISTANT_LOGIN_CANCEL, (service, id: ProviderId) => service.cancelLogin(id));
  handle(IPC.ASSISTANT_LOGOUT, (service, id: ProviderId) => service.signOut(id));
  type SolveOpts = { timeBudgetMs?: number; cpu?: SolveCpu };
  handle(IPC.SOLVE_STATE, (service) => service.solve.state);
  handle(IPC.SOLVE_GOAL, (service, goal: SolveGoal, opts: SolveOpts) => service.solve.setGoal(goal, opts, 'panel'));
  handle(IPC.SOLVE_RUN, (service, goal: SolveGoal, opts: SolveOpts) => service.solve.run(goal, opts));
  handle(IPC.SOLVE_STOP, (service) => service.solve.stop());
  handle(IPC.SOLVE_CONTINUE, (service) => service.solve.keepImproving());
  handle(IPC.SOLVE_DETAILS, async (service, index: number) => {
    const { xml: _xml, baseHash: _h, ...d } = await service.solve.details(index);
    return d;
  });
  handle(IPC.SOLVE_EVIDENCE, (_service, skill: string) => { try { return evidenceFor(loadPatterns(), String(skill)); } catch { return null; } });
  handle(IPC.SOLVE_CARD, (service, ref: number | string) => service.solve.propose(ref, 'panel'));
}

export const AI_CONNECTION_CHANNELS = {
  verify: 'mastery:ai:verify', enable: 'mastery:ai:enable', begin: 'mastery:ai:pair:begin',
  allow: 'mastery:ai:pair:allow', decline: 'mastery:ai:pair:decline', revoke: 'mastery:ai:revoke', install: 'mastery:ai:install',
} as const;

/** Registers these handlers for the trusted main window and extends the existing preload. */
export function registerAiConnectionsIpc(ready: Promise<AssistantService>, getWindow: () => BrowserWindow | null): void {
  const trusted = <T>(channel: string, work: (service: AssistantService, value: unknown) => Promise<T>) => {
    ipcMain.handle(channel, (event, value) => wrap(async () => {
      const window = getWindow();
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('CONNECTION_REVOKED');
      return work(await ready, value);
    }));
  };
  trusted(AI_CONNECTION_CHANNELS.verify, async service => { await service.verifyAi(); return service.connectorInfo(); });
  trusted(AI_CONNECTION_CHANNELS.enable, (service, value) => {
    if (typeof value !== 'boolean') throw new Error('VALIDATION_FAILED');
    return service.setConnectionsEnabled(value);
  });
  trusted(AI_CONNECTION_CHANNELS.begin, (service, value) => {
    const v = value as { publicIdentity?: unknown; scopes?: unknown };
    if (!v || typeof v.publicIdentity !== 'string' || !Array.isArray(v.scopes) || v.scopes.some(s => typeof s !== 'string')) throw new Error('VALIDATION_FAILED');
    return service.beginPairing(v.publicIdentity, v.scopes as import('./aiGate/gate.js').AiScope[]);
  });
  for (const action of ['allow','decline','install'] as const) trusted(AI_CONNECTION_CHANNELS[action], (service, value) => {
    if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/i.test(value)) throw new Error('VALIDATION_FAILED');
    return action === 'allow' ? service.allowPairing(value) : action === 'decline' ? service.declinePairing(value) : service.installConnector(value);
  });
  trusted(AI_CONNECTION_CHANNELS.revoke, (service, value) => {
    if (value !== null && (typeof value !== 'string' || !/^[a-f0-9-]{36}$/i.test(value))) throw new Error('VALIDATION_FAILED');
    return service.revokeConnections(value as string | null);
  });
}
