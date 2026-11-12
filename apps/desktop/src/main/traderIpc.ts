import { app, ipcMain } from 'electron';
import { IPC } from '../shared/ipc.js';
import type { WealthService } from './wealth/service.js';
import { ReplayTradeApi } from './wealth/traderReplay.js';
import { TraderService } from './wealth/traderService.js';

const METHODS = new Set(['auth', 'search', 'fromUrl', 'rates']);

/**
 * The Trader's calls. The session cookie Wealth saves is used here only inside the trade client, in this process.
 * POM_TRADER_REPLAY=<folder> answers from recorded responses instead (see traderReplay.ts).
 */
export function registerTraderIpc(wealth: WealthService): TraderService {
  const userAgent = `PathOfMastery/${app.getVersion()} (contact: https://pathofmastery.gg)`;
  const replay = process.env.POM_TRADER_REPLAY ? new ReplayTradeApi(process.env.POM_TRADER_REPLAY) : null;
  const svc = new TraderService(replay ?? wealth.traderApi, { authenticated: () => !!replay || wealth.traderAuthenticated(), userAgent, ...(replay ? { fetchFn: replay.fetchFn } : {}) });
  ipcMain.handle(IPC.TRADER_CALL, async (_e, method: string, ...args: unknown[]) => {
    if (!METHODS.has(method)) throw new Error(`Unknown Trader call ${method}`);
    await wealth.whenReady();
    const fn = (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method];
    return fn!.apply(svc, args);
  });
  return svc;
}
