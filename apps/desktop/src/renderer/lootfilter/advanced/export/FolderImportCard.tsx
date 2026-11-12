import { useState } from 'react';
import { Icon, useToast } from '../../../ui';
import { useLf } from '../../lfStore';
import type { LfNav } from '../../LootFilterArea';
import { Eyebrow } from '../sim/kit';
import { tr } from '../../../i18n';
import { lfNet } from '../../mainText';

type Row = { name: string; ours: boolean };

/** Lists the .filter files in the Path of Exile folder and imports one through the same reader as a file the player opens. */
export function FolderImportCard({ nav }: { nav: LfNav }) {
  const lf = useLf();
  const toast = useToast();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState('');

  const load = async (): Promise<void> => {
    setBusy('list');
    setErr('');
    const r = await window.pom.lootFilter.folderList(lf.gameFolder);
    setBusy(null);
    if (!r.ok) setErr(r.error);
    else if (!r.value.ok) setErr(lfNet(r.value.error));
    else setRows(r.value.files);
  };
  const take = async (f: Row): Promise<void> => {
    setBusy(f.name);
    setErr('');
    const r = await window.pom.lootFilter.folderRead(lf.gameFolder, f.name);
    if (!r.ok || !r.value.ok) {
      setBusy(null);
      setErr(r.ok && !r.value.ok ? lfNet(r.value.error) : r.ok ? '' : r.error);
      return;
    }
    const res = await lf.importFilterText(f.name.replace(/\.filter$/i, ''), r.value.text);
    setBusy(null);
    toast({ text: res.message, kind: 'ok' });
    nav.setAdvancedView('filters');
  };

  return (
    <div className="adv-ex-import">
      <Eyebrow>{tr('lootfilter_advanced_export_FolderImportCard.path_of_exile_folder')}</Eyebrow>
      {err && <div className="adv-v-msg bad">{err}</div>}
      {!rows && (
        <button type="button" className="adv-sh-btn" style={{ alignSelf: 'flex-start' }} disabled={busy === 'list'} onClick={() => void load()}>
          <Icon name="folder" size={14} />
          {busy === 'list' ? tr('lootfilter_advanced_export_FolderImportCard.reading_the_folder') : tr('lootfilter_advanced_export_FolderImportCard.import_from_path_of_exile')}
        </button>
      )}
      {rows && (rows.length ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {rows.map((f) => (
            <div key={f.name} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="adv-v-ellip" style={{ flex: 1, color: 'var(--text-strong)' }} title={f.name}>{f.name}{f.ours ? tr('lootfilter_advanced_export_FolderImportCard.made_here') : ''}</span>
              <button type="button" className="btn sm" disabled={busy !== null} onClick={() => void take(f)}>
                {busy === f.name ? tr('lootfilter_advanced_export_FolderImportCard.importing') : tr('lootfilter_advanced_export_FolderImportCard.import')}
              </button>
            </div>
          ))}
        </div>
      ) : (
        <span className="adv-v-muted">{tr('lootfilter_advanced_export_FolderImportCard.there_are_no_filter_files')}</span>
      ))}
    </div>
  );
}
