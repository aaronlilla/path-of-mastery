// Find Timeless Jewel: upstream's search dialog on the Tree tab. The seed search runs in the engine (a stepped job,
// so the window stays responsive and Stop works); this file is the controls, the weight lists and the results.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { POWER_STATS, type StatDelta, type TimelessInfo, TimelessMod, TimelessRow, TimelessRows, TimelessSocket } from '@pom/protocol';
import { addItem, setJewel } from '../../shared/itemsXml.js';
import { readTimelessData } from '../../shared/buildXml';
import { compareLines, normaliseOutput, type CompareLine, type NumberFormat } from '../displayStats';
import { engineSend, type EngineBuild } from '../engineBuild';
import { Dialog, Icon, Select, Switch, useToast } from '../ui';
import {
  CONQUERORS,
  DEVOTION_VARIANTS,
  JEWEL_TYPES,
  REALMS,
  TABLE_OF,
  TIPS,
  TRADE_TYPES,
  jewelItemText,
  outcomeOf,
  parseRows,
  pickNode,
  setRowWeights,
  sliderValuesOf,
  tradeRange,
  tradeUrl,
  weightsOf,
  withOutcome,
  type SliderValues,
} from './timelessData';
import { SocketPreview } from './SocketPreview';
import { useTimelessTables } from './useTimelessTables';
import './timeless.css';
import { label as lbl, tr } from '../i18n';

interface Saved {
  jewelType: number;
  conqueror: number;
  dv1: number;
  dv2: number;
  socketId: number;
  socketFilter: boolean;
  distance: number;
  socketAllocate: boolean;
  searchList: string;
  searchListFallback: string;
  fallbackMode: string;
  totalMin: string;
  tradeType: number;
  realm: string;
  league: string;
  searchMore: boolean;
}

const DEFAULTS: Saved = { jewelType: 1, conqueror: 1, dv1: 1, dv2: 1, socketId: -1, socketFilter: false, distance: 0, socketAllocate: false, searchList: '', searchListFallback: '', fallbackMode: '', totalMin: '', tradeType: 0, realm: 'PC', league: '', searchMore: false };
const KEY = 'pom.timeless.v1';
/** The choices that are not part of upstream's `TimelessData` (trade link settings and the total minimum). */
const LOCAL_KEYS = ['totalMin', 'tradeType', 'realm', 'league', 'searchMore'] as const;

function num(v: string | undefined, d: number): number {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? n : d;
}

/** The dialog's starting choices: what the build file holds, then the local trade settings. */
function loadSaved(xml: string): Saved {
  const out: Saved = { ...DEFAULTS };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const l = JSON.parse(raw) as Partial<Saved>;
      for (const k of LOCAL_KEYS) if (l[k] !== undefined) (out as unknown as Record<string, unknown>)[k] = l[k];
    }
  } catch {
    /* defaults */
  }
  const td = readTimelessData(xml);
  if (td) {
    out.jewelType = JEWEL_TYPES.some((j) => j.id === num(td.jewelTypeId, 1)) ? num(td.jewelTypeId, 1) : 1;
    out.conqueror = num(td.conquerorTypeId, 1);
    out.dv1 = num(td.devotionVariant1, 1);
    out.dv2 = num(td.devotionVariant2, 1);
    out.socketId = num(td.jewelSocketId, -1);
    out.fallbackMode = POWER_STATS[num(td.fallbackWeightModeIdx, 1) - 1]?.stat ?? '';
    out.socketFilter = td.socketFilter === 'true';
    out.socketAllocate = td.socketAllocate === 'true';
    out.distance = num(td.socketFilterDistance, 0);
    out.searchList = td.searchList ?? '';
    out.searchListFallback = td.searchListFallback ?? '';
  }
  return out;
}

/** The build file's `TimelessData` attributes for the choices (`Build.lua` `SaveDB`). */
function savedAttrs(s: Saved): Record<string, string | undefined> {
  const idx = POWER_STATS.findIndex((p) => p.stat === s.fallbackMode);
  return {
    jewelTypeId: String(s.jewelType),
    conquerorTypeId: String(s.conqueror),
    devotionVariant1: String(s.dv1),
    devotionVariant2: String(s.dv2),
    jewelSocketId: String(s.socketId),
    fallbackWeightModeIdx: idx >= 0 ? String(idx + 1) : undefined,
    socketFilter: s.socketFilter ? 'true' : undefined,
    socketAllocate: s.socketAllocate ? 'true' : undefined,
    socketFilterDistance: String(s.distance),
    searchList: s.searchList,
    searchListFallback: s.searchListFallback,
  };
}

const PAGE = 200;

type Phase = { k: 'idle' } | { k: 'running'; progress: number; seeds: number } | { k: 'done'; ms: number } | { k: 'error'; text: string };

function Tip({ lines, children }: { lines: string[]; children: ReactNode }) {
  return <span title={lines.join('\n')} className="tl-tip">{children}</span>;
}

function Section({ icon, title }: { icon: string; title: string }) {
  return (
    <div className="tl-section">
      <Icon name={icon} size={14} />
      <span>{title}</span>
      <i />
    </div>
  );
}

function Field({ label, tip, children, wide, dim }: { label: string; tip?: string[]; children: ReactNode; wide?: boolean; dim?: boolean }) {
  return (
    <div className={'tl-field' + (wide ? ' wide' : '') + (dim ? ' dim' : '')}>
      <span className="lbl" title={tip?.join('\n')}>{label}</span>
      {children}
    </div>
  );
}

function linesFor(eng: EngineBuild, changed: StatDelta[], fmt: NumberFormat): CompareLine[] {
  if (!changed.length) return [];
  const after = { ...eng.stats };
  for (const d of changed) {
    if (d.after === null) delete after[d.statId];
    else after[d.statId] = d.after;
  }
  return compareLines(eng.stats, normaliseOutput(after), eng.flags, fmt);
}

export function TimelessDialog({ eng, fmt, xml, onSave, onClose }: { eng: EngineBuild; fmt: NumberFormat; xml: string; onSave: (attrs: Record<string, string | undefined>) => void; onClose: () => void }) {
  const toast = useToast();
  const buildId = eng.buildId;
  const [s, setS] = useState<Saved>(() => loadSaved(xml));
  const set = useCallback((p: Partial<Saved>) => setS((cur) => ({ ...cur, ...p })), []);
  // The trade settings stay on this machine; the rest goes into the build text, where upstream keeps it.
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(LOCAL_KEYS.map((k) => [k, s[k]]))));
    } catch {
      /* not saved */
    }
  }, [s]);
  const xmlRef = useRef(xml);
  xmlRef.current = xml;
  useEffect(() => {
    const attrs = savedAttrs(s);
    const t = window.setTimeout(() => {
      const have = readTimelessData(xmlRef.current);
      const same = have ? Object.entries(attrs).every(([k, v]) => (have[k] ?? undefined) === v) : JSON.stringify(attrs) === JSON.stringify(savedAttrs({ ...DEFAULTS }));
      if (!same) onSave(attrs);
    }, 300);
    return () => window.clearTimeout(t);
  }, [s, onSave]);

  // ---- what the engine knows about the build -------------------------------------------------------------------------
  const [info, setInfo] = useState<TimelessInfo | null>(null);
  const [infoErr, setInfoErr] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const loadInfo = useCallback(async () => {
    if (!buildId) return;
    setChecking(true);
    try {
      setInfo(await engineSend('timelessInfo', { buildId }));
      setInfoErr(null);
    } catch (e) {
      setInfoErr(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  }, [buildId]);
  useEffect(() => {
    void loadInfo();
  }, [loadInfo, eng.rev]);

  const [mods, setMods] = useState<TimelessMod[]>([]);
  useEffect(() => {
    if (!buildId) return;
    let alive = true;
    void engineSend('timelessMods', { buildId, jewelType: s.jewelType }).then((r) => alive && setMods(r.mods), () => alive && setMods([]));
    return () => {
      alive = false;
    };
  }, [buildId, s.jewelType]);

  // The jewel type's own table decides: a package without one table (Zorath) still searches the others.
  const tables = useTimelessTables(true);
  const missing = info?.data.missing ?? [];
  const installed = !!info && !missing.includes('NodeIndexMapping.lua') && !missing.includes(TABLE_OF[s.jewelType] ?? '');
  const inflating = tables?.state === 'inflating';
  const tablesState = tables?.state;
  useEffect(() => {
    if (tablesState === 'ready') void loadInfo();
  }, [tablesState, loadInfo]);
  const jewel = JEWEL_TYPES.find((j) => j.id === s.jewelType) ?? JEWEL_TYPES[0]!;
  const conquerors = CONQUERORS[s.jewelType] ?? CONQUERORS[1]!;
  const sockets: TimelessSocket[] = info?.sockets ?? [{ id: -1, label: tr('timeless_TimelessDialog.all_sockets'), keystone: tr('timeless_TimelessDialog.multi_socket_search'), allocated: false }];
  const socket = sockets.find((x) => x.id === s.socketId) ?? sockets[0]!;
  const socketLabel = (x: TimelessSocket) => (x.id === -1 ? x.label : x.label.replace(/^# /, '') + (x.allocated ? '' : ''));

  // ---- node weights --------------------------------------------------------------------------------------------------
  const [view, setView] = useState<'desired' | 'fallback'>('desired');
  const [nodeId, setNodeId] = useState('');
  const [sl, setSl] = useState<SliderValues>({ w1: 1, w2: 1, min: 0 });
  const node = mods.find((m) => m.id && m.id === nodeId);
  const statCount = node?.statCount ?? 0;
  const slider2On = !nodeId || statCount > 1;
  const listKey = view === 'desired' ? 'searchList' : 'searchListFallback';
  const listText = s[listKey];

  const writeWeights = (next: SliderValues) => {
    setSl(next);
    if (nodeId) set({ [listKey]: setRowWeights(listText, nodeId, weightsOf(next)) } as Partial<Saved>);
  };

  const chooseNode = (id: string) => {
    setNodeId(id);
    if (!id) return;
    const m = mods.find((x) => x.id === id);
    let cur = sl;
    if ((m?.statCount ?? 0) <= 1) cur = { ...cur, w2: 0 };
    const r = pickNode(listText, id, weightsOf(cur));
    if (r.existing) setSl(sliderValuesOf(r.existing));
    else {
      setSl(cur);
      set({ [listKey]: r.text } as Partial<Saved>);
    }
  };

  const changeJewel = (id: number) => {
    setNodeId('');
    set({ jewelType: id, conqueror: 1, searchList: '', searchListFallback: '' });
  };

  // ---- protect list (Militant Faith) -----------------------------------------------------------------------------------
  const [protect, setProtect] = useState<Record<string, boolean>>({});
  const protectOptions = useMemo(() => ((s.jewelType === 4 || s.jewelType === 11) && s.socketFilter && socket.id !== -1 ? (s.jewelType === 11 ? info?.ascendancyNotables ?? [] : socket.allocatedNotables ?? []) : []), [s.jewelType, s.socketFilter, socket, info]);
  useEffect(() => setProtect({}), [s.jewelType, s.socketFilter, s.socketId]);

  // ---- the search ---------------------------------------------------------------------------------------------------------
  const [phase, setPhase] = useState<Phase>({ k: 'idle' });
  const run = useRef(0);
  const [rows, setRows] = useState<TimelessRow[]>([]);
  const [total, setTotal] = useState(0);
  const [desired, setDesired] = useState<TimelessRows['desired']>([]);
  const [sel, setSel] = useState<number | null>(null);
  const [hi, setHi] = useState<number | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const alt = useRef(new Map<string, { a: number; b: number }>());
  const listRef = useRef<HTMLDivElement>(null);
  const loading = useRef(false);

  const stop = useCallback(() => {
    run.current++;
    if (buildId) void engineSend('timelessCancel', { buildId }).catch(() => undefined);
  }, [buildId]);
  useEffect(() => () => stop(), [stop]);

  const clearResults = () => {
    setRows([]);
    setTotal(0);
    setSel(null);
    setHi(null);
    setAdded(new Set());
    lastTrade.current = null;
  };

  const startSearch = async () => {
    if (!buildId || phase.k === 'running') return;
    const my = ++run.current;
    clearResults();
    setPhase({ k: 'running', progress: 0, seeds: 0 });
    const t0 = performance.now();
    try {
      const totalMin = s.totalMin.trim() === '' ? null : Number(s.totalMin);
      await engineSend('timelessStart', {
        buildId,
        search: {
          jewelType: s.jewelType,
          socketId: s.socketId,
          socketFilter: s.socketFilter,
          socketFilterDistance: s.distance,
          totalMinimumWeight: totalMin !== null && Number.isFinite(totalMin) ? totalMin : null,
          searchList: s.searchList,
          searchListFallback: s.searchListFallback,
          protected: protectOptions.filter((o) => protect[o.label]).map((o) => o.label),
        },
      });
      for (;;) {
        if (my !== run.current) return;
        const st = await engineSend('timelessStep', { buildId, budgetMs: 30 });
        if (my !== run.current) return;
        if (st.done) break;
        setPhase({ k: 'running', progress: st.progress, seeds: st.seedsDone ?? 0 });
        await new Promise((r) => setTimeout(r, 0));
      }
      const first = await engineSend('timelessRows', { buildId, from: 0, count: PAGE });
      if (my !== run.current) return;
      setRows(first.rows);
      setTotal(first.total);
      setDesired(first.desired);
      setSel(first.total > 0 ? 0 : null);
      setPhase({ k: 'done', ms: Math.round(performance.now() - t0) });
    } catch (e) {
      if (my === run.current) setPhase({ k: 'error', text: e instanceof Error ? e.message : String(e) });
    }
  };

  const loadMore = useCallback(async () => {
    if (!buildId || loading.current || rows.length >= total) return;
    loading.current = true;
    try {
      const r = await engineSend('timelessRows', { buildId, from: rows.length, count: PAGE });
      setRows((cur) => (cur.length === rows.length ? [...cur, ...r.rows] : cur));
    } finally {
      loading.current = false;
    }
  }, [buildId, rows.length, total]);

  const reset = () => {
    stop();
    setNodeId('');
    set({ searchList: '', searchListFallback: '' });
    setProtect({});
    clearResults();
    setPhase({ k: 'idle' });
  };

  // ---- adding a jewel -------------------------------------------------------------------------------------------------------
  const rowKey = (r: TimelessRow) => `${r.socketId ?? ''}:${r.seed}`;
  const addRow = async (r: TimelessRow) => {
    if (added.has(rowKey(r))) return;
    const pick = { jewelType: s.jewelType, conqueror: s.conqueror, devotion1: s.dv1, devotion2: s.dv2 };
    try {
      const made = jewelItemText(pick, r, socket.keystone, alt.current.get(rowKey(r)));
      if (made.alt) alt.current.set(rowKey(r), made.alt);
      const socketId = r.socketId ?? socket.id;
      const target = s.socketAllocate && socketId !== -1 && sockets.find((x) => x.id === socketId)?.allocated ? socketId : null;
      await eng.editXml((xml) => {
        const a = addItem(xml, made.text);
        return target !== null ? setJewel(a.xml, target, a.id) : a.xml;
      });
      setAdded((cur) => new Set(cur).add(rowKey(r)));
      toast({ text: tr('timeless_TimelessDialog.label_seed_was_successfully_added', { label: jewel.label, seed: r.seed, target: target !== null ? '' : '' }), kind: 'ok' });
    } catch (e) {
      toast({ text: tr('timeless_TimelessDialog.the_jewel_was_not_added', { value: e instanceof Error ? e.message : String(e) }), kind: 'error' });
    }
  };

  // ---- hover details -----------------------------------------------------------------------------------------------------------
  const [tip, setTip] = useState<{ row: TimelessRow; x: number; y: number } | null>(null);
  const [tipLines, setTipLines] = useState<CompareLine[] | null>(null);
  const tipSeq = useRef(0);
  const hoverRow = (r: TimelessRow, el: HTMLElement) => {
    const b = el.getBoundingClientRect();
    setTip({ row: r, x: b.left, y: b.top });
    setTipLines(null);
    const my = ++tipSeq.current;
    window.setTimeout(() => {
      if (my !== tipSeq.current) return;
      const pick = { jewelType: s.jewelType, conqueror: s.conqueror, devotion1: s.dv1, devotion2: s.dv2 };
      const made = jewelItemText(pick, r, socket.keystone, alt.current.get(rowKey(r)));
      if (made.alt) alt.current.set(rowKey(r), made.alt);
      const socketId = r.socketId ?? socket.id;
      const target = s.socketAllocate && socketId !== -1 && sockets.find((x) => x.id === socketId)?.allocated ? socketId : null;
      void (async () => {
        try {
          const id = eng.buildId;
          if (!id) return;
          const { buildXml } = await engineSend('getBuildXml', { buildId: id });
          const a = addItem(buildXml, made.text);
          const xml = target !== null ? setJewel(a.xml, target, a.id) : a.xml;
          const res = await eng.preview({ kind: 'setXml', xml });
          if (my === tipSeq.current) setTipLines(linesFor(eng, res.changed, fmt));
        } catch {
          if (my === tipSeq.current) setTipLines([]);
        }
      })();
    }, 180);
  };
  const leaveRow = () => {
    tipSeq.current++;
    setTip(null);
  };

  // ---- trade ----------------------------------------------------------------------------------------------------------------------
  const [leagues, setLeagues] = useState<string[]>([]);
  const [leagueErr, setLeagueErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void window.pom.app.tradeLeagues(s.realm.toLowerCase()).then((r) => {
      if (!alive) return;
      const v = r.ok ? r.value : { leagues: ['Standard', 'Hardcore', 'Ruthless', 'Hardcore Ruthless'], error: r.error };
      const perm = ['Standard', 'Hardcore', 'Ruthless', 'Hardcore Ruthless'];
      const list = [...new Set([...v.leagues.filter((l) => !perm.includes(l)), ...perm])];
      setLeagues(list);
      setLeagueErr(v.error ?? null);
      setS((cur) => (cur.league && list.includes(cur.league) ? cur : { ...cur, league: list[0] ?? 'Standard' }));
    });
    return () => {
      alive = false;
    };
  }, [s.realm]);
  const lastTrade = useRef<[number, number] | null>(null);
  const [tradeLabel, setTradeLabel] = useState(tr('timeless_TimelessDialog_2.open_trade_url'));
  useEffect(() => setTradeLabel(tr('timeless_TimelessDialog_2.open_trade_url')), [total]);
  const openTrade = async () => {
    if (!rows.length) return;
    const range = tradeRange({ count: total, sel: (sel ?? 0) + 1, highlight: hi === null ? null : hi + 1, more: s.searchMore, conqueror: s.conqueror, last: lastTrade.current });
    if (!range) return;
    let have = rows;
    if (buildId && range.start - 1 + range.seedCount > rows.length) {
      const r = await engineSend('timelessRows', { buildId, from: rows.length, count: range.start - 1 + range.seedCount - rows.length });
      have = [...rows, ...r.rows];
      setRows(have);
    }
    setSel(range.start - 1);
    setHi(range.end - 1);
    lastTrade.current = [range.start, range.seedCount];
    const seeds = have.slice(range.start - 1, range.start - 1 + range.seedCount).map((r) => r.seed);
    const url = tradeUrl({ jewelType: s.jewelType, conqueror: s.conqueror, devotion1: s.dv1, devotion2: s.dv2, seeds, tradeType: s.tradeType, realm: s.realm, league: s.league || 'Standard' });
    void navigator.clipboard?.writeText(url).catch(() => undefined);
    const r = await window.pom.app.openExternal(url);
    if (!r.ok) toast({ text: tr('timeless_TimelessDialog.the_trade_page_did_not'), kind: 'error' });
    setTradeLabel(tr('timeless_TimelessDialog_2.open_next_trade_url'));
  };

  // ---- fallback weights ------------------------------------------------------------------------------------------------------------
  const powerStats = POWER_STATS;
  const mode = s.fallbackMode || powerStats[0]?.stat || '';
  const [generating, setGenerating] = useState(false);
  const generate = async () => {
    if (!buildId || generating) return;
    setGenerating(true);
    try {
      const r = await engineSend('timelessFallback', { buildId, jewelType: s.jewelType, stat: mode });
      set({ searchListFallback: r.list });
      setView('fallback');
      toast({ text: tr('timeless_TimelessDialog.fallback_weights_generated'), kind: 'ok' });
    } catch (e) {
      toast({ text: tr('timeless_TimelessDialog.the_weights_were_not_generated', { value: e instanceof Error ? e.message : String(e) }), kind: 'error' });
    } finally {
      setGenerating(false);
    }
  };

  // ---- render -----------------------------------------------------------------------------------------------------------------------
  const running = phase.k === 'running';
  const desiredCols = desired.filter((d) => d.idx <= 8).sort((a, b) => a.idx - b.idx);
  const colsStyle = { gridTemplateColumns: `76px repeat(${Math.max(desiredCols.length, 1)}, minmax(44px, 1fr)) 70px` };
  // Many desired nodes make many columns: the table scrolls sideways inside its own frame instead of widening the dialog.
  const tableMin = 76 + Math.max(desiredCols.length, 1) * 44 + 70 + (Math.max(desiredCols.length, 1) + 1) * 10 + 24;
  const rowsText = view === 'desired' ? s.searchList : s.searchListFallback;
  const parsedCount = parseRows(rowsText).length;
  const searchDisabled = !installed || running || !buildId;
  const status = info?.data;

  return createPortal(
    <Dialog
      size="large"
      icon="info"
      title={tr('timeless_TimelessDialog.find_a_timeless_jewel')}
      cancelLabel={tr('timeless_TimelessDialog.cancel')}
      confirmLabel={running ? tr('timeless_TimelessDialog.stop') : tr('timeless_TimelessDialog.search')}
      confirmIcon={running ? 'x' : 'search'}
      confirmDisabled={!running && searchDisabled}
      onCancel={onClose}
      onConfirm={() => (running ? (stop(), setPhase({ k: 'idle' })) : void startSearch())}
      altLabel={tr('timeless_TimelessDialog.reset')}
      altIcon="reset"
      onAlt={reset}
      note={phase.k === 'done' ? tr(total === 1 ? 'h_c_Tl.results_one' : 'h_c_Tl.results_other', { n: total.toLocaleString(), ms: phase.ms }) : phase.k === 'error' ? phase.text : undefined}
    >
      <div className="tl-root">
        {status && !installed && (
          <div className="tl-missing" role="alert">
            <Icon name="warning" size={18} />
            <div>
              <b>{tr('timeless_TimelessDialog.the_timeless_jewel_data_is')}</b>
              {inflating ? (
                <p>
                  {tr('timeless_TimelessDialog.unpacking_the_tables_from_the', { percent: tables?.percent ?? 0, current: tables?.current ?? 'starting' })}
                </p>
              ) : tables?.state === 'error' ? (
                <p>{tr('timeless_TimelessDialog.the_tables_could_not_be', { error: tables.error })} <code>{status.dir}</code>.</p>
              ) : (
                <p>
                  {tr('timeless_TimelessDialog.the')} {JEWEL_TYPES.find((j) => j.id === s.jewelType)?.label} {tr('timeless_TimelessDialog.table_is_read_from')} <code>{status.dir || tr('timeless_TimelessDialog.a_folder_that_is_not')}</code>{tr('timeless_TimelessDialog.missing_join', { value: missing.join(', ') || 'the folder' })}
                </p>
              )}
            </div>
            <button type="button" className="btn sm" onClick={() => void loadInfo()}>
              {checking || inflating ? <span className="spinner" /> : <Icon name="reset" size={14} />}{tr('timeless_TimelessDialog.check_again')}
            </button>
          </div>
        )}
        {infoErr && <div className="tl-missing" role="alert"><Icon name="error" size={18} /><div><b>{tr('timeless_TimelessDialog.the_engine_could_not_list')}</b><p>{infoErr}</p></div></div>}

        <Section icon="jewel" title={tr('timeless_TimelessDialog.jewel')} />
        <div className="tl-grid">
          <Field label={tr('timeless_TimelessDialog.jewel_type')}>
            <Select ariaLabel={tr('timeless_TimelessDialog.jewel_type_2')} value={String(s.jewelType)} options={JEWEL_TYPES.map((j) => ({ value: String(j.id), label: j.label }))} width="100%" onChange={(v) => changeJewel(Number(v))} />
          </Field>
          <Field label={tr('timeless_TimelessDialog.conqueror')}>
            <Select ariaLabel={tr('timeless_TimelessDialog.conqueror_2')} value={String(s.conqueror)} options={conquerors.map((c) => ({ value: String(c.id), label: c.label }))} width="100%" onChange={(v) => set({ conqueror: Number(v) })} />
          </Field>
          <Field label={tr('timeless_TimelessDialog.jewel_socket')}>
            <div className="tl-socket">
              <div className="grow">
              <Select ariaLabel={tr('timeless_TimelessDialog.jewel_socket_2')} value={String(socket.id)} options={sockets.map((x) => ({ value: String(x.id), label: socketLabel(x), hint: x.id === -1 ? tr('timeless_TimelessDialog.every_socket') : x.allocated ? tr('timeless_TimelessDialog.allocated') : undefined }))} width="100%" onChange={(v) => set({ socketId: Number(v) })} />
              </div>
              {socket.preview && socket.preview.length > 0 && <SocketPreview socket={socket} treeVersion={info?.treeVersion ?? '3_29'} />}
            </div>
          </Field>
          <Field label={tr('timeless_TimelessDialog.socket_jewel')} tip={TIPS.socketAllocate}>
            <Tip lines={TIPS.socketAllocate}><Switch checked={s.socketAllocate} label={tr('timeless_TimelessDialog.socket_jewel_2')} onChange={(v) => set({ socketAllocate: v })} /></Tip>
          </Field>
          {s.jewelType === 11 && (
            <Field label={tr('timeless_TimelessDialog.required_ascendancy_outcome')}>
              <Select
                ariaLabel={tr('timeless_TimelessDialog.required_ascendancy_outcome_2')}
                value={outcomeOf(s.searchList) ?? ''}
                options={[{ value: '', label: tr('timeless_TimelessDialog.any') }, ...(info?.ascendancyOutcomes ?? []).map((o) => ({ value: o.id, label: o.label }))]}
                width="100%"
                onChange={(v) => set({ searchList: withOutcome(s.searchList, v || null) })}
              />
            </Field>
          )}
          {s.jewelType === 4 && (
            <>
              <Field label={tr('timeless_TimelessDialog.devotion_modifiers')}>
                <Select ariaLabel={tr('timeless_TimelessDialog.devotion_modifier_1')} value={String(s.dv1)} options={DEVOTION_VARIANTS.map((d) => ({ value: String(d.id), label: d.label }))} width="100%" onChange={(v) => set({ dv1: Number(v) })} />
              </Field>
              <Field label=" ">
                <Select ariaLabel={tr('timeless_TimelessDialog.devotion_modifier_2')} value={String(s.dv2)} options={DEVOTION_VARIANTS.map((d) => ({ value: String(d.id), label: d.label }))} width="100%" onChange={(v) => set({ dv2: Number(v) })} />
              </Field>
            </>
          )}
        </div>

        <Section icon="search" title={tr('timeless_TimelessDialog.search_2')} />
        <div className="tl-grid">
          <Field label={tr('timeless_TimelessDialog.search_for_node')}>
            <Select
              ariaLabel={tr('timeless_TimelessDialog.search_for_node_2')}
              value={nodeId}
              options={mods.map((m) => ({ value: m.id ?? '', label: m.id ? m.label.replace(/\s{2,}.*$/, '') : m.label, hint: m.id && m.descriptions?.length ? m.descriptions.join(' · ') : undefined }))}
              width="100%"
              onChange={chooseNode}
            />
          </Field>
          <Field label={tr('timeless_TimelessDialog.filter_nodes')} tip={TIPS.socketFilter}>
            <div className="tl-inline">
              <Tip lines={TIPS.socketFilter}><Switch checked={s.socketFilter} label={tr('timeless_TimelessDialog.filter_nodes_2')} onChange={(v) => set({ socketFilter: v })} /></Tip>
              {s.socketFilter && (
                <span className="tl-slider small" title={TIPS.distance.join('\n')}>
                  <span className="lbl">{tr('timeless_TimelessDialog.node_distance')}</span>
                  <input type="range" min={0} max={10} step={1} value={s.distance} aria-label={tr('timeless_TimelessDialog.node_distance_2')} onChange={(e) => set({ distance: Number(e.target.value) })} />
                  <b>{s.distance}</b>
                </span>
              )}
            </div>
          </Field>
          <Field label={tr('timeless_TimelessDialog.primary_node_weight')} tip={TIPS.slider1(node?.stat1 ?? 'None')}>
            <div className="tl-slider" title={TIPS.slider1(node?.stat1 ?? 'None').join('\n')}>
              <input type="range" min={0} max={1000} step={1} value={Math.round(sl.w1 * 100)} aria-label={tr('timeless_TimelessDialog.primary_node_weight_2')} onChange={(e) => writeWeights({ ...sl, w1: Number(e.target.value) / 100 })} />
              <b>{sl.w1.toFixed(3)}</b>
            </div>
          </Field>
          <Field label={tr('timeless_TimelessDialog.secondary_node_weight')} dim={!slider2On} tip={TIPS.slider2(node?.stat2 ?? 'None')}>
            <div className="tl-slider" title={TIPS.slider2(node?.stat2 ?? 'None').join('\n')}>
              <input type="range" min={0} max={1000} step={1} disabled={!slider2On} value={Math.round((slider2On ? sl.w2 : 0) * 100)} aria-label={tr('timeless_TimelessDialog.secondary_node_weight_2')} onChange={(e) => writeWeights({ ...sl, w2: Number(e.target.value) / 100 })} />
              <b>{(slider2On ? sl.w2 : 0).toFixed(3)}</b>
            </div>
          </Field>
          <Field label={tr('timeless_TimelessDialog.minimum_node_weight')} tip={TIPS.slider3}>
            <div className="tl-slider" title={TIPS.slider3.join('\n')}>
              <input type="range" min={0} max={500} step={1} value={sl.min} aria-label={tr('timeless_TimelessDialog.minimum_node_weight_2')} onChange={(e) => writeWeights({ ...sl, min: Number(e.target.value) })} />
              <b>{sl.min >= 500 ? tr('timeless_TimelessDialog.required') : Math.round(sl.min)}</b>
            </div>
          </Field>
          <Field label={tr('timeless_TimelessDialog.total_minimum_weight')} tip={TIPS.total}>
            <input className="input tl-total" inputMode="decimal" aria-label={tr('timeless_TimelessDialog.total_minimum_weight_2')} title={TIPS.total.join('\n')} value={s.totalMin} onChange={(e) => set({ totalMin: e.target.value.replace(/[^0-9.\-]/g, '') })} placeholder="0" />
          </Field>
          <Field label={tr('timeless_TimelessDialog.fallback_weight_mode')} wide>
            <div className="tl-inline">
              <Select ariaLabel={tr('timeless_TimelessDialog.fallback_weight_mode_2')} value={mode} options={powerStats.map((p) => ({ value: p.stat, label: tr('h_c_Tl.sort_by', { stat: lbl(p.label) }) }))} width={220} onChange={(v) => set({ fallbackMode: v })} />
              <button type="button" className="btn sm" title={TIPS.generate.join('\n')} onClick={() => void generate()} aria-disabled={!buildId || generating || undefined}>
                {generating ? <span className="spinner" /> : <Icon name="sparkle" size={14} />}{tr('timeless_TimelessDialog.generate')}
              </button>
            </div>
          </Field>
        </div>

        {protectOptions.length > 0 && (
          <>
            <Section icon="shield" title={tr('timeless_TimelessDialog.protect_allocated_nodes_from_changin')} />
            <div className="tl-protect">
              {protectOptions.map((o) => (
                <label key={o.id}>
                  <input type="checkbox" checked={!!protect[o.label]} onChange={(e) => setProtect((cur) => ({ ...cur, [o.label]: e.target.checked }))} />
                  {o.label}
                </label>
              ))}
            </div>
          </>
        )}

        <div className="tl-split">
          <div className="tl-lists">
            <div className="seg tl-tabs" data-lg="tile" role="tablist" aria-label={tr('timeless_TimelessDialog.weight_lists')}>
              <button type="button" role="tab" aria-selected={view === 'desired'} title={TIPS.desired.join('\n')} onClick={() => setView('desired')}>{tr('timeless_TimelessDialog.desired_nodes')}</button>
              <button type="button" role="tab" aria-selected={view === 'fallback'} title={TIPS.fallback.join('\n')} onClick={() => setView('fallback')}>{tr('timeless_TimelessDialog.fallback_nodes')}</button>
            </div>
            <textarea
              className="tl-list"
              aria-label={view === 'desired' ? tr('timeless_TimelessDialog.desired_nodes') : tr('timeless_TimelessDialog.fallback_nodes')}
              spellCheck={false}
              value={rowsText}
              placeholder={tr('timeless_TimelessDialog.node_id_primary_weight_secondary')}
              onChange={(e) => set({ [listKey]: e.target.value } as Partial<Saved>)}
            />
            <span className="tl-count">{tr('timeless_TimelessDialog.count_rows', { count: parsedCount })}</span>
          </div>

          <div className="tl-results">
            <Section icon="list-ordered" title={tr('timeless_TimelessDialog.results')} />
            <div className="tl-table"><div className="tl-table-in" style={{ minWidth: tableMin }}>
            <div className="tl-rows-head" style={colsStyle} aria-hidden="true">
              <span>{tr('timeless_TimelessDialog.seed')}</span>
              {desiredCols.length === 0 ? <span /> : desiredCols.map((d) => <span key={d.id} title={d.displayName}>{d.displayName}</span>)}
              <span className="r">{tr('timeless_TimelessDialog.total')}</span>
            </div>
            <div
              className="tl-rows"
              ref={listRef}
              role="listbox"
              aria-label={tr('timeless_TimelessDialog.results_2')}
              tabIndex={0}
              onScroll={(e) => {
                const el = e.currentTarget;
                if (el.scrollTop + el.clientHeight > el.scrollHeight - 300) void loadMore();
              }}
              onKeyDown={(e) => {
                if (!rows.length) return;
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setSel((v) => Math.min((v ?? -1) + 1, rows.length - 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setSel((v) => Math.max((v ?? 1) - 1, 0));
                } else if (e.key === 'Enter' && sel !== null && rows[sel]) {
                  e.preventDefault();
                  void addRow(rows[sel]!);
                }
              }}
            >
              {running && (
                <div className="tl-state"><span className="spinner" />{tr('timeless_TimelessDialog.searching_progress', { progress: phase.progress })}<span className="sub">{tr('timeless_TimelessDialog.tolocalestring_seeds_checked', { seeds: phase.seeds.toLocaleString() })}</span></div>
              )}
              {!running && rows.length === 0 && (
                <div className="tl-state">{phase.k === 'done' ? tr('timeless_TimelessDialog.no_seed_matches_those_weights') : tr('timeless_TimelessDialog.no_results_yet_pick_the')}</div>
              )}
              {rows.map((r, i) => (
                <div
                  key={rowKey(r)}
                  role="option"
                  aria-selected={sel === i}
                  className={'tl-row' + (sel === i ? ' sel' : '') + (hi !== null && sel !== null && i >= Math.min(sel, hi) && i <= Math.max(sel, hi) ? ' range' : '') + (added.has(rowKey(r)) ? ' added' : '')}
                  style={colsStyle}
                  onClick={(e) => {
                    if (e.shiftKey && sel !== null) setHi(i);
                    else {
                      setSel(i);
                      setHi(null);
                    }
                  }}
                  onDoubleClick={() => void addRow(r)}
                  onMouseEnter={(e) => hoverRow(r, e.currentTarget)}
                  onMouseLeave={leaveRow}
                >
                  <span className="seed">{r.seed.toLocaleString('en-US')}{r.socketLabel && <em title={r.socketLabel}>{r.socketLabel.replace(/^# /, '')}</em>}</span>
                  {desiredCols.length === 0 ? <span /> : desiredCols.map((d) => {
                    const h = r.hits.find((x) => x.id === d.id);
                    return <span key={d.id} className={h ? 'n' : 'n zero'}>{h ? trim(h.weight) : '0'}</span>;
                  })}
                  <span className="r tot">{trim(r.total)}</span>
                </div>
              ))}
              {rows.length > 0 && rows.length < total && <div className="tl-state small">{tr('timeless_TimelessDialog.showing_tolocalestring_of_tolocalest', { count: rows.length.toLocaleString(), total: total.toLocaleString() })}</div>}
            </div>
            </div></div>
          </div>
        </div>

        <div className="tl-trade">
          <span className="tl-more" title={TIPS.searchMore.join('\n')}>
            <Switch checked={s.searchMore} label={tr('timeless_TimelessDialog.search_maximum_amount_2')} onChange={(v) => set({ searchMore: v })} />
            {tr('timeless_TimelessDialog.search_maximum_amount')}
          </span>
          <Select ariaLabel={tr('timeless_TimelessDialog.trade_status')} value={String(s.tradeType)} options={TRADE_TYPES.map((t, i) => ({ value: String(i), label: [tr('items_trader_model.instant_buyout'), tr('h_c_It.tt_instant_inperson'), tr('h_c_It.tt_inperson_league'), tr('h_c_It.tt_inperson_online'), tr('h_c_It.tt_any')][i] ?? t }))} width={210} onChange={(v) => set({ tradeType: Number(v) })} />
          <span className="lbl">{tr('timeless_TimelessDialog.realm')}</span>
          <Select ariaLabel={tr('timeless_TimelessDialog.realm_2')} value={s.realm} options={REALMS.map((r) => ({ value: r, label: r }))} width={86} onChange={(v) => set({ realm: v })} />
          <span className="lbl">{tr('timeless_TimelessDialog.league')}</span>
          <Select ariaLabel={tr('timeless_TimelessDialog.league_2')} value={s.league || leagues[0] || 'Standard'} options={(leagues.length ? leagues : ['Standard']).map((l) => ({ value: l, label: l }))} width={160} onChange={(v) => set({ league: v })} />
          <button type="button" className="btn" data-lg="control" title={TIPS.trade.join('\n')} aria-disabled={!rows.length || undefined} onClick={() => rows.length && void openTrade()}>
            <Icon name="external" size={15} />{tradeLabel}
          </button>
        </div>
        {leagueErr && <div className="tl-msg">{tr('timeless_TimelessDialog.error_fetching_league_list_default', { leagueErr })}</div>}
      </div>
      {tip && createPortal(<RowTip tip={tip} jewelLabel={jewel.label} desired={desired} lines={tipLines} socketAllocate={s.socketAllocate} socket={socket} sockets={sockets} added={added.has(rowKey(tip.row))} />, document.body)}
    </Dialog>,
    document.querySelector('.stage') ?? document.body,
  );
}

function trim(x: number): string {
  return String(Math.round(x * 1000) / 1000);
}

function RowTip({ tip, jewelLabel, desired, lines, socketAllocate, socket, sockets, added }: { tip: { row: TimelessRow; x: number; y: number }; jewelLabel: string; desired: TimelessRows['desired']; lines: CompareLine[] | null; socketAllocate: boolean; socket: TimelessSocket; sockets: TimelessSocket[]; added: boolean }) {
  const r = tip.row;
  const target = sockets.find((x) => x.id === (r.socketId ?? socket.id));
  const w = 340;
  const left = Math.max(8, Math.min(tip.x - w - 12, window.innerWidth - w - 8));
  const top = Math.max(8, Math.min(tip.y - 20, window.innerHeight - 380));
  const byId = new Map(desired.map((d) => [d.id, d]));
  return (
    <div className="tl-tip-box" data-lg="pop" style={{ left, top, width: w }} role="tooltip">
      <div className="head">{added ? tr('timeless_TimelessDialog.jewellabel_seed_was_successfully_add', { jewelLabel, seed: r.seed }) : tr('timeless_TimelessDialog.double_click_to_add_this')}</div>
      {!added && socketAllocate && (target?.allocated ? <div className="sub">{tr('timeless_TimelessDialog.it_will_be_socketed_into', { label: r.socketLabel ?? target.label })}</div> : <div className="warn">{tr('timeless_TimelessDialog.that_jewel_socket_is_not')}</div>)}
      {r.hits.length > 0 && (
        <div className="nodes">
          <div className="cap">{tr('timeless_TimelessDialog.node_list')}</div>
          {[...r.hits].sort((a, b) => a.idx - b.idx).map((h) => (
            <div key={h.id}>
              <div className="nm">{byId.get(h.id)?.displayName ?? h.id}:</div>
              <div className="list">{h.names.length ? h.names.join(', ') : tr('timeless_TimelessDialog.none')}</div>
            </div>
          ))}
        </div>
      )}
      <div className="sub">{tr('timeless_TimelessDialog.combined_node_weight_totaltext', { totalText: r.totalText })}</div>
      {lines === null ? <div className="sub">{tr('timeless_TimelessDialog.reading_the_stat_changes')}</div> : lines.length > 0 && (
        <div className="diff">
          {lines.slice(0, 14).map((l, i) => (
            <div key={i} className={l.good ? 'up' : 'down'}><span>{l.label}</span><span>{l.value}{l.percent ?? ''}</span></div>
          ))}
        </div>
      )}
    </div>
  );
}
