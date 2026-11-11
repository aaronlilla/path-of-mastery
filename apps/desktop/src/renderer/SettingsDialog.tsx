import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import type { AppInfo, AppSettings } from '../shared/library.js';
import { THEMES } from './appearance';
import { ConfirmDialog } from './Dialogs';
import { ClaudeMark } from './ClaudeMark';
import { Icon, Kbd, PortalMenu, Segmented, Select, Switch, type Option } from './ui';
import type { SettingsSection as Section } from './search/shellDocs';
import { LANGUAGE_NAMES, fromMain, inLanguage, tr } from './i18n';
import { LANGUAGE_CODES } from '../shared/library.js';

const NAV: { id: Section; label: string; icon: string }[] = [
  { id: 'general', label: tr('SettingsDialog.general'), icon: 'settings' },
  { id: 'appearance', label: tr('SettingsDialog.appearance'), icon: 'palette' },
  { id: 'build-defaults', label: tr('SettingsDialog.build_defaults'), icon: 'tree' },
  { id: 'numbers', label: tr('SettingsDialog.numbers'), icon: 'hash' },
  { id: 'network', label: tr('SettingsDialog.network'), icon: 'globe' },
  { id: 'account', label: tr('SettingsDialog.assistant_and_account'), icon: 'user' },
  { id: 'advanced', label: tr('SettingsDialog.advanced'), icon: 'code' },
];

const SCALES: Option<AppSettings['uiScale']>[] = [
  { value: 'system', label: tr('SettingsDialog.use_system_default') },
  { value: '90', label: '90%' },
  { value: '100', label: '100%' },
  { value: '110', label: '110%' },
  { value: '125', label: '125%' },
  { value: '150', label: '150%' },
];

const POSITIVE = ['#33ff77', '#4fdc7c', '#88ffff', '#e9c887'];
const NEGATIVE = ['#dd0022', '#ef4656', '#ff8a94', '#ff9922'];
const HIGHLIGHT = ['#ff4a2e', '#3de2e2', '#e9c887', '#ff66cc'];

function Row({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="set-row" data-row={title}>
      <span className="l">
        <span className="a">{title}</span>
        {hint && <span className="b">{hint}</span>}
      </span>
      <span className="r">{children}</span>
    </div>
  );
}

function Stepper({ value, min, max, onChange, label }: { value: number; min: number; max: number; onChange: (n: number) => void; label: string }) {
  return (
    <div className="stepper" role="group" aria-label={label}>
      <button type="button" aria-label={tr('SettingsDialog.decrease_label', { label })} onClick={() => onChange(Math.max(min, value - 1))}>−</button>
      <span className="v">{value}</span>
      <button type="button" aria-label={tr('SettingsDialog.increase_label', { label })} onClick={() => onChange(Math.min(max, value + 1))}>+</button>
    </div>
  );
}

const PRESETS = ['#ff4a2e', '#ff9922', '#ffd23f', '#e9c887', '#33ff77', '#4fdc7c', '#3de2e2', '#88ffff', '#4aa8ff', '#8f7aff', '#ff66cc', '#ef4656', '#dd0022', '#ff8a94', '#ffffff', '#9a9a9a'];

/** The custom-colour popover: a hex box and a grid of presets, drawn at page level so it never covers the swatches it edits. */
function ColourPopover({ anchor, open, value, onClose, onPick, label }: { anchor: React.RefObject<HTMLElement | null>; open: boolean; value: string; onClose: () => void; onPick: (c: string) => void; label: string }) {
  const [hex, setHex] = useState(value);
  useEffect(() => setHex(value), [value, open]);
  const valid = /^#[0-9a-f]{6}$/i.test(hex);
  return (
    <PortalMenu anchor={anchor} open={open} onClose={onClose} align="left" role="group" label={tr('SettingsDialog.label_custom_colour', { label })} minWidth={196} className="set-colour-pop">
      <div className="colour-grid">
        {PRESETS.map((c) => (
          <button key={c} type="button" title={c} aria-label={c} aria-pressed={c.toLowerCase() === value.toLowerCase()} style={{ background: c }} onClick={() => { onPick(c); onClose(); }} />
        ))}
      </div>
      <div className="colour-hex">
        <span className="chip" style={{ background: valid ? hex : 'transparent' }} />
        <input
          value={hex}
          aria-label={tr('SettingsDialog.label_hex_colour', { label })}
          spellCheck={false}
          maxLength={7}
          onChange={(e) => {
            const v = e.target.value.startsWith('#') ? e.target.value : '#' + e.target.value;
            setHex(v);
            if (/^#[0-9a-f]{6}$/i.test(v)) onPick(v);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.stopPropagation();
              e.preventDefault();
              if (valid) onClose();
            }
          }}
        />
      </div>
    </PortalMenu>
  );
}

function Swatches({ value, colours, onChange, label }: { value: string; colours: string[]; onChange: (c: string) => void; label: string }) {
  const custom = !colours.includes(value);
  const plus = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <span className="swatches" role="group" aria-label={label}>
      {colours.map((c) => (
        <button key={c} type="button" title={c} aria-label={c} aria-pressed={c === value} style={{ background: c }} onClick={() => onChange(c)} />
      ))}
      {custom && <button type="button" title={value} aria-label={value} aria-pressed style={{ background: value }} onClick={() => setOpen(true)} />}
      <button ref={plus} type="button" className="custom" title={tr('SettingsDialog.custom_colour')} aria-label={tr('SettingsDialog.custom_colour')} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((v) => !v)}>+</button>
      <ColourPopover anchor={plus} open={open} value={value} onClose={close} onPick={onChange} label={label} />
    </span>
  );
}

function TextBox({ value, width, onChange, placeholder, label, max }: { value: string; width: number; onChange: (v: string) => void; placeholder?: string; label: string; max?: number }) {
  return <input className="tiny-input" style={{ width }} value={value} maxLength={max} placeholder={placeholder} aria-label={label} spellCheck={false} onChange={(e) => onChange(e.target.value)} />;
}

export interface SettingsDialogProps {
  /** Scrolls to this section when the dialog opens (a palette result for one setting). */
  initialSection?: Section | undefined;
  /** The row a palette result names: scrolled into view under its section's heading. */
  initialRow?: string | undefined;
  settings: AppSettings;
  info: AppInfo | null;
  version: string;
  signedIn: boolean;
  /** A build without the hosted backend: there is no account row. */
  noAccounts?: boolean;
  onPreview: (patch: Partial<AppSettings>) => void;
  /** Save: only the settings changed here, so a change saved elsewhere while the dialog was open is never written back. */
  onSave: (changed: Partial<AppSettings>) => void;
  onCancel: () => void;
  onReveal: () => void;
  /** Checks for an update; an offer replaces this dialog through `control.leave` (the Discard question when something changed). */
  onCheckUpdate: () => void;
  /** Filled in while the dialog is open: how the app leaves it for another dialog, and how look changes made elsewhere reach the draft. */
  control?: MutableRefObject<SettingsControl | null> | undefined;
  /** Changes each time the app asks for Settings again while it is open (a palette result, More looks): go to initialSection/initialRow. */
  navToken?: unknown;
  /** These leave Settings (after the unsaved-changes question when something changed) and open their own screen. */
  onConnectDesktop: () => void;
  onAccount: () => void;
  onSignIn: () => void;
}

/** What the app can ask of an open Settings dialog. */
export interface SettingsControl {
  /** Leave for another screen: asks Discard your changes? when something changed, puts the saved look back, then runs `then`. */
  leave(then: () => void): void;
  /**
   * A look change made outside the dialog while it is open (Alt+Shift+L/T, the account menu's Mode row, a palette action): it
   * becomes a draft edit, shown in the dialog and previewed, kept by Save and undone by Cancel, like a change made in the dialog.
   */
  edit(patch: Partial<AppSettings>): void;
}

export function SettingsDialog({ initialSection, initialRow, settings, info, version, signedIn, noAccounts, onPreview, onSave, onCancel, onReveal, onCheckUpdate, onConnectDesktop, onAccount, onSignIn, control, navToken }: SettingsDialogProps) {
  const original = useRef(settings);
  const [draft, setDraft] = useState<AppSettings>(settings);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const box = useRef<HTMLDivElement>(null);
  // A setting saved elsewhere while the dialog is open (one this dialog has not touched) is taken in as the new saved value, so
  // the dialog shows it and Cancel does not put the old one back.
  useEffect(() => {
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const took: Partial<AppSettings> = {};
    for (const k of Object.keys(settings) as (keyof AppSettings)[]) {
      if (same(draftRef.current[k], original.current[k]) && !same(settings[k], original.current[k])) (took as Record<string, unknown>)[k] = settings[k];
    }
    if (!Object.keys(took).length) return;
    original.current = { ...original.current, ...took };
    setDraft((d) => ({ ...d, ...took }));
  }, [settings]);
  const [current, setCurrent] = useState<Section>('general');
  const body = useRef<HTMLDivElement>(null);
  const [pickedDir, setPickedDir] = useState<string | null>(null);
  const nextDir = pickedDir ?? info?.nextBuildsDir ?? '';
  const defaultDir = info ? info.userDataDir.replace(/[\\/]+$/, '').replace(/\\/g, '/') + '/Builds' : '';
  const moved = !!info && nextDir.replace(/\\/g, '/') !== info.buildsDir.replace(/\\/g, '/');
  const pickDir = async (reset: boolean) => {
    const r = await window.pom.lib.chooseBuildsDir(reset);
    if (r.ok && r.value) {
      setPickedDir(r.value);
      setProblem(null);
    } else if (!r.ok) setProblem(fromMain('ml_io_errors', r.error)); // a folder that cannot hold builds: say so, keep the old one
  };
  const set = <K extends keyof AppSettings>(k: K, v: AppSettings[K]) => {
    setDraft((d) => ({ ...d, [k]: v }));
    // Appearance changes show at once; Cancel puts them back.
    if (['theme', 'mode', 'glass', 'texture', 'density', 'animations', 'positiveColour', 'negativeColour', 'highlightColour', 'uiScale'].includes(k as string)) onPreview({ [k]: v } as Partial<AppSettings>);
  };
  // Saving is refused, with the reason in the footer, while the two number separators are unusable.
  const [problem, setProblem] = useState<string | null>(null);
  const trySave = () => {
    const t = draft.thousandsSeparator;
    const d = draft.decimalSeparator;
    const why = t === '' ? tr('SettingsDialog.the_thousands_separator_cannot_be') : d === '' ? tr('SettingsDialog.the_decimal_separator_cannot_be') : t === d ? tr('SettingsDialog.the_thousands_separator_and_the') : null;
    setProblem(why);
    if (why) return;
    const changed = Object.fromEntries(Object.entries(draft).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(original.current[k as keyof AppSettings])));
    onSave(changed as Partial<AppSettings>);
  };
  const cancel = () => {
    onPreview(original.current);
    onCancel();
  };
  // Escape, the X and a click outside ask before throwing away edits; the Cancel button is the explicit way out. A button that
  // leaves for another screen (Connect Claude Desktop, Account settings, Sign in) asks the same question first.
  const [ask, setAsk] = useState<null | { then?: () => void }>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(original.current);
  const askRef = useRef(false);
  askRef.current = ask !== null;
  const requestClose = () => (dirty ? setAsk({}) : cancel());
  const leave = (then: () => void) => {
    if (dirty) return setAsk({ then });
    onPreview(original.current);
    then();
  };
  if (control) {
    control.current = {
      leave,
      edit: (patch) => {
        for (const [k, v] of Object.entries(patch)) set(k as keyof AppSettings, v as AppSettings[keyof AppSettings]);
      },
    };
  }
  useEffect(() => () => { if (control) control.current = null; }, [control]);
  /** Where `el` sits inside the scrolling body, in body scroll coordinates. */
  const topIn = (el: HTMLElement) => {
    const b = body.current!;
    return b.scrollTop + el.getBoundingClientRect().top - b.getBoundingClientRect().top;
  };
  const jump = (id: Section) => {
    const el = body.current?.querySelector<HTMLElement>(`#set-${id}`);
    if (el && body.current) body.current.scrollTo({ top: topIn(el), behavior: 'smooth' });
    setCurrent(id);
  };
  // More content below the fold: a fade above the footer says so.
  const [more, setMore] = useState(false);
  const onScroll = () => {
    const b = body.current;
    if (!b) return;
    let best: Section = 'general';
    for (const n of NAV) {
      const el = b.querySelector<HTMLElement>(`#set-${n.id}`);
      if (el && topIn(el) - 48 <= b.scrollTop) best = n.id;
    }
    const atEnd = b.scrollTop + b.clientHeight >= b.scrollHeight - 4;
    if (atEnd && b.scrollTop > 0) best = 'advanced';
    setMore(!atEnd);
    setCurrent(best);
  };
  /** Opens at a section and, for a palette result, brings its row into view under the pinned heading. */
  const goTo = (section: Section | undefined, rowTitle: string | undefined, again: boolean) => {
    const b = body.current;
    if (!b) return;
    const sec = section && section !== 'general' ? b.querySelector<HTMLElement>(`#set-${section}`) : null;
    if (sec) b.scrollTop = topIn(sec);
    else if (again && section === 'general') b.scrollTop = 0;
    if (section) setCurrent(section);
    const row = rowTitle ? b.querySelector<HTMLElement>(`[data-row="${CSS.escape(inLanguage('SettingsDialog', rowTitle))}"]`) : null;
    if (row && topIn(row) + row.offsetHeight > b.scrollTop + b.clientHeight - 24) b.scrollTop = topIn(row) - 56;
    setMore(b.scrollTop + b.clientHeight < b.scrollHeight - 4);
  };
  const navSeen = useRef(navToken);
  useEffect(() => {
    // First open: go where the opener asked. Asked again while open (a palette result, More looks): go there too.
    const again = navSeen.current !== navToken;
    navSeen.current = navToken;
    if (!again) return goTo(initialSection, initialRow, false);
    if (initialSection || initialRow) goTo(initialSection, initialRow, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navToken]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (askRef.current) return;
      // Only while Settings is the top layer: Escape in the palette or the account menu above it closes those, and Enter in the
      // palette's box picks a result (it must never save Settings).
      if (document.querySelector('.search-box, .acct-menu')) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        requestClose();
      } else if (e.key === 'Enter' && e.target instanceof HTMLInputElement && e.target.type !== 'color' && box.current?.contains(e.target)) {
        e.preventDefault();
        trySave();
      }
    };
    document.addEventListener('keydown', key, true);
    return () => document.removeEventListener('keydown', key, true);
  });
  const lightNow = useMemo(() => document.documentElement.getAttribute('data-mode') === 'light', [draft.mode, draft.theme]);

  return (
    <>
      <div className="scrim" onClick={requestClose} />
      <div ref={box} className="settings" role="dialog" aria-modal="true" aria-label={tr('SettingsDialog.settings')} data-lg="pop" data-screen-label="Settings">
        <nav aria-label={tr('SettingsDialog.settings_sections')}>
          <span className="ttl">{tr('SettingsDialog.settings')}</span>
          {NAV.map((n) => (
            <button key={n.id} type="button" aria-current={current === n.id} aria-label={n.label} title={n.label} onClick={() => jump(n.id)}>
              <Icon name={n.icon} size={14} />
              <span className="lbl">{n.label}</span>
            </button>
          ))}
          <span className="sp" />
          <span className="hint">
            <Kbd>Ctrl ,</Kbd>
            <span>{tr('SettingsDialog.open_settings_anywhere')}</span>
          </span>
        </nav>
        <button type="button" className="x" aria-label={tr('SettingsDialog.close')} onClick={requestClose}>
          <Icon name="x" size={12} />
        </button>
        <div className="body" ref={body} onScroll={onScroll}>
          <section id="set-general">
            <h3>{tr('SettingsDialog.general')}</h3>
            <Row title={tr('SettingsDialog.language')} hint={tr('SettingsDialog.language_hint')}>
              <Select ariaLabel={tr('SettingsDialog.language')} width={190} value={draft.language} options={[{ value: 'system', label: tr('SettingsDialog.language_system') }, ...LANGUAGE_CODES.map((c) => ({ value: c, label: LANGUAGE_NAMES[c] }))]} onChange={(v) => set('language', v)} />
            </Row>
            <Row title={tr('SettingsDialog.build_name_in_window_title')} hint={tr('SettingsDialog.shows_the_open_build_s')}><Switch label={tr('SettingsDialog.build_name_in_window_title')} checked={draft.buildNameInTitle} onChange={(v) => set('buildNameInTitle', v)} /></Row>
            <Row title={tr('SettingsDialog.early_updates')} hint={tr('SettingsDialog.get_updates_before_everyone_else')}><Switch label={tr('SettingsDialog.early_updates')} checked={draft.betaBuilds} onChange={(v) => set('betaBuilds', v)} /></Row>
            <Row title={tr('SettingsDialog.community_builds_on_the_build')} hint={tr('SettingsDialog.adds_poe_ninja_and_pobb')}><Switch label={tr('SettingsDialog.community_builds_on_the_build')} checked={draft.communityBuilds} onChange={(v) => set('communityBuilds', v)} /></Row>
            <Row title={tr('SettingsDialog.updates')} hint={tr('SettingsDialog.you_have_version_version', { version })}>
              <button type="button" className="btn sm" onClick={() => onCheckUpdate()}>
                <Icon name="cloud-down" size={14} />
                {tr('SettingsDialog.check_for_update')}
              </button>
            </Row>
          </section>

          <section id="set-appearance">
            <h3>{tr('SettingsDialog.appearance')}</h3>
            <Row title={tr('SettingsDialog.theme')} hint={tr('SettingsDialog.the_colours_of_the_whole')}>
              <div className="themes" role="group" aria-label={tr('SettingsDialog.theme')}>
                {THEMES.map((th) => {
                  const c = lightNow ? th.light : th.dark;
                  const on = th.id === draft.theme;
                  return (
                    <button
                      key={th.id}
                      type="button"
                      className="theme-sw"
                      title={th.label}
                      aria-label={tr('SettingsDialog.label_theme', { label: th.label })}
                      aria-pressed={on}
                      style={{ background: c[0], boxShadow: on ? `0 0 0 2px ${c[1]}` : '0 0 0 1px rgba(127,127,127,.35)' }}
                      onClick={() => set('theme', th.id)}
                    >
                      <i style={{ left: '14%', top: '16%', width: '40%', height: '5%', borderRadius: 2, background: c[2], opacity: 0.85 }} />
                      <i style={{ left: '14%', top: '28%', width: '26%', height: '5%', borderRadius: 2, background: c[2], opacity: 0.4 }} />
                      <i style={{ left: '14%', right: '14%', bottom: '16%', height: '22%', borderRadius: 4, background: c[3] }} />
                      <i style={{ right: '22%', bottom: '23%', width: '22%', height: '8%', borderRadius: 3, background: c[1] }} />
                      {on && (
                        <i className="chk">
                          <Icon name="check" size={14} style={{ color: c[1] }} />
                        </i>
                      )}
                    </button>
                  );
                })}
              </div>
            </Row>
            <Row title={tr('SettingsDialog.mode')} hint={tr('SettingsDialog.light_dark_or_follow_windows')}>
              <Segmented ariaLabel={tr('SettingsDialog.mode')} value={draft.mode} onChange={(v) => set('mode', v)} options={[{ value: 'light', label: tr('SettingsDialog.light') }, { value: 'dark', label: tr('SettingsDialog.dark') }, { value: 'system', label: tr('SettingsDialog.system') }]} />
            </Row>
            <Row title={tr('SettingsDialog.glass')} hint={tr('SettingsDialog.how_see_through_the_panels')}>
              <Segmented ariaLabel={tr('SettingsDialog.glass')} value={draft.glass} onChange={(v) => set('glass', v)} options={[{ value: 'liquid', label: tr('SettingsDialog.liquid') }, { value: 'clear', label: tr('SettingsDialog.clear') }, { value: 'frosted', label: tr('SettingsDialog.frosted') }]} />
            </Row>
            <Row title={tr('SettingsDialog.texture')} hint={tr('SettingsDialog.a_stone_grain_behind_the')}>
              <Segmented ariaLabel={tr('SettingsDialog.texture')} value={draft.texture} onChange={(v) => set('texture', v)} options={[{ value: 'off', label: tr('SettingsDialog.off') }, { value: 'subtle', label: tr('SettingsDialog.subtle') }, { value: 'stone', label: tr('SettingsDialog.stone') }]} />
            </Row>
            <Row title={tr('SettingsDialog.density')} hint={tr('SettingsDialog.comfortable_36px_rows_compact_28px')}>
              <Segmented ariaLabel={tr('SettingsDialog.density')} tall value={draft.density} onChange={(v) => set('density', v)} options={[{ value: 'comfortable', label: tr('SettingsDialog.comfortable') }, { value: 'compact', label: tr('SettingsDialog.compact') }]} />
            </Row>
            <Row title={tr('SettingsDialog.ui_scaling_override')} hint={tr('SettingsDialog.overrides_the_system_display_scaling')}>
              <Select ariaLabel={tr('SettingsDialog.ui_scaling_override')} width={190} value={draft.uiScale} options={SCALES} onChange={(v) => set('uiScale', v)} />
            </Row>
            <Row title={tr('SettingsDialog.animations')} hint={tr('SettingsDialog.turn_off_to_reduce_motion')}><Switch label={tr('SettingsDialog.animations')} checked={draft.animations} onChange={(v) => set('animations', v)} /></Row>
            <Row title={tr('SettingsDialog.starfield')} hint={tr('SettingsDialog.the_star_backdrop_calm_is')}>
              <Segmented ariaLabel={tr('SettingsDialog.starfield')} value={draft.starfield} onChange={(v) => set('starfield', v)} options={[{ value: 'Full', label: tr('SettingsDialog.full') }, { value: 'Calm', label: tr('SettingsDialog.calm') }, { value: 'Off', label: tr('SettingsDialog.off') }]} />
            </Row>
            <Row title={tr('SettingsDialog.styled_tooltips_with_flavour_text')} hint={tr('SettingsDialog.reopen_the_build_after_changing')}><Switch label={tr('SettingsDialog.styled_tooltips_with_flavour_text')} checked={draft.styledTooltips} onChange={(v) => set('styledTooltips', v)} /></Row>
            <Row title={tr('SettingsDialog.node_power_colours')} hint={tr('SettingsDialog.colour_ramp_for_the_node')}>
              <Segmented ariaLabel={tr('SettingsDialog.node_power_colours')} value={draft.nodePowerColours} onChange={(v) => set('nodePowerColours', v)} options={[{ value: 'red-blue', label: tr('SettingsDialog.red_blue') }, { value: 'red-green', label: tr('SettingsDialog.red_green') }, { value: 'green-blue', label: tr('SettingsDialog.green_blue') }]} />
            </Row>
            <Row title={tr('SettingsDialog.positive_values')} hint={tr('SettingsDialog.stat_increases_and_good_deltas')}><Swatches label={tr('SettingsDialog.positive_values')} value={draft.positiveColour} colours={POSITIVE} onChange={(c) => set('positiveColour', c)} /></Row>
            <Row title={tr('SettingsDialog.negative_values')} hint={tr('SettingsDialog.stat_decreases_and_bad_deltas')}><Swatches label={tr('SettingsDialog.negative_values')} value={draft.negativeColour} colours={NEGATIVE} onChange={(c) => set('negativeColour', c)} /></Row>
            <Row title={tr('SettingsDialog.highlighted_nodes')} hint={tr('SettingsDialog.colour_for_search_matches_on')}><Swatches label={tr('SettingsDialog.highlighted_nodes')} value={draft.highlightColour} colours={HIGHLIGHT} onChange={(c) => set('highlightColour', c)} /></Row>
            <Row title={tr('SettingsDialog.off_screen_search_markers')} hint={tr('SettingsDialog.points_to_search_matches_that')}><Switch label={tr('SettingsDialog.off_screen_search_markers')} checked={draft.offscreenMarkers} onChange={(v) => set('offscreenMarkers', v)} /></Row>
          </section>

          <section id="set-build-defaults">
            <h3>{tr('SettingsDialog.build_defaults')}</h3>
            <Row title={tr('SettingsDialog.default_character_level')} hint={tr('SettingsDialog.used_for_new_builds')}><Stepper label={tr('SettingsDialog.level')} value={draft.defaultLevel} min={1} max={100} onChange={(n) => set('defaultLevel', n)} /></Row>
            <Row title={tr('SettingsDialog.default_gem_quality')} hint={tr('SettingsDialog.used_when_you_add_a')}><Stepper label={tr('SettingsDialog.gem_quality')} value={draft.defaultGemQuality} min={0} max={23} onChange={(n) => set('defaultGemQuality', n)} /></Row>
            <Row title={tr('SettingsDialog.default_item_affix_quality')} hint={tr('SettingsDialog.roll_position_for_new_crafted')}>
              <div className="slider">
                <input type="range" min={0} max={100} value={draft.defaultAffixQuality} aria-label={tr('SettingsDialog.default_item_affix_quality')} style={{ ['--p' as string]: `${draft.defaultAffixQuality}%` }} onChange={(e) => set('defaultAffixQuality', Number(e.target.value))} />
                <span className="v">{draft.defaultAffixQuality}%</span>
              </div>
            </Row>
            <Row title={tr('SettingsDialog.build_warnings')} hint={tr('SettingsDialog.shows_point_socket_and_requirement')}><Switch label={tr('SettingsDialog.build_warnings')} checked={draft.buildWarnings} onChange={(v) => set('buildWarnings', v)} /></Row>
            <Row title={tr('SettingsDialog.build_save_path')} hint={moved ? tr('SettingsDialog.takes_effect_after_a_restart') : tr('SettingsDialog.where_local_builds_are_saved')}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="path-pill" title={nextDir}>{info ? '‎' + nextDir.replace(/\\/g, '/') : tr('SettingsDialog.loading')}</span>
                <button type="button" className="btn sm" disabled={!info} onClick={() => void pickDir(false)}>{tr('SettingsDialog.choose')}</button>
                {nextDir.replace(/\\/g, '/') !== defaultDir && <button type="button" className="btn sm" onClick={() => void pickDir(true)}>{tr('SettingsDialog.use_default')}</button>}
                {moved && <button type="button" className="btn sm" onClick={() => void window.pom.lib.relaunch()}>{tr('SettingsDialog.restart_now')}</button>}
              </div>
            </Row>
          </section>

          <section id="set-numbers">
            <h3>{tr('SettingsDialog.numbers')}</h3>
            <Row title={tr('SettingsDialog.thousands_separators')} hint={tr('SettingsDialog.n3_123_221_instead_of')}><Switch label={tr('SettingsDialog.thousands_separators')} checked={draft.thousandsSeparators} onChange={(v) => set('thousandsSeparators', v)} /></Row>
            <Row title={tr('SettingsDialog.compact_large_numbers')} hint={tr('SettingsDialog.shortens_big_numbers_in_the')}><Switch label={tr('SettingsDialog.compact_large_numbers')} checked={draft.compactNumbers} onChange={(v) => set('compactNumbers', v)} /></Row>
            <Row title={tr('SettingsDialog.thousands_separator')} hint={tr('SettingsDialog.one_character_shown_between_groups')}><TextBox label={tr('SettingsDialog.thousands_separator')} width={56} max={1} value={draft.thousandsSeparator} onChange={(v) => set('thousandsSeparator', v)} /></Row>
            <Row title={tr('SettingsDialog.decimal_separator')} hint={tr('SettingsDialog.one_character_shown_before_the')}><TextBox label={tr('SettingsDialog.decimal_separator')} width={56} max={1} value={draft.decimalSeparator} onChange={(v) => set('decimalSeparator', v)} /></Row>
          </section>

          <section id="set-network">
            <h3>{tr('SettingsDialog.network')}</h3>
            <Row title={tr('SettingsDialog.connection_protocol')} hint={tr('SettingsDialog.used_when_downloading_updates_and')}>
              <Segmented ariaLabel={tr('SettingsDialog.connection_protocol')} value={draft.connectionProtocol} onChange={(v) => set('connectionProtocol', v)} options={[{ value: 'auto', label: tr('SettingsDialog.auto') }, { value: 'ipv4', label: tr('SettingsDialog.ipv4') }, { value: 'ipv6', label: tr('SettingsDialog.ipv6') }]} />
            </Row>
            <Row title={tr('SettingsDialog.proxy_server')} hint={tr('SettingsDialog.only_needed_on_networks_that')}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Select ariaLabel={tr('SettingsDialog.proxy_type')} width={96} value={draft.proxyKind} options={[{ value: 'http', label: tr('SettingsDialog.http') }, { value: 'socks5', label: tr('SettingsDialog.socks5') }]} onChange={(v) => set('proxyKind', v)} />
                <TextBox label={tr('SettingsDialog.proxy_host_and_port')} width={190} value={draft.proxyHost} placeholder={tr('SettingsDialog.host_port')} onChange={(v) => set('proxyHost', v)} />
              </div>
            </Row>
          </section>

          <section id="set-account">
            <h3>{tr('SettingsDialog.assistant_and_account')}</h3>
            <Row title={tr('SettingsDialog.ai_apps')} hint={tr('SettingsDialog.lets_claude_code_codex_cli')}>
              <button type="button" className="btn sm" onClick={() => leave(onConnectDesktop)}>
                <ClaudeMark size={14} />
                {tr('SettingsDialog.connect_an_ai_app')}
              </button>
            </Row>
            {noAccounts ? null : signedIn ? (
              <Row title={tr('SettingsDialog.account')} hint={tr('SettingsDialog.your_profile_cloud_builds_and')}>
                <button type="button" className="btn sm" onClick={() => leave(onAccount)}>
                  <Icon name="user" size={14} />
                  {tr('SettingsDialog.account_settings')}
                </button>
              </Row>
            ) : (
              <Row title={tr('SettingsDialog.account')} hint={tr('SettingsDialog.sign_in_with_discord_to')}>
                <button type="button" className="btn sm" onClick={() => leave(onSignIn)}>
                  <Icon name="log-in" size={14} />
                  {tr('SettingsDialog.sign_in')}
                </button>
              </Row>
            )}
          </section>

          <section id="set-advanced">
            <h3>{tr('SettingsDialog.advanced')}</h3>
            <Row title={tr('SettingsDialog.all_affix_sliders')} hint={tr('SettingsDialog.shows_a_roll_slider_for')}><Switch label={tr('SettingsDialog.all_affix_sliders')} checked={draft.allAffixSliders} onChange={(v) => set('allAffixSliders', v)} /></Row>
            <Row title={tr('SettingsDialog.tooltips_only_for_affected_slots')}><Switch label={tr('SettingsDialog.tooltips_only_for_affected_slots')} checked={draft.tooltipsAffectedSlotsOnly} onChange={(v) => set('tooltipsAffectedSlotsOnly', v)} /></Row>
            <Row title={tr('SettingsDialog.copy_eldritch_implicits_onto_the')}><Switch label={tr('SettingsDialog.copy_eldritch_implicits_onto_the')} checked={draft.copyEldritchImplicits} onChange={(v) => set('copyEldritchImplicits', v)} /></Row>
            <Row title={tr('SettingsDialog.tooltips_for_unsupported_mods')} hint={tr('SettingsDialog.explains_mods_the_calculator_does')}><Switch label={tr('SettingsDialog.tooltips_for_unsupported_mods')} checked={draft.tooltipsUnsupportedMods} onChange={(v) => set('tooltipsUnsupportedMods', v)} /></Row>
            <Row title={tr('SettingsDialog.ignore_mouse_wheel_on_controls')} hint={tr('SettingsDialog.stops_the_mouse_wheel_from')}><Switch label={tr('SettingsDialog.ignore_mouse_wheel_on_controls')} checked={draft.ignoreWheelOnControls} onChange={(v) => set('ignoreWheelOnControls', v)} /></Row>
            <Row title={tr('SettingsDialog.invert_slider_scroll')}><Switch label={tr('SettingsDialog.invert_slider_scroll')} checked={draft.invertSliderScroll} onChange={(v) => set('invertSliderScroll', v)} /></Row>
          </section>
        </div>
        <div className="fade" aria-hidden data-on={more || undefined} />
        <div className="foot">
          {problem ? <span className="note" role="alert" style={{ color: 'var(--negative-text)' }}>{problem}</span> : <span className="note">{tr('SettingsDialog.appearance_previews_now_everything_s')}</span>}
          <button type="button" className="btn ghost" onClick={cancel}>
            <Icon name="x" size={16} />
            {tr('SettingsDialog.cancel')}
          </button>
          <button type="button" className="btn gold" onClick={trySave}>
            <Icon name="save" size={16} />
            {tr('SettingsDialog.save')}
          </button>
        </div>
      </div>
      {ask && (
        <ConfirmDialog
          icon="warning"
          title={tr('SettingsDialog.discard_your_changes')}
          body={tr('SettingsDialog.you_changed_some_settings_and')}
          confirmLabel={tr('SettingsDialog.discard_changes')}
          confirmIcon="x"
          tone="danger"
          cancelLabel={tr('SettingsDialog.keep_editing')}
          onCancel={() => setAsk(null)}
          onConfirm={() => {
            const then = ask.then;
            if (!then) return cancel();
            onPreview(original.current);
            then();
          }}
        />
      )}
    </>
  );
}
