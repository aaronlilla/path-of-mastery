import { useEffect, useState, type ReactNode } from 'react';
import type { CatalogItem } from '../../../../shared/lootfilter/catalog.js';
import type { LootFilterSettings, WriteOutcome } from '../../../../shared/lootfilter/ipcTypes.js';
import { Dialog, Icon, Segmented, Switch } from '../../../ui';
import { LabelChip, groundFor } from '../../LabelChip';
import { useLf } from '../../lfStore';
import type { ImportResult } from './selection';
import { tr } from '../../../i18n';

export function ConfirmHide({ item, title, body, yes, onYes, onNo }: { item: CatalogItem; title: string; body: ReactNode; yes: string; onYes: () => void; onNo: () => void }) {
  const lf = useLf();
  const look = lf.evaluateCatalogItem(item)?.style ?? item.style;
  return (
    <Dialog size="small" icon="warning" tone="danger" title={title} cancelLabel={tr('lootfilter_advanced_shell_Dialogs.keep_it_shown')} confirmLabel={yes} confirmIcon="eye-off" onCancel={onNo} onConfirm={onYes}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ padding: 14, borderRadius: 10, background: groundFor('dark'), display: 'flex', justifyContent: 'center' }}>
          <LabelChip name={item.name} style={look} />
        </div>
        <span style={{ color: 'var(--text-2)', lineHeight: 1.5 }}>{body}</span>
      </div>
    </Dialog>
  );
}

export function GameDialog({ which, onClose }: { which: string; onClose: () => void }) {
  return (
    <Dialog size="small" icon="info" title={tr('lootfilter_advanced_shell_Dialogs.which_is_not_supported_yet', { which })} cancelLabel={null} confirmLabel={tr('lootfilter_advanced_shell_Dialogs.stay_on_poe_1')} confirmIcon="check" onCancel={onClose} onConfirm={onClose}>
      <span style={{ color: 'var(--text-2)', lineHeight: 1.5 }}>
        {tr('lootfilter_advanced_shell_Dialogs.this_app_builds_filters_for', { which })}
      </span>
    </Dialog>
  );
}

export function ImportDialog({ r, onClose }: { r: ImportResult; onClose: () => void }) {
  const rows: [string, string][] = [
    [tr('lootfilter_advanced_shell_Dialogs_2.game'), r.game],
    [tr('lootfilter_advanced_shell_Dialogs_2.based_on'), r.basedOn],
    [tr('lootfilter_advanced_shell_Dialogs_2.rules'), r.rules],
    [tr('lootfilter_advanced_shell_Dialogs_2.problems'), r.problems],
  ];
  return (
    <Dialog
      size="small"
      icon="import"
      title={r.name}
      cancelLabel={tr('lootfilter_advanced_shell_Dialogs.cancel')}
      confirmLabel={tr('lootfilter_advanced_shell_Dialogs.open')}
      confirmIcon="external"
      onCancel={onClose}
      onConfirm={() => {
        r.onOpen?.();
        onClose();
      }}
    >
      <div style={{ display: 'grid', gridTemplateColumns: '110px minmax(0,1fr)', gap: '8px 12px', fontSize: 13 }}>
        {rows.map(([k, v]) => (
          <span key={k} style={{ display: 'contents' }}>
            <span style={{ color: 'var(--text-muted)' }}>{k}</span>
            <span style={{ color: k === rows[3]![0] && !/^none/i.test(v) ? 'var(--warning-text)' : 'var(--text-strong)' }}>{v}</span>
          </span>
        ))}
      </div>
      {r.note && <p style={{ color: 'var(--text-muted)', fontSize: 12.5, margin: '12px 0 0' }}>{r.note}</p>}
    </Dialog>
  );
}

const KEYS: [string, string][] = [
  ['Ctrl K', tr('lootfilter_advanced_shell_Dialogs.search_the_app_areas_builds')],
  ['Ctrl S', tr('lootfilter_advanced_shell_Dialogs.write_to_game')],
  ['Ctrl Z / Ctrl Shift Z', tr('lootfilter_advanced_shell_Dialogs.undo_redo')],
  ['Ctrl J', tr('lootfilter_advanced_shell_Dialogs.ask_for_a_change')],
  ['Ctrl I', tr('lootfilter_advanced_shell_Dialogs.import_a_build')],
  ['Ctrl ,', tr('lootfilter_advanced_shell_Dialogs.settings')],
  ['Alt 0 to 7', tr('lootfilter_advanced_shell_Dialogs.switch_screen')],
  ['I', tr('lootfilter_advanced_shell_Dialogs.show_or_hide_the_inspector')],
  ['M', tr('lootfilter_advanced_shell_Dialogs.move_the_selected_item_to')],
  ['1 to 9', tr('lootfilter_advanced_shell_Dialogs.pick_a_tier_in_the')],
  ['L', tr('lootfilter_advanced_shell_Dialogs_2.change_look')],
  ['S', tr('lootfilter_advanced_shell_Dialogs_2.sound_picker')],
  ['H', tr('lootfilter_advanced_shell_Dialogs_2.hide_or_show')],
  ['K', tr('lootfilter_advanced_shell_Dialogs_2.lock_or_unlock')],
  ['E', tr('lootfilter_advanced_shell_Dialogs_2.explain')],
  ['J', tr('lootfilter_advanced_shell_Dialogs_2.jump_to_rule')],
  ['Esc', tr('lootfilter_advanced_shell_Dialogs.close')],
  ['?', tr('lootfilter_advanced_shell_Dialogs_2.this_sheet')],
];

export function KeysDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog size="small" icon="keyboard" title={tr('lootfilter_advanced_shell_Dialogs.keyboard_shortcuts')} cancelLabel={null} confirmLabel={tr('lootfilter_advanced_shell_Dialogs.close')} onCancel={onClose} onConfirm={onClose}>
      <div style={{ display: 'grid', gridTemplateColumns: '150px minmax(0,1fr)', gap: '6px 14px' }}>
        {KEYS.map(([k, t]) => (
          <span key={k} style={{ display: 'contents' }}>
            <span style={{ font: "500 11.5px 'Geist Mono'", color: 'var(--gold-text)' }}>{k}</span>
            <span style={{ color: 'var(--text-2)', fontSize: 13 }}>{t}</span>
          </span>
        ))}
      </div>
    </Dialog>
  );
}

export function WriteConfirm({ outcome, onYes, onNo }: { outcome: Extract<WriteOutcome, { kind: 'needs-confirm' }>; onYes: () => void; onNo: () => void }) {
  return (
    <Dialog size="small" icon="warning" title={tr('lootfilter_advanced_shell_Dialogs.replace_the_file_in_your')} cancelLabel={tr('lootfilter_advanced_shell_Dialogs.cancel')} confirmLabel={tr('lootfilter_advanced_shell_Dialogs.replace_it')} confirmIcon="download" onCancel={onNo} onConfirm={onYes} note={tr('lootfilter_advanced_shell_Dialogs.the_old_file_is_kept')}>
      <span style={{ color: 'var(--text-2)', lineHeight: 1.5 }}>
        {outcome.why === 'foreign' ? tr('lootfilter_advanced_shell_Dialogs.a_filter_with_this_name') : tr('lootfilter_advanced_shell_Dialogs.the_filter_in_your_game')}
      </span>
      <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 9, background: 'rgba(var(--shadow-rgb),calc(.3*var(--shadow-k)))', font: "500 12px/1.5 'Geist Mono'", color: 'var(--text-2)', overflowWrap: 'anywhere' }}>{outcome.path}</div>
    </Dialog>
  );
}

// ---- Settings --------------------------------------------------------------------------------------

type SetRow =
  | { k: 'tg'; l: string; h?: string; f: 'showPrices' | 'confirmValuable' | 'reduceMotion' | 'soundPreview' | 'autoWrite' | 'checkNeverSink' | 'quickSetup' }
  | { k: 'seg'; l: string; h?: string; opts: { v: string; l: string }[]; get: (s: LootFilterSettings) => string; set: (v: string) => Partial<LootFilterSettings> }
  | { k: 'path' }
  | { k: 'league' };

const SECTIONS: { name: string; icon: string; rows: SetRow[] }[] = [
  {
    name: tr('lootfilter_advanced_shell_Dialogs_2.general'),
    icon: 'sliders',
    rows: [
      { k: 'tg', l: tr('lootfilter_advanced_shell_Dialogs.show_prices_on_labels'), h: tr('lootfilter_advanced_shell_Dialogs_2.poe_ninja_value_next_to_each'), f: 'showPrices' },
      { k: 'tg', l: tr('lootfilter_advanced_shell_Dialogs.confirm_before_hiding_valuable_items'), h: tr('lootfilter_advanced_shell_Dialogs.asks_first_when_an_item'), f: 'confirmValuable' },
      { k: 'tg', l: tr('lootfilter_advanced_shell_Dialogs.hear_sound_previews'), h: tr('lootfilter_advanced_shell_Dialogs.plays_a_short_preview_tone'), f: 'soundPreview' },
      { k: 'tg', l: tr('lootfilter_advanced_shell_Dialogs.reduce_motion'), h: tr('lootfilter_advanced_shell_Dialogs.turns_off_transitions'), f: 'reduceMotion' },
      { k: 'seg', l: tr('lootfilter_advanced_shell_Dialogs_2.prices_in'), opts: [{ v: 'Chaos', l: 'Chaos' }, { v: 'Divine', l: 'Divine' }], get: (s) => s.currencyUnit, set: (v) => ({ currencyUnit: v === 'Divine' ? 'Divine' : 'Chaos' }) },
    ],
  },
  {
    name: tr('lootfilter_advanced_shell_Dialogs_2.saving'),
    icon: 'save',
    rows: [
      { k: 'path' },
      { k: 'tg', l: tr('lootfilter_advanced_shell_Dialogs.write_after_every_change'), h: tr('lootfilter_advanced_shell_Dialogs.keeps_the_file_in_the'), f: 'autoWrite' },
      { k: 'seg', l: tr('lootfilter_advanced_shell_Dialogs.keep_backups'), h: tr('lootfilter_advanced_shell_Dialogs.before_each_write_this_many'), opts: [{ v: '0', l: tr('lootfilter_advanced_shell_Dialogs_2.none') }, { v: '5', l: '5' }, { v: '20', l: '20' }], get: (s) => String(s.backups), set: (v) => ({ backups: Number(v) }) },
    ],
  },
  {
    name: tr('lootfilter_advanced_shell_Dialogs_2.startup'),
    icon: 'power',
    rows: [
      { k: 'seg', l: tr('lootfilter_advanced_shell_Dialogs.open_on_launch'), opts: [{ v: 'My Filters', l: tr('lootfilter_advanced_AdvancedApp.my_filters') }, { v: 'Last filter', l: tr('lootfilter_advanced_shell_Dialogs.last_filter') }], get: (s) => s.startWith, set: (v) => ({ startWith: v === 'My Filters' ? 'My Filters' : 'Last filter' }) },
      { k: 'tg', l: tr('lootfilter_advanced_shell_Dialogs.check_for_neversink_updates'), h: tr('lootfilter_advanced_shell_Dialogs.looks_for_a_newer_neversink'), f: 'checkNeverSink' },
      { k: 'tg', l: tr('lootfilter_advanced_shell_Dialogs.quick_setup_for_new_filters'), h: tr('lootfilter_advanced_shell_Dialogs.asks_a_few_questions_when'), f: 'quickSetup' },
    ],
  },
  {
    name: tr('lootfilter_advanced_shell_Dialogs_2.prices'),
    icon: 'coins',
    rows: [
      { k: 'league' },
      { k: 'seg', l: tr('lootfilter_advanced_shell_Dialogs_2.refresh'), h: tr('lootfilter_advanced_shell_Dialogs.how_often_poe_ninja_prices'), opts: [{ v: '15', l: tr('lootfilter_advanced_shell_Dialogs_2.t_15_min') }, { v: '30', l: tr('lootfilter_advanced_shell_Dialogs_2.t_30_min') }, { v: '60', l: tr('lootfilter_advanced_shell_Dialogs_2.t_1_hour') }], get: (s) => String(s.priceRefreshMinutes), set: (v) => ({ priceRefreshMinutes: Number(v) }) },
    ],
  },
];

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const lf = useLf();
  const [sec, setSec] = useState(0);
  const [league, setLeague] = useState(lf.settings.league);
  useEffect(() => {
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', esc, true);
    return () => document.removeEventListener('keydown', esc, true);
  }, [onClose]);
  const s = lf.settings;
  const cur = SECTIONS[sec]!;
  return (
    <div className="adv-sh-scrim" onClick={onClose} style={{ zIndex: 95 }}>
      <div className="adv-sh-settings" data-lg="pop" role="dialog" aria-modal="true" aria-label={tr('lootfilter_advanced_shell_Dialogs.loot_filter_settings')} onClick={(e) => e.stopPropagation()}>
        <div style={{ padding: 'var(--s-8) var(--s-6)', display: 'flex', flexDirection: 'column', gap: 2, borderRight: '1px solid rgba(var(--line-rgb),.08)' }}>
          <span style={{ padding: '0 var(--s-6) var(--s-6)', font: "600 22px 'Cormorant Garamond',serif", color: 'var(--text-display)' }}>{tr('lootfilter_advanced_shell_Dialogs.settings')}</span>
          {SECTIONS.map((x, i) => (
            <button key={x.name} type="button" className="adv-sh-setnav" aria-current={i === sec} onClick={() => setSec(i)}>
              <Icon name={x.icon} size={14} style={{ opacity: 0.85 }} />
              {x.name}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={{ padding: 'var(--s-8) var(--s-9) var(--s-6)', display: 'flex', alignItems: 'center' }}>
            <span className="lf-eyebrow" style={{ flex: 1 }}>{cur.name.toUpperCase()}</span>
            <button type="button" className="adv-sh-ib sm" aria-label={tr('lootfilter_advanced_shell_Dialogs.close')} onClick={onClose}>
              <Icon name="x" size={14} />
            </button>
          </div>
          <div className="lf-scroll" style={{ flex: 1, padding: '0 var(--s-9) var(--s-7)', display: 'flex', flexDirection: 'column' }}>
            {cur.rows.map((r, i) => {
              if (r.k === 'path')
                return (
                  <div key={i}>
                  <div className="adv-sh-setrow">
                    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                      <span style={{ color: 'var(--text-strong)' }}>{tr('lootfilter_advanced_shell_Dialogs.game_folder')}</span>
                      <span style={{ color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.45 }}>{tr('lootfilter_advanced_shell_Dialogs.where_filters_are_written_for')}</span>
                    </div>
                    <span className="ellipsis" title={lf.gameFolder} style={{ font: "500 12px 'Geist Mono'", color: 'var(--text-2)', maxWidth: 220 }}>{lf.gameFolder}</span>
                    <button type="button" className="adv-sh-btn sm" onClick={() => void lf.chooseFolder()}>
                      <Icon name="edit" size={14} />
                      {tr('lootfilter_advanced_shell_Dialogs.change')}
                    </button>
                  </div>
                  <div className="adv-sh-setrow">
                    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                      <span style={{ color: 'var(--text-strong)' }}>{tr('lootfilter_advanced_shell_Dialogs.game_log_client_txt')}</span>
                      <span style={{ color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.45 }}>{tr('lootfilter_advanced_shell_Dialogs.read_for_the_areas_you')}</span>
                    </div>
                    <span className="ellipsis" title={s.clientLogPath} style={{ font: "500 12px 'Geist Mono'", color: 'var(--text-2)', maxWidth: 220 }}>{s.clientLogPath || tr('lootfilter_advanced_shell_Dialogs.automatic')}</span>
                    <button type="button" className="adv-sh-btn sm" onClick={() => void window.pom.lootFilter.pickClientLog().then((x) => x.ok && x.value && lf.setSettings({ clientLogPath: x.value }))}>
                      <Icon name="edit" size={14} />
                      {tr('lootfilter_advanced_shell_Dialogs.change')}
                    </button>
                  </div>
                  </div>
                );
              if (r.k === 'league')
                return (
                  <div key={i} className="adv-sh-setrow">
                    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                      <span style={{ color: 'var(--text-strong)' }}>{tr('lootfilter_advanced_shell_Dialogs.league')}</span>
                      <span style={{ color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.45 }}>{tr('lootfilter_advanced_shell_Dialogs.the_league_poe_ninja_prices')}{lf.prices ? ` (${lf.prices.league})` : ''}.</span>
                    </div>
                    <input className="adv-sh-field" aria-label={tr('lootfilter_advanced_shell_Dialogs.league')} value={league} placeholder={tr('lootfilter_advanced_shell_Dialogs.current_league')} onChange={(e) => setLeague(e.target.value)} onBlur={() => league !== s.league && lf.setSettings({ league: league.trim() })} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} style={{ width: 170, height: 30 }} />
                  </div>
                );
              return (
                <div key={i} className="adv-sh-setrow">
                  <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <span style={{ color: 'var(--text-strong)' }}>{r.l}</span>
                    {r.h && <span style={{ color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.45 }}>{r.h}</span>}
                  </div>
                  {r.k === 'tg' ? <Switch checked={!!s[r.f]} label={r.l} onChange={(v) => lf.setSettings({ [r.f]: v } as Partial<LootFilterSettings>)} /> : <Segmented value={r.get(s)} options={r.opts.map((o) => ({ value: o.v, label: o.l }))} onChange={(v) => lf.setSettings(r.set(v))} ariaLabel={r.l} />}
                </div>
              );
            })}
          </div>
          <div style={{ padding: 'var(--s-6) var(--s-9)', borderTop: '1px solid rgba(var(--line-rgb),.08)', color: 'var(--text-faint)', fontSize: 12 }}>{tr('lootfilter_advanced_shell_Dialogs.changes_save_as_you_make')}</div>
        </div>
      </div>
    </div>
  );
}
