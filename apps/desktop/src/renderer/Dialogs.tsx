import { useEffect, useMemo, useState } from 'react';
import type { BuildEntry, FolderEntry, TrashEntry } from '../shared/library.js';
import { CLASSES } from '../shared/buildXml';
import { classPortrait, crest } from './art';
import { folderLabel, formatWhen, levelLabel } from './format';
import { Dialog, Icon, Kbd, Select } from './ui';
import { AREA_LABEL, NAV_AREAS } from './areaGate';
import { LEVELING_GUIDE } from '../shared/leagueContent';
import { tr } from './i18n';

// ---- About -----------------------------------------------------------------------------------

interface ChangeEntry {
  version: string;
  date: string;
  groups: { tag: string; items: string[] }[];
}

const CHANGELOG: ChangeEntry[] = [
  {
    version: '0.1.0',
    date: tr('h_rb_Dlg.date'),
    groups: [
      {
        tag: tr('h_rb_Dlg.tag_new'),
        items: [
          tr('Dialogs.path_of_mastery_for_path'),
          LEVELING_GUIDE ? tr('h_rb_Dlg.planner_lvl') : tr('h_rb_Dlg.planner_nolvl'),
          tr('Dialogs.atlas_planner_with_an_optimizer'),
          tr('Dialogs.loot_filter_written_for_your'),
          tr('Dialogs.assistant_that_runs_on_your'),
          tr('Dialogs.import_and_export_of_build'),
        ],
      },
      { tag: tr('h_rb_Dlg.tag_legal'), items: [tr('Dialogs.this_product_isn_t_affiliated')] },
    ],
  },
];

const CREDITS: { name: string; what: string; licence: string }[] = [
  { name: 'NeverSink', what: tr('h_rb_Dlg.cr_neversink'), licence: 'MIT' },
  { name: 'Path of Building', what: tr('h_rb_Dlg.cr_ref'), licence: 'MIT' },
];

const HELP: { head: string; body: string }[] = [
  { head: tr('Dialogs.your_builds'), body: tr('Dialogs.builds_are_path_of_building') },
  { head: tr('h_rb_Dlg.h_importing'), body: tr('Dialogs.paste_a_build_code_or') },
  { head: tr('h_rb_Dlg.h_sharing'), body: tr('Dialogs.on_the_import_export_tab') },
  { head: tr('Dialogs.notes_colours'), body: tr('Dialogs.in_notes_type_followed_by') },
  { head: tr('h_rb_Dlg.h_searching'), body: tr('Dialogs.press_ctrl_k_to_search') },
  { head: tr('h_rb_Dlg.h_deleting'), body: tr('Dialogs.deleting_a_build_removes_it') },
];

export function AboutDialog({ version, engineVersion, interfaceVersion, platform, onClose, onOpenSite, onFeedback }: { version: string; engineVersion?: string; interfaceVersion?: string; platform: string; onClose: () => void; onOpenSite: () => void; onFeedback: () => void }) {
  const layer = (v?: string) => (v && /^\d/.test(v) ? v : 'unknown');
  const [tab, setTab] = useState<'history' | 'help'>('history');
  const [q, setQ] = useState('');
  const query = q.trim().toLowerCase();
  const log = useMemo(
    () =>
      CHANGELOG.map((c) => ({ ...c, groups: c.groups.map((g) => ({ ...g, items: g.items.filter((i) => !query || i.toLowerCase().includes(query) || g.tag.toLowerCase().includes(query)) })).filter((g) => g.items.length) })).filter((c) => c.groups.length),
    [query],
  );
  const help = HELP.filter((h) => !query || h.head.toLowerCase().includes(query) || h.body.toLowerCase().includes(query));
  return (
    <Dialog size="medium" width={820} title={tr('Dialogs.about')} cancelLabel={null} confirmLabel={null} onCancel={onClose} onConfirm={onClose}>
      <div className="about" style={{ display: 'flex', flexDirection: 'column', gap: 14 }} data-screen-label="About / Dialog / Version history">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div className="about-brand">
            <img className="about-logo" src={crest} alt="" />
            <span className="about-name">{tr('Dialogs.path_of_mastery')}</span>
          </div>
          <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>{tr('Dialogs.engine_v_engineversion_interface_v', { engineVersion: layer(engineVersion), interfaceVersion: layer(interfaceVersion), version })}</span>
        </div>
        <div style={{ color: 'var(--text-2)', lineHeight: 1.5 }}>
          <button type="button" className="link-btn" style={{ color: 'var(--gold-text)', textDecoration: 'underline', textUnderlineOffset: 3 }} onClick={onOpenSite}>{tr('Dialogs.website_pathofmastery_gg')}</button>
          <button type="button" className="link-btn" style={{ color: 'var(--gold-text)', textDecoration: 'underline', textUnderlineOffset: 3, display: 'block' }} onClick={onFeedback}>{tr('Dialogs.send_feedback')}</button>
        </div>
        <details>
          <summary style={{ cursor: 'pointer', color: 'var(--text-muted)', fontSize: 13 }}>{tr('Dialogs.credits_and_licences')}</summary>
        <div className="about-credits" style={{ marginTop: 8, display: 'flex', gap: 28, flexWrap: 'wrap', color: 'var(--text-2)', fontSize: 13, lineHeight: 1.5 }}>
          <div>
            <b style={{ color: 'var(--text-display)' }}>{tr('Dialogs.credits')}</b>
            <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
              {CREDITS.map((c) => <li key={c.name}>{c.name}: {c.what}</li>)}
            </ul>
          </div>
          <div>
            <b style={{ color: 'var(--text-display)' }}>{tr('Dialogs.licences')}</b>
            <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
              {CREDITS.map((c) => <li key={c.name}>{c.name}: {c.licence}</li>)}
            </ul>
          </div>
        </div>
        </details>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div className="seg tall" data-lg="tile">
            <button type="button" aria-pressed={tab === 'history'} onClick={() => setTab('history')}>{tr('Dialogs.version_history')}</button>
            <button type="button" aria-pressed={tab === 'help'} onClick={() => setTab('help')}>
              <Icon name="help" size={15} />
              {tr('Dialogs.help')}
            </button>
          </div>
          <span style={{ flex: 1 }} />
          <div className="lib-search" style={{ flex: 'none', width: 240, height: 'var(--control-h)', borderRadius: 10, padding: '0 12px' }}>
            <Icon name="search" size={16} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tab === 'history' ? tr('Dialogs.search_changelog') : tr('Dialogs.search_help')} spellCheck={false} aria-label={tr('Dialogs.search')} />
          </div>
        </div>
        <div className="scroll-y" style={{ maxHeight: 360, padding: '14px 0 0', borderTop: '1px solid rgba(var(--line-rgb),.07)', display: 'flex', flexDirection: 'column' }}>
          {tab === 'history' &&
            log.map((c, i) => (
              <section key={c.version} style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: `${i === 0 ? 0 : 16}px 0 ${i === log.length - 1 ? 0 : 16}px`, borderTop: i === 0 ? 'none' : '1px solid rgba(var(--line-rgb),.07)' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ font: "600 20px/1.2 'Cormorant Garamond',serif", color: 'var(--text-display)' }}>{tr('Dialogs.version_version', { version: c.version })}</span>
                  <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{c.date}</span>
                </div>
                {c.groups.map((g) => (
                  <div key={g.tag} className="chg">
                    <span><span className="tag">{g.tag}</span></span>
                    <ul>{g.items.map((it) => <li key={it}>{it}</li>)}</ul>
                  </div>
                ))}
              </section>
            ))}
          {tab === 'history' && log.length === 0 && <span style={{ color: 'var(--text-muted)' }}>{tr('Dialogs.nothing_in_the_changelog_matches', { value: q })}</span>}
          {tab === 'help' &&
            help.map((h) => (
              <section key={h.head} style={{ padding: '8px 0', display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ font: "600 16px 'Cormorant Garamond',serif", color: 'var(--text-display)' }}>{h.head}</span>
                <span style={{ color: 'var(--text)', fontSize: 14, lineHeight: 1.5 }}>{h.body}</span>
              </section>
            ))}
          {tab === 'help' && help.length === 0 && <span style={{ color: 'var(--text-muted)' }}>{tr('Dialogs.no_help_topic_matches_q', { value: q })}</span>}
        </div>
      </div>
    </Dialog>
  );
}

// ---- Shortcuts -------------------------------------------------------------------------------

const SHORTCUTS: { head: string; rows: [string, string][] }[] = [
  {
    head: tr('h_rb_Dlg.sc_anywhere'),
    rows: [[tr('Dialogs.new_build_from_any_screen'), 'Ctrl N'], [NAV_AREAS.map((a) => AREA_LABEL[a]).join(', '), `Ctrl 1 – ${NAV_AREAS.length}`], [tr('Dialogs.back_to_the_last_area'), 'Alt Left'], [tr('Dialogs.search_everything'), 'Ctrl K'], [tr('Dialogs.assistant'), 'Ctrl J'], [tr('Dialogs.settings'), 'Ctrl ,'], [tr('Dialogs.keyboard_shortcuts'), 'Ctrl /'], [tr('Dialogs.cycle_themes'), 'Alt Shift T'], [tr('Dialogs.switch_light_and_dark'), 'Alt Shift L']],
  },
  {
    head: tr('h_rb_Dlg.sc_library'),
    rows: [[tr('Dialogs.import_a_build'), 'Ctrl I'], [tr('Dialogs.paste_a_code_or_link'), 'Ctrl V'], [tr('Dialogs.search_builds'), 'Ctrl F'], [tr('Dialogs.move_through_builds'), '↑ ↓'], [tr('Dialogs.open_the_selected_build'), 'Enter'], [tr('Dialogs.rename_the_selected_build'), 'F2'], [tr('h_rb_Dlg.sc_delete_build'), tr('Dialogs.del')]],
  },
  {
    head: tr('Dialogs.in_a_build'),
    rows: [[tr('Dialogs.save'), 'Ctrl S'], [tr('Dialogs.save_as'), 'Ctrl Shift S'], [tr('Dialogs.version_history_signed_in'), 'Ctrl H'], [tr('Dialogs.close_build_and_go_back'), 'Ctrl W'], [tr('Dialogs.tree_skills_items_calcs'), 'Ctrl Alt 1 – 4'], [LEVELING_GUIDE ? tr('Dialogs.configuration_compare_party_notes_le') : tr('Dialogs.configuration_compare_party_notes'), LEVELING_GUIDE ? 'Ctrl Alt 5 – 9' : 'Ctrl Alt 5 – 8'], [tr('Dialogs.import_a_build_as_a'), 'Ctrl I'], [tr('Dialogs.zoom_notes_in_out_reset'), 'Ctrl + − 0']],
  },
];

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog size="medium" icon="keyboard" title={tr('Dialogs.keyboard_shortcuts')} cancelLabel={null} confirmLabel={null} onCancel={onClose} onConfirm={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18, paddingTop: 6 }}>
        {SHORTCUTS.map((g) => (
          <section key={g.head}>
            <div style={{ font: '600 10.5px Geist', letterSpacing: '.12em', color: 'var(--gold-label)', paddingBottom: 6 }}>{g.head.toUpperCase()}</div>
            {g.rows.map(([l, k]) => (
              <div key={l} style={{ display: 'flex', alignItems: 'center', gap: 12, minHeight: 32, borderTop: '1px solid rgba(var(--line-rgb),.06)' }}>
                <span style={{ flex: 1, color: 'var(--text-2)' }}>{l}</span>
                <Kbd>{k}</Kbd>
              </div>
            ))}
          </section>
        ))}
      </div>
    </Dialog>
  );
}

// ---- Prompts and confirms --------------------------------------------------------------------

export function NameDialog({ title, label, value, confirmLabel, icon = 'folder', error, onSubmit, onCancel, busy }: { title: string; label: string; value: string; confirmLabel: string; icon?: 'folder' | 'save' | 'info'; error?: string; onSubmit: (v: string) => void; onCancel: () => void; busy?: boolean }) {
  const [v, setV] = useState(value);
  return (
    <Dialog icon={icon} title={title} confirmLabel={confirmLabel} confirmDisabled={!v.trim()} confirmBusy={busy} onCancel={onCancel} onConfirm={() => onSubmit(v.trim())}>
      <label className="field-label">
        <span className="lbl">{label}</span>
        <input className={'input' + (error ? ' bad' : '')} value={v} onChange={(e) => setV(e.target.value)} maxLength={120} spellCheck={false} aria-label={label} />
        {error && <span className="field-msg bad">{error}</span>}
      </label>
    </Dialog>
  );
}

export function ConfirmDialog(p: { title: string; subtitle?: string; body?: React.ReactNode; confirmLabel: string; confirmIcon?: string; tone?: 'primary' | 'danger'; icon?: 'danger' | 'warning' | 'info' | 'save'; altLabel?: string; altIcon?: string; cancelLabel?: string; onConfirm: () => void; onAlt?: () => void; onCancel: () => void }) {
  return (
    <Dialog icon={p.icon ?? (p.tone === 'danger' ? 'danger' : 'warning')} tone={p.tone ?? 'primary'} title={p.title} subtitle={p.subtitle} confirmLabel={p.confirmLabel} confirmIcon={p.confirmIcon} altLabel={p.altLabel} altIcon={p.altIcon} cancelLabel={p.cancelLabel} onConfirm={p.onConfirm} onAlt={p.onAlt} onCancel={p.onCancel}>
      {p.body && <div style={{ color: 'var(--text-2)', lineHeight: 1.5, textWrap: 'pretty' }}>{p.body}</div>}
    </Dialog>
  );
}

export function InfoDialog({ title, body, onClose, icon = 'info' }: { title: string; body: React.ReactNode; onClose: () => void; icon?: 'info' | 'warning' | 'error' }) {
  return (
    <Dialog icon={icon} title={title} cancelLabel={null} confirmLabel={tr('Dialogs.ok')} onCancel={onClose} onConfirm={onClose}>
      <div style={{ color: 'var(--text-2)', lineHeight: 1.5, textWrap: 'pretty' }}>{body}</div>
    </Dialog>
  );
}

// ---- Move ------------------------------------------------------------------------------------

export function MoveDialog({ build, folders, onMove, onCancel }: { build: BuildEntry; folders: FolderEntry[]; onMove: (folder: string) => void; onCancel: () => void }) {
  const options = [{ value: '', label: tr('Dialogs.builds') }, ...folders.map((f) => ({ value: f.path, label: folderLabel(f.path) }))];
  const [to, setTo] = useState(build.folder);
  return (
    <Dialog icon="folder" title={tr('Dialogs.move_build')} subtitle={build.name} confirmLabel={tr('Dialogs.move')} confirmDisabled={to === build.folder} onCancel={onCancel} onConfirm={() => onMove(to)}>
      <label className="field-label">
        <span className="lbl">{tr('Dialogs.folder')}</span>
        <Select ariaLabel={tr('Dialogs.folder')} width="100%" value={to} options={options} onChange={setTo} />
      </label>
    </Dialog>
  );
}

// ---- Save As ---------------------------------------------------------------------------------

export function SaveAsDialog({ name, folder, folders, error, onSave, onCancel }: { name: string; folder: string; folders: FolderEntry[]; error?: string; onSave: (name: string, folder: string) => void; onCancel: () => void }) {
  const [n, setN] = useState(name);
  const [f, setF] = useState(folder);
  const options = [{ value: '', label: tr('Dialogs.builds') }, ...folders.map((x) => ({ value: x.path, label: folderLabel(x.path) }))];
  return (
    <Dialog icon="save" title={tr('Dialogs.save_as')} confirmLabel={tr('Dialogs.save')} confirmIcon="save" confirmDisabled={!n.trim()} onCancel={onCancel} onConfirm={() => onSave(n.trim(), f)}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <label className="field-label">
          <span className="lbl">{tr('Dialogs.build_name')}</span>
          <input className={'input' + (error ? ' bad' : '')} value={n} onChange={(e) => setN(e.target.value)} maxLength={120} spellCheck={false} aria-label={tr('Dialogs.build_name')} />
        </label>
        <label className="field-label">
          <span className="lbl">{tr('Dialogs.folder')}</span>
          <Select ariaLabel={tr('Dialogs.folder')} width="100%" value={f} options={options} onChange={setF} />
        </label>
        {error && <span className="field-msg bad">{error}</span>}
      </div>
    </Dialog>
  );
}

// ---- New build -------------------------------------------------------------------------------

export function NewBuildDialog({ initialClass, onCreate, onCancel, busy }: { initialClass: string; onCreate: (cls: string, name: string) => void; onCancel: () => void; busy?: boolean }) {
  const [cls, setCls] = useState(initialClass);
  const [name, setName] = useState('');
  const placeholder = tr('Dialogs.new_cls_build', { cls });
  return (
    <Dialog size="medium" icon="plus" title={tr('Dialogs.new_build')} subtitle={tr('Dialogs.pick_a_class_you_choose')} confirmLabel={tr('Dialogs.create_build')} confirmIcon="plus" confirmBusy={busy} onCancel={onCancel} onConfirm={() => onCreate(cls, name.trim() || placeholder)}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div className="class-grid" role="radiogroup" aria-label={tr('Dialogs.class')} onKeyDown={(e) => { if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); e.stopPropagation(); onCreate(cls, name.trim() || placeholder); } }}>
          {CLASSES.map((c) => (
            <button key={c.name} type="button" role="radio" aria-checked={c.name === cls} {...(c.name === cls ? { 'data-autofocus': '' } : {})} className="class-opt" onClick={() => setCls(c.name)}>
              <span className="portrait" style={{ backgroundImage: `url(${classPortrait(c.name)})`, ['--cls' as string]: `var(--class-${c.name.toLowerCase()})`, boxShadow: `0 0 0 1.5px color-mix(in srgb, var(--class-${c.name.toLowerCase()}) 60%, transparent)` }} />
              {c.name}
            </button>
          ))}
        </div>
        <label className="field-label">
          <span className="lbl">{tr('Dialogs.build_name')}</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={placeholder} maxLength={120} spellCheck={false} aria-label={tr('Dialogs.build_name')} />
        </label>
      </div>
    </Dialog>
  );
}

// ---- Recently deleted ------------------------------------------------------------------------

export function TrashDialog({ items, onRestore, onPurge, onEmpty, onClose }: { items: TrashEntry[]; onRestore: (t: TrashEntry) => void; onPurge: (t: TrashEntry) => void; onEmpty: () => void; onClose: () => void }) {
  return (
    <Dialog size="medium" icon="trash" title={tr('Dialogs.recently_deleted')} subtitle={tr('Dialogs.builds_stay_here_for_30')} cancelLabel={null} confirmLabel={tr('Dialogs.close')} confirmIcon="x" onCancel={onClose} onConfirm={onClose} altLabel={items.length ? tr('Dialogs.empty') : undefined} altIcon="trash" onAlt={onEmpty}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {items.length === 0 && <span style={{ color: 'var(--text-muted)', padding: '16px 0' }}>{tr('Dialogs.nothing_has_been_deleted_lately')}</span>}
        {items.map((t) => (
          <div key={t.token} style={{ display: 'flex', alignItems: 'center', gap: 12, minHeight: 48, borderTop: '1px solid rgba(var(--line-rgb),.06)' }}>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
              <span className="ellipsis" style={{ color: 'var(--text-strong)' }}>{t.name}</span>
              <span className="ellipsis" style={{ color: 'var(--text-muted)', fontSize: 12 }}>{tr('Dialogs.info_folder_deleted_deletedatms', { info: levelLabel(t.info), folder: folderLabel(t.folder), deletedAtMs: formatWhen(t.deletedAtMs) })}</span>
            </div>
            <button type="button" className="btn sm" onClick={() => onRestore(t)}>
              <Icon name="undo" size={14} />
              {tr('Dialogs.restore')}
            </button>
            <button type="button" className="btn sm icon ghost" aria-label={tr('Dialogs.delete_name_for_good', { name: t.name })} title={tr('Dialogs.delete_for_good')} onClick={() => onPurge(t)}>
              <Icon name="trash" size={14} />
            </button>
          </div>
        ))}
      </div>
    </Dialog>
  );
}

export function useEscape(handler: () => void): void {
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && handler();
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  });
}
