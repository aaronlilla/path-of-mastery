// The Tree tab: the WebGL passive tree with the engine behind it. Clicks, hover previews, masteries, class changes,
// search, Node Power, compare and Smart pathing. Every number on screen is the engine's.
import { getTreePreview, setTreePreview, useTreePreview } from './assistant/bus';
import { AssistantRings } from './tree/AssistantRings';
import { PreviewRings, PvNodeNote } from './tree/PreviewRings';
import { previewCall, usePreview } from './preview/preview';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { POWER_STATS, type BuildEdit, type NodePower, type StatDelta, type StatScalar, type TreeState } from '@pom/protocol';
import type { AppSettings } from '../shared/library.js';
import { CLASSES } from '../shared/buildXml';
import { autoLevelStep, convertSpecVersion, estimateLevel, readHeader, setActiveSpec, setBuildAttr, specTitle, type BuildHeader, type SpecInfo } from './buildSkills';
import { compareLines, displayStats, type CompareLine } from './displayStats';
import type { NumberFormat } from './displayStats';
import { normaliseOutput } from './displayStats';
import { engineSend, type EngineBuild } from './engineBuild';
import { artFor } from './gameArt';
import { HOVER_REST_MS, PassiveTreeView, type NodeHoverDetail, type PassiveTree } from './tree';
import type { JewelInfo } from './tree/treeTypes';
import { Dialog, Icon, PortalMenu, Select, Switch, useToast } from './ui';
import { TimelessDialog } from './timeless/TimelessDialog';
import { MasteryPicker } from './tree/MasteryPicker';
import { NodeTooltip } from './tree/NodeTooltip';
import { PowerReport } from './tree/PowerReport';
import { SearchEdge } from './tree/SearchEdge';
import { TattooDialog } from './tree/TattooDialog';
import { countedTattoos, tattooEligible, tattooTooltip, type Tattoo, type TattooTarget } from './tree/tattoos';
import { ResetTreeDialog, TreeConvertedDialog, UnknownVersionCard, type ConvertDrop } from './tree/TreeDialogs';
import { ConvertAllDialog, ManageTreesDialog } from './TreeSetsDialogs';
import { TreeSetSelect } from './TreeSetSelect';
import { ClassChangeDialog } from './HeaderClassMenu';
import { passiveMax } from '../shared/pointsReadout';
import { tr } from './i18n';

export interface TreeInfo {
  used: number;
  usedMax: number;
  asc: number;
  ascMax: number;
  level: number;
  act: number | 'Endgame';
  /** The tooltip over the points: quest points, extra skillpoints and the lab the level suggests. */
  questPoints: number;
  extraSkillpoints: number;
  lab: string;
  tooMany: string[];
}

export interface TreeTabProps {
  eng: EngineBuild;
  xml: string;
  header: BuildHeader | null;
  settings: AppSettings;
  fmt: NumberFormat;
  visible: boolean;
  onInfo(info: TreeInfo | null): void;
  onDeltas(d: Record<string, [StatScalar, StatScalar]> | null): void;
  /** Right click on an allocated jewel socket goes to the Items tab (upstream does the same). */
  onOpenItems(): void;
  /** The Find Timeless Jewel dialog's choices, saved in the build text like upstream's `TimelessData`. */
  onTimelessData(attrs: Record<string, string | undefined>): void;
}

const NODE_KIND = ['Normal', 'Notable', 'Keystone', 'Mastery', 'Socket', 'ClassStart', 'AscendClassStart'];

/** The Version dropdown's entries (written by scripts/build-tree-data.mjs from GameVersions.lua): fetched once. */
interface TreeVersionEntry {
  value: string;
  display: string;
}
let versionList: Promise<TreeVersionEntry[]> | null = null;
function loadVersionList(): Promise<TreeVersionEntry[]> {
  versionList ??= fetch('game/tree/versions.json').then((r) => (r.ok ? (r.json() as Promise<TreeVersionEntry[]>) : [])).catch(() => []);
  return versionList;
}
const LATEST_TREE_VERSION = '3_29';

/** Smart pathing: a node the player wants in the tree, or one the route must never use. */
type Mark = 'wanted' | 'avoided';

interface MasteryPick {
  id: number;
  detail: ReturnType<PassiveTree['masteryDetail']>;
}

/** How long an open tooltip waits for its stat lines (the engine answered in 14-46 ms on empty and full builds). */
const STAT_WAIT_MS = 200;
/** Long enough to reach the next node and hear back, so the sidebar's numbers change in place instead of blinking. */
const DELTA_HOLD_MS = 300;

/** Compare lines from the diff of a preview, against the stats the build has now (`pv`: the diff came from the preview
 * engine, so its own `before` values are the base). */
function linesFor(eng: EngineBuild, changed: StatDelta[], fmt: NumberFormat, nodeCount?: number, keepZero = false, pv = false): CompareLine[] {
  if (!changed.length) return [];
  const after = { ...eng.stats };
  const was = { ...eng.stats };
  for (const d of changed) {
    if (d.after === null) delete after[d.statId];
    else after[d.statId] = d.after;
    if (d.before === null) delete was[d.statId];
    else was[d.statId] = d.before;
  }
  // The tooltip's calculator has no `Spec:` outputs ("%Inc Life from Tree" and the like are only worked out for the sidebar), so those
  // rows never change there: leave them out of a tooltip, as upstream does.
  const list = keepZero ? displayStats.filter((d) => !d.stat?.startsWith('Spec:')) : undefined;
  const lines = compareLines(pv ? normaliseOutput(was) : eng.stats, normaliseOutput(after), eng.flags, fmt, list, nodeCount);
  // The tooltip prints every line upstream does; the mastery chips leave out a change that rounds to nothing ("+0%").
  return keepZero ? lines : lines.filter((l) => parseFloat(String(l.value).replace(/[,+\s]/g, '')) !== 0);
}

export function TreeTab(p: TreeTabProps) {
  const { eng, header } = p;
  const toast = useToast();
  const treeRef = useRef<PassiveTree | null>(null);
  const [ready, setReady] = useState(false);
  const [hover, setHover] = useState<NodeHoverDetail | null>(null);
  const [previewLines, setPreviewLines] = useState<CompareLine[] | null>(null);
  /** The second block of an allocated node's tooltip: unallocating the node and every node depending on it. */
  const [previewPathLines, setPreviewPathLines] = useState<CompareLine[] | null>(null);
  const [previewBlocked, setPreviewBlocked] = useState<string | null>(null);
  const previewSeq = useRef(0);
  const [search, setSearch] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const [mastery, setMastery] = useState<MasteryPick | null>(null);
  const masteryRef = useRef<MasteryPick | null>(null);
  masteryRef.current = mastery;
  const [classChange, setClassChange] = useState<{ nodeId: number; classId: number } | null>(null);
  const [timeless, setTimeless] = useState(false);
  const [resetAsk, setResetAsk] = useState(false);
  const [tattooAsk, setTattooAsk] = useState<{ id: number; target: TattooTarget; tattooed: boolean } | null>(null);
  const [tattoos, setTattoos] = useState<Tattoo[]>([]);
  const [shiftHeld, setShiftHeld] = useState(false);
  const [tipOn, setTipOn] = useState(() => {
    try {
      return localStorage.getItem('pom.treeTip') !== 'off';
    } catch {
      return true;
    }
  });
  const [compareOn, setCompareOn] = useState(false);
  const [compareSpec, setCompareSpec] = useState<number | null>(null);
  const [powerOn, setPowerOn] = useState(false);
  const [depth, setDepth] = useState<number | null>(null);
  const [powerStat, setPowerStat] = useState<string>('');
  const [customDepth, setCustomDepth] = useState(false);
  const [customDepthN, setCustomDepthN] = useState('20');
  /** Ctrl+D: the stat differences in the node tooltip (on until switched off, like upstream). */
  const [showDiff, setShowDiff] = useState(true);
  /** Ctrl held: the node tooltip stays hidden. */
  const [ctrlHeld, setCtrlHeld] = useState(false);
  // Settings > Off-screen search markers is the default; the Tools switch overrides it for this session.
  const [edgeCircles, setEdgeCircles] = useState(p.settings.offscreenMarkers);
  useEffect(() => setEdgeCircles(p.settings.offscreenMarkers), [p.settings.offscreenMarkers]);
  const hoverRef = useRef<NodeHoverDetail | null>(null);
  const tipTimer = useRef(0);
  const deltaTimer = useRef(0);
  const reopenUntil = useRef(0);
  const showDiffRef = useRef(true);
  // Preview on: the hover diff comes from the preview engine, on the build text as it is now.
  const pvOnRef = useRef(false);
  pvOnRef.current = usePreview().on;
  const xmlRef = useRef(p.xml);
  xmlRef.current = p.xml;
  showDiffRef.current = showDiff;
  const [power, setPower] = useState<{ nodes: NodePower[]; max: NonNullable<Awaited<ReturnType<typeof stepPower>>['max']> } | null>(null);
  const [powerProgress, setPowerProgress] = useState<number | null>(null);
  const [report, setReport] = useState(false);
  // Off by default; the last choice is kept like the tips switch.
  const [smart, setSmart] = useState(() => {
    try {
      return localStorage.getItem('pom.smartPathing') === 'on';
    } catch {
      return false;
    }
  });
  const [marks, setMarks] = useState<Map<number, Mark>>(() => new Map());
  const marksRef = useRef(marks);
  /** The marks of every build opened this session, so turning Smart pathing back on restores them. */
  const marksByBuild = useRef(new Map<string, Map<number, Mark>>());
  const solveQ = useRef<Promise<void>>(Promise.resolve());
  const engRef = useRef(eng);
  engRef.current = eng;

  const tree = eng.tree;
  // The build's own tree version: from the engine once it has answered, from the build text until then (so only that version loads).
  const version: string | null = tree?.treeVersion ?? header?.specs[(header.activeSpec || 1) - 1]?.treeVersion ?? null;
  // The older-tree bar follows the build text like the tree select's label does; the engine's tree lags a few frames behind it (and still holds the previous build's while a new one loads).
  const barVersion: string | null = header?.specs[(header.activeSpec || 1) - 1]?.treeVersion ?? version;
  const [versions, setVersions] = useState<TreeVersionEntry[]>([]);
  const [versionsLoaded, setVersionsLoaded] = useState(false);
  useEffect(() => {
    let live = true;
    void loadVersionList().then((l) => {
      if (!live) return;
      setVersions(l);
      setVersionsLoaded(true);
    });
    return () => {
      live = false;
    };
  }, []);
  // Until the list of versions is in nothing mounts; a version the app has no tree for gets a message instead of a failed load.
  const versionKnown = !version || (versionsLoaded && (versions.length === 0 || versions.some((v) => v.value === version)));
  const versionUnknown = !!version && versionsLoaded && versions.length > 0 && !versions.some((v) => v.value === version);
  const [convert, setConvert] = useState<{ version: string; busy: boolean } | null>(null);
  const [manage, setManage] = useState(false);
  const [convertAll, setConvertAll] = useState<string | null>(null);
  const displayOf = (v: string) => versions.find((x) => x.value === v)?.display ?? v.replace(/_/g, '.');
  // A new version is a new tree: the old one is torn down and the new one's art loads.
  useEffect(() => setReady(false), [version]);
  useEffect(() => {
    let live = true;
    setTattoos([]);
    // Tattoos came with 3.21; older trees have no such file to fetch.
    if (version && versionKnown && /^3_(\d+)/.test(version) && Number(/^3_(\d+)/.exec(version)![1]) >= 21) void fetch(`game/tree/${version}/tattoos.json`).then((r) => (r.ok ? (r.json() as Promise<Tattoo[]>) : [])).then((l) => live && setTattoos(l), () => undefined);
    return () => {
      live = false;
    };
  }, [version, versionKnown]);
  const jewelInfo = useMemo(() => tree?.jewelInfo as Record<number, JewelInfo> | undefined, [tree]);

  // The tree is framed inside the space the panels leave free (between sidebar, tab bar and toolbar).
  const measureInsets = useCallback((t: PassiveTree) => {
    const r = t.host.getBoundingClientRect();
    const side = document.querySelector('.bw-side')?.getBoundingClientRect();
    const tabs = document.querySelector('.bw-tabs')?.getBoundingClientRect();
    const dock = document.querySelector('.tt-dock')?.getBoundingClientRect();
    const ap = document.querySelector('.ap, .ap-rail')?.getBoundingClientRect();
    if (!r.width || !r.height) return;
    t.setInsets({ left: Math.max(0, (side?.right ?? r.left) - r.left), top: Math.max(0, (tabs?.bottom ?? r.top) - r.top), right: ap ? Math.max(0, r.right - ap.left) : 0, bottom: Math.max(0, r.bottom - (dock?.top ?? r.bottom)) });
  }, []);
  useEffect(() => {
    const t = treeRef.current;
    if (!t || !p.visible) return;
    const on = () => measureInsets(t);
    on();
    window.addEventListener('resize', on);
    const id = window.setTimeout(on, 400);
    return () => {
      window.removeEventListener('resize', on);
      clearTimeout(id);
    };
  }, [ready, p.visible, measureInsets, tree]);

  // ---- points, level and the header numbers ------------------------------------------------------------------------
  const info = useMemo<TreeInfo | null>(() => {
    const t = treeRef.current;
    if (!tree || !ready || !eng.ready || !t || !header) return null; // eng.ready: the old build's tree is not counted against the new build's header
    let used = 0;
    let asc = 0;
    for (const id of tree.allocated) {
      const n = t.nodeById(id);
      if (n && (n.t === 5 || n.t === 6)) continue;
      if (n?.asc) {
        if (!n.multipleChoice) asc++;
      } else used++; // cluster jewel nodes are not in the tree file and cost a point each
    }
    const extra = (eng.stats.ExtraPoints as number | undefined) ?? 0;
    // what the character has at its level, the same total the assistant counts, so the header and the tools never disagree
    const usedMax = passiveMax(extra, header.auto ? null : header.level);
    const est = estimateLevel(used, extra);
    const tooMany: string[] = [];
    if (used > passiveMax(extra, null)) tooMany.push(tr('TreeTab.you_have_too_many_passive'));
    if (asc > 8) tooMany.push(tr('TreeTab.you_have_too_many_ascendancy'));
    return { used, usedMax, asc, ascMax: 8, level: est.level, act: est.act, questPoints: est.questPoints, extraSkillpoints: est.extraSkillpoints, lab: est.lab, tooMany };
  }, [tree, ready, eng.ready, header, eng.stats]);
  useEffect(() => p.onInfo(info), [info]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto level: the level the points call for (upstream does this on every recalculation). Opening a build changes
  // nothing, and neither does an edit that leaves the level the points call for as it was (a Config switch, an item): the
  // level moves only when the points (or the extra points) do, so flipping a switch and back restores every number. An undo
  // or redo, and a build replaced by an import, take the level their text has.
  const autoBusy = useRef(false);
  const levelSettled = useRef<number | null>(null);
  useEffect(() => {
    if (!info) return;
    if (autoBusy.current && levelSettled.current !== null && levelSettled.current !== info.level) return;
    const step = autoLevelStep(levelSettled.current, info.level, { auto: !!header?.auto, stepping: eng.isStepping(), edited: eng.history.undo > 0, level: header?.level ?? 0 });
    levelSettled.current = step.settled;
    if (!step.apply) return;
    autoBusy.current = true;
    // The text the engine holds now decides: an import may have just switched the build to a manual level.
    void eng.editXml((x) => (readHeader(x)?.auto ? setBuildAttr(x, 'level', String(info.level)) : x), true).finally(() => {
      autoBusy.current = false;
    });
  }, [info, header?.auto, header?.level, eng.history.undo]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- edits ---------------------------------------------------------------------------------------------------------
  const runEdit = useCallback(
    async (edit: BuildEdit, label?: string) => {
      try {
        const r = await eng.edit(edit);
        return r;
      } catch (e) {
        toast({ text: tr('TreeTab.label_did_not_apply_v2', { label: label ?? tr('TreeTab.that_change'), value: e instanceof Error ? e.message : String(e) }), kind: 'error' });
        return null;
      }
    },
    [eng, toast],
  );

  const clickNode = useCallback(
    async (id: number) => {
      const r = await runEdit({ kind: 'clickNode', nodeId: id });
      if (!r) return;
      // The tree applies a click at once; a click the engine held back puts the engine's tree back.
      if (r.blocked && eng.tree) treeRef.current?.setState(eng.tree);
      if (r.blocked === 'PickMastery') {
        const t = treeRef.current;
        if (t) setMastery({ id, detail: t.masteryDetail(id) });
      } else if (r.blocked === 'OtherAscendancy' || (r.blocked === 'Nothing' && isOtherAscendancyNode(treeRef.current, id))) {
        // Upstream acts on a click on any node of another ascendancy, reachable or not (PassiveTreeView:OnKeyUp).
        const a = await runEdit({ kind: 'chooseAscendancy', nodeId: id });
        if (a?.blocked === 'ClassChange' && a.blockedClass !== undefined) setClassChange({ nodeId: id, classId: a.blockedClass });
      }
    },
    [runEdit],
  );

  /** What choosing a mastery effect changes in the calculation, for the picker's cards (null: nothing). */
  const masteryCalc = useCallback(
    async (effectId: number): Promise<string | null> => {
      const m = masteryRef.current;
      if (!m) return null;
      const r = await eng.preview({ kind: 'pickMastery', nodeId: m.id, effectId });
      if (r.blocked) return null;
      const l = linesFor(eng, r.changed, p.fmt).slice(0, 2);
      return l.length ? l.map((x) => `${x.value} ${x.label}${x.percent ?? ''}`).join(' · ') : null;
    },
    [eng, p.fmt], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // ---- hover preview -----------------------------------------------------------------------------------------------
  const closeTip = useCallback(() => {
    clearTimeout(tipTimer.current);
    setHover(null);
    setPreviewLines(null);
    setPreviewPathLines(null);
    setPreviewBlocked(null);
  }, []);
  /** The sidebar keeps its +N numbers until the next node's arrive; they only go when none come soon. */
  const fadeDeltas = useCallback(() => {
    if (deltaTimer.current) return;
    deltaTimer.current = window.setTimeout(() => {
      deltaTimer.current = 0;
      p.onDeltas(null);
    }, DELTA_HOLD_MS);
  }, [p.onDeltas]); // eslint-disable-line react-hooks/exhaustive-deps
  const showDeltas = useCallback((dm: Record<string, [StatScalar, StatScalar]>) => {
    clearTimeout(deltaTimer.current);
    deltaTimer.current = 0;
    p.onDeltas(dm);
  }, [p.onDeltas]); // eslint-disable-line react-hooks/exhaustive-deps
  const onHover = useCallback(
    (d: NodeHoverDetail) => {
      hoverRef.current = d;
      const seq = ++previewSeq.current;
      closeTip();
      fadeDeltas();
      const open = () => {
        if (seq !== previewSeq.current) return;
        // It opens beside the pointer as it is now, which may have moved on inside the node during the wait.
        const shown = { ...d, ...treeRef.current?.pointerOn(d.id) };
        const n = d.node;
        const previewed = n.t !== 5 && n.t !== 6 && !(n.t === 3 && !d.alloc) && showDiffRef.current; // masteries are picked, not previewed as a click
        if (!previewed) {
          setHover(shown);
          return;
        }
        // The tooltip opens with its stat lines, so it never jumps when they arrive; a slow engine only holds it this long.
        tipTimer.current = window.setTimeout(() => setHover(shown), STAT_WAIT_MS);
        const show = () => {
          clearTimeout(tipTimer.current);
          setHover(shown);
        };
        // Shift tracing: the nodes walked over are the path, so the preview counts exactly those.
        const trace = treeRef.current?.traceMode && !d.alloc && d.path.length > 0;
        const pv = pvOnRef.current;
        const diff = (edit: BuildEdit) =>
          pv ? previewCall('previewEdit', xmlRef.current, { edit }).then(({ result: r }) => ({ blocked: r.blocked, changed: r.statDiff.changed })) : eng.preview(edit);
        if (d.alloc) {
          // Upstream's tooltip for an allocated node: the node taken out of the calculation alone, then (when others hang off it)
          // the node with everything depending on it, both through the calculator's `removeNodes` override (PassiveTreeView:AddNodeTooltip).
          const dependsOn = [d.id, ...d.dependents.filter((x) => x !== d.id)];
          const one = diff({ kind: 'removeNodes', nodeIds: [d.id] });
          const many = dependsOn.length > 1 ? diff({ kind: 'removeNodes', nodeIds: dependsOn }) : null;
          void Promise.all([one, many]).then(([a, b]) => {
            if (seq !== previewSeq.current) return;
            setPreviewLines(linesFor(eng, a.changed, p.fmt, undefined, true, pv));
            if (b) setPreviewPathLines(linesFor(eng, b.changed, p.fmt, dependsOn.length, true, pv));
            show();
            const dm: Record<string, [StatScalar, StatScalar]> = {};
            for (const c of (b ?? a).changed) dm[c.statId] = [c.before, c.after];
            showDeltas(dm);
            // The click that may follow reuses the engine's kept preview of the real unallocation, so it is made last.
            if (seq === previewSeq.current) void eng.preview({ kind: 'clickNode', nodeId: d.id }).catch(() => undefined);
          }).catch(() => { if (seq === previewSeq.current) show(); });
          return;
        }
        // Upstream's tooltip for an unallocated node: the node added alone, then (when the path is longer than the node)
        // the node with every node leading to it. The second one is the click, so it is asked for last and stays warm.
        const far = d.path.length > 1;
        const alone = far ? diff({ kind: 'addNodes', nodeIds: [d.id] }) : null;
        void Promise.all([alone, diff(trace ? { kind: 'addNodes', nodeIds: d.path } : { kind: 'clickNode', nodeId: d.id })]).then(([a, r]) => {
          if (seq !== previewSeq.current) return;
          show();
          if (r.blocked) {
            setPreviewBlocked(r.blocked);
            return;
          }
          if (a && !a.blocked) {
            setPreviewLines(linesFor(eng, a.changed, p.fmt, undefined, true, pv));
            setPreviewPathLines(linesFor(eng, r.changed, p.fmt, d.path.length, true, pv));
          } else setPreviewLines(linesFor(eng, r.changed, p.fmt, undefined, true, pv));
          const dm: Record<string, [StatScalar, StatScalar]> = {};
          for (const c of r.changed) dm[c.statId] = [c.before, c.after];
          showDeltas(dm);
        }).catch(() => { if (seq === previewSeq.current) show(); });
      };
      // A hover the pointer did not make (search focus, key walking), or the pointer still resting after a click, opens at once.
      if (d.cx === undefined || performance.now() < reopenUntil.current) open();
      else tipTimer.current = window.setTimeout(open, HOVER_REST_MS);
    },
    [eng, p.fmt, closeTip, fadeDeltas, showDeltas], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const onLeave = useCallback(() => {
    previewSeq.current++;
    hoverRef.current = null;
    closeTip();
    fadeDeltas();
  }, [closeTip, fadeDeltas]);
  useEffect(() => () => {
    clearTimeout(tipTimer.current);
    clearTimeout(deltaTimer.current);
  }, []);
  useEffect(() => {
    // A committed change makes the open tooltip stale: it is asked for again (upstream keeps the tooltip up after a
    // click, with the node's new state). Before, it was only closed and stayed closed until the pointer moved, so a click
    // looked as if nothing had happened. When the tree's state changed too, the tree re-hovers the node itself (its
    // `ready` callback is queued before this one); otherwise the node is sent again here.
    onLeave();
    clearTimeout(deltaTimer.current);
    deltaTimer.current = 0;
    p.onDeltas(null); // the numbers were for the build as it was
    reopenUntil.current = performance.now() + 500;
    const t = treeRef.current;
    if (t) void t.ready.then(() => { if (treeRef.current === t && !hoverRef.current) t.refreshHover(); });
  }, [eng.rev]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- search, compare, heat -----------------------------------------------------------------------------------------
  const compareState = useMemo<TreeState | null>(() => {
    if (!compareOn || !header || compareSpec === null) return null;
    const s = header.specs.find((x) => x.index === compareSpec);
    if (!s) return null;
    return specToState(s);
  }, [compareOn, compareSpec, header]);
  const searchInfo = useMemo(() => {
    const t = treeRef.current;
    if (!t || !search.trim()) return { found: 0, allocated: 0 };
    void ready;
    void tree;
    t.search = search;
    const r = t.searchResults();
    return { found: r.ids.length, allocated: r.allocated };
  }, [search, ready, tree]);
  const matchCount = searchInfo.found;
  const foundText = searchInfo.allocated > 0 ? tr('TreeTab.found_allocated', { matchCount, allocated: searchInfo.allocated }) : tr('TreeTab.matchcount_found', { matchCount });
  const foundTitle = tr('TreeTab.search_found_title', { matchCount, allocated: searchInfo.allocated });

  const heatMap = useMemo(() => {
    if (!powerOn || !power) return null;
    const out: Record<number, { offence: number; defence: number }> = {};
    const m = power.max;
    for (const n of power.nodes) {
      if (n.allocated) continue; // removal figures belong to the report only
      if (powerStat) out[n.id] = { offence: m.singleStat > 0 ? Math.max(n.single, 0) / m.singleStat : 0, defence: 0 };
      else out[n.id] = { offence: m.offence > 0 ? Math.max(n.offence, 0) / m.offence : 0, defence: m.defence > 0 ? Math.max(n.defence, 0) / m.defence : 0 };
    }
    return out;
  }, [powerOn, power, powerStat]);
  // Every edit restarts the ranking and empties `power` for a few seconds; the tree keeps the last heat meanwhile instead of flashing undarkened.
  const lastHeat = useRef<{ id: string | null; map: NonNullable<typeof heatMap> } | null>(null);
  if (!powerOn) lastHeat.current = null;
  else if (heatMap) lastHeat.current = { id: eng.buildId ?? null, map: heatMap };
  const heatShown = heatMap ?? (lastHeat.current?.id === (eng.buildId ?? null) ? lastHeat.current.map : null);

  // The distance limit: All, 5, 10, 15 or a number of the player's own (upstream's Custom).
  const effDepth = customDepth ? Math.max(1, Math.floor(Number(customDepthN) || 0)) || null : depth;
  // Node Power runs in steps off the click path and starts over after any change.
  useEffect(() => {
    setPower(null);
    if (!powerOn || !eng.buildId || !eng.ready) {
      setPowerProgress(null);
      return;
    }
    let alive = true;
    const id = eng.buildId;
    setPowerProgress(0);
    void (async () => {
      try {
        const { total } = await engineSend('nodePowerStart', { buildId: id, maxDepth: effDepth, stat: powerStat || null });
        void total;
        const nodes: NodePower[] = [];
        let restarts = 0;
        for (;;) {
          if (!alive) return;
          const s = await stepPower(id);
          if (!alive) return;
          if (!s.active) {
            // The engine dropped the run (the build changed under it): start it again once, then stop showing progress,
            // rather than leaving the report waiting for nodes that will not come.
            if (restarts++ > 0) {
              setPowerProgress(null);
              return;
            }
            nodes.length = 0;
            await engineSend('nodePowerStart', { buildId: id, maxDepth: effDepth, stat: powerStat || null });
            continue;
          }
          nodes.push(...s.nodes);
          setPowerProgress(s.progress);
          if (s.done) {
            setPower({ nodes, max: s.max! });
            setPowerProgress(null);
            return;
          }
          await new Promise((r) => setTimeout(r, 0));
        }
      } catch (e) {
        if (alive) {
          setPowerProgress(null);
          toast({ text: tr('TreeTab.node_power_could_not_be', { value: e instanceof Error ? e.message : String(e) }), kind: 'error' });
          setPowerOn(false);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [powerOn, effDepth, powerStat, eng.rev, eng.buildId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- smart pathing -----------------------------------------------------------------------------------------------------
  const putMarks = useCallback(
    (m: Map<number, Mark>) => {
      marksRef.current = m;
      setMarks(m);
      if (eng.buildId) marksByBuild.current.set(eng.buildId, m);
    },
    [eng.buildId],
  );
  useEffect(() => {
    const m = (eng.buildId && marksByBuild.current.get(eng.buildId)) || new Map<number, Mark>();
    marksRef.current = m;
    setMarks(m);
  }, [eng.buildId]);

  /** Re-routes the tree to the fewest points that reach every wanted node and never use an avoided one: one undo step. A
   * wanted node no route reaches leaves the tree as it is and puts the clicked node's mark back. */
  const reroute = useCallback(
    (clicked: number, before: Mark | undefined) => {
      const id = eng.buildId;
      if (!id) return;
      const name = (n: number) => treeRef.current?.nodeById(n)?.name ?? tr('TreeTab.that_node');
      solveQ.current = solveQ.current.then(async () => {
        const m = marksRef.current;
        const ids = (want: Mark) => [...m].filter(([, k]) => k === want).map(([n]) => n);
        try {
          const r = await engineSend('pathSolve', { buildId: id, wanted: ids('wanted'), avoided: ids('avoided') });
          if ('unreachable' in r) {
            const back = new Map(marksRef.current);
            if (before) back.set(clicked, before);
            else back.delete(clicked);
            putMarks(back);
            toast({ text: r.unreachable.includes(clicked) ? tr('TreeTab.clicked_cannot_be_reached_without', { clicked: name(clicked) }) : tr('TreeTab.clicked_can_only_be_reached', { clicked: name(r.unreachable[0] ?? clicked), clicked2: name(clicked) }), kind: 'error' });
            return;
          }
          const have = new Set(engRef.current.tree?.allocated ?? []);
          if (r.nodeIds.length === have.size && r.nodeIds.every((n) => have.has(n))) return;
          await runEdit({ kind: 'setNodes', nodeIds: r.nodeIds }, tr('TreeTab.smart_pathing'));
        } catch (e) {
          toast({ text: tr('TreeTab.smart_pathing_did_not_finish', { value: e instanceof Error ? e.message : String(e) }), kind: 'error' });
        }
      });
    },
    [eng.buildId, putMarks, runEdit, toast],
  );
  /** Main-tree passives only: masteries, ascendancy and cluster-jewel nodes keep their normal click. */
  const markable = (n: ReturnType<PassiveTree['nodeById']>) => !!n && [0, 1, 2, 4].includes(n.t) && !n.asc && !n.generated && n.id < 65536;
  const smartClick = (id: number): boolean => {
    if (!markable(treeRef.current?.nodeById(id))) return false;
    const m = new Map(marksRef.current);
    const before = m.get(id);
    if (before === undefined) m.set(id, 'wanted');
    else if (before === 'wanted') m.set(id, 'avoided');
    else m.delete(id);
    putMarks(m);
    reroute(id, before);
    return true;
  };
  const smartClear = (id: number): boolean => {
    const before = marksRef.current.get(id);
    if (!before) return false;
    const m = new Map(marksRef.current);
    m.delete(id);
    putMarks(m);
    reroute(id, before);
    return true;
  };
  const smartRef = useRef({ smartClick, smartClear });
  smartRef.current = { smartClick, smartClear };
  useEffect(() => {
    const t = treeRef.current;
    if (t) t.clickGate = smart ? (id) => smartRef.current.smartClick(id) : null;
  }, [smart, ready]);
  const toggleSmart = () => {
    try {
      localStorage.setItem('pom.smartPathing', smart ? 'off' : 'on');
    } catch { /* storage is optional */ }
    setSmart(!smart);
  };
  const marksOverlay = useMemo(() => {
    if (!smart || !marks.size) return null;
    const of = (want: Mark) => [...marks].filter(([, k]) => k === want).map(([n]) => n);
    return { added: of('wanted'), removed: of('avoided'), ringsOnly: true };
  }, [smart, marks]);

  const assistantPreview = useTreePreview();
  const previewRev = useRef(eng.rev);
  const overlay = assistantPreview ? { added: assistantPreview.added, removed: assistantPreview.removed } : marksOverlay;
  const previewKey = assistantPreview ? assistantPreview.proposalId : '';
  useEffect(() => {
    // Preview on tree: take the player to the changed nodes so the red and green rings are in view.
    if (!assistantPreview) return;
    const ids = [...assistantPreview.removed, ...assistantPreview.added];
    const go = () => treeRef.current?.frameNodes(ids);
    go();
    const t = window.setTimeout(go, 350); // the tab may only just have become visible
    return () => window.clearTimeout(t);
  }, [previewKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    // Any change to the build makes the suggestion's picture out of date.
    if (previewRev.current !== eng.rev) {
      previewRev.current = eng.rev;
      if (getTreePreview()) setTreePreview(null);
    }
  }, [eng.rev]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- keys -------------------------------------------------------------------------------------------------------------------
  const keyState = useRef({ header, powerOn, eng });
  keyState.current = { header, powerOn, eng };
  useEffect(() => {
    if (!p.visible) return;
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const t = e.target as HTMLElement | null;
      const typing = !!t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);
      const key = e.key.toLowerCase();
      const dialog = !!document.querySelector('.dialog, .tt-mastery');
      const treeView = treeRef.current;
      if (e.key === 'Control') setCtrlHeld(true);
      if (e.key === 'Shift') setShiftHeld(true);
      if (mod && key === 'f' && !e.shiftKey) {
        e.preventDefault();
        setSearchOpen(true);
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (mod && key === 'z' && !typing) {
        e.preventDefault();
        void (e.shiftKey ? eng.redo() : eng.undo());
      } else if (mod && key === 'y' && !typing) {
        e.preventDefault();
        void eng.redo();
      } else if (dialog || typing) {
        return;
      } else if (!mod && !e.altKey && key === 'p') {
        // P: the Node Power heat map, like the toolbar switch.
        e.preventDefault();
        setPowerOn((v) => !v);
      } else if (mod && key === 'd') {
        e.preventDefault();
        setShowDiff((v) => !v);
      } else if (mod && key === 'c') {
        // Ctrl+C over a node copies its name and text (not for jewel sockets, as in upstream).
        const h = hoverRef.current;
        if (h && h.node.t !== 4 && !window.getSelection()?.toString()) {
          e.preventDefault();
          void navigator.clipboard.writeText(`# ${h.node.n}\n${h.node.s.join('\n')}\n`).then(() => toast({ text: tr('TreeTab.node_text_copied'), kind: 'ok' }));
        }
      } else if (e.key === 'PageUp' || e.key === 'PageDown') {
        e.preventDefault();
        treeView?.zoomBy((e.key === 'PageUp' ? 1 : -1) * (e.shiftKey ? 3 : 1));
      } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !mod && !e.shiftKey && !e.altKey) {
        // Up and Down switch the tree set, unless an open menu or the focused tree has its own use for them.
        if (t?.closest('[role="listbox"], [role="menu"], .tt-canvas, button[aria-haspopup]')) return;
        const h = keyState.current.header;
        const idx = (h?.activeSpec ?? 1) + (e.key === 'ArrowUp' ? -1 : 1);
        if (h?.specs.some((s) => s.index === idx)) {
          e.preventDefault();
          void keyState.current.eng.editXml((x) => setActiveSpec(x, idx));
        }
      } else if (mod && e.key.toLowerCase() === 'm' && !e.shiftKey && !e.altKey && !document.querySelector('.dialog')) {
        e.preventDefault();
        setManage(true);
      }
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.key === 'Control') setCtrlHeld(false);
      if (e.key === 'Shift') setShiftHeld(false);
    };
    const onBlur = () => {
      setCtrlHeld(false);
      setShiftHeld(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [p.visible, eng]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- tree version conversion --------------------------------------------------------------------------------------------------
  const [converted, setConverted] = useState<{ display: string; dropped: ConvertDrop | null } | null>(null);
  /** The latest version with the old tree's own suffix (a ruthless tree stays ruthless). */
  const latestFor = (v: string) => LATEST_TREE_VERSION + (v.match(/^\d+_\d+(_[a-z]+_?[a-z]*)$/)?.[1] ?? '');
  /** What the new tree dropped from `before`, counted the way the header counts points (the class start is free, ascendancy nodes have their own count). */
  const droppedSince = async (before: Array<[number, 'point' | 'asc' | 'free']>): Promise<ConvertDrop | null> => {
    if (!eng.buildId) return null;
    try {
      const t = await engineSend('treeState', { buildId: eng.buildId });
      const now = new Set(t.tree.allocated);
      const gone = before.filter(([id]) => !now.has(id));
      return { points: gone.filter(([, k]) => k === 'point').length, ascendancy: gone.filter(([, k]) => k === 'asc').length, pointsBefore: before.filter(([, k]) => k === 'point').length };
    } catch {
      return null;
    }
  };
  const convertTo = async (to: string, copy: boolean) => {
    setConvert((c) => (c ? { ...c, busy: true } : c));
    const old = treeRef.current;
    const before: Array<[number, 'point' | 'asc' | 'free']> = (eng.tree?.allocated ?? []).map((id) => {
      const n = old?.nodeById(id);
      return [id, !n || n.t === 5 || n.t === 6 ? 'free' : n.asc ? 'asc' : 'point'];
    });
    try {
      await eng.editXml((x) => convertSpecVersion(x, activeSpec, to, copy));
      setConverted({ display: displayOf(to), dropped: await droppedSince(before) });
    } catch (e) {
      toast({ text: tr('TreeTab.converting_the_tree_did_not', { value: e instanceof Error ? e.message : String(e) }), kind: 'error' });
    } finally {
      setConvert(null);
    }
  };
  // ---- test hooks (the app driver reads these; nothing in the UI uses them) -----------------------------------------------------
  useEffect(() => {
    (window as unknown as { __pomTree?: unknown }).__pomTree = { get tree() { return treeRef.current; }, eng, clickNode, hover };
  });

  // ---- render -----------------------------------------------------------------------------------------------------------------------
  const specs = header?.specs ?? [];
  const activeSpec = header?.activeSpec ?? 1;

  // Node Power off closes the report. On keeps the stat (Offence/Defence by default, as upstream does); "Show Power Report" opens it.
  useEffect(() => {
    if (!powerOn) setReport(false);
  }, [powerOn]);

  // What the compare legend counts: nodes only in one of the two trees, and masteries or jewels that differ.
  const compareCounts = useMemo(() => {
    if (!compareState || !tree) return null;
    const mine = new Set(tree.allocated);
    const theirs = new Set(compareState.allocated);
    const real = (id: number) => {
      const n = treeRef.current?.nodeById(id);
      return !n || (n.t !== 5 && n.t !== 6);
    };
    const onlyThere = compareState.allocated.filter((id) => !mine.has(id) && real(id)).length;
    const onlyHere = tree.allocated.filter((id) => !theirs.has(id) && real(id)).length;
    const myMast = new Map(tree.masteries);
    const myJewel = new Map(tree.jewels);
    let differ = 0;
    for (const [id, eff] of compareState.masteries) if (myMast.has(id) && myMast.get(id) !== eff) differ++;
    for (const [id, item] of compareState.jewels) if (myJewel.has(id) && myJewel.get(id) !== item) differ++;
    return { onlyThere, onlyHere, differ };
  }, [compareState, tree, ready]);
  const compareName = (() => {
    const s = specs.find((x) => x.index === compareSpec);
    return s ? specTitle(s) : '';
  })();
  const activeName = (() => {
    const s = specs.find((x) => x.index === activeSpec);
    return s ? specTitle(s) : tr('TreeTab_2.this_tree');
  })();

  // ---- toolbar stages (RESPONSIVE.md: by the toolbar's own width) ----------------------------------------------------
  const dockRef = useRef<HTMLDivElement>(null);
  const [dockW, setDockW] = useState(1500);
  useEffect(() => {
    const el = dockRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setDockW(el.clientWidth));
    ro.observe(el);
    setDockW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  // 0: everything inline (from 1400 px), 1: tools menu, 2: search icon, 3: icons only.
  const stage = dockW >= 1400 ? 0 : dockW >= 900 ? 1 : dockW >= 640 ? 2 : 3;
  const [toolsOpen, setToolsOpen] = useState(false);
  const toolsBtn = useRef<HTMLButtonElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const activeTools = (compareOn ? 1 : 0) + (powerOn ? 1 : 0);

  // Like any popover: a press outside closes the compact search and the Power Report, and Escape does too. A press that
  // lands on the tree only closes the report; it must not also pan or allocate (the host never sees that pointerdown).
  useEffect(() => {
    if (!(searchOpen || (report && powerOn)) || !p.visible) return;
    const inside = (t: Element | null, sel: string) => !!t?.closest(sel);
    const down = (e: PointerEvent) => {
      const t = e.target instanceof Element ? e.target : null;
      if (inside(t, '.menu.portal, [role="dialog"]')) return;
      if (searchOpen && !inside(t, '.tt-search.wide')) setSearchOpen(false);
      if (report && powerOn && !inside(t, '.tt-report, .tt-dock')) {
        setReport(false);
        if (e.button === 0 && treeRef.current?.host.contains(t)) {
          e.stopPropagation();
        }
      }
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('[role="dialog"][aria-modal="true"], .menu.portal, .tt-mp')) return;
      if (searchOpen) setSearchOpen(false);
      else setReport(false);
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key);
    };
  }, [searchOpen, report, powerOn, p.visible]);

  const specField = (
    <div className="tt-field tt-spec">
      <span className="cap">{tr('TreeTab.tree')}</span>
      <TreeSetSelect eng={eng} xml={p.xml} level={header?.level ?? 100} fmt={p.fmt} width={stage >= 3 ? '100%' : 150} onManage={() => { setToolsOpen(false); setManage(true); }} />
    </div>
  );
  const oldBarOn = !!(barVersion && versionKnown && !barVersion.startsWith(LATEST_TREE_VERSION));
  // With the older-tree bar showing, the first-click hint stacks above it inside the bottom column instead of floating over the bar's buttons.
  const hintEl = tipOn && tree && tree.allocated.length < 3 && (
    <div className={'tt-hint' + (oldBarOn ? ' stacked' : '')} role="status">
      <Icon name="tree" size={15} />
      <span>{tr('TreeTab.click_a_node_to_allocate')}</span>
      <button type="button" className="btn ghost sm" onClick={() => { setTipOn(false); try { localStorage.setItem('pom.treeTip', 'off'); } catch { /* storage is optional */ } }}><Icon name="eye-off" size={14} />{tr('TreeTab.turn_off_tips')}</button>
      <button type="button" className="icon-btn" aria-label={tr('TreeTab.close')} onClick={() => setTipOn(false)}><Icon name="x" size={14} /></button>
    </div>
  );
  const versionField = (
    <div className="tt-field tt-ver">
      <span className="cap">{tr('TreeTab.version')}</span>
      <Select
        ariaLabel={tr('TreeTab.tree_version')}
        value={version ?? ''}
        options={versions.length ? [...versions.map((v) => ({ value: v.value, label: v.display })), ...(version && versionUnknown ? [{ value: version, label: displayOf(version) }] : [])] : version ? [{ value: version, label: displayOf(version) }] : []}
        width={stage >= 3 ? '100%' : 92}
        onChange={(v) => v !== version && setConvert({ version: v, busy: false })}
      />
    </div>
  );
  const edgeCtl = (
    <label className="tt-sw" title={tr('TreeTab.show_search_circles_at_viewport')}>
      <Switch checked={edgeCircles} label={tr('TreeTab.show_search_circles_at_viewport')} onChange={setEdgeCircles} />
      {tr('TreeTab.edge_circles')}
    </label>
  );
  const compareCtl = (
    <>
      <label className="tt-sw">
        <Switch checked={compareOn} label={tr('TreeTab.compare')} onChange={(v) => {
          setCompareOn(v);
          if (v && compareSpec === null) setCompareSpec(specs.find((s) => s.index !== activeSpec)?.index ?? null);
        }} />
        {tr('TreeTab.compare')}
      </label>
      {compareOn && (
        <div className="tt-field tt-cmp">
          <span className="cap">{tr('TreeTab.compare_with')}</span>
          <Select ariaLabel={tr('TreeTab.compare_with_2')} value={String(compareSpec ?? '')} options={specs.filter((s) => s.index !== activeSpec).map((s) => ({ value: String(s.index), label: specTitle(s), hint: tr('TreeTab.length_pts', { count: s.nodes.length }) }))} width={stage > 0 ? '100%' : 150} onChange={(v) => setCompareSpec(Number(v))} />
        </div>
      )}
    </>
  );
  const resetCtl = (
    <button type="button" className="btn" data-lg="control" aria-haspopup="dialog" onClick={() => { setToolsOpen(false); setResetAsk(true); }}>
      <Icon name="reset" size={15} />
      {tr('TreeTab.reset_tree_tattoos')}
    </button>
  );
  const timelessBtn = (
    <button type="button" className="btn" data-lg="control" onClick={() => { setToolsOpen(false); setTimeless(true); }}>
      <Icon name="jewel-socket" size={15} />
      {tr('TreeTab.find_timeless_jewel')}
    </button>
  );
  const powerSw = (
    <label className="tt-sw pw" title={tr('TreeTab.node_power_p')}>
      <Switch checked={powerOn} label={tr('TreeTab.node_power')} onChange={setPowerOn} />
      {(stage !== 2 || dockW >= 720) && tr('TreeTab.node_power')}
      {powerProgress !== null && !(report && powerOn) && <span className="tt-prog" title={tr('TreeTab.calculating_node_power')}>{powerProgress}%</span>}
    </label>
  );
  const powerDepth = (
    <>
      <div className={'seg' + (powerOn ? '' : ' off tt-seg-off')} data-lg="tile" role="group" aria-label={tr('TreeTab.node_power_depth')} title={tr('TreeTab.limit_of_node_distance_to')}>
        {([[null, tr('TreeTab_2.all')], [5, '5'], [10, '10'], [15, '15']] as Array<[number | null, string]>).map(([v, l]) => (
          <button key={l} type="button" aria-pressed={!customDepth && depth === v} aria-disabled={!powerOn || undefined} onClick={() => { if (!powerOn) return; setCustomDepth(false); setDepth(v); }}>{l}</button>
        ))}
        {powerOn && <button type="button" aria-pressed={customDepth} onClick={() => setCustomDepth(true)}>{tr('TreeTab.custom')}</button>}
      </div>
      {powerOn && customDepth && (
        <input className="tt-num" type="number" min={1} step={1} value={customDepthN} onChange={(e) => setCustomDepthN(e.target.value)} aria-label={tr('TreeTab.custom_node_power_distance')} title={tr('TreeTab.nodes_further_than_this_many')} />
      )}
    </>
  );
  const powerCtl = (<>{powerSw}{powerOn && powerDepth}</>);
  const powerMore = (
    <>
      <Select ariaLabel={tr('TreeTab.node_power_stat')} value={powerStat} options={[{ value: '', label: tr('TreeTab.offence_defence') }, ...POWER_STATS.map((s) => ({ value: s.stat, label: s.label }))]} width={stage > 0 ? '100%' : 150} onChange={setPowerStat} />
      <button type="button" className="btn sm" data-lg="control" onClick={() => { setToolsOpen(false); setReport((v) => !v); }}>{report ? tr('TreeTab.hide_power_report') : tr('TreeTab.show_power_report')}</button>
    </>
  );

  const shiftSocketHide = shiftHeld && hover?.node.t === 4;
  const nodeTip = hover && !mastery && !ctrlHeld && !shiftSocketHide ? (
    <NodeTooltip
      d={hover}
      lines={previewLines}
      pathLines={previewPathLines}
      blocked={previewBlocked}
      host={treeRef.current?.host}
      tree={treeRef.current}
      jewel={jewelInfo}
      eng={eng}
      xml={p.xml}
      showDiff={showDiff}
      traceMode={!!treeRef.current?.traceMode}
      level={header?.level ?? 1}
      extra={<PvNodeNote id={hover.id} alloc={hover.alloc} eng={eng} xml={p.xml} />}
    />
  ) : null;
  const searchHelp = tr('TreeTab.search_the_tree_ctrl_f');

  return (
    <div className="tt" style={{ display: p.visible ? undefined : 'none' }} data-screen-label="Tree / Tab / Content">
      <div
        className="tt-canvas"
        tabIndex={0}
        role="application"
        aria-label={tr('TreeTab.passive_skill_tree_arrow_keys')}
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={(e) => {
          const t = treeRef.current;
          if (!t || e.ctrlKey || e.metaKey || e.altKey) return;
          const dir: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
          if (dir[e.key]) {
            e.preventDefault();
            t.stepHover(...dir[e.key]!);
          } else if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            t.activateHover();
          } else if (e.key === 'Escape') t.setHover(null);
        }}
      >
        {version && versionKnown && <PassiveTreeView
          key={version}
          base={`game/tree/${version}/`}
          state={tree}
          compare={compareState}
          search={search}
          overlay={overlay}
          heat={powerOn && !!heatShown}
          heatSingle={!!powerStat}
          heatTheme={p.settings.nodePowerColours}
          power={heatShown}
          jewelInfo={jewelInfo}
          autoApply
          masteryPicker
          fit="alloc"
          minFitScale={0.14}
          maxDpr={2}
          onReady={(t) => {
            treeRef.current = t;
            measureInsets(t);
            setReady(true);
          }}
          onNodeHover={onHover}
          onNodeLeave={onLeave}
          onNodeClick={(d) => {
            const w = window as unknown as { __pomClickT0?: number; __pomClickHover?: boolean };
            w.__pomClickT0 = performance.now();
            w.__pomClickHover = previewLines !== null;
            if (d.node.t === 3 && !d.alloc) {
              w.__pomClickT0 = 0;
              return; // the tree emits masteryclick next
            }
            if (d.trace) {
              // A Shift-traced path is allocated exactly as walked.
              void runEdit({ kind: 'setNodes', nodeIds: [...new Set([...(eng.tree?.allocated ?? []), ...d.trace])] }, tr('TreeTab.the_traced_path'));
              return;
            }
            void clickNode(d.id);
          }}
          onNodeRightClick={(d) => {
            const t = treeRef.current;
            if (!t) return;
            if (smart && smartClear(d.id)) return;
            const base = t.nodeById(d.id);
            const target: TattooTarget | null = base ? { name: base.name, type: NODE_KIND[base.t] ?? '', firstStat: base.stats[0] ?? '', linked: base.linked.length } : null;
            const tattooed = !!t.overrides.get(d.id)?.tattoo;
            if (d.node.t === 4 && d.alloc) p.onOpenItems();
            else if (target && base && tattoos.length && tattooEligible({ ...target, tattooed, unallocatedMastery: d.node.t === 3 && !d.alloc && !!d.node.me })) setTattooAsk({ id: d.id, target, tattooed });
            else if (d.node.t === 3 && d.alloc && d.node.me) setMastery({ id: d.id, detail: t.masteryDetail(d.id) });
          }}
          onMasteryClick={(d) => setMastery({ id: d.id, detail: d })}
        />}
        <SearchEdge tree={ready ? treeRef.current : null} on={edgeCircles} search={search} />
        <AssistantRings tree={ready ? treeRef.current : null} />
        <PreviewRings tree={ready ? treeRef.current : null} />
        {nodeTip}
        {versionUnknown && version && <UnknownVersionCard version={version} />}
        {eng.error && <div className="tt-card tt-old" role="alert"><b>{tr('TreeTab.the_engine_could_not_read')}</b><span>{eng.error}</span></div>}
        {!oldBarOn && hintEl}
      </div>

      <div className="tt-bottom">
        {oldBarOn && hintEl}
        {oldBarOn && barVersion && (
          <div className="tt-bar tt-oldbar" role="status" title={tr('TreeTab.this_is_an_older_tree')}>
            <i className="dot" />
            <span className="grow">{tr('TreeTab.old_tree_line', { from: displayOf(barVersion), to: displayOf(latestFor(barVersion)) })}</span>
            <button type="button" className="btn" data-lg="control" onClick={() => setConvert({ version: latestFor(barVersion), busy: false })}>
              <Icon name="refresh" size={15} />{tr('TreeTab.convert_to_barversion', { barVersion: displayOf(latestFor(barVersion)) })}
            </button>
            <button type="button" className="btn ghost" data-lg="control" onClick={() => setConvertAll(latestFor(barVersion))}>
              {tr('TreeTab.convert_all_trees_to_latest', { LATEST_TREE_VERSION: displayOf(LATEST_TREE_VERSION) })}
            </button>
          </div>
        )}
        {compareOn && compareState && compareCounts && (
          <div className="tt-bar tt-legend" role="status">
            <span className="lg"><i className="g" />{tr('TreeTab.only_in_comparename_v4_onlythere', { compareName, value: '·', onlyThere: compareCounts.onlyThere })}</span>
            <span className="lg"><i className="r" />{tr('TreeTab.only_in_activename_v4_onlyhere', { activeName, value: '·', onlyHere: compareCounts.onlyHere })}</span>
            {compareCounts.differ > 0 && <span className="lg"><i className="b" />{tr('TreeTab.different_mastery_or_jewel_v2', { value: '·', differ: compareCounts.differ })}</span>}
          </div>
        )}

        {report && powerOn && <PowerReport progress={powerProgress} nodes={power?.nodes ?? null} tree={treeRef.current} stat={powerStat} depthLabel={customDepth ? String(effDepth ?? tr('TreeTab_2.all')) : depth === null ? tr('TreeTab.all') : String(depth)} fmt={p.fmt} onStat={setPowerStat} onFocus={(id) => treeRef.current?.focusNode(id)} onHide={() => setReport(false)} />}

        <div className="tt-dock" data-lg="panel" ref={dockRef} data-stage={stage} data-search={searchOpen && stage >= 2 ? 1 : undefined} data-narrow={stage <= 1 && (compareOn || powerOn) ? 1 : undefined}>
          {searchOpen && stage >= 2 && (
            <div className="tt-search wide">
              <Icon name="search" size={15} />
              <input ref={searchRef} autoFocus value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setSearchOpen(false); } }} placeholder={tr('TreeTab.search_the_tree')} title={searchHelp} aria-label={tr('TreeTab.search_the_tree')} spellCheck={false} />
              {search ? <span className="n" title={foundTitle}>{foundText}</span> : null}
              <button type="button" className="icon-btn" aria-label={tr('TreeTab.close_search')} onClick={() => setSearchOpen(false)}><Icon name="x" size={14} /></button>
            </div>
          )}
          {/* The toolbar stays mounted under the open search (hidden by CSS): remounting its glass controls made them re-filter and flash. */}
          {(
            <>
              {stage < 3 && specField}
              {stage === 0 && (<>{compareCtl}{resetCtl}</>)}
              {stage < 3 && versionField}
              {stage < 2 ? (
                <div className="tt-search" title={searchHelp}>
                  <Icon name="search" size={15} />
                  <input ref={searchRef} value={search} onChange={(e) => setSearch(e.target.value)} placeholder={tr('TreeTab.search_the_tree')} title={searchHelp} aria-label={tr('TreeTab.search_the_tree')} spellCheck={false} />
                  {search ? <span className="n" title={foundTitle}>{foundText}</span> : <kbd className="k">Ctrl F</kbd>}
                </div>
              ) : (
                <button type="button" className="btn icon" data-lg="control" aria-label={tr('TreeTab.search_the_tree')} aria-pressed={!!search.trim()} title={search.trim() ? foundTitle : searchHelp} onClick={() => setSearchOpen(true)}>
                  <Icon name="search" size={15} />
                  {search.trim() ? <span className="tt-sn">{matchCount}</span> : null}
                </button>
              )}
              {stage === 0 && search.trim() && edgeCtl}
              {stage === 0 && timelessBtn}
              {stage === 0 ? powerCtl : powerSw}
              {stage === 0 && powerOn && !report && powerMore}
              {stage > 0 && (
                <>
                  <button ref={toolsBtn} type="button" className={'btn' + (stage >= 3 ? ' icon' : '')} data-lg="control" aria-haspopup="menu" aria-expanded={toolsOpen} aria-label={tr('TreeTab.tools')} title={tr('TreeTab.tools_compare_node_power_depth')} onClick={() => setToolsOpen((v) => !v)}>
                    <Icon name="sliders" size={15} />
                    {stage < 3 && tr('TreeTab.tools')}
                    {activeTools > 0 && <span className="tools-n">{activeTools}</span>}
                  </button>
                  <PortalMenu anchor={toolsBtn} open={toolsOpen} onClose={() => setToolsOpen(false)} label={tr('TreeTab.tools')} minWidth={322} align="right" className="tt-toolsmenu">
                    <div className="tt-tools-pane">
                      {stage >= 3 && (<>{specField}{versionField}</>)}
                      {stage >= 3 && <div className="tt-sep" />}
                      {compareCtl}
                      {edgeCtl}
                      <div className="tt-trow"><span className="tt-lbl">{tr('TreeTab.node_power_range')}</span>{powerDepth}</div>
                      {powerOn && !report && powerMore}
                      <div className="tt-sep" />
                      <button type="button" role="menuitem" className="menu-item" onClick={() => { setToolsOpen(false); setTimeless(true); }}>
                        <Icon name="jewel-socket" size={14} /><span className="grow">{tr('TreeTab.find_timeless_jewel_v2', { value: '\u2026' })}</span>
                      </button>
                      <button type="button" role="menuitem" className="menu-item danger" aria-haspopup="dialog" onClick={() => { setToolsOpen(false); setResetAsk(true); }}>
                        <Icon name="reset" size={14} /><span className="grow">{tr('TreeTab.reset_tree_tattoos')}</span>
                      </button>
                    </div>
                  </PortalMenu>
                </>
              )}
              <span className="grow" />
              <div className="tt-split">
                <button type="button" className={'btn lg' + (stage >= 3 ? ' icon' : '')} aria-pressed={smart} aria-label={tr('TreeTab.smart_pathing')} title={tr('TreeTab.on_click_a_node_to')} onClick={toggleSmart}>
                  <Icon name="path" size={15} />{stage < 3 && tr('TreeTab.smart_pathing')}
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {mastery && (
        <MasteryPicker
          detail={mastery.detail}
          host={treeRef.current?.host}
          tree={treeRef.current}
          calc={masteryCalc}
          onClose={() => setMastery(null)}
          onChoose={(effectId) => {
            const id = mastery.id;
            setMastery(null);
            void runEdit({ kind: 'pickMastery', nodeId: id, effectId }, tr('TreeTab.the_mastery_effect'));
          }}
          onRemove={() => {
            const id = mastery.id;
            setMastery(null);
            void runEdit({ kind: 'clickNode', nodeId: id }, tr('TreeTab.removing_the_mastery'));
          }}
        />
      )}

      {classChange && (
        <ClassChangeDialog
          className={CLASSES.find((c) => c.classId === classChange.classId)?.name ?? tr('TreeTab_2.the_new_class')}
          onCancel={() => setClassChange(null)}
          onContinue={() => {
            const c = classChange;
            setClassChange(null);
            void runEdit({ kind: 'chooseAscendancy', nodeId: c.nodeId, confirm: 'reset' }, tr('TreeTab.the_class_change'));
          }}
          onConnect={() => {
            const c = classChange;
            setClassChange(null);
            void runEdit({ kind: 'chooseAscendancy', nodeId: c.nodeId, confirm: 'connect' }, tr('TreeTab.connecting_the_path'));
          }}
        />
      )}

      {convert && (
        <Dialog
          icon="warning"
          title={tr('TreeTab.convert_to_version_version', { version: displayOf(convert.version) })}
          confirmLabel={tr('TreeTab.convert')}
          altLabel={tr('TreeTab.copy_convert')}
          confirmBusy={convert.busy}
          onCancel={() => setConvert(null)}
          onConfirm={() => void convertTo(convert.version, false)}
          onAlt={() => void convertTo(convert.version, true)}
        >
          <p style={{ margin: 0, color: 'var(--text)', lineHeight: 1.5 }}>
            {tr('TreeTab.warning_some_or_all_of')}
            <br />{tr('TreeTab.convert_will_replace_your_current')}
          </p>
        </Dialog>
      )}
      {converted && <TreeConvertedDialog display={converted.display} dropped={converted.dropped} onClose={() => setConverted(null)} onUndo={() => { setConverted(null); void eng.undo(); }} />}
      {tattooAsk && (
        <TattooDialog
          all={tattoos}
          node={tattooAsk.target}
          tattooed={tattooAsk.tattooed}
          count={countedTattoos(tree?.changed ?? []).length}
          countTip={tattooTooltip(tree?.changed ?? [])}
          onCancel={() => setTattooAsk(null)}
          onAdd={(tt) => {
            const a = tattooAsk;
            setTattooAsk(null);
            void runEdit({ kind: 'setTattoo', nodeId: a.id, tattoo: tt.key }, tr('TreeTab.the_tattoo')).then((r) => r && toast({ text: r.blocked ? tr('TreeTab.name_already_has_dn', { name: a.target.name, dn: tt.dn }) : tr('TreeTab.dn_added_undo_with_ctrl', { dn: tt.dn }), kind: r.blocked ? 'info' : 'ok' }));
          }}
          onReset={() => {
            const a = tattooAsk;
            setTattooAsk(null);
            void runEdit({ kind: 'setTattoo', nodeId: a.id, tattoo: null }, tr('TreeTab.the_node_reset')).then((r) => r && toast({ text: r.blocked ? tr('TreeTab.that_node_has_no_tattoo') : tr('TreeTab.node_reset_undo_with_ctrl'), kind: r.blocked ? 'info' : 'ok' }));
          }}
        />
      )}
      {resetAsk && (
        <ResetTreeDialog
          tattoos={tree?.changed.filter((c) => c.tattoo).length ?? 0}
          onCancel={() => setResetAsk(false)}
          onReset={() => { setResetAsk(false); void runEdit({ kind: 'resetTree' }, 'Reset Tree').then((r) => r && toast({ text: tr('TreeTab.tree_reset_undo_with_ctrl'), kind: 'ok' })); }}
          onRemoveTattoos={() => { setResetAsk(false); void runEdit({ kind: 'resetTattoos' }, 'Remove All Tattoos').then((r) => r && toast({ text: tr('TreeTab.tattoos_removed_undo_with_ctrl'), kind: 'ok' })); }}
        />
      )}

      {manage && <ManageTreesDialog eng={eng} xml={p.xml} onClose={() => setManage(false)} />}
      {convertAll && <ConvertAllDialog eng={eng} version={convertAll} display={displayOf(convertAll)} known={versions.map((v) => v.value)} onClose={() => setConvertAll(null)} />}

      {timeless && <TimelessDialog eng={eng} fmt={p.fmt} xml={p.xml} onSave={p.onTimelessData} onClose={() => setTimeless(false)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------------------

/** A node of an ascendancy the tree has not taken (the engine holds a click on one back as "nothing" when no path reaches it). */
function isOtherAscendancyNode(t: PassiveTree | null, id: number): boolean {
  const n = t?.nodeById(id);
  return !!t && !!n?.asc && n.t !== 6 && !t.alloc.has(id);
}

async function stepPower(buildId: string) {
  return engineSend('nodePowerStep', { buildId, budgetMs: 40 });
}

function specToState(s: SpecInfo): TreeState {
  return { treeVersion: s.treeVersion, classId: s.classId, ascendClassId: s.ascendClassId, secondaryAscendClassId: s.secondaryAscendClassId, allocated: s.nodes, masteries: s.masteries, jewels: s.jewels, generated: [], changed: [], sockets: [] };
}

