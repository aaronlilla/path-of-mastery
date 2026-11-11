import { useEffect, useMemo, useState } from 'react';
import { Dialog, Icon } from '../../ui';
import { Over } from '../dialogs';
import { MenuHost, PickButton, useMenu, type MenuEntry } from '../parts';
import { CURRENCIES, ELDRITCH_SLOTS, categoryOf, type QueryMods, type StatWeight } from './model';
import pseudoStats from '../tradePseudo.json';
import { tr } from '../../i18n';

const QO_WORD: Record<string, string> = { 'Copy Current': tr('h_c_It.q_copy_current'), 'Keep regular': tr('h_c_It.q_keep_regular'), 'Keep regular+presence': tr('h_c_It.q_keep_regular_presence'), Remove: tr('h_c_It.q_remove'), Keep: tr('h_c_It.q_keep'), Base: tr('items_dialogs.base'), Abyss: tr('h_c_It.q_abyss') };
const qw = (v: string) => QO_WORD[v] ?? v;

export interface ModSel {
  tradeId: string;
  label: string;
  value?: number;
}

export interface QueryOpts {
  includeCorrupted: boolean;
  includeMirrored: boolean;
  includeScourge: boolean;
  includeTalisman: boolean;
  eldritch: string;
  copyEnchant: string;
  jewelType: 'Base' | 'Abyss';
  maxPrice: string;
  maxPriceType: number;
  maxLevel: string;
  sockets: string;
  links: string;
  includeAllWEMods: boolean;
  jewelSlot: string | null;
  ringSlot: string | null;
  required: ModSel[];
  blocked: ModSel[];
}

export const DEFAULT_OPTS: QueryOpts = {
  includeCorrupted: true,
  includeMirrored: true,
  includeScourge: true,
  includeTalisman: false,
  eldritch: 'Copy Current',
  copyEnchant: 'Keep',
  jewelType: 'Base',
  maxPrice: '',
  maxPriceType: 0,
  maxLevel: '',
  sockets: '',
  links: '',
  includeAllWEMods: false,
  jewelSlot: null,
  ringSlot: null,
  required: [],
  blocked: [],
};

let modsOnce: Promise<QueryMods> | null = null;
/** Upstream's list of mods the search can weigh (about 3,600), read when first needed. */
export function loadQueryMods(): Promise<QueryMods> {
  modsOnce ??= import('../queryMods.json').then((m) => m.default as unknown as QueryMods);
  return modsOnce;
}

const IGNORED_PSEUDO = [/^pseudo\.lake/, /^pseudo\.pseudo_lake/, /^pseudo\.pseudo_logbook/, /^pseudo\.pseudo_temple/, /^pseudo\.pseudo_map/, /^pseudo\.pseudo_ritual/];

/** The stats a Required or Blocked row can pick: the slot's explicit, implicit and corrupted mods, then the pseudo totals. */
export function statChoices(data: QueryMods, key: string): Array<{ tradeId: string; label: string; kind: 'Explicit' | 'Implicit' | 'Corrupted' | 'Pseudo' }> {
  const seen = new Set<string>();
  const out: Array<{ tradeId: string; label: string; kind: 'Explicit' | 'Implicit' | 'Corrupted' | 'Pseudo' }> = [];
  for (const g of ['Explicit', 'Implicit', 'Corrupted'] as const) {
    for (const m of data[g] ?? []) {
      if (!m.c[key] || seen.has(m.id)) continue;
      seen.add(m.id);
      out.push({ tradeId: m.id, label: m.t.replace(/(\w+) Passive Skills in Radius also grant /, '$1: '), kind: g });
    }
  }
  for (const p of pseudoStats as Array<{ id: string; text: string }>) {
    if (IGNORED_PSEUDO.some((r) => r.test(p.id))) continue;
    out.push({ tradeId: p.id, label: p.text, kind: 'Pseudo' });
  }
  return out;
}

const ELDRITCH_TIP = [
  tr('items_trader_QueryOptions.controls_the_inclusion_of_eldritch'),
  tr('items_trader_QueryOptions.copy_current_implicits_in_weights'),
  tr('items_trader_QueryOptions.keep_regular_weights_are_generated'),
  tr('items_trader_QueryOptions.keep_regular_presence_weights_are'),
  tr('items_trader_QueryOptions.remove_eldritch_implicits_are_remove'),
].join('\n\n');

function Check({ on, onChange, disabled, label, tip }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string; tip?: string }) {
  return (
    <label className="tr-qo-row" title={tip}>
      <span className="k">{label}</span>
      <input type="checkbox" className="tr-check" checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

function Num({ label, value, onChange, width = 90 }: { label: string; value: string; onChange: (v: string) => void; width?: number }) {
  return (
    <div className="tr-qo-row">
      <span className="k">{label}</span>
      <input className="it-input n" style={{ width }} inputMode="numeric" aria-label={label} value={value} onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))} />
    </div>
  );
}

export interface QueryOptionsProps {
  slotName: string;
  label: string;
  unique?: 'Megalomaniac' | "Watcher's Eye" | 'Pearl of Tsoatha';
  isJewel: boolean;
  isAbyssal: boolean;
  itemType: string | undefined;
  league: string;
  weights: StatWeight[];
  initial: QueryOpts;
  /** Active jewel sockets for the Watcher's Eye row, and ring slots for the Pearl row. */
  jewelSockets: Array<{ name: string; label: string }>;
  ringSlots: Array<{ name: string; label: string }>;
  onExecute: (o: QueryOpts) => void;
  onCancel: () => void;
}

/** The "Query Options" popup of a row's Find best (`TradeQueryGenerator:RequestQuery`). */
export function QueryOptionsDialog(p: QueryOptionsProps) {
  const [o, setO] = useState<QueryOpts>(() => ({
    ...p.initial,
    includeCorrupted: p.unique === 'Megalomaniac' ? false : p.initial.includeCorrupted,
    jewelType: p.isAbyssal ? 'Abyss' : p.initial.jewelType,
    jewelSlot: p.initial.jewelSlot && p.jewelSockets.some((s) => s.name === p.initial.jewelSlot) ? p.initial.jewelSlot : p.jewelSockets[0]?.name ?? null,
    ringSlot: p.initial.ringSlot && p.ringSlots.some((s) => s.name === p.initial.ringSlot) ? p.initial.ringSlot : p.ringSlots[0]?.name ?? null,
  }));
  const set = (patch: Partial<QueryOpts>) => setO((c) => ({ ...c, ...patch }));
  const { menu, open, close } = useMenu();
  const [data, setData] = useState<QueryMods | null>(null);
  useEffect(() => {
    void loadQueryMods().then(setData);
  }, []);
  const key = useMemo(() => {
    if (p.unique) return null;
    const c = categoryOf(p.slotName, p.itemType);
    if (!c) return null;
    return p.isJewel && !p.isAbyssal ? `${o.jewelType}Jewel` : c.key;
  }, [p.slotName, p.itemType, p.unique, p.isJewel, p.isAbyssal, o.jewelType]);
  const choices = useMemo(() => (data && key ? statChoices(data, key) : []), [data, key]);
  const standard = p.league === 'Standard' || p.league === 'Hardcore';
  const isWeapon = p.slotName === 'Weapon 1' || p.slotName === 'Weapon 2';
  const eldritch = ELDRITCH_SLOTS.includes(p.slotName);
  const showScourge = !p.isJewel && !p.isAbyssal && standard && !p.unique;
  const showSockets = !p.unique && !p.isJewel && !p.isAbyssal && !/Flask/.test(p.slotName);
  const showLinks = showSockets && !/Belt|Ring|Amulet/.test(p.slotName);
  const canRun = !p.unique || !(p.unique === "Watcher's Eye" && !o.jewelSlot);
  const nameOf = (list: Array<{ name: string; label: string }>, n: string | null) => list.find((x) => x.name === n)?.label ?? tr('items_trader_QueryOptions_2.none');

  const modRows = (field: 'required' | 'blocked', title: string, first: string) => {
    const list = o[field];
    const rows = Math.min(5, list.length + 1);
    return (
      <div className="tr-qo-mods">
        <div className="tr-qo-h">{title}</div>
        {Array.from({ length: rows }, (_, i) => {
          const sel = list[i];
          const entries: MenuEntry[] = [
            { key: '__none', label: first, run: () => set({ [field]: list.filter((_, j) => j !== i) } as Partial<QueryOpts>) },
            ...choices.map((c) => ({
              key: c.tradeId,
              label: c.label,
              colour: c.kind === 'Pseudo' ? 'var(--text-faint)' : 'var(--mod-explicit)',
              right: c.kind === 'Explicit' ? undefined : c.kind,
              on: sel?.tradeId === c.tradeId,
              run: () => {
                const next = [...list];
                next[i] = { tradeId: c.tradeId, label: c.label, value: sel?.value };
                set({ [field]: next } as Partial<QueryOpts>);
              },
            })),
          ];
          return (
            <div key={i} className="tr-qo-mod">
              <PickButton small value={sel?.label ?? first} colour={sel ? undefined : 'var(--text-muted)'} onOpen={(el) => open(el, entries, 420)} />
              {sel && (
                <>
                  <input className="it-input n" style={{ width: 70 }} inputMode="numeric" placeholder={tr('items_trader_QueryOptions.min')} aria-label={tr('items_trader_QueryOptions.title_minimum', { title })} value={sel.value === undefined ? '' : String(sel.value)} onChange={(e) => {
                    const v = e.target.value.replace(/[^\d.-]/g, '').slice(0, 6);
                    const next = [...list];
                    next[i] = { ...sel, value: v === '' || Number.isNaN(Number(v)) ? undefined : Number(v) };
                    set({ [field]: next } as Partial<QueryOpts>);
                  }} />
                  <button type="button" className="it-icon" aria-label={tr('items_trader_QueryOptions.remove_this_stat')} title={tr('items_trader_QueryOptions.remove_this_stat')} onClick={() => set({ [field]: list.filter((_, j) => j !== i) } as Partial<QueryOpts>)}>
                    <Icon name="x" size={12} />
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <Over>
      <Dialog size="medium" title={tr('items_trader_QueryOptions.query_options')} subtitle={p.label} confirmLabel={tr('items_trader_QueryOptions.execute')} confirmIcon="search" confirmDisabled={!canRun} onCancel={p.onCancel} onConfirm={() => canRun && p.onExecute(o)}>
        <div className="tr-qo">
          <Check on={o.includeCorrupted} disabled={p.unique === 'Megalomaniac'} onChange={(v) => set({ includeCorrupted: v })} label={tr('items_trader_QueryOptions.corrupted_mods')} tip={tr('items_trader_QueryOptions.includes_corruption_implicit_modifie')} />
          {p.unique === "Watcher's Eye" && (
            <div className="tr-qo-row">
              <span className="k">{tr('items_trader_QueryOptions.jewel_slot')}</span>
              <PickButton small value={nameOf(p.jewelSockets, o.jewelSlot)} disabled={!p.jewelSockets.length} onOpen={(el) => open(el, p.jewelSockets.map((s) => ({ key: s.name, label: s.label, on: s.name === o.jewelSlot, run: () => set({ jewelSlot: s.name }) })), 160)} />
            </div>
          )}
          {p.unique === 'Pearl of Tsoatha' && (
            <div className="tr-qo-row">
              <span className="k">{tr('items_trader_QueryOptions.ring_slot')}</span>
              <PickButton small value={nameOf(p.ringSlots, o.ringSlot)} disabled={!p.ringSlots.length} onOpen={(el) => open(el, p.ringSlots.map((s) => ({ key: s.name, label: s.label, on: s.name === o.ringSlot, run: () => set({ ringSlot: s.name }) })), 160)} />
            </div>
          )}
          {!p.unique && <Check on={o.includeMirrored} onChange={(v) => set({ includeMirrored: v })} label={tr('items_trader_QueryOptions.mirrored_items')} />}
          {showScourge && <Check on={o.includeScourge} onChange={(v) => set({ includeScourge: v })} label={tr('items_trader_QueryOptions.scourge_mods')} />}
          {p.slotName === 'Amulet' && <Check on={o.includeTalisman} onChange={(v) => set({ includeTalisman: v })} label={tr('items_trader_QueryOptions.talisman_mods')} tip={tr('items_trader_QueryOptions.whether_talisman_enchant_mods_should')} />}
          {eldritch && !p.unique && (
            <div className="tr-qo-row" title={ELDRITCH_TIP}>
              <span className="k">{tr('items_trader_QueryOptions.eldritch_mods')}</span>
              <PickButton small value={qw(o.eldritch)} onOpen={(el) => open(el, ['Copy Current', 'Keep regular', 'Keep regular+presence', 'Remove'].map((v) => ({ key: v, label: qw(v), on: v === o.eldritch, run: () => set({ eldritch: v }) })), 190)} />
            </div>
          )}
          {(isWeapon || p.slotName === 'Amulet' || p.slotName === 'Belt') && !p.unique && (
            <div className="tr-qo-row" title={[tr(isWeapon ? 'h_c_It.tip_keep_enchants' : 'h_c_It.tip_keep_anoints'), tr(isWeapon ? 'h_c_It.tip_copy_enchants' : 'h_c_It.tip_copy_anoints'), tr(isWeapon ? 'h_c_It.tip_remove_enchants' : 'h_c_It.tip_remove_anoints')].join('\n')}>
              <span className="k">{isWeapon ? tr('items_trader_QueryOptions.enchant_behaviour') : tr('items_trader_QueryOptions.anoint_behaviour')}</span>
              <PickButton small value={qw(o.copyEnchant)} onOpen={(el) => open(el, ['Keep', 'Copy Current', 'Remove'].map((v) => ({ key: v, label: qw(v), on: v === o.copyEnchant, run: () => set({ copyEnchant: v }) })), 160)} />
            </div>
          )}
          {p.isJewel && !p.unique && (
            <div className="tr-qo-row">
              <span className="k">{tr('items_trader_QueryOptions.jewel_type')}</span>
              <PickButton small value={qw(p.isAbyssal ? 'Abyss' : o.jewelType)} disabled={p.isAbyssal} onOpen={(el) => open(el, (['Base', 'Abyss'] as const).map((v) => ({ key: v, label: qw(v), on: v === o.jewelType, run: () => set({ jewelType: v, required: [], blocked: [] }) })), 140)} />
            </div>
          )}
          <div className="tr-qo-row" title={tr('items_trader_QueryOptions.the_trade_site_will_filter')}>
            <span className="k">{tr('items_trader_QueryOptions.max_price')}</span>
            <span className="tr-qo-pair">
              <input className="it-input n" style={{ width: 70 }} inputMode="numeric" aria-label={tr('items_trader_QueryOptions.max_price_2')} value={o.maxPrice} onChange={(e) => set({ maxPrice: e.target.value.replace(/\D/g, '').slice(0, 6) })} />
              <PickButton small value={CURRENCIES[o.maxPriceType]?.name} onOpen={(el) => open(el, CURRENCIES.map((c, i) => ({ key: c.name, label: c.name, on: i === o.maxPriceType, run: () => set({ maxPriceType: i }) })), 200)} />
            </span>
          </div>
          <Num label={tr('items_trader_QueryOptions.max_level')} value={o.maxLevel} onChange={(v) => set({ maxLevel: v })} />
          {showSockets && <Num label={tr('items_trader_QueryOptions.of_empty_sockets')} value={o.sockets} onChange={(v) => set({ sockets: v })} width={70} />}
          {showLinks && <Num label={tr('items_trader_QueryOptions.of_links')} value={o.links} onChange={(v) => set({ links: v })} width={70} />}
          <div className="tr-qo-row" title={tr('items_trader_QueryOptions.sorts_the_weights_by_the')}>
            <span className="k">{tr('items_trader_QueryOptions.stat_to_sort_by')}</span>
            <span className="tr-qo-stats">
              {p.weights.slice(0, p.weights.length < 6 ? 10 : 4).map((w) => (
                <span key={w.stat}>{`${w.weightMult.toFixed(2)}: ${w.label}`}</span>
              ))}
              {p.weights.length >= 6 && (
                <span title={p.weights.slice(4).map((w) => `${w.label}: ${w.weightMult.toFixed(2)}`).join('\n')}>{tr('items_trader_QueryOptions.length_additional_stats', { value: p.weights.length - 4 })}</span>
              )}
            </span>
          </div>
          {p.unique === "Watcher's Eye" && <Check on={o.includeAllWEMods} onChange={(v) => set({ includeAllWEMods: v })} label={tr('items_trader_QueryOptions.include_all_watcher_s_eye')} tip={tr('items_trader_QueryOptions.include_mods_that_could_not')} />}
          {!p.unique && (
            <>
              {!data && <span className="it-sub">{tr('items_trader_QueryOptions.loading_the_trade_site_s')}</span>}
              {modRows('required', tr('items_trader_QueryOptions_2.required_stats'), tr('items_trader_QueryOptions_2.add_required_stat'))}
              {modRows('blocked', tr('items_trader_QueryOptions_2.blocked_stats'), tr('items_trader_QueryOptions_2.add_blocked_stat'))}
            </>
          )}
        </div>
      </Dialog>
      <MenuHost menu={menu} close={close} onTip={() => undefined} offTip={() => undefined} />
    </Over>
  );
}
