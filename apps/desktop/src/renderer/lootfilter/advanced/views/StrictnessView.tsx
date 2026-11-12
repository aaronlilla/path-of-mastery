import { Fragment, useMemo } from 'react';
import type { LfNav } from '../../LootFilterArea';
import { useLf } from '../../lfStore';
import { LabelChip } from '../../LabelChip';
import { STRICTNESS } from '../../../../shared/lootfilter/styles.js';
import { Btn, GroundBox, Head, Panel, Eyebrow, Page, plain, useGround } from '../strictness/kit';
import { sampleItems } from '../strictness/sample';
import { tr } from '../../../i18n';
import { strictName, strictBlurb } from '../../names';

/** Strictness: seven steps, what each one hides (counted from NeverSink's own files), and a grid to compare them. */
export function StrictnessView({ nav }: { nav: LfNav }) {
  const lf = useLf();
  const [ground] = useGround();
  const cur = lf.doc.setup.strictness;
  const h = lf.hidden;
  const set = (i: number): void => {
    if (i === cur) return;
    lf.edit(tr('lootfilter_advanced_views_StrictnessView.set_strictness_to_name', { name: strictName(i) }), (d) => ({ ...d, setup: { ...d.setup, strictness: i } }));
  };

  const rows = useMemo(() => {
    if (!lf.catalog || !h) return [];
    return sampleItems(lf.catalog, h.mask, (n) => lf.prices?.byName[n]?.chaos ?? 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lf.catalog, h, lf.prices]);

  const hiddenNow = h ? h.hidden[cur] ?? 0 : 0;
  const regular = h ? h.hidden[1] ?? 0 : 0;
  const delta = !h ? '' : cur === 1 ? tr('lootfilter_advanced_views_StrictnessView.the_reference_level') : hiddenNow > regular ? tr('lootfilter_advanced_views_StrictnessView.hides_tolocalestring_more_than_regul', { value: (hiddenNow - regular).toLocaleString() }) : tr('lootfilter_advanced_views_StrictnessView.shows_tolocalestring_more_than_regul', { value: (regular - hiddenNow).toLocaleString() });

  return (
    <Page>
      <Head title={tr('lootfilter_advanced_views_StrictnessView.strictness')} sub={tr('lootfilter_advanced_views_StrictnessView.how_much_cheap_loot_is')}>
        <Btn icon="eye" onClick={() => nav.setAdvancedView('customize')}>
          {tr('lootfilter_advanced_views_StrictnessView.review_your_overrides')}
        </Btn>
      </Head>

      <div className="lf-card adv-s-sxtop">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="adv-s-steps" role="group" aria-label={tr('lootfilter_advanced_views_StrictnessView.strictness_level')}>
            {STRICTNESS.map((s, i) => (
              <button key={s.id} type="button" className={'adv-s-step' + (i <= cur ? ' on' : '')} aria-pressed={i === cur} onClick={() => set(i)}>
                <i />
                <span>{strictName(i)}</span>
              </button>
            ))}
          </div>
          <span style={{ color: 'var(--text-2)', lineHeight: 1.5 }}>{strictBlurb(cur)}</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span className="adv-s-sxname">{strictName(cur)}</span>
          {h ? (
            <>
              <span style={{ color: 'var(--text-2)' }} title={tr('lootfilter_advanced_views_StrictnessView.counted_from_neversink_version_item', { version: h.version, total: h.total.toLocaleString() })}>
                {tr('lootfilter_advanced_views_StrictnessView.tolocalestring_item_types_hidden', { hiddenNow: hiddenNow.toLocaleString() })}
              </span>
              <div className="adv-s-bar" role="img" aria-label={tr('lootfilter_advanced_views_StrictnessView.hiddennow_of_total_item_types', { hiddenNow, total: h.total })}>
                <div style={{ width: `${h.total ? Math.min(100, (hiddenNow / h.total) * 100) : 0}%` }} />
              </div>
              <span className="adv-s-faint">{delta}</span>
            </>
          ) : (
            <span className="adv-s-faint">{tr('lootfilter_advanced_views_StrictnessView.counting_what_each_level_hides')}</span>
          )}
        </div>
      </div>

      <Panel className="" style={{ gap: 4, minHeight: 0, overflowX: 'auto' }}>
        <div className="adv-s-row" style={{ gap: 10, paddingBottom: 8 }}>
          <Eyebrow>{tr('lootfilter_advanced_views_StrictnessView.compare_levels')}</Eyebrow>
          <span className="adv-s-faint" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {tr('lootfilter_advanced_views_StrictnessView.filled_dot_shown_hollow_hidden')}
          </span>
        </div>
        {!h || !lf.catalog ? (
          <span className="adv-s-faint">{lf.baseLoading ? tr('lootfilter_advanced_views_StrictnessView.reading_neversink') : tr('lootfilter_advanced_views_StrictnessView.no_neversink_data_to_compare')}</span>
        ) : rows.length === 0 ? (
          <span className="adv-s-faint">{tr('lootfilter_advanced_views_StrictnessView.no_item_types_in_neversink', { version: h.version })}</span>
        ) : (
          <div className="adv-s-cmp">
            <span />
            {STRICTNESS.map((s, i) => (
              <button key={s.id} type="button" className="col" aria-pressed={i === cur} onClick={() => set(i)}>
                {strictName(i)}
              </button>
            ))}
            {rows.map((it) => {
              const m = h.mask[it.name] ?? 0;
              const st = lf.evaluateCatalogItem(it)?.style ?? it.style;
              return (
                <Fragment key={it.name}>
                  <div className="nm">
                    <GroundBox kind={ground}>
                      <LabelChip name={it.name} style={plain(st)} fontPx={15} bright={ground === 'bright'} />
                    </GroundBox>
                  </div>
                  {STRICTNESS.map((s, L) => {
                    const hid = ((m >> L) & 1) === 1;
                    return (
                      <div key={s.id} className={'cell' + (L === cur ? ' cur' : '')}>
                        <span className={'dot' + (hid ? ' hid' : '')} title={tr(hid ? 'h_lootB_Views.dot_hidden' : 'h_lootB_Views.dot_shown', { item: it.name, level: strictName(L) })} />
                      </div>
                    );
                  })}
                </Fragment>
              );
            })}
          </div>
        )}
      </Panel>
    </Page>
  );
}
