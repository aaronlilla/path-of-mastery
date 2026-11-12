import { useMemo, useState } from 'react';
import { GEAR_KINDS } from '../../../../shared/lootfilter/bases.js';
import { STRICTNESS, applyStylePreset } from '../../../../shared/lootfilter/styles.js';
import { buildBlurb } from '../../../../shared/lootfilter/buildBlurb.js';
import { useBuildRules } from '../../buildRulesHook';
import type { Rule } from '../../../../shared/lootfilter/types.js';
import { Icon, useToast } from '../../../ui';
import { classKey, classPortrait } from '../../../art';
import { LabelChip } from '../../LabelChip';
import { useLf } from '../../lfStore';
import type { LfNav } from '../../LootFilterArea';
import { buildRulesAvailable, deriveBuildRules } from '../build/buildRulesBridge';
import { Eyebrow } from '../sim/kit';
import '../sim/adv-v.css';
import { tr } from '../../../i18n';
import { strictName, strictBlurb, styleName } from '../../names';

const GEAR_ICON: Record<string, string> = { body: tr('lootfilter_advanced_views_StartView.body_armour'), helmet: 'helmet', gloves: 'gloves', boots: 'boots', belt: 'belt', ring: 'ring', amulet: 'amulet', shield: 'shield', quiver: 'quiver', flask: 'flask', jewel: 'jewel', weapon: 'weapon' };
const PREFER = ['Divine Orb', 'Exalted Orb', 'Chaos Orb', 'Orb of Alchemy', 'Mirror of Kalandra', 'Orb of Alteration'];
const STYLE_NAMES = [0, 1, 2, 3].map(styleName);

export function StartView({ nav }: { nav: LfNav }) {
  const lf = useLf();
  const toast = useToast();
  const build = lf.build && lf.build.info.valid ? lf.build : null;
  const [useBuild, setUseBuild] = useState(!!build && lf.doc.setup.followBuild);
  const [use, setUse] = useState<string[]>(lf.doc.setup.use);
  const [strict, setStrict] = useState(lf.doc.setup.strictness);
  const [style, setStyle] = useState(lf.doc.setup.style);
  const [busy, setBusy] = useState(false);
  const following = !!build && useBuild;
  const br = useBuildRules();
  const blurb = following ? buildBlurb(br.facts, br.proposals) : [];

  // Real labels from the NeverSink file, drawn in each style.
  const sample = useMemo(() => {
    const cat = lf.catalog;
    if (!cat) return [];
    const picked = PREFER.map((n) => cat.byName.get(n)).filter((x): x is NonNullable<typeof x> => !!x && !x.hidden);
    for (const it of cat.items) {
      if (picked.length >= 4) break;
      if (!it.hidden && !picked.includes(it)) picked.push(it);
    }
    return picked.slice(0, 4);
  }, [lf.catalog]);

  const make = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      let derived: Rule[] | null = null;
      if (following && build) {
        try {
          derived = await deriveBuildRules({ build, doc: lf.doc, catalog: lf.catalog, newId: lf.newId, nextPriority: lf.nextPriority });
        } catch (e) {
          toast({ text: tr('lootfilter_advanced_views_StartView.the_build_could_not_be', { value: e instanceof Error ? e.message : String(e) }), kind: 'error' });
        }
      }
      lf.edit(tr('lootfilter_advanced_views_StartView.set_up_the_filter'), (d) => {
        const next = { ...d, setup: { ...d.setup, strictness: strict, style, followBuild: following, use: following ? d.setup.use : [...use] } };
        if (following && build) {
          next.buildId = build.id;
          next.buildName = build.name;
          if (derived) {
            // The build's rules are replaced as a set; anything the player made stays.
            const mineRules = d.rules.filter((r) => r.source !== 'build');
            next.rules = [...mineRules, ...derived.map((r, i) => ({ ...r, source: 'build' as const, priority: r.priority || Math.max(0, ...mineRules.map((x) => x.priority)) + 1 + i }))];
          }
        }
        return next;
      });
      if (following && !derived) {
        toast({ text: buildRulesAvailable() ? tr('lootfilter_advanced_views_StartView.the_build_gave_no_rules') : tr('lootfilter_advanced_views_StartView.rules_from_the_build_are'), kind: 'info' });
      }
      nav.setAdvancedView('overview');
    } finally {
      setBusy(false);
    }
  };

  const toggleUse = (id: string): void => setUse((u) => (u.includes(id) ? u.filter((x) => x !== id) : [...u, id]));
  const ascend = build ? build.info.ascendClassName || build.info.className : '';
  const portrait = build ? classPortrait(classKey(build.info)) : '';
  const label = busy ? tr('lootfilter_advanced_views_StartView.reading_your_build') : following ? tr('h_lootB_Views.make_for', { what: [ascend, build!.info.mainSkill].filter(Boolean).join(', ') || build!.name }) : tr('lootfilter_advanced_views_StartView.make_filter');

  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
      <div className="adv-st">
        <div className="lf-card" style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: 22, alignSelf: 'start' }}>
          {build ? (
            useBuild ? (
              <>
                <Eyebrow>{tr('lootfilter_advanced_views_StartView.open_build')}</Eyebrow>
                {portrait && <img src={portrait} alt="" style={{ width: 120, height: 120, borderRadius: '50%', objectFit: 'cover', alignSelf: 'center', boxShadow: '0 0 0 1px rgba(var(--accent-rgb),.5),0 14px 40px rgba(0,0,0,.5)' }} />}
                <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={{ font: "600 26px/1.1 'Cormorant Garamond',serif", color: 'var(--text-display)' }}>{build.name}</span>
                  <span style={{ color: 'var(--text-2)' }}>{[ascend, build.info.level ? tr('lootfilter_advanced_views_StartView_2.level', { level: build.info.level }) : ''].filter(Boolean).join(' · ')}</span>
                  {build.info.mainSkill && (
                    <span style={{ color: 'var(--text-2)' }}>
                      {tr('lootfilter_advanced_views_StartView.main_skill')} <span style={{ color: 'var(--gem-dex)' }}>{build.info.mainSkill}</span>
                    </span>
                  )}
                </div>
                {blurb.length ? (
                  blurb.map((l) => (
                    <span key={l} className="adv-v-muted" style={{ lineHeight: 1.45 }}>{l}</span>
                  ))
                ) : (
                  <span className="adv-v-muted" style={{ lineHeight: 1.45 }}>{tr('lootfilter_advanced_views_StartView.the_filter_reads_this_build')}</span>
                )}
                <button type="button" className="btn ghost sm" style={{ color: 'var(--gold-text)' }} onClick={() => setUseBuild(false)}>
                  <Icon name="arrow-right" size={14} />
                  {tr('lootfilter_advanced_views_StartView.continue_without_a_build')}
                </button>
              </>
            ) : (
              <QuickSetup use={use} toggle={toggleUse} onBuild={() => setUseBuild(true)} />
            )
          ) : (
            <QuickSetup use={use} toggle={toggleUse} noBuild />
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
          <div className="lf-card" style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 18 }}>
            <Eyebrow>{tr('lootfilter_advanced_views_StartView.strictness')}</Eyebrow>
            <div className="adv-st-levels">
              {STRICTNESS.map((s, i) => (
                <button key={s.id} type="button" className="adv-st-lv" aria-pressed={strict === i} aria-label={i === 2 ? tr('lootfilter_advanced_views_StartView.name_default', { name: strictName(i) }) : strictName(i)} onClick={() => setStrict(i)}>
                  <span className="adv-st-dot" />
                  <span title={strictName(i)} className="adv-v-ellip" style={{ display: 'block', maxWidth: '100%' }}>{strictName(i)}</span>
                  <span className="adv-v-ellip" style={{ display: 'block', maxWidth: '100%', fontSize: 11, color: 'var(--text-muted)', minHeight: 14 }}>{i === 2 ? tr('lootfilter_advanced_views_StartView.default') : ''}</span>
                </button>
              ))}
            </div>
            <span style={{ color: 'var(--text-2)', lineHeight: 1.45 }}>{strictBlurb(strict)}</span>
          </div>

          <div className="lf-card" style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 18 }}>
            <Eyebrow>{tr('lootfilter_advanced_views_StartView.style')}</Eyebrow>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: 10 }}>
              {STYLE_NAMES.map((s, i) => (
                <button key={s} type="button" className="adv-st-style" aria-pressed={style === i} onClick={() => setStyle(i)}>
                  <span style={{ color: 'var(--text-strong)', font: '500 13px Geist' }}>{s}</span>
                  <span className="adv-v-ground wrap" style={{ background: 'radial-gradient(120% 90% at 50% 40%,#2a2419,#0d0b08)' }}>
                    {sample.length === 0 && <span className="adv-v-muted">{tr('lootfilter_advanced_views_StartView.reading_neversink')}</span>}
                    {sample.map((it) => (
                      <LabelChip key={it.name} name={it.name} style={{ ...applyStylePreset(it.style, i), sound: null, beam: null, icon: null }} fontPx={22} />
                    ))}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="adv-st-bar">
            <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
              <span style={{ color: 'var(--text-strong)', font: '500 14px Geist' }}>
                {`${strictName(strict)} · ${STYLE_NAMES[style] ?? tr('lootfilter_advanced_views_StartView_2.neversink_default')}${following ? ` · ${tr('h_lootB_Views.for_build', { name: build!.name })}` : ''}`}
              </span>
              <span className="adv-v-muted">{tr('lootfilter_advanced_views_StartView.nothing_is_written_to_the')}</span>
            </span>
            <button type="button" className="btn gold lg" style={{ height: 44, padding: '0 22px', fontSize: 14.5, gap: 10 }} disabled={busy || lf.baseLoading} onClick={() => void make()}>
              {busy && <span className="lf-spinner" />}
              {label}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function QuickSetup({ use, toggle, onBuild, noBuild }: { use: string[]; toggle: (id: string) => void; onBuild?: () => void; noBuild?: boolean }) {
  return (
    <>
      <Eyebrow>{noBuild ? tr('lootfilter_advanced_views_StartView.no_build_open_quick_setup') : tr('lootfilter_advanced_views_StartView.quick_setup')}</Eyebrow>
      <span style={{ color: 'var(--text-2)', lineHeight: 1.45 }}>{tr('lootfilter_advanced_views_StartView.pick_what_you_use_the')}</span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {GEAR_KINDS.map((g) => (
          <button key={g.id} type="button" className="adv-st-chip" aria-pressed={use.includes(g.id)} onClick={() => toggle(g.id)}>
            <Icon name={GEAR_ICON[g.id] ?? 'weapon'} size={14} style={{ opacity: 0.85 }} />
            {g.label}
          </button>
        ))}
      </div>
      {noBuild && <span className="adv-v-muted" style={{ lineHeight: 1.45 }}>{tr('lootfilter_advanced_views_StartView.open_a_build_in_the')}</span>}
      {onBuild && (
        <button type="button" className="btn ghost sm" style={{ color: 'var(--gold-text)' }} onClick={onBuild}>
          <Icon name="tree" size={14} />
          {tr('lootfilter_advanced_views_StartView.use_the_open_build_instead')}
        </button>
      )}
    </>
  );
}
