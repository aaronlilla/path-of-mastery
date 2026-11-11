import type { ItemInfo } from '@pom/protocol';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../ui';
import { SharedList } from './SharedList';
import type { SharedState } from './useShared';
import { BASE_KEY, defaultItemSort, gainText, rankAll, sortByValue } from './rank';
import { basesByName, buildLevel, DB_DEFAULTS, dbRows, infoCache, rankCache, rankCandidates, readInfos, useCalcRev, type DbRow as Row, type DbTab } from './prerank';
import { MenuHost, PickButton, SegControl, useHoverTip, useMenu, type MenuEntry, type TipSpec } from './parts';
import type { SlotDef } from './slots';
import type { ItemsEnv } from './useItems';
import { useWindowedRows } from './virtual';
import { label, tr } from '../i18n';

const SLOT_FILTERS = ['Any slot', 'Weapon 1', 'Weapon 2', 'Helmet', 'Body Armour', 'Gloves', 'Boots', 'Amulet', 'Ring', 'Belt', 'Jewel', 'Flask', 'Graft 1', 'Graft 2'];
const TYPE_FILTERS = ['Any type', 'Armour', 'Jewellery', 'One Handed Melee', 'Two Handed Melee'];
const REQ_FILTERS = ['Any requirements', 'Current level', 'Current attributes', 'Current useable'];
const OBT_FILTERS = ['Obtainable', 'Any source', 'Unobtainable', 'Vendor Recipe', 'Upgraded', 'Boss Item', 'Corruption', 'Core Drop Pool'];

export interface DbPanelProps {
  env: ItemsEnv;
  validSlots: (info: ItemInfo) => SlotDef[];
  tipFor: (info: ItemInfo, def: SlotDef | undefined, target: { id: number } | { text: string }) => TipSpec;
  shared: SharedState;
  onPick: (o: DbTab, text: string, label: string) => void;
  onCtrl: (text: string, alt: boolean) => void;
  tip: ReturnType<typeof useHoverTip>;
  dragRef: React.MutableRefObject<{ id?: number; text?: string } | null>;
}

/** The unique and rare-template lists (`ItemDBControl`): filters, search, and a sort by name or by the gain in a stat. */
export function DbPanel({ env, validSlots, tipFor, shared, onPick, onCtrl, tip, dragRef }: DbPanelProps) {
  const { menu, open: openMenu, close: closeMenu } = useMenu();
  const [tab, setTab] = useState<DbTab>(DB_DEFAULTS.tab);
  const [slot, setSlot] = useState(DB_DEFAULTS.slot);
  const [type, setType] = useState(DB_DEFAULTS.type);
  const [pickedSort, setSort] = useState<string | null>(null);
  // With a build open the list starts sorted by Full DPS, as the design and upstream's item list do; otherwise by name.
  // A build that has no Full DPS row (one skill, nothing else to add up) falls back to the next damage row it does have.
  const sort = pickedSort ?? defaultItemSort(Boolean(env.buildId), env.stats, env.powerStats);
  const [league, setLeague] = useState(DB_DEFAULTS.league);
  const [req, setReq] = useState(DB_DEFAULTS.req);
  const [obt, setObt] = useState(DB_DEFAULTS.obt);
  const [q, setQ] = useState(DB_DEFAULTS.q);
  const [mode, setMode] = useState(DB_DEFAULTS.mode);
  const [selKey, setSelKey] = useState<string | null>(null);
  const cat = env.catalog;

  const baseOf = useMemo(() => basesByName(cat), [cat]);
  const leagues = useMemo(() => {
    const s = new Set<string>();
    for (const u of cat?.uniques ?? []) if (u.league) for (const l of u.league.split(',')) s.add(l.trim());
    return ['Any league', 'No league', ...[...s].sort()];
  }, [cat]);
  const types = useMemo(() => {
    const s = new Set<string>();
    for (const u of cat?.uniques ?? []) {
      const t = baseOf.get(u.base)?.type;
      if (t) s.add(t);
    }
    for (const r of cat?.rares ?? []) {
      const t = baseOf.get(r.base)?.type;
      if (t) s.add(t);
    }
    return [...TYPE_FILTERS, ...[...s].sort()];
  }, [cat, baseOf]);
  const level = useMemo(() => buildLevel(env.xml), [env.xml]);

  const list = useMemo<Row[]>(
    () => dbRows(cat, baseOf, { tab, slot, type, league, obt, req, q, mode }, level, env.stats),
    [cat, baseOf, tab, slot, type, league, obt, req, q, mode, level, env.stats],
  );

  // ---- sort by a stat ----------------------------------------------------------------------------------------------
  const statDef = tab === 'unique' && sort !== 'Name' ? env.powerStats?.find((s) => s.stat === sort) : undefined;
  const validRef = useRef(validSlots);
  validRef.current = validSlots;
  /** The candidates for the list as it stands, and each row's candidate key. */
  const candidates = (infos: Map<string, ItemInfo>) => rankCandidates(list, infos, validRef.current);
  /** The finished ranking straight from the cache, when every row is already in it: a return visit shows the sorted list at once. */
  const cachedRanking = () => {
    if (!statDef || !env.buildId) return null;
    const infos = infoCache(env.buildId);
    if (list.some((r) => !infos.has(r.text))) return null;
    const values = rankCache(env.buildId, env.xml);
    const { keyOf, cands } = candidates(infos);
    if (cands.some((c) => !values.has(`${statDef.stat}|${c.key}`))) return null;
    const byRow = new Map<string, number>();
    for (const r of list) byRow.set(r.key, values.get(`${statDef.stat}|${keyOf.get(r.key)!}`) ?? -Infinity);
    return { stat: statDef.stat, value: byRow, base: values.get(`${statDef.stat}|${BASE_KEY}`) ?? 0 };
  };
  // A recalculation of the same text (the timeless tables installed) drops the ranking; this sorts the list again.
  const calcRev = useCalcRev(env.buildId);
  const [progress, setProgress] = useState<number | null>(null);
  type Ranked = { stat: string; value: Map<string, number>; base: number; keys: string };
  const rowKeys = (rows: Row[]) => rows.map((r) => r.key).join('|');
  const [ranked, setRanked] = useState<Ranked | null>(() => {
    const r = cachedRanking();
    return r && { ...r, keys: rowKeys(list) };
  });
  const rankedRef = useRef(ranked);
  rankedRef.current = ranked;

  // A layout effect: the sorting bar (and the drop of a stale order) must land in the same frame as the list. From a plain
  // effect the bar came a frame after the list on opening the tab and pushed it down, a one-frame flash.
  useLayoutEffect(() => {
    if (!statDef || !env.buildId) {
      setRanked(null);
      setProgress(null);
      return;
    }
    let alive = true;
    const hit = cachedRanking();
    if (hit) {
      setRanked({ ...hit, keys: rowKeys(list) });
      setProgress(null);
      return;
    }
    const cache = rankCache(env.buildId, env.xml);
    const infos = infoCache(env.buildId);
    // The same rows ranked again because the build changed (a weapon set, an item): keep the order on screen until the new one
    // is ready, instead of dropping to name order for a few frames.
    const again = rankedRef.current?.stat === statDef.stat && rankedRef.current.keys === rowKeys(list);
    if (!again) {
      setProgress(0);
      setRanked(null);
    }
    // At most a few progress repaints a second: each one re-rendered the panel and laid the list out again.
    let shownAt = 0;
    const onProgress = (p: number) => {
      const now = performance.now();
      if (!alive || (p < 1 && now - shownAt < 150)) return;
      shownAt = now;
      setProgress(p);
    };
    void (async () => {
      try {
        // Typing or switching a filter starts a new run; wait a moment so only the last one costs engine time.
        await new Promise((res) => setTimeout(res, 250));
        if (!alive) return;
        await readInfos(list, infos, env.infoMany, () => alive);
        if (!alive) return;
        const { keyOf, cands } = candidates(infos);
        const values = await rankAll(statDef.stat, statDef.negate, cands, env.rank, cache, onProgress, () => alive);
        if (!alive || !values) return;
        const byRow = new Map<string, number>();
        for (const r of list) byRow.set(r.key, values.get(keyOf.get(r.key)!) ?? -Infinity);
        setRanked({ stat: statDef.stat, value: byRow, base: values.get(BASE_KEY) ?? 0, keys: rowKeys(list) });
        setProgress(null);
      } catch {
        if (alive) {
          setRanked(null);
          setProgress(null);
        }
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, statDef?.stat, env.xml, env.infos, env.buildId, calcRev]);

  const rows = useMemo(() => {
    if (statDef && ranked && ranked.stat === statDef.stat) return sortByValue(list, (r) => ranked.value.get(r.key) ?? -Infinity, (r) => r.name);
    return list;
  }, [list, statDef, ranked]);

  const filterBtn = (key: string, value: string, options: string[], set: (v: string) => void) => (
    <button key={key} type="button" className="it-pick sm" data-mt={key} aria-haspopup="listbox" style={{ width: '100%' }} onClick={(e) => openMenu(e.currentTarget, options.map((o) => ({ key: o, label: label(o), on: o === value, run: () => set(o) })), 170)}>
      <span className="v">{label(value)}</span>
      <Icon name="chevron-down" size={12} />
    </button>
  );
  const sortOptions = ['Name', ...(env.powerStats ?? []).filter((s) => s.items).map((s) => s.stat)];
  const sortLabel = (k: string) => (k === 'Name' ? label('Name') : label(env.powerStats?.find((s) => s.stat === k)?.label ?? k));
  const sortMenu = (el: HTMLElement) =>
    openMenu(
      el,
      sortOptions.map<MenuEntry>((k) => ({ key: k, label: sortLabel(k), on: k === sort, run: () => setSort(k) })),
      200,
    );

  const hover = async (el: HTMLElement, r: Row) => {
    try {
      const [shown, plain] = await Promise.all([env.info(r.text, { dbMode: true }), env.info(r.text)]);
      if (!el.matches(':hover')) return;
      tip.show(el, tipFor({ ...shown, granted: plain.granted }, undefined, { text: plain.text ?? r.text }));
    } catch {
      /* the row stays without a tooltip */
    }
  };

  const sorting = progress !== null;
  const win = useWindowedRows(rows.length, 29, tab);
  return (
    <>
      <div style={{ flex: 'none', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 10px', minWidth: 0 }}>
        <SegControl label={tr('items_DbPanel.item_database')} value={tab} options={[{ value: 'unique', label: tr('items_DbPanel.uniques') }, { value: 'rare', label: tr('items_DbPanel.rare_templates') }, { value: 'shared', label: tr('items_DbPanel.shared') }]} onChange={setTab} />
        <span title={tr('items_DbPanel.click_to_preview_ctrl_click')} className="it-sub" style={{ flex: '1 1 auto', textAlign: 'right', whiteSpace: 'nowrap', fontSize: 12 }}>
          {tr('items_DbPanel.ctrl_click_to_equip_shift')}
        </span>
      </div>
      {tab === 'shared' ? (
        <SharedList env={env} shared={shared} tip={tip} tipFor={tipFor} onOpen={(text, label) => onPick('shared', text, label)} onCtrl={onCtrl} dragRef={dragRef} />
      ) : (
        <>
      <div className="it-filters">
        {filterBtn('slot', slot, SLOT_FILTERS, setSlot)}
        {filterBtn('type', type, types, setType)}
        {tab === 'unique' && (
          <button type="button" className="it-pick sm" data-mt="sort" title={tr('items_DbPanel.sort_the_list_by_this')} aria-haspopup="listbox" style={{ width: "100%" }} onClick={(e) => sortMenu(e.currentTarget)}>
            <span className="v">{sortLabel(sort)}</span>
            <Icon name="chevron-down" size={12} />
          </button>
        )}
        {tab === 'unique' && filterBtn('league', league, leagues, setLeague)}
        {tab === 'unique' && filterBtn('req', req, REQ_FILTERS, setReq)}
        {tab === 'unique' && filterBtn('obt', obt, OBT_FILTERS, setObt)}
      </div>
      <div style={{ flex: 'none', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <div className="it-search" style={{ flexBasis: 140 }}>
          <Icon name="search" size={15} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('items_DbPanel.search')} aria-label={tr('items_DbPanel.search_the_item_database')} maxLength={100} />
          {q && (
            <button type="button" className="it-icon" style={{ width: 22, height: 22 }} aria-label={tr('items_DbPanel.clear_search')} onClick={() => setQ('')}>
              <Icon name="x" size={12} />
            </button>
          )}
        </div>
        <SegControl tall label={tr('items_DbPanel.search_in')} value={mode} options={[{ value: 'any', label: tr('items_DbPanel.anywhere') }, { value: 'names', label: tr('items_DbPanel.names') }, { value: 'mods', label: tr('items_DbPanel.modifiers') }]} onChange={setMode} />
      </div>
      <div style={{ flex: 1, minHeight: 90, position: 'relative', display: 'flex', flexDirection: 'column' }}>
      {sorting && (
        <div className="it-sortbar" role="status">
          <span>{tr('items_DbPanel.sorting_by_sort_progress', { sort: sortLabel(sort), progress: Math.floor((progress ?? 0) * 100) })}</span>
          <span className="it-progress"><i style={{ transform: `scaleX(${(progress ?? 0).toFixed(3)})` }} /></span>
        </div>
      )}
      <div role="listbox" aria-label={tr('items_DbPanel.item_database_results')} className="it-box" style={{ flex: 1, minHeight: 0 }} ref={win.ref} onScroll={win.onScroll}>
        {!cat && <div className="it-empty"><span className="s">{tr('items_DbPanel.loading')}</span></div>}
        {win.range.padTop > 0 && <div aria-hidden="true" style={{ flex: 'none', height: win.range.padTop }} />}
        {rows.slice(win.range.start, win.range.end).map((r) => {
            const gain = statDef && ranked && ranked.stat === statDef.stat ? (ranked.value.get(r.key) ?? -Infinity) - ranked.base : undefined;
            return (
              <div
                key={r.key}
                role="option"
                aria-selected={selKey === r.key}
                className="it-li"
                draggable
                onDragStart={(e) => {
                  dragRef.current = { text: r.text };
                  e.dataTransfer.effectAllowed = 'copy';
                  e.dataTransfer.setData('text/plain', r.name);
                  tip.hide();
                }}
                onDragEnd={() => (dragRef.current = null)}
                onClick={(e) => {
                  if (e.ctrlKey || e.metaKey) onCtrl(r.text, e.shiftKey);
                  else {
                    setSelKey(r.key);
                    onPick(tab, r.text, r.label);
                  }
                }}
                onMouseEnter={(e) => void hover(e.currentTarget, r)}
                onMouseLeave={tip.hide}
              >
                {r.art && <img src={r.art} alt="" />}
                <span className="n" style={{ color: r.colour }}>{r.name}</span>
                {tab === 'rare' && <span className="tag">{r.base}</span>}
                {gain !== undefined && (
                  <span className="val" title={tr('items_DbPanel_2.change_from_the_build_now', { label: env.powerStats?.find((s) => s.stat === statDef!.stat)?.label })} style={{ color: !Number.isFinite(gain) ? 'var(--text-faint)' : gain >= 0.005 ? 'var(--positive-text)' : gain <= -0.005 ? 'var(--negative-text)' : 'var(--text-faint)' }}>
                    {Number.isFinite(gain) ? gainText(gain) : tr('items_DbPanel.no_slot')}
                  </span>
                )}
              </div>
            );
          })}
        {win.range.padBottom > 0 && <div aria-hidden="true" style={{ flex: 'none', height: win.range.padBottom }} />}
        {cat && rows.length === 0 && (
          <div className="it-empty">
            <span className="s">{tr('items_DbPanel.no_items_found_that_match')}</span>
          </div>
        )}
      </div>
      </div>
        </>
      )}
      <MenuHost menu={menu} close={closeMenu} onTip={tip.show} offTip={tip.hide} />
    </>
  );
}
