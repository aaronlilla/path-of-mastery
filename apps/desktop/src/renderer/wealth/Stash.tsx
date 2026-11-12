import { useMemo, useState } from 'react';
import type { BuildEdit } from '@pom/protocol';
import { fmtPct, type Cat, type StashRow, type TabInfo } from '../../shared/wealth.js';
import { useToast, Icon } from '../ui.js';
import { Cb, change, Chip, ItemIcon, LineChart, Panel, Spark, sparkTitle, CAT_COLOUR, catName } from './wui.js';
import { SellDialog } from './SellDialog.js';
import type { Wealth, WealthUi } from './useWealth.js';
import { loadCatalog } from '../items/engine.js';
import { addStashItemShared, stashItemText, type TryResult } from './stashItem.js';
import type { PremiumBuild } from './premiumUi.js';
import { label, tr } from '../i18n';
import { cxText, fmtOld, item, msg } from './mainText';

const CATS: [string, string][] = [['all', tr('wealth_Stash_2.all')], ['cur', tr('wealth_Stash_2.currency')], ['frag', tr('wealth_Stash_2.fragments')], ['scar', tr('wealth_Stash_2.scarabs')], ['uniq', tr('wealth_Stash_2.uniques')]];
/** Filters reached from the Overview (its Breakdown and Put it to work rows) that have no pill of their own: shown as one while active. */
const EXTRA_CATS: Record<string, string> = { other: tr('wealth_Stash.everything_else'), unpriced: tr('wealth_Stash.no_price') };
const PAGE = 200;
const CAT_ICON: Record<string, [string, string?]> = { all: ['Stacked Deck'], cur: ['Divine Orb'], frag: ['Simulacrum Splinter'], scar: ['Scarab of Wisps'], rare: ['Vermillion Ring', 'bases'], uniq: ['Mageblood', 'uniques'] };

/** A stand-in art name for a stash tab, by its type or name. */
function tabArt(t: TabInfo): [string, string | undefined, Cat] {
  const n = `${t.type} ${t.name}`;
  if (/Currency/i.test(n)) return ['Divine Orb', undefined, 'cur'];
  if (/Fragment/i.test(n)) return ['Simulacrum Splinter', undefined, 'frag'];
  if (/scarab/i.test(n)) return ['Scarab of Wisps', undefined, 'scar'];
  if (/Essence/i.test(n)) return ['Deafening Essence of Scorn', undefined, 'ess'];
  if (/Unique/i.test(n)) return ['Mageblood', 'uniques', 'uniq'];
  if (/Map/i.test(n)) return ['Strand Map', 'maps', 'map'];
  if (/Divination|Card/i.test(n)) return ['The Apothecary', undefined, 'card'];
  if (/Inventory/i.test(n)) return ['Chaos Orb', undefined, 'cur'];
  return ['Stacked Deck', undefined, 'other'];
}

export function matchesCat(r: StashRow, cat: string): boolean {
  if (cat === 'all') return true;
  if (cat === 'unpriced') return r.unit === null;
  if (cat === 'other') return r.cat === 'card' || r.cat === 'gem' || r.cat === 'ess' || r.cat === 'map' || r.cat === 'other';
  return r.cat === cat;
}

export function filterRows(rows: StashRow[], ui: Pick<WealthUi, 'q' | 'cat' | 'tab'>): StashRow[] {
  const q = ui.q.trim().toLowerCase();
  return rows.filter((r) => (ui.tab === 'all' || r.tabIds.includes(ui.tab)) && matchesCat(r, ui.cat) && (!q || r.name.toLowerCase().includes(q) || (r.base ?? '').toLowerCase().includes(q)));
}

export function Stash({ s, build, onEquip, onTryItem }: { s: Wealth; build?: PremiumBuild | null; onEquip?: (edit: BuildEdit) => Promise<boolean>; onTryItem?: (itemText: string) => Promise<TryResult | { error: string }> }) {
  const { w, ui, patch, fmt, go, now } = s;
  const toast = useToast();
  const [tried, setTried] = useState<{ key: string; res: TryResult } | null>(null);
  const [trying, setTrying] = useState(false);
  /** The text of a stash row: a unique's full item text comes from the item database. */
  const textOf = async (r: StashRow) => stashItemText(r, (await loadCatalog().catch(() => null))?.uniques ?? []);
  const copyText = async (r: StashRow) => {
    try {
      await navigator.clipboard.writeText((await textOf(r)).text);
      toast({ text: tr('wealth_Stash.copied_the_item_text_of', { name: r.name }), kind: 'ok' });
    } catch {
      toast({ text: tr('wealth_Stash.could_not_copy_to_the'), kind: 'error' });
    }
  };
  const saveShared = async (r: StashRow) => {
    const { text, gear } = await textOf(r);
    if (!gear) return void toast({ text: tr('wealth_Stash.name_is_not_gear_only', { name: r.name }), kind: 'error' });
    const got = await window.pom.shared.get();
    if (!got.ok) return void toast({ text: tr('wealth_Stash.couldn_t_read_the_shared', { error: got.error }), kind: 'error' });
    const { list, added } = addStashItemShared(got.value, text);
    if (!added) return void toast({ text: tr('wealth_Stash.name_is_already_a_shared', { name: r.name }), kind: 'ok' });
    const set = await window.pom.shared.set(list);
    toast(set.ok ? { text: tr('wealth_Stash.saved_name_as_a_shared', { name: r.name }), kind: 'ok' } : { text: tr('wealth_Stash.couldn_t_save_the_shared', { error: set.error }), kind: 'error' });
  };
  const tryOn = async (r: StashRow) => {
    if (!onTryItem) return;
    const { text, gear } = await textOf(r);
    if (!gear) return void toast({ text: tr('wealth_Stash.name_is_not_gear_so', { name: r.name }), kind: 'error' });
    setTrying(true);
    const res = await onTryItem(text).finally(() => setTrying(false));
    if ('error' in res) return void toast({ text: res.error, kind: 'error' });
    setTried({ key: r.key, res });
  };
  const [shown, setShown] = useState(PAGE);
  if (!w) return null;
  const tabName = (id: string) => w.tabs.find((t) => t.id === id)?.name ?? id;
  const rows = useMemo(() => {
    const f = filterRows(w.rows, ui);
    const key: Record<WealthUi['sortK'], (r: StashRow) => number | string> = {
      name: (r) => r.name.toLowerCase(),
      tab: (r) => tabName(r.tabIds[0] ?? ''),
      qty: (r) => r.qty,
      unit: (r) => r.unit ?? -1,
      total: (r) => (r.unit ?? -1) * r.qty,
      chg: (r) => change(r.spark),
    };
    const k = key[ui.sortK];
    return [...f].sort((a, b) => {
      const A = k(a);
      const B = k(b);
      return (A > B ? 1 : A < B ? -1 : 0) * ui.sortD;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w.rows, w.tabs, ui.q, ui.cat, ui.tab, ui.sortK, ui.sortD]);
  const shownVal = rows.reduce((a, r) => a + (r.unit ?? 0) * r.qty, 0);
  const sel = ui.sel ? w.rows.find((r) => r.key === ui.sel) : undefined;
  const counted = w.tabs.filter((t) => t.counted && t.readable).length;
  const sellable = rows.filter((r) => r.unit !== null);

  const toggleTab = (t: TabInfo, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!t.readable) return void toast({ text: tr('wealth_Stash.name_can_t_be_read', { name: t.name, why: item(t.why ?? 'not readable') }), kind: 'error' });
    const on = new Set(w.tabs.filter((x) => x.counted && x.readable).map((x) => x.id));
    if (on.has(t.id)) on.delete(t.id);
    else on.add(t.id);
    void window.pom.wealth.setCounted([...on]);
  };

  const exportCsv = () => {
    const esc = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
    const csv = 'Item,Tab,Qty,Unit low (c),Unit high (c),Total low (c)\n' + rows.map((r) => [esc(r.name), esc(r.tabIds.map(tabName).join(' + ')), r.qty, r.unit ?? '', r.hi ?? '', r.unit === null ? '' : Math.round(r.unit * r.qty * 100) / 100].join(',')).join('\n');
    void window.pom.wealth.exportCsv('stash.csv', csv).then((p) => p && toast({ text: tr('wealth_Stash.exported_length_rows', { count: rows.length }), kind: 'ok' }));
  };

  const Th = ({ label, k, al }: { label: string; k: WealthUi['sortK'] | null; al?: 'r' }) => (
    <button type="button" className={'w-h' + (al ? ' r' : '') + (k && ui.sortK === k ? ' on' : '')} disabled={!k} onClick={() => k && patch({ sortK: k, sortD: ui.sortK === k ? (-ui.sortD as 1 | -1) : -1 })}>
      {label}
      {k && ui.sortK === k ? (ui.sortD > 0 ? ' ↑' : ' ↓') : ''}
    </button>
  );

  // Picking a tab or a category never lands on an empty table because of the other filter: the one picked wins, and the
  // other (then the search text) falls back to "all" when the two together match nothing.
  const pickTab = (id: string) => {
    const tab = ui.tab === id ? 'all' : id;
    if (filterRows(w.rows, { q: ui.q, cat: ui.cat, tab }).length > 0) return patch({ tab });
    if (filterRows(w.rows, { q: ui.q, cat: 'all', tab }).length > 0) return patch({ tab, cat: 'all' });
    patch({ tab, cat: 'all', q: '' });
  };
  const pickCat = (cat: string) => {
    if (filterRows(w.rows, { q: ui.q, cat, tab: ui.tab }).length > 0) return patch({ cat });
    if (filterRows(w.rows, { q: ui.q, cat, tab: 'all' }).length > 0) return patch({ cat, tab: 'all' });
    patch({ cat, tab: 'all', q: '' });
  };
  return (
    <div className={'w-stash' + (sel ? ' sel' : '')}>
      <Panel className="w-rail">
        <div className="w-eyebrow">
          <span title={tr('wealth_Stash.tick_a_tab_to_count')}>{tr('wealth_Stash.tabs_counted_of_length_counted', { counted, count: w.tabs.length })}</span>
        </div>
        <div className="w-rail-list">
          {w.tabs.map((t) => (
            <div key={t.id} role="button" tabIndex={0} className="w-tab" data-on={ui.tab === t.id} style={{ opacity: t.readable ? (t.counted ? 1 : 0.6) : 0.5 }} onClick={() => t.readable && pickTab(t.id)} onKeyDown={(e) => e.key === 'Enter' && t.readable && pickTab(t.id)}>
              <Cb on={t.counted && t.readable} label={tr('wealth_Stash.count_name', { name: t.name })} onClick={(e) => toggleTab(t, e)} />
              <i className="w-tab-bar" style={{ background: t.colour }} />
              <ItemIcon name={tabArt(t)[0]} cat={tabArt(t)[2]} size={26} {...(tabArt(t)[1] ? { artCat: tabArt(t)[1] } : {})} />
              <span className="w-name" title={t.readable ? (t.counted ? tr('h_c_Wl.tab_tip_counted', { n: t.items.toLocaleString(), value: fmt(t.value) }) : tr('h_c_Wl.tab_tip_uncounted', { n: t.items.toLocaleString() })) : tr('wealth_Stash.cannot_be_read_why', { why: item(t.why ?? 'not readable') })}><span className="w-tn">{t.name}</span></span>
              <span className="r" style={{ color: t.counted ? 'var(--text-strong)' : 'var(--text-faint)' }}>{t.readable && t.counted ? (w.prices.lines === 0 ? '—' : fmt(t.value)) : !t.readable ? <i className="w-tab-st" style={{ color: 'var(--warning)' }} title={t.why ? item(t.why) : undefined}>{t.why ? item(t.why) : ''}</i> : <i className="w-tab-st">{tr('wealth_Stash.not_counted')}</i>}</span>
            </div>
          ))}
        </div>
      </Panel>
      <Panel className="w-tbl">
        <div className="w-tool">
          <label className="w-search">
            <input value={ui.q} onChange={(e) => { patch({ q: e.target.value }); setShown(PAGE); }} placeholder={tr('wealth_Stash.search_items')} aria-label={tr('wealth_Stash.search_items')} />
          </label>
          <div className="w-cats">
            {[...CATS, ...(EXTRA_CATS[ui.cat] ? [[ui.cat, EXTRA_CATS[ui.cat]!] as [string, string]] : [])].map(([k, l]) => (
              <button key={k} type="button" aria-pressed={ui.cat === k} onClick={() => { pickCat(k); setShown(PAGE); }}>
                {CAT_ICON[k] && <ItemIcon name={CAT_ICON[k]![0]} cat="other" {...(CAT_ICON[k]![1] ? { artCat: CAT_ICON[k]![1] } : {})} size={18} />}
                {l}
              </button>
            ))}
          </div>
          <span className="grow" />
          <button type="button" className="w-btn alt sm" aria-label={tr('wealth_Stash.export_csv')} title={tr('wealth_Stash.export_csv')} onClick={exportCsv}>
            <Icon name="export" size={14} />
          </button>
          <button type="button" className="w-btn sm" onClick={() => (sellable.length ? patch({ sell: sellable.map((r) => r.key) }) : toast({ text: ui.q.trim() || ui.cat !== 'all' || ui.tab !== 'all' ? tr('wealth_Stash.nothing_priced_to_sell_clear') : tr('wealth_Stash.nothing_priced_to_sell_yet'), kind: 'error' }))}>
            {tr(sellable.length === 1 ? 'h_c_Wl.sell_item' : 'h_c_Wl.sell_items', { n: sellable.length, total: fmt(sellable.reduce((a, r) => a + (r.unit ?? 0) * r.qty, 0)) })}
          </button>
        </div>
        <div className="w-grid-h">
          <span />
          <Th label={tr('wealth_Stash.item')} k="name" />
          <Th label={tr('wealth_Stash.tab')} k="tab" />
          <Th label={tr('wealth_Stash.qty')} k="qty" al="r" />
          <Th label={tr('wealth_Stash.unit')} k="unit" al="r" />
          <Th label={tr('wealth_Stash.total')} k="total" al="r" />
          <Th label={tr('wealth_Stash.n7_days')} k="chg" />
          <Th label={tr('wealth_Stash.note')} k={null} />
        </div>
        <div className="w-body">
          {rows.slice(0, shown).map((r) => {
            const c = change(r.spark);
            const rising = c > 0.15;
            return (
              <div key={r.key} role="button" tabIndex={0} className="w-grid-r" data-on={ui.sel === r.key} onClick={() => patch({ sel: r.key })} onKeyDown={(e) => e.key === 'Enter' && patch({ sel: r.key })}>
                <ItemIcon name={r.art} cat={r.cat} {...(r.artCat ? { artCat: r.artCat } : {})} />
                <span className="w-name" style={{ color: r.cat === 'rare' ? 'var(--rarity-rare)' : r.cat === 'uniq' ? 'var(--rarity-unique)' : undefined }} title={r.unit === null ? (r.why ? msg(r.why) : tr('wealth_Stash.no_poe_ninja_price_for')) : `${tr('h_c_Wl.row_tip', { qty: r.qty.toLocaleString(), price: r.unit === null ? '' : fmt(r.unit * r.qty), source: item(r.source) })}${r.hi ? `, ${tr('h_c_Wl.row_tip_hi')}` : ''}${r.base ? ` · ${tr('h_c_Wl.row_tip_base', { base: r.base })}` : ''}`}>
                  {r.name}
                  {r.variant && <i>{item(r.variant)}</i>}
                </span>
                <span className="w-cell" title={tr('wealth_Stash.held_in_join', { tabIds: r.tabIds.map(tabName).join(', ') })}>{r.tabIds.length > 1 ? `${tabName(r.tabIds[0]!)} +${r.tabIds.length - 1}` : tabName(r.tabIds[0] ?? '')}</span>
                <span className="r" title={`${tr(r.tabIds.length === 1 ? 'h_c_Wl.in_tab' : 'h_c_Wl.in_tabs', { qty: r.qty.toLocaleString(), n: r.tabIds.length })}${r.maxStack > 1 ? `, ${tr('h_c_Wl.stacks_up_to', { n: r.maxStack.toLocaleString() })}` : ''}`}>{r.qty.toLocaleString()}</span>
                <span className="r" title={r.unit === null ? (r.why ? msg(r.why) : tr('wealth_Stash.no_price')) : r.hi ? tr('wealth_Stash.unit_to_hi', { unit: fmt(r.unit), hi: fmt(r.hi) }) : fmt(r.unit)}>{r.unit === null ? <em className="w-np">{tr('wealth_Stash.no_price')}</em> : r.hi ? `${fmt(r.unit)} – ${fmt(r.hi)}` : fmt(r.unit)}</span>
                <span className="r" title={r.unit === null ? '' : fmt(r.unit * r.qty)}>{r.unit === null ? '—' : fmt(r.unit * r.qty)}</span>
                <Spark data={r.spark} title={sparkTitle(r.spark, fmt)} />
                <span className="w-cell">{r.unit === null ? <Chip tone="neutral" title={r.why ? msg(r.why) : undefined}>{r.why ? msg(r.why) : tr('wealth_Stash.no_price')}</Chip> : rising ? <span className="w-rise" title={tr('wealth_Stash.rising_v1_this_week', { value: fmtPct(c) })}>{fmtPct(c)}</span> : r.hi ? <Chip tone="gold" title={r.why ? msg(r.why) : undefined}>{tr('wealth_Stash.several_versions')}</Chip> : null}</span>
              </div>
            );
          })}
          {rows.length === 0 && (
            <div className="w-empty">
              <b>{tr('wealth_Stash.no_items_match')}</b>
              <span>{w.rows.length === 0 ? tr('wealth_Stash.nothing_has_been_read_from') : tr('wealth_Stash.try_fewer_filters')}</span>
              {w.rows.length > 0 && (
                <button type="button" className="w-btn alt sm" onClick={() => patch({ q: '', cat: 'all', tab: 'all' })}>
                  <Icon name="x" size={14} />
                  {tr('wealth_Stash.clear_filters')}
                </button>
              )}
            </div>
          )}
          {rows.length > shown && (
            <button type="button" className="w-more" onClick={() => setShown((n) => n + PAGE)}>
              {tr('wealth_Stash.show_shown_more_of_shown2', { shown: Math.min(PAGE, rows.length - shown), shown2: rows.length - shown })}
            </button>
          )}
        </div>
        <div className="w-foot">
          <span>{tr('wealth_Stash.showing_length_of_length2_items', { count: rows.length, count2: w.rows.length, shownVal: fmt(shownVal) })}</span>
          <span className="faint">{w.prices.fetchedAt ? '' : `${tr('wealth_Stash.no_prices_loaded')} · `}{tr('wealth_Stash.totals_low_end')}{w.unpriced ? tr('wealth_Stash.count_kinds_unpriced', { count: w.unpriced }) : ''}</span>
        </div>
      </Panel>
      {sel && (
        <Panel className="w-item">
          <div className="w-item-h">
            <ItemIcon name={sel.art} cat={sel.cat} {...(sel.artCat ? { artCat: sel.artCat } : {})} size={36} />
            <span className="w-name big">
              <b style={{ color: sel.cat === 'rare' ? '#f1d777' : 'var(--text-strong)' }}>{sel.name}</b>
              <i>{(sel.variant ? `${item(sel.variant)} · ` : '') + (sel.base ? item(sel.base) : catName(sel.cat)) + ' · ' + sel.tabIds.map(tabName).join(', ')}</i>
            </span>
            <button type="button" className="w-x" aria-label={tr('wealth_Stash.close')} title={tr('wealth_Stash.close')} onClick={() => patch({ sel: null })}>
              <Icon name="x" size={16} />
            </button>
          </div>
          <div className="w-price">{sel.unit === null ? tr('wealth_Stash.no_price') : sel.hi ? `${fmt(sel.unit)} – ${fmt(sel.hi)}` : fmt(sel.unit)}</div>
          {sel.unit === null && <div className="w-note-line">{sel.why ? msg(sel.why) : tr('wealth_Stash.nothing_prices_this_item')}</div>}
          <LineChart data={sel.spark} height={80} />
          <div className="w-kv"><span>{tr('wealth_Stash.price_source')}</span><span>{sel.source === 'none' ? tr('wealth_Stash.none') : `${item(sel.source)} · ${sel.priceAt ? fmtOld(now - sel.priceAt) : tr('wealth_Stash_2.age_unknown')}`}</span></div>
          {sel.cx && sel.source === 'poe.ninja' && <div className="w-kv"><span>{tr('wealth_Stash.ggg_exchange')}</span><span title={tr('wealth_Stash.official_currency_exchange_volume_we')}>{cxText(sel.cx, now, fmt)}</span></div>}
          {sel.hi !== null && <div className="w-kv"><span>{tr('wealth_Stash.range')}</span><span>{tr('wealth_Stash.total_uses_the_low_end')}</span></div>}
          {sel.listings !== undefined && <div className="w-kv"><span>{tr('wealth_Stash.listings')}</span><span>{sel.listings.toLocaleString()}</span></div>}
          <div className="w-kv"><span>{tr('wealth_Stash.where')}</span><span>{sel.tabIds.map(tabName).join(', ')}</span></div>
          <div className="w-kv"><span>{tr('wealth_Stash.total_2')}</span><span>{sel.unit === null ? '—' : tr('wealth_Stash.qty_for_tolocalestring', { qty: fmt(sel.unit * sel.qty), qty2: sel.qty.toLocaleString() })}</span></div>
          <div className="w-btns">
            <button type="button" className="w-btn" disabled={sel.unit === null} onClick={() => patch({ sell: [sel.key] })}>
              <Icon name="tag" size={14} />
              {tr('wealth_Stash.sell_this')}
            </button>
            <button type="button" className="w-btn alt" aria-label={tr('wealth_Stash.open_in_market')} title={tr('wealth_Stash.open_in_market')} onClick={() => go('market', { mq: sel.name, mi: sel.name, mcat: 'all' })}>
              <Icon name="external" size={14} />
            </button>
          </div>
          <div className="w-btns wrap" aria-label={tr('wealth_Stash.take_this_item_into_a')}>
            <button type="button" className="w-btn alt" aria-label={tr('wealth_Stash.copy_item_text')} title={tr('wealth_Stash.copy_item_text')} onClick={() => void copyText(sel)}>
              <Icon name="copy" size={14} />
            </button>
            <button
              type="button"
              className="w-btn alt"
              disabled={!build?.open || !onTryItem || trying || sel.cat !== 'uniq'}
              title={!build?.open ? tr('wealth_Stash.open_a_build_in_builds') : sel.cat !== 'uniq' ? tr('wealth_Stash.only_gear_can_be_equipped') : tr('wealth_Stash.calculate_name_in_name2_before', { name: sel.name, name2: build.name })}
              onClick={() => void tryOn(sel)}
            >
              <Icon name="tree" size={14} />
              {trying ? tr('wealth_Stash.calculating') : tr('wealth_Stash.equip_in_open_build')}
            </button>
            <button type="button" className="w-btn alt" disabled={sel.cat !== 'uniq'} aria-label={tr('wealth_Stash.save_as_shared_item')} title={sel.cat !== 'uniq' ? tr('wealth_Stash.only_gear_can_be_saved') : `${tr('wealth_Stash.save_as_shared_item')}: ${tr('wealth_Stash.keep_this_item_in_the')}`} onClick={() => void saveShared(sel)}>
              <Icon name="plus" size={14} />
            </button>
          </div>
          {tried && tried.key === sel.key && (
            <div className="w-tryon" role="region" aria-label={tr('wealth_Stash.equip_preview')}>
              <b>{tr('wealth_Stash.name_in_slot_what_the', { name: sel.name, slot: tried.res.slot })}</b>
              {tried.res.rows.length === 0 && <span className="faint">{tr('wealth_Stash.no_stat_changes')}</span>}
              {tried.res.rows.map((x) => (
                <div key={x.statId} className="w-kv"><span>{label(x.label)}</span><span>{x.before} → {x.after} ({x.change})</span></div>
              ))}
              <div className="w-btns">
                {onEquip && (
                  <button
                    type="button"
                    className="w-btn"
                    onClick={() => void onEquip(tried.res.edit).then((ok) => { toast({ text: ok ? tr('wealth_Stash.equipped_name_in_slot_undo', { name: sel.name, slot: tried.res.slot }) : tr('wealth_Stash.the_engine_did_not_take'), kind: ok ? 'ok' : 'error' }); if (ok) setTried(null); })}
                  >
                    {tr('wealth_Stash.equip_it_in_slot', { slot: tried.res.slot })}
                  </button>
                )}
                <button type="button" className="w-btn alt" onClick={() => setTried(null)}>{tr('wealth_Stash.not_now')}</button>
              </div>
            </div>
          )}
        </Panel>
      )}
      {ui.sell && <SellDialog rows={w.rows.filter((r) => ui.sell!.includes(r.key) && r.unit !== null)} divine={w.divine} onClose={() => patch({ sell: null })} onBoard={() => { patch({ sell: null }); go('board'); }} />}
    </div>
  );
}

export { CAT_COLOUR };
