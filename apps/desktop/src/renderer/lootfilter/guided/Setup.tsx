import { strictnessCaption } from '../hidesText';
import { useDelayedFlag } from '../../delayedFlag.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { GUIDED_STRICTNESS, STYLES, applyStylePreset } from '../../../shared/lootfilter/styles.js';
import { GEAR_KINDS } from '../../../shared/lootfilter/bases.js';
import { mergeBuildRules, proposalsFor, proposalsForUse, proposalsFromStats, readBuildFacts } from '../../../shared/lootfilter/buildRules.js';
import { Icon } from '../../ui';
import { useSay } from './say';
import { classPortrait, classKey } from '../../art';
import { useLf } from '../lfStore';
import { LabelChip } from '../LabelChip';
import { artFor } from '../../gameArt';
import type { GuidedApi } from './Guided';
import type { LabelStyle } from '../../../shared/lootfilter/types.js';
import { tr } from '../../i18n';
import { guidedName, guidedBlurb, gearKindName, styleName, styleBlurb } from '../names';
import { plural } from '../advanced/views/plural';

const SAMPLE = ['Mirror of Kalandra', 'Divine Orb', 'Exalted Orb', 'Chaos Orb', 'Orb of Alchemy', 'Orb of Fusing', 'Chromatic Orb', 'Scroll of Wisdom', 'The Doctor', 'Rain of Chaos', 'Vaal Regalia', 'Thicket Bow', 'Sapphire Ring', 'Wool Shoes'];

/** The design's Setup samples draw the icon and beam beside the label and no sound; the colour swatches draw the label alone. */
const noSound = (st: LabelStyle): LabelStyle => {
  const { sound: _s, ...rest } = st;
  return rest;
};
const textOnly = (st: LabelStyle): LabelStyle => {
  const { sound: _s, icon: _i, beam: _b, ...rest } = st;
  return rest;
};

/** For the verification scripts only: the next "Build my filter" fails with this reason, so the error panel can be seen. */
type FailHook = { __pomLfFailNextBuild?: string };

export function Setup({ api, editing, cancel }: { api: GuidedApi; editing: boolean; cancel: () => void }) {
  const lf = useLf();
  const toast = useSay();
  const cur = lf.doc.setup;
  const [strict, setStrict] = useState(Math.min(4, cur.strictness));
  const [style, setStyle] = useState(cur.style);
  const [follow, setFollow] = useState(lf.build ? cur.followBuild : false);
  const [use, setUse] = useState<string[]>(cur.use);
  const [building, setBuilding] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const h1 = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    h1.current?.focus();
  }, []);
  const hasBuild = !!lf.build;
  const info = lf.build?.info;

  const cat = lf.catalog;
  const chips = useMemo(
    () =>
      SAMPLE.flatMap((n) => {
        const it = cat?.byName.get(n);
        if (!it) return [];
        const hidden = !!lf.hidden && ((lf.hidden.mask[n] ?? 0) & (1 << strict)) !== 0;
        const price = lf.prices?.byName[n]?.chaos ?? lf.prices?.uniqueByBase[n];
        return [{ n, hidden, style: applyStylePreset(it.style, style), price }];
      }),
    [cat, lf.hidden, lf.prices, strict, style],
  );
  const line = strictnessCaption(lf.hidden, strict);
  // "Counting item types…" is loading feedback: only when the counts take a while; until then the line keeps its space, unseen.
  const counting = useDelayedFlag(!line.ready, 200);
  // The button waits for the catalog and both counts (how many item types each level hides).
  const ready = !!cat && line.ready;
  const disabled = !!building || !ready;

  const save = async (): Promise<void> => {
    if (disabled) return;
    setFailed(null);
    try {
      const facts = follow && lf.build ? readBuildFacts(lf.build.xml) : null;
      // With the Build Filter on (or about to be made), it writes the build rules; these older proposals would replace them.
      const staged = !!lf.doc.setup.build?.on || (follow && !!lf.build);
      let props = staged ? [] : facts ? proposalsFor(facts, cat, -1000) : !follow ? proposalsForUse(use, -1000) : [];
      const eng = lf.build?.engine;
      if (!staged && facts && eng && eng.state === 'ready') {
        // Numbers from the engine for this build (resistances under the cap) add rules too.
        const [st, af] = await Promise.all([window.pom.sendCommand('getStats', { buildId: eng.summary.buildId }), window.pom.lootFilter.resistAffixes()]);
        if (st.ok && af.ok) props = [...props, ...proposalsFromStats(Object.fromEntries(st.result.stats.filter((x) => x.value === null || typeof x.value !== 'object').map((x) => [x.id, x.value as number | string | boolean | null])), af.value, -900)];
      }
      if (editing) {
        lf.edit(tr('lootfilter_guided_Setup.base_filter_name_name2_colours', { name: guidedName(strict), name2: styleName(style) }), (d) => ({ ...d, setup: { ...d.setup, strictness: strict, style, followBuild: follow, use }, rules: staged ? d.rules : mergeBuildRules(d.rules, props) }));
        toast({ text: tr('lootfilter_guided_Setup.base_filter_updated_name_name2', { name: guidedName(strict), name2: styleName(style) }), kind: 'ok', action: { label: tr('lootfilter_guided_Setup.undo'), run: () => lf.undo() } });
        cancel();
        api.scrollTop();
        return;
      }
      const steps = [facts ? tr('h_lootB_Guided.reading_name', { name: lf.build?.name ?? tr('lootfilter_guided_Setup_2.your_build') }) : tr('lootfilter_guided_Setup_2.reading_your_setup'), tr('lootfilter_guided_Setup.picking_tiers_from_prices'), tr(props.length === 1 ? 'h_lootB_Guided.adding_one' : 'h_lootB_Guided.adding_other', { n: props.length })];
      for (const s of steps) {
        setBuilding(s);
        await new Promise((r) => setTimeout(r, 450));
        const hook = window as unknown as FailHook;
        if (hook.__pomLfFailNextBuild) {
          const why = hook.__pomLfFailNextBuild;
          delete hook.__pomLfFailNextBuild;
          throw new Error(why);
        }
      }
      lf.edit(tr('lootfilter_guided_Setup.built_the_filter'), (d) => ({ ...d, setup: { ...(d.setup.build ? { build: d.setup.build } : {}), strictness: strict, style, followBuild: follow, use }, rules: staged ? d.rules : mergeBuildRules(d.rules, props), ...(facts && lf.build ? { buildId: lf.build.id, buildName: lf.build.name } : {}) }));
      api.setDone();
      setBuilding(null);
      toast({ text: props.length ? tr(props.length === 1 ? 'h_lootB_Guided.built_plus_one' : 'h_lootB_Guided.built_plus_other', { level: guidedName(strict), n: props.length, what: follow ? tr('h_lootB_Views.for_build', { name: lf.build?.name ?? tr('lootfilter_guided_Setup_2.your_build') }) : tr('lootfilter_guided_Setup_2.for_the_gear_you_use') }) : tr('h_lootB_Guided.built_plain', { level: guidedName(strict) }), kind: 'ok', action: { label: tr('lootfilter_guided_Setup.undo'), run: () => lf.undo() } });
      api.scrollTop();
      if (staged && follow && !lf.doc.setup.build?.on) api.nav.openAdvanced('build');
    } catch (e) {
      setBuilding(null);
      setFailed((e instanceof Error ? e.message : String(e)).replace(/\.$/, ''));
    }
  };

  // What changes when editing an existing filter.
  const impact = (): string => {
    const parts: string[] = [];
    if (lf.hidden) {
      const d = lf.hidden.hidden[strict]! - lf.hidden.hidden[Math.min(4, cur.strictness)]!;
      if (d > 0) parts.push(tr('lootfilter_guided_Setup.tolocalestring_more_item_types_will', { value: d.toLocaleString() }));
      if (d < 0) parts.push(tr('lootfilter_guided_Setup.tolocalestring_item_types_will_be', { value: (-d).toLocaleString() }));
    }
    if (style !== cur.style) parts.push(tr('h_lootB_Guided.colours_change', { name: styleName(style) }));
    if (follow !== cur.followBuild) parts.push(follow ? tr('lootfilter_guided_Setup_2.build_rules_are_added') : tr('lootfilter_guided_Setup_2.build_rules_are_removed'));
    const s = parts.join(', ');
    return (s ? s[0]!.toUpperCase() + s.slice(1) + '. ' : tr('h_lootB_Guided.nothing_yet') + ' ') + tr('lootfilter_guided_Setup_2.your_changes_stay_as_they_are');
  };

  const sum = `${GUIDED_STRICTNESS[strict]?.name} · ${STYLES[style]?.name} colours · ${follow && hasBuild ? `for ${lf.build!.name}` : use.length ? `highlights ${use.map((u) => GEAR_KINDS.find((g) => g.id === u)?.label.toLowerCase() ?? u).join(' and ')}` : tr('lootfilter_guided_Setup_2.no_build')}`;
  const ground = `url(${new URL('../../design/assets/ground-desert.webp', import.meta.url).href})`;

  return (
    <div className="gd-setup" data-screen-label={editing ? 'Setup / Change base' : 'Setup / First open'}>
      <div className="gd-setup-body">
        <div className="gd-col">
          <div>
            <h1 className="gd-h1" tabIndex={-1} ref={h1}>
              {editing ? tr('lootfilter_guided_Setup.change_your_base_filter') : tr('lootfilter_guided_Setup.set_up_your_loot_filter')}
            </h1>
            <p className="gd-sub">{editing ? tr('lootfilter_guided_Setup.these_settings_sit_under_your') : tr('lootfilter_guided_Setup.three_questions_you_can_change')}</p>
          </div>
          <div className="gd-setup-grid">
            <div className="gd-qs">
              <section className="gd-card gd-q" aria-label={tr('lootfilter_guided_Setup.make_it_for_this_build')}>
                <div>
                  <h3>{tr('lootfilter_guided_Setup.make_it_for_this_build')}</h3>
                  <div className="hint">{tr('lootfilter_guided_Setup.shows_the_gear_and_gems')}</div>
                </div>
                <div className="gd-q1row">
                  {hasBuild && info && (
                    <>
                      <img src={classPortrait(classKey(info))} alt="" />
                      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                        <span style={{ color: 'var(--text-strong)', fontWeight: 600 }}>{lf.build!.name}</span>
                        <span className="lf-muted" style={{ fontSize: 12.5 }}>{[info.ascendClassName || info.className, `Level ${info.level}`].filter(Boolean).join(' · ')}</span>
                      </div>
                    </>
                  )}
                  {!hasBuild && <span style={{ flex: 1, color: 'var(--text-muted)', fontSize: 13 }}>{tr('lootfilter_guided_Setup.no_build_is_open_open')}</span>}
                  <div className="gd-seg" role="radiogroup" aria-label={tr('lootfilter_guided_Setup.follow_my_build')}>
                    {(hasBuild ? ([[tr('lootfilter_guided_Setup_2.yes'), true], [tr('lootfilter_guided_Setup_2.no'), false]] as const) : ([[tr('lootfilter_guided_Setup_2.no'), false]] as const)).map(([l, v]) => (
                      <button key={l} role="radio" aria-checked={follow === v} onClick={() => setFollow(v)}>
                        {l}
                      </button>
                    ))}
                  </div>
                </div>
                {!follow && (
                  <div>
                    <div className="lf-faint" style={{ fontSize: 12, marginBottom: 6 }}>{tr('lootfilter_guided_Setup.what_do_you_use')}</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {GEAR_KINDS.map((k) => (
                        <button key={k.id} className="gd-chipbtn" aria-pressed={use.includes(k.id)} onClick={() => setUse(use.includes(k.id) ? use.filter((x) => x !== k.id) : [...use, k.id])}>
                          {k.art && <img src={`game/ui/${k.art}.png`} alt="" style={{ width: 16, height: 16, objectFit: 'contain' }} />}
                          {gearKindName(k.id, k.label)}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </section>
              <section className="gd-card gd-q" aria-label={tr('lootfilter_guided_Setup.how_much_do_you_want')}>
                <div>
                  <h3>{tr('lootfilter_guided_Setup.how_much_do_you_want')}</h3>
                  <div className="hint">
                    {tr('lootfilter_guided_Setup.stricter_hides_more_name_blurb', { name: guidedName(strict), blurb: guidedBlurb(strict) })}
                  </div>
                </div>
                <div role="radiogroup" aria-label={tr('lootfilter_guided_Setup.strictness')} className="gd-tiles5">
                  {GUIDED_STRICTNESS.map((s) => {
                    const c = strictnessCaption(lf.hidden, s.index);
                    return (
                      <button key={s.index} className="gd-tile" role="radio" aria-checked={strict === s.index} onClick={() => setStrict(s.index)} style={{ position: 'relative', paddingTop: 12 }}>
                        <span style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 3, borderRadius: '10px 10px 0 0', background: s.index <= strict ? 'rgba(var(--area-filter-rgb),.85)' : 'rgba(var(--line-rgb),.14)' }} />
                        <span style={{ color: 'var(--text-strong)', fontWeight: 500, whiteSpace: 'nowrap' }}>{guidedName(s.index)}</span>
                        {c.ready ? <span className="gd-hides">{c.text}</span> : <span className="gd-skel" aria-label={tr('lootfilter_guided_Setup.counting_item_types')} />}
                      </button>
                    );
                  })}
                </div>
              </section>
              <section className="gd-card gd-q" aria-label={tr('lootfilter_guided_Setup.colours')}>
                <div>
                  <h3>{tr('lootfilter_guided_Setup.colours')}</h3>
                  <div className="hint">{tr('lootfilter_guided_Setup.how_labels_look_on_the')}</div>
                </div>
                <div role="radiogroup" aria-label={tr('lootfilter_guided_Setup.colours')} className="gd-tiles4">
                  {STYLES.map((s, i) => (
                    <button key={s.id} className="gd-tile gd-coltile" role="radio" aria-checked={style === i} title={styleBlurb(i)} onClick={() => setStyle(i)}>
                      <span className="gd-ground" style={{ ['--gd-ground' as string]: ground }}>
                        {['Divine Orb', 'Chaos Orb'].map((n) => {
                          const it = cat?.byName.get(n);
                          return it ? <LabelChip key={n} name={n} style={textOnly(applyStylePreset(it.style, i))} scale={0.34} /> : null;
                        })}
                      </span>
                      <span className="nm">{styleName(i)}</span>
                    </button>
                  ))}
                </div>
              </section>
            </div>
            <aside className="gd-card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10, position: 'sticky', top: 0 }} aria-label={tr('lootfilter_guided_Setup.what_you_will_see')}>
              <div>
                <h3>{tr('lootfilter_guided_Setup.what_you_will_see')}</h3>
                <div className="hint">{tr('lootfilter_guided_Setup.a_sample_of_drops_with')}</div>
              </div>
              <div className="gd-ground" style={{ ['--gd-ground' as string]: ground, padding: 14, display: 'flex', flexWrap: 'wrap', gap: '10px 10px', minHeight: 180 }}>
                {!cat ? <span style={{ color: 'rgba(255,255,255,.7)' }}>{tr('lootfilter_guided_Setup.reading_neversink')}</span> : chips.map((c) => <LabelChip key={c.n} name={c.n} style={noSound(c.style)} hidden={c.hidden} hiddenLook="dashed" scale={0.5} title={`${c.n}${c.hidden ? ' (hidden)' : ''}`} />)}
              </div>
              <div aria-hidden={line.ready || counting ? undefined : true} style={{ color: 'var(--text-strong)', fontWeight: 600, fontSize: 14, fontVariantNumeric: 'tabular-nums', visibility: line.ready || counting ? undefined : 'hidden' }}>{!line.ready && counting ? tr('lootfilter_guided_Setup.counting_item_types_2') : `${line.text}.`}</div>
              <div className="lf-muted" style={{ fontSize: 12.5 }}>{tr('lootfilter_guided_Setup.struck_through_labels_are_hidden')}</div>
            </aside>
          </div>
        </div>
      </div>
      {failed && (
        <div className="gd-col" style={{ padding: '0 0 10px', animation: 'none' }}>
          <div className="gd-err" role="alert">
            <Icon name="error" size={18} style={{ color: 'var(--negative-text)', flex: 'none' }} />
            <span style={{ flex: 1, minWidth: 0 }}>
              <b>{tr('lootfilter_guided_Setup.your_filter_could_not_be')}</b> {failed}.
            </span>
            <button className="gd-secondary" onClick={() => void save()}>
              <Icon name="refresh" size={14} />
              {tr('lootfilter_guided_Setup.try_again')}
            </button>
          </div>
        </div>
      )}
      <div className="gd-setup-foot" role="group" aria-label={tr('lootfilter_guided_Setup.summary')}>
        <div className="sum">
          <b>{sum}</b>
          <span>{editing ? impact() : building ?? tr('lootfilter_guided_Setup.takes_a_few_seconds_nothing')}</span>
        </div>
        {editing && (
          <button className="gd-secondary" onClick={cancel}>
            {tr('lootfilter_guided_Setup.cancel')}
          </button>
        )}
        <button className="gd-primary" aria-disabled={disabled} title={!ready ? tr('lootfilter_guided_Setup.counting_item_types_2') : undefined} onClick={() => void save()}>
          {building && <span className="lf-spinner" />}
          {building ? tr('lootfilter_guided_Setup.building_your_filter') : editing ? tr('lootfilter_guided_Setup.save_base_filter') : tr('lootfilter_guided_Setup.build_my_filter')}
        </button>
      </div>
    </div>
  );
}

export { artFor, Icon };
