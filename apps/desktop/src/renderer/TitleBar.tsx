import { useEffect, useRef, useState } from 'react';
import { type AppSettings, type LanguageCode, type ModePref } from '../shared/library.js';
import { crest } from './art';
import { Icon, Kbd, useDismiss } from './ui';
import { ClaudeMark } from './ClaudeMark';
import { SearchPalette, type PaletteAssistant } from './search/SearchPalette';
import type { SearchDoc } from './search/searchIndex';
import type { SettingsSection } from './search/shellDocs';
import { SyncPill } from './accounts/SyncPill';
import { UpdatePill } from './updates/UpdateCenter';
import { Avatar } from './accounts/Avatar';
import { useAcct, useAcctCall } from './accounts/useAccount';
import { DeleteAccountDialog, openDeleteAccount } from './accounts/DeleteAccountDialog';
import { ALL_AREAS, NAV_AREAS, areaEnabled } from './areaGate';
import { tr } from './i18n';

/** Every area. Timelines and Marketplace are switched off (areaGate.ts) and sit at the end of the order. */
export type Area = typeof ALL_AREAS[number];
/** The areas on the bar, in the order of Ctrl 1-N (switched-off areas left out). */
export const AREA_ORDER: readonly Area[] = NAV_AREAS;

export interface TitleBarProps {
  area: Area;
  /** Back history (Alt+Left, mouse back): the previous area, when there is one. */
  canBack?: boolean;
  onBack?: () => void;
  onArea: (a: Area) => void;
  onHome: () => void;
  title: string;
  subtitle?: string;
  maximized: boolean;
  settings: AppSettings;
  onAppearance: (patch: Partial<AppSettings>) => void;
  /** Switches the app language at once (saved, then the window reloads in it). */
  onLanguage: (code: LanguageCode) => void;
  /** Opens the Settings dialog, at a section when one is given (the account menu's More looks opens Appearance). */
  onOpenSettings: (section?: SettingsSection) => void;
  onShortcuts: () => void;
  onFeedback: () => void;
  /** Opens the Connect Claude Desktop screen (the assistant panel's, or a dialog when no panel is on screen). */
  onConnectDesktop: () => void;
  /** Runs `then` after an open Settings dialog is left (its Discard question first); for screens that are not app dialogs. */
  afterSettings?: (then: () => void) => void;
  onSignIn: () => void;
  onRevealBuilds: () => void;
  /** A sync conflict's Resolve button. */
  onResolve: (localId: string) => void;
  /** The account menu's Cloud builds, Version history and Account settings. */
  onCloudBuilds: () => void;
  onHistory: () => void;
  onAccountSettings: () => void;
  searchDocs: SearchDoc[];
  assistant: PaletteAssistant;
  searchOpen: boolean;
  setSearchOpen: (v: boolean) => void;
  /** The Loot Filter area fills the title bar's context and search slots itself (portals), so there is one search and one title. */
  /** setCtx is left out while Loot filter Full shows (its header names the filter; R8). */
  lfSlots?: { setCtx?: (el: HTMLElement | null) => void; setSearch: (el: HTMLElement | null) => void };
}

const AREAS: { id: Area; label: string; icon: string; area: string }[] = ([
  { id: 'builds', label: tr('TitleBar.builds'), icon: 'tree', area: 'build' },
  { id: 'atlas', label: tr('TitleBar.atlas'), icon: 'globe', area: 'atlas' },
  { id: 'wealth', label: tr('TitleBar.wealth'), icon: 'coins', area: 'wealth' },
  { id: 'filter', label: tr('TitleBar.loot_filter'), icon: 'filter', area: 'filter' },
  { id: 'timelines', label: tr('TitleBar.timelines'), icon: 'list', area: 'timelines' },
  { id: 'marketplace', label: tr('TitleBar.marketplace'), icon: 'market', area: 'marketplace' },
] as { id: Area; label: string; icon: string; area: string }[]).filter((a) => areaEnabled(a.id));

export function TitleBar(p: TitleBarProps) {
  const acct = useAcct();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuWrap = useRef<HTMLDivElement>(null);
  useDismiss(menuWrap, menuOpen, () => setMenuOpen(false));
  // Under 1000 px the area buttons show only their icons (shell.css), so only then do they need a tooltip.
  const [narrow, setNarrow] = useState(() => window.innerWidth < 1000);
  useEffect(() => {
    const on = () => setNarrow(window.innerWidth < 1000);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  const authState = acct.view?.auth;
  const me = authState && (authState.state === 'signedIn' || authState.state === 'restoring') ? authState.user : null;

  return (
    <header className="titlebar" data-area={p.area} aria-label={tr('TitleBar.title_bar')}>
      <div className="tb-left">
        <button type="button" className="tb-crest-btn" aria-label={tr('TitleBar.home')} title={tr('TitleBar.home_build_library')} onClick={p.onHome}>
          <img className="tb-crest" src={crest} alt="" />
        </button>
        <button type="button" className="tb-back tb-nodrag" aria-label={tr('TitleBar.back')} title={tr('TitleBar.back_alt_left')} disabled={!p.canBack} onClick={p.onBack}>
          <Icon name="chevron-left" size={16} />
        </button>
        <nav className="area-switch tb-nodrag" aria-label={tr('TitleBar.areas')}>
          {AREAS.map((a) => (
            <button key={a.id} type="button" data-area={a.area} aria-current={p.area === a.id ? 'page' : 'false'} aria-label={a.label} title={tr('TitleBar.label_ctrl_id', { label: narrow ? a.label + ' · ' : '', id: AREA_ORDER.indexOf(a.id) + 1 })} onClick={() => p.onArea(a.id)}>
              <Icon name={a.icon} size={15} style={p.area === a.id && a.id === 'builds' ? { filter: 'drop-shadow(0 0 6px rgba(var(--area-build-rgb),.7))' } : undefined} />
              <span className="lbl">{a.label}</span>
            </button>
          ))}
        </nav>
        {p.area === 'filter' && p.lfSlots ? (
          p.lfSlots.setCtx && <div className="tb-lfslot tb-nodrag" ref={p.lfSlots.setCtx} />
        ) : (
          p.title && <span className="tb-title" title={p.title}>{p.title}</span>
        )}
        {p.area !== 'filter' && p.subtitle && (
          <>
            {p.title && <span className="tb-dot" />}
            <span className="tb-sub">{p.subtitle}</span>
          </>
        )}
      </div>
      {p.area === 'filter' && p.lfSlots ? (
        <div className="tb-lfsearch" ref={p.lfSlots.setSearch} />
      ) : (
      <button type="button" className="search-pill" title={tr('TitleBar.search_ctrl_k')} aria-label={tr('TitleBar.search_ctrl_k')} onClick={() => p.setSearchOpen(true)}>
        <Icon name="search" size={15} />
        <span className="txt">{tr('TitleBar.search_stats_items_settings')}</span>
        <Kbd>Ctrl K</Kbd>
      </button>
      )}
      <div className="tb-right">
        <UpdatePill />
        <SyncPill onRevealBuilds={p.onRevealBuilds} onResolve={p.onResolve} hidden={!me} />
        <button type="button" className="tb-gear" aria-label={tr('TitleBar.settings')} title={tr('TitleBar.settings_ctrl')} onClick={() => p.onOpenSettings()}>
          <Icon name="settings" size={16} />
        </button>
        <div ref={menuWrap} style={{ position: 'relative' }}>
          {me ? (
            <button type="button" className="acct" title={tr('TitleBar.account_and_appearance')} aria-haspopup="menu" aria-expanded={menuOpen} aria-label={tr('TitleBar.account_and_appearance')} onClick={() => setMenuOpen((v) => !v)}>
              <span className="av" data-signed="">
                <Avatar user={me} size={26} dot={acct.sync?.state === 'offline' ? 'off' : 'on'} />
              </span>
              <span className="lbl">{me.name.split(/\s+/)[0]}</span>
              <Icon name="chevron-down" size={12} />
            </button>
          ) : acct.view?.unavailable ? null : (
            // Signed out, one click opens the Sign-in dialog; there is no menu to pass through.
            <button type="button" className="acct" title={tr('TitleBar.sign_in')} aria-haspopup="dialog" onClick={() => { setMenuOpen(false); p.onSignIn(); }}>
              <span className="av">
                <Icon name="user" size={14} />
              </span>
              <span className="lbl">{tr('TitleBar.sign_in')}</span>
            </button>
          )}
          {menuOpen && me && (
            <AccountMenu
              settings={p.settings}
              onAppearance={p.onAppearance}
              onClose={() => setMenuOpen(false)}
              onMoreLooks={() => { setMenuOpen(false); p.onOpenSettings('appearance'); }}
              onShortcuts={() => { setMenuOpen(false); p.onShortcuts(); }}
              onFeedback={() => { setMenuOpen(false); p.onFeedback(); }}
              onCloudBuilds={() => { setMenuOpen(false); p.onCloudBuilds(); }}
              onHistory={() => { setMenuOpen(false); p.onHistory(); }}
              onAccountSettings={() => { setMenuOpen(false); p.onAccountSettings(); }}
              onClaudeDesktop={() => { setMenuOpen(false); p.onConnectDesktop(); }}
              onDeleteAccount={() => { setMenuOpen(false); (p.afterSettings ?? ((then) => then()))(openDeleteAccount); }}
            />
          )}
        </div>
      </div>
      <WindowControls maximized={p.maximized} />
      {p.searchOpen && <SearchPalette docs={p.searchDocs} assistant={p.assistant} onClose={() => p.setSearchOpen(false)} />}
      <DeleteAccountDialog />
    </header>
  );
}

function WindowControls({ maximized }: { maximized: boolean }) {
  return (
    <div className="wc tb-nodrag">
      <button type="button" title={tr('TitleBar.minimize')} aria-label={tr('TitleBar.minimize')} onClick={() => void window.pom.win.minimize()}>
        <Icon name="window-min" size={12} />
      </button>
      <button type="button" title={maximized ? tr('TitleBar.restore_down') : tr('TitleBar.maximize')} aria-label={maximized ? tr('TitleBar.restore_down') : tr('TitleBar.maximize')} onClick={() => void window.pom.win.maximize()}>
        <Icon name={maximized ? 'copy' : 'window-max'} size={12} />
      </button>
      <button type="button" className="close" title={tr('TitleBar.close')} aria-label={tr('TitleBar.close')} onClick={() => void window.pom.win.close()}>
        <Icon name="x" size={12} />
      </button>
    </div>
  );
}

/** The signed-in account menu. Settings is not repeated here (the gear owns it); theme, glass and texture live in Settings >
 *  Appearance, and only the quick Light / Dark / System switch stays. */
function AccountMenu({ settings, onAppearance, onClose, onMoreLooks, onShortcuts, onFeedback, onClaudeDesktop, onCloudBuilds, onHistory, onAccountSettings, onDeleteAccount }: { settings: AppSettings; onAppearance: (patch: Partial<AppSettings>) => void; onClose: () => void; onMoreLooks: () => void; onShortcuts: () => void; onFeedback: () => void; onClaudeDesktop: () => void; onCloudBuilds: () => void; onHistory: () => void; onAccountSettings: () => void; onDeleteAccount: () => void }) {
  const a = useAcct();
  const call = useAcctCall();
  const st = a.view?.auth;
  const me = st && (st.state === 'signedIn' || st.state === 'restoring') ? st.user : null;
  const syncState = a.sync?.state ?? 'synced';
  const badge = syncState === 'synced' ? { icon: 'cloud-check', text: tr('TitleBar.synced'), colour: 'var(--positive)' } : syncState === 'syncing' ? { icon: 'refresh', text: tr('TitleBar.syncing'), colour: 'var(--text-3)' } : syncState === 'offline' ? { icon: 'cloud-off', text: tr('TitleBar.offline'), colour: 'var(--text-muted)' } : syncState === 'conflict' ? { icon: 'warning', text: tr('TitleBar.conflict'), colour: 'var(--warning-text)' } : { icon: 'warning', text: tr('TitleBar.paused'), colour: 'var(--warning-text)' };
  const ref = useRef<HTMLDivElement>(null);
  const modes: { id: ModePref; label: string; icon: string }[] = [
    { id: 'light', label: tr('TitleBar.light'), icon: 'sun' },
    { id: 'dark', label: tr('TitleBar.dark'), icon: 'moon' },
    { id: 'system', label: tr('TitleBar.system'), icon: 'monitor' },
  ];
  const onKey = (e: React.KeyboardEvent) => {
    const items = [...(ref.current?.querySelectorAll<HTMLElement>('.mi, .modes button, .more-looks') ?? [])].filter((x) => x.offsetParent !== null);
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(i + 1) % items.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length]?.focus();
    }
  };
  if (!me) return null;
  return (
    <div ref={ref} className="acct-menu" role="menu" aria-label={tr('TitleBar.account_and_appearance')} data-lg="pop" data-solid="" onKeyDown={onKey}>
      <div className="acct-card signed">
        <Avatar user={me} size={48} />
        <span className="who">
          <span className="h">{me.name}</span>
          <span className="em">{me.email}</span>
        </span>
        <span className="sbadge" data-state={syncState}>
          <Icon name={badge.icon} size={12} spin={syncState === 'syncing'} style={{ color: badge.colour }} />
          {badge.text}
        </span>
      </div>
      <div className="sec" style={{ paddingTop: 0 }}>
        <button type="button" className="mi" role="menuitem" onClick={onAccountSettings}>
          <Icon name="user" size={15} />
          {tr('TitleBar.account_settings')}
        </button>
        <button type="button" className="mi" role="menuitem" onClick={onCloudBuilds}>
          <Icon name="cloud" size={15} />
          {tr('TitleBar.cloud_builds')}
          <span className="meta">{a.sync?.cloudCount ?? 0}</span>
        </button>
        <button type="button" className="mi" role="menuitem" onClick={onHistory}>
          <Icon name="clock" size={15} />
          {tr('TitleBar.version_history')}
          <span className="meta">{tr('TitleBar.ctrl_h')}</span>
        </button>
      </div>
      <div className="rule" />
      <div className="sec">
        <div className="modes-row">
          <span>{tr('TitleBar.mode')}</span>
          <div className="modes" role="group" aria-label={tr('TitleBar.mode')}>
            {modes.map((m) => (
              <button key={m.id} type="button" aria-pressed={settings.mode === m.id} onClick={() => onAppearance({ mode: m.id })}>
                <Icon name={m.icon} size={14} />
                {m.label}
              </button>
            ))}
          </div>
        </div>
        <button type="button" className="more-looks" onClick={onMoreLooks}>{tr('TitleBar.more_looks_in_settings')}</button>
      </div>
      <div className="rule" />
      <div className="sec">
        <button type="button" className="mi" role="menuitem" onClick={onClaudeDesktop}>
          <ClaudeMark size={15} />
          {tr('TitleBar.connect_an_ai_app')}
        </button>
        <button type="button" className="mi" role="menuitem" onClick={onShortcuts}>
          <Icon name="keyboard" size={15} />
          {tr('TitleBar.keyboard_shortcuts')}
          <span className="meta">{tr('TitleBar.ctrl')}</span>
        </button>
        <button type="button" className="mi" role="menuitem" onClick={onFeedback}>
          <Icon name="mail" size={15} />
          {tr('TitleBar.send_feedback')}
        </button>
        <button type="button" className="mi danger" role="menuitem" onClick={() => void call(a.api.signOut())}>
          <Icon name="log-out" size={15} />
          {tr('TitleBar.sign_out')}
        </button>
        <button type="button" className="mi danger" role="menuitem" onClick={onDeleteAccount}>
          <Icon name="trash" size={15} />
          {tr('TitleBar.delete_account')}
        </button>
      </div>
    </div>
  );
}
