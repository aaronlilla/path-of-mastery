import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { InboxEntry, MarketRow, StrategyView, WealthView } from '../../shared/wealth.js';
import type { BulkView } from '../../shared/bulk.js';
import { fmtChaos } from '../../shared/wealth.js';
import { tr } from '../i18n';

/** The six nav entries, plus two screens reached from other screens (Bulk board, Your filter): they have no nav entry. */
export type Sub = 'overview' | 'stash' | 'sessions' | 'strategies' | 'market' | 'board' | 'filter' | 'watch';

export interface WealthUi {
  sub: Sub;
  /** The stash search, shared with the title bar. */
  q: string;
  cat: string;
  tab: string;
  sel: string | null;
  sortK: 'name' | 'tab' | 'qty' | 'unit' | 'total' | 'chg';
  sortD: 1 | -1;
  sess: string | null;
  stTab: 0 | 1 | 2;
  stQ: string;
  strat: string | null;
  mcat: string;
  mq: string;
  owned: boolean;
  mi: string | null;
  range: 0 | 1 | 2 | 3;
  sell: string[] | null;
  /** The Upgrade watch match to show (set by the bell's "View match"). */
  wsel: string | null;
}

export const initialUi = (): WealthUi => ({ sub: 'overview', q: '', cat: 'all', tab: 'all', sel: null, sortK: 'total', sortD: -1, sess: null, stTab: 0, stQ: '', strat: null, mcat: 'all', mq: '', owned: false, mi: null, range: 2, sell: null, wsel: null });

export interface Wealth {
  w: WealthView | null;
  ui: WealthUi;
  patch: (p: Partial<WealthUi>) => void;
  go: (sub: Sub, p?: Partial<WealthUi>) => void;
  market: MarketRow[];
  strategies: StrategyView[];
  fmt: (c: number) => string;
  /** Re-read the view (after an action that returns nothing). */
  reload: () => void;
  now: number;
  /** The bell, from the saved list in the main process. */
  inbox: InboxEntry[];
  unread: boolean;
  /** Marks the bell read. */
  readInbox: () => void;
  /** The Bulk board's listings (null until read). */
  board: BulkView | null;
  reloadBoard: () => void;
}

/** Holds the Wealth view pushed from the main process, plus the screen state. `active` turns it on. */
export function useWealth(active: boolean): Wealth {
  const [w, setW] = useState<WealthView | null>(null);
  const [ui, setUi] = useState<WealthUi>(initialUi);
  const [market, setMarket] = useState<MarketRow[]>([]);
  const [strategies, setStrategies] = useState<StrategyView[]>([]);
  const [now, setNow] = useState(Date.now());
  const started = useRef(false);
  const [board, setBoard] = useState<BulkView | null>(null);
  const reloadBoard = useCallback(() => void window.pom.wealth.boardView().then(setBoard, () => undefined), []);
  useEffect(() => {
    if (!active) return;
    reloadBoard();
    const i = window.setInterval(reloadBoard, 60_000);
    return () => window.clearInterval(i);
  }, [active, reloadBoard]);
  // Opening the board reads it fresh (a lot just posted from Sell shows at once).
  useEffect(() => {
    if (active && ui.sub === 'board') reloadBoard();
  }, [active, ui.sub, reloadBoard]);

  const reload = useCallback(() => void window.pom.wealth.get().then(setW), []);
  useEffect(() => {
    if (!active) return;
    started.current = true;
    reload();
    const off = window.pom.wealth.onChange(setW);
    const tick = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => {
      off();
      window.clearInterval(tick);
    };
  }, [active, reload]);

  // While the app waits out a rate limit the countdown ticks every second; otherwise every 15 s is enough.
  const waiting = w?.sync.phase === 'rate-limited' || w?.trade.phase === 'waiting';
  useEffect(() => {
    if (!active || !waiting) return;
    const i = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(i);
  }, [active, waiting]);

  const priceAt = w?.prices.fetchedAt ?? 0;
  const needMarket = active && (ui.sub === 'market' || ui.sub === 'overview');
  const needStrategies = active && (ui.sub === 'strategies' || ui.sub === 'overview' || ui.sub === 'filter' || ui.sub === 'sessions');
  // The exchange feed loads hour by hour after the prices: the rows carry its quote, so they are read again whenever it brings a new hour.
  const cxSig = w?.cx ? `${w.cx.hours}:${w.cx.at ?? 0}` : '';
  useEffect(() => {
    if (needMarket) void window.pom.wealth.market().then(setMarket);
  }, [needMarket, priceAt, cxSig]);
  const stashSig = w ? w.rows.length + ':' + Math.round(w.networth) : '';
  useEffect(() => {
    if (needStrategies) void window.pom.wealth.strategies().then(setStrategies);
  }, [needStrategies, priceAt, stashSig]);

  const readInbox = useCallback(() => void window.pom.wealth.readInbox(), []);
  const patch = useCallback((p: Partial<WealthUi>) => setUi((u) => ({ ...u, ...p })), []);
  const go = useCallback((sub: Sub, p: Partial<WealthUi> = {}) => setUi((u) => ({ ...u, sub, ...p })), []);
  const divine = w?.divine ?? 370;
  const fmt = useMemo(() => (c: number) => fmtChaos(c, divine), [divine]);
  return { w, ui, patch, go, market, strategies, fmt, reload, now, inbox: w?.inbox ?? [], unread: (w?.inboxUnread ?? 0) > 0, readInbox, board, reloadBoard };
}
