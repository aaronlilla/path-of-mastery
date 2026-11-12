import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { bundledTreeVersions, dotVersion } from './treeVersions';
import type { BuildEdit, CalcSectionOut, StatDiff, TreeState } from '@pom/protocol';
import {
  activeConfigOf,
  activeGroupsOf,
  activeSpecOf,
  equipped,
  loadoutsOf,
  loadoutXml,
  setActiveSetXml,
  readFacts,
  type BuildFacts,
  type ConfigValue,
} from '../shared/buildFacts.js';
import schemaJson from '../shared/configSchema.json';
import { DISPLAY_STATS, exactStat, formatStat, statDelta, statLines, toOut, type Out, type StatLine } from '../shared/displayStats.js';
import {
  configText,
  effectiveConfig,
  impactOf,
  itemSlots,
  normaliseConfig,
  planPower,
  POWER_CATEGORIES,
  POWER_STATS,
  powerRows,
  powerValue,
  type ConfigOption,
  type ConfigSchema,
  type PowerCategory,
  type PowerRow,
  type PowerStat,
  type PowerTask,
} from '../shared/comparePower.js';
import { artUrl, gemArtUrl, gemColour, isSupportGem, loadTreeNodes, RARITY_COLOUR, useGameInfo } from './gameData';
import { useReadImport } from './ImportDialog';
import { ImportCompareDialog, type CompareSource } from './compare/ImportDialogs';
import { PowerTable, type PowerSort } from './compare/PowerTable';
import { effectiveStat, fetchOut, measure } from './compare/measure';
import { CalcsView } from './compare/CalcsView';
import { ConfigView } from './compare/ConfigView';
import { ItemsView } from './compare/ItemsView';
import { SetBar, SetSelect } from './compare/SetBar';
import { ComparePick, type PickRow, type PickSection } from './compare/ComparePick';
import { reimportCharacter, useSelectedCharacter } from './compare/reimport';
import { TreeBar } from './compare/TreeBar';
import { useSide } from './compare/useSide';
import { loadTreeGraph } from './compare/treeGraph';
import { pathDistances } from '../shared/treePath.js';
import { skillKindOf } from './items/statCompare';
import { Art, CapSelect, CheckBox, Chips, SwitchRow, type CapOption } from './tabKit';
import type { EditResult } from './types';
import { PassiveTreeView, type TreeState as RenderTreeState } from './tree';
import { Icon, useToast } from './ui';
import type { TreeNodeInfo } from '../shared/library.js';
import type { VersionInfo } from '../shared/accounts.js';
import { label as lbl, tr } from './i18n';

const SCHEMA = schemaJson as ConfigSchema;

/** "Today 14:02", "Yesterday 23:18" or "Sep 26 09:30": when a saved version was made. */
function versionLabel(ms: number): string {
  const d = new Date(ms);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const day = (t: Date) => new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
  const gap = Math.round((day(new Date()) - day(d)) / 86_400_000);
  if (gap === 0) return tr('CompareTab.today_hm', { hm });
  if (gap === 1) return tr('CompareTab.yesterday_hm', { hm });
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${hm}`;
}

export interface CompareTabProps {
  /** The open build's text and name. */
  xml: string;
  saved: string;
  buildId: string;
  buildName: string;
  /** The engine session of the open build, once it has loaded. */
  engineId: string | null;
  /** Changes whenever the engine reports new numbers for the open build. */
  statsVersion: unknown;
  onEdit: (e: BuildEdit) => Promise<EditResult>;
  onUndo: () => Promise<EditResult>;
  /** A build the Import tab sent here ("Import as comparison"); a new `key` loads it. */
  inbox?: { key: number; xml: string; label: string } | null;
  /** Opens "Compare with…" when it changes (the build's top-bar menu asks for it). */
  pickKey?: number;
}

type Kind = 'imported' | 'loadout' | 'saved' | 'library' | 'version';

interface Entry {
  key: string;
  label: string;
  sub: string;
  kind: Kind;
  xml: string;
  facts: BuildFacts;
  state: 'loading' | 'ready' | 'error';
  error?: string;
  engineId?: string;
  out?: Out;
  /** Counts the edits made to the compared build, so what reads it knows to read again. */
  rev?: number;
  /** When an imported build was loaded (ms). */
  at?: number;
}

type View = 'sum' | 'tree' | 'skills' | 'items' | 'calcs' | 'config';
const VIEWS: { id: View; label: string; icon: string }[] = [
  { id: 'sum', label: tr('CompareTab.summary'), icon: 'chart-bar' },
  { id: 'tree', label: tr('CompareTab.tree'), icon: 'tree' },
  { id: 'skills', label: tr('CompareTab.skills'), icon: 'gem' },
  { id: 'items', label: tr('CompareTab.items'), icon: 'body-armour' },
  { id: 'calcs', label: tr('CompareTab.calcs'), icon: 'calculator' },
  { id: 'config', label: tr('CompareTab.config'), icon: 'sliders' },
];
const GROUPS: Record<'o' | 'd' | 'u', string> = { o: tr('CompareTab_2.offence'), d: tr('CompareTab_2.defence'), u: tr('CompareTab_2.resistances_and_utility') };
const GROUP_ORDER = ['o', 'd', 'u'] as const;
const METRICS = POWER_STATS;

const short = (label: string): string => label.replace(/\s*\(.*\)$/, '');

export function CompareTab(p: CompareTabProps) {
  const toast = useToast();
  const info = useGameInfo();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [view, setView] = useState<View>('sum');
  const [show, setShow] = useState<'all' | 'diff' | 'off' | 'def'>('all');
  const [onlyDiff, setOnlyDiff] = useState(false);
  const [overlay, setOverlay] = useState(true);
  const [metric, setMetric] = useState('CombinedDPS');
  const [cats, setCats] = useState<Record<PowerCategory, boolean>>({ Tree: true, Items: true, 'Skill gems': true, 'Support gems': true, Config: true });
  const [cq, setCq] = useState('');
  const [url, setUrl] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [pickOpen, setPickOpen] = useState(false);
  // The synced versions of this build (signed in and synced); asked for when "Compare with�" opens.
  const [cloudVersions, setCloudVersions] = useState<VersionInfo[]>([]);
  useEffect(() => {
    if (!pickOpen) return;
    let alive = true;
    void (async () => {
      try {
        const r = await window.pom.account.versions(p.buildId);
        if (alive) setCloudVersions(r.ok && r.value ? r.value.filter((v) => !v.current).slice(0, 12) : []);
      } catch {
        if (alive) setCloudVersions([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [pickOpen, p.buildId]);
  const seenPick = useRef(0);
  useEffect(() => {
    if (p.pickKey && p.pickKey !== seenPick.current) {
      seenPick.current = p.pickKey;
      setPickOpen(true);
    }
  }, [p.pickKey]);
  const selectedChar = useSelectedCharacter();
  const [reimporting, setReimporting] = useState(false);
  const [treeSearch, setTreeSearch] = useState('');
  const [aOut, setAOut] = useState<Out | null>(null);
  const [libraryBuilds, setLibraryBuilds] = useState<{ id: string; name: string; folder: string }[]>([]);
  const { read, message, resolve } = useReadImport(url, { lazyLinks: true });
  const aFacts = useMemo(() => readFacts(p.xml), [p.xml]);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const activeRef = useRef(active);
  activeRef.current = active;
  const ready = !!p.engineId;
  const cur = entries.find((e) => e.key === active) ?? null;

  // This build's numbers, kept in step with the engine.
  useEffect(() => {
    let live = true;
    if (!p.engineId) {
      setAOut(null);
      return;
    }
    void fetchOut(p.engineId).then((o) => live && o && setAOut(o));
    return () => {
      live = false;
    };
  }, [p.engineId, p.statsVersion]);

  // Library builds that can be compared with.
  useEffect(() => {
    let live = true;
    void window.pom.lib.list().then((r) => {
      if (live && r.ok) setLibraryBuilds(r.value.builds.filter((b) => b.id !== p.buildId && b.info.valid).sort((a, b) => b.mtimeMs - a.mtimeMs).map((b) => ({ id: b.id, name: b.name, folder: b.folder })));
    });
    return () => {
      live = false;
    };
  }, [p.buildId]);

  // The engine sessions of the compared builds close when the tab goes.
  useEffect(
    () => () => {
      for (const e of entriesRef.current) if (e.engineId) void window.pom.sendCommand('closeBuild', { buildId: e.engineId });
    },
    [],
  );

  const load = useCallback(async (entry: Omit<Entry, 'state' | 'facts'>) => {
    const facts = readFacts(entry.xml);
    setEntries((es) => [...es.filter((x) => x.key !== entry.key), { ...entry, facts, state: 'loading' }]);
    setActive(entry.key);
    const r = await window.pom.sendCommand('loadBuild', { buildXml: entry.xml, keep: 'shown' });
    if (!r.ok) {
      setEntries((es) => es.map((x) => (x.key === entry.key ? { ...x, state: 'error', error: r.error.message } : x)));
      return;
    }
    const out = await fetchOut(r.result.buildId);
    setEntries((es) => es.map((x) => (x.key === entry.key ? { ...x, state: out ? 'ready' : 'error', error: out ? undefined : tr('CompareTab.no_numbers_came_back'), engineId: r.result.buildId, out: out ?? undefined } : x)));
  }, []);

  // A build sent from the Import tab.
  const seenInbox = useRef(0);
  const inbox = p.inbox;
  useEffect(() => {
    if (!inbox || seenInbox.current === inbox.key) return;
    seenInbox.current = inbox.key;
    let label = inbox.label;
    const have = new Set(entriesRef.current.map((e) => e.label));
    for (let i = 2; have.has(label); i++) label = `${label.replace(/ \d+$/, '')} ${i}`;
    void load({ key: 'imp:' + inbox.key, label, sub: tr('CompareTab.imported'), kind: 'imported', xml: inbox.xml, at: Date.now() }).then(() => toast({ text: tr('CompareTab.loaded_label_for_comparison', { label }), kind: 'ok' }));
  }, [inbox, load, toast]);

  const remove = () => {
    if (!cur) return;
    if (cur.engineId) void window.pom.sendCommand('closeBuild', { buildId: cur.engineId });
    const rest = entries.filter((e) => e.key !== cur.key);
    setEntries(rest);
    setActive(rest[rest.length - 1]?.key ?? null);
    toast({ text: tr('CompareTab.removed_label', { label: cur.label }), kind: 'ok' });
  };

  const importSource = async (src: CompareSource) => {
    const info = readFacts(src.xml);
    let label = src.name || src.suggested || [info.ascendClassName || info.className].filter(Boolean).join(' ') || tr('CompareTab.imported_build');
    const have = new Set(entries.map((e) => e.label));
    for (let i = 2; have.has(label); i++) label = `${label.replace(/ \d+$/, '')} ${i}`;
    setUrl('');
    setImportOpen(false);
    await load({ key: 'imp:' + Date.now(), label, sub: src.from === 'folder' ? tr('CompareTab.library') : tr('CompareTab.imported'), kind: src.from === 'folder' ? 'library' : 'imported', xml: src.xml, at: Date.now() });
    toast({ text: tr('CompareTab.loaded_label_for_comparison', { label }), kind: 'ok' });
  };
  /** Reads the compared build's text and numbers again after an edit made through its own engine session. */
  const refreshB = async (key: string, engineId: string) => {
    const [x, out] = await Promise.all([window.pom.sendCommand('getBuildXml', { buildId: engineId }), fetchOut(engineId)]);
    setEntries((es) => es.map((e) => (e.key === key ? { ...e, ...(x.ok ? { xml: x.result.buildXml, facts: readFacts(x.result.buildXml) } : {}), out: out ?? e.out, rev: (e.rev ?? 0) + 1 } : e)));
  };
  const editB = async (edit: BuildEdit): Promise<boolean> => {
    const c = entriesRef.current.find((e) => e.key === activeRef.current);
    if (!c?.engineId) return false;
    const r = await window.pom.sendCommand('edit', { buildId: c.engineId, edit });
    if (!r.ok) {
      toast({ text: tr('CompareTab.couldn_t_change_the_compared', { message: r.error.message }), kind: 'error' });
      return false;
    }
    await refreshB(c.key, c.engineId);
    return true;
  };
  const editBXml = async (fn: (xml: string) => string): Promise<boolean> => {
    const c = entriesRef.current.find((e) => e.key === activeRef.current);
    if (!c) return false;
    const next = fn(c.xml);
    return next === c.xml ? true : editB({ kind: 'setXml', xml: next });
  };
  const editA = async (edit: BuildEdit): Promise<{ ok: boolean; error?: string }> => {
    const r = await p.onEdit(edit);
    return { ok: r.ok, error: r.ok ? undefined : r.error };
  };
  const editAXml = async (fn: (xml: string) => string) => {
    const next = fn(p.xml);
    if (next !== p.xml) await p.onEdit({ kind: 'setXml', xml: next });
  };
  const doImport = async () => {
    if (read.state !== 'ok' && read.state !== 'link') return;
    const got = await resolve();
    if (!got.ok) return;
    await importSource({ xml: got.d.xml, name: '', suggested: got.d.name || [got.d.info.mainSkill, got.d.info.ascendClassName || got.d.info.className].filter(Boolean).join(' '), from: 'code' });
  };

  // ---- what can be compared with --------------------------------------------------------------------------
  const loadouts = useMemo(() => loadoutsOf(aFacts), [aFacts]);
  const dirty = p.xml !== p.saved;
  const options: CapOption[] = [];
  for (const e of entries) options.push({ value: 'e:' + e.key, label: e.label, sub: e.sub, icon: e.kind === 'imported' ? 'import' : 'layers' });
  const picked = new Set(entries.map((e) => e.key));
  const cands: CapOption[] = [];
  (loadouts.length > 1 ? loadouts : []).forEach((lo, i) => {
    if (!picked.has('lo:' + i + ':' + lo.name)) cands.push({ value: 'c:lo:' + i, label: lo.name, sub: tr('CompareTab.this_build_loadout'), icon: 'layers' });
  });
  if (dirty && !picked.has('saved')) cands.push({ value: 'c:saved', label: tr('CompareTab.last_saved_version'), sub: tr('CompareTab.this_build_saved_version'), icon: 'layers' });
  for (const b of libraryBuilds.slice(0, 60)) if (!picked.has('lib:' + b.id)) cands.push({ value: 'c:lib:' + b.id, label: b.name, sub: tr('CompareTab.library'), icon: 'layers' });
  if (options.length) options.push({ value: '', label: '', sep: true });
  options.push({ value: 'import', label: tr('CompareTab.import_another_build'), icon: 'plus' });
  options.push({ value: 'pick', label: tr('CompareTab.compare_with'), sub: tr('CompareTab.other_builds_setup_of_the'), icon: 'compare' });
  if (cands.length) options.push({ value: '', label: '', sep: true }, ...cands);

  const inRef = useRef<HTMLInputElement>(null);
  const pick = async (v: string) => {
    if (v === 'import') {
      setImportOpen(true);
      return;
    }
    if (v === 'pick') {
      setPickOpen(true);
      return;
    }
    if (v.startsWith('c:lo:') && entriesRef.current.some((e) => e.key.startsWith('lo:' + v.slice(5) + ':'))) {
      setActive(entriesRef.current.find((e) => e.key.startsWith('lo:' + v.slice(5) + ':'))!.key);
      return;
    }
    if (v === 'c:saved' && entriesRef.current.some((e) => e.key === 'saved')) {
      setActive('saved');
      return;
    }
    if (v.startsWith('c:lib:') && entriesRef.current.some((e) => e.key === 'lib:' + v.slice(6))) {
      setActive('lib:' + v.slice(6));
      return;
    }
    if (v.startsWith('e:')) {
      setActive(v.slice(2));
      return;
    }
    if (v.startsWith('c:lo:')) {
      const i = Number(v.slice(5));
      const lo = loadouts[i];
      if (lo) await load({ key: 'lo:' + i + ':' + lo.name, label: lo.name, sub: tr('CompareTab.this_build_loadout'), kind: 'loadout', xml: loadoutXml(p.xml, lo) });
    } else if (v === 'c:saved') {
      await load({ key: 'saved', label: tr('CompareTab.last_saved_version'), sub: tr('CompareTab.this_build_saved_version'), kind: 'saved', xml: p.saved });
    } else if (v.startsWith('c:ver:')) {
      const rev = Number(v.slice(6));
      const t = await window.pom.account.versionText(p.buildId, rev);
      if (!t.ok || !t.value) return void toast({ text: tr('CompareTab.that_saved_version_could_not'), kind: 'error' });
      await load({ key: 'ver:' + rev, label: versionLabel(cloudVersions.find((x) => x.rev === rev)?.at ?? Date.now()), sub: tr('CompareTab.this_build_saved_version_2'), kind: 'version', xml: t.value });
    } else if (v.startsWith('c:lib:')) {
      const id = v.slice(6);
      const r = await window.pom.lib.read(id);
      if (!r.ok) return void toast({ text: r.error, kind: 'error' });
      await load({ key: 'lib:' + id, label: r.value.name, sub: tr('CompareTab.library'), kind: 'library', xml: r.value.xml });
    }
  };

  // ---- summary --------------------------------------------------------------------------------------------
  const bOut = cur?.out ?? null;
  const lines = useMemo(() => {
    if (!aOut || !bOut) return [];
    // Block chance is "%.3f%%" in upstream's sidebar; side by side a column of "68.000%" is noise, so one decimal here (the tooltip keeps the exact value).
    const all = statLines(aOut, bOut).map((l) => (l.fmt === '.3f%%' ? { ...l, fmt: '.1f%%' } : l));
    return GROUP_ORDER.flatMap((g) => all.filter((l) => l.group === g));
  }, [aOut, bOut]);
  const shown = useMemo(
    () =>
      lines.filter((l) => {
        if (show === 'off') return l.group === 'o';
        if (show === 'def') return l.group === 'd';
        if (show === 'diff') return statDelta(l).better !== 0;
        return true;
      }),
    [lines, show],
  );
  const biggest = useMemo(
    () =>
      lines
        .map((l) => ({ l, d: statDelta(l) }))
        .filter((x) => x.d.better !== 0)
        .sort((a, b) => b.d.magnitude - a.d.magnitude)
        .slice(0, 5),
    [lines],
  );

  // ---- power report ---------------------------------------------------------------------------------------
  interface Report {
    state: 'running' | 'done' | 'error';
    progress: number;
    metric: string;
    entryKey: string;
    rows: PowerRow[];
    base: number;
    stat: PowerStat;
    count: number;
    error?: string;
  }
  const [report, setReport] = useState<Report | null>(null);
  const [prSort, setPrSort] = useState<PowerSort>('val');
  const run = useRef(0);
  useEffect(() => () => void run.current++, []);
  // A report belongs to the build it measured; another comparison build starts a new one.
  useEffect(() => {
    run.current++;
    setReport(null);
  }, [active]);

  const buildReport = async () => {
    if (!cur || cur.state !== 'ready' || !p.engineId || !aOut) return;
    const mine = ++run.current;
    const stat = effectiveStat(METRICS.find((m) => m.stat === metric) ?? METRICS[1]!, aOut);
    setReport({ state: 'running', progress: 0, metric, entryKey: cur.key, rows: [], base: 0, stat, count: 0 });
    try {
      const ts = await window.pom.sendCommand('treeState', { buildId: p.engineId });
      const primaryNodes = ts.ok ? (ts.result.tree as TreeState).allocated : [];
      const cSpec = activeSpecOf(cur.facts);
      const nodes = cats.Tree && cSpec?.treeVersion ? await loadTreeNodes(cSpec.treeVersion) : null;
      const own = cats.Items && treeVersion ? await loadTreeNodes(treeVersion) : null;
      const socketNodes = own ? Object.entries(own).filter(([, n]) => n.j).map(([id]) => Number(id)) : [];
      let treeDist: Map<number, number> | undefined;
      if (cats.Tree && cSpec?.treeVersion) {
        const g = await loadTreeGraph(cSpec.treeVersion);
        const start = g?.classStart(activeSpecOf(aFacts)?.classId ?? 0);
        if (g) treeDist = pathDistances([...g.nodes.values()], start ? [...primaryNodes, start] : primaryNodes);
      }
      const tasks = planPower({ primary: aFacts, primaryXml: p.xml, primaryNodes, compare: cur.facts, nodes, socketNodes, schema: SCHEMA, isSupport: (n, id) => isSupportGem(info, n, id), categories: cats, treeDist });
      const base = powerValue(stat, aOut[stat.stat]);
      const res = await measure(p.engineId, tasks, stat, () => run.current === mine, (progress) => run.current === mine && setReport((r) => (r && r.state === 'running' ? { ...r, progress } : r)));
      if (!res || run.current !== mine) return;
      setReport({ state: 'done', progress: 100, metric, entryKey: cur.key, rows: powerRows(tasks, res.map((x) => x.v), base, res.map((x) => x.note)), base, stat, count: tasks.length });
    } catch (e) {
      if (run.current === mine) setReport((r) => (r ? { ...r, state: 'error', error: e instanceof Error ? e.message : String(e) } : r));
    }
  };

  // ---- config -----------------------------------------------------------------------------------------------
  // The inputs each build saved, and the config the way upstream holds it (defaults and the <Build> picks under them).
  const aSaved = useMemo(() => activeConfigOf(aFacts), [aFacts]);
  const bSaved = useMemo(() => (cur ? activeConfigOf(cur.facts) : new Map<string, ConfigValue>()), [cur]);
  const aCfg = useMemo(() => effectiveConfig(aFacts, SCHEMA), [aFacts]);
  const bCfg = useMemo(() => (cur ? effectiveConfig(cur.facts, SCHEMA) : new Map<string, ConfigValue>()), [cur]);
  const cfgOptions = useMemo(() => {
    // CompareTab:RebuildConfigControls: every option with a variable except the two sections it leaves out.
    const skip = new Set(['Custom Modifiers', tr('CompareTab.map_modifiers_and_player_debuffs')]);
    return SCHEMA.options.filter((o) => !skip.has(o.section) && o.type !== 'text');
  }, []);
  const cfgSections = useMemo(() => {
    const q = cq.trim().toLowerCase();
    const out: { name: string; rows: { opt: ConfigOption; a: string; b: string; diff: boolean }[]; diffs: number }[] = [];
    for (const sec of SCHEMA.sections) {
      const rows: { opt: ConfigOption; a: string; b: string; diff: boolean }[] = [];
      for (const opt of cfgOptions.filter((o) => o.section === sec.name)) {
        if (q && !opt.label.toLowerCase().includes(q)) continue;
        const av = aCfg.get(opt.var);
        const bv = bCfg.get(opt.var);
        const [na, nb] = normaliseConfig(opt, av, bv);
        const diff = String(na) !== String(nb);
        if (!diff && !aSaved.has(opt.var) && !bSaved.has(opt.var)) continue;
        if (onlyDiff && !diff) continue;
        const show1 = (v: ConfigValue | undefined) => (v === undefined ? (opt.type === 'check' ? tr('CompareTab_2.off') : '—') : configText(opt, v) === 'Yes' ? 'On' : configText(opt, v) === 'No' ? tr('CompareTab_2.off') : configText(opt, v));
        rows.push({ opt, a: show1(av), b: show1(bv), diff });
      }
      rows.sort((x, y) => Number(y.diff) - Number(x.diff));
      if (rows.length) out.push({ name: sec.name, rows, diffs: rows.filter((r) => r.diff).length });
    }
    return out;
  }, [cfgOptions, aCfg, bCfg, aSaved, bSaved, cq, onlyDiff]);

  const copyConfig = async () => {
    if (!cur) return;
    const values: Record<string, ConfigValue | null> = {};
    let n = 0;
    for (const [k, v] of bCfg) {
      values[k] = v;
      const opt = SCHEMA.options.find((o) => o.var === k);
      const [a, b] = opt ? normaliseConfig(opt, aCfg.get(k), v) : [aCfg.get(k), v];
      if (String(a) !== String(b)) n++;
    }
    const r = await p.onEdit({ kind: 'setConfigs', values });
    if (!r.ok) return void toast({ text: tr('CompareTab_2.couldn_t_copy_the_configuration', { error: r.error ?? '' }).trim(), kind: 'error' });
    toast({ text: n ? tr('CompareTab.copied_count_config_options_from', { count: n, label: short(cur.label) }) : tr('CompareTab.this_build_already_has_the'), kind: 'ok', action: n ? { label: tr('CompareTab.undo'), run: () => void p.onUndo() } : undefined });
  };

  // ---- skills and items rows ------------------------------------------------------------------------------
  const [gemHover, setGemHover] = useState<{ side: 'a' | 'b'; group: number; name: string; index: number } | null>(null);
  const skillPairs = useMemo(() => {
    if (!cur) return [];
    type GemLine = { name: string; level: number; quality: number; support: boolean };
    type G = { slot: string; label: string; gems: string[]; lines: GemLine[]; main: string };
    const groups = (f: BuildFacts): G[] =>
      activeGroupsOf(f)
        .map((g) => {
          const gems = g.gems.map((x) => x.name).filter(Boolean);
          const main = g.gems.find((x) => x.name && !isSupportGem(info, x.name, x.skillId))?.name ?? gems[0] ?? '';
          const lines = g.gems.filter((x) => x.name).map((x) => ({ name: x.name, level: x.level, quality: x.quality, support: isSupportGem(info, x.name, x.skillId) }));
          return { slot: g.slot, label: g.label, gems, lines, main };
        })
        .filter((g) => g.gems.length > 0);
    const A = groups(aFacts);
    const B = groups(cur.facts);
    const jac = (x: string[], y: string[]): number => {
      const sy = new Set(y);
      const shared = x.filter((n) => sy.has(n)).length;
      return shared / (new Set([...x, ...y]).size || 1);
    };
    // A group is matched with the group of the other build in the same slot, else the one sharing the most gems.
    const usedB = new Set<number>();
    const pairs: { a?: G; b?: G }[] = [];
    A.forEach((ga) => {
      let best = -1;
      let bestScore = 0;
      B.forEach((gb, j) => {
        if (usedB.has(j)) return;
        const score = jac(ga.gems, gb.gems) + (ga.slot && ga.slot === gb.slot ? 1 : 0);
        if (score > bestScore) {
          bestScore = score;
          best = j;
        }
      });
      if (best >= 0 && bestScore >= 0.34) {
        usedB.add(best);
        pairs.push({ a: ga, b: B[best] });
      } else pairs.push({ a: ga });
    });
    B.forEach((gb, j) => {
      if (!usedB.has(j)) pairs.push({ b: gb });
    });
    return pairs.map(({ a, b }) => {
      const ga = a?.gems ?? [];
      const gb = b?.gems ?? [];
      const j = jac(ga, gb);
      const g = (a ?? b)!;
      const slot = [a?.slot, b?.slot].find(Boolean) ?? '';
      return { slot: slot || g.label || g.main, sub: slot ? g.main : '', note: !ga.length || !gb.length ? tr('CompareTab.only_in_length', { value: ga.length ? 'A' : 'B' }) : j === 1 ? tr('CompareTab.same_gems') : tr('CompareTab.v1_match', { value: Math.round(j * 100) }), a: ga, b: gb, la: a?.lines ?? [], lb: b?.lines ?? [], same: j === 1 && ga.length > 0 };
    });
  }, [aFacts, cur, info]);

  // ---- tree: the drawing, when the tree data for the builds' version is installed -------------------------------
  const [trees, setTrees] = useState<{ a: RenderTreeState; b: RenderTreeState; key: string; union: number[] } | null>(null);
  const [treeOk, setTreeOk] = useState<boolean | null>(null);
  const treeVersion = activeSpecOf(aFacts)?.treeVersion ?? '';
  const treeVersionB = (cur ? activeSpecOf(cur.facts)?.treeVersion : undefined) ?? '';
  useEffect(() => {
    let live = true;
    setTreeOk(null);
    if (view !== 'tree' || !treeVersion) return;
    void bundledTreeVersions().then((s) => live && setTreeOk(s.has(treeVersion) && (!treeVersionB || s.has(treeVersionB))));
    return () => {
      live = false;
    };
  }, [view, treeVersion, treeVersionB]);
  useEffect(() => {
    let live = true;
    if (view !== 'tree' || !treeOk || !p.engineId || !cur?.engineId || cur.state !== 'ready') {
      setTrees(null);
      return;
    }
    void Promise.all([window.pom.sendCommand('treeState', { buildId: p.engineId }), window.pom.sendCommand('treeState', { buildId: cur.engineId })]).then(([ra, rb]) => {
      if (live && ra.ok && rb.ok) {
        const a = ra.result.tree as RenderTreeState;
        const b = rb.result.tree as RenderTreeState;
        setTrees({ a, b, key: `${cur.key}:${Date.now()}`, union: [...new Set([...a.allocated, ...b.allocated])] });
      }
    });
    return () => {
      live = false;
    };
  }, [view, treeOk, p.engineId, p.statsVersion, cur?.engineId, cur?.state, cur?.rev]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- tree: what differs ------------------------------------------------------------------------------------
  const [treeNames, setTreeNames] = useState<Record<string, TreeNodeInfo> | null>(null);
  const aSpec = activeSpecOf(aFacts);
  useEffect(() => {
    let live = true;
    if (view === 'tree' && aSpec?.treeVersion) void loadTreeNodes(aSpec.treeVersion).then((n) => live && setTreeNames(n));
    return () => {
      live = false;
    };
  }, [view, aSpec?.treeVersion]);
  const treeDiff = useMemo(() => {
    const b = cur ? activeSpecOf(cur.facts) : undefined;
    if (!aSpec || !b) return null;
    // One source for the legend, the panel titles and the lists: the allocated nodes the engine drew, once loaded.
    const an = trees ? trees.a.allocated : aSpec.nodes;
    const bn = trees ? trees.b.allocated : b.nodes;
    const sa = new Set(an);
    const sb = new Set(bn);
    return { onlyA: an.filter((n) => !sb.has(n)), onlyB: bn.filter((n) => !sa.has(n)), sameVersion: aSpec.treeVersion === b.treeVersion };
  }, [aSpec, cur, trees]);

  const reimportCurrent = async () => {
    if (!selectedChar) return;
    setReimporting(true);
    const r = await reimportCharacter(selectedChar, p.xml);
    if (!r.ok) toast({ text: tr('CompareTab.couldn_t_re_import_name', { name: selectedChar.character.name, error: r.error }), kind: 'error' });
    else {
      await p.onEdit({ kind: 'setXml', xml: r.xml });
      toast({ text: tr('CompareTab.re_imported_name', { name: selectedChar.character.name }), kind: 'ok', action: { label: tr('CompareTab.undo'), run: () => void p.onUndo() } });
    }
    setReimporting(false);
  };

  // "Compare with…": loadouts of this build, the saved version, other builds, then import.
  const pickSections: PickSection[] = (() => {
    const out: PickSection[] = [];
    const lo: PickRow[] = loadouts.map((l, i) => {
      const n = aFacts.specs[l.spec - 1]?.nodes.length ?? 0;
      return { value: 'c:lo:' + i, label: l.name, sub: [tr('h_rA_cmp.loadout'), n ? tr('h_rA_cmp.n_passives', { n }) : '', i + 1 === aFacts.activeSpec ? tr('h_rA_cmp.open_now') : ''].filter(Boolean).join(' · '), icon: 'layers' };
    });
    if (lo.length) out.push({ title: tr('CompareTab.loadouts_in_this_build'), rows: lo });
    const saved: PickRow[] = [
      ...(dirty ? [{ value: 'c:saved', label: tr('CompareTab.last_saved_version'), sub: tr('CompareTab.without_your_unsaved_changes'), icon: 'history' }] : []),
      ...cloudVersions.map((v) => ({ value: 'c:ver:' + v.rev, label: versionLabel(v.at), sub: v.note || (v.here ? tr('h_rA_cmp.saved_on_this_pc') : tr('h_rA_cmp.saved_on_device', { device: v.deviceName })), icon: 'history' })),
    ];
    if (saved.length) out.push({ title: tr('CompareTab.saved_versions'), rows: saved });
    const other: PickRow[] = [
      ...entries.filter((e) => e.kind === 'imported').map((e) => ({ value: 'e:' + e.key, label: e.label, sub: e.at ? tr('h_rA_cmp.imported_on', { date: new Date(e.at).toLocaleDateString(document.documentElement.lang || 'en-US', { month: 'short', day: '2-digit' }) }) : tr('CompareTab.imported'), icon: 'tree' })),
      ...libraryBuilds.slice(0, 60).map((b) => ({ value: 'c:lib:' + b.id, label: b.name, sub: b.folder ? tr('CompareTab.library_join', { value: b.folder.split('/').join(' / ') }) : tr('CompareTab.library'), icon: 'tree' })),
    ];
    out.push({ title: tr('CompareTab.other_builds'), rows: other });
    return out;
  })();
  const pickInitial = (() => {
    if (!cur) return '';
    if (cur.kind === 'loadout') return 'c:lo:' + cur.key.split(':')[1];
    if (cur.kind === 'saved') return 'c:saved';
    if (cur.kind === 'version') return 'c:ver:' + cur.key.slice(4);
    if (cur.kind === 'library') return 'c:lib:' + cur.key.slice(4);
    return 'e:' + cur.key;
  })();

  const has0 = !!cur && cur.state === 'ready';
  const bSide = useSide(cur?.engineId, cur?.rev, !!cur && cur.state === 'ready');
  // One object per change of this build's numbers or text: what reads this build compares it by identity.
  const aKey = useMemo(() => ({}), [p.statsVersion, p.xml]); // eslint-disable-line react-hooks/exhaustive-deps
  const abKey = useMemo(() => ({}), [aKey, cur?.rev]);
  const aSide = useSide(p.engineId, aKey, has0 && view === 'calcs');
  const has = !!cur;
  const bShort = cur ? short(cur.label) : '';
  const notReady = has && cur!.state !== 'ready';
  const view1: View = has ? view : 'sum';
  const isLoading = cur?.state === 'loading';


  return (
    <div className="tabroot pc cmp-root" data-screen-label="Compare / Tab / Content">
      <div className="cmp-tb tab-tb" data-r="tab-tb">
        {has && (
          <>
            <CapSelect caption={tr('CompareTab.compare_with_2')} valueLabel={cur!.label} value={'e:' + cur!.key} options={options} width={240} minWidth={140} ariaLabel={tr('CompareTab.compare_with_3')} tone="compare" onChange={(v) => void pick(v)} />
            <button type="button" className="btn ghost" title={tr('CompareTab.remove')} aria-label={tr('CompareTab.remove')} onClick={remove}>
              <Icon name="trash" size={16} />
            </button>
          </>
        )}
        <div className={'lib-search cmp-in ' + (read.state === 'ok' || read.state === 'link' ? 'good' : message.tone === 'bad' ? 'bad' : '')} data-lg="tile">
          <input
            ref={inRef}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void doImport();
            }}
            placeholder={has ? tr('CompareTab.paste_another_build_code_or') : tr('CompareTab.paste_a_build_code_or')}
            title={message.text}
            aria-label={tr('CompareTab.build_code_or_url_to')}
            spellCheck={false}
          />
          {message.tone === 'good' && <Icon name="check-circle" size={13} style={{ color: 'var(--positive)' }} />}
          {message.tone === 'bad' && <Icon name="error" size={13} style={{ color: 'var(--negative-text)' }} />}
        </div>
        <button type="button" className="btn" data-lg="control" disabled={!ready || (read.state !== 'ok' && read.state !== 'link')} title={tr('CompareTab.import_the_pasted_build_code')} onClick={() => void doImport()}>
          <Icon name="import" size={16} />
          {tr('CompareTab.import')}
        </button>
        {has && (
          <div className="right">
            <div className="seg cmp-views" data-lg="tile" role="tablist" aria-label={tr('CompareTab.compare_views')}>
              {VIEWS.map((v) => (
                <button key={v.id} type="button" role="tab" aria-selected={view1 === v.id} aria-label={v.label} title={v.label} onClick={() => setView(v.id)} style={{ height: 28 }}>
                  {v.icon && <Icon name={v.icon} size={15} style={{ opacity: 0.85 }} />}
                  <span className="lbl">{v.label}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      {importOpen && <ImportCompareDialog initialText={url} onClose={() => setImportOpen(false)} onImport={importSource} />}
      {pickOpen && (
        <ComparePick
          sections={pickSections}
          initial={pickInitial}
          onClose={() => setPickOpen(false)}
          onImport={() => {
            setPickOpen(false);
            setImportOpen(true);
          }}
          onCompare={(v) => {
            setPickOpen(false);
            void pick(v);
          }}
          setup={cur && cur.state === 'ready' ? <SetBar facts={cur.facts} xml={cur.xml} side={bSide} apply={editB} applyXml={editBXml} /> : undefined}
          extra={
            <button type="button" className="cmp-pick-row" disabled={!selectedChar || reimporting || !ready} aria-label={tr('CompareTab.re_import_current')} title={selectedChar ? tr('CompareTab.re_import_character_from_the', { name: selectedChar.character.name, class: selectedChar.character.class, league: selectedChar.character.league }) : tr('CompareTab.no_character_selected_go_to')} onClick={() => void reimportCurrent()}>
              {reimporting ? <span className="spinner" /> : <Icon name="reset" size={16} />}
              <span className="n ellipsis">{tr('CompareTab.re_import_current')}</span>
              <span className="s ellipsis">{selectedChar ? `${selectedChar.character.name}, ${selectedChar.character.class}` : tr('CompareTab.no_character_selected_pick_one')}</span>
            </button>
          }
        />
      )}

      <div className="gl cmp-body" data-r="tab-body">
        {!has && (
          <div className="cmp-empty">
            <span className="t">{tr('CompareTab.nothing_to_compare_yet')}</span>
            <span className="p">
              {ready
                ? tr('CompareTab.paste_a_build_code_or_2')
                : tr('CompareTab.the_calculation_engine_has_not')}
            </span>
            {ready && (
              <button type="button" className="btn" style={{ marginTop: 10 }} onClick={() => setPickOpen(true)}>
                <Icon name="compare" size={16} />
                {tr('CompareTab.compare_with')}
              </button>
            )}
          </div>
        )}
        {has && view1 !== 'sum' && (
          <div className="cmp-sub">
            {view1 === 'tree' && overlay ? (
              <>
                <span className="lg"><i style={{ background: '#00ff00' }} />{tr('CompareTab.only_in_b_bshort')}</span>
                <span className="lg"><i style={{ background: '#ff0000' }} />{tr('CompareTab.only_in_a_this_build')}</span>
                <span className="lg"><i style={{ background: '#0000ff' }} />{tr('CompareTab.mastery_or_jewel_differs')}</span>
              </>
            ) : view1 === 'skills' || view1 === 'items' ? null : (
              <>
                <span className="lg"><i style={{ background: 'var(--positive)' }} />{tr('CompareTab.a_this_build')}</span>
                <span className="lg"><i style={{ background: 'var(--compare-b)' }} />{tr('CompareTab.b_bshort', { bShort })}</span>
              </>
            )}
            <span className="note">
              {view1 === 'tree' ? (treeDiff ? tr('CompareTab.length_nodes_only_in_b_2', { count: treeDiff.onlyB.length, count2: treeDiff.onlyA.length }) : '') : view1 === 'skills' ? tr('CompareTab.socket_groups_matched_by_slot') : ''}
            </span>
            <span style={{ flex: 1 }} />
            {view1 === 'tree' && <SwitchRow checked={overlay} onChange={setOverlay} label={tr('CompareTab.overlay_comparison')} />}
            {view1 === 'config' && (
              <>
                <div className="lib-search" data-lg="tile" style={{ flex: '0 1 220px', minWidth: 110, height: 32, borderRadius: 9, padding: '0 10px' }}>
                  <Icon name="search" size={14} style={{ color: 'var(--text-muted)' }} />
                  <input value={cq} onChange={(e) => setCq(e.target.value)} placeholder={tr('CompareTab.search')} aria-label={tr('CompareTab.search_config')} spellCheck={false} />
                </div>
                <button type="button" className="btn sm" data-lg="control" disabled={!ready || notReady} title={tr('CompareTab.copy_config_from_compare_build')} onClick={() => void copyConfig()}>
                  <Icon name="copy" size={14} />
                  {tr('CompareTab.copy_config')}
                </button>
              </>
            )}
            {(view1 === 'skills' || view1 === 'items' || view1 === 'calcs' || view1 === 'config') && <SwitchRow checked={onlyDiff} onChange={setOnlyDiff} label={tr('CompareTab.only_differences')} />}
          </div>
        )}
        {has && isLoading && <div className="cmp-note"><span className="spinner" style={{ color: 'var(--gold-text)' }} />{tr('CompareTab.calculating_label_with_the_engine', { label: cur!.label })}</div>}
        {has && cur!.state === 'error' && <div className="cmp-note bad"><Icon name="error" size={16} />{tr('CompareTab.couldn_t_load_label_for', { label: cur!.label, error: cur!.error })}</div>}

        {has && !notReady && view1 === 'sum' && (
          <>
            <div className="cmp-scroll scroll-thin">
              <div className="cmp-sum" data-r="cmp-sum">
                <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
                  <div>
                    <div className="cmp-row head">
                      <span />
                      <span title={p.buildName}><i style={{ background: 'var(--positive)' }} />{tr('CompareTab.cell_a')}</span>
                      <span title={cur!.label}><b className="wrap2"><i style={{ background: 'var(--compare-b)', display: 'inline-block', marginRight: 6 }} />{tr('CompareTab.cell_b')}</b></span>
                      <span style={{ textAlign: 'right' }}>{tr('CompareTab.a_b')}</span>
                    </div>
                    <div style={{ padding: '4px 0 8px' }}>
                      {GROUP_ORDER.map((g) => {
                        const rs = shown.filter((l) => l.group === g);
                        if (!rs.length) return null;
                        return (
                          <div key={g}>
                            <div className="cmp-grp">{GROUPS[g]}</div>
                            {rs.map((l) => (
                              <StatRow key={l.key} l={l} />
                            ))}
                          </div>
                        );
                      })}
                      {!shown.length && <div style={{ padding: '18px 14px', color: 'var(--text-muted)' }}>{tr('CompareTab.no_differences_in_this_view')}</div>}
                    </div>
                  </div>
                </div>
                <aside style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
                  <div className="cmp-card" data-lg="tile">
                    <span className="ttl"><Icon name="diff" size={15} style={{ color: 'var(--text-muted)' }} />{tr('CompareTab.biggest_differences')}</span>
                    {biggest.map(({ l, d }) => (
                      <div className="bd" key={l.key}>
                        <span className="ellipsis" style={{ color: l.color ?? 'var(--text-2)' }}>{l.label}</span>
                        <span style={{ color: d.better > 0 ? 'var(--positive-text)' : 'var(--negative-text)', fontWeight: 600, whiteSpace: 'nowrap' }}>{d.text}</span>
                      </div>
                    ))}
                    {!biggest.length && <span style={{ color: 'var(--text-muted)' }}>{tr('CompareTab.these_builds_have_the_same')}</span>}
                  </div>
                  <div className="cmp-card" data-lg="tile">
                    <Chips
                      label={tr('CompareTab.show')}
                      value={show}
                      onChange={setShow}
                      options={[
                        { value: 'all', label: tr('CompareTab.all_stats') },
                        { value: 'diff', label: tr('CompareTab.only_differences') },
                        { value: 'off', label: tr('CompareTab.offence') },
                        { value: 'def', label: tr('CompareTab.defence') },
                      ]}
                    />
                  </div>
                </aside>
              </div>
            </div>
            {report && report.entryKey === cur!.key && report.state === 'done' && aOut && (
              <div className="cmp-prdrawer">
                <PowerTable report={report} version={activeSpecOf(cur!.facts)?.treeVersion ?? treeVersion} sort={prSort} onSort={setPrSort} onClose={() => setReport(null)} engineId={p.engineId} kind={skillKindOf(aOut as Record<string, number | string | boolean | null>)} stats={aOut as Record<string, number | string | boolean | null>} />
              </div>
            )}
            <div className="cmp-pr" data-r="cmp-pr">
              <span className="eyebrow">{tr('CompareTab.power_report')}</span>
              <CapSelect caption={tr('CompareTab.metric')} valueLabel={lbl(METRICS.find((m) => m.stat === metric)?.label ?? metric)} value={metric} options={METRICS.map((m) => ({ value: m.stat, label: lbl(m.label) }))} width={190} ariaLabel={tr('CompareTab.power_report_metric')} size="short" onChange={setMetric} />
              {POWER_CATEGORIES.map((c) => (
                <CheckBox key={c} checked={cats[c]} label={lbl(c)} onChange={(v) => setCats((s) => ({ ...s, [c]: v }))} />
              ))}
              <span style={{ flex: 1 }} />
              {report && report.entryKey === cur!.key && report.state === 'done' && <span style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>{tr('CompareTab.length_of_count_change_label', { count2: report.rows.length, count: report.count, label: lbl(report.stat.label) })}</span>}
              <button type="button" className="btn" data-lg="control" disabled={report?.state === 'running' || !POWER_CATEGORIES.some((c) => cats[c]) || !ready} style={{ opacity: POWER_CATEGORIES.some((c) => cats[c]) ? 1 : 0.5 }} onClick={() => void buildReport()}>
                {report?.state === 'running' ? <span className="spinner" /> : <Icon name="chart-bar" size={16} />}
                {report?.state === 'running' ? tr('CompareTab.building_progress', { progress: report.progress }) : report?.state === 'done' ? tr('CompareTab.rebuild_report') : tr('CompareTab.build_report')}
              </button>
              {report?.state === 'error' && <span style={{ width: '100%', color: 'var(--negative-text)', fontSize: 12.5 }}>{tr('CompareTab.the_report_stopped_error', { error: report.error })}</span>}
            </div>
          </>
        )}

        {has && !notReady && view1 === 'tree' && (
          <>
            <TreeBar aFacts={aFacts} bFacts={cur!.facts} aXml={p.xml} bXml={cur!.xml} bLabel={bShort} search={treeSearch} onSearch={setTreeSearch} editAXml={editAXml} editBXml={editBXml} onUndo={p.onUndo} />
            {treeOk && trees && !overlay && trees.a.treeVersion !== trees.b.treeVersion ? (
              <div className="cmp-treeview" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)' }}>
                <div className="pane">
                  <PassiveTreeView key={'a' + trees.key} className="tv" search={treeSearch} state={trees.a} base={`game/tree/${trees.a.treeVersion}/`} autoApply={false} frame={trees.a.allocated} />
                  <span className="lab"><i style={{ background: 'var(--positive)' }} />{tr('CompareTab.a_this_build_tree_treeversion', { treeVersion: dotVersion(trees.a.treeVersion) })}</span>
                </div>
                <div className="pane">
                  <PassiveTreeView key={'b' + trees.key} className="tv" search={treeSearch} state={trees.b} base={`game/tree/${trees.b.treeVersion}/`} autoApply={false} frame={trees.b.allocated} />
                  <span className="lab"><i style={{ background: 'var(--compare-b)' }} />{tr('CompareTab.b_bshort_tree_treeversion', { bShort, treeVersion: dotVersion(trees.b.treeVersion) })}</span>
                </div>
              </div>
            ) : treeOk && trees ? (
              <div className="cmp-treeview" style={{ gridTemplateColumns: overlay ? 'minmax(0,1fr)' : 'minmax(0,1fr) minmax(0,1fr)' }}>
                <div className="pane">
                  <PassiveTreeView key={'a' + trees.key + overlay} className="tv" search={treeSearch} state={trees.a} compare={overlay ? trees.b : null} base={`game/tree/${treeVersion}/`} autoApply={false} frame={trees.union} />
                  <span className="lab"><i style={{ background: overlay ? 'var(--compare-b)' : 'var(--positive)' }} />{overlay ? (trees.a.treeVersion !== trees.b.treeVersion ? tr('CompareTab.a_with_b_overlaid_tree', { treeVersion: dotVersion(trees.a.treeVersion), treeVersion2: dotVersion(trees.b.treeVersion) }) : tr('CompareTab.a_with_b_overlaid')) : tr('CompareTab.a_this_build')}</span>
                </div>
                {!overlay && (
                  <div className="pane">
                    <PassiveTreeView key={'b' + trees.key} className="tv" search={treeSearch} state={trees.b} base={`game/tree/${treeVersion}/`} autoApply={false} frame={trees.union} />
                    <span className="lab"><i style={{ background: 'var(--compare-b)' }} />{tr('CompareTab.b_bshort', { bShort })}</span>
                  </div>
                )}
              </div>
            ) : (
              <div className="cmp-scroll scroll-thin" style={{ padding: '12px 14px 16px', gap: 12, display: 'flex', flexDirection: 'column' }}>
                <div className="cmp-note" style={{ margin: 0 }}>
                  <Icon name="tree" size={16} />
                  <span style={{ whiteSpace: 'normal' }}>
                    {treeOk === false
                      ? tr('CompareTab.the_tree_drawing_needs_the')
                      : tr('CompareTab.loading_the_passive_tree')}
                  </span>
                </div>
                {treeDiff && (
                  <div className="cmp-trees">
                    <NodeList title={tr('CompareTab.length_nodes_only_in_b', { count: treeDiff.onlyB.length })} colour="#00ff00" ids={treeDiff.onlyB} names={treeNames} />
                    <NodeList title={tr('CompareTab.length_nodes_only_in_a', { count: treeDiff.onlyA.length })} colour="#ff0000" ids={treeDiff.onlyA} names={treeNames} />
                  </div>
                )}
                {treeDiff && !treeDiff.sameVersion && <span style={{ color: 'var(--warning)', fontSize: 12.5 }}>{tr('CompareTab.the_two_builds_use_different')}</span>}
              </div>
            )}
          </>
        )}

        {has && !notReady && view1 === 'skills' && (
          <div className="cmp-scroll scroll-thin" style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '12px 14px 16px' }}>
            <div className="cmp-ibar">
              <span style={{ flex: 1 }} />
              <SetSelect facts={aFacts} kind="skillSet" caption={tr('CompareTab.a_skill_set')} onPick={(id) => void editAXml((x) => setActiveSetXml(x, 'skillSet', id))} />
              <SetSelect facts={cur!.facts} kind="skillSet" caption={tr('CompareTab.b_skill_set')} onPick={(id) => void editBXml((x) => setActiveSetXml(x, 'skillSet', id))} />
            </div>
            <div className="cmp-hdr3"><span>{tr('CompareTab.slot')}</span><span>{tr('CompareTab.a_this_build_2')}</span><span>{tr('CompareTab.b_touppercase', { label: bShort.toUpperCase() })}</span></div>
            {skillPairs.filter((r) => !onlyDiff || !r.same).map((r, i) => (
              <div className="cmp-pair" data-lg="tile" key={r.slot + i}>
                <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                  <span className="ellipsis" style={{ color: 'var(--text-strong)', fontWeight: 500 }} title={r.slot}>{r.slot}</span>
                  <span style={{ color: r.same ? 'var(--text-muted)' : 'var(--warning)', fontSize: 12 }}>{r.note}</span>
                </span>
                {[r.la, r.lb].map((lines, ci) => {
                  const mine = new Set((ci === 0 ? r.a : r.b));
                  const other = new Set(ci === 0 ? r.b : r.a);
                  const missing = (ci === 0 ? r.lb : r.la).filter((g) => !mine.has(g.name));
                  const side = ci === 0 ? 'a' : 'b';
                  const hov = gemHover && gemHover.side === side && gemHover.group === i ? lines.find((x) => x.name === gemHover.name && (lines.indexOf(x) === gemHover.index)) : undefined;
                  return (
                    <div key={ci} style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
                      {lines.map((g, gi) => {
                        // Hovering a gem lights the gems it supports or is supported by in the same group.
                        const lit = hov ? lines.indexOf(hov) === gi || (hov.support !== g.support) : false;
                        return (
                          <span className={'gem' + (lit ? ' lit' : '')} key={g.name + gi} onMouseEnter={() => setGemHover({ side, group: i, name: g.name, index: gi })} onMouseLeave={() => setGemHover(null)}>
                            <Art src={gemArtUrl(info, g.name)} size={20} />
                            <span className="ellipsis" style={{ color: gemColour(info, g.name) }}>{!other.has(g.name) ? '+ ' : ''}{g.name}</span>
                            <span className="lvq">{g.level}{g.quality ? `/${g.quality}%` : ''}</span>
                          </span>
                        );
                      })}
                      {missing.map((g, gi) => (
                        <span className="gem miss" key={'m' + g.name + gi} title={tr('CompareTab.this_gem_is_only_in')}>
                          <Art src={gemArtUrl(info, g.name)} size={20} />
                          <span className="ellipsis">- {g.name}</span>
                        </span>
                      ))}
                      {!lines.length && !missing.length && <span style={{ color: 'var(--text-faint)' }}>{tr('CompareTab.no_group')}</span>}
                    </div>
                  );
                })}
              </div>
            ))}
            {!skillPairs.filter((r) => !onlyDiff || !r.same).length && <div style={{ color: 'var(--text-muted)' }}>{tr('CompareTab.no_differences_in_this_view')}</div>}
          </div>
        )}

        {has && !notReady && view1 === 'items' && (
          <ItemsView aFacts={aFacts} bFacts={cur!.facts} aXml={p.xml} bLabel={bShort} aEngineId={p.engineId} bEngineId={cur!.engineId ?? null} aOut={aOut} version={abKey} onlyDiff={onlyDiff} editA={editA} editAXml={editAXml} onUndo={p.onUndo} />
        )}

        {has && !notReady && view1 === 'calcs' && (
          <CalcsView aSide={aSide} bSide={bSide} aEngineId={p.engineId} bEngineId={cur!.engineId ?? null} aFacts={aFacts} bFacts={cur!.facts} aXml={p.xml} bXml={cur!.xml} onlyDiff={onlyDiff} editA={editA} editB={editB} editAXml={editAXml} editBXml={editBXml} />
        )}

        {has && !notReady && view1 === 'config' && (
          <ConfigView aEngineId={p.engineId} bEngineId={cur!.engineId ?? null} aFacts={aFacts} bFacts={cur!.facts} aKey={aKey} bKey={cur!.rev} q={cq} onlyDiff={onlyDiff} editA={editA} editB={editB} editAXml={editAXml} editBXml={editBXml} />
        )}
      </div>
    </div>
  );
}

function StatRow({ l }: { l: StatLine }) {
  const d = statDelta(l);
  return (
    <div className="cmp-row">
      <span className="ellipsis" title={l.label} style={{ color: l.color ?? 'var(--text-2)' }}>{l.label}</span>
      <span title={exactStat(l.a, l.fmt, l.scale, l.offset)} className="n">{formatStat(l.a, l.fmt, l.scale, l.offset, l.compact)}</span>
      <span title={exactStat(l.b, l.fmt, l.scale, l.offset)} className="n">{formatStat(l.b, l.fmt, l.scale, l.offset, l.compact)}</span>
      <span className="d" style={{ color: d.better === 0 ? 'var(--text-muted)' : d.better > 0 ? 'var(--positive-text)' : 'var(--negative-text)' }}>{d.text}</span>
    </div>
  );
}

function NodeList({ title, colour, ids, names }: { title: string; colour: string; ids: number[]; names: Record<string, TreeNodeInfo> | null }) {
  const rows = ids.map((id) => ({ id, n: names?.[String(id)] })).sort((a, b) => rank(b.n?.t) - rank(a.n?.t));
  return (
    <div className="cmp-card" data-lg="tile" style={{ minWidth: 0 }}>
      <span className="ttl"><i style={{ width: 8, height: 8, borderRadius: 2, background: colour }} />{title}</span>
      <div style={{ maxHeight: 420, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }} className="scroll-thin">
        {rows.slice(0, 400).map((r) => (
          <span key={r.id} className="ellipsis" style={{ flexShrink: 0, color: r.n?.t === 'Keystone' ? 'var(--node-keystone)' : r.n?.t === 'Notable' ? 'var(--gold-text)' : 'var(--text-2)', fontSize: 13 }}>
            {r.n ? r.n.n : tr('CompareTab.node_id', { id: r.id })}
            {r.n && r.n.t !== 'Normal' && <span style={{ color: 'var(--text-faint)', marginLeft: 8, fontSize: 11.5 }}>{r.n.t}</span>}
          </span>
        ))}
        {!rows.length && <span style={{ color: 'var(--text-faint)' }}>{tr('CompareTab.none')}</span>}
        {rows.length > 400 && <span style={{ color: 'var(--text-faint)' }}>{tr('CompareTab.and_length_more', { value: rows.length - 400 })}</span>}
      </div>
    </div>
  );
}

const rank = (t: string | undefined): number => (t === 'Keystone' ? 3 : t === 'Notable' ? 2 : t === 'Mastery' ? 0 : 1);

void ({} as StatDiff);
