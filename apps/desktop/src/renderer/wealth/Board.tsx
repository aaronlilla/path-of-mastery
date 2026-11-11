import { useMemo, useState } from 'react';
import { askChaos, clampMult, filterListings, isOnline, MULT_MAX, MULT_MIN, SELLERS_TO_SHOW, sellerCount, whisper, type BulkFilter, type BulkListing, type BulkSort, type BulkView } from '../../shared/bulk.js';
import { fmtChaos, type Cat } from '../../shared/wealth.js';
import { useAcct } from '../accounts/useAccount';
import { Icon, useToast } from '../ui.js';
import { catName, Chip, Empty, Panel, Seg } from './wui.js';
import { tr } from '../i18n';
import { fmtAgo, lot, msg } from './mainText';

const CATS: (Cat | 'all')[] = ['all', 'cur', 'scar', 'frag', 'ess', 'card'];
const SORTS: [BulkSort, string][] = [['new', tr('wealth_Board_2.newest')], ['price', tr('wealth_Board_2.price')], ['deal', tr('wealth_Board_2.best_deal')]];

const lotText = (l: BulkListing) => lot(l.items);
const lotFull = (l: BulkListing) => lot(l.items, l.items.length);
type Result = { ok: true } | { ok: false; error: string };

/** Bulk board: bulk sellers' listings from the community backend. Without an account there is nothing to show but how to get it. */
export function Board({ view, now, reload, onStash }: { view: BulkView | null; now: number; reload: () => void; onStash: () => void }) {
  const acct = useAcct();
  const toast = useToast();
  const [f, setF] = useState<BulkFilter>({ q: '', cat: 'all', onlineOnly: false, sort: 'new' });
  const [offering, setOffering] = useState<{ id: string; mult: number } | null>(null);
  const rows = useMemo(() => (view?.status === 'ready' ? filterListings(view.listings, f, now) : []), [view, f, now]);

  if (!view) return <div className="w-center" data-screen-label="Wealth / Tab / board" />;
  if (view.status === 'needs-account') {
    return (
      <div className="w-center" data-screen-label="Wealth / Tab / board" data-state="needs-account">
        <Panel className="w-card w-board">
          <span className="w-board-t">{tr('wealth_Board.the_bulk_board_needs_an')}</span>
          <span className="w-board-p">{tr('wealth_Board.listings_are_shared_between_players')}</span>
          <div className="w-btns inline">
            <button type="button" className="w-btn" onClick={() => acct.openSignIn()}>
              <Icon name="log-in" size={14} />
              {tr('wealth_Board.sign_in')}
            </button>
            <button type="button" className="w-btn alt" onClick={onStash}>
              <Icon name="tag" size={14} />
              {tr('wealth_Board.sell_from_your_stash')}
            </button>
          </div>
        </Panel>
      </div>
    );
  }

  if (view.status === 'unavailable') {
    return (
      <div className="w-center" data-screen-label="Wealth / Tab / board" data-state="unavailable">
        <Panel className="w-card w-board">
          <span className="w-board-t">{tr('wealth_Board.the_bulk_board_could_not')}</span>
          <span className="w-board-p">{tr('wealth_Board.error_your_own_listings_are', { error: msg(view.error ?? '') })}</span>
          <div className="w-btns inline">
            <button type="button" className="w-btn" onClick={reload}>{tr('wealth_Board.try_again')}</button>
          </div>
        </Panel>
      </div>
    );
  }

  const { divine, me } = view;
  const fmt = (c: number) => fmtChaos(c, divine);
  const mine = view.listings.filter((l) => l.mine);
  const act = async (p: Promise<Result>, done: string): Promise<boolean> => {
    const r = await p;
    toast(r.ok ? { text: done, kind: 'ok' } : { text: msg(r.error), kind: 'error' });
    reload();
    return r.ok;
  };
  const copy = async (text: string, done: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ text: done, kind: 'ok' });
    } catch {
      toast({ text: tr('wealth_Board.could_not_reach_the_clipboard'), kind: 'error' });
    }
  };

  return (
    <div className="w-bb" data-screen-label="Wealth / Tab / board">
      <Panel className="w-tbl w-bb-main">
        <div className="w-tool">
          <label className="w-search">
            <input value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} placeholder={tr('wealth_Board.search_items_or_sellers')} aria-label={tr('wealth_Board.search_listings')} />
          </label>
          <div className="w-cats" role="group" aria-label={tr('wealth_Board.category')}>
            {CATS.map((c) => (
              <button key={c} type="button" aria-pressed={f.cat === c} onClick={() => setF({ ...f, cat: c })}>
                {c === 'all' ? tr('wealth_Board.all') : catName(c)}
              </button>
            ))}
          </div>
          <span className="grow" />
          <button type="button" className="w-bb-on" aria-pressed={f.onlineOnly} onClick={() => setF({ ...f, onlineOnly: !f.onlineOnly })}>
            <i />
            {tr('wealth_Board.online_now')}
          </button>
          <Seg label={tr('wealth_Board.sort_listings')} labels={SORTS.map((s) => s[1])} active={SORTS.findIndex((s) => s[0] === f.sort)} onPick={(i) => setF({ ...f, sort: SORTS[i]![0] })} />
        </div>
        <div className="w-bb-h">
          <span>{tr('wealth_Board.seller')}</span>
          <span>{tr('wealth_Board.lot')}</span>
          <span className="r">{tr('wealth_Board.price')}</span>
          <span className="r">{tr('wealth_Board.of_market')}</span>
          <span className="r">{tr('wealth_Board.posted')}</span>
          <span />
        </div>
        <div className="w-body">
          {!view.sample && rows.length === 0 && <div className="w-none">{view.listings.some((l) => !l.mine) ? tr('wealth_Board.no_listing_matches') : tr('wealth_Board.no_live_listings_from_players')}</div>}
          {rows.map((l) => (
            <div key={l.id} className="w-bb-item">
              <div className="w-bb-r" data-live="" data-online={isOnline(l, now)}>
                <span className="w-bb-who" title={isOnline(l, now) ? tr('wealth_Board.has_path_of_mastery_open') : tr('wealth_Board.last_had_path_of_mastery', { lastOnlineAt: fmtAgo(now - l.lastOnlineAt) })}>
                  <i />
                  <b>{l.seller}</b>
                  <em>{l.vouches > 0 ? tr('wealth_Board.count_vouches', { count: l.vouches }) : isOnline(l, now) ? tr('wealth_Board.online') : fmtAgo(now - l.lastOnlineAt)}</em>
                </span>
                <span className="w-name wrap" title={lotFull(l)}>
                  {lotText(l)}
                  <i>{catName(l.cat)}</i>
                </span>
                <span className="r" title={tr('wealth_Board.tolocalestring_chaos', { askChaos: Math.round(askChaos(l)).toLocaleString('en-US') })}>{fmt(askChaos(l))}</span>
                <span className="r">
                  <Chip tone={l.mult < 100 ? 'positive' : l.mult > 100 ? 'warning' : 'neutral'} title={tr('wealth_Board.market_value_marketchaos_when_posted', { marketChaos: fmt(l.marketChaos) })}>{`${l.mult}%`}</Chip>
                </span>
                <span className="r faint">{fmtAgo(now - l.postedAt)}</span>
                <span className="w-bb-act">
                  <button type="button" className="w-btn sm" onClick={() => void copy(whisper(l, divine), tr('wealth_Board.whisper_copied_paste_it_in'))}>
                    <Icon name="copy" size={13} />
                    {tr('wealth_Board.whisper')}
                  </button>
                  <button type="button" className="w-btn alt sm" aria-expanded={offering?.id === l.id} onClick={() => setOffering(offering?.id === l.id ? null : { id: l.id, mult: l.mult })}>
                    {tr('wealth_Board.offer')}
                  </button>
                  <button type="button" className="w-link" disabled={l.voted === 'vouch'} title={tr('wealth_Board.this_seller_traded_fairly')} onClick={() => void act(window.pom.wealth.boardVouch(l.id), tr('wealth_Board.vouch_added'))}>
                    {l.voted === 'vouch' ? tr('wealth_Board.vouched') : tr('wealth_Board.vouch')}
                  </button>
                  <button type="button" className="w-link" disabled={l.voted === 'report'} title={tr('wealth_Board.report_a_scam_two_independent')} onClick={() => void act(window.pom.wealth.boardReport(l.id), tr('wealth_Board.reported_two_independent_reports_hid'))}>
                    {l.voted === 'report' ? tr('wealth_Board.reported') : tr('wealth_Board.report')}
                  </button>
                </span>
              </div>
              {offering?.id === l.id && (
                <div className="w-bb-offer">
                  <span>{tr('wealth_Board.offer')}</span>
                  <input type="range" min={MULT_MIN} max={MULT_MAX} step={1} value={offering.mult} onChange={(e) => setOffering({ id: l.id, mult: clampMult(+e.target.value) })} aria-label={tr('wealth_Board.offer_as_a_share_of')} />
                  <b>{`${offering.mult}% · ${fmt((l.marketChaos * offering.mult) / 100)}`}</b>
                  <button type="button" className="w-btn sm" onClick={() => void act(window.pom.wealth.boardOffer(l.id, offering.mult), tr('wealth_Board.offer_sent_to_split', { split: l.seller.split('#')[0] })).then((ok) => ok && setOffering(null))}>
                    {tr('wealth_Board.send_offer')}
                  </button>
                </div>
              )}
            </div>
          ))}
          {rows.length === 0 && (
            <Empty
              title={tr('wealth_Board.no_listings_match')}
              body={view.listings.some((l) => !l.mine) ? tr('wealth_Board.try_fewer_filters') : tr('wealth_Board.nobody_has_posted_a_lot')}
              action={
                (f.q || f.cat !== 'all' || f.onlineOnly) && (
                  <button type="button" className="w-btn alt sm" onClick={() => setF({ ...f, q: '', cat: 'all', onlineOnly: false })}>
                    <Icon name="x" size={14} />
                    {tr('wealth_Board.clear_filters')}
                  </button>
                )
              }
            />
          )}
        </div>
        <div className="w-foot">
          <span>{tr('wealth_Board.count_listings_from_now_sellers', { count: rows.length, now: sellerCount(view.listings, now) })}</span>
          <span className="faint">{tr('wealth_Board.online_means_the_seller_has', { SELLERS_TO_SHOW })}</span>
        </div>
      </Panel>
      {view.sampleListings && view.sampleListings.length > 0 && (
        <Panel className="w-tbl w-bb-sample">
          <h3 className="w-bb-sample-h" title={tr('wealth_Board.made_up_sellers_so_the')}>{tr('wealth_Board.sample_listings')}</h3>
          <div className="w-none">{tr('wealth_Board.examples_not_from_players_they')}</div>
          <div className="w-body">
            {view.sampleListings.map((l) => (
              <div key={l.id} className="w-bb-item">
                <div className="w-bb-r" data-sample="" data-online={isOnline(l, now)}>
                  <span className="w-bb-who"><i /><b>{l.seller}</b><em>{tr('wealth_Board.sample')}</em></span>
                  <span className="w-name wrap" title={lotFull(l)}>{lotText(l)}<i>{catName(l.cat)}</i></span>
                  <span className="r">{fmt(askChaos(l))}</span>
                  <span className="r"><Chip tone="neutral">{`${l.mult}%`}</Chip></span>
                  <span className="r faint">{fmtAgo(now - l.postedAt)}</span>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      )}
      <Panel className="w-bb-mine">
        <div className="w-eyebrow">
          <span>{tr('wealth_Board.your_listings_length', { count: mine.length })}</span>
          {view.sample && <Chip tone="gold" title={tr('wealth_Board.made_up_sellers_and_a')}>{tr('wealth_Board.sample_listings')}</Chip>}
        </div>
        {mine.length === 0 && <div className="w-none">{tr('wealth_Board.nothing_posted_yet_post_to', { me })}</div>}
        {mine.map((l) => (
          <div key={l.id} className="w-bb-m">
            <span className="w-name wrap">
              {lotText(l)}
              <i>{tr('wealth_Board.v1_mult_of_market_listed', { value: fmt(askChaos(l)), mult: l.mult, seller: l.seller, postedAt: fmtAgo(now - l.postedAt) })}</i>
            </span>
            <span className="w-bb-offers">
              {(l.offers ?? []).length === 0 ? (
                <em>{tr('wealth_Board.no_offers_yet')}</em>
              ) : (
                (l.offers ?? []).map((o) => (
                  <button key={o.id} type="button" className="w-btn alt sm" data-offer="" title={tr('wealth_Board.from_offers_mult_of_market', { from: o.from, mult: o.mult, mult2: fmt((l.marketChaos * o.mult) / 100), value: fmtAgo(now - o.at) })} onClick={() => void copy(`@${o.from.split('#')[0]} Hi, I accept your offer of ${fmt((l.marketChaos * o.mult) / 100)} for my ${lotText(l)}.`, tr('wealth_Board.reply_copied_paste_it_in'))}>
                    {`${o.from.split('#')[0]} · ${o.mult}% · ${fmt((l.marketChaos * o.mult) / 100)} · ${fmtAgo(now - o.at)}`}
                  </button>
                ))
              )}
            </span>
            <button type="button" className="w-link" onClick={() => void act(window.pom.wealth.boardRemove(l.id), tr('wealth_Board.listing_removed'))}>
              <Icon name="trash" size={12} />
              {tr('wealth_Board.remove')}
            </button>
          </div>
        ))}
      </Panel>
    </div>
  );
}
