import type { ItemInfo } from '@pom/protocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { inDivines, type CurrencyRates } from '../../../shared/tradeRates.js';
import type { TraderListing, TraderSearch } from '../../../shared/trader.js';
import { setActiveSet } from '../../../shared/itemsXml.js';
import { Dialog, useToast } from '../../ui';
import { Over } from '../dialogs';
import { colourOf } from '../ItemTooltip';
import { setQuality } from '../itemText';
import { MenuHost, PickButton, rarityColour, useHoverTip, useMenu, type MenuEntry, type TipSpec } from '../parts';
import type { SlotDef } from '../slots';
import type { ItemsEnv } from '../useItems';
import {
  DEFAULT_WEIGHTS,
  REALMS,
  SORT_MODES,
  sortWord,
  TRADE_TYPES,
  buildSearchUrl,
  buildWeightedQuery,
  categoryOf,
  defaultTestBase,
  exactQuery,
  ignoredHashes,
  modCandidates,
  modGroups,
  parseTradeUrl,
  priceOption,
  CURRENCIES,
  sortResults,
  totalPriceText,
  whisperLabel,
  wholeNumber,
  type SortMode,
  type StatWeight,
} from './model';
import { DEFAULT_OPTS, loadQueryMods, QueryOptionsDialog, type QueryOpts } from './QueryOptions';
import { StatWeightsDialog } from './StatWeights';
import { evaluateTexts, generateWeights, testItemText } from './weights';
import './trader.css';
import { tr } from '../../i18n';
import { msg } from '../../wealth/mainText';

type Unique = 'Megalomaniac' | "Watcher's Eye" | 'Pearl of Tsoatha';

interface RowDef {
  key: string;
  label: string;
  def: SlotDef | null;
  unique?: Unique;
}

interface Res {
  l: TraderListing;
  /** The item as the build file keeps it. */
  text: string;
  info: ItemInfo;
  weight: number;
}

interface RowState {
  url: string;
  busy: boolean;
  res: Res[] | null;
  order: number[];
  pos: number;
  query?: unknown;
  opts: QueryOpts;
  /** The slot the results were measured in (the jewel socket or ring a unique row searched for). */
  slot?: string;
}

const blankRow = (): RowState => ({ url: '', busy: false, res: null, order: [], pos: 0, opts: DEFAULT_OPTS });

const store = {
  get(k: string, d: string): string {
    try {
      return localStorage.getItem(k) ?? d;
    } catch {
      return d;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* the choice lasts until the window closes */
    }
  },
};

const PERMANENT = ['Standard', 'Hardcore', 'Ruthless', 'Hardcore Ruthless'];

/** Temporary leagues first, then Standard, Hardcore, Ruthless and Hardcore Ruthless last (`UpdateRealms`). */
export function sortLeagues(all: string[]): string[] {
  return [...all.filter((l) => !PERMANENT.includes(l) && !/SSF/.test(l)), ...PERMANENT];
}

/** Weights and options of one Find best pass, kept between rows like upstream keeps its last choices. */
function loadWeights(): StatWeight[] {
  try {
    const v = JSON.parse(store.get('pom.trade.weights', '')) as StatWeight[];
    if (Array.isArray(v) && v.length && v.every((w) => typeof w.stat === 'string' && typeof w.weightMult === 'number')) return v;
  } catch {
    /* use the defaults */
  }
  return DEFAULT_WEIGHTS;
}

export interface TraderProps {
  env: ItemsEnv;
  slots: SlotDef[];
  slotItemId: (d: SlotDef) => number;
  fits: (info: ItemInfo, def: SlotDef) => boolean;
  tipFor: (info: ItemInfo, def: SlotDef | undefined, target: { id: number } | { text: string }) => TipSpec;
  addToBuild: (text: string) => Promise<number | null>;
  equipId: (def: SlotDef, id: number) => Promise<boolean>;
  onClose: () => void;
  onOpenWealth: () => void;
}

/** The Trader popup (`TradeQueryClass:PriceItem`): search the trade site for each slot, pick a result, import it. */
export function TraderDialog(p: TraderProps) {
  const { env } = p;
  const toast = useToast();
  const { menu, open, close } = useMenu();
  const tip = useHoverTip(env.skillKind, env.stats);
  const [realm, setRealm] = useState(() => store.get('pom.trade.realm', 'pc'));
  const [leagues, setLeagues] = useState<string[]>([]);
  const [league, setLeague] = useState(() => store.get('pom.trade.league', ''));
  const [tradeType, setTradeType] = useState(() => Math.min(TRADE_TYPES.length - 1, Math.max(0, Number(store.get('pom.trade.type', '0')) || 0)));
  const [pages, setPages] = useState(() => Math.min(10, Math.max(1, Number(store.get('pom.trade.pages', '2')) || 2)));
  const [pagesText, setPagesText] = useState(String(pages));
  const [weights, setWeights] = useState<StatWeight[]>(loadWeights);
  const [sortMode, setSortMode] = useState<SortMode>(() => (SORT_MODES as readonly string[]).includes(store.get('pom.trade.sort', '')) ? (store.get('pom.trade.sort', '') as SortMode) : SORT_MODES[0]);
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [rates, setRates] = useState<CurrencyRates | null>(null);
  const [notice, setNotice] = useState<{ text: string; tone: 'warn' | 'error' | '' }>({ text: '', tone: '' });
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [dlg, setDlg] = useState<null | { k: 'weights' } | { k: 'options'; row: RowDef }>(null);
  const [wait, setWait] = useState<{ label: string; pct: number } | null>(null);
  const [pasting, setPasting] = useState<Record<string, boolean>>({});
  const alive = useRef(true);
  const cancelFlag = useRef(0);
  useEffect(() => () => void (alive.current = false), []);

  // ---- rows ------------------------------------------------------------------------------------------------------------
  const defs = useMemo<RowDef[]>(() => {
    const out: RowDef[] = [];
    for (const s of p.slots) {
      if (/^Graft/.test(s.name)) continue;
      out.push({ key: s.name, label: s.kind === 'abyssal' ? `${s.parent ?? ''} Abyssal ${s.name.slice(-1)}`.trim() : s.kind === 'jewel' ? s.label : s.label, def: s });
    }
    out.push({ key: 'u:Megalomaniac', label: tr('items_trader_TraderDialog.megalomaniac'), def: null, unique: 'Megalomaniac' }, { key: "u:Watcher's Eye", label: tr('items_trader_TraderDialog.watcher_s_eye'), def: null, unique: "Watcher's Eye" }, { key: 'u:Pearl', label: tr('items_trader_TraderDialog.pearl_of_tsoatha'), def: null, unique: 'Pearl of Tsoatha' });
    return out;
  }, [p.slots]);
  const uniqueAt = defs.findIndex((d) => d.unique);
  const jewelSlots = p.slots.filter((s) => s.kind === 'jewel');
  const ringSlots = p.slots.filter((s) => /^Ring \d$/.test(s.name));
  const rowOf = (k: string): RowState => rows[k] ?? blankRow();
  const patch = useCallback((k: string, v: Partial<RowState> | ((r: RowState) => Partial<RowState>)) => {
    if (!alive.current) return;
    setRows((all) => {
      const cur = all[k] ?? blankRow();
      return { ...all, [k]: { ...cur, ...(typeof v === 'function' ? v(cur) : v) } };
    });
  }, []);

  // ---- realm, league, auth, rates ------------------------------------------------------------------------------------------------
  useEffect(() => {
    void window.pom.trader.auth().then((a) => alive.current && setAuthed(a.authenticated)).catch(() => setAuthed(false));
  }, []);
  useEffect(() => {
    let dead = false;
    setLeagues([]);
    void window.pom.app.tradeLeagues(realm).then((r) => {
      if (dead) return;
      const names = r.ok ? r.value.leagues : [];
      const list = sortLeagues(names);
      if (!r.ok || r.value.error) setNotice({ text: tr('items_trader_TraderDialog.error_while_fetching_league_list', { error: r.ok ? r.value.error : r.error }), tone: 'error' });
      setLeagues(list);
      setLeague((cur) => (cur && list.includes(cur) ? cur : list[0] ?? 'Standard'));
    });
    void window.pom.trader.rates(realm).then((r) => {
      if (dead) return;
      if (r.ok) setRates(r.rates);
      else setNotice({ text: msg(r.message), tone: 'error' });
    });
    return () => {
      dead = true;
    };
  }, [realm]);

  const divOf = useCallback((currency: string, amount: number) => inDivines(rates, league, currency, amount), [rates, league]);

  // ---- results -----------------------------------------------------------------------------------------------------------------
  const slotFor = (row: RowDef, o: QueryOpts): SlotDef | null => {
    if (row.def) return row.def;
    if (row.unique === "Watcher's Eye") return p.slots.find((s) => s.name === o.jewelSlot) ?? jewelSlots[0] ?? null;
    if (row.unique === 'Pearl of Tsoatha') return p.slots.find((s) => s.name === o.ringSlot) ?? ringSlots[0] ?? null;
    return jewelSlots[0] ?? null;
  };

  const orderOf = useCallback(
    (res: Res[], mode: SortMode) => {
      const s = sortResults(res.map((r) => ({ amount: r.l.amount, currency: r.l.currency, weight: r.weight })), mode, divOf);
      return s;
    },
    [divOf],
  );

  /** Reads the fetched items into build items, keeps those that fit the slot and measures each with the engine. */
  const intake = async (row: RowDef, out: Extract<TraderSearch, { ok: true }>, slot: SlotDef | null, opts: QueryOpts): Promise<boolean> => {
    const texts = await Promise.all(out.listings.map((l) => env.normalise(l.text)));
    const infos = await env.infoMany(texts);
    const kept: Res[] = [];
    out.listings.forEach((l, i) => {
      const info = infos[i];
      if (!info?.valid) return;
      if (slot && !p.fits(info, slot)) return;
      let text = info.text ?? texts[i]!;
      // The buyer is assumed to add quality (`NormaliseQuality`).
      if (!info.noQuality && info.quality !== null && info.quality !== undefined && info.quality < 20 && !info.corrupted && !/^Unique ID:|^Mirrored|^Split$/im.test(text)) text = setQuality(text, 20);
      kept.push({ l, text, info, weight: 0 });
    });
    if (!kept.length) {
      patch(row.key, { busy: false, res: null });
      setNotice({ text: tr('items_trader_TraderDialog.no_compatible_items_found_for'), tone: 'warn' });
      return false;
    }
    if (slot) {
      const w = await evaluateTexts({ rank: env.rank, weights, texts: kept.map((k) => k.text), slot: slot.name, flask: slot.kind === 'flask', alive: () => alive.current }).catch(() => null);
      if (w) w.forEach((x, i) => (kept[i]!.weight = x));
    }
    const sorted = orderOf(kept, sortMode);
    if (sorted.fellBack) setNotice({ text: tr('items_trader_TraderDialog.currency_rates_unavailable_falling_b'), tone: 'warn' });
    else setNotice({ text: '', tone: '' });
    patch(row.key, { busy: false, res: kept, order: sorted.order, pos: 0, query: out.query, opts, slot: slot?.name });
    return true;
  };

  const failNotice = (r: Extract<TraderSearch, { ok: false }>) => {
    if (r.kind === 'rate-limited') setNotice({ text: tr('items_trader_TraderDialog.rate_limited_retrying_after_retryaft', { retryAfterSec: r.retryAfterSec ?? 60 }), tone: 'warn' });
    else setNotice({ text: tr('items_trader_TraderDialog.error_message', { message: msg(r.message) }), tone: 'error' });
  };

  const priceUrl = async (row: RowDef) => {
    const st = rowOf(row.key);
    patch(row.key, { busy: true });
    const r = await window.pom.trader.fromUrl({ url: /^https?:\/\//i.test(st.url) ? st.url : `https://${st.url}`, pages });
    if (!alive.current) return;
    if (!r.ok) {
      failNotice(r);
      patch(row.key, { busy: false });
      return;
    }
    setNotice({ text: '', tone: '' });
    await intake(row, r, slotFor(row, st.opts), st.opts);
  };

  const unavailable = (row: RowDef, o: QueryOpts): string | null => (row.unique === "Watcher's Eye" && !o.jewelSlot ? tr('items_trader_TraderDialog.requires_an_active_jewel_socket') : null);

  /** Find best: weigh the slot's mods with the engine, build the weighted search and run it. */
  const findBest = async (row: RowDef, o: QueryOpts) => {
    store.set('pom.trade.opts', JSON.stringify({ ...o, required: [], blocked: [] }));
    const slot = slotFor(row, o);
    const token = ++cancelFlag.current;
    const live = () => alive.current && cancelFlag.current === token;
    const status = TRADE_TYPES[tradeType]!.status;
    patch(row.key, { busy: true });
    setWait({ label: tr('items_trader_TraderDialog.calculating_mod_weights'), pct: 0 });
    try {
      const data = await loadQueryMods();
      const price = wholeNumber(o.maxPrice);
      const common = {
        status,
        includeMirrored: o.includeMirrored,
        maxPrice: price ? { amount: price, type: priceOption(CURRENCIES[o.maxPriceType]?.id ?? null) } : undefined,
        maxLevel: wholeNumber(o.maxLevel),
        sockets: wholeNumber(o.sockets),
        links: wholeNumber(o.links),
        required: o.required.map((m) => ({ tradeId: m.tradeId, value: m.value })),
        blocked: o.blocked.map((m) => ({ tradeId: m.tradeId, value: m.value })),
      };
      let query: unknown;
      if (row.unique === 'Megalomaniac' || row.unique === 'Pearl of Tsoatha') {
        // These two have no mod list to weigh: the search is for the unique itself, cheapest first.
        query = {
          query: { status: { option: status }, name: row.unique, ...(row.unique === 'Megalomaniac' ? { type: 'Medium Cluster Jewel' } : {}), stats: [{ type: 'and', filters: [] }] },
          sort: { price: 'asc' },
        };
      } else {
        const cur = slot ? env.infos.get(p.slotItemId(slot)) : undefined;
        const cat = row.unique === "Watcher's Eye" ? { trade: 'jewel', key: 'AnyJewel' } : slot ? categoryOf(slot.name, cur?.type) : null;
        if (!slot || !cat) throw new Error(tr('items_trader_TraderDialog_2.searching_for_is_not_supported', { label: row.label }));
        const isJewel = slot.kind === 'jewel' || slot.kind === 'abyssal';
        const key = !row.unique && isJewel ? (slot.kind === 'abyssal' ? 'AbyssJewel' : `${o.jewelType}Jewel`) : cat.key;
        const tradeCat = !row.unique && isJewel ? (key === 'AbyssJewel' ? 'jewel.abyss' : key === 'BaseJewel' ? 'jewel.base' : 'jewel') : cat.trade;
        const qo = { includeCorrupted: o.includeCorrupted, includeScourge: o.includeScourge, includeTalisman: o.includeTalisman, eldritch: o.eldritch };
        const cands = modCandidates(data, modGroups(qo, row.unique === "Watcher's Eye" ? 'watchersEye' : undefined), key, qo);
        const base = cur?.baseName ?? defaultTestBase(slot.name);
        const current = cur ? testItemText(base, (cur.mods ?? []).filter((m) => m.bucket === 'explicit' || m.bucket === 'scourge' || m.bucket === 'implicit' || m.bucket === 'crucible').map((m) => m.text)) : undefined;
        const run = await generateWeights({ rank: env.rank, weights, candidates: cands, base, slot: slot.name, flask: slot.kind === 'flask', current, alive: live, onProgress: (d) => live() && setWait({ label: tr('items_trader_TraderDialog.calculating_mod_weights'), pct: d }) });
        if (!run) {
          patch(row.key, { busy: false });
          return;
        }
        if (row.unique === "Watcher's Eye" && o.includeAllWEMods) {
          const have = new Set(run.list.map((w) => w.tradeModId));
          for (const m of data.WatchersEye ?? []) if (!have.has(m.id)) run.list.push({ tradeModId: m.id, weight: 0, meanStatDiff: 0, invert: false });
        }
        const sorted = [...run.list].sort((a, b) => (a.meanStatDiff === b.meanStatDiff ? Math.abs(b.weight) - Math.abs(a.weight) : b.meanStatDiff - a.meanStatDiff));
        const extra: Record<string, unknown> | undefined = row.unique === "Watcher's Eye" ? { name: "Watcher's Eye" } : undefined;
        const filters = row.unique === "Watcher's Eye" ? { type_filters: { filters: { category: { option: 'jewel' }, rarity: { option: 'unique' } } } } : undefined;
        const built = buildWeightedQuery({ ...common, weights: sorted, minWeight: run.currentDiff * 0.5, category: tradeCat, ...(filters ? { filters } : {}), ...(extra ? { extra } : {}) }, ignoredHashes(data));
        if (built.error) {
          setNotice({ text: built.error, tone: 'error' });
          patch(row.key, { busy: false });
          return;
        }
        query = built.query;
      }
      setWait(null);
      patch(row.key, { opts: o });
      const link = buildSearchUrl(realm, league, query);
      const weighted = (query as { query?: { stats?: Array<{ type?: string }> } }).query?.stats?.[0]?.type === 'weight';
      if (weighted && !authed) {
        // The public trade site refuses a weighted search (its complexity limit is lower without a session), so, as in the
        // original, the search link is made for the player to open on the site.
        patch(row.key, { busy: false, url: link });
        setNotice({ text: tr('items_trader_TraderDialog.search_link_ready_open_it'), tone: '' });
        return;
      }
      const r = await window.pom.trader.search({ realm, league, query, pages });
      if (!alive.current) return;
      if (!r.ok) {
        patch(row.key, { busy: false, url: link });
        failNotice(r);
        return;
      }
      patch(row.key, { url: buildSearchUrl(realm, league, null, r.queryId), query: r.query });
      await intake(row, { ...r, query }, slot, o);
    } catch (e) {
      patch(row.key, { busy: false });
      setNotice({ text: tr('items_trader_TraderDialog.error_v1', { value: e instanceof Error ? e.message : String(e) }), tone: 'error' });
    } finally {
      if (alive.current) setWait(null);
    }
  };

  // The sort mode or the weights changed: every row with results is measured again and put in order.
  const lastWeights = useRef(weights);
  useEffect(() => {
    setRows((all) => {
      const next: Record<string, RowState> = {};
      for (const [k, st] of Object.entries(all)) {
        if (!st.res) {
          next[k] = st;
          continue;
        }
        const sorted = orderOf(st.res, sortMode);
        next[k] = { ...st, order: sorted.order, pos: 0 };
        if (sorted.fellBack) setNotice({ text: tr('items_trader_TraderDialog.currency_rates_unavailable_falling_b'), tone: 'warn' });
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortMode, orderOf]);
  useEffect(() => {
    if (lastWeights.current === weights) return;
    lastWeights.current = weights;
    const token = ++cancelFlag.current;
    void (async () => {
      for (const d of defs) {
        const st = rows[d.key];
        if (!st?.res || !st.slot) continue;
        const slot = p.slots.find((s) => s.name === st.slot);
        if (!slot) continue;
        const w = await evaluateTexts({ rank: env.rank, weights, texts: st.res.map((r) => r.text), slot: slot.name, flask: slot.kind === 'flask', alive: () => alive.current && cancelFlag.current === token }).catch(() => null);
        if (!w) return;
        patch(d.key, (cur) => {
          const res = (cur.res ?? []).map((r, i) => ({ ...r, weight: w[i] ?? r.weight }));
          return { res, order: orderOf(res, sortMode).order, pos: 0 };
        });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weights]);

  // ---- import, whisper, totals -------------------------------------------------------------------------------------------------------
  const chosen = (st: RowState): Res | undefined => (st.res ? st.res[st.order[st.pos] ?? 0] : undefined);

  const importItem = async (row: RowDef) => {
    const st = rowOf(row.key);
    const r = chosen(st);
    if (!r) return;
    const id = await p.addToBuild(r.text);
    if (!id) return;
    const slot = st.slot ? p.slots.find((s) => s.name === st.slot) : row.def;
    let equipped = false;
    if (slot && p.fits(r.info, slot)) equipped = await p.equipId(slot, id);
    toast({ text: equipped ? tr('items_trader_TraderDialog.imported_name_into_label', { name: r.info.name, label: slot!.label }) : tr('items_trader_TraderDialog.imported_name', { name: r.info.name }), kind: 'ok', ttl: 2500 });
  };

  const whisper = async (row: RowDef) => {
    const st = rowOf(row.key);
    const r = chosen(st);
    if (!r) return;
    if (r.l.whisper && r.l.priceType !== '~b/o') {
      await navigator.clipboard.writeText(r.l.whisper).catch(() => undefined);
      toast({ text: tr('items_trader_TraderDialog.copied_the_whisper_to_the'), kind: 'ok', ttl: 1800 });
      return;
    }
    const q = st.query ? exactQuery(st.query as Parameters<typeof exactQuery>[0], 0, r.l.account) : null;
    const weighted = (st.query as { query?: { stats?: Array<{ type?: string }> } } | undefined)?.query?.stats?.[0]?.type === 'weight';
    if (q && !weighted) delete ((q as { query: { stats?: unknown } }).query).stats;
    const url = q ? buildSearchUrl(realm, league, q) : buildSearchUrl(realm, league, null);
    await navigator.clipboard.writeText(url).catch(() => undefined);
    const o = await window.pom.app.openExternal(url);
    if (!o.ok) toast({ text: o.error, kind: 'error' });
  };

  const total = useMemo(() => {
    const prices: Array<{ currency: string; amount: number }> = [];
    for (const st of Object.values(rows)) {
      const r = chosen(st);
      if (r?.l.currency && r.l.amount !== null) prices.push({ currency: r.l.currency, amount: r.l.amount });
    }
    return totalPriceText(prices, (c) => rates?.[league]?.[c]);
  }, [rows, rates, league]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- render ----------------------------------------------------------------------------------------------------------------------
  const sets = env.model.sets;
  const labelOf = (r: Res) => `${r.info.name}${r.l.amount !== null ? ` · ${r.l.amount} ${r.l.currency}` : ''}`;
  const rowView = (d: RowDef, i: number) => {
    const st = rowOf(d.key);
    const valid = parseTradeUrl(st.url) !== null;
    const slotNeeded = d.unique === "Watcher's Eye" || d.unique === 'Megalomaniac';
    const noSocket = slotNeeded && jewelSlots.length === 0;
    const priceTip = noSocket ? tr('items_trader_TraderDialog.requires_an_active_jewel_socket') : !valid ? tr('items_trader_TraderDialog_2.enter_a_valid_trade_url') : authed ? '' : tr('items_trader_TraderDialog.searching_without_signing_in_uses');
    const res = st.res;
    const cur = chosen(st);
    const slotDef = d.def;
    return (
      <div key={d.key}>
        {i === uniqueAt && <div className="tr-other">{tr('items_trader_TraderDialog.other_trades')}</div>}
        <div className="tr-row" data-r="tr-row">
          <span className="tr-name" style={d.unique ? { color: 'var(--rarity-unique)' } : undefined} title={d.label}>{d.label}</span>
          {!res ? (
            <>
              <button type="button" className="it-btn xs" disabled={!league || st.busy} title={tr('items_trader_TraderDialog.creates_a_weighted_search_to')} onClick={() => setDlg({ k: 'options', row: d })}>
                {tr('items_trader_TraderDialog.find_best')}
              </button>
              {st.url || pasting[d.key] ? (
                <input
                  className="it-input tr-url"
                  placeholder={tr('items_trader_TraderDialog.paste_trade_url_here')}
                  aria-label={tr('items_trader_TraderDialog.trade_url_for_label', { label: d.label })}
                  value={st.url}
                  autoFocus={pasting[d.key]}
                  title={valid ? tr('items_trader_TraderDialog.control_click_to_open_in') : undefined}
                  onChange={(e) => { setPasting((x) => (x[d.key] ? x : { ...x, [d.key]: true })); patch(d.key, { url: e.target.value }); }}
                  onClick={(e) => {
                    if ((e.ctrlKey || e.metaKey) && valid) void window.pom.app.openExternal(/^https?:\/\//i.test(st.url) ? st.url : `https://${st.url}`);
                  }}
                />
              ) : (
                <button type="button" className="it-btn xs ghost" style={{ gridColumn: 3, justifySelf: 'start' }} aria-label={tr('items_trader_TraderDialog.trade_url_for_label', { label: d.label })} onClick={() => setPasting((x) => ({ ...x, [d.key]: true }))}>
                  {tr('items_trader_TraderDialog.paste_link')}
                </button>
              )}
              <button type="button" className="it-btn xs" disabled={!valid || st.busy || noSocket} title={priceTip} onClick={() => void priceUrl(d)}>
                {st.busy ? tr('items_trader_TraderDialog.searching') : tr('items_trader_TraderDialog.price_item')}
              </button>
            </>
          ) : (
            <>
              <button type="button" className="it-btn xs" onClick={() => patch(d.key, { res: null, order: [], pos: 0 })}>
                {tr('items_trader_TraderDialog.search')}
              </button>
              <PickButton
                small
                value={cur ? labelOf(cur) : ''}
                colour={cur ? rarityColour(cur.info) : undefined}
                onOpen={(el) =>
                  open(
                    el,
                    st.order.map<MenuEntry>((ri, n) => {
                      const r = res[ri]!;
                      return {
                        key: `${r.l.id}`,
                        label: r.info.name,
                        colour: colourOf(r.info.headerRarity),
                        right: r.l.amount !== null ? `${r.l.amount} ${r.l.currency}` : undefined,
                        rightColour: 'var(--gold-text)',
                        on: n === st.pos,
                        tip: p.tipFor(r.info, slotDef ?? p.slots.find((s) => s.name === st.slot), { text: r.text }),
                        run: () => patch(d.key, { pos: n }),
                      };
                    }),
                    420,
                  )
                }
              />
              <button type="button" className="it-btn xs" disabled={!cur} onClick={() => void importItem(d)}>
                {tr('items_trader_TraderDialog.import_item')}
              </button>
              <button type="button" className="it-btn xs" disabled={!cur} title={cur?.l.whisper && cur.l.priceType !== '~b/o' ? tr('items_trader_TraderDialog.copies_the_item_purchase_whisper') : tr('items_trader_TraderDialog.opens_the_search_page_to')} onClick={() => void whisper(d)}>
                {whisperLabel(cur ? { whisper: cur.l.whisper, priceType: cur.l.priceType, amount: cur.l.amount, currency: cur.l.currency } : undefined)}
              </button>
            </>
          )}
        </div>
      </div>
    );
  };

  const opt = (list: string[], v: string, set: (x: string) => void, w = 190) => (el: HTMLElement) => open(el, list.map((x) => ({ key: x, label: x, on: x === v, run: () => set(x) })), w);
  const initialOpts = (): QueryOpts => {
    try {
      return { ...DEFAULT_OPTS, ...(JSON.parse(store.get('pom.trade.opts', '{}')) as Partial<QueryOpts>), required: [], blocked: [] };
    } catch {
      return DEFAULT_OPTS;
    }
  };

  return (
    <Over>
      <Dialog size="large" title={tr('items_trader_TraderDialog.trader')} confirmLabel={tr('items_trader_TraderDialog.done')} confirmIcon="check" cancelLabel={null} onCancel={p.onClose} onConfirm={p.onClose}>
        <div className="tr">
          <div className="tr-top">
            <div className="tr-col">
              <PickButton small dataKey="tr-set" value={sets.find((s) => s.id === env.model.activeSet)?.title || tr('items_trader_TraderDialog_2.default')} disabled={sets.length < 2} onOpen={(el) => open(el, sets.map((s) => ({ key: String(s.id), label: s.title || tr('items_trader_TraderDialog.default'), on: s.id === env.model.activeSet, run: () => void env.runXml(setActiveSet(env.xml, s.id)) })), 220)} />
              <button type="button" className={'it-btn xs tr-auth' + (authed ? ' ok' : ' warn')} onClick={() => { p.onClose(); p.onOpenWealth(); }} title={tr('items_trader_TraderDialog.searches_use_the_player_s')}>
                {authed ? tr('items_trader_TraderDialog.authenticated') : tr('items_trader_TraderDialog.not_authenticated')}
              </button>
              <PickButton small dataKey="tr-type" value={TRADE_TYPES[tradeType]!.label} onOpen={(el) => open(el, TRADE_TYPES.map((t, i) => ({ key: t.status, label: t.label, on: i === tradeType, run: () => { setTradeType(i); store.set('pom.trade.type', String(i)); } })), 240)} />
            </div>
            <div className="tr-realm">
              <span className="k">{tr('items_trader_TraderDialog.league')}</span>
              <PickButton small value={league || tr('items_trader_TraderDialog_2.loading')} disabled={leagues.length < 2} onOpen={opt(leagues, league, (v) => { setLeague(v); store.set('pom.trade.league', v); }, 200)} />
            </div>
            <div className="tr-col right">
              <button type="button" className="it-btn xs" style={{ width: 150 }} title={`Sorts the weights by the stats selected multiplied by a value\nCurrently sorting by:\n${weights.map((w) => `${w.label}: ${w.weightMult.toFixed(2)}`).join('\n')}`} onClick={() => setDlg({ k: 'weights' })}>
                {tr('items_trader_TraderDialog.adjust_search_weights')}
              </button>
            </div>
          </div>
          <details className="tr-more">
            <summary>{tr('items_trader_TraderDialog.search_options')}</summary>
            <div className="tr-more-body">
              <span className="tr-sortline">
                <span className="k">{tr('items_trader_TraderDialog.realm')}</span>
                <PickButton small value={REALMS.find((r) => r.id === realm)?.label} onOpen={opt(REALMS.map((r) => r.label), REALMS.find((r) => r.id === realm)?.label ?? 'PC', (v) => { const r = REALMS.find((x) => x.label === v)!; setRealm(r.id); store.set('pom.trade.realm', r.id); }, 120)} />
              </span>
              <input
                className="it-input n"
                style={{ width: 150 }}
                inputMode="numeric"
                placeholder={tr('items_trader_TraderDialog.fetch_pages')}
                aria-label={tr('items_trader_TraderDialog.fetch_pages')}
                value={pagesText}
                title={tr('items_trader_TraderDialog.specify_maximum_number_of_item')}
                onChange={(e) => {
                  const t = e.target.value.replace(/\D/g, '').slice(0, 3);
                  setPagesText(t);
                  const n = Math.min(10, Math.max(1, Number(t) || 2));
                  setPages(n);
                  store.set('pom.trade.pages', String(n));
                }}
                onBlur={() => setPagesText(String(pages))}
              />
              <span className="tr-sortline">
                <span className="k">{tr('items_trader_TraderDialog.sort_by')}</span>
                <PickButton small value={sortWord(sortMode)} onOpen={(el) => open(el, SORT_MODES.map((x) => ({ key: x, label: sortWord(x), on: x === sortMode, run: () => { setSortMode(x); store.set('pom.trade.sort', x); } })), 220)} />
              </span>
            </div>
          </details>
          <div className="tr-rows">{defs.map(rowView)}</div>
          <div className="tr-foot">
            <span className="tr-total">{total ? tr('items_trader_TraderDialog.total_price_total', { total }) : ''}</span>
            <span className={'tr-notice ' + notice.tone} role="status">{notice.text}</span>
          </div>
        </div>
      </Dialog>
      {dlg?.k === 'weights' && (
        <StatWeightsDialog
          stats={env.powerStats}
          current={weights}
          onCancel={() => setDlg(null)}
          onSave={(list) => {
            setDlg(null);
            setWeights(list);
            store.set('pom.trade.weights', JSON.stringify(list));
          }}
        />
      )}
      {dlg?.k === 'options' && (
        <QueryOptionsDialog
          slotName={dlg.row.def?.name ?? dlg.row.label}
          label={dlg.row.label}
          unique={dlg.row.unique}
          isJewel={dlg.row.def?.kind === 'jewel' || dlg.row.def?.kind === 'abyssal'}
          isAbyssal={dlg.row.def?.kind === 'abyssal'}
          itemType={dlg.row.def ? env.infos.get(p.slotItemId(dlg.row.def))?.type : undefined}
          league={league}
          weights={weights}
          initial={{ ...initialOpts(), ...rowOf(dlg.row.key).opts, required: [], blocked: [] }}
          jewelSockets={jewelSlots.map((s) => ({ name: s.name, label: s.label }))}
          ringSlots={ringSlots.map((s) => ({ name: s.name, label: s.label }))}
          onCancel={() => setDlg(null)}
          onExecute={(o) => {
            const row = dlg.row;
            setDlg(null);
            if (unavailable(row, o)) return;
            void findBest(row, o);
          }}
        />
      )}
      {wait && (
        <Over>
          <Dialog size="small" title={tr('items_trader_TraderDialog.please_wait')} confirmLabel={null} cancelLabel={tr('items_trader_TraderDialog.cancel')} onCancel={() => { cancelFlag.current++; setWait(null); setRows((all) => Object.fromEntries(Object.entries(all).map(([k, v]) => [k, { ...v, busy: false }]))); }}>
            <div className="tr-wait" role="status">
              <span>{wait.label}</span>
              <span className="it-progress"><i style={{ transform: `scaleX(${Math.min(1, Math.max(0, wait.pct)).toFixed(3)})` }} /></span>
              <span className="it-sub">{Math.floor(wait.pct * 100)}%</span>
            </div>
          </Dialog>
        </Over>
      )}
      <MenuHost menu={menu} close={close} onTip={tip.show} offTip={tip.hide} />
      {tip.node}
    </Over>
  );
}
