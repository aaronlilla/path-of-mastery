import { useEffect, useRef, useState } from 'react';
import { STRICTNESS } from '../../../../shared/lootfilter/styles.js';
import { rowState, type RowState } from '../../../../shared/lootfilter/fileState.js';
import { Dialog, Icon, PortalMenu, useToast } from '../../../ui';
import { artFor } from '../../../gameArt';
import { classKey, classPortrait } from '../../../art';
import { useLf } from '../../lfStore';
import type { LfNav } from '../../LootFilterArea';
import { copyText, fmtAgo } from '../sim/kit';
import '../sim/adv-v.css';
import { tr } from '../../../i18n';


export function FiltersView({ nav }: { nav: LfNav }) {
  const lf = useLf();
  const toast = useToast();
  const filters = lf.state.filters;
  const [states, setStates] = useState<Record<string, RowState>>({});
  const [menuId, setMenuId] = useState<string | null>(null);
  const menuAnchor = useRef<HTMLElement | null>(null);
  const [rename, setRename] = useState<{ id: string; name: string } | null>(null);
  const [del, setDel] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);

  // What is on disk for each filter, checked against the hash of the file the app wrote.
  useEffect(() => {
    let dead = false;
    void (async () => {
      const next: Record<string, RowState> = {};
      await Promise.all(
        filters.map(async (f) => {
          if (!f.written) {
            next[f.id] = rowState(undefined, null, f.account);
            return;
          }
          const r = await window.pom.lootFilter.inspect(f.written.folder || lf.settings.gameFolder, f.fileName, f.written.fileHash);
          next[f.id] = rowState(f.written, r.ok ? r.value : null, f.account);
        }),
      );
      if (!dead) setStates(next);
    })();
    return () => {
      dead = true;
    };
  }, [filters, lf.settings.gameFolder, lf.target]);

  const build = lf.build && lf.build.info.valid ? lf.build : null;
  const open = (id: string): void => {
    lf.switchFilter(id);
    nav.setAdvancedView('overview');
  };

  const importText = (name: string, text: string): void => {
    void lf.importAny(name.replace(/\.(filter|pomrules)$/i, ''), text).then((res) => toast({ text: res.message, kind: res.done ? 'info' : 'error' }));
  };
  // A share link or a rule pack pasted anywhere on this screen is imported like a dropped file.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent): void => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const text = e.clipboardData?.getData('text') ?? '';
      if (!text.trim()) return;
      e.preventDefault();
      importText(tr('lootfilter_advanced_views_FiltersView.pasted_filter'), text);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const importFile = async (): Promise<void> => {
    const r = await window.pom.lootFilter.importFile();
    if (!r.ok) toast({ text: r.error, kind: 'error' });
    else if (r.value) importText(r.value.name, r.value.text);
  };
  const onDrop = async (e: React.DragEvent): Promise<void> => {
    e.preventDefault();
    setDropping(false);
    const f = e.dataTransfer.files[0];
    if (!f) return;
    if (!/\.(filter|pomrules)$/i.test(f.name)) {
      toast({ text: tr('lootfilter_advanced_views_FiltersView.drop_a_filter_file'), kind: 'error' });
      return;
    }
    importText(f.name, await f.text());
  };

  const newFromBase = (): void => {
    lf.newFilter(tr('lootfilter_advanced_views_FiltersView.filter_length', { value: filters.length + 1 }));
    nav.setAdvancedView('start');
  };
  const forBuild = (): void => {
    if (!build) return;
    lf.newFilter(tr('lootfilter_advanced_views_FiltersView.name_filter', { name: build.name }), { followBuild: true });
    nav.setAdvancedView('start');
  };

  // A FilterBlade save is a .filter text file made from NeverSink's filter, so it goes through the same reader as any import.
  const importBlade = async (): Promise<void> => {
    const r = await window.pom.lootFilter.importFile();
    if (!r.ok) return void toast({ text: r.error, kind: 'error' });
    if (!r.value) return;
    const name = r.value.name.replace(/\.filter$/i, '');
    const res = await lf.importFilterText(name, r.value.text);
    if (res.needChoice) toast({ text: res.bladeMessage, kind: 'info', action: { label: tr('lootfilter_advanced_views_FiltersView.review'), run: () => nav.setAdvancedView('customize') } });
    else toast({ text: res.bladeMessage, kind: 'info' });
  };

  const menuFilter = filters.find((f) => f.id === menuId);
  const actions: { title: string; sub: string; go: () => void; dashed?: boolean }[] = [
    { title: tr('lootfilter_advanced_views_FiltersView.new_from_neversink'), sub: tr('lootfilter_advanced_views_FiltersView.start_from_any_of_the'), go: newFromBase },
    { title: tr('lootfilter_advanced_views_FiltersView.import_a_filter'), sub: tr('lootfilter_advanced_views_FiltersView.or_drop_a_file_anywhere'), go: () => void importFile(), dashed: true },
    { title: tr('lootfilter_advanced_views_FiltersView.import_a_filterblade_save'), sub: tr('lootfilter_advanced_views_FiltersView.reads_the_save_file_and'), go: () => void importBlade() },
    { title: tr('lootfilter_advanced_views_FiltersView.open_recovery_file'), sub: tr('lootfilter_advanced_views_FiltersView.brings_back_changes_from_a'), go: () => void lf.openRecoveryFile() },
  ];

  const pill = (s: RowState): { c: string; l: string } =>
    s === 'written' ? { c: 'var(--positive-text)', l: tr('lootfilter_advanced_views_FiltersView.written_to_game') } : s === 'synced' ? { c: 'var(--info)', l: tr('lootfilter_advanced_views_FiltersView.synced_to_account') } : s === 'conflict' ? { c: 'var(--negative-text)', l: tr('lootfilter_advanced_views_FiltersView_2.conflict') } : { c: 'var(--text-muted)', l: tr('lootfilter_advanced_views_FiltersView.local_only') };

  const heroImg = build ? classPortrait(classKey(build.info)) : undefined;
  const mainArt = build ? artFor(build.info.mainSkill, 'gems') : undefined;

  return (
    <div
      className="adv-v-page"
      style={{ position: 'relative', gap: 0 }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        if (!dropping) setDropping(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
      }}
      onDrop={(e) => void onDrop(e)}
    >
      <div className="adv-fl-wrap">
        <div className="adv-v-head">
          <span className="adv-v-title">{tr('lootfilter_advanced_views_FiltersView.my_filters')}</span>
          <span className="adv-v-sub">{tr('lootfilter_advanced_views_FiltersView.no_account_needed_filters_live')}</span>
        </div>
        <div className="adv-fl-top">
          <button type="button" className="adv-fl-card hero lf-card" onClick={forBuild} disabled={!build} style={!build ? { opacity: 0.85, cursor: 'default' } : undefined}>
            {heroImg ? (
              <img src={heroImg} alt="" style={{ flex: 'none', width: 84, height: 84, borderRadius: '50%', objectFit: 'cover', boxShadow: '0 0 0 1px rgba(var(--accent-rgb),.5),0 10px 30px rgba(0,0,0,.5)' }} />
            ) : (
              <span style={{ flex: 'none', width: 84, height: 84, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(var(--accent-rgb),.12)', boxShadow: '0 0 0 1px rgba(var(--accent-rgb),.5)' }}>
                {mainArt ? <img src={mainArt} alt="" style={{ width: 52, height: 52, objectFit: 'contain' }} /> : <Icon name="tree" size={34} style={{ color: 'var(--gold-text)' }} />}
              </span>
            )}
            <span style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
              <span className="lf-eyebrow">{tr('lootfilter_advanced_views_FiltersView.recommended')}</span>
              <span style={{ font: "600 26px/1.1 'Cormorant Garamond',serif", color: 'var(--text-display)' }}>{tr('lootfilter_advanced_views_FiltersView.make_a_filter_for_my')}</span>
              {build ? (
                <span style={{ color: 'var(--text-2)' }}>
                  {[build.name, build.info.ascendClassName || build.info.className, build.info.mainSkill, build.info.level ? tr('lootfilter_advanced_views_FiltersView_2.level', { level: build.info.level }) : ''].filter(Boolean).join(' · ')}
                </span>
              ) : (
                <span style={{ color: 'var(--text-2)' }}>{tr('lootfilter_advanced_views_FiltersView.no_build_is_open_open')}</span>
              )}
              <span className="adv-v-muted" style={{ lineHeight: 1.45, fontSize: 12.5 }}>{tr('lootfilter_advanced_views_FiltersView.neversink_semi_strict_plus_rules')}</span>
            </span>
          </button>
          {actions.map((a) => (
            <button key={a.title} type="button" className={'adv-fl-card lf-card' + (a.dashed ? ' dashed' : '')} onClick={a.go}>
              <span style={{ color: 'var(--text-strong)', fontWeight: 500 }}>{a.title}</span>
              <span className="adv-v-muted" style={{ lineHeight: 1.4 }} title={a.sub}>{a.sub}</span>
            </button>
          ))}
        </div>

        <div className="lf-card" style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div className="adv-fl-row th">
            <span>{tr('lootfilter_advanced_views_FiltersView.name')}</span>
            <span>{tr('lootfilter_advanced_views_FiltersView.game')}</span>
            <span>{tr('lootfilter_advanced_views_FiltersView.strictness')}</span>
            <span>{tr('lootfilter_advanced_views_FiltersView.build')}</span>
            <span>{tr('lootfilter_advanced_views_FiltersView.edited')}</span>
            <span>{tr('lootfilter_advanced_views_FiltersView.changes')}</span>
            <span>{tr('lootfilter_advanced_views_FiltersView.state')}</span>
            <span />
          </div>
          {filters.map((f) => {
            const st = pill(states[f.id] ?? 'local');
            return (
              <div key={f.id} className="adv-fl-row" onDoubleClick={() => open(f.id)}>
                <span className="adv-v-strong adv-v-ellip" title={f.name}>{f.name}</span>
                <span style={{ color: 'var(--text-2)', whiteSpace: 'nowrap' }}>{tr('lootfilter_advanced_views_FiltersView.poe_1')}</span>
                <span style={{ color: 'var(--text-2)', whiteSpace: 'nowrap' }}>{STRICTNESS[f.setup.strictness]?.name ?? tr('lootfilter_advanced_views_FiltersView.semi_strict')}</span>
                <span className="adv-v-ellip" style={{ color: 'var(--text-2)' }}>{f.buildName ?? tr('lootfilter_advanced_views_FiltersView.none')}</span>
                <span className="adv-v-muted" style={{ whiteSpace: 'nowrap' }}>{fmtAgo(f.editedAt)}</span>
                <span className="adv-v-muted adv-v-ellip">
                  <a
                    href="#changes"
                    className="adv-sh-link"
                    title={tr('lootfilter_advanced_views_FiltersView.review_neversink_update')}
                    onClick={(e) => {
                      e.preventDefault();
                      lf.switchFilter(f.id);
                      nav.setAdvancedView('update');
                    }}
                  >
                    {f.rules.length ? tr('lootfilter_advanced_views_FiltersView.count_changes', { count: f.rules.length }) : tr('lootfilter_advanced_views_FiltersView.no_changes')}
                  </a>
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: st.c, fontSize: 12.5, whiteSpace: 'nowrap' }}>
                  <span className="adv-v-dot" style={{ width: 6, height: 6, background: st.c }} />
                  {st.l}
                </span>
                <span style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                  <button type="button" className="btn sm" onClick={() => open(f.id)}>
                    <Icon name="external" size={14} />
                    {tr('lootfilter_advanced_views_FiltersView.open')}
                  </button>
                  <button
                    type="button"
                    className="btn ghost sm icon"
                    title={tr('lootfilter_advanced_views_FiltersView.duplicate_rename_export_delete')}
                    aria-label={tr('lootfilter_advanced_views_FiltersView.more')}
                    onClick={(e) => {
                      menuAnchor.current = e.currentTarget;
                      setMenuId(menuId === f.id ? null : f.id);
                    }}
                  >
                    <Icon name="more" size={12} />
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <PortalMenu anchor={menuAnchor} open={!!menuFilter} onClose={() => setMenuId(null)} align="right" label={tr('lootfilter_advanced_views_FiltersView.filter_actions')} minWidth={190}>
        {menuFilter && (
          <>
            <button type="button" className="menu-item" role="menuitem" onClick={() => { open(menuFilter.id); setMenuId(null); }}>
              <Icon name="external" size={14} />
              <span className="grow">{tr('lootfilter_advanced_views_FiltersView.open')}</span>
              <span className="kbd">{tr('lootfilter_advanced_views_FiltersView.enter')}</span>
            </button>
            <button type="button" className="menu-item" role="menuitem" onClick={() => { lf.duplicateFilter(menuFilter.id); setMenuId(null); toast({ text: tr('lootfilter_advanced_views_FiltersView.duplicated_name', { name: menuFilter.name }), kind: 'ok' }); }}>
              <Icon name="duplicate" size={14} />
              <span className="grow">{tr('lootfilter_advanced_views_FiltersView.duplicate')}</span>
            </button>
            <button type="button" className="menu-item" role="menuitem" onClick={() => { setRename({ id: menuFilter.id, name: menuFilter.name }); setMenuId(null); }}>
              <Icon name="rename" size={14} />
              <span className="grow">{tr('lootfilter_advanced_views_FiltersView.rename')}</span>
              <span className="kbd">{tr('lootfilter_advanced_views_FiltersView.f2')}</span>
            </button>
            <button type="button" className="menu-item" role="menuitem" onClick={() => { lf.switchFilter(menuFilter.id); nav.setAdvancedView('export'); setMenuId(null); }}>
              <Icon name="export" size={14} />
              <span className="grow">{tr('lootfilter_advanced_views_FiltersView.export')}</span>
            </button>
            <div style={{ height: 1, margin: '6px 4px', background: 'rgba(var(--line-rgb),.08)' }} />
            <button type="button" className="menu-item danger" role="menuitem" disabled={filters.length <= 1} title={filters.length <= 1 ? tr('lootfilter_advanced_views_FiltersView.you_need_at_least_one') : undefined} onClick={() => { setDel(menuFilter.id); setMenuId(null); }}>
              <Icon name="trash" size={14} />
              <span className="grow">{tr('lootfilter_advanced_views_FiltersView.delete')}</span>
              <span className="kbd">{tr('lootfilter_advanced_views_FiltersView.del')}</span>
            </button>
          </>
        )}
      </PortalMenu>

      {rename && (
        <Dialog title={tr('lootfilter_advanced_views_FiltersView.rename_filter')} subtitle={tr('lootfilter_advanced_views_FiltersView.this_is_the_name_you')} confirmLabel={tr('lootfilter_advanced_views_FiltersView.rename')} onCancel={() => setRename(null)} onConfirm={() => { lf.renameFilter(rename.id, rename.name); setRename(null); }}>
          <input className="input" value={rename.name} aria-label={tr('lootfilter_advanced_views_FiltersView.filter_name')} onChange={(e) => setRename({ ...rename, name: e.target.value })} />
        </Dialog>
      )}
      {del && (
        <Dialog tone="danger" icon="warning" title={tr('lootfilter_advanced_views_FiltersView.delete_this_filter')} subtitle={filters.find((f) => f.id === del)?.name} confirmLabel={tr('lootfilter_advanced_views_FiltersView.delete')} note={tr('lootfilter_advanced_views_FiltersView.its_rules_are_removed_from')} onCancel={() => setDel(null)} onConfirm={() => { lf.deleteFilter(del); setDel(null); }}>
          <span className="adv-v-muted">{tr('lootfilter_advanced_views_FiltersView.this_cannot_be_undone')}</span>
        </Dialog>
      )}

      {dropping && (
        <div className="adv-fl-drop">
          <span style={{ font: "600 26px 'Cormorant Garamond',serif", color: 'var(--text-display)' }}>{tr('lootfilter_advanced_views_FiltersView.drop_to_import')}</span>
          <span style={{ color: 'var(--text-2)' }}>{tr('lootfilter_advanced_views_FiltersView.filter_files_from_poe_1')}</span>
        </div>
      )}
    </div>
  );
}
