import { useEffect, useMemo, useRef, useState } from 'react';
import { makeRulePack, makeShareLink } from '../../../../shared/lootfilter/share.js';
import { Dialog, Icon, useToast } from '../../../ui';
import { useLf } from '../../lfStore';
import type { LfNav } from '../../LootFilterArea';
import { diffLines, type DiffResult } from '../export/lineDiff';
import { FolderImportCard } from '../export/FolderImportCard';
import { useSharedPreflight, type PreflightRow } from '../export/usePreflight';
import { Eyebrow, TogglePlain, copyText, fmtClock } from '../sim/kit';
import '../sim/adv-v.css';
import { tr } from '../../../i18n';
import { lfNet } from '../../mainText';

type Ex = 'never' | 'verified' | 'unwritten' | 'notfound' | 'outside' | 'foreign' | 'failed' | 'confirm-foreign' | 'confirm-changed';

export function ExportView({ nav }: { nav: LfNav }) {
  const lf = useLf();
  const toast = useToast();
  const { doc, target, phase, outcome, gen } = lf;
  const [keptHash, setKeptHash] = useState<string | null>(null);
  const [cmp, setCmp] = useState<{ loading: boolean; diff?: DiffResult; error?: string } | null>(null);
  const busy = phase === 'writing';
  const pf = useSharedPreflight();
  const folderRef = useRef<HTMLSpanElement>(null);

  // ---- which state the file is in ----------------------------------------------------------------------
  const ex: Ex = useMemo(() => {
    if (outcome?.kind === 'error') return 'failed';
    if (outcome?.kind === 'needs-confirm') return outcome.why === 'foreign' ? 'confirm-foreign' : 'confirm-changed';
    if (target?.state === 'folder-missing') return 'notfound';
    if (target?.state === 'changed' && keptHash !== target.hash) return 'outside';
    if (target?.state === 'foreign') return 'foreign';
    if (!doc.written) return 'never';
    if (lf.pending.total > 0) return 'unwritten';
    return 'verified';
  }, [outcome, target, keptHash, doc.written, lf.pending.total]);

  const folder = lf.gameFolder;
  const path = (target && 'path' in target ? target.path : undefined) ?? doc.written?.path ?? (folder ? `${folder.replace(/[\\/]+$/, '')}\\${doc.fileName}` : doc.fileName);
  const wroteAt = doc.written?.at;

  const msg = ((): { text: string; tone: '' | 'ok' | 'warn' | 'bad' } => {
    switch (ex) {
      case 'never':
        return { text: tr('lootfilter_advanced_views_ExportView.not_saved_yet_saving_puts', { fileName: doc.fileName, fileName2: doc.fileName.replace(/\.filter$/i, '') }), tone: '' };
      case 'verified':
        return { text: tr(wroteAt ? 'h_lootB_Export.written_at' : 'h_lootB_Export.written', { path, time: wroteAt ? fmtClock(wroteAt) : '', name: doc.fileName.replace(/\.filter$/i, '') }), tone: 'ok' };
      case 'unwritten':
        return { text: tr(`h_lootB_Export.${wroteAt ? 'unwritten_at' : 'unwritten'}_${lf.pending.total === 1 ? 'one' : 'other'}`, { n: lf.pending.total, time: wroteAt ? fmtClock(wroteAt) : '' }), tone: 'warn' };
      case 'notfound':
        return { text: tr('lootfilter_advanced_views_ExportView.the_folder_folder_was_not', { folder: folder || tr('h_lootB_Export.none_paren') }), tone: 'bad' };
      case 'outside':
        return { text: tr('lootfilter_advanced_views_ExportView.the_file_in_the_game'), tone: 'warn' };
      case 'foreign':
        return { text: tr('lootfilter_advanced_views_ExportView.a_file_named_filename_is', { fileName: doc.fileName }), tone: 'warn' };
      case 'confirm-foreign':
        return { text: tr('lootfilter_advanced_views_ExportView.a_file_named_filename_already', { fileName: doc.fileName }), tone: 'warn' };
      case 'confirm-changed':
        return { text: tr('lootfilter_advanced_views_ExportView.the_file_was_changed_outside'), tone: 'warn' };
      case 'failed':
        return { text: outcome?.kind === 'error' ? `${tr('h_lootB_Export.write_failed_detail', { file: doc.fileName, message: outcome.message })}${outcome.code === 'permission' ? ` ${tr('h_lootB_Export.read_only_hint')}` : ''}` : tr('lootfilter_advanced_views_ExportView.write_failed'), tone: 'bad' };
    }
  })();

  const doWrite = async (overwrite?: 'foreign' | 'changed'): Promise<void> => {
    if (busy) return;
    const o = await lf.write(overwrite ? { overwrite } : {});
    if (o?.kind === 'written') toast({ text: tr('lootfilter_advanced_views_ExportView.wrote_path', { path: o.path }), kind: 'ok' });
  };

  const showCompare = async (): Promise<void> => {
    if (!gen) return;
    setCmp({ loading: true });
    const p = target && 'path' in target ? target.path : outcome && 'path' in outcome ? outcome.path : path;
    const r = await window.pom.lootFilter.readFile(p);
    if (!r.ok) {
      setCmp({ loading: false, error: r.error });
      return;
    }
    setCmp({ loading: false, diff: diffLines(r.value, gen.text) });
  };

  // ---- file actions ---------------------------------------------------------------------------------------
  const saveCopy = async (): Promise<void> => {
    if (!gen) return;
    const r = await window.pom.lootFilter.exportFile(doc.fileName, gen.fileText);
    if (!r.ok) toast({ text: r.error, kind: 'error' });
    else if (r.value) toast({ text: tr('lootfilter_advanced_views_ExportView.saved_a_copy_to_value', { value: r.value }), kind: 'ok' });
  };
  const copyFilter = async (): Promise<void> => {
    if (!gen) return;
    const ok = await copyText(gen.text);
    toast(ok ? { text: tr('lootfilter_advanced_views_ExportView.copied_tolocalestring_lines', { count: gen.text.split('\n').length.toLocaleString() }), kind: 'ok' } : { text: tr('lootfilter_advanced_views_ExportView.the_clipboard_is_not_available'), kind: 'error' });
  };
  const shareLink = async (): Promise<void> => {
    const link = await makeShareLink({ v: 1, name: doc.name, setup: doc.setup, rules: doc.rules });
    const ok = await copyText(link);
    toast(ok ? { text: tr('lootfilter_advanced_views_ExportView.copied_a_share_link_paste'), kind: 'ok' } : { text: tr('lootfilter_advanced_views_ExportView.the_clipboard_is_not_available'), kind: 'error' });
  };
  const exportModule = async (): Promise<void> => {
    const mine = doc.rules.filter((r) => r.source !== 'build');
    if (!mine.length) {
      toast({ text: tr('lootfilter_advanced_views_ExportView.there_are_no_changes_of'), kind: 'info' });
      return;
    }
    const r = await window.pom.lootFilter.exportFile(`${doc.name}.pomrules`, makeRulePack(doc.name, doc.rules));
    if (!r.ok) toast({ text: r.error, kind: 'error' });
    else if (r.value) toast({ text: tr('lootfilter_advanced_views_ExportView.saved_count_rules_to_value', { count: mine.length, value: r.value }), kind: 'ok' });
  };
  const copyCmd = async (): Promise<void> => {
    const ok = await copyText('/reloaditemfilter');
    toast(ok ? { text: tr('lootfilter_advanced_views_ExportView.copied_reloaditemfilter'), kind: 'ok' } : { text: tr('lootfilter_advanced_views_ExportView.the_clipboard_is_not_available'), kind: 'error' });
  };

  const fileActs: { icon: string; label: string; sub: string; go: () => void; off?: boolean }[] = [
    { icon: 'save', label: tr('lootfilter_advanced_views_ExportView.save_a_copy'), sub: tr('lootfilter_advanced_views_ExportView.choose_where_to_save_a'), go: () => void saveCopy(), off: !gen },
    { icon: 'copy', label: tr('lootfilter_advanced_views_ExportView.copy_filter_text'), sub: gen ? tr('lootfilter_advanced_views_ExportView.copy_all_tolocalestring_lines', { count: gen.text.split('\n').length.toLocaleString() }) : tr('lootfilter_advanced_views_ExportView.waiting_for_the_filter'), go: () => void copyFilter(), off: !gen },
    { icon: 'share', label: tr('lootfilter_advanced_views_ExportView.share_link'), sub: tr('lootfilter_advanced_views_ExportView.a_read_only_link_anyone'), go: () => void shareLink() },
    { icon: 'file-text', label: tr('lootfilter_advanced_views_ExportView.export_as_module'), sub: tr('lootfilter_advanced_views_ExportView.save_your_changes_as_a'), go: () => void exportModule() },
  ];

  // ---- preflight: one list for this screen and the status bar ----------------------------------------------
  const act = async (row: PreflightRow): Promise<void> => {
    const a = row.a;
    if (!a) return;
    if (a.kind === 'fix-sound' && a.file) {
      const r = await window.pom.lootFilter.copySound(folder, a.file);
      if (!r.ok) toast({ text: lfNet(r.error), kind: 'error' });
      else if (r.value) {
        toast({ text: tr('lootfilter_advanced_views_ExportView.copied_file_into_the_game', { file: a.file }), kind: 'ok' });
        pf.recheck();
      }
    } else if (a.kind === 'rule' && a.ruleId) nav.openAdvanced('customize', { ruleId: a.ruleId });
    else nav.setAdvancedView('advanced');
  };

  const mkBtn = (label: string, icon: string, go: () => void, off = false) => (
    <button type="button" className="btn sm" style={{ height: 34 }} disabled={off} onClick={go} key={label}>
      <Icon name={icon} size={14} />
      {label}
    </button>
  );

  return (
    <div className="adv-v-page" style={{ position: 'relative' }}>
      <div className="adv-v-head">
        <span className="adv-v-title">{tr('lootfilter_advanced_views_ExportView.export')}</span>
      </div>
      <div className="adv-ex-grid">
        <div className="lf-card adv-v-panel accent">
          <div className="adv-v-row">
            <Eyebrow>{tr('lootfilter_advanced_views_ExportView.game_folder')}</Eyebrow>
          </div>
          <div className="adv-ex-folder">
            <span className="adv-v-muted">{tr('lootfilter_advanced_views_ExportView.folder')}</span>
            <span ref={folderRef} className="adv-v-mono" title={folder} style={{ color: 'var(--text-2)', overflowWrap: 'anywhere' }}>
              {folder || tr('lootfilter_advanced_views_ExportView.not_set')}
            </span>
            <button type="button" className="btn sm" style={{ height: 28 }} onClick={() => void lf.chooseFolder()}>
              <Icon name="edit" size={13} />
              {tr('lootfilter_advanced_views_ExportView.change')}
            </button>
            <span className="adv-v-muted">{tr('lootfilter_advanced_views_ExportView.file')}</span>
            <span className="adv-v-mono" style={{ color: 'var(--text-2)', overflowWrap: 'anywhere' }}>{doc.fileName}</span>
            <span />
          </div>
          <div className={'adv-v-msg ' + msg.tone}>{msg.text}</div>
          {outcome?.kind === 'written' && outcome.backupPath && <span className="adv-v-muted">{tr('lootfilter_advanced_views_ExportView.the_previous_file_was_backed', { backupPath: outcome.backupPath })}</span>}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {(ex === 'confirm-foreign' || ex === 'confirm-changed') && (
              <>
                <button type="button" className="adv-sh-btn" disabled={busy} onClick={() => void doWrite(ex === 'confirm-foreign' ? 'foreign' : 'changed')}>
                  <Icon name="save" size={14} />
                  {tr('lootfilter_advanced_views_ExportView.overwrite')}
                </button>
                {ex === 'confirm-changed' && mkBtn(tr('lootfilter_advanced_views_ExportView_2.compare'), 'compare', () => void showCompare())}
                {mkBtn(ex === 'confirm-changed' ? tr('lootfilter_advanced_views_ExportView.keep_theirs') : tr('lootfilter_advanced_views_ExportView_2.cancel'), ex === 'confirm-changed' ? 'cloud' : 'x', () => {
                  if (target?.state === 'changed') setKeptHash(target.hash);
                  lf.dismissOutcome();
                  if (ex === 'confirm-changed') toast({ text: tr('lootfilter_advanced_views_ExportView.kept_the_file_on_disk'), kind: 'info' });
                })}
              </>
            )}
            {ex !== 'confirm-foreign' && ex !== 'confirm-changed' && (
              <button type="button" className="adv-sh-btn" disabled={busy || !gen || ex === 'notfound'} onClick={() => void doWrite()}>
                <Icon name={busy ? 'loader' : 'gamepad'} size={14} spin={busy} />
                {busy ? tr('lootfilter_advanced_views_ExportView.saving') : tr('lootfilter_advanced_views_ExportView.save_to_path_of_exile')}
              </button>
            )}
            {ex === 'verified' && mkBtn(tr('h_lootB_Export.copy_cmd', { cmd: '/reloaditemfilter' }), 'copy', () => void copyCmd())}
            {ex === 'failed' && outcome?.kind === 'error' && outcome.code === 'folder-missing' && mkBtn(tr('lootfilter_advanced_views_ExportView.choose_folder'), 'folder-open', () => void lf.chooseFolder())}
            {ex === 'outside' && target?.state === 'changed' && (
              <>
                {mkBtn(tr('lootfilter_advanced_views_ExportView.keep_theirs'), 'cloud', () => {
                  setKeptHash(target.hash);
                  toast({ text: tr('lootfilter_advanced_views_ExportView.kept_the_file_on_disk'), kind: 'info' });
                })}
                {mkBtn(tr('lootfilter_advanced_views_ExportView_2.overwrite'), 'save', () => void doWrite('changed'), busy)}
                {mkBtn(tr('lootfilter_advanced_views_ExportView_2.compare'), 'compare', () => void showCompare())}
              </>
            )}
            {ex === 'foreign' && mkBtn(tr('lootfilter_advanced_views_ExportView_2.overwrite'), 'save', () => void doWrite('foreign'), busy)}
            {ex === 'failed' && mkBtn(tr('lootfilter_advanced_views_ExportView.try_again'), 'refresh', () => void doWrite(), busy)}
            {ex === 'failed' && outcome?.kind === 'error' && outcome.code !== 'folder-missing' && mkBtn(tr('lootfilter_advanced_views_ExportView.choose_folder'), 'folder-open', () => void lf.chooseFolder())}
          </div>
          <TogglePlain on={lf.settings.autoWrite} onChange={(v) => lf.setSettings({ autoWrite: v })} label={tr('lootfilter_advanced_views_ExportView.write_automatically_after_each_chang')} />
        </div>

        <div className="lf-card adv-v-panel tight">
          <Eyebrow>{tr('lootfilter_advanced_views_ExportView.file_2')}</Eyebrow>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 'var(--s-3)', marginTop: 'var(--s-2)' }}>
            {fileActs.map((a) => (
              <button key={a.label} type="button" className="adv-ex-act" title={a.sub} disabled={a.off} onClick={a.go}>
                <Icon name={a.icon} size={16} style={{ gridRow: '1 / span 2', alignSelf: 'center', color: 'var(--text-muted)' }} />
                <span style={{ display: 'block', color: 'var(--text-strong)', font: '500 14px/1.3 Geist' }}>{a.label}</span>
              </button>
            ))}
          </div>
          <FolderImportCard nav={nav} />
        </div>
      </div>

      <div className="lf-card" style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div className="adv-v-row" style={{ padding: '12px 16px', gap: 10 }}>
          <Eyebrow>{tr('lootfilter_advanced_views_ExportView.preflight')}</Eyebrow>
          <span className="adv-v-muted" style={{ fontSize: 12 }}>{tr('lootfilter_advanced_views_ExportView.checked_live_as_you_edit')}</span>
        </div>
        {pf.rows.map((p, i) => (
          <div key={i} className="adv-ex-pf">
            <span className="adv-ex-ic" style={{ color: p.k === 'ok' ? 'var(--positive-text)' : p.k === 'bad' ? 'var(--negative-text)' : p.k === 'wait' ? 'var(--text-muted)' : 'var(--warning-text)', background: p.k === 'ok' ? 'rgba(79,220,124,.1)' : p.k === 'bad' ? 'rgba(239,70,86,.12)' : p.k === 'wait' ? 'rgba(var(--line-rgb),.08)' : 'rgba(255,153,34,.12)' }}>
              {p.k === 'ok' ? '✓' : p.k === 'wait' ? '…' : '!'}
            </span>
            <span className="adv-v-strong">{p.t}</span>
            <span style={{ color: 'var(--text-2)', fontSize: 12.5, lineHeight: 1.45 }}>{p.s}</span>
            {p.a ? (
              <button type="button" className="btn sm" onClick={() => void act(p)}>
                {p.a.label}
              </button>
            ) : (
              <span />
            )}
          </div>
        ))}
      </div>

      {cmp && (
        <Dialog size="large" title={tr('lootfilter_advanced_views_ExportView.compare_with_the_file_on')} subtitle={path} cancelLabel={tr('lootfilter_advanced_views_ExportView.close')} confirmLabel={null} onCancel={() => setCmp(null)}>
          {cmp.loading && <span className="adv-v-muted">{tr('lootfilter_advanced_views_ExportView.reading_the_file')}</span>}
          {cmp.error && <div className="adv-v-msg bad">{tr('lootfilter_advanced_views_ExportView.the_file_could_not_be', { error: cmp.error })}</div>}
          {cmp.diff && (
            <>
              <div className="adv-v-muted" style={{ marginBottom: 8 }}>
                {cmp.diff.complete ? tr('lootfilter_advanced_views_ExportView.tolocalestring_lines_only_in_the', { removed: cmp.diff.removed.toLocaleString(), added: cmp.diff.added.toLocaleString() }) : tr('lootfilter_advanced_views_ExportView.the_files_differ_too_much')}
                {cmp.diff.complete && cmp.diff.added === 0 && cmp.diff.removed === 0 ? tr('lootfilter_advanced_views_ExportView.the_two_are_identical') : ''}
              </div>
              <div className="adv-ex-diff">
                {cmp.diff.rows.map((r, i) => (
                  <div key={i} className={r.kind === 'same' ? '' : r.kind}>
                    {r.kind === 'add' ? '+ ' : r.kind === 'del' ? '- ' : r.kind === 'same' ? '  ' : ''}
                    {r.kind === 'gap' ? `... ${r.text} ...` : r.text}
                  </div>
                ))}
              </div>
            </>
          )}
        </Dialog>
      )}
    </div>
  );
}
