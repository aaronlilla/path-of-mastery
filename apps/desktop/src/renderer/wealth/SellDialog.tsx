import { useMemo, useState } from 'react';
import { fmtChaos, type StashRow } from '../../shared/wealth.js';
import { planWindows } from '../../shared/sell.js';
import { useAcct } from '../accounts/useAccount';
import { Icon, useToast } from '../ui.js';
import { Cb, change, Modal } from './wui.js';
import { tr } from '../i18n';
import { msg } from './mainText';

export function SellDialog({ rows, divine, onClose, onBoard }: { rows: StashRow[]; divine: number; onClose: () => void; onBoard?: () => void }) {
  const toast = useToast();
  const acct = useAcct();
  const accountName = acct.view?.auth.state === 'signedIn' ? acct.view.auth.user.name : '';
  const [listedAs, setListedAs] = useState(accountName);
  const [mult, setMult] = useState(100);
  const [bulk, setBulk] = useState(true);
  const [skipRising, setSkipRising] = useState(false);
  // Only what is actually in this sale can be called out as rising: the Bulk-only filter is applied first.
  const inSale = useMemo(() => rows.filter((r) => !bulk || r.maxStack > 1 || r.qty > 1), [rows, bulk]);
  const rising = inSale.filter((r) => change(r.spark) > 0.15);
  const items = useMemo(() => inSale.filter((r) => !skipRising || change(r.spark) <= 0.15), [inSale, skipRising]);
  const m = mult / 100;
  const wins = useMemo(() => planWindows(items.map((r) => ({ name: r.name, qty: r.qty, unit: r.unit ?? 0, maxStack: r.maxStack })), m), [items, m]);
  const total = items.reduce((a, r) => a + (r.unit ?? 0) * r.qty, 0) * m;
  const count = items.reduce((a, r) => a + r.qty, 0);
  const warn = !skipRising && rising.length > 0;

  const copy = async () => {
    const txt = `WTS ${bulk ? 'bulk only · ' : ''}${mult}% of poe.ninja\n` + items.map((r) => `${r.qty}× ${r.name} @ ${fmtChaos((r.unit ?? 0) * m, divine)}`).join('\n') + `\nTotal ${(total / divine).toFixed(1)} div · paid per trade window`;
    try {
      await navigator.clipboard.writeText(txt);
      onClose();
      toast({ text: tr('wealth_SellDialog.listing_text_copied_count_trade', { count: wins.length }), kind: 'ok' });
    } catch {
      toast({ text: tr('wealth_SellDialog.could_not_reach_the_clipboard'), kind: 'error' });
    }
  };

  /** Posts this lot as it stands (items kept, price multiplier) to the Bulk board. */
  const post = async () => {
    const top = [...items].sort((a, b) => (b.unit ?? 0) * b.qty - (a.unit ?? 0) * a.qty)[0]!;
    const r = await window.pom.wealth.boardPost({ cat: top.cat, items: items.map((i) => ({ name: i.name, qty: i.qty })), marketChaos: total / m, mult, ...(listedAs.trim() ? { seller: listedAs.trim() } : {}) });
    if (r.ok) {
      onClose();
      toast({ text: tr('wealth_SellDialog.posted_to_the_bulk_board'), kind: 'ok' });
      onBoard?.();
    } else {
      toast({ text: msg(r.error), kind: 'error' });
      if (!acct.signedIn) acct.openSignIn();
    }
  };

  return (
    <Modal label={tr('wealth_SellDialog.sell')} onClose={onClose}>
        <div className="w-dlg-h">
          <span>{items.length === rows.length ? tr('wealth_SellDialog.sell_count_items', { count: items.length }) : tr('wealth_SellDialog.sell_length_of_length2_items', { count: items.length, count2: rows.length })}</span>
          <button type="button" className="w-x" aria-label={tr('wealth_SellDialog.close')} title={tr('wealth_SellDialog.close')} onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="w-dlg-b">
          <div className="w-dlg-l">
            <div className="w-sub">
              <div className="w-kv-row">
                <span>{tr('wealth_SellDialog.price')}</span>
                <b>{tr('wealth_SellDialog.mult_of_market', { mult })}</b>
              </div>
              <input type="range" min={50} max={150} step={5} value={mult} onChange={(e) => setMult(+e.target.value)} aria-label={tr('wealth_SellDialog.price_as_a_share_of')} />
              <div className="w-kv-row faint">
                <span>50%</span>
                <span>{tr('wealth_SellDialog.n100_market')}</span>
                <span>150%</span>
              </div>
            </div>
            <div className="w-bulk">
              <div className="w-bulk-b" role="presentation" onClick={() => setBulk((b) => !b)}>
                <Cb on={bulk} label={tr('wealth_SellDialog.bulk_only')} onClick={() => {}} />
                {tr('wealth_SellDialog.bulk_only')}
              </div>
              <span className="faint" title={tr('wealth_SellDialog.kinds_of_item_in_this')}>{tr('wealth_SellDialog.count_items_tolocalestring_pieces', { count: items.length, count2: count.toLocaleString() })}</span>
            </div>
            <div className="w-eyebrow-t">{tr('wealth_SellDialog.trade_windows_60_slots_each')}</div>
            <div className="w-wins">
              {wins.map((x) => (
                <div key={x.n} className="w-win">
                  <span className="faint">{x.n}</span>
                  <span>{tr('wealth_SellDialog.slots_slots', { slots: x.slots })}</span>
                  <span className="w-wi">{x.items.map((i) => `${i.name} ×${i.qty.toLocaleString()}`).join(', ')}</span>
                  <b>{fmtChaos(x.value, divine)}</b>
                </div>
              ))}
              {wins.length === 0 && <div className="w-none">{tr('wealth_SellDialog.nothing_left_to_sell_with')}</div>}
            </div>
          </div>
          <div className="w-dlg-r">
            <span className="w-eyebrow-t">{tr('wealth_SellDialog.buyer_pays')}</span>
            <span className="w-pay">{tr('wealth_SellDialog.tofixed_div', { value: (total / divine).toFixed(1) })}</span>
            <span className="faint">{tr('wealth_SellDialog.tolocalestring_chaos_divine_c_1', { total: Math.round(total).toLocaleString(), divine: Math.round(divine) })}</span>
            <hr />
            <span className="w-p">{tr('wealth_SellDialog.the_buyer_pays_window_by')}</span>
            {acct.signedIn && (
              <label className="w-listed-as">
                <span className="w-eyebrow-t">{tr('wealth_SellDialog.listed_as')}</span>
                <input value={listedAs} onChange={(e) => setListedAs(e.target.value.slice(0, 40))} maxLength={40} aria-label={tr('wealth_SellDialog.listed_as_2')} placeholder={accountName || tr('wealth_SellDialog.a_name_for_this_listing')} />
                <span className="faint">{tr('wealth_SellDialog.the_name_buyers_see_on')}</span>
              </label>
            )}
            {onBoard && (
              <button type="button" className="w-link w-board-link" onClick={onBoard}>
                {tr('wealth_SellDialog.see_the_bulk_board')}
              </button>
            )}
            {warn && (
              <span className="w-warn">
                {rising.map((r) => r.name).join(', ')} {rising.length > 1 ? tr('wealth_SellDialog.are') : tr('wealth_SellDialog.is')} {tr('wealth_SellDialog.rising_fast_selling_later_may')}
              </span>
            )}
          </div>
        </div>
        <div className="w-dlg-f">
          {warn && (
            <button type="button" className="w-btn alt" onClick={() => setSkipRising(true)}>
              <Icon name="trend-up" size={14} />
              {tr('wealth_SellDialog.keep_rising_items')}
            </button>
          )}
          <button type="button" className="w-btn alt" onClick={onClose}>
            <Icon name="x" size={14} />
            {tr('wealth_SellDialog.cancel')}
          </button>
          <button type="button" className="w-btn alt" disabled={wins.length === 0} onClick={() => void post()}>
            <Icon name="upload" size={14} />
            {tr('wealth_SellDialog.post_to_bulk_board')}
          </button>
          <button type="button" className="w-btn" disabled={wins.length === 0} onClick={() => void copy()}>
            {tr('wealth_SellDialog.copy_listing_tofixed_div', { value: (total / divine).toFixed(1) })}
          </button>
        </div>
    </Modal>
  );
}
