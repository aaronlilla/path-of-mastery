import type { AtlasEditorSession } from '../editor/session.js';

/**
 * The Applied banner's lifecycle, kept free of React so it can be tested on its own. `applied` stays null until the
 * applied change's save lands; `plan` is the plan right after the change (edit() updates it at once).
 * `undo: false` is a plain notice (no Undo button).
 */
export type Toast = { text: string; key: string; cursor: string | null; applied: string | null; plan: unknown; undo: boolean };
export const stepKey = (s: AtlasEditorSession['state']) => s.record && s.selected ? `${s.record.source.objectId}:${s.selected}` : '';
/** True only while the session is exactly as the applied change left it. */
export const untouched = (s: AtlasEditorSession['state'], t: Toast) => t.applied !== null && s.save === 'saved' && !s.preview && s.plan === t.plan && (s.record?.history.cursor ?? null) === t.applied && stepKey(s) === t.key;
/** The banner after a session change: the same toast (keep), null (hide), or the toast accepted once its save landed. */
export function nextToast(session: AtlasEditorSession['state'], toast: Toast): Toast | null {
  const cursor = session.record?.history.cursor ?? null;
  if (stepKey(session) !== toast.key) return null;
  if (!toast.undo) return toast;
  if (toast.applied === null) {
    // Save still pending: a later edit (typing included) replaces the plan object, which hides the banner at once,
    // before any save lands.
    if (session.save !== 'saved') return session.plan === toast.plan ? toast : null;
    if (cursor === toast.cursor) return toast;
    // Accept only if the applied change is the one entry added since: if another edit landed right after it, drop the banner.
    const entry = session.record?.history.events.find(e => e.transactionId === cursor);
    return entry && entry.parentTransactionId === toast.cursor ? { ...toast, applied: cursor, plan: session.plan } : null;
  }
  return untouched(session, toast) ? toast : null;
}
