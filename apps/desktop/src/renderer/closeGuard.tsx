import { useEffect, useState } from 'react';
import { ConfirmDialog } from './Dialogs';
import { tr } from './i18n';

/** What the app asks before closing while some screen still holds work that isn't finished. */
export interface CloseBlock {
  title: string;
  subtitle: string;
  body: string;
  confirmLabel: string;
  /** When set, the screen asks in its own dialog (the Save / Don't Save / Cancel prompt) instead of the generic one. */
  ask?: () => void;
}

const blocks = new Map<string, CloseBlock>();

/** Registers a reason to ask before the window closes, or clears it with `null`. `key` names the screen. */
export function setCloseBlock(key: string, block: CloseBlock | null): void {
  if (block) blocks.set(key, block);
  else blocks.delete(key);
}

/**
 * Save-before-restart: each screen that holds a document registers how to save it through its own save path. The
 * function returns false when the save failed, after showing that screen's own Save failed dialog or message.
 */
const savers = new Map<string, () => Promise<boolean>>();

/** Registers (or clears with `null`) how a screen saves its open document before an update restart. */
export function setRestartSaver(key: string, save: (() => Promise<boolean>) | null): void {
  if (save) savers.set(key, save);
  else savers.delete(key);
}

/** Saves every open document, one after another. False as soon as one fails: the restart must not happen then. */
export async function saveAllForRestart(): Promise<boolean> {
  for (const save of [...savers.values()]) {
    let ok = false;
    try {
      ok = await save();
    } catch {
      ok = false;
    }
    if (!ok) return false;
  }
  return true;
}

// One handler for the whole app: refusing the unload makes main report it (IPC WIN_CLOSE_BLOCKED) instead of
// closing, and CloseGuardDialog asks in the app's own style. No system message box is involved.
window.addEventListener('beforeunload', (e) => {
  if (blocks.size > 0) {
    e.preventDefault();
    e.returnValue = '';
  }
});

const UNKNOWN: CloseBlock = {
  title: tr('closeGuard.close_the_app'),
  subtitle: tr('closeGuard.something_in_this_window_is'),
  body: tr('closeGuard.close_anyway_and_anything_not'),
  confirmLabel: tr('closeGuard.close_anyway'),
};

/** Mounted once at the app root, so the question can be asked from any screen. */
export function CloseGuardDialog() {
  const [open, setOpen] = useState(false);
  useEffect(
    () =>
      window.pom.win.onCloseBlocked(() => {
        const own = [...blocks.values()].find((b) => b.ask);
        if (own?.ask) own.ask();
        else setOpen(true);
      }),
    [],
  );
  if (!open) return null;
  const block = blocks.values().next().value ?? UNKNOWN;
  return (
    <ConfirmDialog
      icon="warning"
      tone="danger"
      title={block.title}
      subtitle={block.subtitle}
      body={block.body}
      confirmLabel={block.confirmLabel}
      confirmIcon="x"
      cancelLabel={tr('closeGuard.cancel')}
      onConfirm={() => void window.pom.win.closeAnyway()}
      onCancel={() => setOpen(false)}
    />
  );
}
