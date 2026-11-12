import { useEffect, useMemo, useRef, useState } from 'react';
import type { ItemProps } from '../../../shared/lootfilter/evaluate.js';
import { STRICTNESS } from '../../../shared/lootfilter/styles.js';
import { Icon, Switch } from '../../ui';
import { LabelChip } from '../LabelChip';
import { useLf } from '../lfStore';
import type { LfNav } from '../LootFilterArea';
import { useBuildFilter, useGameData } from '../useBuildFilter';
import { LevelingPicker } from './LevelingPicker';
import { LEVELING_GUIDE } from '../../../shared/leagueContent';
import { PreviewColumns } from './PreviewColumns';
import { StageStrip } from './StageStrip';
import { GROUPS } from './model';
import { Eyebrow } from '../advanced/sim/kit';
import { requestWrite, setBuildWriteGate } from './writeGate';
import './buildfilter.css';
import { tr } from '../../i18n';
import { lfBuild } from '../mainText';
import { strictName } from '../names';

const STEPS = [tr('lootfilter_buildfilter_Wizard_2.your_build'), tr('lootfilter_buildfilter_Wizard_2.stages'), tr('lootfilter_buildfilter_Wizard_2.preview')];

/** Test drops for the preview: the same few things at every stage, so the stages can be compared. */
function samples(bodyBase: string | undefined): { label: string; props: ItemProps }[] {
  const base = { rarity: 'Rare' as const, itemLevel: 80, corrupted: false, identified: true, mirrored: false, influences: [] as string[] };
  return [
    { label: tr('lootfilter_buildfilter_Wizard.rare_rusted_sword'), props: { ...base, name: 'Rusted Sword', class: 'One Hand Swords', linkedSockets: 2, sockets: 'RG' } },
    { label: tr('lootfilter_buildfilter_Wizard.n6_link_rusted_sword'), props: { ...base, name: 'Rusted Sword', class: 'One Hand Swords', linkedSockets: 6, sockets: 'RGBRGB' } },
    ...(bodyBase ? [{ label: tr('lootfilter_buildfilter_Wizard.rare_bodybase', { bodyBase }), props: { ...base, name: bodyBase, class: 'Body Armours', linkedSockets: 2, sockets: 'RG' } }] : []),
    { label: tr('lootfilter_buildfilter_Wizard.magic_boots_with_cheetah_s'), props: { ...base, rarity: 'Magic' as const, name: 'Wool Shoes', class: 'Boots', linkedSockets: 0, sockets: 'R', explicitMods: ["Cheetah's"] } },
    { label: tr('lootfilter_buildfilter_Wizard.divine_orb'), props: { ...base, rarity: 'Normal' as const, name: 'Divine Orb', class: 'Stackable Currency', stackSize: 1 } },
  ];
}

export function BuildFilterWizard({ nav }: { nav: LfNav }) {
  const lf = useLf();
  const bf = useBuildFilter();
  const game = useGameData();
  const [step, setStep] = useState(0);
  const [sel, setSel] = useState('');
  const [writeAfter, setWriteAfter] = useState(false);
  const build = bf.hasBuild ? lf.build : null;
  const stages = bf.built?.stages ?? [];
  const stage = stages.find((s) => s.id === sel) ?? stages.find((s) => s.id === 'S3') ?? stages[0];

  useEffect(() => {
    bf.wantPreview(step === 2);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // Write once the filter in the document is the draft. Every Write to game while the Preview shows (the header button,
  // Ctrl S, the palette, the button below) comes through this gate, so what is written is what the Preview shows.
  const synced = !!bf.built && JSON.stringify(lf.doc.setup.build) === JSON.stringify({ ...bf.draft, on: true }) && lf.doc.rules.filter((r) => r.source === 'build').length === bf.built.rules.length;
  const pendingWrite = useRef<(() => Promise<void>) | null>(null);
  useEffect(() => {
    if (!writeAfter || !synced || !lf.gen) return;
    setWriteAfter(false);
    const w = pendingWrite.current;
    pendingWrite.current = null;
    if (w) void w();
  }, [writeAfter, synced, lf.gen]); // eslint-disable-line react-hooks/exhaustive-deps

  const gateRef = useRef<(write: () => Promise<void>) => void>(() => undefined);
  gateRef.current = (write) => {
    if (!bf.built) {
      void write();
      return;
    }
    pendingWrite.current = write;
    if (!synced) bf.apply();
    setWriteAfter(true);
  };
  const previewing = step === 2 && !!bf.built;
  useEffect(() => {
    if (!previewing) return;
    setBuildWriteGate((w) => gateRef.current(w));
    return () => setBuildWriteGate(null);
  }, [previewing]);

  const groups = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of bf.built?.rules ?? []) if (r.build) m.set(r.build.group, (m.get(r.build.group) ?? 0) + 1);
    return m;
  }, [bf.built]);
  const reasonOf = (g: string): string => lfBuild(bf.built?.rules.find((r) => r.build?.group === g)?.build?.reason ?? '');

  const p = bf.built?.profile;
  const bodyBase = p?.armour['Body Armours']?.base;
  const lvl = bf.plan?.skills[0];

  if (!build) {
    return (
      <div className="adv-v-page" data-screen-label="Loot Filter / Build">
        <div className="adv-v-head">
          <span className="adv-v-title">{tr('lootfilter_buildfilter_Wizard.build_filter')}</span>
          <span className="adv-v-sub">{tr('lootfilter_buildfilter_Wizard.no_build_is_open')}</span>
        </div>
        <div className="lf-card adv-v-panel">
          <span style={{ color: 'var(--text-2)', lineHeight: 1.5 }}>{tr('lootfilter_buildfilter_Wizard.open_a_build_and_path')}</span>
          {nav.openBuildTab && (
            <button type="button" className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={nav.openBuildTab}>
              <Icon name="tree" size={14} />
              {tr('lootfilter_buildfilter_Wizard.open_the_build_tab')}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="adv-v-page bf" data-screen-label="Loot Filter / Build">
      <div className="bf-top">
        <div className="adv-v-head" style={{ flex: 1, minWidth: 0 }}>
          <span className="adv-v-title">{tr('lootfilter_buildfilter_Wizard.build_filter')}</span>
          <span className="adv-v-sub">{bf.active ? tr('lootfilter_buildfilter_Wizard.on_for_this_build') : tr('lootfilter_buildfilter_Wizard.not_made_yet')}</span>
        </div>
        <div className="bf-steps" role="tablist" aria-label={tr('lootfilter_buildfilter_Wizard.steps')}>
          {STEPS.map((s, i) => (
            <button key={s} type="button" role="tab" aria-selected={step === i} data-step={i + 1} title={i === 1 ? tr('lootfilter_buildfilter_Wizard.the_game_gives_a_filter') : undefined} onClick={() => setStep(i)}>
              <span className="bf-num">{i + 1}</span>
              {s}
            </button>
          ))}
        </div>
      </div>

      {!bf.ready && !bf.error && <div className="lf-card adv-v-panel"><span className="adv-v-muted">{tr('lootfilter_buildfilter_Wizard.reading_the_game_data')}</span></div>}
      {bf.error && <div className="lf-card adv-v-panel"><span style={{ color: 'var(--text-2)' }}>{tr('lootfilter_buildfilter_Wizard.the_engine_data_could_not', { error: bf.error })}</span></div>}

      {bf.ready && !bf.built && <div className="lf-card adv-v-panel"><span className="adv-v-muted">{tr('lootfilter_buildfilter_Wizard.this_build_could_not_be')}</span></div>}

      {bf.built && p && step === 0 && (
        <div className="adv-bl-grid" data-step-body="1">
          <div className="lf-card adv-v-panel">
            <span title={build.name} style={{ font: "600 20px/1.1 'Cormorant Garamond',serif", color: 'var(--text-display)', overflowWrap: 'anywhere', minWidth: 0 }}>{build.name}</span>
            <span className="adv-v-muted">{tr('lootfilter_buildfilter_Wizard.class_level', { class: p.ascendancy || p.className, level: p.level })}</span>
            <div style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0,1fr)', gap: '8px 14px' }}>
              {([[tr('lootfilter_buildfilter_Wizard_2.main_skill'), p.mainSkill?.name ?? tr('lootfilter_buildfilter_Wizard_2.none_found')], [tr('lootfilter_buildfilter_Wizard_2.weapons'), p.weaponClasses.length ? p.weaponClasses.join(', ') : tr('lootfilter_buildfilter_Wizard_2.none')]] as [string, string][]).map(([k, v]) => (
                <span key={k} style={{ display: 'contents' }}>
                  <span className="adv-v-muted">{k}</span>
                  <span style={{ color: 'var(--text-strong)', fontSize: 12.5, overflowWrap: 'anywhere' }}>{v}</span>
                </span>
              ))}
            </div>
            <div className="adv-v-row" style={{ paddingTop: 10, borderTop: '1px solid rgba(var(--line-rgb),.08)' }}>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ color: 'var(--text-strong)' }}>{tr('lootfilter_buildfilter_Wizard.how_you_play')}</span>
              </div>
              <div className="seg" role="group" aria-label={tr('lootfilter_buildfilter_Wizard.play_mode')} data-lg="tile">
                <button type="button" aria-pressed={bf.draft.mode === 'ssf'} title={tr('lootfilter_buildfilter_Wizard.self_found_you_craft_and')} onClick={() => bf.setDraft({ mode: 'ssf' })}>{tr('lootfilter_buildfilter_Wizard.ssf')}</button>
                <button type="button" aria-pressed={bf.draft.mode === 'trade'} title={tr('lootfilter_buildfilter_Wizard.trade_other_classes_rares_stay')} onClick={() => bf.setDraft({ mode: 'trade' })}>{tr('lootfilter_buildfilter_Wizard.trade')}</button>
              </div>
            </div>
          </div>
          <div className="lf-card adv-v-panel">
            <Eyebrow>{tr('lootfilter_buildfilter_Wizard.what_the_filter_will_do')}</Eyebrow>
            <div className="bf-groups">
              {GROUPS.filter((g) => groups.has(g.id)).map((g) => {
                const on = !bf.draft.disabled.includes(g.id);
                return (
                  <div key={g.id} className="bf-group" data-group={g.id} data-on={on}>
                    <div className="adv-v-row">
                      <span className="bf-group-name">{g.label}</span>
                      <span className="bf-n" title={tr('lootfilter_buildfilter_Wizard.rules_in_group', { count: groups.get(g.id) })} aria-label={tr('lootfilter_buildfilter_Wizard.rules_in_group', { count: groups.get(g.id) })}>{groups.get(g.id)}</span>
                      <span style={{ flex: 1 }} />
                      <Switch checked={on} label={g.label} onChange={() => bf.toggleGroup(g.id)} />
                    </div>
                    <span className="bf-why" title={reasonOf(g.id)}>{reasonOf(g.id) || g.blurb}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {bf.built && p && step === 1 && (
        <div className="lf-card adv-v-panel" data-step-body="2">
          <StageStrip stages={stages} selected={stage?.id ?? ''} onSelect={setSel} />
          <div className="adv-v-row" style={{ flexWrap: 'wrap', gap: 18 }}>
            {/* The leveling skill and the swap come from the leveling guide's data: switched off with it (shared/leagueContent.ts). */}
            {LEVELING_GUIDE && (
              <div className="bf-fact">
                <span className="adv-v-muted">{tr('lootfilter_buildfilter_Wizard.leveling_skill')}</span>
                <LevelingPicker candidates={bf.candidates} game={game} value={bf.draft.levelingSkill} current={bf.candidates[0]?.name ?? 'none'} onPick={bf.setLevelingSkill} />
                <span>{lvl ? tr('lootfilter_buildfilter_Wizard.name_until_area_to', { name: lvl.name, to: lvl.to }) : tr('lootfilter_buildfilter_Wizard.none')}</span>
                {!lvl && bf.planNote && <span className="adv-v-muted" style={{ fontSize: 12 }}>{bf.planNote}</span>}
              </div>
            )}
            {LEVELING_GUIDE && (
              <div className="bf-fact">
                <span className="adv-v-muted">{tr('lootfilter_buildfilter_Wizard.main_skill_ready')}</span>
                <span>{bf.plan?.swap ? tr('lootfilter_buildfilter_Wizard.area_arealevel_zone', { areaLevel: bf.plan.swap.areaLevel, zone: bf.plan.swap.zone ? `, ${bf.plan.swap.zone}` : '' }) : p.mainSkill ? tr('lootfilter_buildfilter_Wizard.from_the_start') : tr('lootfilter_buildfilter_Wizard.unknown')}</span>
              </div>
            )}
            <div className="bf-fact">
              <span className="adv-v-muted">{tr('lootfilter_buildfilter_Wizard.neversink_strictness')}</span>
              <select className="bf-select" aria-label={tr('lootfilter_buildfilter_Wizard.strictness')} value={lf.doc.setup.strictness} onChange={(e) => lf.edit(tr('lootfilter_buildfilter_Wizard.changed_strictness'), (d) => ({ ...d, setup: { ...d.setup, strictness: Number(e.target.value) } }))}>
                {STRICTNESS.map((s, i) => (
                  <option key={s.id} value={i}>{strictName(i)}</option>
                ))}
              </select>
              {lf.doc.setup.strictness > 2 && <span className="adv-v-muted" style={{ fontSize: 12 }}>{tr('lootfilter_buildfilter_Wizard.your_build_blocks_still_show', { name: STRICTNESS[lf.doc.setup.strictness]?.name })}</span>}
            </div>
            <div className="bf-fact">
              <span className="adv-v-muted">{tr('lootfilter_buildfilter_Wizard.safety_net')}</span>
              <Switch checked={bf.draft.safetyNet} label={tr('lootfilter_buildfilter_Wizard.safety_net')} onChange={(v) => bf.setDraft({ safetyNet: v })} />
            </div>
          </div>
        </div>
      )}

      {bf.built && p && stage && step === 2 && (
        <div className="lf-card adv-v-panel" data-step-body="3">
          <StageStrip stages={stages} selected={stage.id} onSelect={setSel} />
          <PreviewColumns built={bf.built} stage={stage} off={bf.draft.disabled} />
          <Eyebrow>{tr('lootfilter_buildfilter_Wizard.test_drops_at_area_lo', { lo: stage.lo })}</Eyebrow>
          <div className="bf-tests">
            {samples(bodyBase).map((s) => {
              const r = bf.evaluate(s.props, stage.lo);
              const rule = r?.decided?.ruleId ? bf.built!.rules.find((x) => x.id === r.decided!.ruleId) : undefined;
              return (
                <div key={s.label} className="bf-test" data-visible={r ? String(r.visible) : ''}>
                  <LabelChip name={s.label} style={r?.style ?? {}} fontPx={13} hidden={r ? !r.visible : false} hiddenLook="fade" />
                  <span className="bf-why">{r ? (r.visible ? tr('lootfilter_buildfilter_Wizard.shown') : tr('lootfilter_buildfilter_Wizard.hidden')) : '...'}{rule ? `: ${lfBuild(rule.build?.reason ?? '')}` : r?.decided ? tr('lootfilter_buildfilter_Wizard.neversink') : ''}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="bf-bar">
        {bf.active && (
          <button type="button" className="btn sm" onClick={bf.turnOff}>{tr('lootfilter_buildfilter_Wizard.turn_the_build_filter_off')}</button>
        )}
        <span style={{ flex: 1 }} />
        <button type="button" className="btn sm" disabled={step === 0} onClick={() => setStep(step - 1)}>{tr('lootfilter_buildfilter_Wizard.back')}</button>
        {step < 2 ? (
          <button type="button" className="btn sm" disabled={!bf.built} onClick={() => setStep(step + 1)}>{tr('lootfilter_buildfilter_Wizard.next')}</button>
        ) : (
          <button type="button" className="btn sm" disabled={!bf.built || lf.phase === 'writing'} onClick={requestWrite} title={tr('lootfilter_buildfilter_Wizard.same_as_write_to_game')}>
            <Icon name="check" size={14} />
            {lf.phase === 'writing' ? tr('lootfilter_buildfilter_Wizard.writing') : tr('lootfilter_buildfilter_Wizard.write_to_game')}
          </button>
        )}
      </div>
      {step === 2 && lf.outcome && lf.outcome.kind === 'written' && <span className="adv-v-muted" data-written="1">{tr('lootfilter_buildfilter_Wizard.written_to_path', { path: lf.outcome.path })}</span>}
    </div>
  );
}
