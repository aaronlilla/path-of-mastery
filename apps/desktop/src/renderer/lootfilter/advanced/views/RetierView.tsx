import { useMemo, useState } from 'react';
import type { LfNav } from '../../LootFilterArea';
import { formatPrice, useLf } from '../../lfStore';
import { LabelChip } from '../../LabelChip';
import { useToast, Icon } from '../../../ui';
import { Btn, GroundBox, Head, Page, Panel, Eyebrow, Spinner, plain, useGround } from '../strictness/kit';
import { priceAge } from '../../hidesText';
import { useRetier } from '../retier/useRetier';
import { applyPriceMoves } from '../retier/apply';
import { tr } from '../../../i18n';

const MAX_ROWS = 150;

/** Retier: items whose poe.ninja price sits outside the price band of the tier NeverSink put them in. */
export function RetierView({ nav }: { nav: LfNav }) {
  const lf = useLf();
  const toast = useToast();
  const [ground] = useGround();
  const rt = useRetier();
  const [off, setOff] = useState<Record<string, boolean>>({});
  const locks = (Array.isArray(lf.ui.advLocks) ? lf.ui.advLocks : []) as string[];

  const divine = lf.prices?.divine ?? 0;
  const unit = lf.settings.currencyUnit;
  const fmt = (c: number): string => formatPrice(c, divine, unit);
  const cur = rt.lead;
  const shown = useMemo(() => rt.rows.slice(0, MAX_ROWS), [rt.rows]);
  const selected = shown.filter((r) => !r.done && off[r.item.name] !== true && !locks.includes(r.item.name));

  const apply = (): void => {
    const n = applyPriceMoves(lf, selected);
    if (n) toast({ text: tr('lootfilter_advanced_views_RetierView.moved_count_items_to_new', { count: n }), kind: 'ok' });
  };

  const age = lf.prices ? priceAge(lf.prices.fetchedAt) : '';
  const left = rt.total;
  const sub = lf.prices
    ? tr(left === 1 ? 'h_lootB_Views.retier_sub_one' : 'h_lootB_Views.retier_sub_other', { league: lf.prices.league || lf.settings.league || tr('lootfilter_advanced_views_RetierView_2.current_league'), age, n: left })
    : tr('lootfilter_advanced_views_RetierView.compares_poe_ninja_prices_with');

  return (
    <Page>
      <Head title={tr('lootfilter_advanced_views_RetierView.retier')} sub={sub}>
        <Btn icon="clock" onClick={() => nav.setAdvancedView('overview')}>
          {tr('lootfilter_advanced_views_RetierView.not_now')}
        </Btn>
        <Btn kind="gold" onClick={apply} disabled={!selected.length}>
          {selected.length ? tr('lootfilter_advanced_views_RetierView.move_count_items', { count: selected.length }) : tr('lootfilter_advanced_views_RetierView.nothing_selected')}
        </Btn>
      </Head>

      {!lf.prices ? (
        <Panel>
          <Eyebrow>{tr('lootfilter_advanced_views_RetierView.prices')}</Eyebrow>
          {lf.pricesLoading ? (
            <div className="adv-s-row">
              <Spinner />
              <span className="adv-s-muted">{tr('lootfilter_advanced_views_RetierView.loading_prices_from_poe_ninja')}</span>
            </div>
          ) : (
            <>
              <span className="adv-s-strong">{tr('lootfilter_advanced_views_RetierView.no_prices_yet')}</span>
              <span className="adv-s-muted">{tr('lootfilter_advanced_views_RetierView.priceerror_retier_needs_today_s', { priceError: lf.priceError ?? tr('lootfilter_advanced_views_RetierView.prices_have_not_loaded') })}</span>
              <div>
                <Btn icon="refresh" onClick={() => void lf.refreshPrices(true)}>
                  {tr('lootfilter_advanced_views_RetierView.retry')}
                </Btn>
              </div>
            </>
          )}
        </Panel>
      ) : !lf.catalog ? (
        <Panel>
          <span className="adv-s-muted">{lf.baseLoading ? tr('lootfilter_advanced_views_RetierView.reading_neversink') : tr('lootfilter_advanced_views_RetierView.no_neversink_data_loaded')}</span>
        </Panel>
      ) : !cur ? (
        <Panel>
          <Eyebrow>{tr('lootfilter_advanced_views_RetierView.all_tiers_fit')}</Eyebrow>
          <span className="adv-s-strong">{tr('lootfilter_advanced_views_RetierView.no_item_sits_outside_its')}</span>
          <span className="adv-s-muted">{tr('lootfilter_advanced_views_RetierView.checked_every_neversink_item_type', { count: Object.keys(lf.prices.byName).length.toLocaleString() })}{lf.priceStale ? tr('lootfilter_advanced_views_RetierView.these_prices_are_out_of') : ''}.</span>
          <div>
            <Btn icon="refresh" onClick={() => void lf.refreshPrices(true)} disabled={lf.pricesLoading}>
              {tr('lootfilter_advanced_views_RetierView.refresh_prices')}
            </Btn>
          </div>
        </Panel>
      ) : (
        <>
          <Panel className="" style={{ flexDirection: 'row', alignItems: 'center', gap: 18, flexWrap: 'wrap', padding: '10px 16px' }}>
            <Eyebrow>{tr('lootfilter_advanced_views_RetierView.tier_lines')}</Eyebrow>
            {rt.types.length > 1 && <span style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>{cur.label}</span>}
            {cur.bands.map((b, i) => (
              <span key={b.tier.key} style={{ color: 'var(--text-2)', fontSize: 12.5 }} title={tr('lootfilter_advanced_views_RetierView.median_median_across_count_priced', { count: b.members, median: fmt(b.median) })}>
                <span style={{ color: 'var(--text-strong)', fontWeight: 600 }}>{b.name}</span> {i === cur.bands.length - 1 && b.low === 0 ? tr('lootfilter_advanced_views_RetierView.under_high', { high: fmt(b.high) }) : tr('lootfilter_advanced_views_RetierView.low_and_up', { low: fmt(b.low) })}
              </span>
            ))}
          </Panel>
          <div className="lf-card adv-s-table">
            {shown.map((r) => {
              const locked = locks.includes(r.item.name);
              const checked = !r.done && !locked && off[r.item.name] !== true;
              return (
                <div key={r.item.name} className={'adv-s-trow' + (r.done ? ' done' : '')}>
                  <input type="checkbox" checked={checked} disabled={r.done || locked} onChange={() => setOff((o) => ({ ...o, [r.item.name]: checked }))} aria-label={tr('lootfilter_advanced_views_RetierView.move_this_item')} />
                  <GroundBox kind={ground}>
                    <LabelChip name={r.item.name} style={plain(r.from.style)} fontPx={15} bright={ground === 'bright'} />
                  </GroundBox>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6 }} title={tr('lootfilter_advanced_views_RetierView.price_now_price_the_median', { price: fmt(r.price), label: r.from.label, fromMedian: fmt(r.fromMedian), label2: r.to.label, toMedian: fmt(r.toMedian) })}>
                    {fmt(r.fromMedian)}
                    <Icon name="arrow-right" size={10} style={{ opacity: 0.6 }} />
                    <span style={{ color: 'var(--text-strong)' }}>{fmt(r.price)}</span>
                  </span>
                  <span style={{ color: r.pct > 0 ? 'var(--positive-text)' : 'var(--negative-text)' }}>{(r.pct > 0 ? '+' : '') + r.pct}%</span>
                  <span title={r.typeLabel}>
                    {rt.types.length > 1 && r.type !== cur.type ? `${r.typeLabel}: ` : ''}
                    {tr('lootfilter_advanced_views_RetierView.fromname_to_toname', { fromName: r.fromName, toName: r.toName })}
                  </span>
                  <span style={{ textAlign: 'right', fontSize: 12, color: r.done ? 'var(--positive-text)' : 'var(--text-muted)' }}>{r.done ? tr('lootfilter_advanced_views_RetierView.moved') : locked ? tr('lootfilter_advanced_views_RetierView.locked') : ''}</span>
                </div>
              );
            })}
            {rt.rows.length > MAX_ROWS && (
              <span className="adv-s-faint" style={{ paddingTop: 8 }}>
                {tr('lootfilter_advanced_views_RetierView.showing_the_max_rows_furthest', { MAX_ROWS, count: rt.rows.length })}
              </span>
            )}
          </div>
        </>
      )}
    </Page>
  );
}
