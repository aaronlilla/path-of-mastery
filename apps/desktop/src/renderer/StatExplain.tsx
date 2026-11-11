// The sidebar's stat tooltip (design: Explain Tooltips, "Sidebar stat" and "Formula stat"). After a short rest on a row, or
// on keyboard focus, it shows what the stat means, how the engine calculated it with the live numbers, and its biggest
// sources. Holding Alt (or a click, or Enter) opens upstream's full breakdown, the same popup the Calcs tab draws.
// Everything numeric comes from the engine's breakdown tables and modifier lists; only the one-line meaning is text.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CalcDetail, CalcModTable } from '@pom/protocol';
import { activeSpecOf, equipped, readFacts } from '../shared/buildFacts';
import { DEFAULT_NUM_FORMAT, type NumFormat } from '../shared/calcsLogic';
import { buildBreakdownIndex, statBreakdownKey, statDetails, type BreakdownIndex } from '../shared/statBreakdown';
import { statMeaning } from '../shared/statMeaning';
import type { SidebarRow } from './displayStats';
import type { EngineHandle } from './engineHandle';
import { useTreeNodes } from './gameData';
import { portal } from './Freeze';
import { AltHint } from './tipFrame';
import { Popup, type PopupEnv, type PopupTarget } from './calcs/Popup';
import { NODE_KIND, useTreeText } from './calcs/treeData';
import { inLanguage, label as lbl, tr } from './i18n';

interface ExplainData {
  tables: Record<string, unknown>;
  index: BreakdownIndex;
  /** The skill the breakdown tables describe (the Calcs tab's). */
  skill: string;
}

export interface TipTarget {
  row: SidebarRow;
  /** The hovered row and the sidebar, in viewport pixels. */
  cell: DOMRect;
  card: DOMRect;
  pinned: boolean;
}

const strip = (s: string) => s.replace(/\^x[0-9a-fA-F]{6}|\^\d/g, '');

/**
 * What the tooltips read, for one engine session at one build text and version. It lives outside the tooltip, which
 * closes and opens again on every row: the next row reuses it instead of reading every breakdown again.
 */
let shared: { buildId: string; xml: string; version: number; p: Promise<ExplainData>; mods: Map<string, Promise<CalcModTable | null>> } | null = null;

function explainCache(engine: EngineHandle, xml: string) {
  if (!shared || shared.buildId !== engine.buildId || shared.xml !== xml || shared.version !== engine.version) {
    const p = Promise.all([engine.call('getBreakdowns', {}), engine.call('calcsView', {})]).then(([b, v]) => ({ tables: b.breakdowns.player, index: buildBreakdownIndex(v.sections), skill: v.mainSkill.name }));
    const entry = { buildId: engine.buildId, xml, version: engine.version, p, mods: new Map<string, Promise<CalcModTable | null>>() };
    // A failed read is tried again by the next tooltip.
    p.catch(() => shared === entry && (shared = null));
    shared = entry;
  }
  return shared;
}

/** The loader of everything a tooltip reads, cached per engine session, build text and version. */
function useExplainData(engine: EngineHandle | null, xml: string) {
  const load = useCallback((): Promise<ExplainData> | null => (engine ? explainCache(engine, xml).p : null), [engine, xml]);
  const loadMods = useCallback(
    (d: CalcDetail): Promise<CalcModTable | null> => {
      if (!engine) return Promise.resolve(null);
      const mods = explainCache(engine, xml).mods;
      const k = JSON.stringify(d);
      let p = mods.get(k);
      if (!p) {
        p = engine.call('calcsMods', { detail: d }).then((r) => r.table).catch(() => null);
        mods.set(k, p);
      }
      return p;
    },
    [engine, xml],
  );
  return { load, loadMods };
}

export function StatExplain({ target, engine, xml, fmt, alt, mainSkill, onClose, onKeep, onLeave }: { target: TipTarget; engine: EngineHandle | null; xml: string; fmt: NumFormat; alt: boolean; mainSkill: string | undefined; onClose: () => void; onKeep: () => void; onLeave: () => void }) {
  const { row } = target;
  const { load, loadMods } = useExplainData(engine, xml);
  const [data, setData] = useState<ExplainData | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    const p = load();
    if (!p) return setData(null);
    void p.then((d) => live && setData(d)).catch(() => live && setData(null));
    return () => {
      live = false;
    };
  }, [load]);

  // The breakdown is of the Calcs tab's skill: it only explains the sidebar's number when that is the main skill.
  const same = !!data && (!mainSkill || data.skill === mainSkill);
  const key = same && data ? statBreakdownKey(row, data.tables) : null;
  const details = useMemo(() => (same && data && key ? statDetails(row, key, data.index) : []), [same, data, key, row]);

  // ---- the full breakdown (Alt, a click or Enter): the Calcs popup ----
  const facts = useMemo(() => readFacts(xml), [xml]);
  const treeVersion = (activeSpecOf(facts)?.treeVersion ?? '').replace('.', '_');
  const treeNodes = useTreeNodes(treeVersion);
  const treeText = useTreeText(treeVersion);
  const items = useMemo(() => equipped(facts), [facts]);
  const env: PopupEnv = useMemo(
    () => ({
      tables: data?.tables ?? null,
      loadMods,
      slotItem: (slot) => {
        const it = items.get(slot);
        return it ? { name: it.name, rarity: it.rarity, id: it.id } : null;
      },
      itemRarity: (id) => facts.items.get(id)?.rarity ?? null,
      loadItem: (id) => {
        const it = facts.items.get(id);
        return it && engine ? engine.call('itemInfo', { itemText: it.raw }).then((r) => r.item).catch(() => null) : Promise.resolve(null);
      },
      treeVersion,
      treeState: null,
      node: (id) => {
        const st = treeNodes?.[String(id)];
        const tx = treeText?.get(id);
        return st || tx ? { n: tx?.n || st?.n || tr('StatExplain.node_id', { id }), t: tx ? NODE_KIND[tx.t] ?? 'Passive' : st?.t ?? 'Passive', a: tx?.a ?? st?.a, sp: st?.sp, stats: tx?.s } : undefined;
      },
      fmt: fmt ?? DEFAULT_NUM_FORMAT,
    }),
    [data, loadMods, items, facts, engine, treeVersion, treeNodes, treeText, fmt],
  );

  const full = (alt || target.pinned) && details.length > 0;
  if (full) {
    const pt: PopupTarget = { key: `sb:${row.key}`, pinned: target.pinned, cell: target.cell, card: target.card, title: lbl(row.label), text: row.text, details };
    return <Popup target={pt} env={env} onClose={onClose} onKeep={onKeep} onLeave={onLeave} />;
  }
  return <ExplainCard target={target} meaning={((m) => (m === undefined ? m : inLanguage('ml_misc_statmean', m)))(statMeaning(row.stat, row.childStat))} loading={data === undefined} noBreakdown={data !== undefined && !key} otherSkill={!!data && !same} hasFull={details.length > 0} alt={alt} />;
}

function ExplainCard({ target, meaning, loading, noBreakdown, otherSkill, hasFull, alt }: { target: TipTarget; meaning: string | undefined; loading: boolean; noBreakdown: boolean; otherSkill: boolean; hasFull: boolean; alt: boolean }) {
  const { row } = target;
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const W = window.innerWidth;
    const H = window.innerHeight;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = target.card.right + 10;
    if (left + w > W - 8) left = Math.max(8, target.card.left - 10 - w);
    if (left + w > W - 8) left = Math.max(8, Math.min(target.card.left, W - w - 8));
    const top = Math.max(8, Math.min(target.cell.top - 12, H - h - 8));
    setPos({ left, top });
  }, [target.cell, target.card, loading]);
  return portal(
    <div ref={ref} className="sb-explain" role="tooltip" data-lg="pop" data-testid="stat-explain" style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden', pointerEvents: 'none' }}>
      <div className="hd tt-band col">
        <span className="t">{lbl(row.label)}</span>
        <span className="v">{row.text}{row.suffix ? <span className="sfx"> ({lbl(row.suffix)})</span> : null}</span>
      </div>
      {meaning && <div className="mean">{meaning}</div>}
      {loading && <div className="note">{tr('StatExplain.reading_the_calculation')}</div>}
      {alt && otherSkill && <div className="note">{tr('StatExplain.the_calcs_tab_is_on')}</div>}
      {noBreakdown && !otherSkill && !meaning && <div className="note">{tr('StatExplain.this_number_has_no_breakdown')}</div>}
      {hasFull && !alt && <div className="ft"><AltHint /></div>}
    </div>,
    document.body,
  );
}
