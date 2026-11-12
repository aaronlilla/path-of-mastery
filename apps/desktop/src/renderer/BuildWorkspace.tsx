import './ambientLight';
import { useTimelessRecalc } from './timeless/useTimelessTables';
import type { StatDelta, StatScalar } from '@pom/protocol';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createDeltaStore } from './deltaStore';
import { Freeze } from './Freeze';
import type { AppInfo, AppSettings, DecodedImport } from '../shared/library.js';
import { baseClassOf } from '../shared/buildXml';
import { convertSpecVersion, readHeader, setBuildAttr } from './buildSkills';
import { DEFAULT_NUMBER_FORMAT, type NumberFormat } from './displayStats';
import { engineSend, useEngineBuild } from './engineBuild';
import { usePublishBuildSearch } from './search/buildSource';
import type { ApplyXml, Confirm } from './CharacterImport';
import { Sidebar } from './Sidebar';
import { PreviewSwitch, PreviewTag } from './preview/PreviewControls';
import { HeaderPoints } from './PointsMeter';
import { TreeTab, type TreeInfo } from './TreeTab';
import { ConfigTab } from './ConfigTab';
import type { EngineHandle } from './engineHandle';
import { SkillsTab } from './SkillsTab';
import { compactNumber, exactNumber, folderLabel } from './format';
import { AssistantDock } from './assistant/AssistantPanel';
import { ImportExportTab } from './ImportExportTab';
import { loadCatalog } from './items/engine';
import { ItemsTab } from './items/ItemsTab';
import { usePrerank } from './items/prerank';
import { headerStage, nameNeedsRow } from '../shared/treeUi';
import { BuildMoreMenu } from './BuildMoreMenu';
import { PublishDialog, SimilarBuildsDialog } from './community';
import type { CommunityBuild } from '../shared/community.js';
import { NotesTab } from './NotesTab';
import { LevelingTab } from './leveling/LevelingTab';
import { CompareTab } from './CompareTab';
import { CalcsTab } from './calcs/CalcsTab';
import { FightTab } from './fight/FightTab';
import { PartyTab } from './PartyTab';
import type { EditResult, OpenBuild, TabId } from './types';
import type { BuildEdit } from '@pom/protocol';
import { Icon, Dialog, useToast } from './ui';
import { HeaderClassMenu } from './HeaderClassMenu';
import { BuildOpenGates } from './BuildOpenGates';
import { ErrorBoundary } from './ErrorBoundary';
import { useTreeBundled } from './treeVersions';
import { SharePopover } from './accounts/SharePopover';
import { useAcct } from './accounts/useAccount';
import { copyCredit } from '../shared/buildCredit';
import { TABS, tabVisible } from './buildTabs';
import { tr } from './i18n';

export { TABS };

export interface BuildWorkspaceProps {
  build: OpenBuild;
  engine: EngineHandle | null;
  tab: TabId;
  onTab: (t: TabId) => void;
  appInfo: AppInfo | null;
  version: string;
  dirty: boolean;
  /** A new build that was never saved: the header says so until the first save. */
  notSaved?: boolean;
  /** The bottom bar's save result: 'Saved on this PC', 'Saving...' or 'Save failed'; null while there are unsaved edits. */
  saveStatus?: string | null;
  onBack: () => void;
  /** Closes the build without asking to save (the version questions on opening: nothing was changed to save). */
  onDiscard: () => void;
  onSave: () => void;
  /** Saves now; the saved build's id, or null when nothing was saved (the assistant saves a never-saved build before its first question). */
  saveNow?: () => Promise<string | null>;
  onSaveAs: () => void;
  /** Opens the New build dialog (Ctrl N). */
  onNewBuild: () => void;
  onRename: (name: string) => void;
  onNotes: (text: string) => void;
  onTimelessData: (attrs: Record<string, string | undefined>) => void;
  onEdit: (e: BuildEdit) => Promise<EditResult>;
  onUndo: () => Promise<EditResult>;
  onImportHere: (d: DecodedImport) => void;
  /** Puts the build back as it was before the last Import to this build; false when there is nothing to undo. */
  onUndoImport: () => boolean;
  onImportNew: (d: DecodedImport) => Promise<void>;
  onOpenImportDialog: () => void;
  onLootFilter: () => void;
  /** Freezes this build as a Timeline source and opens the Send to timeline dialog. */
  onSendToTimeline?: () => void;
  /** Opens a community build as a new local build. */
  onOpenCommunity: (b: CommunityBuild) => void;
  /** Opens Wealth on its Upgrade watch (the Items tab's Trade for upgrades). */
  onOpenWealth?: () => void;
  onReveal: () => void;
  onCopyCode: () => void;
  /** Opens Version history for this build. */
  onHistory: () => void;
  onOpenSettings: () => void;
  onOpenAbout: () => void;
  onCheckUpdate: () => void;
  /** Told whether the header hides its folder line (narrow widths), so the title bar crumb can carry it then. */
  onPathHidden?: (hidden: boolean) => void;
  settings: AppSettings;
  /** Saves a change to the settings (the sidebar's section order and pinned stats). */
  onPatchSettings: (patch: Partial<AppSettings>) => void;
  /** The build text after an engine edit (the engine already holds it). */
  onXml: (xml: string) => void;
  /** Replaces the open build's text and loads it into the engine again (used to convert an unsupported tree version). */
  onReplaceXml: (xml: string) => void;
  /** An edit the engine applied to the open build: its new text and the stats it changed. */
  onEngineEdited: (xml: string, changed: StatDelta[]) => void;
}

/** The engine's reason in plain words: a tree version this app has no data for is said as that. */
function unavailableNote(reason: string): string {
  const m = /tree_([0-9]+_[0-9]+(?:_[a-z_]+)?)\.json/.exec(reason);
  return m ? tr('BuildWorkspace.it_uses_passive_tree_version', { value: m[1]!.replace(/_/g, '.') }) : reason;
}

// A kept tab shown again with the same build, engine and format has nothing new to draw, so it does not render again.
const ConfigTabM = memo(ConfigTab);
const SkillsTabM = memo(SkillsTab);
const CalcsTabM = memo(CalcsTab);
const FightTabM = memo(FightTab);

/** A tab's name in the player's language; buildTabs.ts keeps the English label for ids this map lacks. */
function tabLabel(id: string, fallback: string): string {
  const m: Record<string, string> = { tree: tr('BuildWorkspace.tab_tree'), skills: tr('BuildWorkspace.tab_skills'), items: tr('BuildWorkspace.tab_items'), calcs: tr('BuildWorkspace.tab_calcs'), config: tr('BuildWorkspace.tab_config'), compare: tr('BuildWorkspace.tab_compare'), party: tr('BuildWorkspace.tab_party'), notes: tr('BuildWorkspace.tab_notes'), leveling: tr('BuildWorkspace.tab_leveling') };
  return m[id] ?? fallback;
}

export function BuildWorkspace(p: BuildWorkspaceProps) {
  const { build } = p;
  // Compare keeps what was loaded into it while other tabs are open.
  const visitedCompare = useRef(false);
  if (p.tab === 'compare') visitedCompare.current = true;
  // The tabs opened for this build stay mounted, frozen while hidden (see Freeze).
  const visited = useRef<{ build: string; tabs: Set<string> }>({ build: build.id, tabs: new Set() });
  if (visited.current.build !== build.id) visited.current = { build: build.id, tabs: new Set() };
  visited.current.tabs.add(p.tab);
  const keep = (id: string, label: string, node: ReactNode) =>
    visited.current.tabs.has(id) ? (
      <Freeze key={id} freeze={p.tab !== id}>
        <ErrorBoundary scope="tab" label={label} resetKey={build.id}>
          {node}
        </ErrorBoundary>
      </Freeze>
    ) : null;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(build.name);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => setDraft(build.name), [build.name]);
  useEffect(() => {
    if (editing) {
      input.current?.focus();
      input.current?.select();
    }
  }, [editing]);
  const commit = () => {
    setEditing(false);
    const v = draft.trim();
    if (v && v !== build.name) p.onRename(v);
    else setDraft(build.name);
  };
  const cls = baseClassOf(build.info).toLowerCase() || 'scion';
  const acct = useAcct();
  const [shareOpen, setShareOpen] = useState(false);
  const [comparePick, setComparePick] = useState(0);
  const moreBtn = useRef<HTMLButtonElement>(null);
  // The header's stage by its own width, as the design steps it: wide (0, 1) keeps Save As and the share link in the header, narrower moves them into More.
  const topRef = useRef<HTMLDivElement>(null);
  const [topW, setTopW] = useState(1844);
  useEffect(() => {
    const el = topRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setTopW(el.offsetWidth));
    ro.observe(el);
    setTopW(el.offsetWidth);
    return () => ro.disconnect();
  }, []);
  // A longer language can leave the name or its "current build" line cut off: when the header measures that, it steps to the next
  // stage (labels into the More menu) until the text fits; a new width or name starts again from the width's own stage.
  const [squeeze, setSqueeze] = useState(0);
  const hs = Math.min(4, headerStage(topW) + squeeze) as 0 | 1 | 2 | 3 | 4;
  // A name too long for the header's line goes on a row of its own; the header is as tall as that row needs (buttons 46, gaps 16).
  const nameRow = nameNeedsRow(build.name, topW);
  const pathHidden = nameRow || hs >= 2;
  const pathHiddenRef = useRef(p.onPathHidden);
  pathHiddenRef.current = p.onPathHidden;
  useEffect(() => pathHiddenRef.current?.(pathHidden), [pathHidden]);
  useEffect(() => () => pathHiddenRef.current?.(false), []);
  const nameRef = useRef<HTMLDivElement>(null);
  useEffect(() => setSqueeze(0), [topW, build.name]);
  useLayoutEffect(() => {
    const el = nameRef.current;
    if (!el || nameRow || hs >= 4) return;
    const cut = (n: Element | null) => n instanceof HTMLElement && n.scrollWidth > n.clientWidth + 1;
    if (cut(el.querySelector('.t')) || cut(el.querySelector('.path'))) setSqueeze((q) => q + 1);
  });
  const [nameH, setNameH] = useState(0);
  useEffect(() => {
    const el = nameRef.current;
    if (!nameRow || !el) return;
    const ro = new ResizeObserver(() => setNameH(el.offsetHeight));
    ro.observe(el);
    setNameH(el.offsetHeight);
    return () => ro.disconnect();
  }, [nameRow]);
  const eng = useEngineBuild(build, p.onXml);
  const toast = useToast();
  /** A yes/no question for the Import tab (its own dialog would be clipped by the tab's container). */
  const [ask, setAsk] = useState<{ title: string; body: string; confirmLabel: string; resolve: (v: boolean) => void } | null>(null);
  const confirm: Confirm = (spec) => new Promise<boolean>((resolve) => setAsk({ ...spec, resolve }));
  /** Puts a new build text on the open build as one undoable engine edit, computed from the engine's latest text. */
  const applyXml: ApplyXml = async (fn, toastText) => {
    const e = engRef.current;
    if (!e.buildId) {
      toast({ text: tr('BuildWorkspace.the_calculation_engine_has_not'), kind: 'error' });
      return false;
    }
    try {
      // Read, change and write back as one queued step (no other change can land in between).
      const out = await e.editXml(fn);
      if (out.blocked) throw new Error(tr('BuildWorkspace_2.the_build_text_was_refused'));
      if (toastText) toast({ text: toastText, kind: 'ok', action: { label: tr('BuildWorkspace.undo'), run: () => void engRef.current.undo() } });
      return true;
    } catch (err) {
      toast({ text: tr('BuildWorkspace.could_not_apply_that_err', { err: err instanceof Error ? err.message : String(err) }), kind: 'error' });
      return false;
    }
  };
  const [similarOpen, setSimilarOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [cmpInbox, setCmpInbox] = useState<{ key: number; xml: string; label: string } | null>(null);
  /** Import to this build: asks first, then replaces everything (as one undo step). */
  const importHere = async (d: DecodedImport) => {
    const ok = await confirm({ title: tr('BuildWorkspace.build_import'), body: tr('BuildWorkspace.warning_importing_to_the_current'), confirmLabel: tr('BuildWorkspace.import') });
    if (!ok) return;
    if (!engRef.current.buildId) return p.onImportHere(d);
    await applyXml(async () => d.xml, tr('BuildWorkspace.imported_into_this_build_press'));
  };
  useTimelessRecalc(eng);
  // The item lists take a couple of seconds to build the first time: start while the build is being looked at, so the Items tab opens with them.
  const engineReady = build.engine.state === 'ready';
  useEffect(() => {
    if (!engineReady) return;
    const t = window.setTimeout(() => void loadCatalog().catch(() => undefined), 600);
    return () => window.clearTimeout(t);
  }, [engineReady]);
  // The Items tab's list is ranked in the background once the build is left alone for a moment, so it opens sorted.
  usePrerank(build);
  const header = useMemo(() => readHeader(build.xml), [build.xml]);
  const fmt: NumberFormat = useMemo(() => ({ ...DEFAULT_NUMBER_FORMAT, thousands: p.settings.thousandsSeparators, compact: p.settings.compactNumbers, thousandsSeparator: p.settings.thousandsSeparator, decimalSeparator: p.settings.decimalSeparator }), [p.settings.thousandsSeparators, p.settings.compactNumbers, p.settings.thousandsSeparator, p.settings.decimalSeparator]);
  usePublishBuildSearch(build.id, build.xml, eng, header, fmt);
  // Another tab (Compare, Party, Items) changed the build through the engine: take its numbers and tree.
  useEffect(() => {
    const strip = (x: string) => x.replace(/<Notes>[\s\S]*?<\/Notes>/, '').replace(/[ \t]*<TimelessData\b[^>]*?\/>[ \t]*\r?\n?/, '');
    const k = eng.knownXml();
    if (k !== null && eng.ready && strip(build.xml) !== strip(k)) void eng.resync();
  }, [build.xml]); // eslint-disable-line react-hooks/exhaustive-deps
  const spec = header?.specs[(header?.activeSpec ?? 1) - 1];
  const treeVersion = spec?.treeVersion ?? '';
  const bundled = useTreeBundled(treeVersion || null);
  const treeUnknown = bundled === false;
  const engineDown = build.engine.state === 'unavailable' ? build.engine.reason : null;
  const problem = treeUnknown || engineDown ? (
          <div className="tabroot" data-screen-label="Tree / Tab / Cannot open">
            <div className="panel" data-lg="panel">
              <div className="later" role="alert">
                <Icon name="warning" size={28} style={{ color: 'var(--negative-text)' }} />
                <span className="eyebrow">{treeUnknown ? tr('BuildWorkspace.passive_tree_version_not_available') : tr('BuildWorkspace.calculation_engine_could_not_open')}</span>
                <h2>{treeUnknown ? tr('BuildWorkspace.this_build_uses_passive_tree', { treeVersion: treeVersion.replace('_', '.') }) : tr('BuildWorkspace.this_build_could_not_be')}</h2>
                <p>
                  {treeUnknown
                    ? tr('BuildWorkspace_2.path_of_mastery_has_no_tree')
                    : tr('BuildWorkspace.the_engine_said_enginedown', { engineDown })}
                </p>
                <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
                  {treeUnknown && (
                    <button type="button" className="btn gold" onClick={() => p.onReplaceXml(convertSpecVersion(build.xml, header?.activeSpec ?? 1, '3_29', false))}>
                      <Icon name="refresh" size={16} />
                      {tr('BuildWorkspace.convert_to_3_29')}
                    </button>
                  )}
                  <button type="button" className="btn" data-lg="control" onClick={p.onBack}>
                    {tr('BuildWorkspace.back_to_the_library')}
                  </button>
                </div>
              </div>
            </div>
          </div>
        
  ) : null;
  // Ctrl Z / Ctrl Y on every tab (the Tree, Items and Configuration tabs also have their own): the engine's undo steps,
  // and after "Import to this build" (a new engine session with no steps) the build as it was before the import.
  const engRef = useRef(eng);
  engRef.current = eng;
  const tabRef = useRef(p.tab);
  tabRef.current = p.tab;
  const undoImportRef = useRef(p.onUndoImport);
  undoImportRef.current = p.onUndoImport;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k !== 'z' && k !== 'y') return;
      const t = e.target as HTMLElement | null;
      if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const en = engRef.current;
      const ownKeys = ['tree', 'items', 'config'].includes(tabRef.current);
      const redo = k === 'y' || e.shiftKey;
      if (!redo && en.history.undo === 0) {
        if (undoImportRef.current()) e.preventDefault();
        return;
      }
      if (ownKeys) return;
      // Nothing to redo in the engine: leave the key to the page (a Notes edit redoes natively).
      if (redo && en.history.redo === 0) return;
      e.preventDefault();
      void (redo ? en.redo() : en.undo());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // Narrow window: the stats drawer opens from the rail's button and closes on Escape or a press outside it.
  const [drawer, setDrawer] = useState(false);
  useEffect(() => {
    if (!drawer) return;
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setDrawer(false);
    const down = (e: PointerEvent) => !(e.target as HTMLElement).closest('.bw-side, .menu.portal') && setDrawer(false);
    window.addEventListener('keydown', key);
    window.addEventListener('pointerdown', down, true);
    return () => {
      window.removeEventListener('keydown', key);
      window.removeEventListener('pointerdown', down, true);
    };
  }, [drawer]);
  const [treeInfo, setTreeInfo] = useState<TreeInfo | null>(null);
  // The tree reports null while a build loads; the header keeps the last points until the new ones arrive.
  const keepTreeInfo = useCallback((i: TreeInfo | null) => { if (i) setTreeInfo(i); }, []);
  // A build with no tree to show (version missing, engine down, engine could not read it) never reports, so drop the previous build's points.
  const noTree = !!problem || !!eng.error;
  const shownInfo = noTree ? null : treeInfo;
  useEffect(() => { if (noTree) setTreeInfo(null); }, [noTree]);
  // The design's key light and dust over the tree (ambient-light.js), mounted once per workspace.
  const lightRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (lightRef.current) window.PomLight?.mount(lightRef.current); }, []);
  const deltaStore = useMemo(createDeltaStore, []);
  const path = `${tr('areaGate.builds')}${build.folder ? ' / ' + folderLabel(build.folder).replace(/^Builds$/, '') : ''}`;
  // A copy of a Marketplace post keeps its source credit (first line of its notes).
  const credit = useMemo(() => copyCredit(build.xml), [build.xml]);

  return (
    <div className="bw" data-tab={p.tab} data-name-row={nameRow ? '' : undefined} {...(nameRow && nameH ? { style: { '--hh': `${62 + nameH}px` } as React.CSSProperties } : {})} data-screen-label="Build workspace">
      <div className="bw-bg" />
      <div className="bw-top" data-lg="panel" ref={topRef} data-hs={hs}>
        <div className="grp">
          <button type="button" className="btn icon bw-back" data-lg="control" title={tr('BuildWorkspace.library_ctrl_w')} aria-label={tr('BuildWorkspace.back_to_the_library')} onClick={p.onBack}>
            <Icon name="grid" size={16} />
          </button>
          <button type="button" className={'btn save' + (p.dirty || p.notSaved ? ' gold' : '')} title={tr('BuildWorkspace.save_ctrl_s')} aria-label={tr('BuildWorkspace.save')} onClick={p.onSave} style={{ gap: 10 }}>
            <Icon name="save" size={15} />
            <span className="t-save">{tr('BuildWorkspace.save')}</span>
          </button>
          <SharePopover anchor={moreBtn} open={shareOpen} onClose={() => setShareOpen(false)} localId={build.id} onCopyCode={p.onCopyCode} />
          {similarOpen && <SimilarBuildsDialog xml={build.xml} onOpen={(b) => { setSimilarOpen(false); p.onOpenCommunity(b); }} onClose={() => setSimilarOpen(false)} />}
          {publishOpen && <PublishDialog name={build.name} xml={build.xml} onClose={() => setPublishOpen(false)} />}
          <BuildMoreMenu
            stage={hs}
            auto={!!header?.auto}
            signedIn={acct.signedIn}
            btnRef={moreBtn}
            onNewBuild={p.onNewBuild}
            onSaveAs={p.onSaveAs}
            onShare={() => setShareOpen(true)}
            onSimilar={() => setSimilarOpen(true)}
            onCompare={() => { setComparePick((k) => k + 1); p.onTab('compare'); }}
            onHistory={p.onHistory}
            onLootFilter={p.onLootFilter}
            onPublish={() => setPublishOpen(true)}
            onAuto={(a) => void eng.editXml((x) => setBuildAttr(x, 'characterLevelAutoMode', a ? 'true' : 'false'))}
          />
          <div className="vr" />
          <div className="bw-name" ref={nameRef}>
            <span style={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
              <span className="path ellipsis" title={[p.notSaved ? '' : path, credit].filter(Boolean).join('\n')}>{[p.notSaved ? '' : path, credit].filter(Boolean).join(' · ') || ' '}</span>
              <PreviewTag />
            </span>
            <span className="line">
              {editing ? (
                <input
                  ref={input}
                  value={draft}
                  maxLength={120}
                  aria-label={tr('BuildWorkspace.build_name')}
                  spellCheck={false}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={commit}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commit();
                    else if (e.key === 'Escape') {
                      e.stopPropagation();
                      setDraft(build.name);
                      setEditing(false);
                    }
                  }}
                />
              ) : (
                <button type="button" className="nm" title={tr('BuildWorkspace.rename_click')} onClick={() => setEditing(true)}>
                  <span className="t" title={build.name}>{build.name}</span>
                  <Icon name="edit" size={13} />
                </button>
              )}
              {(p.dirty || p.notSaved) && (
                <span className="chip-unsaved" title={tr('BuildWorkspace.unsaved_changes')}>
                  <i />
                  {tr('BuildWorkspace.unsaved')}
                </span>
              )}
            </span>
          </div>
        </div>
        {header && (
          <div className="bw-points">
            <HeaderPoints info={shownInfo} />
          </div>
        )}
        <HeaderClassMenu build={build} header={header} eng={eng} xml={build.xml} />
      </div>

      <nav className="bw-tabs" aria-label={tr('BuildWorkspace.build_tabs')} data-screen-label="Build / Area bar">
        {TABS.map((t) => (
          <button key={t.id} type="button" className="tab" role="tab" aria-selected={p.tab === t.id} title={t.key ? `${tabLabel(t.id, t.label)} (${t.key})` : tabLabel(t.id, t.label)} aria-label={tabLabel(t.id, t.label)} onClick={() => p.onTab(t.id)}>
            <Icon name={t.icon} size={15} />
            <span className="lbl">{tabLabel(t.id, t.label)}</span>
          </button>
        ))}
        <button type="button" className="tab" role="tab" aria-selected={p.tab === 'import'} title={tr('BuildWorkspace.import_or_export_this_build')} aria-label={tr('BuildWorkspace.import')} onClick={() => p.onTab('import')}>
          <Icon name="import" size={15} />
          <span className="lbl">{tr('BuildWorkspace.import')}</span>
        </button>
        <span className="sp" />
        <PreviewSwitch />
        {p.onSendToTimeline && (
          <button type="button" className="tb-act" title={tr('BuildWorkspace.add_this_build_to_a')} aria-label={tr('BuildWorkspace.send_to_timeline')} onClick={p.onSendToTimeline}>
            <span className="full">{tr('BuildWorkspace.send_to_timeline')}</span>
            <span className="short">{tr('BuildWorkspace.timeline')}</span>
          </button>
        )}
      </nav>

      <aside className="bw-side" data-lg="panel" aria-label={tr('BuildWorkspace.build_stats')} data-drawer={drawer ? 'open' : 'closed'}>
        <ErrorBoundary scope="panel" label={tr('BuildWorkspace.the_stats_sidebar')} resetKey={build.id}>
        <Sidebar
          eng={eng}
          unavailable={build.engine.state === 'unavailable' ? unavailableNote(build.engine.reason) : undefined}
          fmt={fmt}
          deltas={deltaStore}
          groups={header?.groups ?? []}
          mainGroup={header?.mainSocketGroup ?? 1}
          mainActive={header?.mainActive ?? 1}
          onMainGroup={(n) => void eng.editXml((x) => setBuildAttr(x, 'mainSocketGroup', String(n)))}
          onMainActive={(g, n) => void eng.edit({ kind: 'setGroup', group: g, attr: 'mainActiveSkill', value: n })}
          extraWarnings={shownInfo?.tooMany ?? []}
          onOpenSkills={() => p.onTab('skills')}
          xml={build.xml}
          engine={p.engine}
          drawer={drawer}
          onDrawer={setDrawer}
          nav={{ tab: p.tab, onTab: (t) => p.onTab(t as TabId) }}
          statOrder={p.settings.statOrder}
          pinnedStats={p.settings.pinnedStats}
          onPatchSettings={p.onPatchSettings}
        />
        </ErrorBoundary>
        <div className="foot">
          <span className="save-status" role="status" data-state={p.saveStatus === tr('saveStatus.save_failed') ? 'failed' : undefined}>
            {p.saveStatus && (
              <>
                <span className="dot" />
                <span className="t" title={p.saveStatus}>{p.saveStatus}</span>
              </>
            )}
          </span>
          <button type="button" aria-label={tr('BuildWorkspace.about')} title={tr('BuildWorkspace.about')} onClick={p.onOpenAbout}>
            <Icon name="info" size={15} />
          </button>
          <span className="ver">{tr('BuildWorkspace.v_version', { version: p.version })}</span>
        </div>
      </aside>

      <div className="bw-tree" data-behind={p.tab === 'tree' ? undefined : ''} {...(p.tab !== 'tree' ? { inert: '' } : {})}>
        <ErrorBoundary scope="tab" label={tr('BuildWorkspace.tree')} resetKey={build.id}>
        {problem}
        {bundled !== null && !problem && <TreeTab eng={eng} xml={build.xml} header={header} settings={p.settings} fmt={fmt} visible={p.tab === 'tree'} onInfo={keepTreeInfo} onDeltas={deltaStore.set} onOpenItems={() => p.onTab('items')} onTimelessData={p.onTimelessData} />}
        </ErrorBoundary>
      </div>
      <div className="bw-light" ref={lightRef} aria-hidden />
      <div className="bw-main" style={{ display: p.tab === 'tree' ? 'none' : undefined }}>
        <ErrorBoundary scope="tab" label={TABS.find((t) => t.id === p.tab)?.label ?? tr('BuildWorkspace.import_export')} resetKey={p.tab + build.id}>
        {problem && p.tab !== 'notes' && p.tab !== 'import' && p.tab !== 'config' ? problem : null}
        {p.tab === 'notes' && <NotesTab buildId={build.id} xml={build.xml} rev={build.rev} onNotes={p.onNotes} />}
        {p.tab === 'leveling' && tabVisible('leveling') && <LevelingTab buildId={build.id} xml={build.xml} rev={build.rev} eng={eng} onOpenSkills={() => p.onTab('skills')} />}
        {p.tab === 'import' && (
          <ImportExportTab
            engineId={build.engine.state === 'ready' ? build.engine.summary.buildId : null}
            buildName={build.name}
            xml={build.xml}
            apply={applyXml}
            confirm={confirm}
            onImportHere={(d) => void importHere(d)}
            onImportNew={p.onImportNew}
            onImportCompare={(d) => {
              setCmpInbox({ key: Date.now(), xml: d.xml, label: d.name || [d.info.mainSkill, d.info.ascendClassName || d.info.className].filter(Boolean).join(' ') || tr('BuildWorkspace.imported_comparison') });
              p.onTab('compare');
            }}
            onOpenImportDialog={p.onOpenImportDialog}
            onOpenWealth={() => p.onOpenWealth?.()}
          />
        )}
        {!problem && (p.tab === 'compare' || visitedCompare.current) && (
          <div style={{ display: p.tab === 'compare' ? 'contents' : 'none' }}>
            <CompareTab
              xml={build.xml}
              saved={build.saved}
              buildId={build.id}
              buildName={build.name}
              engineId={build.engine.state === 'ready' ? build.engine.summary.buildId : null}
              statsVersion={build.engine.state === 'ready' ? build.engine.summary : null}
              onEdit={p.onEdit}
              onUndo={p.onUndo}
              inbox={cmpInbox}
              pickKey={comparePick}
            />
          </div>
        )}
        {!problem && keep('party', 'Party', <PartyTab xml={build.xml} ready={build.engine.state === 'ready'} onEdit={p.onEdit} onUndo={p.onUndo} />)}
        {!problem && keep('items', 'Items', <ItemsTab allAffixSliders={p.settings.allAffixSliders} build={build} onEdited={(xml, changed) => { eng.applyExternal(changed); p.onEngineEdited(xml, changed); }} goTab={p.onTab} eng={eng} onOpenWealth={p.onOpenWealth} />)}
        {(!problem || p.tab === 'config') && keep('config', 'Configuration', <ConfigTabM build={build} engine={p.engine} />)} {/* with the engine down the tab says so itself ("No configuration yet.") */}
        {!problem && keep('skills', 'Skills', <SkillsTabM build={build} engine={p.engine} />)}
        {!problem && keep('calcs', 'Calcs', <CalcsTabM build={build} engine={p.engine} fmt={fmt} />)}
        {!problem && keep('fight', 'Fight', <FightTabM build={build} engine={p.engine} fmt={fmt} />)}
        </ErrorBoundary>
      </div>
      <ErrorBoundary scope="panel" label={tr('BuildWorkspace.the_assistant')} resetKey={build.id} fallback={(retry) => (<button type="button" className="btn sm" style={{ position: 'absolute', right: 12, bottom: 12, zIndex: 5 }} onClick={retry}>{tr('BuildWorkspace.the_assistant_stopped_try_again')}</button>)}>
      <AssistantDock build={build} onTab={p.onTab} onEngineEdited={p.onEngineEdited} {...(p.notSaved && p.saveNow ? { saveFirst: p.saveNow } : {})} />
      </ErrorBoundary>
      <BuildOpenGates buildId={build.id} xml={build.xml} eng={eng} onClose={p.onDiscard} />
    {ask && (
      <Dialog
        icon="warning"
        title={ask.title}
        confirmLabel={ask.confirmLabel}
        onCancel={() => {
          ask.resolve(false);
          setAsk(null);
        }}
        onConfirm={() => {
          ask.resolve(true);
          setAsk(null);
        }}
      >
        <p style={{ margin: 0, color: 'var(--text)', lineHeight: 1.5 }}>{ask.body}</p>
      </Dialog>
    )}
    </div>
  );
}
