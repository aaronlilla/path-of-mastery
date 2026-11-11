import { useState } from 'react';
import { Icon } from '../ui';
import { ArchivePanel } from '../documents/ArchivePanel';
import { useLf } from './lfStore';
import { tr } from '../i18n';

/** Archive in the Loot Filter header: the filters made for a league other than the current one. */
export function LfArchive() {
  const lf = useLf();
  const [open, setOpen] = useState(false);
  const current = lf.currentLeague;
  const rows = lf.state ? lf.state.filters.filter((f) => f.league && current && f.league !== current).map((f) => ({ id: f.id, title: f.name, stamp: f.league! })) : [];
  return (
    <>
      <button type="button" className="btn" onClick={() => setOpen(true)}><Icon name="history" size={14} />{tr('lootfilter_LfArchive.archive')}</button>
      {open && <ArchivePanel area="Loot Filter" current={current || tr('lootfilter_LfArchive_2.the_current_league')} rows={rows}
        emptyText={current ? tr('lootfilter_LfArchive.no_archived_filters_every_filter') : tr('lootfilter_LfArchive.the_current_league_is_not')}
        {...(current ? { onCopy: async (row, name) => { lf.archiveCopy(row.id, name); return null; } } : {})} onClose={() => setOpen(false)} />}
    </>
  );
}
