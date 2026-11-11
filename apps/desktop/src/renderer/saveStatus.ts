import { tr } from './i18n';
// The open build's save status in the sidebar. A status belongs to the open it was set in: opening or closing a build clears it.
export type BuildSave = { id: string; status: 'saving' | 'failed' } | null;
export type SaveEvent = { kind: 'saving' | 'failed'; id: string } | { kind: 'saved' } | { kind: 'open-changed' };

export function buildSaveReducer(_prev: BuildSave, e: SaveEvent): BuildSave {
  return e.kind === 'saving' || e.kind === 'failed' ? { id: e.id, status: e.kind } : null;
}

export function saveStatusLabel(buildSave: BuildSave, openId: string, dirty: boolean, notSaved: boolean): string | null {
  return buildSave?.id === openId ? (buildSave.status === 'failed' ? tr('saveStatus.save_failed') : tr('h_rA_misc.saving')) : !dirty && !notSaved ? tr('saveStatus.saved_on_this_pc') : null;
}
