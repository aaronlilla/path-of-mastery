import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { buildSaveReducer, saveStatusLabel } from './saveStatus.js';
import type { BuildEdit, StatDiff } from '@pom/protocol';
import { HEADLINE_STATS, type AppInfo, type AppSettings, type BuildEntry, type DecodedImport, type EngineBuildSummary, type FolderEntry, type LibraryListing, type TrashEntry, type BuildsDirProblem, type UpdateOffer } from '../shared/library.js';
import { classifyImportText } from '../shared/buildSites';
import { MyPublishedDialog } from './community';
import type { CommunityBuild } from '../shared/community.js';
import { FeedbackDialog } from './FeedbackDialog';
import { annotationsOf, blankBuildXml, checkBuildXml, damagedBuildMessage, figuresOf, getNotes, type PlayerStats, playerStatsOf, readBuildInfo, setNotes, setTimelessData, withPlayerStats, withWindowAnnotations } from '../shared/buildXml';
import { applyAppearance, THEMES, useSettings } from './appearance';
import { BuildWorkspace, TABS } from './BuildWorkspace';
import { PALETTE_TABS, tabVisible } from './buildTabs';
import { LEAGUE_STARTERS } from '../shared/leagueContent';
import { fileText } from './treeKinds';
import { ArchivePanel } from './documents/ArchivePanel';
import { currentBuildLeague, oldBuilds } from './documents/archiveBuilds';
import { convertAllSpecs, LATEST_TREE_VERSION } from '../shared/treeSets.js';
import { LAYER_SELECTOR } from './focusLayers';
import { AboutDialog, ConfirmDialog, InfoDialog, MoveDialog, NameDialog, NewBuildDialog, SaveAsDialog, ShortcutsDialog, TrashDialog } from './Dialogs';
import { areaDocs, buildDocs, settingsDocs, type SettingsSection } from './search/shellDocs';
import { CloseGuardDialog, setCloseBlock, setRestartSaver } from './closeGuard';
import { UpdateCenter } from './updates/UpdateCenter';
import { ErrorBoundary } from './ErrorBoundary';
import { ImportDialog } from './ImportDialog';
import { SaveFailedDialog, SettingsPathDialog, UpdateAvailableDialog } from './FailureDialogs';
import { Library } from './Library';
import { serial } from './engineBuild';
import { useEngineHandle } from './useEngineHandle';
import { LootFilterArea } from './lootfilter/LootFilterArea';
import { SettingsDialog, type SettingsControl } from './SettingsDialog';
import { AREA_ORDER, TitleBar, type Area } from './TitleBar';
import { areaEnabled, timelinesEnabled } from './areaGate';
import { withCopyCredit } from '../shared/buildCredit';
import { MasteryAreas } from './mastery/MasteryAreas';
import { Start } from './home/Start';
import { call as masteryCall } from './mastery/bridge';
import { Starfield } from './appearance/Starfield';
import { useEntitlement } from './entitlements/useEntitlement';
import { useBuildSearch } from './search/buildSource';
import type { SearchDoc } from './search/searchIndex';
import { jumpTo } from './search/jump';
import type { SearchRow } from './search/buildSource';
import { requestAssistant, requestConnector } from './assistant/bus';
import { Connector } from './assistant/AssistantPanel';
import type { ProviderId } from '../shared/assistant/types.js';
import { DEFAULT_TAB, type EditResult, type OpenBuild, type TabId } from './types';
import { Dialog, Icon, useToast } from './ui';
import { useWealth } from './wealth/useWealth';
import { WealthApp } from './wealth/WealthApp';
import { tryStashItem } from './wealth/stashItem';
import { folderLabel } from './format';
import { AccountProvider, acctText, useAcct } from './accounts/useAccount';
import { SignInDialog } from './accounts/SignInDialog';
import { ConflictDialog } from './accounts/ConflictDialog';
import { VersionHistoryDialog } from './accounts/HistoryDialog';
import { AccountDialog } from './accounts/AccountDialog';
import { SharedBuildDialog } from './accounts/SharedBuildDialog';
import { OFFICIAL_ONLY, parseShareToken, type SharedBuild } from '../shared/accounts.js';
import './accounts/accounts.css';
import { fromMain, tr } from './i18n';

type Dlg =
  | null
  | { k: 'import'; tab?: number }
  | { k: 'newBuild'; cls: string }
  | { k: 'newFolder'; parent: string; error?: string }
  | { k: 'rename'; entry: BuildEntry; error?: string }
  | { k: 'renameFolder'; folder: FolderEntry; error?: string }
  | { k: 'deleteFolder'; folder: FolderEntry; count: number }
  | { k: 'move'; entry: BuildEntry }
  | { k: 'conflict'; entry: BuildEntry; to: string; message: string }
  | { k: 'saveAs'; error?: string }
  | { k: 'saveChanges'; then: () => void }
  | { k: 'shortcuts' }
  | { k: 'settings'; section?: SettingsSection; row?: string }
  | { k: 'about' }
  | { k: 'feedback' }
  | { k: 'myPublished' }
  | { k: 'trash'; items: TrashEntry[] }
  | { k: 'info'; title: string; body: string }
  | { k: 'signIn' }
  | { k: 'connectClaude' }
  | { k: 'syncConflict'; id: string }
  | { k: 'history'; id: string; name: string }
  | { k: 'account' }
  | { k: 'shared'; token: string }
  | { k: 'update'; offer: UpdateOffer; busy: boolean; error: string | null }
  | { k: 'settingsPath'; problem: BuildsDirProblem }
  | { k: 'saveError'; path: string; error: string; busy: boolean; exported: string | null };

/**
 * The text a build is written with: its DPS and Life as the engine calculates them are put in as <PlayerStat> lines, as upstream does on
 * every save, so the library card and the next start show the sidebar's numbers, not the ones the file was imported with.
 */
async function textToSave(cur: OpenBuild): Promise<string> {
  let xml = cur.xml;
  if (cur.engine.state === 'ready') {
    const r = await window.pom.sendCommand('getStats', { buildId: cur.engine.summary.buildId });
    if (r.ok) xml = withPlayerStats(xml, playerStatsOf(r.result.stats));
  }
  return fileText(xml);
}

/** The sidebar numbers after the engine reports changed stats. */
function withDiff(summary: EngineBuildSummary, diff: StatDiff): EngineBuildSummary {
  const changed = new Map(diff.changed.map((c) => [c.statId, c.after]));
  const headline = HEADLINE_STATS.flatMap((h) => {
    const had = summary.headline.find((x) => x.id === h.id);
    const v = changed.has(h.id) ? changed.get(h.id) : had?.value;
    return typeof v === 'number' ? [{ id: h.id, label: h.label, value: v }] : [];
  });
  return { ...summary, headline };
}

const DESCRIBE_EXAMPLE = tr('App.a_tanky_melee_league_starter');

function buildNameFor(d: DecodedImport): string {
  return d.name || `${d.info.mainSkill} ${d.info.ascendClassName || d.info.className}`.trim() || tr('App.imported_build');
}

function engineReason(message: string): string {
  return message.replace(/^engine not available:\s*/i, '').replace(/^./, (c) => c.toUpperCase()) + (/[.!]$/.test(message) ? '' : '.');
}

/** The app. Accounts sit above it so every screen can ask who is signed in and how the sync is doing. */

export function App() {
  return (
    <AccountProvider openSignIn={() => window.dispatchEvent(new Event('pom-sign-in'))}>
      <AppInner />
    </AccountProvider>
  );
}

function AppInner() {
  const toast = useToast();
  const acct = useAcct();
  const noAccounts = !!acct.view?.unavailable;
  const { settings, ready, update, preview } = useSettings();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const infoRef = useRef<AppInfo | null>(null);
  infoRef.current = info;
  const [area, setAreaState] = useState<Area>('builds');
  // Back history for the six areas (02-global): every area change remembers where it came from; Alt+Left, the mouse back
  // button and the title-bar Back button return there. Areas stay mounted, so scroll, query and selection are as they were.
  const areaRef = useRef<Area>('builds');
  const areaBack = useRef<Area[]>([]);
  const [canBack, setCanBack] = useState(false);
  const setArea = useCallback((next: Area) => {
    const prev = areaRef.current;
    // A switched-off area (areaGate.ts: Timelines, Marketplace) is never entered, whatever asked for it (restore, link, event).
    if (next === prev || !areaEnabled(next)) return;
    areaBack.current = [...areaBack.current.slice(-49), prev];
    areaRef.current = next;
    setAreaState(next);
    setCanBack(true);
  }, []);
  const goBack = useCallback(() => {
    const prev = areaBack.current.pop();
    if (!prev) return;
    areaRef.current = prev;
    setAreaState(prev);
    setCanBack(areaBack.current.length > 0);
  }, []);
  // First-run marker only: it no longer decides which screen shows. Start shows by itself until the first build
  // exists, and again whenever the Library's League starts button asks for it.
  const finishSetup = useCallback(() => { try { localStorage.setItem('pom-setup-complete', '1'); } catch { /* per-viewer convenience only */ } }, []);
  const [startOpen, setStartOpen] = useState(false);
  // The build header drops its folder line at narrow widths; the title bar crumb carries it then (and only then).
  const [pathHidden, setPathHidden] = useState(false);
  const [startArchive, setStartArchive] = useState(false);
  const entitlement = useEntitlement();
  const [lfCtx, setLfCtx] = useState<HTMLElement | null>(null);
  const [lfSearch, setLfSearch] = useState<HTMLElement | null>(null);
  const [lfMode, setLfMode] = useState<'guided' | 'advanced'>('guided');
  const [wealthSeen, setWealthSeen] = useState(false);
  useEffect(() => {
    if (area === 'wealth') setWealthSeen(true);
  }, [area]);
  const wealth = useWealth(wealthSeen);
  const [pickedBuild, setPickedBuild] = useState<{ key: string; name: string; xml: string; open: boolean } | null>(null);
  const [listing, setListing] = useState<LibraryListing | null>(null);
  // Why the builds folder could not be read (the Start screen shows it with Try again); null while it reads or after it read.
  const [listError, setListError] = useState<string | null>(null);
  // Whether the root of Builds is on screen: Start shows a read failure there in its own panel, so the toast is only for the
  // other screens (a build open, another area).
  const buildsRootRef = useRef(false);
  const [folder, setFolder] = useState('');
  const [open, setOpen] = useState<OpenBuild | null>(null);
  const [tab, setTab] = useState<TabId>(DEFAULT_TAB);
  // "Make a loot filter for this build" opens the Loot Filter area on the Build filter wizard.
  const [lfStart, setLfStart] = useState<string | undefined>(undefined);
  const [dlg, setDlgState] = useState<Dlg>(null);
  const dlgRef = useRef<Dlg>(null);
  dlgRef.current = dlg;
  // Settings with unsaved edits is never replaced by another dialog behind its back: anything outside Settings that opens a
  // dialog (title-bar Sign in, Ctrl /, a palette result) goes through its Discard question, and leaving puts the saved look back.
  // Settings itself closes with the raw setter, after its own question.
  const settingsCtl = useRef<SettingsControl | null>(null);
  const setDlg = useCallback((next: Dlg | ((d: Dlg) => Dlg)) => {
    const cur = dlgRef.current;
    const value = typeof next === 'function' ? next(cur) : next;
    const ctl = settingsCtl.current;
    if (cur?.k === 'settings' && value?.k !== 'settings' && ctl) ctl.leave(() => setDlgState(value));
    else setDlgState(value);
  }, []);
  const [searchOpen, setSearchOpen] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const dirty = !!open && open.xml !== open.saved;
  // The open build's save while it runs or after it failed; cleared when a save succeeds.
  const [buildSave, saveEvent] = useReducer(buildSaveReducer, null);
  useEffect(() => saveEvent({ kind: 'open-changed' }), [open?.id]); // a status belongs to the open it was set in
  // The open build's text and its saved text, for the drivers that check that opening a build changes nothing.
  useEffect(() => {
    (window as unknown as { __pomOpen?: { xml: string; saved: string } | null }).__pomOpen = open ? { xml: open.xml, saved: open.saved } : null;
  });
  const engineHandle = useEngineHandle(open, setOpen);
  // Opening or starting a build leaves Start; closing it later comes back to the Library, not to Start.
  useEffect(() => {
    if (open) setStartOpen(false);
  }, [open]);
  const premiumBuild = pickedBuild ?? (open ? { key: 'open:' + open.id, name: open.name, xml: open.xml, open: true } : null);
  // With no build open and none chosen, Upgrade watch starts from the most recently saved build rather than an empty screen.
  const newestId = useMemo(() => [...(listing?.builds ?? [])].sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.id ?? null, [listing]);
  useEffect(() => {
    if (area !== 'wealth' || pickedBuild || open || !newestId) return;
    let on = true;
    void window.pom.lib.read(newestId).then((r) => on && r.ok && setPickedBuild((cur) => cur ?? { key: 'lib:' + r.value.id, name: r.value.name, xml: r.value.xml, open: false }));
    return () => void (on = false);
  }, [area, pickedBuild, open, newestId]);

  // ---- loading --------------------------------------------------------------------------

  const refresh = useCallback(async () => {
    const r = await window.pom.lib.list();
    if (r.ok) {
      setListing(r.value);
      setListError(null);
    } else {
      setListError(fromMain('ml_io_errors', r.error));
      if (!buildsRootRef.current) toast({ text: tr('App.could_not_read_the_builds', { error: fromMain('ml_io_errors', r.error) }), kind: 'error' });
    }
    return r.ok ? r.value : null;
  }, [toast]);
  /** Try again on the Start error panel: the page goes back to its loading frame while the folder is read again. */
  const retryList = useCallback(() => {
    setListError(null);
    setListing(null);
    void refresh();
  }, [refresh]);

  useEffect(() => {
    void refresh();
    void window.pom.app.info().then((r) => {
      if (r.ok) {
        setInfo(r.value);
        setMaximized(r.value.maximized);
        // The builds folder the player chose cannot be used: ask for another before anything else.
        if (r.value.buildsDirProblem) setDlg({ k: 'settingsPath', problem: r.value.buildsDirProblem });
      }
    });
    const off = window.pom.win.onState(setMaximized);
    const offEngine = window.pom.onEngineEvent((e) => {
      if (e.type === 'status') {
        void window.pom.app.info().then((r) => r.ok && setInfo(r.value));
      }
    });
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      off();
      offEngine();
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  useEffect(() => {
    document.title = settings.buildNameInTitle && open ? `${open.name} - Path of Mastery` : 'Path of Mastery';
  }, [settings.buildNameInTitle, open?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  // A folder that no longer exists sends the player back up.
  useEffect(() => {
    if (listing && folder && !listing.folders.some((f) => f.path === folder)) setFolder('');
  }, [listing, folder]);

  // ---- engine ---------------------------------------------------------------------------

  const loadEngine = useCallback(async (id: string, xml: string) => {
    const r = await window.pom.engine.open(xml);
    setOpen((cur) => (cur && cur.id === id ? { ...cur, engine: r.ok ? { state: 'ready', summary: r.value } : { state: 'unavailable', reason: engineReason(r.error) }, engineAnn: annotationsOf(xml) } : cur));
  }, []);

  // The library card shows the figures of the build AS SAVED. The engine's figures for a build opened without a save are kept with the
  // file's modified time they were calculated for, and only count while the file is unchanged (a save, a sync pull or anything else that
  // rewrites it makes the file's own PlayerStat lines the truth: Save writes the engine's, see textToSave). Edits not saved yet show live
  // figures only while that build is open and dirty; leaving it (Don't Save, close, open another) drops them.
  const [figures, setFigures] = useState<Record<string, { ps: PlayerStats; mtime: number }>>({});
  const [liveFigures, setLiveFigures] = useState<{ id: string; ps: PlayerStats } | null>(null);
  const figuresRef = useRef(figures);
  figuresRef.current = figures;
  const listingRef = useRef(listing);
  listingRef.current = listing;
  const engineSummary = open && open.engine.state === 'ready' ? open.engine.summary : null;
  const openDirty = !!open && open.xml !== open.saved;
  useEffect(() => {
    if (!open || !engineSummary || !openDirty) setLiveFigures(null);
    if (!open || !engineSummary) return;
    const id = open.id;
    const dirty = openDirty;
    const mtime = listingRef.current?.builds.find((x) => x.id === id)?.mtimeMs ?? -1;
    let alive = true;
    void window.pom.sendCommand('getStats', { buildId: engineSummary.buildId }).then((r) => {
      if (!alive || !r.ok) return;
      const ps = playerStatsOf(r.result.stats);
      if (dirty) setLiveFigures({ id, ps });
      else setFigures((f) => ({ ...f, [id]: { ps, mtime } }));
    });
    return () => { alive = false; };
  }, [open?.id, engineSummary, openDirty]); // eslint-disable-line react-hooks/exhaustive-deps
  const shownListing = useMemo(
    () => (listing ? { ...listing, builds: listing.builds.map((b) => {
      const ps = liveFigures && liveFigures.id === b.id && open?.id === b.id && openDirty ? liveFigures.ps : figures[b.id]?.mtime === b.mtimeMs ? figures[b.id]!.ps : undefined;
      return ps ? { ...b, info: { ...b.info, ...figuresOf(ps) } } : b;
    }) } : listing),
    [listing, figures, liveFigures, open?.id, openDirty],
  );

  /** Brings the sidebar numbers up to date with the engine's session (after an edit, and when FullDPS follows it). */
  const refreshSummary = useCallback(async () => {
    const cur = openRef.current;
    if (!cur || cur.engine.state !== 'ready') return;
    const buildId = cur.engine.summary.buildId;
    const r = await window.pom.sendCommand('getStats', { buildId });
    if (!r.ok) return;
    const by = new Map(r.result.stats.map((s) => [s.id, s.value]));
    const headline = HEADLINE_STATS.flatMap((h) => (typeof by.get(h.id) === 'number' ? [{ id: h.id, label: h.label, value: by.get(h.id) as number }] : []));
    setOpen((c) => (c && c.engine.state === 'ready' && c.engine.summary.buildId === buildId ? { ...c, engine: { state: 'ready', summary: { buildId, statCount: r.result.stats.length, headline } } } : c));
  }, []);

  /** A tab changed the open build through the engine: keep its text and the sidebar in step. */
  const engineEdited = useCallback(
    (xml: string) => {
      setOpen((cur) => (cur ? { ...cur, xml: withWindowAnnotations(xml, cur.xml, cur.engineAnn), engineAnn: annotationsOf(xml) } : cur));
      void refreshSummary();
    },
    [refreshSummary],
  );

  // The FullDPS rows that follow an edit: the one place the sidebar summary follows them (one read of the stats per event).
  useEffect(
    () =>
      window.pom.onEngineEvent((e) => {
        if (e.type === 'statDiff') void refreshSummary();
      }),
    [refreshSummary],
  );

  // ---- opening and closing builds ---------------------------------------------------------

  const openById = useCallback(
    async (id: string) => {
      const r = await window.pom.lib.read(id);
      if (!r.ok) {
        toast({ text: fromMain('ml_io_errors', r.error), kind: 'error' });
        void refresh();
        return;
      }
      const b = r.value;
      const whole = checkBuildXml(b.xml);
      if (!whole.ok) {
        setDlg({ k: 'info', title: tr('App.this_build_file_is_damaged'), body: tr('App.problem_name_was_not_opened', { problem: fromMain('ml_io_errors', damagedBuildMessage(whole.problem, 'file')), name: b.name }) });
        return;
      }
      setOpen({ id: b.id, name: b.name, folder: b.folder, xml: b.xml, saved: b.xml, info: b.info, engine: { state: 'loading' }, rev: 0 });
      setTab(DEFAULT_TAB);
      setArea('builds');
      void loadEngine(b.id, b.xml);
    },
    [loadEngine, refresh, toast],
  );

  // Follow a league-start guide: its build is saved to the library and opened (first launch and the Timelines starter card).
  const followStarter = useCallback(async (starterId: string) => {
    try {
      const b = await masteryCall<{ name: string; xml: string }>('mastery:starters', { method: 'build', starterId });
      const r = await window.pom.lib.create({ folder: '', name: b.name, xml: b.xml });
      if (!r.ok) { toast({ text: tr('App.couldn_t_save_the_starter', { error: fromMain('ml_io_errors', r.error) }), kind: 'error' }); return; }
      finishSetup();
      setStartOpen(false);
      await refresh();
      // Unsaved edits in the open Build get the same Save / Discard / Cancel question as any other way of leaving it.
      const cur = openRef.current;
      if (cur && cur.xml !== cur.saved) setDlg({ k: 'saveChanges', then: () => void openById(r.value.id) });
      else await openById(r.value.id);
    } catch { toast({ text: tr('App.that_starter_could_not_be'), kind: 'error' }); }
  }, [finishSetup, refresh, openById, toast]);

  // The Timelines league-start chooser asks for the import dialog the same way the first-launch one does.
  useEffect(() => {
    const open = () => { setArea('builds'); setDlg({ k: 'import' }); };
    window.addEventListener('pom:open-import', open);
    return () => window.removeEventListener('pom:open-import', open);
  }, [setArea]);

  // One save at a time: Save or Ctrl+S pressed while a save runs (the assistant saving a new build before its first question)
  // waits for that save instead of writing a second file. Resolves to the saved build's id, or null when nothing was saved.
  const saving = useRef<Promise<string | null> | null>(null);
  const saveOpen = useCallback((): Promise<string | null> => (saving.current ??= (async (): Promise<string | null> => {
    const cur = openRef.current;
    if (!cur) return null;
    saveEvent({ kind: 'saving', id: cur.id });
    if (freshRef.current === cur.id) {
      // First Save of a new build: this is when its file is written.
      const c = await window.pom.lib.create({ folder: cur.folder, name: cur.name, xml: await textToSave(cur) });
      if (!c.ok) {
        setDlg({ k: 'saveError', path: `${infoRef.current?.buildsDir ?? ''}/${cur.folder ? cur.folder + '/' : ''}${cur.name}.xml`.replace(/\\/g, '/'), error: fromMain('ml_io_errors', c.error), busy: false, exported: null });
        saveEvent({ kind: 'failed', id: cur.id });
        return null;
      }
      freshRef.current = null;
      setFreshId(null);
      saveEvent({ kind: 'saved' });
      setOpen((o) => (o && o.id === cur.id ? { ...o, id: c.value.id, name: c.value.name, folder: c.value.folder, saved: cur.xml, info: c.value.info } : o));
      void refresh();
      toast({ text: tr('App.saved_name', { name: c.value.name }), kind: 'ok', ttl: 2500 });
      return c.value.id;
    }
    const r = await window.pom.lib.save(cur.id, await textToSave(cur));
    if (!r.ok) {
      setDlg({ k: 'saveError', path: `${infoRef.current?.buildsDir ?? ''}/${cur.id}`.split('\\').join('/'), error: fromMain('ml_io_errors', r.error), busy: false, exported: null });
      saveEvent({ kind: 'failed', id: cur.id });
      return null;
    }
    saveEvent({ kind: 'saved' });
    if (freshRef.current === cur.id) {
      freshRef.current = null;
      setFreshId(null);
    }
    setOpen((c) => (c && c.id === cur.id ? { ...c, saved: cur.xml, info: r.value.info } : c));
    void refresh();
    toast({ text: tr('App.saved_name', { name: cur.name }), kind: 'ok', ttl: 2500 });
    return cur.id;
  })().finally(() => { saving.current = null; })), [refresh, toast]);
  const save = useCallback(async (): Promise<boolean> => (await saveOpen()) !== null, [saveOpen]);

  // Send to timeline: the saved build is frozen as a Timeline source in main, then the Timelines area opens its dialog.
  const sendOpenToTimeline = useCallback(async () => {
    const cur = openRef.current;
    if (!cur) return;
    if (freshRef.current === cur.id) { toast({ text: tr('App.save_this_build_first_then'), kind: 'error' }); return; }
    if (cur.xml !== cur.saved && !(await save())) return;
    try {
      const r = await masteryCall<{ objectId: string }>('mastery:timelines:sources', { method: 'freezeBuild', libraryId: cur.id });
      window.dispatchEvent(new CustomEvent('pom:mastery-go', { detail: { area: 'timelines', intent: { kind: 'send-to-timeline', source: { kind: 'build', objectId: r.objectId } } } }));
    } catch { toast({ text: tr('App.this_build_could_not_be'), kind: 'error' }); }
  }, [save, toast]);

  // A build made from "New build" or a class portrait that was never saved or renamed is not kept when the player leaves it.
  const freshRef = useRef<string | null>(null);
  // The same marker as state, so the header can say "Not saved yet" for it.
  const [freshId, setFreshId] = useState<string | null>(null);
  const guardLeave = useCallback((then: () => void) => {
    const cur = openRef.current;
    if (cur && cur.xml !== cur.saved) setDlg({ k: 'saveChanges', then });
    else then();
  }, []);

  // The window X, Alt F4, the taskbar and app quit all refuse to unload while the open build has unsaved changes;
  // the app then asks with the same Save / Don't Save / Cancel prompt as Back and Ctrl W.
  useEffect(() => {
    setCloseBlock(
      'build',
      dirty
        ? {
            title: tr('App.save_changes'),
            subtitle: tr('App.this_build_has_unsaved_changes'),
            body: tr('App.do_you_want_to_save'),
            confirmLabel: tr('App.save'),
            ask: () => guardLeave(() => void window.pom.win.closeAnyway()),
          }
        : null,
    );
    return () => setCloseBlock('build', null);
  }, [dirty, guardLeave]);

  // Restart to update saves the open build first, through the same Save as Ctrl S (a failure shows Save failed and stops the restart).
  useEffect(() => {
    setRestartSaver('build', async () => {
      const cur = openRef.current;
      if (!cur || cur.xml === cur.saved) return true;
      return save();
    });
    return () => setRestartSaver('build', null);
  }, [save]);

  // An interface update swaps this page for the new bundle without a restart (main/updater/interfaceSwap.ts): main asks
  // the old page where the player was (after every document was saved) and hands it to the new page, which reopens it.
  const handoffRef = useRef({ area, tab, buildId: open?.id ?? null });
  handoffRef.current = { area, tab, buildId: open?.id ?? null };
  useEffect(() => {
    const w = window as unknown as { __pomCaptureState?: () => unknown; __pomRestoreState?: (s: unknown) => Promise<void> };
    w.__pomCaptureState = () => ({ ...handoffRef.current });
    w.__pomRestoreState = async (raw: unknown) => {
      const s = raw as { area?: Area; tab?: TabId; buildId?: string | null } | null;
      if (!s) return;
      if (s.buildId) {
        const r = await window.pom.lib.read(s.buildId);
        if (r.ok) {
          await openById(s.buildId);
          if (s.tab && tabVisible(s.tab)) setTab(s.tab);
        }
      }
      if (s.area) setArea(s.area);
    };
    return () => {
      delete w.__pomCaptureState;
      delete w.__pomRestoreState;
    };
  }, [openById, setArea]);

  const closeBuild = useCallback(() => {
    guardLeave(() => {
      freshRef.current = null;
      setFreshId(null);
      setOpen(null);
      void refresh();
    });
  }, [guardLeave, refresh]);

  // The crest (Home): the root of Builds, which is the Library once builds exist and Start before that.
  const goHome = useCallback(() => {
    setArea('builds');
    setStartOpen(false);
    if (openRef.current) closeBuild();
  }, [closeBuild]);

  const importAndOpen = useCallback(
    async (d: DecodedImport, folderForNew = folder) => {
      const name = buildNameFor(d);
      const r = await window.pom.lib.create({ folder: folderForNew, name, xml: d.xml });
      if (!r.ok) {
        toast({ text: tr('App.couldn_t_save_the_imported', { error: fromMain('ml_io_errors', r.error) }), kind: 'error' });
        return;
      }
      setDlg(null);
      await refresh();
      await openById(r.value.id);
      toast({
        text: tr('App.imported_name_as_a_new', { name: r.value.name }),
        kind: 'ok',
        action: {
          label: tr('App.undo'),
          run: () => {
            void (async () => {
              const del = await window.pom.lib.remove(r.value.id);
              if (!del.ok) return toast({ text: fromMain('ml_io_errors', del.error), kind: 'error' });
              if (openRef.current?.id === r.value.id) setOpen(null);
              void refresh();
            })();
          },
        },
      });
    },
    [folder, openById, refresh, toast],
  );

  /** Reads pasted text (a code, XML or a link) and opens it as a new build. */
  const importText = useCallback(
    async (text: string) => {
      const shareToken = parseShareToken(text);
      if (shareToken) return void setDlg({ k: 'shared', token: shareToken });
      const c = classifyImportText(text);
      if (c.kind === 'unknown' || c.kind === 'empty') return void toast({ text: tr('App.that_is_not_a_build'), kind: 'error' });
      if (c.kind === 'link') toast({ text: tr('App.reading_from_label', { label: c.match.site.label }), ttl: 2500 });
      else if (c.kind === 'character-link') toast({ text: tr('App.reading_the_character_from_poe'), ttl: 2500 });
      const r = await window.pom.code.importText(text);
      if (!r.ok) {
        toast({ text: fromMain('ml_io_errors', r.error), kind: 'error' });
        return;
      }
      guardLeave(() => void importAndOpen(r.value, openRef.current ? openRef.current.folder : folder));
    },
    [folder, guardLeave, importAndOpen, toast],
  );

  useEffect(() => window.pom.onDeepLink((route) => {
    if (route.kind === 'importCode') void importText(route.code);
    else if (route.kind === 'openBuild') void openById(route.buildId);
    else if (route.kind === 'share') setDlg({ k: 'shared', token: route.token });
  }), [importText, openById]);

  // ---- accounts and cloud ----------------------------------------------------------------

  useEffect(() => {
    const h = () => (noAccounts ? toast({ text: acctText(OFFICIAL_ONLY) }) : setDlg({ k: 'signIn' }));
    window.addEventListener('pom-sign-in', h);
    return () => window.removeEventListener('pom-sign-in', h);
  }, [noAccounts, toast]);

  /** The sync wrote or removed files: reload the list, and the open build too when nothing of the player's is unsaved. */
  useEffect(
    () =>
      window.pom.account.onLibraryChanged((ids) => {
        void refresh();
        const cur = openRef.current;
        if (!cur || !ids.includes(cur.id)) return;
        if (cur.xml !== cur.saved) return void toast({ text: tr('App.name_changed_in_the_cloud', { name: cur.name }), kind: 'info' });
        void openById(cur.id);
        toast({ text: tr('App.name_was_updated_from_another', { name: cur.name }), kind: 'info' });
      }),
    [openById, refresh, toast],
  );

  const openHistory = useCallback(() => {
    const cur = openRef.current;
    if (!cur) return void toast({ text: tr('App.open_a_build_first_version'), kind: 'info' });
    setDlg({ k: 'history', id: cur.id, name: cur.name });
  }, [toast]);

  const syncToCloud = async (b: BuildEntry) => {
    const r = await window.pom.account.enroll(b.id);
    toast(r.ok ? { text: tr('App.name_is_syncing_to_your', { name: b.name }), kind: 'ok' } : { text: r.error, kind: 'error' });
  };
  const stopSync = async (b: BuildEntry) => {
    const r = await window.pom.account.unenroll(b.id, true);
    toast(r.ok ? { text: tr('App.name_is_local_only_again', { name: b.name }), kind: 'ok' } : { text: r.error, kind: 'error' });
  };

  /** Opens a shared build as a copy in the Library (in Shared with me). */
  const openShared = async (b: SharedBuild) => {
    const info = readBuildInfo(b.xml);
    const r = await window.pom.lib.create({ folder: tr('App.shared_with_me'), name: b.name, xml: b.xml, ...(b.allowDuplicate ? {} : { noSync: true }) });
    if (!r.ok) return void toast({ text: tr('App.couldn_t_save_the_shared', { error: fromMain('ml_io_errors', r.error) }), kind: 'error' });
    void info;
    setDlg(null);
    await refresh();
    await openById(r.value.id);
    toast({ text: tr('App.opened_name_as_a_new', { name: r.value.name }), kind: 'ok' });
  };

  /**
   * Marketplace "Edit a copy" of a published Build: its build code becomes a new build in "Marketplace", opened as the current Build
   * The code is unpacked here on this PC, so a saved post copies with the site unreachable too.
   */
  useEffect(() => {
    const onCopy = (e: Event) => {
      const d = (e as CustomEvent<{ name: string; code: string; credit: string }>).detail;
      if (!d || typeof d.code !== 'string' || typeof d.name !== 'string') return;
      guardLeave(() => void (async () => {
        const decoded = await window.pom.code.importText(d.code);
        if (!decoded.ok) return void toast({ text: tr('App.couldn_t_open_a_copy', { error: decoded.error }), kind: 'error' });
        // The credit stays with the build (first line of its notes), not only in the toast. The XML is parsed before it is saved.
        const xml = d.credit ? withCopyCredit(decoded.value.xml, d.credit) : decoded.value.xml;
        if (new DOMParser().parseFromString(xml, 'application/xml').getElementsByTagName('parsererror').length) return void toast({ text: tr('App.couldn_t_make_a_copy'), kind: 'error' });
        const r = await window.pom.lib.create({ folder: 'Marketplace', name: d.name.slice(0, 120) || decoded.value.name, xml });
        if (!r.ok) return void toast({ text: tr('App.couldn_t_save_the_copy', { error: fromMain('ml_io_errors', r.error) }), kind: 'error' });
        await refresh();
        await openById(r.value.id);
        toast({ text: tr('App.opened_name_as_a_new_2', { name: r.value.name, credit: d.credit }), kind: 'ok', ttl: 8000 });
      })());
    };
    window.addEventListener('pom-open-build-copy', onCopy);
    return () => window.removeEventListener('pom-open-build-copy', onCopy);
  }, [guardLeave, openById, refresh, toast]);

  /** Opens a community build as a new local build in "Community" (never synced to the cloud). */
  const openCommunity = async (c: CommunityBuild) => {
    const g = await window.pom.account.communityGet(c.id);
    if (!g.ok || !g.value) return void toast({ text: g.ok ? tr('App.that_build_is_no_longer') : tr('App.couldn_t_open_the_community', { error: g.error }), kind: 'error' });
    const r = await window.pom.lib.create({ folder: 'Community', name: g.value.name, xml: g.value.xml, noSync: true });
    if (!r.ok) return void toast({ text: tr('App.couldn_t_save_the_community', { error: fromMain('ml_io_errors', r.error) }), kind: 'error' });
    setDlg(null);
    await refresh();
    await openById(r.value.id);
    toast({ text: g.value.author ? tr('h_rA_app.opened_new_build_by', { name: r.value.name, author: g.value.author }) : tr('h_rA_app.opened_new_build', { name: r.value.name }), kind: 'ok' });
  };

  const makeBuild = useCallback(
    async (className: string, name: string) => {
      // A new build lives in memory until Save: no file exists before that, so leaving or crashing leaves nothing behind.
      const xml = blankBuildXml(className, settings.defaultLevel);
      const id = 'unsaved:' + Date.now();
      setDlg(null);
      setOpen({ id, name, folder, xml, saved: xml, info: readBuildInfo(xml), engine: { state: 'loading' }, rev: 0 });
      setTab(DEFAULT_TAB);
      setArea('builds');
      freshRef.current = id;
      setFreshId(id);
      void loadEngine(id, xml);
    },
    [folder, loadEngine, settings.defaultLevel],
  );
  // Every way to start a build (dialog, palette, class pick, Describe it) asks the same Save / Don't Save / Cancel question first
  // when the open build has unsaved edits, exactly like opening another build.
  const createBuild = useCallback(
    (className: string, name: string): Promise<void> => new Promise<void>((resolve) => guardLeave(() => void makeBuild(className, name).then(resolve))),
    [guardLeave, makeBuild],
  );
  // The New build dialog, from anywhere: Builds (library or an open build) and every other area switch to Builds first.
  const finishSetupRef = useRef<() => void>(() => undefined);
  finishSetupRef.current = finishSetup;
  const openNewBuild = useCallback(() => {
    finishSetupRef.current();
    setArea('builds');
    setDlg({ k: 'newBuild', cls: 'Scion' });
  }, [setArea]);
  useEffect(() => {
    window.addEventListener('pom:new-build', openNewBuild);
    return () => window.removeEventListener('pom:new-build', openNewBuild);
  }, [openNewBuild]);

  // ---- library actions --------------------------------------------------------------------

  const deleteBuild = async (b: BuildEntry) => {
    const r = await window.pom.lib.remove(b.id);
    if (!r.ok) {
      toast({ text: tr('App.couldn_t_delete_the_build', { error: fromMain('ml_io_errors', r.error) }), kind: 'error' });
      return;
    }
    await refresh();
    toast({
      text: tr('App.deleted_name_it_stays_in', { name: b.name }),
      action2: { label: tr('App.recently_deleted'), run: () => void openTrash() },
      action: {
        label: tr('App.undo'),
        run: () => {
          void (async () => {
            const back = await window.pom.lib.restore(r.value.token);
            if (!back.ok) toast({ text: fromMain('ml_io_errors', back.error), kind: 'error' });
            void refresh();
          })();
        },
      },
    });
  };

  const duplicate = async (b: BuildEntry) => {
    const r = await window.pom.lib.duplicate(b.id);
    if (!r.ok) return void toast({ text: fromMain('ml_io_errors', r.error), kind: 'error' });
    await carryFigures(b.id, r.value.id);
    await refresh();
    toast({ text: tr('App.duplicated_as_name', { name: r.value.name }), kind: 'ok' });
  };

  /** Archive, "Create copy": a new build file with every tree on the current version. The archived file is not touched. */
  const archiveCopy = async (b: BuildEntry, name: string): Promise<string | null> => {
    const read = await window.pom.lib.read(b.id);
    if (!read.ok) return fromMain('ml_io_errors', read.error);
    const xml = await fileText(convertAllSpecs(read.value.xml, LATEST_TREE_VERSION, [LATEST_TREE_VERSION]));
    const r = await window.pom.lib.create({ folder: b.folder, name, xml });
    if (!r.ok) return fromMain('ml_io_errors', r.error);
    await refresh();
    return null;
  };

  const copyCodeOf = async (b: BuildEntry) => {
    const read = await window.pom.lib.read(b.id);
    if (!read.ok) return void toast({ text: fromMain('ml_io_errors', read.error), kind: 'error' });
    const enc = await window.pom.code.encode(await fileText(read.value.xml));
    if (!enc.ok) return void toast({ text: enc.error, kind: 'error' });
    try {
      await navigator.clipboard.writeText(enc.value);
      toast({ text: tr('App.code_for_name_copied', { name: b.name }), kind: 'ok' });
    } catch {
      toast({ text: tr('App.could_not_reach_the_clipboard'), kind: 'error' });
    }
  };

  /**
   * The one place a build that changes id or is copied keeps its calculated DPS and Life: rename (card menu, header), Move to
   * folder (dialog, drag), Duplicate and Rename folder go through it. The saved figures are written into the new file, so the card
   * and a reload show them. Save and Save As write them in `textToSave`.
   */
  const carryFigures = async (oldId: string, newId: string) => {
    const fig = figuresRef.current[oldId];
    if (!fig || oldId === newId || fig.mtime !== listingRef.current?.builds.find((x) => x.id === oldId)?.mtimeMs) return;
    const rd = await window.pom.lib.read(newId);
    if (!rd.ok) return;
    const xml = withPlayerStats(rd.value.xml, fig.ps);
    if (xml !== rd.value.xml) await window.pom.lib.save(newId, xml);
  };

  const doRename = async (b: BuildEntry, name: string) => {
    const r = await window.pom.lib.rename(b.id, name);
    if (!r.ok) return setDlg({ k: 'rename', entry: b, error: fromMain('ml_io_errors', r.error) });
    setDlg(null);
    await carryFigures(b.id, r.value.id);
    void refresh();
  };

  const doMove = async (b: BuildEntry, to: string, keepBoth: boolean) => {
    const r = await window.pom.lib.move(b.id, to, keepBoth);
    if (!r.ok) {
      if (r.code === 'EEXIST') return setDlg({ k: 'conflict', entry: b, to, message: fromMain('ml_io_errors', r.error) });
      setDlg(null);
      return void toast({ text: tr('App.couldn_t_move_the_build', { error: fromMain('ml_io_errors', r.error) }), kind: 'error' });
    }
    setDlg(null);
    await carryFigures(b.id, r.value.id);
    void refresh();
    toast({ text: tr('App.moved_to_to', { to: folderLabel(to) }), kind: 'ok' });
  };

  const doNewFolder = async (parent: string, name: string) => {
    const r = await window.pom.lib.folderCreate(parent, name);
    if (!r.ok) return setDlg({ k: 'newFolder', parent, error: fromMain('ml_io_errors', r.error) });
    setDlg(null);
    await refresh();
    setFolder(r.value.path);
  };

  const doRenameFolder = async (f: FolderEntry, name: string) => {
    const r = await window.pom.lib.folderRename(f.path, name);
    if (!r.ok) return setDlg({ k: 'renameFolder', folder: f, error: fromMain('ml_io_errors', r.error) });
    setDlg(null);
    if (folder === f.path || folder.startsWith(f.path + '/')) setFolder(r.value.path + folder.slice(f.path.length));
    for (const id of Object.keys(figuresRef.current)) if (id.startsWith(f.path + '/')) await carryFigures(id, r.value.path + id.slice(f.path.length));
    void refresh();
  };

  const askDeleteFolder = async (f: FolderEntry) => {
    const c = await window.pom.lib.folderCount(f.path);
    const count = c.ok ? c.value : 0;
    if (count === 0) {
      const r = await window.pom.lib.folderDelete(f.path, false);
      if (!r.ok) toast({ text: fromMain('ml_io_errors', r.error), kind: 'error' });
      void refresh();
    } else setDlg({ k: 'deleteFolder', folder: f, count });
  };

  const openTrash = async () => {
    const r = await window.pom.lib.trashList();
    if (r.ok) setDlg({ k: 'trash', items: r.value });
    else toast({ text: fromMain('ml_io_errors', r.error), kind: 'error' });
  };

  const checkUpdate = async () => {
    const r = await window.pom.app.updateAvailable();
    if (!r.ok) return toast({ text: r.error, kind: 'error' });
    if (!r.value.layers.length) return toast({ text: tr('App.you_are_on_the_latest'), kind: 'ok' });
    setDlg({ k: 'update', offer: r.value, busy: false, error: null });
  };

  /** Update: the existing update pass downloads and checks each layer; the dialog says what happened. */
  const runUpdate = async (offer: UpdateOffer) => {
    setDlg({ k: 'update', offer, busy: true, error: null });
    const r = await window.pom.app.checkForUpdates();
    const fail = !r.ok ? r.error : (r.value as { failed?: string | null } | undefined)?.failed;
    if (fail) return setDlg({ k: 'update', offer, busy: false, error: tr('App.the_update_did_not_finish', { fail }) });
    setDlg(null);
    void window.pom.app.info().then((r) => r.ok && setInfo(r.value)); /* About shows the layer versions now running */
    // Whatever was taken now waits in the title bar: Restart to update (app, engine) or Apply update (interface).
  };

  // ---- workspace actions -------------------------------------------------------------------

  const onNotes = useCallback((text: string) => {
    setOpen((cur) => (cur && getNotes(cur.xml) !== text ? { ...cur, xml: setNotes(cur.xml, text) } : cur));
  }, []);

  /** The Find Timeless Jewel dialog's choices live in the build text only (like the notes); the engine never sees them. */
  const onTimelessData = useCallback((attrs: Record<string, string | undefined>) => {
    setOpen((cur) => (cur ? { ...cur, xml: setTimelessData(cur.xml, attrs) } : cur));
  }, []);

  const onEngineXml = useCallback((engineXml: string) => {
    setOpen((cur) => {
      if (!cur) return cur;
      const xml = withWindowAnnotations(engineXml, cur.xml, cur.engineAnn);
      const engineAnn = annotationsOf(engineXml);
      return cur.xml !== xml || cur.engineAnn !== engineAnn ? { ...cur, xml, info: cur.xml !== xml ? readBuildInfo(xml) : cur.info, engineAnn } : cur;
    });
  }, []);
  /** Edits go to the engine one at a time (with every other change to the session); the build text and the sidebar numbers then follow what it answers. */
  /** One change to session `buildId`, run inside its queue. */
  const engineJob = useCallback(async (buildId: string, kind: 'edit' | 'undo' | 'redo', edit?: BuildEdit): Promise<EditResult> => {
      const cur = openRef.current;
      if (!cur || cur.engine.state !== 'ready' || cur.engine.summary.buildId !== buildId) return { ok: false, error: tr('App.the_build_changed_before_this') };
      const r = kind === 'edit' ? await window.pom.sendCommand('edit', { buildId, edit: edit! }) : await window.pom.sendCommand(kind, { buildId });
      if (!r.ok) return { ok: false, error: engineReason(r.error.message) };
      const res = r.result as { statDiff: StatDiff | null; blocked?: string };
      if (res.blocked) return { ok: true, blocked: res.blocked };
      const x = await window.pom.sendCommand('getBuildXml', { buildId });
      setOpen((c) => {
        if (!c || c.engine.state !== 'ready' || c.engine.summary.buildId !== buildId) return c;
        // The engine's text has no unsaved notes or Timeless dialog choices; those are edited only in the text here.
        const xml = x.ok ? withWindowAnnotations(x.result.buildXml, c.xml, c.engineAnn) : c.xml;
        return { ...c, xml, ...(x.ok ? { engineAnn: annotationsOf(x.result.buildXml) } : {}), engine: { state: 'ready', summary: res.statDiff ? withDiff(c.engine.summary, res.statDiff) : c.engine.summary } };
      });
      return { ok: true };
  }, []);
  const runEngine = useCallback((kind: 'edit' | 'undo' | 'redo', edit?: BuildEdit): Promise<EditResult> => {
    const start = openRef.current;
    if (!start || start.engine.state !== 'ready') return Promise.resolve({ ok: false, error: tr('App.the_calculation_engine_has_not_2') });
    const buildId = start.engine.summary.buildId;
    return serial(buildId, () => engineJob(buildId, kind, edit)).catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
  }, [engineJob]);
  const onEdit = useCallback((edit: BuildEdit) => runEngine('edit', edit), [runEngine]);
  const onUndo = useCallback(() => runEngine('undo'), [runEngine]);

  /** The open build's text changes outside the engine (a converted tree version): load it into the engine again. */
  const replaceXml = (xml: string) => {
    setOpen((cur) => (cur ? { ...cur, xml, info: readBuildInfo(xml), rev: cur.rev + 1, engine: { state: 'loading' } } : cur));
    const cur = openRef.current;
    if (cur) void loadEngine(cur.id, xml);
    toast({ text: tr('App.converted_to_the_current_tree'), kind: 'ok' });
  };

  // The build as it was before the last "Import to this build", so Ctrl Z can bring it back (the import starts a new engine session).
  const importBack = useRef<{ id: string; xml: string } | null>(null);
  const undoImport = (): boolean => {
    const b = importBack.current;
    const cur = openRef.current;
    importBack.current = null;
    if (!b || !cur || cur.id !== b.id) return false;
    setOpen((c) => (c ? { ...c, xml: b.xml, info: readBuildInfo(b.xml), rev: c.rev + 1, engine: { state: 'loading' } } : c));
    void loadEngine(cur.id, b.xml);
    toast({ text: tr('App.import_undone'), kind: 'ok' });
    return true;
  };
  const importHere = (d: DecodedImport) => {
    if (openRef.current) importBack.current = { id: openRef.current.id, xml: openRef.current.xml };
    setOpen((cur) => (cur ? { ...cur, xml: d.xml, info: d.info, rev: cur.rev + 1, engine: { state: 'loading' } } : cur));
    const cur = openRef.current;
    if (cur) void loadEngine(cur.id, d.xml);
    toast({ text: tr('App.imported_into_this_build_press'), kind: 'ok' });
  };

  /** The Import dialog's "replace items in the current build": a new text for the open build as one undoable step. */
  const applyToOpen = useCallback(
    async (fn: (xml: string) => Promise<string>, text: string): Promise<boolean> => {
      const cur = openRef.current;
      if (!cur || cur.engine.state !== 'ready') {
        toast({ text: tr('App.the_calculation_engine_has_not'), kind: 'error' });
        return false;
      }
      const buildId = cur.engine.summary.buildId;
      try {
        // Read, change and write back as one step of the session's queue, so no other change is lost in between.
        const r = await serial(buildId, async () => {
          const x = await window.pom.sendCommand('getBuildXml', { buildId });
          if (!x.ok) throw new Error(x.error.message);
          const next = await fn(x.result.buildXml);
          return engineJob(buildId, 'edit', { kind: 'setXml', xml: next });
        });
        if (!r.ok) throw new Error(r.error);
        toast({ text, kind: 'ok', action: { label: tr('App.undo'), run: () => void runEngine('undo') } });
        return true;
      } catch (e) {
        toast({ text: tr('App.could_not_apply_that_v1', { value: e instanceof Error ? e.message : String(e) }), kind: 'error' });
        return false;
      }
    },
    [runEngine, engineJob, toast],
  );

  const renameOpen = async (name: string) => {
    const cur = openRef.current;
    if (!cur) return;
    if (freshRef.current === cur.id) return void setOpen((c) => (c && c.id === cur.id ? { ...c, name } : c)); // not on disk yet: only the name in memory changes
    const r = await window.pom.lib.rename(cur.id, name);
    if (!r.ok) return void toast({ text: tr('App.couldn_t_rename_the_build', { error: fromMain('ml_io_errors', r.error) }), kind: 'error' });
    setOpen((c) => (c && c.id === cur.id ? { ...c, id: r.value.id, name: r.value.name } : c));
    await carryFigures(cur.id, r.value.id);
    void refresh();
  };

  // Export recovery file (failed save): the unsaved build goes to a file the user picks; it stays unsaved here.
  const exportRecovery = async () => {
    const cur = openRef.current;
    if (!cur) return;
    const r = await window.pom.code.saveFile(tr('App.name_recovery', { name: cur.name }), await fileText(cur.xml));
    if (!r.ok) return void toast({ text: tr('App.the_recovery_file_could_not'), kind: 'error' });
    const picked = r.value;
    if (picked) setDlg((d) => (d?.k === 'saveError' ? { ...d, exported: picked } : d));
  };

  const saveAs = async (name: string, to: string) => {
    const cur = openRef.current;
    if (!cur) return;
    const r = await window.pom.lib.create({ folder: to, name, xml: await textToSave(cur) });
    if (!r.ok) return setDlg({ k: 'saveAs', error: fromMain('ml_io_errors', r.error) });
    setDlg(null);
    if (freshRef.current === cur.id) {
      freshRef.current = null;
      setFreshId(null);
    }
    setOpen((c) => (c ? { ...c, id: r.value.id, name: r.value.name, folder: r.value.folder, saved: cur.xml } : c));
    await refresh();
    toast({ text: tr('App.saved_as_name', { name: r.value.name }), kind: 'ok' });
  };

  const copyOpenCode = async () => {
    const cur = openRef.current;
    if (!cur) return;
    const enc = await window.pom.code.encode(await fileText(cur.xml));
    if (!enc.ok) return void toast({ text: enc.error, kind: 'error' });
    try {
      await navigator.clipboard.writeText(enc.value);
      toast({ text: tr('App.build_code_copied'), kind: 'ok' });
    } catch {
      toast({ text: tr('App.could_not_reach_the_clipboard'), kind: 'error' });
    }
  };

  // Every look change made outside the Settings dialog (the account menu's Mode row, Alt+Shift+L/T, the palette's theme and mode
  // actions) goes through here. With Settings closed it is saved at once, so it survives a restart. With Settings open it becomes
  // a draft edit there (shown and previewed, kept by Save, undone by Cancel), so Settings never shows a stale look or saves one back.
  const appearance = useCallback((patch: Partial<AppSettings>) => {
    const ctl = dlgRef.current?.k === 'settings' ? settingsCtl.current : null;
    if (ctl) ctl.edit(patch);
    else void update(patch);
  }, [update]);
  /** Runs `then` once an open Settings dialog has been left (its Discard question first), for screens that are not app dialogs. */
  const afterSettings = useCallback((then: () => void) => {
    const ctl = dlgRef.current?.k === 'settings' ? settingsCtl.current : null;
    if (ctl) ctl.leave(() => { setDlgState(null); then(); });
    else then();
  }, []);

  // ---- keyboard and paste --------------------------------------------------------------------

  // Alt+Shift+L (light/dark) and Alt+Shift+T (next theme) are look changes like the account menu's Mode row (see `appearance`).
  // Caught before the design system's own page-only handler (public/ds/theme.js), which would change the look unsaved.
  const lookRef = useRef(settings);
  lookRef.current = settings;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey || (e.code !== 'KeyL' && e.code !== 'KeyT')) return;
      e.preventDefault();
      e.stopPropagation();
      const s = lookRef.current; // includes an open Settings dialog's preview, so the next theme follows what is on screen
      if (e.code === 'KeyL') appearance({ mode: document.documentElement.getAttribute('data-mode') === 'light' ? 'dark' : 'light' });
      else appearance({ theme: THEMES[(THEMES.findIndex((t) => t.id === s.theme) + 1) % THEMES.length]!.id });
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [appearance]);

  // Builds with no build open shows Start when nothing is saved yet (or the folder is still being read, or could not be read),
  // and when League starts asked for it; otherwise the Library.
  const libEmpty = !!listing && listing.builds.length === 0 && listing.folders.length === 0;
  // A failed read shows Start's recovery panel even when builds were listed before (the old list would be stale).
  const startView = area === 'builds' && !open && (listing === null || libEmpty || startOpen || listError !== null);
  buildsRootRef.current = area === 'builds' && !open;
  const describeRef = useRef<() => void>(() => undefined);
  const openAssistantRef = useRef<(r?: { text?: string; send?: boolean; toggle?: boolean }) => void>(() => undefined);
  const blocked = dlg !== null || searchOpen;
  const inLibrary = area === 'builds' && !open;
  useEffect(() => {
    if (blocked) return;
    const typing = (t: EventTarget | null) => { const e = t as HTMLElement | null; return !!e && (/^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName) || e.isContentEditable); };
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.key === 'ArrowLeft' && !typing(e.target)) { e.preventDefault(); goBack(); }
    };
    const onMouse = (e: MouseEvent) => { if (e.button === 3) { e.preventDefault(); goBack(); } };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mouseup', onMouse);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mouseup', onMouse); };
  }, [blocked, goBack]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      // Ctrl Alt 1 to 9 follow the build's tab row, left to right (they moved off Ctrl 1-9, which are the areas now).
      if (e.altKey) {
        const digit = /^Digit([1-9])$/.exec(e.code)?.[1];
        const target = digit ? TABS[Number(digit) - 1] : undefined; // a digit past the visible tabs does nothing
        if (target && open && !dlg && !searchOpen) {
          e.preventDefault();
          setArea('builds');
          setTab(target.id);
        }
        return;
      }
      const k = e.key.toLowerCase();
      // Ctrl 1 to N switch areas in area-bar order, even from a text field (the shell's global navigation).
      if (/^[1-9]$/.test(k) && Number(k) <= AREA_ORDER.length && !dlg && !e.shiftKey) {
        e.preventDefault();
        setArea(AREA_ORDER[Number(k) - 1]!);
        return;
      }
      const t = e.target as HTMLElement | null;
      const typing = !!t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);
      // The loot filter area owns Ctrl K (its own palette) and, in Full mode, Ctrl , (its own settings): one overlay at a time.
      const lfOwns = area === 'filter';
      if (k === 'k') {
        // Guided's find box (once a filter exists) keeps Ctrl K. Everywhere else in Loot Filter, Full mode
        // included, it opens the app palette as in every other area; Full mode's own palette stays on its search button.
        if (lfOwns && document.getElementById('lf-find')) return;
        e.preventDefault();
        setSearchOpen((v) => !v);
        return;
      }
      if (searchOpen) return;
      if (k === 'j') {
        // In the loot filter's Full mode Ctrl J is the filter's own Ask panel.
        if (lfOwns && lfMode === 'advanced') return;
        e.preventDefault();
        // Ctrl J never makes a build: with none open it says so. On Builds it toggles the panel; elsewhere it brings it up.
        openAssistantRef.current(area === 'builds' ? { toggle: true } : {});
      } else if (k === ',') {
        if (lfOwns && lfMode === 'advanced') return;
        e.preventDefault();
        setDlg((d) => (d?.k === 'settings' ? d : { k: 'settings' }));
      } else if (k === '/') {
        e.preventDefault();
        setDlg({ k: 'shortcuts' });
      } else if (dlg) {
        return;
      } else if (k === 'n' && !e.shiftKey && !typing) {
        // Ctrl N starts a fresh build from anywhere (not while typing, and not under another dialog: `dlg` returned above).
        // A modal or menu owned by a screen (Atlas New folder, a Timelines dialog, an open menu) is in the DOM but not in `dlg`.
        if (document.querySelector(`${LAYER_SELECTOR}, [role="dialog"], [aria-modal="true"]`)) return;
        e.preventDefault();
        openNewBuild();
      } else if (k === 'i') {
        e.preventDefault();
        // Always the Import dialog: it adds a new build and leaves an open one as it is.
        setDlg({ k: 'import' });
      } else if (k === 'h' && open && acct.signedIn) {
        e.preventDefault();
        openHistory();
      } else if (k === 's' && open) {
        e.preventDefault();
        if (e.shiftKey) setDlg({ k: 'saveAs' });
        else void save();
      } else if (k === 'w' && open) {
        e.preventDefault();
        closeBuild();
      } else if (k === 'f' && inLibrary && !startView) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (open && !typing && /^[7-9]$/.test(k)) {
        // Ctrl 7-9 are not areas; they stay a quiet no-op rather than reaching the page.
        e.preventDefault();
      }
    };
    const onPaste = (e: ClipboardEvent) => {
      if (blocked || !inLibrary) return;
      const t = e.target as HTMLElement | null;
      if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
      const text = e.clipboardData?.getData('text') ?? '';
      if (!text.trim()) return;
      e.preventDefault();
      const c = classifyImportText(text);
      if (c.kind === 'unknown' || c.kind === 'empty') return void toast({ text: tr('App.that_is_not_a_build'), kind: 'error' });
      void importText(text);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('paste', onPaste);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('paste', onPaste);
    };
  }, [acct.signedIn, area, blocked, closeBuild, dlg, importText, inLibrary, lfMode, open, openHistory, openNewBuild, save, searchOpen, startView, toast]);

  // ---- search documents -----------------------------------------------------------------------

  const found = useBuildSearch();
  const [assistantReady, setAssistantReady] = useState<ProviderId | null>(null);
  // Read at start-up as well as on each open, so the palette never shows "Connect" and then flips to a signed-in assistant.
  useEffect(() => {
    let alive = true;
    void Promise.all([window.pom.assistant.status(), window.pom.assistant.getPrefs()]).then(([st, pr]) => {
      if (!alive || !st.ok) return;
      const want = pr.ok ? pr.value.provider : 'claude';
      const ready = st.value.filter((x) => x.state === 'ready');
      setAssistantReady((ready.find((x) => x.id === want) ?? ready[0])?.id ?? null);
    });
    return () => {
      alive = false;
    };
  }, [searchOpen]);

  const searchDocs = useMemo<SearchDoc[]>(() => {
    // Areas first: on a tie with another row ("Wealth: Bulk board"), the area itself is the top result.
    const docs: SearchDoc[] = areaDocs(setArea);
    const tabTo = (t: TabId, r?: SearchRow) => () => { setArea('builds'); setTab(t); if (r?.target) jumpTo(r.target, r.title); };
    if (open && found && found.buildId === open.id) {
      for (const r of found.stats) docs.push({ kind: 'Stat', title: r.title, meta: r.meta, run: tabTo('calcs', r) });
      for (const r of found.config) docs.push({ kind: 'Setting', title: r.title, meta: r.meta, run: tabTo('config', r) });
      for (const r of found.items) docs.push({ kind: 'Item', title: r.title, meta: r.meta, run: tabTo('items', r) });
      for (const r of found.gems) docs.push({ kind: 'Gem', title: r.title, meta: r.meta, run: tabTo('skills', r) });
      for (const r of found.passives) docs.push({ kind: 'Passive', title: r.title, meta: r.meta, run: tabTo('tree', r) });
    }
    if (open) {
      for (const [id, label, meta, extra] of PALETTE_TABS) docs.push({ kind: 'Tab', title: label, meta, extra, run: tabTo(id) });
      docs.push(
        { kind: 'Action', title: tr('App.save_build'), meta: 'Ctrl S', extra: 'save', run: () => void save() },
        { kind: 'Action', title: tr('App.save_as'), meta: '', extra: 'save', run: () => setDlg({ k: 'saveAs' }) },
        { kind: 'Action', title: tr('App.copy_build_code'), meta: '', extra: 'share export', run: () => void copyOpenCode() },
      );
    }
    docs.push(...buildDocs(listing?.builds ?? [], (b) => { setArea('builds'); void openById(b.id); }));
    docs.push(...settingsDocs((section, row) => setDlg({ k: 'settings', section, row })));
    docs.push(
      { kind: 'Action', title: tr('App.recently_deleted'), meta: '', extra: 'trash restore undelete bin deleted builds', run: () => { setArea('builds'); void openTrash(); } },
      { kind: 'Action', title: tr('App.import_a_build'), meta: 'Ctrl I', extra: 'import code link paste pobb.in pastebin', run: () => setDlg({ k: 'import' }) },
      { kind: 'Action', title: tr('App.new_build'), meta: 'Ctrl N', run: openNewBuild },
      { kind: 'Action', title: tr('App.new_folder'), meta: '', run: () => { setArea('builds'); setDlg({ k: 'newFolder', parent: folder }); } },
      { kind: 'Action', title: tr('App.build_library'), meta: tr('h_rA_app.screen'), extra: 'builds home', run: () => { setArea('builds'); setStartOpen(false); if (openRef.current) closeBuild(); } },
      ...(LEAGUE_STARTERS ? [{ kind: 'Action' as const, title: tr('App.league_starts'), meta: tr('h_rA_app.screen'), extra: 'start guide follow starter new build home', run: () => { setArea('builds'); if (openRef.current) closeBuild(); setStartOpen(true); } }] : []),
      { kind: 'Action', title: tr('App.wealth_bulk_board'), meta: tr('h_rA_app.screen'), extra: 'sell bulk trade', run: () => { setArea('wealth'); wealth.go('board'); } },
      { kind: 'Action', title: tr('App.wealth_your_loot_filter_priced'), meta: tr('h_rA_app.screen'), extra: 'loot filter rate hide threshold suggestions', run: () => { setArea('wealth'); wealth.go('filter'); } },
      { kind: 'Action', title: tr('App.wealth_connection_check'), meta: '', extra: 'pathofexile.com calls rate limit cookie', run: () => { setArea('wealth'); window.setTimeout(() => window.dispatchEvent(new CustomEvent('pom-wealth-connection')), 0); } },
      { kind: 'Action', title: tr('App.change_theme'), meta: tr('h_rA_app.appearance'), extra: 'theme', run: () => { const i = THEMES.findIndex((t) => t.id === settings.theme); appearance({ theme: THEMES[(i + 1) % THEMES.length]!.id }); } },
      { kind: 'Action', title: tr('App.switch_light_and_dark_mode'), meta: 'Alt Shift L', extra: 'theme appearance', run: () => appearance({ mode: document.documentElement.getAttribute('data-mode') === 'light' ? 'dark' : 'light' }) },
      { kind: 'Action', title: tr('App.options'), meta: 'Ctrl ,', extra: 'settings preferences', run: () => setDlg({ k: 'settings' }) },
      { kind: 'Action', title: tr('App.keyboard_shortcuts'), meta: 'Ctrl /', run: () => setDlg({ k: 'shortcuts' }) },
      { kind: 'Action', title: tr('App.send_feedback'), meta: '', extra: 'support help report bug contact email', run: () => setDlg({ k: 'feedback' }) },
      { kind: 'Action', title: tr('App.about_path_of_mastery'), meta: '', extra: 'version changelog help', run: () => setDlg({ k: 'about' }) },
      { kind: 'Action', title: tr('App.check_for_update'), meta: '', run: () => void checkUpdate() },
    );
    return docs;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [found, open?.id, folder, settings.theme, listing]);

  /** Opens the assistant on the open build; with no build open there is nothing for it to read. */
  const openAssistant = useCallback((r: { text?: string; send?: boolean; toggle?: boolean } = {}) => {
    if (!openRef.current) {
      toast({ text: tr('App.open_a_build_first_the'), kind: 'info' });
      return;
    }
    setArea('builds');
    // The panel mounts with the workspace; ask again until it is there.
    let tries = 0;
    const ask = () => {
      if (!requestAssistant(r) && ++tries < 20) window.setTimeout(ask, 250);
    };
    ask();
  }, [toast]);
  openAssistantRef.current = openAssistant;

  // ---- render ---------------------------------------------------------------------------------

  /** Start, "Describe it": a new build opens with the assistant beside it and the example question ready to edit. */
  describeRef.current = () => {
    void createBuild('Scion', tr('App.new_build')).then(() => window.setTimeout(() => openAssistant({ text: DESCRIBE_EXAMPLE }), 400));
  };
  // The title slot only says something the screen does not: Wealth's league. The open build's header carries its own name
  // (the crumb keeps only the folder while the header hides it), Start and the Library their own heading, the other areas their own header.
  const title = area === 'wealth' ? (wealth.w?.sync.league ? `${wealth.w.sync.league}${/Standard|Hardcore|HC|SSF|Ruthless|Solo/i.test(wealth.w.sync.league) ? '' : ' SC'}` : '') : '';
  const subtitle = area === 'wealth' && wealth.w?.sync.sample ? tr('h_rA_app.sample') : area === 'builds' && open && pathHidden ? (freshId === open.id ? tr('App.not_saved_yet') : `${tr('areaGate.builds')}${open.folder ? ' / ' + folderLabel(open.folder) : ''}`) : undefined;
  const version = info?.version ?? '0.1.0';

  return (
    <div className="app" data-screen-label="Path of Mastery">
      <CloseGuardDialog />
      <UpdateCenter />
      <Starfield mode={settings.starfield} context={{ window: 'main', area: area === 'builds' ? 'build' : area }} modalOpen={blocked} reducedMotion={!settings.animations} />
      <TitleBar
        area={area}
        onArea={setArea}
        canBack={canBack}
        onBack={goBack}
        onHome={goHome}
        title={title}
        subtitle={subtitle}
        maximized={maximized}
        settings={settings}
        onAppearance={appearance}
        onLanguage={(language) => void update({ language }).then((r) => { if (!r.ok) toast({ text: tr('TitleBar.language_could_not_switch', { error: r.error }), kind: 'error' }); })}
        onOpenSettings={(section) => setDlg({ k: 'settings', ...(section ? { section } : {}) })}
        onShortcuts={() => setDlg({ k: 'shortcuts' })}
        onFeedback={() => setDlg({ k: 'feedback' })}
        onConnectDesktop={() => afterSettings(() => { if (!requestConnector()) setDlgState({ k: 'connectClaude' }); })}
        afterSettings={afterSettings}
        onSignIn={() => setDlg({ k: 'signIn' })}
        onRevealBuilds={() => void window.pom.lib.reveal()}
        onResolve={(id) => setDlg({ k: 'syncConflict', id })}
        onCloudBuilds={goHome}
        onHistory={openHistory}
        onAccountSettings={() => setDlg({ k: 'account' })}
        searchDocs={searchDocs}
        assistant={{ ready: assistantReady, onConnect: () => openAssistant(), onAsk: (q) => openAssistant({ text: q, send: true }) }}
        searchOpen={searchOpen}
        lfSlots={{ setCtx: lfMode === 'advanced' ? undefined : setLfCtx, setSearch: setLfSearch }}
        setSearchOpen={setSearchOpen}
      />
      <main className="stage" {...(area === 'atlas' || area === 'timelines' || area === 'marketplace' || startView ? { 'data-sky': '' } : {})}>
        {area === 'builds' && !open && listing && !libEmpty && (
          // Kept mounted (hidden) while Start is open from League starts, so Back to your builds returns to the same folder and search.
          <div hidden={startView}>
          <ErrorBoundary scope="area" label={tr('App.the_library')} resetKey={folder}>
          <Library
            listing={shownListing}
            settings={settings}
            folder={folder}
            setFolder={setFolder}
            blocked={blocked || startView}
            {...(LEAGUE_STARTERS ? { onLeagueStarts: () => setStartOpen(true) } : {})}
            searchRef={searchRef}
            onOpen={(b) => void openById(b.id)}
            onNewBuild={openNewBuild}
            onImport={() => setDlg({ k: 'import' })}
            onNewFolder={() => setDlg({ k: 'newFolder', parent: folder })}
            onRename={(b) => setDlg({ k: 'rename', entry: b })}
            onDuplicate={(b) => void duplicate(b)}
            onArchiveCopy={archiveCopy}
            onMove={(b) => setDlg({ k: 'move', entry: b })}
            onMoveTo={(b, to) => void doMove(b, to, false)}
            onDelete={(b) => void deleteBuild(b)}
            onCopyCode={(b) => void copyCodeOf(b)}
            onRenameFolder={(f) => setDlg({ k: 'renameFolder', folder: f })}
            onDeleteFolder={(f) => void askDeleteFolder(f)}
            onOpenTrash={() => void openTrash()}
            onReveal={() => void window.pom.lib.reveal()}
            onPatchSettings={appearance}
            onOpenCommunity={(c) => void openCommunity(c)}
            onManageCommunity={() => setDlg({ k: 'myPublished' })}
            onSyncToCloud={(b) => void syncToCloud(b)}
            onStopSync={(b) => void stopSync(b)}
            onHistory={(b) => setDlg({ k: 'history', id: b.id, name: b.name })}
            onResolve={(b) => setDlg({ k: 'syncConflict', id: b.id })}
            onSyncAll={() => void window.pom.account.enrollAll().then((r) => toast(r.ok ? { text: r.value ? tr('App.syncing_count_builds_to_the', { count: r.value }) : tr('App.everything_is_already_in_the'), kind: 'ok' } : { text: r.error, kind: 'error' }))}
          />
          </ErrorBoundary>
          </div>
        )}
        {startView && startArchive && (
          <ArchivePanel area="Builds" current={currentBuildLeague} rows={oldBuilds(listing?.builds ?? [])} emptyText={tr('App.no_archived_builds_every_build')} onClose={() => setStartArchive(false)}
            onCopy={(row, name) => archiveCopy(listing!.builds.find((b) => b.id === row.id)!, name)} />
        )}
        {startView && (
          <ErrorBoundary scope="area" label={tr('App.the_start_screen')}>
            <Start
              lib={listError ? { state: 'error', error: listError } : listing === null ? { state: 'loading' } : { state: 'ready' }}
              version={version}
              signedIn={acct.signedIn || noAccounts}
              onBack={listing && !libEmpty && !listError ? () => setStartOpen(false) : undefined}
              onArchive={() => setStartArchive(true)}
              onPickClass={(cls) => { finishSetup(); setStartOpen(false); void createBuild(cls, tr('App.new_cls_build', { cls })); }}
              onNewBuild={openNewBuild}
              onImportText={(t) => void importText(t)}
              onOpenImport={(tab) => setDlg({ k: 'import', ...(tab !== undefined ? { tab } : {}) })}
              onAssistant={() => describeRef.current()}
              onFollow={followStarter}
              onLootFilter={() => setArea('filter')}
              onAtlas={() => setArea('atlas')}
              onOpenSettings={() => setDlg({ k: 'settings' })}
              onOpenAbout={() => setDlg({ k: 'about' })}
              onCheckUpdate={() => void checkUpdate()}
              onSignIn={() => setDlg({ k: 'signIn' })}
              onRetry={retryList}
              onChooseFolder={() => setDlg({ k: 'settings', section: 'build-defaults', row: tr('App.build_save_path') })}
              onShowFolder={() => void window.pom.lib.reveal()}
            />
          </ErrorBoundary>
        )}
        {area === 'builds' && open && (
          <ErrorBoundary scope="area" label={tr('App.this_build')} resetKey={open.id} back={{ label: tr('App.back_to_the_library'), run: closeBuild }}>
          <BuildWorkspace
            build={open}
            onPathHidden={setPathHidden}
            onNewBuild={openNewBuild}
            engine={engineHandle}
            tab={tab}
            onTab={setTab}
            appInfo={info}
            version={version}
            dirty={dirty}
            notSaved={freshId === open.id}
            saveStatus={saveStatusLabel(buildSave, open.id, dirty, freshId === open.id)}
            onBack={closeBuild}
            onDiscard={() => { setOpen(null); void refresh(); }}
            onSave={() => void save()}
            saveNow={saveOpen}
            onSaveAs={() => setDlg({ k: 'saveAs' })}
            onRename={(n) => void renameOpen(n)}
            onNotes={onNotes}
            onTimelessData={onTimelessData}
            onEdit={onEdit}
            onUndo={onUndo}
            onImportHere={importHere}
            onUndoImport={undoImport}
            onImportNew={(d) => new Promise<void>((resolve) => guardLeave(() => void importAndOpen(d, open.folder).then(resolve)))}
            onOpenImportDialog={() => setDlg({ k: 'import' })}
            onLootFilter={() => { setLfStart('build'); setArea('filter'); }}
            {...(timelinesEnabled() ? { onSendToTimeline: () => void sendOpenToTimeline() } : {})}
            onOpenCommunity={(c) => void openCommunity(c)}
            onOpenWealth={() => { wealth.go('watch'); setArea('wealth'); }}
            onReveal={() => void window.pom.lib.reveal()}
            onCopyCode={() => void copyOpenCode()}
            onHistory={openHistory}
            onOpenSettings={() => setDlg({ k: 'settings' })}
            onOpenAbout={() => setDlg({ k: 'about' })}
            onCheckUpdate={() => void checkUpdate()}
            settings={settings}
            onPatchSettings={appearance}
            onXml={onEngineXml}
            onReplaceXml={replaceXml}
            onEngineEdited={engineEdited}
          />
          </ErrorBoundary>
        )}
        {area === 'wealth' && (
          <ErrorBoundary scope="area" label={tr('App.wealth')} back={{ label: tr('App.back_to_builds'), run: () => setArea('builds') }}>
          <WealthApp
            s={wealth}
            p={{
              build: premiumBuild,
              ...(open ? { openName: open.name } : {}),
              library: (listing?.builds ?? []).map((b) => ({ id: b.id, name: b.name, folder: b.folder })),
              onPickBuild: (id) => {
                if (!id) return setPickedBuild(null);
                void window.pom.lib.read(id).then((r) => r.ok && setPickedBuild({ key: 'lib:' + r.value.id, name: r.value.name, xml: r.value.xml, open: false }));
              },
              onEquip: async (edit) => (await onEdit(edit)).ok,
              onTryItem: async (itemText) => {
                const cur = openRef.current;
                if (!cur || cur.engine.state !== 'ready') return { error: tr('App.the_calculation_engine_has_not_3') };
                return tryStashItem((command, params) => window.pom.sendCommand(command, params as never) as never, cur.engine.summary.buildId, itemText);
              },
            }}
          />
          </ErrorBoundary>
        )}
        {area === 'filter' && (
          <ErrorBoundary scope="area" label={tr('App.loot_filter')} back={{ label: tr('App.back_to_builds'), run: () => setArea('builds') }}>
            <LootFilterArea startView={lfStart} onStarted={() => setLfStart(undefined)} build={open} onOpenBuild={open ? () => setArea('builds') : undefined} onOpenWealth={() => setArea('wealth')} slots={{ ctx: lfCtx, search: lfSearch }} onMode={setLfMode} />
          </ErrorBoundary>
        )}

        <MasteryAreas
          area={area}
          setArea={setArea}
          signedIn={acct.signedIn}
          aiAccess={entitlement.signedIn}
          accountId={acct.view?.auth.state === 'signedIn' || acct.view?.auth.state === 'restoring' ? acct.view.auth.user.id : null}
          signIn={() => setDlg({ k: 'signIn' })}
          requestAiAccess={() => undefined}
          followStarter={followStarter}
        />

        {dlg?.k === 'import' && <ImportDialog initialTab={dlg.tab} onClose={() => setDlg(null)} onOpenWealth={() => setArea('wealth')} {...(open && open.engine.state === 'ready' ? { currentXml: open.xml, onApplyHere: applyToOpen } : {})} onImport={(d) => new Promise<void>((resolve) => guardLeave(() => void importAndOpen(d, open ? open.folder : folder).then(resolve)))} />}
        {dlg?.k === 'newBuild' && <NewBuildDialog initialClass={dlg.cls} onCancel={() => setDlg(null)} onCreate={(c, n) => void createBuild(c, n)} />}
        {dlg?.k === 'newFolder' && <NameDialog title={tr('App.new_folder_2')} label={tr('App.enter_folder_name')} value="" confirmLabel={tr('App.create')} error={dlg.error} onCancel={() => setDlg(null)} onSubmit={(v) => void doNewFolder(dlg.parent, v)} />}
        {dlg?.k === 'rename' && <NameDialog title={tr('App.rename_build')} label={tr('App.enter_new_name')} value={dlg.entry.name} confirmLabel={tr('App.save')} icon="save" error={dlg.error} onCancel={() => setDlg(null)} onSubmit={(v) => void doRename(dlg.entry, v)} />}
        {dlg?.k === 'renameFolder' && <NameDialog title={tr('App.rename_folder')} label={tr('App.enter_new_name')} value={dlg.folder.name} confirmLabel={tr('App.save')} icon="save" error={dlg.error} onCancel={() => setDlg(null)} onSubmit={(v) => void doRenameFolder(dlg.folder, v)} />}
        {dlg?.k === 'deleteFolder' && (
          <ConfirmDialog
            tone="danger"
            title={tr('App.confirm_folder_delete')}
            body={<><div>{tr('App.the_folder_is_not_empty_2', { count: dlg.count })}.</div><div>{tr('App.are_you_sure_you_want')}</div><div style={{ color: 'var(--text-strong)', fontWeight: 600, padding: '4px 0' }}>{dlg.folder.name}</div><div>{tr('App.this_cannot_be_undone')}</div></>}
            confirmLabel={tr('App.delete')}
            onCancel={() => setDlg(null)}
            onConfirm={() => {
              const f = dlg.folder;
              setDlg(null);
              void window.pom.lib.folderDelete(f.path, true).then((r) => {
                if (!r.ok) toast({ text: fromMain('ml_io_errors', r.error), kind: 'error' });
                void refresh();
              });
            }}
          />
        )}
        {dlg?.k === 'move' && listing && <MoveDialog build={dlg.entry} folders={listing.folders} onCancel={() => setDlg(null)} onMove={(to) => void doMove(dlg.entry, to, false)} />}
        {dlg?.k === 'conflict' && (
          <ConfirmDialog icon="warning" title={tr('App.couldn_t_move_the_build_2')} subtitle={dlg.message} confirmLabel={tr('App.keep_both')} confirmIcon="files" onCancel={() => setDlg(null)} onConfirm={() => void doMove(dlg.entry, dlg.to, true)} body={tr('App.keep_both_moves_the_build')} />
        )}
        {dlg?.k === 'update' && <UpdateAvailableDialog offer={dlg.offer} busy={dlg.busy} error={dlg.error} onUpdate={() => void runUpdate(dlg.offer)} onLater={() => !dlg.busy && setDlg(null)} />}
        {dlg?.k === 'settingsPath' && (
          <SettingsPathDialog
            problem={dlg.problem}
            defaultPath={`${(info?.userDataDir ?? '').split('\\').join('/').replace(/\/+$/, '')}/Builds`}
            onDefault={() => void window.pom.lib.chooseBuildsDir(true).then(() => setDlg(null))}
            onChoose={async () => {
              const r = await window.pom.lib.chooseBuildsDir(false);
              if (!r.ok) {
                toast({ text: fromMain('ml_io_errors', r.error), kind: 'error' });
                return null;
              }
              if (r.value) setTimeout(() => void window.pom.lib.relaunch(), 600);
              return r.value;
            }}
          />
        )}
        {dlg?.k === 'saveError' && (
          <SaveFailedDialog
            path={dlg.path}
            error={dlg.error}
            busy={dlg.busy}
            exported={dlg.exported}
            onDismiss={() => setDlg(null)}
            onSaveAs={() => setDlg({ k: 'saveAs' })}
            onExport={() => void exportRecovery()}
            onRetry={() => {
              setDlg({ ...dlg, busy: true });
              void save().then((ok) => ok && setDlg(null));
            }}
          />
        )}
        {dlg?.k === 'saveAs' && open && listing && <SaveAsDialog name={open.name} folder={open.folder} folders={listing.folders} error={dlg.error} onCancel={() => setDlg(null)} onSave={(n, f) => void saveAs(n, f)} />}
        {dlg?.k === 'saveChanges' && open && (
          <ConfirmDialog
            icon="save"
            title={tr('App.save_changes')}
            body={<><div>{tr('App.this_build_has_unsaved_changes')}</div><div>{tr('App.do_you_want_to_save')}</div></>}
            confirmLabel={tr('App.save')}
            confirmIcon="save"
            altLabel={tr('App.don_t_save')}
            onCancel={() => setDlg(null)}
            onAlt={() => {
              const then = dlg.then;
              setDlg(null);
              then();
            }}
            onConfirm={() => {
              const then = dlg.then;
              void save().then((ok) => {
                if (ok) {
                  setDlg(null);
                  then();
                }
              });
            }}
          />
        )}
        {dlg?.k === 'shortcuts' && <ShortcutsDialog onClose={() => setDlg(null)} />}
        {dlg?.k === 'myPublished' && <MyPublishedDialog onClose={() => setDlg(null)} />}
        {dlg?.k === 'feedback' && <FeedbackDialog version={version} platform={info?.platform ?? ''} onClose={() => setDlg(null)} />}
        {dlg?.k === 'about' && <AboutDialog version={version} engineVersion={info?.engineVersion} interfaceVersion={info?.interfaceVersion} platform={info?.platform ?? ''} onClose={() => setDlg(null)} onOpenSite={() => void window.pom.app.openExternal('https://pathofmastery.gg')} onFeedback={() => setDlg({ k: 'feedback' })} />}
        {dlg?.k === 'info' && <InfoDialog title={dlg.title} body={dlg.body} onClose={() => setDlg(null)} />}
        {dlg?.k === 'signIn' && <SignInDialog onClose={() => setDlg(null)} />}
        {dlg?.k === 'connectClaude' && (
          <Dialog size="medium" title={tr('App.connect_an_ai_app')} cancelLabel={null} confirmLabel={tr('App.close')} confirmIcon="x" onCancel={() => setDlg(null)} onConfirm={() => setDlg(null)}>
            <div className="ap-dialog">
              <Connector />
            </div>
          </Dialog>
        )}
        {dlg?.k === 'account' && <AccountDialog localOnly={Math.max(0, (listing?.builds.length ?? 0) - Object.keys(acct.sync?.builds ?? {}).length)} onClose={() => setDlg(null)} />}
        {dlg?.k === 'syncConflict' && (() => {
          const c = acct.sync?.conflicts.find((x) => x.localId === dlg.id);
          return c ? <ConflictDialog conflict={c} onClose={() => setDlg(null)} /> : null;
        })()}
        {dlg?.k === 'history' && (
          <VersionHistoryDialog
            localId={dlg.id}
            name={dlg.name}
            onClose={() => setDlg(null)}
            onRestored={(id, copy) => {
              void refresh();
              if (!copy && openRef.current?.id === id) void openById(id);
              toast({ text: copy ? tr('App.restored_as_a_new_build') : tr('App.restored_it_uploads_as_a'), kind: 'ok' });
            }}
          />
        )}
        {dlg?.k === 'shared' && <SharedBuildDialog token={dlg.token} onClose={() => setDlg(null)} onOpen={(b) => void openShared(b)} />}
        {dlg?.k === 'trash' && (
          <TrashDialog
            items={dlg.items}
            onClose={() => setDlg(null)}
            onRestore={(t) => void window.pom.lib.restore(t.token).then(async (r) => {
              if (!r.ok) return void toast({ text: fromMain('ml_io_errors', r.error), kind: 'error' });
              await refresh();
              const left = await window.pom.lib.trashList();
              if (left.ok) setDlg({ k: 'trash', items: left.value });
              toast({ text: tr('App.restored_name', { name: r.value.name }), kind: 'ok' });
            })}
            onPurge={(t) => void window.pom.lib.trashPurge(t.token).then(async () => {
              const left = await window.pom.lib.trashList();
              if (left.ok) setDlg({ k: 'trash', items: left.value });
              void refresh();
            })}
            onEmpty={() => void window.pom.lib.trashPurge(null).then(() => { setDlg({ k: 'trash', items: [] }); void refresh(); })}
          />
        )}
        {dlg?.k === 'settings' && (
          <SettingsDialog
            initialSection={dlg.section}
            initialRow={dlg.row}
            settings={settings}
            info={info}
            version={version}
            signedIn={acct.signedIn}
            noAccounts={noAccounts}
            onPreview={preview}
            control={settingsCtl}
            navToken={dlg}
            onCancel={() => setDlgState(null)}
            onReveal={() => void window.pom.lib.reveal()}
            onCheckUpdate={() => void checkUpdate()}
            onConnectDesktop={() => { setDlgState(null); if (!requestConnector()) setDlgState({ k: 'connectClaude' }); }}
            onAccount={() => setDlgState({ k: 'account' })}
            onSignIn={() => setDlgState({ k: 'signIn' })}
            onSave={(changed) => {
              setDlgState(null);
              applyAppearance({ ...settings, ...changed });
              if (!Object.keys(changed).length) return;
              void update(changed).then((r) => {
                if (r.ok) return toast({ text: tr('App.settings_saved'), kind: 'ok', ttl: 2500 });
                applyAppearance(settings); // not saved: put the old look back
                toast({ text: tr('App.could_not_save_the_settings', { error: r.error }), kind: 'error' });
              });
            }}
          />
        )}
        {!ready && <div style={{ position: 'absolute', inset: 0, background: 'var(--surface-0)' }} />}
      </main>
    </div>
  );
}

function LaterArea({ eyebrow, title, body, icon, onBack }: { eyebrow: string; title: string; body: string; icon: string; onBack: () => void }) {
  return (
    <div style={{ position: 'absolute', inset: '52px 12px 12px' }}>
      <div className="panel" data-lg="panel">
        <div className="later">
          <Icon name={icon} size={28} style={{ color: 'var(--text-muted)' }} />
          <span className="eyebrow">{tr('App.eyebrow_not_built_yet', { eyebrow })}</span>
          <h2>{title}</h2>
          <p>{body}</p>
          <button type="button" className="btn gold" style={{ marginTop: 8 }} onClick={onBack}>
            <Icon name="tree" size={16} />
            {tr('App.back_to_builds')}
          </button>
        </div>
      </div>
    </div>
  );
}
