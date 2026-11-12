import { useMemo, useState } from 'react';
import type { LfNav } from '../../LootFilterArea';
import { useLf } from '../../lfStore';
import { LabelChip } from '../../LabelChip';
import { STYLES, applyStylePreset } from '../../../../shared/lootfilter/styles.js';
import { sectionOfType } from '../../../../shared/lootfilter/sections.js';
import type { FilterSetup, LabelStyle } from '../../../../shared/lootfilter/types.js';
import { Head, GroundBox, Page, Seg, useGround } from '../strictness/kit';
import { tr } from '../../../i18n';
import { styleName } from '../../names';

/** What each whole-filter style does, in the words of what applyStylePreset really changes. */
const DESC = [
  tr('lootfilter_advanced_views_ThemesView.the_colours_the_filter_ships'),
  tr('lootfilter_advanced_views_ThemesView.light_backgrounds_become_dark_with'),
  tr('lootfilter_advanced_views_ThemesView.black_label_no_border_no'),
  tr('lootfilter_advanced_views_ThemesView.border_matches_the_text_larger'),
];

type Scope = 'whole' | 'currency' | 'gear';
const SCOPE_NAME: Record<Scope, string> = { whole: tr('lootfilter_advanced_views_ThemesView_2.whole_filter'), currency: tr('h_lootB_Views.scope_currency'), gear: tr('h_lootB_Views.scope_gear') };
const SCOPE_DONE: Record<Scope, string> = { whole: tr('lootfilter_advanced_views_ThemesView_2.the_whole_filter'), currency: tr('lootfilter_advanced_views_ThemesView_2.currency_only'), gear: tr('lootfilter_advanced_views_ThemesView_2.gear_only') };

interface Sample {
  name: string;
  style: LabelStyle;
}

const CURRENCY_NAMES = ['Mirror of Kalandra', 'Divine Orb', 'Exalted Orb', 'Chaos Orb', 'Orb of Alchemy'];
const GEAR_NAMES = ['Stygian Vise', 'Hubris Circlet', 'Vermillion Ring', 'Sadist Garb', 'Astral Plate'];

const bare = (s: LabelStyle): LabelStyle => {
  const { sound: _s, icon: _i, beam: _b, dropSound: _d, ...rest } = s;
  return rest;
};

/** The five labels each card draws, with the looks the filter really gives them (text only, as the design shows). */
function useSamples(scope: Scope): Sample[] {
  const lf = useLf();
  return useMemo(() => {
    const cat = lf.catalog;
    if (!cat) return [];
    if (scope !== 'gear') {
      const out: Sample[] = [];
      for (const n of CURRENCY_NAMES) {
        const it = cat.byName.get(n);
        if (it && (it.style.bg || it.style.fg)) out.push({ name: n, style: bare(it.style) });
      }
      return out;
    }
    // Gear has no named items in NeverSink; its tiers are rules. Take five lit gear tiers with different looks.
    const seen = new Set<string>();
    const looks: LabelStyle[] = [];
    for (const t of cat.types) {
      if (sectionOfType(t.type).scope !== 'gear') continue;
      for (const ti of t.tiers) {
        if (ti.kind === 'Hide' || !ti.style.fg || !ti.style.bg) continue;
        const k = JSON.stringify([ti.style.fg, ti.style.bg, ti.style.bd]);
        if (seen.has(k)) continue;
        seen.add(k);
        looks.push(bare(ti.style));
      }
    }
    looks.sort((a, b) => (b.fs ?? 0) - (a.fs ?? 0));
    const step = Math.max(1, Math.floor(looks.length / 5));
    return GEAR_NAMES.map((name, i) => ({ name, style: looks[Math.min(looks.length - 1, i * step)] ?? {} })).filter((s) => Object.keys(s.style).length > 0);
  }, [lf.catalog, scope]);
}

const activeIndex = (setup: FilterSetup, scope: Scope): number => (scope === 'currency' ? setup.styleCurrency ?? setup.style : scope === 'gear' ? setup.styleGear ?? setup.style : setup.style);

/** Themes: the four styles, each drawn on real labels with the exact style function the writer uses. */
export function ThemesView({ nav: _nav }: { nav: LfNav }) {
  const lf = useLf();
  const [ground, setGround] = useGround();
  const [scope, setScope] = useState<Scope>('whole');
  const samples = useSamples(scope);
  const setup = lf.doc.setup;
  const active = activeIndex(setup, scope);
  const apply = (i: number): void => {
    if (i === active) return;
    lf.edit(tr('lootfilter_advanced_views_ThemesView.name_applied_to_scope', { name: styleName(i), scope: SCOPE_DONE[scope] }), (d) => {
      const s: FilterSetup = { ...d.setup };
      if (scope === 'whole') {
        s.style = i;
        delete s.styleCurrency;
        delete s.styleGear;
      } else if (scope === 'currency') {
        if (i === s.style) delete s.styleCurrency;
        else s.styleCurrency = i;
      } else if (i === s.style) delete s.styleGear;
      else s.styleGear = i;
      return { ...d, setup: s };
    });
  };
  const note = (() => {
    const c = setup.styleCurrency;
    const g = setup.styleGear;
    const bits: string[] = [];
    if (c !== undefined && c !== setup.style) bits.push(tr('lootfilter_advanced_views_ThemesView_2.currency_uses', { name: styleName(c) }));
    if (g !== undefined && g !== setup.style) bits.push(tr('lootfilter_advanced_views_ThemesView_2.gear_uses', { name: styleName(g) }));
    return bits.length ? tr('lootfilter_advanced_views_ThemesView_2.for_the_rest_of_the_filter', { name: styleName(setup.style), and: bits.join(` ${tr('h_lootB_Views.and_w')} `) }) : '';
  })();
  return (
    <Page>
      <Head title={tr('lootfilter_advanced_views_ThemesView.themes')} sub={tr('lootfilter_advanced_views_ThemesView.restyle_every_tier_at_once')}>
        <Seg<Scope>
          value={scope}
          label={tr('lootfilter_advanced_views_ThemesView.scope')}
          options={[
            { value: 'whole', label: tr('lootfilter_advanced_views_ThemesView.whole_filter') },
            { value: 'currency', label: tr('lootfilter_advanced_views_ThemesView.currency_only') },
            { value: 'gear', label: tr('lootfilter_advanced_views_ThemesView.gear_only') },
          ]}
          onChange={setScope}
        />
        <Seg<'dark' | 'bright'>
          value={ground}
          label={tr('lootfilter_advanced_views_ThemesView.ground')}
          options={[
            { value: 'dark', label: tr('lootfilter_advanced_views_ThemesView.dark_ground') },
            { value: 'bright', label: tr('lootfilter_advanced_views_ThemesView.bright_ground') },
          ]}
          onChange={setGround}
        />
      </Head>
      {note && <span className="adv-s-faint" style={{ marginTop: -4 }}>{note}</span>}
      <div className="adv-s-cards">
        {STYLES.map((s, i) => (
          <div key={s.id} className={'lf-card adv-s-card' + (i === active ? ' active' : '')}>
            <div className="adv-s-row">
              <span className="adv-s-cardname">{styleName(i)}</span>
            </div>
            <GroundBox kind={ground} className={'adv-s-sample' + (ground === 'dark' ? ' flat' : '')} style={ground === 'dark' ? { background: 'transparent' } : undefined}>
              {samples.length === 0 ? (
                <span className="adv-s-faint" style={{ color: ground === 'bright' ? 'rgba(24,20,14,.72)' : 'rgba(255,240,215,.62)' }}>
                  {lf.baseLoading ? tr('lootfilter_advanced_views_ThemesView.reading_neversink') : tr('lootfilter_advanced_views_ThemesView.no_labels_to_preview')}
                </span>
              ) : (
                samples.map((x) => <LabelChip key={x.name} name={x.name} style={applyStylePreset(x.style, i)} fontPx={24} bright={ground === 'bright'} />)
              )}
            </GroundBox>
            <span className="adv-s-muted" style={{ minHeight: 36 }}>
              {DESC[i] ?? s.blurb}
            </span>
            <button type="button" className="adv-s-btn" style={{ width: '100%' }} disabled={i === active} onClick={() => apply(i)}>
              {i === active ? tr('lootfilter_advanced_views_ThemesView.applied') : tr('lootfilter_advanced_views_ThemesView.apply_to_scope', { scope: SCOPE_NAME[scope] })}
            </button>
          </div>
        ))}
      </div>
    </Page>
  );
}
