/** The question the app asks before closing while a Timeline holds changes not yet written; null once everything is saved. */
export function timelineCloseBlock(saveState: 'saved' | 'saving' | 'failed', renamePending: boolean) {
  if (saveState === 'saved' && !renamePending) return null;
  return saveState === 'failed'
    ? { title: 'Your latest timeline changes are not saved.', subtitle: 'They could not be written to this PC.', body: 'Close anyway and they are lost.', confirmLabel: 'Close anyway' }
    : { title: 'Your latest timeline changes are still being saved.', subtitle: '', body: 'Close anyway and the change being saved now may be lost.', confirmLabel: 'Close anyway' };
}
