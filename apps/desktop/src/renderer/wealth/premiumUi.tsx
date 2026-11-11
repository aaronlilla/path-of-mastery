import { useEffect, useState } from 'react';
import { fmtAgo, msg } from './mainText';
import type { TradeStatus } from '../../shared/wealthTrade.js';
import { Icon, useToast } from '../ui.js';
import { tr } from '../i18n';

/** The build the premium screens work for: the open build, or one the player chooses from the library. */
export interface PremiumBuild {
  key: string;
  name: string;
  xml: string;
  /** True when this is the build open in the Builds area (so "Equip" can edit it). */
  open: boolean;
}

export interface LibraryChoice {
  id: string;
  name: string;
  folder: string;
}

/** Visible state of the trade site: waiting out a rate limit, cookie refused, down, or not connected. */
export function TradeBanner({ trade, now, onReconnect }: { trade: TradeStatus; now: number; onReconnect?: () => void }) {
  if (trade.phase === 'idle' || trade.phase === 'busy') return null;
  const secs = trade.resumesAt ? Math.max(0, Math.round((trade.resumesAt - now) / 1000)) : 0;
  const tone = trade.phase === 'expired' ? 'bad' : trade.phase === 'waiting' ? 'warn' : 'info';
  const text =
    trade.phase === 'waiting' ? `${tr('h_c_Wp.waiting')}${secs > 0 ? ` · ${tr('h_c_Wp.resumes_in', { s: secs })}` : ''}. ${tr('h_c_Wp.not_error')}` : msg(trade.message);
  return (
    <div className={'w-banner inline ' + tone} role={tone === 'bad' ? 'alert' : 'status'} data-trade-state={trade.phase}>
      <Icon name={tone === 'bad' ? 'warning' : 'info'} size={14} />
      <span>{text}</span>
      {trade.phase === 'expired' && onReconnect && (
        <button type="button" className="w-btn sm" onClick={onReconnect}>
          {tr('wealth_premiumUi.reconnect')}
        </button>
      )}
    </div>
  );
}

export function useCopy() {
  const toast = useToast();
  return (text: string, what: string) => {
    void navigator.clipboard.writeText(text).then(
      () => toast({ text: tr('wealth_premiumUi.what_copied', { what }), kind: 'ok' }),
      () => toast({ text: tr('wealth_premiumUi.could_not_copy_the_tolowercase', { what: what.toLowerCase() }), kind: 'error' }),
    );
  };
}

/** Re-renders every `ms` (for ages that tick). */
export function useTick(ms = 30_000): number {
  const [t, setT] = useState(Date.now());
  useEffect(() => {
    const i = window.setInterval(() => setT(Date.now()), ms);
    return () => window.clearInterval(i);
  }, [ms]);
  return t;
}

export function ageText(minutes: number | null): string {
  return minutes === null ? tr('wealth_premiumUi_2.unknown_time_ago') : fmtAgo(minutes * 60000);
}
