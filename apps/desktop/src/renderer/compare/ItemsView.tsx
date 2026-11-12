import type { BuildEdit, ItemInfo, StatDelta } from '@pom/protocol';
import { useEffect, useMemo, useRef, useState } from 'react';
import { activeSpecOf, addItemXml, equipped, setActiveSetXml, setJewelXml, type BuildFacts, type ItemFact } from '../../shared/buildFacts.js';
import { abyssSlots, itemSlots, planPower, POWER_STATS, powerValue, type PowerStat } from '../../shared/comparePower.js';
import { formatStat, type Out } from '../../shared/displayStats.js';
import { artUrl, RARITY_COLOUR, useGameInfo } from '../gameData';
import { baseArtNames, hasArt } from '../gameArt';
import { pickItemArt } from './itemArtPick';
import { BuyDialog } from '../items/BuyDialog';
import { ItemTooltip } from '../items/ItemTooltip';
import { useHoverTip } from '../items/parts';
import { skillKindOf } from '../items/statCompare';
import { Art, CheckBox } from '../tabKit';
import { Icon, useToast } from '../ui';
import { effectiveStat, measure } from './measure';
import { SetSelect } from './SetBar';
import { label as lbl, tr } from '../i18n';

interface Row {
  key: string;
  label: string;
  /** The gear slot's name, or '' for a jewel socket. */
  slot: string;
  node?: number;
  a?: ItemFact;
  b?: ItemFact;
  /** A jewel socket or abyssal socket line under a gear slot. */
  sub?: boolean;
  head?: boolean;
}

const ABYSS_BASE = ['Weapon 1', 'Weapon 2', 'Weapon 1 Swap', 'Weapon 2 Swap', 'Helmet', 'Body Armour', 'Gloves', 'Boots', 'Belt'];

/** The rows of the list: every slot either build uses, its abyssal sockets, then the tree's jewel sockets. */
export function itemRows(a: BuildFacts, b: BuildFacts): Row[] {
  const ea = equipped(a);
  const eb = equipped(b);
  const rows: Row[] = [];
  for (const slot of itemSlots(a, b)) {
    rows.push({ key: slot, label: lbl(slot), slot, a: ea.get(slot), b: eb.get(slot) });
    if (ABYSS_BASE.includes(slot)) {
      const n = Math.max(ea.get(slot)?.abyssal ?? 0, eb.get(slot)?.abyssal ?? 0);
      for (let i = 1; i <= Math.min(6, n); i++) {
        const k = `${slot} Abyssal Socket ${i}`;
        rows.push({ key: k, label: tr('compare_ItemsView.abyssal_socket_i', { i }), slot: k, a: ea.get(k), b: eb.get(k), sub: true });
      }
    }
  }
  void abyssSlots;
  const sa = activeSpecOf(a);
  const sb = activeSpecOf(b);
  const nodes = [...new Set([...(sa?.jewels.keys() ?? []), ...(sb?.jewels.keys() ?? [])])].sort((x, y) => x - y);
  if (nodes.length) rows.push({ key: 'jewels', label: tr('compare_ItemsView.jewels'), slot: '', head: true });
  for (const n of nodes) rows.push({ key: `Jewel ${n}`, label: tr('compare_ItemsView.socket_n', { n }), slot: '', node: n, a: a.items.get(sa?.jewels.get(n) ?? 0), b: b.items.get(sb?.jewels.get(n) ?? 0) });
  return rows;
}

interface Props {
  aFacts: BuildFacts;
  bFacts: BuildFacts;
  aXml: string;
  bLabel: string;
  aEngineId: string | null;
  bEngineId: string | null;
  aOut: Out | null;
  /** Changes when the numbers of this build or the compared one change. */
  version: unknown;
  onlyDiff: boolean;
  /** Edits of this build (A) and its text; of the compared build (B). */
  editA: (e: BuildEdit) => Promise<{ ok: boolean; error?: string }>;
  editAXml: (fn: (xml: string) => string) => Promise<unknown>;
  onUndo: () => Promise<unknown>;
}

const cmdItem = async (buildId: string | null, itemText: string): Promise<ItemInfo | null> => {
  const r = await window.pom.sendCommand('itemInfo', { buildId, itemText });
  return r.ok ? r.result.item : null;
};

export function ItemsView(p: Props) {
  const toast = useToast();
  const info = useGameInfo();
  const [expanded, setExpanded] = useState(false);
  const [buy, setBuy] = useState<{ info: ItemInfo; slot: string } | null>(null);
  const cache = useRef(new Map<string, Promise<ItemInfo | null>>());
  const stats = (p.aOut ?? {}) as Record<string, number | string | boolean | null>;
  const tip = useHoverTip(skillKindOf(stats), stats);
  const rows = useMemo(() => itemRows(p.aFacts, p.bFacts), [p.aFacts, p.bFacts]);

  const infoOf = (engineId: string | null, raw: string): Promise<ItemInfo | null> => {
    const k = (engineId ?? '') + '|' + raw;
    let v = cache.current.get(k);
    if (!v) {
      v = cmdItem(engineId, raw);
      cache.current.set(k, v);
    }
    return v;
  };

  // The change to Full DPS from putting B's item in each slot of this build.
  const [swap, setSwap] = useState<Record<string, number | null> | null>(null);
  const [base, setBase] = useState<{ stat: PowerStat; base: number } | null>(null);
  useEffect(() => {
    setSwap(null);
    if (!p.aEngineId || !p.aOut) return;
    let live = true;
    const stat = effectiveStat(POWER_STATS.find((s) => s.stat === 'FullDPS')!, p.aOut);
    const tasks = planPower({ primary: p.aFacts, primaryXml: p.aXml, primaryNodes: [], compare: p.bFacts, nodes: null, schema: { sections: [], options: [] }, isSupport: () => false, categories: { Tree: false, Items: true, 'Skill gems': false, 'Support gems': false, Config: false } }).filter((t) => t.kind === 'item');
    setBase({ stat, base: powerValue(stat, p.aOut[stat.stat]) });
    void measure(p.aEngineId, tasks, stat, () => live).then((imp) => {
      if (live && imp) setSwap(Object.fromEntries(tasks.map((t, i) => [t.id.replace(/^(item|jewel):/, (m) => (m === 'jewel:' ? 'Jewel ' : '')), imp[i]?.v ?? null])));
    });
    return () => {
      live = false;
    };
  }, [p.aEngineId, p.version, p.aXml, p.bFacts]); // eslint-disable-line react-hooks/exhaustive-deps

  const equipEdit = (r: Row, it: ItemFact): BuildEdit => (r.node !== undefined ? { kind: 'setXml', xml: setJewelXml(p.aXml, r.node, it.raw) } : { kind: 'setItem', slot: r.slot, itemText: it.raw });

  const doCopy = async (it: ItemFact) => {
    await p.editAXml((x) => addItemXml(x, it.raw).xml);
    toast({ text: tr('compare_ItemsView.copied_name_to_this_build', { name: it.name }), kind: 'ok', action: { label: tr('compare_ItemsView.undo'), run: () => void p.onUndo() } });
  };
  const doEquip = async (r: Row, it: ItemFact) => {
    const res = await p.editA(equipEdit(r, it));
    if (!res.ok) return void toast({ text: tr('compare_ItemsView_2.couldn_t_equip', { name: it.name, error: res.error ?? '' }).trim(), kind: 'error' });
    toast({ text: tr('compare_ItemsView.equipped_name_in_label', { name: it.name, label: r.label }), kind: 'ok', action: { label: tr('compare_ItemsView.undo'), run: () => void p.onUndo() } });
  };
  const doBuy = async (r: Row, it: ItemFact) => {
    const inf = await infoOf(p.bEngineId, it.raw);
    if (inf) setBuy({ info: inf, slot: r.slot || r.label });
  };
  const showItem = (el: Element, engineId: string | null, it: ItemFact) => {
    void infoOf(engineId, it.raw).then((inf) => inf && el.isConnected && tip.show(el, { info: inf }));
  };
  const showEquip = (el: Element, r: Row, it: ItemFact) => {
    const load = async (): Promise<StatDelta[]> => {
      const res = await window.pom.sendCommand('previewEdit', { buildId: p.aEngineId!, edit: equipEdit(r, it), full: true });
      return res.ok ? res.result.statDiff.changed : [];
    };
    void infoOf(p.bEngineId, it.raw).then((inf) => {
      if (!el.isConnected) return;
      tip.show(el, { info: inf ?? undefined, compares: [{ header: tr('compare_ItemsView.equipping_this_item_in_label', { label: r.label }), replacing: p.aFacts && equipped(p.aFacts).get(r.slot) ? { name: equipped(p.aFacts).get(r.slot)!.name, colour: RARITY_COLOUR[equipped(p.aFacts).get(r.slot)!.rarity] } : undefined, load }] });
    });
  };

  // Expanded mode: the item cards of both builds.
  const [infos, setInfos] = useState<Map<string, ItemInfo>>(new Map());
  useEffect(() => {
    if (!expanded) return;
    let live = true;
    void (async () => {
      const m = new Map<string, ItemInfo>();
      for (const r of rows) {
        for (const [side, it, id] of [['a', r.a, p.aEngineId], ['b', r.b, p.bEngineId]] as const) {
          if (!it) continue;
          const inf = await infoOf(id, it.raw);
          if (inf) m.set(side + r.key, inf);
        }
      }
      if (live) setInfos(m);
    })();
    return () => {
      live = false;
    };
  }, [expanded, rows, p.aEngineId, p.bEngineId]); // eslint-disable-line react-hooks/exhaustive-deps

  const itemSrc = (it: ItemFact): string | undefined => {
    const pk = pickItemArt(it, hasArt, baseArtNames());
    return pk ? artUrl(info, pk.name, pk.category) : undefined;
  };

  const cell = (it: ItemFact | undefined, none: string) =>
    it ? (
      <span className="itm">
        <Art src={itemSrc(it)} size={28} />
        <span className="ellipsis" style={{ color: RARITY_COLOUR[it.rarity] ?? 'var(--text)' }} title={it.name}>{it.name}</span>
      </span>
    ) : (
      <span style={{ color: 'var(--text-faint)' }}>{none}</span>
    );

  return (
    <div className="cmp-scroll scroll-thin cmp-items">
      <div className="cmp-ibar">
        <CheckBox checked={expanded} label={tr('compare_ItemsView.expanded_mode')} onChange={setExpanded} />
        <span style={{ flex: 1 }} />
        <SetSelect facts={p.aFacts} kind="itemSet" caption={tr('compare_ItemsView.a_item_set')} onPick={(id) => void p.editAXml((x) => setActiveSetXml(x, 'itemSet', id))} />
        <SetSelect facts={p.aFacts} kind="spec" caption={tr('compare_ItemsView.a_tree_set')} onPick={(id) => void p.editAXml((x) => setActiveSetXml(x, 'spec', id))} />
      </div>
      <div className="cmp-hdr4">
        <span>{tr('compare_ItemsView.slot')}</span>
        <span>{tr('compare_ItemsView.a_this_build')}</span>
        <span>{tr('compare_ItemsView.b_touppercase', { bLabel: p.bLabel.toUpperCase() })}</span>
        <span className="r" title={tr('CompareTab.change_to_full_dps_if')}>{tr('compare_ItemsView.touppercase_if_swapped', { value: lbl(base?.stat.label ?? 'DPS').toUpperCase() })}</span>
      </div>
      {rows
        .filter((r) => r.head || !p.onlyDiff || r.a?.name !== r.b?.name)
        .map((r) => {
          if (r.head) return <div key={r.key} className="cmp-ihead">{r.label}</div>;
          const same = !!r.a && !!r.b && r.a.name === r.b.name;
          const imp = swap ? swap[r.key] : undefined;
          const pct = imp !== undefined && imp !== null && base && base.base !== 0 ? (imp / Math.abs(base.base)) * 100 : null;
          const text = same ? '—' : !r.b ? tr('compare_ItemsView_2.empty') : imp === undefined ? '…' : imp === null ? '—' : pct === null ? (imp === 0 ? '±0%' : formatStat(imp, '.1f', 1, 0, true)) : pct === 0 ? '±0%' : `${pct > 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)}%`;
          const col = same || imp === undefined || imp === null || imp === 0 ? 'var(--text-muted)' : imp > 0 ? 'var(--positive-text)' : 'var(--negative-text)';
          const ia = infos.get('a' + r.key);
          const ib = infos.get('b' + r.key);
          return (
            <div className={'cmp-item' + (r.sub ? ' sub' : '') + (expanded ? ' open' : '')} data-lg="tile" key={r.key} style={{ opacity: same ? 0.6 : 1 }}>
              <span style={{ color: 'var(--text-3)' }}>{r.label}</span>
              {expanded ? (
                <div className="card" onMouseEnter={undefined}>{ia ? <ItemTooltip info={ia} className="inl" /> : r.a ? <span style={{ color: 'var(--text-faint)' }}>…</span> : <span style={{ color: 'var(--text-faint)' }}>{tr('compare_ItemsView.empty')}</span>}</div>
              ) : (
                <span className="hv" onMouseEnter={(e) => r.a && showItem(e.currentTarget, p.aEngineId, r.a)} onMouseLeave={tip.hide}>{cell(r.a, tr('compare_ItemsView_2.empty'))}</span>
              )}
              <div className="bcol">
                {expanded ? (
                  <div className="card">{ib ? <ItemTooltip info={ib} className="inl" /> : r.b ? <span style={{ color: 'var(--text-faint)' }}>…</span> : <span style={{ color: 'var(--text-faint)' }}>{tr('compare_ItemsView.empty')}</span>}</div>
                ) : same ? (
                  <span style={{ color: 'var(--text-faint)' }}>{tr('compare_ItemsView.same_item')}</span>
                ) : (
                  <span className="hv" onMouseEnter={(e) => r.b && showItem(e.currentTarget, p.bEngineId, r.b)} onMouseLeave={tip.hide}>{cell(r.b, tr('compare_ItemsView_2.empty'))}</span>
                )}
                {r.b && (
                  <span className="acts">
                    <button type="button" className="cmp-act" title={tr('compare_ItemsView.add_this_item_to_the')} onClick={() => void doCopy(r.b!)}>
                      <Icon name="copy" size={13} />
                      {tr('compare_ItemsView.copy')}
                    </button>
                    <button type="button" className="cmp-act" onMouseEnter={(e) => showEquip(e.currentTarget, r, r.b!)} onMouseLeave={tip.hide} onClick={() => void doEquip(r, r.b!)}>
                      <Icon name="check" size={13} />
                      {tr('compare_ItemsView.equip')}
                    </button>
                    <button type="button" className="cmp-act" title={tr('compare_ItemsView.search_the_trade_site_for')} onClick={() => void doBuy(r, r.b!)}>
                      <Icon name="external" size={13} />
                      {tr('compare_ItemsView.buy_similar')}
                    </button>
                  </span>
                )}
              </div>
              <span style={{ textAlign: 'right', color: col, fontWeight: 500 }}>{text}</span>
            </div>
          );
        })}
      {tip.node}
      {buy && <BuyDialog info={buy.info} slot={buy.slot} onClose={() => setBuy(null)} />}
    </div>
  );
}
