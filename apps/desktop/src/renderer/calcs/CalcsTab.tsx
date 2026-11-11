import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CalcDetail, CalcModTable, CalcViewRow, CalcViewSection, CalcsViewOut, ItemInfo, SkillGroup, TreeStateNode } from '@pom/protocol';
import type { TreeState } from '../tree';
import { activeGroupsOf, equipped, readFacts, activeSpecOf } from '../../shared/buildFacts';
import {
  cellIsStat,
  collapseKey,
  columnTitles,
  DEFAULT_NUM_FORMAT,
  findStatCell,
  isHeaderRow,
  lookOf,
  rowLook,
  readCalcsInputs,
  calcsDiffersFromMain,
  readSpectres,
  setSpectres,
  searchFilter,
  searchMatch,
  type SearchKeep,
  sectionKind,
  sectionMatches,
  sectionTitle,
  setCalcsInput,
  shownSections,
  skillControls,
  stripCodes,
  type CalcsInputValue,
  type NumFormat,
} from '../../shared/calcsLogic';
import { ATTR } from '../../shared/skillsLogic';
import { mainSkillProbeXml } from '../../shared/mainSkillProbe';
import type { EngineHandle } from '../engineHandle';
import { useHighlight } from '../assistant/bus';
import { artFor } from '../gameArt';
import { gemColour, useGameInfo, useTreeNodes } from '../gameData';
import { ColorText } from '../ColorText';
import { PortalMenu, Switch, Icon } from '../ui';
import type { OpenBuild } from '../types';
import { Popup, type PopupEnv, type PopupTarget } from './Popup';
import { SpectreDialog } from './SpectreDialog';
import { CalcSelect, NumField } from './CalcControls';
import { minionOptions, useSpectreNames } from './spectres';
import { NODE_KIND, useTreeText } from './treeData';
import './calcs.css';
import { pctChange, previewCall, usePreview } from '../preview/preview';
import { previewEngine, pvWaitText, resolvePreview, type PvResult } from '../preview/pvResult';
import { label as lbl, tr } from '../i18n';

export interface CalcsTabProps {
  build: OpenBuild;
  engine: EngineHandle | null;
  fmt?: NumFormat;
}

// What a closed Calcs tab remembers for the build: collapsed sections, scroll position and the search text.
const remembered = new Map<string, { collapsed: Record<string, boolean>; scroll: number; search: string; popped: string[]; popPos: Record<string, { x: number; y: number }> }>();

// Which sections are popped out and where they sit survives a restart: one layout for every build (section ids are the same in all of them).
const POP_KEY = 'pom-calcs-popouts';
function loadPops(): { popped: string[]; popPos: Record<string, { x: number; y: number }> } {
  try {
    const v = JSON.parse(localStorage.getItem(POP_KEY) || '{}') as { popped?: unknown; popPos?: unknown };
    return { popped: Array.isArray(v.popped) ? v.popped.filter((x): x is string => typeof x === 'string') : [], popPos: v.popPos && typeof v.popPos === 'object' ? (v.popPos as Record<string, { x: number; y: number }>) : {} };
  } catch {
    return { popped: [], popPos: {} };
  }
}

const MODES: { value: string; label: string; tip: string }[] = [
  { value: 'UNBUFFED', label: tr('calcs_CalcsTab.unbuffed'), tip: tr('calcs_CalcsTab.no_auras_buffs_or_other') },
  { value: 'BUFFED', label: tr('calcs_CalcsTab.buffed'), tip: tr('calcs_CalcsTab.aura_and_buff_skills_apply') },
  { value: 'COMBAT', label: tr('calcs_CalcsTab.in_combat'), tip: tr('calcs_CalcsTab.charges_and_combat_buffs_such') },
  { value: 'EFFECTIVE', label: tr('calcs_CalcsTab.effective_dps'), tip: tr('calcs_CalcsTab.curses_and_enemy_properties_such') },
];
const MODE_NOTE = tr('calcs_CalcsTab.this_controls_the_calculation_of');

/** A Lua `^xRRGGBB` code as a CSS colour, or undefined. */
const hexOf = (code: string | null | undefined, alpha?: number): string | undefined => {
  const m = code ? /^\^x([0-9A-Fa-f]{6})$/.exec(code) : null;
  if (!m) return undefined;
  if (alpha === undefined) return '#' + m[1];
  const a = Math.round(alpha * 255).toString(16).padStart(2, '0');
  return '#' + m[1] + a;
};

export function CalcsTab({ build, engine, fmt }: CalcsTabProps) {
  const mem = remembered.get(build.id);
  const [data, setData] = useState<CalcsViewOut | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(mem?.collapsed ?? {});
  const [search, setSearch] = useState(mem?.search ?? '');
  // Sections pulled out into their own windows (`CalcSectionControl:ToggleOverlay`) and where each one sits.
  const [saved] = useState(loadPops);
  const [popped, setPopped] = useState<string[]>(mem?.popped ?? saved.popped);
  const [popPos, setPopPos] = useState<Record<string, { x: number; y: number }>>(mem?.popPos ?? saved.popPos);
  useEffect(() => {
    try {
      localStorage.setItem(POP_KEY, JSON.stringify({ popped, popPos }));
    } catch {
      /* storage unavailable */
    }
  }, [popped, popPos]);
  const [spectreOpen, setSpectreOpen] = useState(false);
  const [pop, setPop] = useState<PopupTarget | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const searchBox = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  const timers = useRef<{ enter: number; leave: number }>({ enter: 0, leave: 0 });
  const popRef = useRef<PopupTarget | null>(null);
  popRef.current = pop;
  const info = useGameInfo();
  const buildId = engine?.buildId ?? null;
  const xml = build.xml;
  const inputs = useMemo(() => readCalcsInputs(xml), [xml]);
  const facts = useMemo(() => readFacts(xml), [xml]);
  const treeVersion = activeSpecOf(facts)?.treeVersion ?? '';
  const treeNodes = useTreeNodes(treeVersion.replace('.', '_'));
  const [skills, setSkills] = useState<{ groups: SkillGroup[] } | null>(null);

  // Remember the tab's own state for when it is opened again.
  useEffect(() => {
    const el = body.current;
    return () => {
      remembered.set(build.id, { collapsed: collapsedRef.current, scroll: el?.scrollTop ?? 0, search: searchRef.current, popped: poppedRef.current, popPos: popPosRef.current });
    };
  }, [build.id]);
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;
  const searchRef = useRef(search);
  searchRef.current = search;
  const poppedRef = useRef(popped);
  poppedRef.current = popped;
  const popPosRef = useRef(popPos);
  popPosRef.current = popPos;

  // The Calcs view of the build as it is now: again whenever the build text changes, whichever tab changed it.
  const version = engine?.version ?? 0;
  // Lets a driver (tests, screenshots) find the open build in the engine.
  useEffect(() => {
    (window as unknown as { __pomCalcs?: { buildId: string | null } }).__pomCalcs = { buildId };
  }, [buildId]);
  // The skills list depends on the build, not on which sub-sections are collapsed: a collapse toggle reuses it.
  const skillsLoad = useRef<{ buildId: string; xml: string; version: number; p: Promise<{ state: { groups: SkillGroup[] } }> } | null>(null);
  useEffect(() => {
    if (!engine || build.engine.state !== 'ready') return;
    const mine = ++seq.current;
    setLoading(true);
    const had = skillsLoad.current;
    const skillsP = had && had.buildId === engine.buildId && had.xml === xml && had.version === version ? had.p : engine.call('skillsState', {});
    skillsLoad.current = { buildId: engine.buildId, xml, version, p: skillsP };
    void (async () => {
      try {
        const searching = searchRef.current.trim() !== '';
        const [view, sk] = await Promise.all([engine.call('calcsView', { collapsed }), skillsP.catch((e: unknown) => {
          if (skillsLoad.current?.p === skillsP) skillsLoad.current = null;
          throw e;
        })]);
        if (mine !== seq.current) return;
        // The engine leaves a collapsed sub-section's summary ("0 (0%)", "0, 0, 3") out: read it from the same view with those sub-sections open.
        const shut: Record<string, boolean> = {};
        view.sections.forEach((sec) => sec.subSections.forEach((sub, i) => sub.collapsed && (searching || sub.extra === null) && (shut[collapseKey(sec.id, i)] = false)));
        if (Object.keys(shut).length) {
          const open = await engine.call('calcsView', { collapsed: { ...collapsed, ...shut } }).catch(() => null);
          if (mine !== seq.current) return;
          if (open) view.sections.forEach((sec, si) => sec.subSections.forEach((sub, i) => { if (sub.collapsed && sub.extra === null) sub.extra = open.sections[si]?.subSections[i]?.extra ?? null; }));
          // A search looks inside collapsed sections too (the saved collapsed state is left alone).
          if (searching && open) {
            setData(open);
            setSkills({ groups: sk.state.groups });
            setError(null);
            return;
          }
        }
        setData(view);
        setSkills({ groups: sk.state.groups });
        setError(null);
      } catch (e) {
        if (mine === seq.current) setError((e as Error).message);
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildId, xml, version, collapsed, build.engine.state, search.trim() !== '']);

  // The scroll position survives reloads (the list keeps its place); coming back to the tab restores it.
  useLayoutEffect(() => {
    if (mem && body.current && data) body.current.scrollTop = mem.scroll;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data === null]);

  // The assistant pointed at a stat: open the sub-section it sits in. A collapsed one carries no rows, so look in a view with all open.
  const hl = useHighlight();
  const hlStat = hl?.tab === 'calcs' ? hl.stat : undefined;
  useEffect(() => {
    if (!hlStat || !engine || !data) return;
    let live = true;
    void (async () => {
      const open: Record<string, boolean> = {};
      data.sections.forEach((s) => s.subSections.forEach((_, i) => (open[collapseKey(s.id, i)] = false)));
      const all = await engine.call('calcsView', { collapsed: open }).catch(() => null);
      const at = all && findStatCell(all.sections, hlStat);
      if (!live || !at) return;
      const sec = data.sections.find((s) => s.id === at.sid);
      const shut = [0, at.sub].filter((i) => sec?.subSections[i]?.collapsed);
      if (shut.length) setCollapsed((c) => ({ ...c, ...Object.fromEntries(shut.map((i) => [collapseKey(at.sid, i), false])) }));
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hl?.key, !!data]);

  // ---- breakdown tables, loaded once per build text and only when a popup first needs them ----
  const pv = usePreview();
  // The breakdowns and modifier tables explain the numbers on screen: with preview on they come from the preview engine.
  const explainEngine = useMemo(() => (engine && pv.on ? previewEngine(engine, xml, previewCall) : engine), [engine, xml, pv.on]);
  const tablesRef = useRef<{ xml: string; p: Promise<{ player: Record<string, unknown>; minion: Record<string, unknown> | null }> } | null>(null);
  const [tables, setTables] = useState<Record<string, unknown> | null>(null);
  const showMinion = !!data?.view?.showMinion;
  const loadTables = useCallback(() => {
    if (!explainEngine) return;
    const key = (pv.on ? 'pv:' : '') + xml;
    if (!tablesRef.current || tablesRef.current.xml !== key) {
      tablesRef.current = { xml: key, p: explainEngine.call('getBreakdowns', {}).then((r) => r.breakdowns) };
    }
    const mine = tablesRef.current;
    void mine.p.then((t) => tablesRef.current === mine && setTables((showMinion ? t.minion : t.player) ?? t.player)).catch(() => undefined);
  }, [explainEngine, xml, showMinion, pv.on]);
  useEffect(() => {
    // A pinned popup stays open while the build changes: its tables are read again.
    if (pop) loadTables();
    else setTables(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [xml, version, showMinion, !!pop, pv.on]);

  const modsCache = useRef<Map<string, Promise<CalcModTable | null>>>(new Map());
  useEffect(() => {
    modsCache.current.clear();
  }, [xml, pv.on]);
  const loadMods = useCallback(
    (d: CalcDetail) => {
      const k = JSON.stringify(d);
      let p = modsCache.current.get(k);
      if (!p && explainEngine) {
        p = explainEngine.call('calcsMods', { detail: d }).then((r) => r.table);
        modsCache.current.set(k, p);
      }
      return p ?? Promise.resolve(null);
    },
    [explainEngine],
  );
  // Nodes a cluster jewel adds or a jewel changes are not in the static tree: the engine names them.
  const [generated, setGenerated] = useState<{ xml: string; nodes: Map<number, TreeStateNode>; state: TreeState } | null>(null);
  const treeText = useTreeText(treeVersion.replace('.', '_'));
  useEffect(() => {
    if (!pop || !engine || generated?.xml === xml) return;
    let live = true;
    void engine.call('treeState', {}).then((r) => live && setGenerated({ xml, nodes: new Map([...r.tree.generated, ...r.tree.changed].map((n) => [n.id, n])), state: r.tree as unknown as TreeState })).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [!!pop, xml]); // eslint-disable-line react-hooks/exhaustive-deps
  const equippedItems = useMemo(() => equipped(facts), [facts]);
  const itemCache = useRef<Map<number, Promise<ItemInfo | null>>>(new Map());
  useEffect(() => {
    itemCache.current.clear();
  }, [xml]);
  const env: PopupEnv = useMemo(
    () => ({
      tables,
      loadMods,
      slotItem: (slot) => {
        const it = equippedItems.get(slot);
        return it ? { name: it.name, rarity: it.rarity, id: it.id } : null;
      },
      itemRarity: (id) => facts.items.get(id)?.rarity ?? null,
      loadItem: (id) => {
        let p = itemCache.current.get(id);
        const it = facts.items.get(id);
        if (!p && it && engine) {
          p = engine.call('itemInfo', { itemText: it.raw }).then((r) => r.item).catch(() => null);
          itemCache.current.set(id, p);
        }
        return p ?? Promise.resolve(null);
      },
      treeVersion: treeVersion.replace('.', '_'),
      treeState: generated?.state ?? null,
      node: (id) => {
        const st = treeNodes?.[String(id)];
        const tx = treeText?.get(id);
        if (st || tx) return { n: tx?.n || st?.n || tr('calcs_CalcsTab.node_id', { id }), t: tx ? NODE_KIND[tx.t] ?? 'Passive' : st?.t ?? 'Passive', a: tx?.a ?? st?.a, sp: st?.sp, stats: tx?.s };
        const g = generated?.nodes.get(id);
        return g ? { n: g.name, t: g.kind ?? 'Notable', a: g.ascendancy ?? undefined, stats: g.stats } : undefined;
      },
      fmt: fmt ?? DEFAULT_NUM_FORMAT,
    }),
    [tables, loadMods, equippedItems, facts, engine, treeVersion, treeNodes, treeText, generated, fmt],
  );

  // ---- popups: hover opens after a short rest, a click pins, Esc or a press elsewhere closes ----
  // Next-league preview on: the preview engine's view is shown, each changed cell with its live value under it.
  const [pvRes, setPvRes] = useState<PvResult<CalcsViewOut> | null>(null);
  const pvKey = xml + '\0' + JSON.stringify(collapsed);
  useEffect(() => {
    if (!pv.on || build.engine.state !== 'ready') return;
    let alive = true;
    void previewCall('calcsView', xml, { collapsed }).then((r) => alive && setPvRes({ key: pvKey, val: r.result })).catch(() => alive && setPvRes({ key: pvKey, val: null }));
    return () => {
      alive = false;
    };
  }, [pv.on, xml, collapsed, build.engine.state]); // eslint-disable-line react-hooks/exhaustive-deps
  const { val: pvView, state: pvState } = resolvePreview(pvRes, pvKey, pv.on && build.engine.state === 'ready');
  const liveSecs = useMemo(() => (pv.on && pvView && data ? new Map(data.sections.map((x) => [x.id, x])) : null), [pv.on, pvView, data]);
  const sections = useMemo(() => shownSections((liveSecs ? pvView : data)?.sections ?? []), [data, pvView, liveSecs]);
  const q = search.trim();
  const keeps = useMemo(() => (q ? searchFilter(sections, q) : null), [sections, q]);
  const cellAt = useCallback(
    (key: string): { el: HTMLElement; target: Omit<PopupTarget, 'pinned'> } | null => {
      const el = root.current?.querySelector<HTMLElement>(`[data-ck="${CSS.escape(key)}"]`);
      if (!el) return null;
      if (key.startsWith('list:')) {
        const kind = key.slice(5);
        const minion = !!data?.view?.showMinion;
        const details: CalcDetail[] = kind === 'buff' ? [{ breakdown: 'SkillBuffs', minion }] : kind === 'curse' ? [{ breakdown: 'SkillDebuffs' }] : [];
        return { el, target: { key, cell: el.getBoundingClientRect(), card: (el.closest<HTMLElement>('[data-card]') ?? el).getBoundingClientRect(), title: kind === 'buff' ? tr('calcs_CalcsTab.aura_and_buff_skills') : kind === 'curse' ? tr('calcs_CalcsTab.curses_and_debuffs') : tr('calcs_CalcsTab.combat_buffs'), details } };
      }
      const [sid, a, b, c2] = key.split(':') as [string, string, string, string];
      const [subi, ri, ci] = [Number(a), Number(b), Number(c2)];
      const sec = sections.find((s) => s.id === sid);
      const row = sec?.subSections[subi]?.rows[ri];
      if (!sec || !row) return null;
      const details = row.cellDetails[ci] ?? [];
      const sub = sec.subSections[subi]!;
      const head = sub.rows.slice(0, ri).reverse().find(isHeaderRow);
      const pos = row.cellIdx[ci] ?? ci;
      const col = stripCodes(head ? head.cells[head.cellIdx.indexOf(pos)] ?? '' : sub.columns?.[pos] ?? '').replace(/:$/, '');
      const title = [row.label ?? sub.label, col].filter(Boolean).join(' · ');
      const card = el.closest<HTMLElement>('[data-card]') ?? el;
      return { el, target: { key, cell: el.getBoundingClientRect(), card: card.getBoundingClientRect(), title, text: el.textContent?.trim() || undefined, details } };
    },
    [sections, data],
  );
  const open = useCallback(
    (key: string, pinned: boolean) => {
      const c = cellAt(key);
      if (!c || c.target.details.length === 0) return;
      loadTables();
      setPop({ ...c.target, pinned });
    },
    [cellAt, loadTables],
  );
  const onEnter = (key: string) => {
    window.clearTimeout(timers.current.leave);
    window.clearTimeout(timers.current.enter);
    if (popRef.current?.pinned) return;
    timers.current.enter = window.setTimeout(() => open(key, false), 180);
  };
  const onLeave = () => {
    window.clearTimeout(timers.current.enter);
    timers.current.leave = window.setTimeout(() => setPop((p) => (p && !p.pinned ? null : p)), 140);
  };
  const onPin = (key: string) => {
    window.clearTimeout(timers.current.enter);
    window.clearTimeout(timers.current.leave);
    if (popRef.current?.pinned && popRef.current.key === key) setPop(null);
    else open(key, true);
  };
  // A layout effect: React takes it down while the tab is kept hidden (Freeze), so these keys only act on the tab on screen.
  useLayoutEffect(() => {
    const pd = (e: PointerEvent) => {
      const p = popRef.current;
      if (!p?.pinned) return;
      const t = e.target as HTMLElement;
      if (t.closest?.('[data-bd="1"]') || t.closest?.('[data-ck]') || t.closest?.('.calc-tip')) return;
      setPop(null);
    };
    const kd = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && popRef.current) {
        e.stopPropagation();
        setPop(null);
      } else if (e.key === 'Escape' && poppedRef.current.length > 0 && !(e.target as HTMLElement | null)?.closest?.('input, textarea, [role="listbox"], .menu')) {
        // A pulled-out section closes like a dialog, the newest one first.
        e.stopPropagation();
        setPopped((p) => p.slice(0, -1));
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        searchBox.current?.focus();
        searchBox.current?.select();
      }
    };
    document.addEventListener('pointerdown', pd, true);
    window.addEventListener('keydown', kd, true);
    return () => {
      document.removeEventListener('pointerdown', pd, true);
      window.removeEventListener('keydown', kd, true);
    };
  }, []);
  const onScroll = () => {
    const p = popRef.current;
    if (!p) return;
    if (!p.pinned) return setPop(null);
    const c = cellAt(p.key);
    const r = body.current?.getBoundingClientRect();
    if (!c || !r || c.target.cell.bottom < r.top || c.target.cell.top > r.bottom) setPop(null);
    else setPop({ ...c.target, pinned: true });
  };
  // A pinned popup follows its cell when the numbers change underneath it.
  useEffect(() => {
    const p = popRef.current;
    if (!p?.pinned) return;
    const c = cellAt(p.key);
    if (!c || c.target.details.length === 0) setPop(null);
    else setPop({ ...c.target, pinned: true });
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- edits: every control goes to the engine ----
  const editInput = (name: string, value: CalcsInputValue) => {
    if (!engine) return;
    const next = setCalcsInput(xml, name, value);
    if (next !== xml) void engine.edit({ kind: 'setXml', xml: next });
  };
  const view = data?.view ?? null;
  const groups = skills?.groups ?? [];
  const groupNo = Math.max(1, Math.min(inputs.skillNumber, Math.max(1, groups.length)));
  const group = groups[groupNo - 1];
  const groupFact = activeGroupsOf(facts)[groupNo - 1];
  const calcsActive = (() => {
    const m = groupFact ? /mainActiveSkillCalcs="(\d+)"/.exec(groupFact.xml.slice(0, groupFact.xml.indexOf('>') + 1)) : null;
    return Math.max(1, Math.min(m ? Number(m[1]) : 1, Math.max(1, group?.activeSkills.length ?? 1)));
  })();
  const activeSkill = group?.activeSkills[calcsActive - 1];
  const ctl = skillControls(view);
  // The sidebar always describes the MAIN skill; this tab has its own skill, active skill and part (as upstream's Calcs
  // tab does). When they differ the tab says so and offers the main skill's view.
  const mainSync = (() => {
    const mg = Math.max(1, facts.mainSocketGroup);
    const mFact = activeGroupsOf(facts)[mg - 1];
    const mGroup = groups[mg - 1];
    if (!mFact || !mGroup || !group || mGroup.activeSkills.length === 0) return null;
    const mTag = mFact.xml.slice(0, mFact.xml.indexOf('>') + 1);
    const mActive = Math.max(1, Math.min(Number(/\smainActiveSkill="(\d+)"/.exec(mTag)?.[1] ?? 1), mGroup.activeSkills.length));
    const mSkill = mGroup.activeSkills[mActive - 1];
    if (!mSkill) return null;
    const mPart = Number(/\sskillPart="(\d+)"/.exec(mFact.gems[mSkill.gem - 1]?.xml ?? '')?.[1] ?? 1) || 1;
    const sameSkill = mg === groupNo && mActive === calcsActive;
    if (!calcsDiffersFromMain({ group: mg, active: mActive, part: mPart }, { group: groupNo, active: calcsActive, part: view?.part ?? mPart })) return null;
    const mainPartName = sameSkill ? view?.parts[mPart - 1] : undefined;
    return {
      main: `${mSkill.name}${mainPartName ? ` · ${mainPartName}` : ''}`,
      shown: `${activeSkill?.name ?? tr('calcs_CalcsTab_2.no_skill')}${view && view.parts.length > 1 ? ` · ${view.parts[view.part - 1] ?? ''}` : ''}`,
      mg,
    };
  })();
  // A Raise Spectre skill's minions are the Spectre Library; the engine's own list is empty for it.
  const spectreNames = useSpectreNames();
  const minionList = view ? minionOptions(view, readSpectres(xml), spectreNames) : [];
  const savedMinion = (() => {
    const el = activeSkill ? groupFact?.gems[activeSkill.gem - 1]?.xml : undefined;
    return el ? /\sskillMinionCalcs="([^"]*)"/.exec(el)?.[1] : undefined;
  })();
  const minionShown = minionList.find((m) => m.id === (view?.spectre ? savedMinion : view?.minion)) ?? minionList[0];
  const setGem = (attr: string, value: string | number | null) => {
    if (!engine || !activeSkill) return;
    void engine.edit({ kind: 'setGem', group: groupNo, gem: activeSkill.gem, attr, value });
  };

  const toggle = (id: string, index: number, now: boolean) => {
    setPop(null);
    if (searchRef.current.trim()) return;
    setCollapsed((c) => ({ ...c, [collapseKey(id, index)]: !now }));
  };

  const jump = (id: string) => {
    const sc = body.current;
    const el = sc?.querySelector<HTMLElement>(`#calc-${id}`);
    if (!sc || !el) return;
    sc.scrollTo({ top: Math.max(0, el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - 44), behavior: 'smooth' });
  };

  // ---- render ----
  if (!engine || build.engine.state !== 'ready') {
    return (
      <div className="tabroot calc-root" data-screen-label="Calcs / Tab / Content" ref={root}>
        <div className="calc-note" role="status">
          <b>{tr('calcs_CalcsTab.no_calculations_yet')}</b> {tr('calcs_CalcsTab.the_calculation_engine_is_not')}
          {build.engine.state === 'unavailable' && <span> {build.engine.reason}</span>}
          {build.engine.state === 'loading' && <span> {tr('calcs_CalcsTab.the_engine_is_still_calculating')}</span>}
        </div>
      </div>
    );
  }
  if (error && !data) {
    return (
      <div className="tabroot calc-root" data-screen-label="Calcs / Tab / Content" ref={root}>
        <div className="calc-note" role="alert">
          <b>{tr('calcs_CalcsTab.nothing_to_calculate_yet')}</b> {error}
        </div>
      </div>
    );
  }
  // Before the first view arrives there is nothing true to show. Drawing the toolbar and columns with placeholders ("None", "No
  // socket groups", "no damage", a missing Skill part) and then swapping them showed a few frames of wrong content and moved the toolbar.
  if (!data) {
    return (
      <div className="tabroot calc-root" data-screen-label="Calcs / Tab / Content" ref={root} data-density="compact" aria-busy="true" />
    );
  }
  // Preview on but its numbers for this build are not in: say so, never the live ones under the preview tag.
  if (pv.on && (pvState === 'computing' || pvState === 'unavailable')) {
    return (
      <div className="tabroot calc-root" data-screen-label="Calcs / Tab / Content" ref={root} data-density="compact" aria-busy={pvState === 'computing'}>
        <div className="calc-empty" role="status">{pvWaitText(pvState)}</div>
      </div>
    );
  }
  const poppedSet = new Set(popped);
  const shownSecs = keeps ? sections.filter((s) => keeps.has(s.id)) : sections;
  const offence = shownSecs.filter((s) => sectionKind(s) === 'offence' && !poppedSet.has(s.id));
  const defence = shownSecs.filter((s) => sectionKind(s) === 'defence' && !poppedSet.has(s.id));
  const floating = shownSecs.filter((s) => poppedSet.has(s.id));
  const popOut = (id: string) => {
    setPop(null);
    setPopped((p) => (p.includes(id) ? p : [...p, id]));
  };
  const popIn = (id: string) => {
    setPop(null);
    setPopped((p) => p.filter((x) => x !== id));
  };
  const listFlags = new Set(view?.flags ?? []);
  const shownLists = view ? (view.showMinion && view.minionLists ? view.minionLists : view.lists) : null;
  const noSkills = groups.length === 0;

  const groupLabel = (g: SkillGroup | undefined): ReactNode => {
    if (!g) return <span style={{ color: 'var(--text-muted)' }}>{tr('calcs_CalcsTab.none')}</span>;
    if (g.label.trim()) return <span style={{ color: 'var(--text-strong)' }}>{g.label}</span>;
    const names = g.gems.filter((x) => x.known);
    if (!names.length) return <span style={{ color: 'var(--text-muted)' }}>{g.displayLabel}</span>;
    return (
      <>
        {names.map((x, i) => (
          <span key={i}>
            {i > 0 && <span style={{ color: 'var(--text-muted)' }}>, </span>}
            <span style={{ color: ATTR[x.colour].text }}>{x.effectName ?? x.nameSpec}</span>
          </span>
        ))}
      </>
    );
  };
  const firstActive = (g: SkillGroup | undefined) => g?.gems.find((x) => !x.support && x.known);

  return (
    <div className="tabroot calc-root" data-screen-label="Calcs / Tab / Content" ref={root} data-density="compact">
      <div className="calc-tb" data-lg="panel" data-r="tab-tb">
        <CalcSelect
          caption={tr('calcs_CalcsTab.socket_group')}
          ariaLabel={tr('calcs_CalcsTab.socket_group_2')}
          grow={1}
          basis={240}
          disabled={noSkills}
          title={group ? group.displayLabel : tr('calcs_CalcsTab.no_socket_groups_yet')}
          value={String(groupNo)}
          valueNode={
            <span className="gv">
              {firstActive(group) && <img src={artFor(firstActive(group)!.effectName ?? firstActive(group)!.nameSpec, 'gems') ?? artFor(firstActive(group)!.nameSpec) ?? undefined} alt="" hidden={!artFor(firstActive(group)!.effectName ?? firstActive(group)!.nameSpec, 'gems') && !artFor(firstActive(group)!.nameSpec)} />}
              <span className="gn">{groupLabel(group)}</span>
            </span>
          }
          options={groups.map((g) => ({
            value: String(g.index),
            node: <span className="gn">{groupLabel(g)}</span>,
            sub: `${g.slot && g.slot !== 'None' ? lbl(g.slot) : tr('h_c_Gem.no_slot')} · ${tr(g.gems.length === 1 ? 'h_c_Gem.gem_one' : 'h_c_Gem.gem_other', { n: g.gems.length })}${g.enabled ? '' : ` · ${tr('items_trader_StatWeights.disabled')}`}`,
            img: artFor(firstActive(g)?.effectName ?? firstActive(g)?.nameSpec, 'gems') ?? (firstActive(g) ? artFor(firstActive(g)!.nameSpec) : undefined),
          }))}
          onChange={(v) => editInput('skill_number', { number: Number(v) })}
          emptyOption={{ label: tr('calcs_CalcsTab.no_socket_groups_yet'), action: tr('calcs_CalcsTab_2.add_a_socket_group_in_skills') }}
        />
        <CalcSelect
          caption={tr('calcs_CalcsTab.active_skill')}
          ariaLabel={tr('calcs_CalcsTab.active_skill_2')}
          grow={0}
          basis={170}
          disabled={!group || group.activeSkills.length < 2}
          title={!group ? tr('calcs_CalcsTab.no_socket_group_is_selected') : group.activeSkills.length === 0 ? tr('calcs_CalcsTab.this_socket_group_has_no') : group.activeSkills.length < 2 ? tr('calcs_CalcsTab.this_socket_group_has_one', { name: activeSkill?.name ?? 'none' }) : tr('calcs_CalcsTab.name_length_active_skills_in', { name: activeSkill?.name ?? '', count: group.activeSkills.length })}
          value={String(calcsActive)}
          valueNode={
            <span className="gv">
              {activeSkill && <img src={artFor(activeSkill.name, 'gems') ?? artFor(activeSkill.name) ?? undefined} alt="" hidden={!artFor(activeSkill.name, 'gems') && !artFor(activeSkill.name)} />}
              <span className="gn" style={{ color: activeSkill ? gemColour(info, activeSkill.name) : 'var(--text-muted)' }}>{activeSkill?.name ?? tr('calcs_CalcsTab.none')}</span>
            </span>
          }
          options={(group?.activeSkills ?? []).map((s) => ({ value: String(s.index), node: <span className="gn" style={{ color: gemColour(info, s.name) }}>{s.name}</span>, img: artFor(s.name, 'gems') ?? artFor(s.name) }))}
          onChange={(v) => engine && void engine.edit({ kind: 'setGroup', group: groupNo, attr: 'mainActiveSkillCalcs', value: Number(v) })}
        />
        {ctl.part && view && (
          <CalcSelect
            caption={tr('calcs_CalcsTab.skill_part')}
            ariaLabel={tr('calcs_CalcsTab.skill_part_2')}
            grow={0}
            basis={150}
            title={`${view.skillName}: ${view.parts[view.part - 1] ?? ''}`}
            value={String(view.part)}
            valueNode={<span className="gn">{view.parts[view.part - 1] ?? ''}</span>}
            options={view.parts.map((n, i) => ({ value: String(i + 1), node: <span className="gn">{n}</span> }))}
            onChange={(v) => setGem('skillPartCalcs', Number(v))}
          />
        )}
        {ctl.stages && view && <NumField caption={tr('calcs_CalcsTab.skill_stages')} label={tr('calcs_CalcsTab.skill_stages_2')} value={view.stageCount ?? view.stageDefault} onCommit={(n) => setGem('skillStageCountCalcs', n)} />}
        {ctl.mines && view && <NumField caption={tr('calcs_CalcsTab.active_mines')} label={tr('calcs_CalcsTab.active_mines_2')} value={view.mineCount} placeholder="" onCommit={(n) => setGem('skillMineCountCalcs', n)} />}
        {view?.minionHasItemSet && (
          <CalcSelect
            caption={tr('calcs_CalcsTab.minion')}
            ariaLabel={tr('calcs_CalcsTab.minion_item_set')}
            grow={0}
            basis={170}
            disabled={facts.itemSets.length < 2}
            title={tr('calcs_CalcsTab.the_item_set_the_minion')}
            value={String(view.minionItemSet ?? facts.itemSets[0]?.id ?? 1)}
            valueNode={<span className="gn">{facts.itemSets.find((s) => s.id === (view.minionItemSet ?? facts.itemSets[0]?.id))?.title || tr('calcs_CalcsTab.default_item_set')}</span>}
            options={facts.itemSets.map((s) => ({ value: String(s.id), node: <span className="gn">{s.title || tr('calcs_CalcsTab.default_item_set')}</span> }))}
            onChange={(v) => setGem('skillMinionItemSetCalcs', Number(v))}
          />
        )}
        {!view?.minionHasItemSet && ctl.minion && view && (view.spectre || view.minions.length > 0) && (
          <CalcSelect
            caption={tr('calcs_CalcsTab.minion')}
            ariaLabel={tr('calcs_CalcsTab.minion_2')}
            grow={0}
            basis={170}
            disabled={minionList.length < 2}
            title={minionShown?.label ?? tr('calcs_CalcsTab.no_spectres_in_your_library')}
            value={minionShown?.id ?? ''}
            valueNode={<span className="gn">{minionShown?.label ?? tr('calcs_CalcsTab.no_spectres_yet')}</span>}
            options={minionList.map((m) => ({ value: m.id, node: <span className="gn">{m.label}</span> }))}
            onChange={(v) => setGem('skillMinionCalcs', v)}
          />
        )}
        {ctl.spectre && (
          <button type="button" className="calc-btn" title={tr('calcs_CalcsTab.choose_the_spectres_your_raise')} onClick={() => setSpectreOpen(true)}>
            {tr('calcs_CalcsTab.manage_spectres')}
          </button>
        )}
        {ctl.minionSkill && view && (
          <CalcSelect
            caption={tr('calcs_CalcsTab.minion_skill')}
            ariaLabel={tr('calcs_CalcsTab.minion_skill_2')}
            grow={0}
            basis={170}
            disabled={view.minionSkills.length < 2}
            title={view.minionSkills[view.minionSkill - 1] ?? ''}
            value={String(view.minionSkill)}
            valueNode={<span className="gn">{view.minionSkills[view.minionSkill - 1] ?? ''}</span>}
            options={view.minionSkills.map((n, i) => ({ value: String(i + 1), node: <span className="gn">{n}</span> }))}
            onChange={(v) => setGem('skillMinionSkillCalcs', Number(v))}
          />
        )}
        {!ctl.part && (
          <div className="calc-ghost" aria-disabled="true" title={view ? tr('calcs_CalcsTab.skillname_has_a_single_part', { skillName: view.skillName }) : tr('calcs_CalcsTab.no_active_skill')}>
            <span className="tx"><span className="k">{tr('calcs_CalcsTab.skill_part')}</span><span className="v">{'—'}</span></span>
            <Icon name="chevron-down" size={12} />
          </div>
        )}
        <span className={'calc-sw' + (ctl.showMinion ? '' : ' off')} title={ctl.showMinion ? tr('calcs_CalcsTab.show_stats_for_the_minion') : tr('calcs_CalcsTab.no_minion_skills_in_this')}>
          <Switch checked={!!view?.showMinion} onChange={(v) => ctl.showMinion && editInput('showMinion', { boolean: v })} label={tr('calcs_CalcsTab.show_minion_stats')} disabled={!ctl.showMinion} />
          <span onClick={() => ctl.showMinion && editInput('showMinion', { boolean: !view?.showMinion })}>{tr('calcs_CalcsTab.show_minion_stats')}</span>
        </span>
        <span className="sp" />
        <label className="calc-search" title={tr('calcs_CalcsTab.shows_only_the_rows_and')}>
          <Icon name="search" size={14} />
          <input ref={searchBox} value={search} placeholder={tr('calcs_CalcsTab.search')} maxLength={100} spellCheck={false} aria-label={tr('calcs_CalcsTab.search')} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => {
            if (e.key === 'Enter') body.current?.querySelector<HTMLElement>('.calc-hit')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
            else if (e.key === 'Escape' && search) { e.stopPropagation(); setSearch(''); }
          }} />
          {search && (
            <button type="button" aria-label={tr('calcs_CalcsTab.clear_search')} onClick={() => setSearch('')}>
              <Icon name="x" size={12} />
            </button>
          )}
        </label>
        <div className="calc-modewrap">
          <span className="calc-mlbl" title={MODE_NOTE}>{tr('calcs_CalcsTab.calculation_mode')}</span>
          <div className="calc-mode" data-lg="tile" role="radiogroup" aria-label={tr('calcs_CalcsTab.calculation_mode')}>
            {MODES.map((m) => (
              <button key={m.value} type="button" role="radio" aria-checked={inputs.buffMode === m.value} title={`${m.tip}\n\n${MODE_NOTE}`} onClick={() => editInput('misc_buffMode', { string: m.value })}>
                {m.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="calc-body" ref={body} onScroll={onScroll} aria-busy={loading}>
        {mainSync && (
          <div className="calc-sync" role="status" data-testid="calcs-main-differs">
            <span>
              {tr('calcs_CalcsTab.this_tab_is_showing')} <b>{mainSync.shown}</b>{tr('calcs_CalcsTab.the_sidebar_shows_the_main')} <b>{mainSync.main}</b>{tr('calcs_CalcsTab.so_their_numbers_differ')}
            </span>
            <button type="button" className="calc-btn" onClick={() => engine && void engine.edit({ kind: 'setXml', xml: mainSkillProbeXml(xml, mainSync.mg) })}>
              {tr('calcs_CalcsTab.show_the_main_skill_here')}
            </button>
          </div>
        )}
        {noSkills && <div className="calc-hint">{tr('calcs_CalcsTab.no_socket_groups_yet_the')}</div>}
        {shownLists && (listFlags.has('buffs') || listFlags.has('combat') || listFlags.has('effective')) && (
          <div className="calc-lists" data-card="" aria-label={tr('calcs_CalcsTab.buffs_and_debuffs_in_effect')}>
            {listFlags.has('buffs') && <ListLine k="buff" label={tr('calcs_CalcsTab.aura_and_buff_skills')} text={shownLists.buff} pop={pop} onEnter={onEnter} onLeave={onLeave} onPin={onPin} />}
            {listFlags.has('combat') && <ListLine k="combat" label={tr('calcs_CalcsTab.combat_buffs')} text={shownLists.combat} pop={pop} onEnter={onEnter} onLeave={onLeave} onPin={onPin} />}
            {listFlags.has('effective') && <ListLine k="curse" label={tr('calcs_CalcsTab.curses_and_debuffs')} text={shownLists.curse} pop={pop} onEnter={onEnter} onLeave={onLeave} onPin={onPin} />}
          </div>
        )}
        <div className="calc-chips" role="navigation" aria-label={tr('calcs_CalcsTab.sections')}>
          {shownSecs.map((s) => (
            <button key={s.id} type="button" onClick={() => jump(s.id)} title={tr('calcs_CalcsTab.jump_to_v1', { value: lbl(sectionTitle(s)) })}>
              <Icon name={lookOf(s.id).icon} size={13} style={{ color: 'var(--text-muted)' }} />
              {lbl(sectionTitle(s))}
            </button>
          ))}
        </div>
        {keeps?.size === 0 && <div className="calc-empty" role="status">{tr('calcs_CalcsTab.no_stats_match_q', { value: q })}</div>}
        <div className="calc-cols">
          {(!keeps || offence.length > 0) && <section aria-label={tr('calcs_CalcsTab.offence')} className="calc-col">
            <span className="calc-cap">{tr('calcs_CalcsTab.offence_2')}</span>
            {offence.map((s) => (
              <SectionCard key={s.id} s={s} keep={keeps?.get(s.id)} live={liveSecs?.get(s.id)} q={q} pop={pop} onToggle={toggle} onEnter={onEnter} onLeave={onLeave} onPin={onPin} onPopOut={popOut} />
            ))}
            {offence.length === 0 && !keeps && <div className="calc-empty">{tr('calcs_CalcsTab.this_skill_deals_no_damage')}</div>}
          </section>}
          {(!keeps || defence.length > 0) && <section aria-label={tr('calcs_CalcsTab.defence')} className="calc-col">
            <span className="calc-cap">{tr('calcs_CalcsTab.defence_2')}</span>
            {defence.map((s) => (
              <SectionCard key={s.id} s={s} keep={keeps?.get(s.id)} live={liveSecs?.get(s.id)} q={q} pop={pop} onToggle={toggle} onEnter={onEnter} onLeave={onLeave} onPin={onPin} onPopOut={popOut} />
            ))}
          </section>}
        </div>
      </div>
      {floating.map((s, i) => (
        <PopWindow key={s.id} s={s} index={i} pos={popPos[s.id]} rootRef={root} onMove={(p) => setPopPos((m) => ({ ...m, [s.id]: p }))} onClose={() => popIn(s.id)}>
          <SectionCard s={s} keep={keeps?.get(s.id)} live={liveSecs?.get(s.id)} q={q} pop={pop} onToggle={toggle} onEnter={onEnter} onLeave={onLeave} onPin={onPin} />
        </PopWindow>
      ))}
      {spectreOpen && (
        <SpectreDialog
          current={readSpectres(xml)}
          onCancel={() => setSpectreOpen(false)}
          onSave={(ids) => {
            setSpectreOpen(false);
            if (engine) void engine.edit({ kind: 'setXml', xml: setSpectres(xml, ids) });
          }}
        />
      )}
      {pop && <Popup target={pop} env={env} onClose={() => setPop(null)} onKeep={() => window.clearTimeout(timers.current.leave)} onLeave={onLeave} />}
    </div>
  );
}

// ---- one section -------------------------------------------------------------------------------------------------------

interface CardProps {
  s: CalcViewSection;
  /** Preview on: the same section from the live engine, to show each changed value's live number. */
  live?: CalcViewSection;
  q: string;
  /** Search on: the sub-sections and rows to show. */
  keep?: SearchKeep;
  pop: PopupTarget | null;
  onToggle: (id: string, index: number, collapsedNow: boolean) => void;
  onEnter: (key: string) => void;
  onLeave: () => void;
  onPin: (key: string) => void;
  /** Pulls the section out into its own window (not offered inside one). */
  onPopOut?: (id: string) => void;
}

const SectionCard = memo(function SectionCard({ s, keep, live, q, pop, onToggle, onEnter, onLeave, onPin, onPopOut }: CardProps) {
  const look = lookOf(s.id);
  const colour = hexOf(s.colour);
  const wide = s.width > 1;
  const first = s.subSections[0];
  const hidden = first?.collapsed ?? false;
  const hit = q.length > 0 && sectionMatches(s, q);
  return (
    <div id={`calc-${s.id}`} className={'calc-card' + (wide ? ' wide' : '') + (hit ? ' has-hit' : '')} data-lg="panel" data-card="" data-sec={s.id} style={{ ['--tone' as string]: `var(${look.tone})`, ['--sec' as string]: colour }}>
      {s.subSections.map((sub, i) => {
        // Upstream draws nothing after a collapsed first sub-section.
        if (i > 0 && hidden) return null;
        if (keep && !keep.has(i)) return null;
        const rowKeep = keep?.get(i) ?? null;
        const open = !sub.collapsed;
        const subHit = searchMatch(sub.label, q);
        return (
          <div key={i} className={'calc-sub' + (i === 0 ? ' calc-first' : '')} data-sub={i}>
            <div
              className="hd"
              role="button"
              tabIndex={0}
              aria-expanded={open}
              title={tr(open ? 'h_c_Gem.collapse' : 'h_c_Gem.expand', { name: lbl(sub.label) })}
              onClick={() => onToggle(s.id, i, sub.collapsed)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onToggle(s.id, i, sub.collapsed);
                }
              }}
            >
              <Icon name="chevron-down" size={13} style={{ color: 'var(--gold-label)', transform: open ? 'none' : 'rotate(-90deg)', transition: 'transform var(--dur-quick,160ms)' }} />
              {i === 0 && <Icon name={look.icon} size={15} style={{ color: `var(${look.tone})` }} />}
              <span className={'t' + (subHit ? ' calc-hit' : '')}>{lbl(sub.label)}</span>
              {sub.extra && (
                <span className="extra" title={stripCodes(sub.extra)}>
                  <ColorText text={sub.extra} />
                  <PvCell now={sub.extra} was={live?.subSections[i]?.extra} />
                </span>
              )}
              {i === 0 && onPopOut && (
                <button
                  type="button"
                  className="po"
                  aria-label={tr('calcs_CalcsTab.pop_label_out_into_its', { label: sub.label })}
                  title={tr('calcs_CalcsTab.pop_this_section_out_into')}
                  style={sub.extra ? undefined : { marginLeft: 'auto' }}
                  onClick={(e) => {
                    e.stopPropagation();
                    onPopOut(s.id);
                  }}
                >
                  <Icon name="external" size={13} />
                </button>
              )}
            </div>
            {open && sub.rows.length > 0 && (
              <div className="calc-rows">
                <ColumnTitles titles={columnTitles(sub)} />
                {sub.rows.map((r, ri) => (rowKeep && !rowKeep.includes(ri) ? null : (
                  <RowView key={ri} r={r} lr={sameRow(live?.subSections[i]?.rows[ri], r)} sid={s.id} subi={i} ri={ri} q={q} pop={pop} onEnter={onEnter} onLeave={onLeave} onPin={onPin} />
                )))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
});

/** The table's column titles when the engine's rows carry none (upstream hides them behind an output flag some builds never set). */
function ColumnTitles({ titles }: { titles: string[] | null }) {
  if (!titles) return null;
  return (
    <div className="calc-row head multi" data-columns="">
      <span className="l" />
      <span className="cells" style={{ gridTemplateColumns: `repeat(${titles.length}, minmax(min-content, 1fr))` }}>
        {titles.map((t, i) => (
          <span key={i} className="c h" style={{ gridColumn: i + 1 }}>
            <ColorText text={t} />
          </span>
        ))}
      </span>
    </div>
  );
}

/** The live row at the same place, when it is the same row (same label). */
// Column headings keep their colour codes: translate only the words between them.
const tlHead = (t: string): string => { const m = /^((?:\^x[0-9A-Fa-f]{6}|\^\d)*)(.*?)(:?)\s*$/.exec(t); return m && m[2] ? m[1] + lbl(m[2]) + m[3] : t; };
const sameRow = (lr: CalcViewRow | undefined, r: CalcViewRow) => (lr && lr.label === r.label ? lr : undefined);

/** The last number in a cell ("9,575 to 96,034" -> 96034). */
const lastNum = (t: string): number | null => {
  const m = stripCodes(t).replace(/,(\d{3})/g, '$1').match(/-?\d+(?:\.\d+)?/g);
  return m ? Number(m[m.length - 1]) : null;
};

/** Preview on: the live value under a changed cell ("3.29 71,453.7 +9.5%"). */
function PvCell({ now, was }: { now: string; was: string | null | undefined }) {
  const pv = usePreview();
  if (was == null || stripCodes(was) === stripCodes(now)) return null;
  const c = pctChange(lastNum(now), lastNum(was));
  return (
    <span className="pv-cell">
      {pv.live} {stripCodes(was)}
      {c && <> <span className={c.good ? 'up' : 'down'}>{c.text}</span></>}
    </span>
  );
}

const RowView = memo(function RowView({ r, lr, sid, subi, ri, q, pop, onEnter, onLeave, onPin }: { r: CalcViewRow; lr?: CalcViewRow; sid: string; subi: number; ri: number; q: string; pop: PopupTarget | null; onEnter: (k: string) => void; onLeave: () => void; onPin: (k: string) => void }) {
  const head = isHeaderRow(r);
  const label = r.label;
  const hit = !!label && searchMatch(label, q);
  const bg = hexOf(r.bgCol, 0.5);
  const multi = r.cols > 1;
  const rl = head ? null : rowLook(sid, label);
  const on = pop && pop.key.startsWith(`${sid}:${subi}:${ri}:`);
  const hl = useHighlight();
  const hlStat = hl?.tab === 'calcs' ? hl.stat : undefined;
  return (
    <div className={'calc-row' + (head ? ' head' : '') + (multi ? ' multi' : '') + (on ? ' on' : '')} style={{ background: bg }}>
      {label !== null && (
        <span className={'l' + (hit ? ' calc-hit' : '')} title={lbl(label)} style={{ color: hexOf(r.color) }}>
          {rl && <Icon name={rl.icon} size={12} style={{ color: `var(${rl.tone})`, marginRight: 7, verticalAlign: '-2px' }} />}
          {lbl(label)}
        </span>
      )}
      {label === null && <span className="l" />}
      <span className="cells" style={multi ? { gridTemplateColumns: `repeat(${r.cols}, minmax(min-content, 1fr))` } : undefined}>
        {r.cells.map((c, ci) => {
          const key = `${sid}:${subi}:${ri}:${ci}`;
          const has = (r.cellDetails[ci]?.length ?? 0) > 0;
          const text = c === '' ? ' ' : c;
          const on1 = pop?.key === key;
          const marked = hlStat && has && cellIsStat(r.cellDetails[ci], hlStat) ? hlStat : undefined;
          if (head || !has) {
            return (
              <span key={ci} className={'c' + (head ? ' h' : '')} style={multi ? { gridColumn: (r.cellIdx[ci] ?? ci) + 1 } : undefined} title={stripCodes(c)}>
                <ColorText text={head ? tlHead(text) : text} />
                {!head && <PvCell now={c} was={lr?.cells[ci]} />}
              </span>
            );
          }
          return (
            <button
              key={ci}
              type="button"
              className={'c cbtn' + (on1 ? (pop?.pinned ? ' pinned' : ' hov') : '')}
              data-ck={key}
              data-sec={sid}
              data-assistant-highlight={marked}
              aria-pressed={on1 && pop?.pinned}
              style={multi ? { gridColumn: (r.cellIdx[ci] ?? ci) + 1 } : undefined}
              title={stripCodes(c)}
              onMouseEnter={() => onEnter(key)}
              onMouseLeave={onLeave}
              onFocus={() => onEnter(key)}
              onBlur={onLeave}
              onClick={() => onPin(key)}
            >
              <ColorText text={text} />
              <PvCell now={c} was={lr?.cells[ci]} />
            </button>
          );
        })}
      </span>
    </div>
  );
});

// ---- toolbar controls -------------------------------------------------------------------------------------------------------

// ---- the buff lists and pulled-out windows ----------------------------------------------------------------------------

/** One of the three lines under the skill controls (`CalcsTab`'s "Aura and Buff Skills", "Combat Buffs", "Curses and Debuffs"). */
function ListLine({ k, label, text, pop, onEnter, onLeave, onPin }: { k: 'buff' | 'combat' | 'curse'; label: string; text: string; pop: PopupTarget | null; onEnter: (key: string) => void; onLeave: () => void; onPin: (key: string) => void }) {
  const key = `list:${k}`;
  const live = k !== 'combat';
  const on = pop?.key === key;
  return (
    <div className="line">
      <span className="k">{label}:</span>
      {live ? (
        <button type="button" className={'v cbtn' + (on ? (pop?.pinned ? ' pinned' : ' hov') : '')} data-ck={key} aria-pressed={on && pop?.pinned} onMouseEnter={() => onEnter(key)} onMouseLeave={onLeave} onFocus={() => onEnter(key)} onBlur={onLeave} onClick={() => onPin(key)}>
          {text || <span className="none">{tr('calcs_CalcsTab.none')}</span>}
        </button>
      ) : (
        <span className="v" data-ck-none="">{text || <span className="none">{tr('calcs_CalcsTab.none')}</span>}</span>
      )}
    </div>
  );
}

/** A section pulled out of the columns: a draggable window over the tab (`CalcSectionClass:DrawOverlay`). */
function PopWindow({ s, index, pos, rootRef, onMove, onClose, children }: { s: CalcViewSection; index: number; pos: { x: number; y: number } | undefined; rootRef: React.RefObject<HTMLDivElement | null>; onMove: (p: { x: number; y: number }) => void; onClose: () => void; children: ReactNode }) {
  const el = useRef<HTMLDivElement>(null);
  const at = pos ?? { x: 40 + index * 28, y: 76 + index * 28 };
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const clamp = (x: number, y: number) => {
    const r = rootRef.current?.getBoundingClientRect();
    const w = el.current?.offsetWidth ?? 360;
    if (!r) return { x, y };
    return { x: Math.max(0, Math.min(x, r.width - w)), y: Math.max(0, Math.min(y, r.height - 40)) };
  };
  // Keep the window inside the tab when the window shrinks.
  useEffect(() => {
    const c = clamp(at.x, at.y);
    if (c.x !== at.x || c.y !== at.y) onMove(c);
  }); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div ref={el} className={'calc-pop' + (s.width > 1 ? ' wide' : '')} style={{ left: at.x, top: at.y }} role="dialog" aria-label={lbl(sectionTitle(s))} data-popwin={s.id}>
      <div
        className="bar"
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest('button')) return;
          const r = el.current!.getBoundingClientRect();
          drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top };
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          const root = rootRef.current?.getBoundingClientRect();
          if (d && root) onMove(clamp(e.clientX - root.left - d.dx, e.clientY - root.top - d.dy));
        }}
        onPointerUp={() => (drag.current = null)}
      >
        <Icon name="grip" size={13} style={{ color: 'var(--text-faint)' }} />
        <span className="t">{sectionTitle(s)}</span>
        <button type="button" className="x" aria-label={tr('calcs_CalcsTab.put_v1_back_in_the', { value: lbl(sectionTitle(s)) })} title={tr('calcs_CalcsTab.put_this_section_back_in')} onClick={onClose}>
          <Icon name="x" size={13} />
        </button>
      </div>
      <div className="body">{children}</div>
    </div>
  );
}
