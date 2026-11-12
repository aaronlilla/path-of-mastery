import type { TargetState } from './ipcTypes.js';
import type { FilterDoc } from './types.js';

/** What the My Filters table says about one filter's file. */
export type RowState = 'local' | 'written' | 'synced' | 'conflict';

/**
 * The state of one filter, from the record of our last write and what is on disk now. "Written to game" needs
 * a record that we wrote it AND the same text still in the game folder; a filter that was never written is
 * "Local only", whatever else is in that folder. A file there that no longer matches what we wrote is a conflict.
 */
export function rowState(written: FilterDoc['written'] | undefined, target: TargetState | null, account?: FilterDoc['account']): RowState {
  if (account && (!written || written.fileHash === account.fileHash) && !(target && (target.state === 'changed' || target.state === 'foreign') && written)) return 'synced';
  if (!written) return 'local';
  if (!target) return 'local';
  if (target.state === 'ours') return 'written';
  if (target.state === 'changed' || target.state === 'foreign') return 'conflict';
  return 'local';
}
