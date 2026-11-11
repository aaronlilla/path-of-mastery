import { BrowserWindow, ipcMain } from 'electron';
import { IPC } from '../shared/ipc.js';
import type { EntitlementView } from '../shared/entitlements.js';
import { isSignedIn, onSignInChange, getAiStatus, onAiStatusChange } from './entitlements.js';

export function entitlementView(): EntitlementView {
  return { signedIn: isSignedIn(), ai: getAiStatus() };
}

/** The window can read AI access. It cannot change it. */
export function registerEntitlementsIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(IPC.ENTITLEMENT_GET, () => entitlementView());
  const notify = () => {
    const w = getWindow();
    if (w && !w.webContents.isDestroyed()) w.webContents.send(IPC.ENTITLEMENT_CHANGED, entitlementView());
  };
  onSignInChange(notify); onAiStatusChange(notify);
}
