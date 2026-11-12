import type { BuildEntry } from '../../shared/library.js';
import { LATEST_TREE_VERSION } from '../../shared/treeSets.js';
import type { ArchiveRow } from './ArchivePanel';
import { tr } from '../i18n';

/** "3_29" is shown as "Tree 3.29". */
export const treeLabel = (version: string): string => tr('documents_archiveBuilds.tree_replace', { version: version.replace('_', '.') });
const parts = (v: string): [number, number] => { const m = /^(\d+)_(\d+)$/.exec(v); return m ? [Number(m[1]), Number(m[2])] : [0, 0]; };

/**
 * A build file carries no league name, only the tree version of its active spec. Archive = plain versions older than the latest;
 * ruthless/alternate trees and builds with no tree stay out. shortcut: the tree version stands in for the league, upgrade when build files get a real league stamp.
 */
export function oldBuilds(builds: BuildEntry[]): ArchiveRow[] {
  const [lm, ln] = parts(LATEST_TREE_VERSION);
  return builds.filter((b) => {
    const v = b.info.treeVersion;
    if (!/^\d+_\d+$/.test(v)) return false;
    const [m, n] = parts(v);
    return m < lm || (m === lm && n < ln);
  }).map((b) => ({ id: b.id, title: b.name, stamp: treeLabel(b.info.treeVersion) }));
}
export const currentBuildLeague = treeLabel(LATEST_TREE_VERSION);
