import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import type { Color, LabelStyle } from '../../../shared/lootfilter/types.js';
import type { TierInfo } from '../../../shared/lootfilter/catalog.js';
import type { WriteOutcome } from '../../../shared/lootfilter/ipcTypes.js';
import { blockStyle } from '../../../shared/lootfilter/blocks.js';
import { useDelayedFlag } from '../../delayedFlag.js';
import { STRICTNESS } from '../../../shared/lootfilter/styles.js';
import { MAX_FILTER_BYTES } from '../../../shared/lootfilter/syntax.js';
import { writeErrorText } from '../../../shared/lootfilter/writeText.js';
import { createPortal } from 'react-dom';
import { hidesText, priceAge } from '../hidesText';
import { Icon, useToast } from '../../ui';
import { useLfSlots, type LfNav } from '../LootFilterArea';
import { PreflightCtx, usePreflight } from './export/usePreflight';
import { useInboxCount } from './shell/useInbox';
import { formatPrice, itemPrice, useLf } from '../lfStore';
import { useBuildLead } from '../useBuildFilter';
import { AdaptView } from './views/AdaptView';
import { BuildView } from './views/BuildView';
import { ComponentsView } from './views/ComponentsView';
import { CustomizeView } from './views/CustomizeView';
import { DiffView } from './views/DiffView';
import { ExportView } from './views/ExportView';
import { FiltersView } from './views/FiltersView';
import { OverviewView } from './views/OverviewView';
import { RawView } from './views/RawView';
import { RetierView } from './views/RetierView';
import { SimulateView } from './views/SimulateView';
import { StartView } from './views/StartView';
import { StrictnessView } from './views/StrictnessView';
import { ThemesView } from './views/ThemesView';
import { UpdateView } from './views/UpdateView';
import { AskPanel, InboxMenu } from './shell/Ask';
import { ConfirmHide, GameDialog, ImportDialog, KeysDialog, SettingsDialog, WriteConfirm } from './shell/Dialogs';
import { ExplainDrawer } from './shell/Explain';
import { FloatMenu } from './shell/FloatMenu';
import { Inspector } from './shell/Inspector';
import { ItemMenu, MoveMenu, TierMenu } from './shell/Menus';
import { CommandPalette, type PaletteAction } from './shell/Palette';
import { BeamPicker, ColourPicker, IconPicker, SoundPicker, type PickerKind } from './shell/Pickers';
import { moveItemToTier, tierKeyOfItem, resolveTarget, currentLook, setItemHiddenRule, setTierHidden, tierHidden, writeLook, targetName } from './shell/edits';
import { AdvShellCtx, type AdvShell, type Ground, type ImportResult, type InspectorTab, type Selection } from './shell/selection';
import { ModeSwitch } from '../guided/ModeSwitch';
import { LfArchive } from '../LfArchive';
import { requestWrite, setShellWrite } from '../buildfilter/writeGate';
import './adv-shell.css';
import { tr } from '../../i18n';
import { strictName, strictBlurb } from '../names';

const VIEWS: Record<string, ComponentType<{ nav: LfNav }>> = {
  filters: FiltersView,
  start: StartView,
  overview: OverviewView,
  customize: CustomizeView,
  simulate: SimulateView,
  themes: ThemesView,
  advanced: RawView,
  export: ExportView,
  build: BuildView,
  strictness: StrictnessView,
  retier: RetierView,
  adapt: AdaptView,
  update: UpdateView,
  diff: DiffView,
  components: ComponentsView,
};

const RAIL: { id: string; label: string; key: string; icon: string }[] = [
  { id: 'filters', label: tr('lootfilter_advanced_AdvancedApp.my_filters'), key: 'Alt 0', icon: 'files' },
  { id: 'overview', label: tr('lootfilter_advanced_AdvancedApp.overview'), key: 'Alt 1', icon: 'layout' },
  { id: 'customize', label: tr('lootfilter_advanced_AdvancedApp.customize'), key: 'Alt 2', icon: 'sliders' },
  { id: 'simulate', label: tr('lootfilter_advanced_AdvancedApp.simulate'), key: 'Alt 3', icon: 'chart-bar' },
  { id: 'themes', label: tr('lootfilter_advanced_AdvancedApp.themes'), key: 'Alt 4', icon: 'palette' },
  { id: 'advanced', label: tr('lootfilter_advanced_AdvancedApp.filter_text'), key: 'Alt 5', icon: 'code' },
  { id: 'export', label: tr('lootfilter_advanced_AdvancedApp.export'), key: 'Alt 6', icon: 'download' },
  { id: 'components', label: tr('lootfilter_advanced_AdvancedApp.components'), key: 'Alt 7', icon: 'layers' },
];

/** Views that show the Inspector beside them. */
const INSPECTOR_VIEWS = new Set(['overview', 'customize', 'simulate', 'diff']);

type Menu = { kind: 'item'; at: { x: number; y: number }; name: string } | { kind: 'tier'; at: { x: number; y: number }; key: string } | { kind: 'move'; at: { x: number; y: number }; name: string } | { kind: 'inbox'; at: { x: number; y: number } } | null;
type Hdr = { k: 'strict' | 'game'; at: { x: number; y: number } } | null;

type Confirm = { kind: 'hide'; name: string } | { kind: 'move'; name: string; tierKey: string } | null;

const clockText = (at: number): string => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
function sizeText(bytes: number): string {
  return bytes >= 1024 * 1024 ? tr('lootfilter_advanced_AdvancedApp.tofixed_mb', { value: (bytes / 1048576).toFixed(2) }) : tr('lootfilter_advanced_AdvancedApp.bytes_kb', { bytes: Math.round(bytes / 1024) });
}

export function AdvancedApp({ nav }: { nav: LfNav }) {
  const lf = useLf();
  const writingSlow = useDelayedFlag(lf.phase === 'writing', 200);
  const toast = useToast();
  const slots = useLfSlots();
  const pre = usePreflight();
  const inbox = useInboxCount();
  const lfRef = useRef(lf);
  lfRef.current = lf;
  const navRef = useRef(nav);
  navRef.current = nav;
  const rootRef = useRef<HTMLDivElement>(null);
  const strictBtn = useRef<HTMLButtonElement>(null);
  const bellBtn = useRef<HTMLButtonElement>(null);
  const gameBtn = useRef<HTMLButtonElement>(null);
  const [w, setW] = useState(1280);

  const view = VIEWS[nav.advancedView] ? nav.advancedView : 'overview';
  const View = VIEWS[view]!;

  const [selected, setSelected] = useState<Selection | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState<boolean>(lf.ui.advInspector !== false);
  const [tab, setTab] = useState<InspectorTab>('style');
  const [picker, setPicker] = useState<PickerKind | null>(null);
  const [menu, setMenu] = useState<Menu>(null);
  const [hdr, setHdr] = useState<Hdr>(null);
  const [palette, setPalette] = useState(false);
  const [explainName, setExplainName] = useState<string | null>(null);
  const [askOpen, setAskOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [gameDlg, setGameDlg] = useState<string | null>(null);
  const [importR, setImportR] = useState<ImportResult | null>(null);
  const [writeConfirm, setWriteConfirm] = useState<Extract<WriteOutcome, { kind: 'needs-confirm' }> | null>(null);
  const [name, setName] = useState(lf.doc.name);
  useEffect(() => setName(lf.doc.name), [lf.doc.name, lf.doc.id]);

  const ground: Ground = lf.ui.advGround === 'bright' ? 'bright' : 'dark';
  const cat = lf.catalog;

  // ---- size ---------------------------------------------------------------------------------------
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const railLabels = w >= 1400;
  const insView = INSPECTOR_VIEWS.has(view);
  const insVisible = inspectorOpen && insView;
  const askPush = askOpen && w >= 1100;
  // As in the design, asking closes the Inspector so the two panels do not fight for the right edge.
  useEffect(() => {
    if (askOpen) setInspectorOpen(false);
  }, [askOpen]);
  const mainW = w - 24 - (railLabels ? 184 : 56) - 12 - (askPush ? 412 : 0) - 352;
  const insDrawer = mainW < 640;
  // Too narrow to put the Inspector beside the content: it becomes a drawer over the content, closed until the
  // player selects something, and it goes back to the saved choice when the window is wide again.
  useEffect(() => {
    setInspectorOpen(insDrawer ? false : lfRef.current.ui.advInspector !== false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [insDrawer]);
  const pickRight = (insVisible ? 360 : 12) + (askPush ? 412 : 0);

  // ---- actions -------------------------------------------------------------------------------------
  const toastUndo = useCallback(
    (text: string) => toast({ text, kind: 'ok', action: { label: tr('lootfilter_advanced_AdvancedApp.undo'), run: () => lfRef.current.undo() } }),
    [toast],
  );
  const openInspector = useCallback((t?: InspectorTab) => {
    setInspectorOpen(true);
    if (t) setTab(t);
    if (!insDrawer) lfRef.current.setUi('advInspector', true);
  }, [insDrawer]);
  const closeInspector = useCallback(() => {
    setInspectorOpen(false);
    setPicker(null);
    if (!insDrawer) lfRef.current.setUi('advInspector', false);
  }, [insDrawer]);
  const locks = (Array.isArray(lf.ui.advLocks) ? lf.ui.advLocks : []) as string[];
  const isLocked = useCallback((n: string) => locks.includes(n), [locks]);
  const toggleLock = useCallback(
    (n: string) => {
      const cur = (Array.isArray(lfRef.current.ui.advLocks) ? lfRef.current.ui.advLocks : []) as string[];
      lfRef.current.setUi('advLocks', cur.includes(n) ? cur.filter((x) => x !== n) : [...cur, n]);
    },
    [],
  );
  const priceOf = (n: string): number | undefined => {
    const p = lfRef.current.prices;
    return p?.byName[n]?.chaos ?? p?.uniqueByBase[n];
  };
  const applyHide = (n: string, hide: boolean): void => {
    const l = lfRef.current;
    const it = l.catalog?.byName.get(n);
    if (!it) return;
    toastUndo(setItemHiddenRule(l, it, hide));
  };
  const setItemHidden = useCallback((item: { name: string }, hide: boolean) => {
    const l = lfRef.current;
    const p = priceOf(item.name);
    if (hide && l.settings.confirmValuable && p !== undefined && p >= 1) setConfirm({ kind: 'hide', name: item.name });
    else applyHide(item.name, hide);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const moveTo = (itemName: string, tier: TierInfo): void => {
    const l = lfRef.current;
    const it = l.catalog?.byName.get(itemName);
    if (!it) return;
    if (isLocked(itemName)) {
      toast({ text: tr('lootfilter_advanced_AdvancedApp.itemname_is_locked_press_k', { itemName }), kind: 'info' });
      return;
    }
    const p = priceOf(itemName);
    if (tierHidden(l.doc.rules, tier) && l.settings.confirmValuable && p !== undefined && p >= 1) {
      setConfirm({ kind: 'move', name: itemName, tierKey: tier.key });
      return;
    }
    toastUndo(moveItemToTier(l, it, tier));
  };

  const goSection = useCallback((type: string, tierKey?: string) => {
    const l = lfRef.current;
    l.setUi('advSection', type);
    l.setUi('advTier', tierKey ?? null);
    navRef.current.setAdvancedView('customize');
    if (tierKey) {
      setSelected({ kind: 'tier', key: tierKey });
      setInspectorOpen(true);
    }
  }, []);

  const doWriteRef = useRef<() => Promise<void>>(async () => undefined);
  const doWrite = useCallback(async () => {
    const l = lfRef.current;
    if (l.phase === 'writing') return;
    const o = await l.write();
    if (!o) return;
    if (o.kind === 'written') {
      toast({ key: 'lf-write', text: tr('lootfilter_advanced_AdvancedApp.written_to_your_game_folder'), kind: 'ok' });
    } else if (o.kind === 'needs-confirm') {
      toast({ key: 'lf-write', text: '' });
      setWriteConfirm(o);
    } else {
      // One error at a time, replacing the last, with a way to fix the folder.
      toast({
        key: 'lf-write',
        text: writeErrorText(o),
        kind: 'error',
        sticky: true,
        action2: { label: tr('lootfilter_advanced_AdvancedApp.choose_folder'), run: () => void lfRef.current.chooseFolder() },
        action: { label: tr('lootfilter_advanced_AdvancedApp.retry'), run: () => void doWriteRef.current() },
      });
    }
  }, [toast]);
  doWriteRef.current = doWrite;
  // Every Write in Full mode goes through the build filter's gate, so on its Preview the previewed filter is what is written.
  useEffect(() => {
    setShellWrite(doWrite);
    return () => setShellWrite(null);
  }, [doWrite]);

  const shell: AdvShell = {
    selected,
    select: setSelected,
    openInspector,
    closeInspector,
    inspectorOpen,
    inspectorTab: tab,
    setInspectorTab: setTab,
    ground,
    setGround: (g) => lf.setUi('advGround', g),
    explain: (n) => {
      setMenu(null);
      setExplainName(n);
    },
    openItemMenu: (at, n) => setMenu({ kind: 'item', at, name: n }),
    openTierMenu: (at, key) => setMenu({ kind: 'tier', at, key }),
    openMove: (at, n) => setMenu({ kind: 'move', at: at ?? { x: Math.max(8, w / 2 - 170), y: 140 }, name: n }),
    moveToTier: moveTo,
    setItemHidden,
    isLocked,
    toggleLock,
    goSection,
    toastUndo,
    toastInfo: (text) => toast({ text, kind: 'info' }),
    openPicker: (k) => {
      openInspector('style');
      setPicker(k);
    },
    openAsk: () => setAskOpen(true),
    openPalette: () => setPalette(true),
    openSettings: () => setSettingsOpen(true),
    showImportResult: setImportR,
  };

  // ---- keyboard ------------------------------------------------------------------------------------
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => undefined);
  keyRef.current = (e: KeyboardEvent): void => {
    const t = e.target as HTMLElement | null;
    const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    // Ctrl K (app palette) and Ctrl I (Import dialog) belong to the app shell: one shortcut, one overlay.
    if (mod && k === 's') {
      e.preventDefault();
      requestWrite();
    } else if (mod && !typing && k === 'z') {
      e.preventDefault();
      if (e.shiftKey) lf.redo();
      else lf.undo();
    } else if (mod && !typing && k === 'y') {
      e.preventDefault();
      lf.redo();
    } else if (mod && k === 'j') {
      e.preventDefault();
      setAskOpen((a) => !a);
    } else if (mod && e.key === ',') {
      e.preventDefault();
      setSettingsOpen(true);
    } else if (e.altKey && /^Digit[0-7]$/.test(e.code)) {
      e.preventDefault();
      const r = RAIL[Number(e.code.slice(5))];
      if (r) nav.setAdvancedView(r.id);
    } else if (!typing && !mod && !e.altKey) {
      if (e.key === '?') {
        e.preventDefault();
        setKeysOpen(true);
        return;
      }
      if (e.key === 'Escape') {
        if (explainName) setExplainName(null);
        else if (picker) setPicker(null);
        else if (askOpen) setAskOpen(false);
        else if (insDrawer && insVisible) closeInspector();
        return;
      }
      if (k === 'i' && insView) {
        e.preventDefault();
        if (inspectorOpen) closeInspector();
        else openInspector();
        return;
      }
      const sel = selected;
      if (!sel || !insView) return;
      const item = sel.kind === 'item' ? cat?.byName.get(sel.name) : undefined;
      const tier = sel.kind === 'tier' ? cat?.tierByKey.get(sel.key) : undefined;
      if (k === 'm' && item) {
        e.preventDefault();
        shell.openMove(null, item.name);
      } else if (k === 'l' && (item || tier)) {
        e.preventDefault();
        openInspector('style');
      } else if (k === 's' && (item || tier)) {
        e.preventDefault();
        shell.openPicker('snd');
      } else if (k === 'h' && item) {
        e.preventDefault();
        const r = lf.evaluateCatalogItem(item);
        setItemHidden(item, r ? r.visible : !item.hidden);
      } else if (k === 'h' && tier) {
        e.preventDefault();
        toastUndo(setTierHidden(lf, tier, !tierHidden(lf.doc.rules, tier)));
      } else if (k === 'k' && item) {
        e.preventDefault();
        toggleLock(item.name);
      } else if (k === 'e' && item) {
        e.preventDefault();
        setExplainName(item.name);
      } else if (k === 'j' && (item || tier)) {
        e.preventDefault();
        const t = tier ?? (item ? cat?.tierByKey.get(tierKeyOfItem(lf.doc.rules, item)) : undefined);
        if (t) goSection(t.type, t.key);
      }
    }
  };
  useEffect(() => {
    const h = (e: KeyboardEvent): void => keyRef.current(e);
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  // Closing a view's selection when it no longer exists (a filter switch, a base change).
  useEffect(() => {
    if (!selected || !cat) return;
    if (selected.kind === 'item' && !cat.byName.has(selected.name)) setSelected(null);
    if (selected.kind === 'tier' && !cat.tierByKey.has(selected.key)) setSelected(null);
  }, [cat, selected]);
  useEffect(() => setSelected(null), [lf.doc.id]);

  // ---- derived header and status ---------------------------------------------------------------------
  const strict = lf.doc.setup.strictness;
  const buildName = lf.doc.buildName ?? lf.build?.name ?? '';
  const bi = lf.build?.info;
  // Named with the profile's main skill, the same one the Build filter title uses.
  const lead = useBuildLead();
  const buildChip = bi && buildName ? lead || [bi.ascendClassName || bi.className, bi.mainSkill].filter(Boolean).join(' · ') || buildName : buildName;
  const g = lf.gen;
  const v = lf.validation;
  const pend = lf.pending;
  const writtenText = writingSlow ? tr('lootfilter_advanced_AdvancedApp_2.writing') : lf.doc.written && lf.target?.state === 'changed' ? tr('lootfilter_advanced_AdvancedApp.game_folder_file_changed_outside') : lf.doc.written ? (pend.total > 0 ? tr('lootfilter_advanced_AdvancedApp.changed_since_at', { value: clockText(lf.doc.written.at) }) : tr('lootfilter_advanced_AdvancedApp.last_written_at', { value: clockText(lf.doc.written.at) })) : tr('lootfilter_advanced_AdvancedApp.not_written_yet');
  const pricesText = lf.prices ? tr(lf.priceStale ? 'h_lootB_App.prices_stale' : 'h_lootB_App.prices_ok', { league: lf.prices.league, age: priceAge(lf.prices.fetchedAt) }) : lf.pricesLoading ? tr('lootfilter_advanced_AdvancedApp.prices_loading') : tr('lootfilter_advanced_AdvancedApp.prices_not_loaded_priceerror', { priceError: lf.priceError ? ` (${lf.priceError})` : '' });
  const pct = g ? Math.min(100, (g.bytes / MAX_FILTER_BYTES) * 100) : 0;

  // ---- pickers ---------------------------------------------------------------------------------------
  const target = resolveTarget(lf, selected);
  const look: LabelStyle = target ? currentLook(lf, target) : {};
  const used = useMemo<Color[]>(() => {
    if (picker !== 'fg' && picker !== 'bd' && picker !== 'bg') return [];
    const seen = new Map<string, Color>();
    for (const b of lf.genBlocks) {
      if (b.kind === 'Hide') continue;
      const s = blockStyle(b);
      const c = s[picker];
      if (c) seen.set(c.join(','), c);
      if (seen.size >= 14) break;
    }
    return [...seen.values()];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picker, lf.genBlocks]);
  const recent = (Array.isArray(lf.ui.advRecent) ? lf.ui.advRecent : []) as Color[];
  const apply = (patch: Partial<LabelStyle>, label: string): void => {
    if (target) writeLook(lf, target, patch, label);
  };
  const pickerLabel = target ? targetName(target, cat) : '';

  // ---- palette ------------------------------------------------------------------------------------------
  const paletteActions = useMemo<PaletteAction[]>(
    () => [
      { id: 'simple', label: tr('lootfilter_advanced_AdvancedApp.switch_to_simple'), sub: tr('lootfilter_advanced_AdvancedApp.your_changes_in_plain_words'), run: () => navRef.current.setMode('guided') },
      { id: 'write', label: tr('lootfilter_advanced_AdvancedApp.write_to_game'), sub: tr('lootfilter_advanced_AdvancedApp.write_the_filter_into_the'), kbd: 'Ctrl S', run: () => requestWrite() },
      { id: 'undo', label: tr('lootfilter_advanced_AdvancedApp.undo'), sub: tr('lootfilter_advanced_AdvancedApp.undo_the_last_change'), kbd: 'Ctrl Z', run: () => lfRef.current.undo() },
      { id: 'redo', label: tr('lootfilter_advanced_AdvancedApp.redo'), sub: tr('lootfilter_advanced_AdvancedApp.redo_the_change_you_undid'), kbd: 'Ctrl Shift Z', run: () => lfRef.current.redo() },
      { id: 'ins', label: tr('lootfilter_advanced_AdvancedApp.show_or_hide_the_inspector'), sub: tr('lootfilter_advanced_AdvancedApp.the_panel_for_the_selected'), kbd: 'I', run: () => (inspectorOpen ? closeInspector() : openInspector()) },
      { id: 'ask', label: tr('lootfilter_advanced_AdvancedApp.ask'), sub: tr('lootfilter_advanced_AdvancedApp.not_connected_yet'), kbd: 'Ctrl J', run: () => setAskOpen(true) },
      { id: 'settings', label: tr('lootfilter_advanced_AdvancedApp.settings'), sub: tr('lootfilter_advanced_AdvancedApp.prices_saving_startup'), kbd: 'Ctrl ,', run: () => setSettingsOpen(true) },
      { id: 'keys', label: tr('lootfilter_advanced_AdvancedApp.keyboard_shortcuts'), sub: tr('lootfilter_advanced_AdvancedApp.the_full_list'), kbd: '?', run: () => setKeysOpen(true) },
      { id: 'strict', label: tr('lootfilter_advanced_AdvancedApp.compare_strictness_levels'), sub: tr('lootfilter_advanced_AdvancedApp.see_what_each_level_hides'), run: () => nav.setAdvancedView('strictness') },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [inspectorOpen],
  );
  const paletteScreens = useMemo(() => RAIL.map((r) => ({ id: r.id, label: r.label, key: r.key, icon: r.icon })), []);

  const openHdr = (k: 'strict' | 'game', el: HTMLElement | null): void => {
    const r = el?.getBoundingClientRect();
    setHdr(hdr?.k === k ? null : { k, at: { x: r ? (k === 'game' ? r.right - 300 : r.left) : 200, y: r ? (k === 'game' ? r.top - 4 - 190 : r.bottom + 6) : 60 } });
  };

  const confirmItem = confirm ? cat?.byName.get(confirm.name) : undefined;
  const confirmTier = confirm?.kind === 'move' ? cat?.tierByKey.get(confirm.tierKey) : undefined;
  const confirmPrice = confirm ? priceOf(confirm.name) : undefined;
  const confirmPriceText = confirmPrice !== undefined ? formatPrice(confirmPrice, lf.prices?.divine ?? 0, lf.settings.currencyUnit) : '';
  const confirmVia = confirm ? itemPrice(lf.prices, confirm.name)?.via : undefined;

  return (
    <AdvShellCtx.Provider value={shell}>
      <PreflightCtx.Provider value={pre}>
      {slots.ctx &&
        createPortal(
          <>
            <span className="tb-title" title={lf.doc.name}>{lf.doc.name}</span>
            <span className="tb-dot" />
            <span className="tb-sub">{tr('lootfilter_advanced_AdvancedApp.loot_filter')}</span>
          </>,
          slots.ctx,
        )}
      {slots.search &&
        createPortal(
          <button type="button" className="search-pill" title={tr('lootfilter_advanced_AdvancedApp.search_this_filter_items_screens')} aria-label={tr('lootfilter_advanced_AdvancedApp.search_this_filter')} onClick={() => setPalette(true)}>
            <Icon name="search" size={15} />
            <span className="txt">{tr('lootfilter_advanced_AdvancedApp.search_this_filter')}</span>
          </button>,
          slots.search,
        )}
      <div ref={rootRef} className="adv-sh-root" data-ground={ground}>
        <header className="adv-sh-header" data-screen-label="Loot Filter / Shell / Header">
          <ModeSwitch mode="advanced" setMode={nav.setMode} />
          <LfArchive />
          <input
            className="adv-sh-name"
            value={name}
            aria-label={tr('lootfilter_advanced_AdvancedApp.filter_name')}
            title={tr('lootfilter_advanced_AdvancedApp.filter_name_click_to_rename')}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => {
              const n = name.trim();
              if (n && n !== lf.doc.name) lf.renameFilter(lf.doc.id, n);
              else setName(lf.doc.name);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') {
                setName(lf.doc.name);
                (e.target as HTMLInputElement).blur();
              }
            }}
          />
          <button ref={strictBtn} type="button" className="adv-sh-hchip" data-on={hdr?.k === 'strict'} title={tr('lootfilter_advanced_AdvancedApp.strictness_how_much_cheap_loot', { blurb: strictBlurb(strict) })} onClick={() => openHdr('strict', strictBtn.current)}>
            <span style={{ color: 'var(--text-strong)' }}>{strictName(strict)}</span>
            <Icon name="chevron-down" size={11} style={{ opacity: 0.6 }} />
          </button>
          <button type="button" className="adv-sh-hchip" title={buildName ? tr('lootfilter_advanced_AdvancedApp.following_buildname', { buildName }) : tr('lootfilter_advanced_AdvancedApp.no_build_is_followed_open')} onClick={() => nav.setAdvancedView('build')}>
            {buildName && <span className="adv-sh-dot" />}
            <span className="ellipsis" style={{ color: 'var(--text-strong)', maxWidth: 220 }}>{buildChip || tr('lootfilter_advanced_AdvancedApp.no_build')}</span>
            <Icon name="chevron-down" size={11} style={{ opacity: 0.6 }} />
          </button>
          <span style={{ flex: '1 1 0', minWidth: 8 }} />
          {insView && (
            <button type="button" className="adv-sh-hbtn" aria-pressed={insVisible} title={insVisible ? tr('lootfilter_advanced_AdvancedApp.hide_the_inspector_i') : tr('lootfilter_advanced_AdvancedApp.show_the_inspector_i')} onClick={() => (inspectorOpen ? closeInspector() : openInspector())} style={{ borderColor: insVisible ? 'rgba(var(--area-filter-rgb),.55)' : undefined, background: insVisible ? 'rgba(var(--area-filter-rgb),.12)' : undefined }}>
              <Icon name="sidebar-right" size={14} />
              <span className="adv-sh-lbl">{tr('lootfilter_advanced_AdvancedApp.inspector')}</span>
            </button>
          )}
          <button type="button" className="adv-sh-ib" title={tr('lootfilter_advanced_AdvancedApp.undo_ctrl_z')} aria-label={tr('lootfilter_advanced_AdvancedApp.undo')} style={{ opacity: lf.canUndo ? 1 : 0.4 }} onClick={() => lf.undo()}>
            <Icon name="undo" size={16} />
          </button>
          <button type="button" className="adv-sh-ib" title={tr('lootfilter_advanced_AdvancedApp.redo_ctrl_shift_z')} aria-label={tr('lootfilter_advanced_AdvancedApp.redo')} style={{ opacity: lf.canRedo ? 1 : 0.4 }} onClick={() => lf.redo()}>
            <Icon name="redo" size={16} />
          </button>
          <button
            ref={bellBtn}
            type="button"
            className="adv-sh-ib"
            title={tr('lootfilter_advanced_AdvancedApp.notices')}
            aria-label={tr('lootfilter_advanced_AdvancedApp.adapt_inbox')}
            onClick={() => {
              const r = bellBtn.current?.getBoundingClientRect();
              setMenu(menu?.kind === 'inbox' ? null : { kind: 'inbox', at: { x: (r?.right ?? 600) - 400, y: (r?.bottom ?? 60) + 6 } });
            }}
          >
            <Icon name="bell" size={16} />
            {inbox > 0 && <span className="adv-sh-bell" />}
          </button>
          <button type="button" className="adv-sh-hbtn" aria-label={tr('lootfilter_advanced_AdvancedApp.ask')} title={tr('lootfilter_advanced_AdvancedApp.ask_for_a_change_in')} aria-pressed={askOpen} onClick={() => setAskOpen((a) => !a)} style={{ borderColor: askOpen ? 'rgba(var(--area-filter-rgb),.55)' : undefined, background: askOpen ? 'rgba(var(--area-filter-rgb),.12)' : undefined }}>
            <Icon name="sparkle-fill" size={14} style={{ color: 'var(--gold-400)' }} />
            <span className="adv-sh-lbl">{tr('lootfilter_advanced_AdvancedApp.ask')}</span>
          </button>
          <button type="button" className="adv-sh-write" title={tr('lootfilter_advanced_AdvancedApp.write_the_filter_into_the_2')} onClick={() => requestWrite()} disabled={lf.phase === 'writing' || !g}>
            {writingSlow ? tr('lootfilter_advanced_AdvancedApp.writing') : tr('lootfilter_advanced_AdvancedApp.write_to_game')}
            <span className="adv-sh-k on-gold">{tr('lootfilter_advanced_AdvancedApp.ctrl_s')}</span>
          </button>
        </header>

        <div className="adv-sh-body">
          <nav className="adv-sh-rail lf-card" data-lg="panel" aria-label={tr('lootfilter_advanced_AdvancedApp.loot_filter_screens')} style={{ width: railLabels ? 184 : 56 }}>
            {RAIL.map((r, i) => (
              <span key={r.id} style={{ display: 'contents' }}>
                {i === 1 && <div className="adv-sh-sep" />}
                <button type="button" className="adv-sh-rbtn" aria-label={r.label} aria-current={view === r.id ? 'page' : undefined} title={`${r.label}  ·  ${r.key}`} onClick={() => nav.setAdvancedView(r.id)} style={{ justifyContent: railLabels ? 'flex-start' : 'center' }}>
                  <Icon name={r.icon} size={16} style={{ flex: 'none' }} />
                  {railLabels && (
                    <>
                      <span style={{ flex: 1, minWidth: 0, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.label}</span>
                      <span className="adv-sh-rkey" style={{ flex: 'none', font: "500 10.5px 'Geist Mono'" }}>{r.key}</span>
                    </>
                  )}
                </button>
              </span>
            ))}
            <span style={{ flex: 1 }} />
            <button type="button" className="adv-sh-rbtn plain" title={tr('lootfilter_advanced_AdvancedApp.loot_filter_settings_ctrl')} aria-label={tr('lootfilter_advanced_AdvancedApp.settings')} onClick={() => setSettingsOpen(true)} style={{ justifyContent: railLabels ? 'flex-start' : 'center' }}>
              <Icon name="settings" size={16} style={{ flex: 'none' }} />
              {railLabels && <span>{tr('lootfilter_advanced_AdvancedApp.settings')}</span>}
            </button>
          </nav>
          <main className="adv-sh-main" data-screen-label={`Loot Filter / ${view}`}>
            <View nav={nav} />
          </main>
          {insVisible && <Inspector drawer={insDrawer} right={12 + (askPush ? 412 : 0)} picker={picker} setPicker={setPicker} nav={nav} />}
          {askOpen && <AskPanel drawer={!askPush} onClose={() => setAskOpen(false)} nav={nav} />}
        </div>

        <footer className="adv-sh-status" data-screen-label="Loot Filter / Shell / Status bar">
          <span title={tr('lootfilter_advanced_AdvancedApp.rules_in_the_file')}>{g ? tr('lootfilter_advanced_AdvancedApp.tolocalestring_rules', { value: (g.baseBlocks + g.userBlocks).toLocaleString() }) : tr('lootfilter_advanced_AdvancedApp.building_the_filter')}</span>
          <span title={tr('lootfilter_advanced_AdvancedApp.the_game_refuses_filters_over')} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="adv-sh-bar">
              <span style={{ width: `${pct}%`, background: pct > 90 ? 'var(--negative)' : 'var(--gold-500)' }} />
            </span>
            {g ? tr('lootfilter_advanced_AdvancedApp.bytes_of_1_mb', { bytes: sizeText(g.bytes) }) : ''}
          </span>
          <button type="button" className="adv-sh-sbtn" title={tr('lootfilter_advanced_AdvancedApp.open_the_preflight_list')} onClick={() => nav.setAdvancedView('export')}>
            <span style={{ color: v && pre.errors > 0 ? 'var(--negative-text)' : 'var(--positive-text)' }}>{v ? tr('lootfilter_advanced_AdvancedApp.count_errors', { count: pre.errors }) : tr('lootfilter_advanced_AdvancedApp.checking')}</span>
            {v && <span style={{ color: pre.warnings > 0 ? 'var(--warning-text)' : 'var(--text-muted)' }}>{tr('lootfilter_advanced_AdvancedApp.count_warnings', { count: pre.warnings })}</span>}
          </button>
          <span>{writtenText}</span>
          <span role="status">{lf.saveStatus === 'saved' ? tr('lootfilter_advanced_AdvancedApp.saved_on_this_pc') : lf.saveStatus === 'saving' ? tr('lootfilter_advanced_AdvancedApp.saving') : <button type="button" className="adv-sh-sbtn" style={{ color: 'var(--negative-text)' }} onClick={lf.openSaveFailed}>{tr('lootfilter_advanced_AdvancedApp.save_failed')}</button>}</span>
          <span style={{ flex: 1 }} />
          <span title={lf.priceError ?? ''}>{pricesText}</span>
          <button ref={gameBtn} type="button" className="adv-sh-sbtn muted" title={tr('lootfilter_advanced_AdvancedApp.change_game')} onClick={() => openHdr('game', gameBtn.current)}>
            {tr('lootfilter_advanced_AdvancedApp.poe_1_neversink_baseversion', { baseVersion: lf.baseVersion })}
          </button>
          <button type="button" className="adv-sh-sbtn muted" aria-label={tr('lootfilter_advanced_AdvancedApp.help')} title={tr('lootfilter_advanced_AdvancedApp.keyboard_shortcuts_2')} onClick={() => setKeysOpen(true)}>
            <Icon name="help" size={13} />
          </button>
        </footer>

        {/* pickers */}
        {insVisible && (picker === 'fg' || picker === 'bd' || picker === 'bg') && target && (
          <ColourPicker
            title={picker === 'fg' ? tr('h_lootB_App.text_colour') : picker === 'bd' ? tr('h_lootB_App.border_colour') : tr('h_lootB_App.background_colour')}
            field={picker}
            look={look}
            name={target.kind === 'item' ? target.item.name : pickerLabel}
            ground={ground}
            right={pickRight}
            used={used}
            recent={recent}
            onChange={(c) => {
              apply({ [picker]: c }, picker === 'fg' ? tr('h_lootB_App.changed_text_colour') : picker === 'bd' ? tr('h_lootB_App.changed_border_colour') : tr('h_lootB_App.changed_background_colour'));
              if (c) lf.setUi('advRecent', [c, ...recent.filter((x) => x.join(',') !== c.join(','))].slice(0, 7));
            }}
            onClose={() => setPicker(null)}
          />
        )}
        {insVisible && picker === 'snd' && target && <SoundPicker look={look} right={pickRight} preview={lf.settings.soundPreview} onChange={(s) => apply({ sound: s }, tr('lootfilter_advanced_AdvancedApp.changed_sound'))} onClose={() => setPicker(null)} />}
        {insVisible && picker === 'icon' && target && <IconPicker look={look} right={pickRight} onChange={(s) => apply({ icon: s }, tr('lootfilter_advanced_AdvancedApp.changed_minimap_icon'))} onClose={() => setPicker(null)} />}
        {insVisible && picker === 'beam' && target && <BeamPicker look={look} right={pickRight} onChange={(s) => apply({ beam: s }, tr('lootfilter_advanced_AdvancedApp.changed_beam'))} onClose={() => setPicker(null)} />}

        {explainName && <ExplainDrawer name={explainName} right={(insVisible ? 352 : 12) + (askPush ? 412 : 0)} nav={nav} onClose={() => setExplainName(null)} />}

        {/* menus and popovers */}
        {menu?.kind === 'item' && <ItemMenu at={menu.at} name={menu.name} onClose={() => setMenu(null)} openPicker={shell.openPicker} />}
        {menu?.kind === 'tier' && <TierMenu at={menu.at} tierKey={menu.key} onClose={() => setMenu(null)} openPicker={shell.openPicker} />}
        {menu?.kind === 'move' && (
          <MoveMenu
            at={menu.at}
            name={menu.name}
            onClose={() => setMenu(null)}
            onPick={(t) => {
              const n = menu.name;
              setMenu(null);
              moveTo(n, t);
            }}
          />
        )}
        {menu?.kind === 'inbox' && <InboxMenu at={menu.at} nav={nav} onClose={() => setMenu(null)} />}
        {hdr?.k === 'strict' && (
          <FloatMenu at={hdr.at} onClose={() => setHdr(null)} width={400} label={tr('lootfilter_advanced_AdvancedApp.strictness')}>
            {STRICTNESS.map((l, i) => {
              const n = lf.hidden?.hidden[i];
              return (
                <button
                  key={l.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={i === strict}
                  className="adv-sh-level"
                  onClick={() => {
                    setHdr(null);
                    if (i === strict) return;
                    lf.edit(tr('lootfilter_advanced_AdvancedApp.strictness_name', { name: strictName(i) }), (d) => ({ ...d, setup: { ...d.setup, strictness: i } }));
                    toastUndo(tr('lootfilter_advanced_AdvancedApp.strictness_is_now_name_your', { name: strictName(i) }));
                  }}
                >
                  <span className="adv-sh-radio" data-on={i === strict} />
                  <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                    <span style={{ color: 'var(--text-strong)', font: '500 13px Geist' }}>{strictName(i)}</span>
                    <span style={{ color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.4, whiteSpace: 'normal' }}>{strictBlurb(i)}</span>
                    <span style={{ color: 'var(--text-faint)', fontSize: 11.5 }}>{n !== undefined && lf.hidden ? hidesText(n, lf.hidden.total) : tr('lootfilter_advanced_AdvancedApp.counting_item_types')}</span>
                  </span>
                </button>
              );
            })}
            <div style={{ padding: '8px 10px 6px', color: 'var(--text-muted)', fontSize: 12, borderTop: '1px solid rgba(var(--line-rgb),.08)', marginTop: 4, display: 'flex', alignItems: 'center', gap: 8, whiteSpace: 'normal' }}>
              <span style={{ flex: 1 }}>{tr('lootfilter_advanced_AdvancedApp.your_customizations_take_priority_ov')}</span>
              <button type="button" className="adv-sh-btn sm" onClick={() => { setHdr(null); nav.setAdvancedView('strictness'); }}>
                <Icon name="compare" size={14} />
                {tr('lootfilter_advanced_AdvancedApp.compare_levels')}
              </button>
            </div>
          </FloatMenu>
        )}
        {hdr?.k === 'game' && (
          <FloatMenu at={hdr.at} onClose={() => setHdr(null)} width={300} label={tr('lootfilter_advanced_AdvancedApp.game')}>
            {[
              { l: 'PoE 1', s: tr('lootfilter_advanced_AdvancedApp.supported_this_filter_is_for'), on: true },
              { l: 'PoE 2', s: tr('lootfilter_advanced_AdvancedApp.not_supported_yet'), on: false },
              { l: 'PoE 1 Ruthless', s: tr('lootfilter_advanced_AdvancedApp.not_supported_yet'), on: false },
            ].map((x) => (
              <button
                key={x.l}
                type="button"
                role="menuitemradio"
                aria-checked={x.on}
                className="adv-sh-level"
                style={{ gridTemplateColumns: '14px minmax(0,1fr)' }}
                onClick={() => {
                  setHdr(null);
                  if (!x.on) setGameDlg(x.l);
                }}
              >
                <span className="adv-sh-radio" data-on={x.on} />
                <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ color: x.on ? 'var(--text-strong)' : 'var(--text-muted)', font: '500 13px Geist' }}>{x.l}</span>
                  <span style={{ color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.4, whiteSpace: 'normal' }}>{x.s}</span>
                </span>
              </button>
            ))}
          </FloatMenu>
        )}

        {palette && <CommandPalette screens={paletteScreens} actions={paletteActions} onGo={(id) => nav.setAdvancedView(id)} onClose={() => setPalette(false)} />}

        {/* dialogs */}
        {confirm && confirmItem && (
          <ConfirmHide
            item={confirmItem}
            title={confirm.kind === 'hide' ? tr('lootfilter_advanced_AdvancedApp.hide_name', { name: confirmItem.name }) : tr('lootfilter_advanced_AdvancedApp.move_name_to_a_hidden', { name: confirmItem.name })}
            body={`${confirmVia ? tr('h_lootB_App.dearest_unique', { name: confirmItem.name, via: confirmVia, price: confirmPriceText }) : tr('h_lootB_App.sells_for', { name: confirmItem.name, price: confirmPriceText })} ${confirm.kind === 'hide' ? tr('lootfilter_advanced_AdvancedApp_2.hidden_it_will_not_show_on') : tr('h_lootB_App.tier_hidden', { tier: confirmTier?.label ?? tr('h_lootB_App.that_tier') })}`}
            yes={confirm.kind === 'hide' ? tr('lootfilter_advanced_AdvancedApp.hide_it') : tr('lootfilter_advanced_AdvancedApp.move_and_hide_it')}
            onNo={() => setConfirm(null)}
            onYes={() => {
              const c = confirm;
              setConfirm(null);
              if (c.kind === 'hide') applyHide(c.name, true);
              else {
                const t = cat?.tierByKey.get(c.tierKey);
                if (t) toastUndo(moveItemToTier(lf, confirmItem, t));
              }
            }}
          />
        )}
        {gameDlg && <GameDialog which={gameDlg} onClose={() => setGameDlg(null)} />}
        {importR && <ImportDialog r={importR} onClose={() => setImportR(null)} />}
        {keysOpen && <KeysDialog onClose={() => setKeysOpen(false)} />}
        {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
        {writeConfirm && (
          <WriteConfirm
            outcome={writeConfirm}
            onNo={() => {
              setWriteConfirm(null);
              lf.dismissOutcome();
            }}
            onYes={() => {
              const why = writeConfirm.why;
              setWriteConfirm(null);
              void lf.write({ overwrite: why }).then((o) => {
                if (o?.kind === 'written') toast({ text: tr('lootfilter_advanced_AdvancedApp.written_to_your_game_folder'), kind: 'ok' });
                else if (o?.kind === 'error') toast({ text: o.message, kind: 'error' });
              });
            }}
          />
        )}
      </div>
      </PreflightCtx.Provider>
    </AdvShellCtx.Provider>
  );
}
