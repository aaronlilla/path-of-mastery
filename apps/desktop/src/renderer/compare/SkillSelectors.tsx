import type { BuildEdit } from '@pom/protocol';
import { useState } from 'react';
import { activeGroupsOf, type BuildFacts } from '../../shared/buildFacts.js';
import { readCalcsInputs, setCalcsInput, skillControls, type CalcsInputValue } from '../../shared/calcsLogic.js';
import { SwitchRow, CapSelect } from '../tabKit';
import type { SideData } from './useSide';
import { label as lbl, tr } from '../i18n';

export const CALC_MODES: { value: string; label: string }[] = [
  { value: 'UNBUFFED', label: tr('compare_SkillSelectors.unbuffed') },
  { value: 'BUFFED', label: tr('compare_SkillSelectors.buffed') },
  { value: 'COMBAT', label: tr('compare_SkillSelectors.in_combat') },
  { value: 'EFFECTIVE', label: tr('compare_SkillSelectors.effective_dps') },
];

function NumField({ caption, value, onCommit }: { caption: string; value: number | null; onCommit: (n: number | null) => void }) {
  const shown = value === null ? '' : String(value);
  const [draft, setDraft] = useState<string | null>(null);
  const done = () => {
    const d = draft;
    setDraft(null);
    if (d === null || d === shown) return;
    onCommit(d.trim() === '' ? null : Math.max(0, Math.floor(Number(d))));
  };
  return (
    <label className="cmp-num" title={caption}>
      <span className="k">{caption}</span>
      <input value={draft ?? shown} inputMode="numeric" aria-label={caption} onChange={(e) => setDraft(e.target.value.replace(/\D/g, '').slice(0, 5))} onBlur={done} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
    </label>
  );
}

interface Props {
  /** Which build: shown in the control labels. */
  tag: string;
  side: SideData;
  xml: string;
  facts: BuildFacts;
  /** 'main' changes the build's main skill (and the Calcs skill with it); 'calcs' changes only the Calcs skill. */
  mode: 'main' | 'calcs';
  apply: (e: BuildEdit) => Promise<unknown>;
  applyXml: (fn: (xml: string) => string) => Promise<unknown>;
  /** Also the calculation mode and the minion switch (the Calcs sub-view). */
  withMode?: boolean;
}

/** The socket group, active skill, part, stages, mines and minion controls of one build. */
export function SkillSelectors({ tag, side, xml, facts, mode, apply, applyXml, withMode }: Props) {
  const inputs = readCalcsInputs(xml);
  const groups = side.groups;
  const groupNo = Math.max(1, Math.min(mode === 'main' ? facts.mainSocketGroup : inputs.skillNumber, Math.max(1, groups.length)));
  const group = groups[groupNo - 1];
  const fact = activeGroupsOf(facts)[groupNo - 1];
  const calcsActive = (() => {
    if (mode === 'main') return group?.mainActiveSkill ?? 1;
    const m = fact ? /mainActiveSkillCalcs="(\d+)"/.exec(fact.xml.slice(0, fact.xml.indexOf('>') + 1)) : null;
    return Math.max(1, Math.min(m ? Number(m[1]) : 1, Math.max(1, group?.activeSkills.length ?? 1)));
  })();
  const active = group?.activeSkills[calcsActive - 1];
  const view = side.view?.view ?? null;
  const ctl = skillControls(view);
  const suffix = (attr: string) => (mode === 'main' ? [attr, attr + 'Calcs'] : [attr + 'Calcs']);
  const setGem = async (attr: string, value: string | number | null) => {
    if (!active) return;
    for (const a of suffix(attr)) await apply({ kind: 'setGem', group: groupNo, gem: active.gem, attr: a, value });
  };
  const input = (name: string, value: CalcsInputValue) => applyXml((x) => setCalcsInput(x, name, value));
  const gname = (g: (typeof groups)[number]) => g.label.trim() || g.displayLabel || tr('compare_SkillSelectors.group_index', { index: g.index });
  const dis = !groups.length;
  return (
    <>
      <CapSelect
        caption={tr('compare_SkillSelectors.tag_socket_group', { tag })}
        ariaLabel={tr('compare_SkillSelectors.tag_socket_group_2', { tag })}
        valueLabel={group ? gname(group) : tr('compare_SkillSelectors.none')}
        value={String(groupNo)}
        width={210}
        size="short"
        disabled={dis}
        options={groups.map((g) => ({ value: String(g.index), label: gname(g), sub: `${g.slot && g.slot !== 'None' ? lbl(g.slot) : tr('h_c_Gem.no_slot')} · ${tr(g.gems.length === 1 ? 'h_c_Gem.gem_one' : 'h_c_Gem.gem_other', { n: g.gems.length })}` }))}
        onChange={(v) => {
          const n = Number(v);
          void (async () => {
            if (mode === 'main') await apply({ kind: 'setMainGroup', group: n });
            await input('skill_number', { number: n });
          })();
        }}
      />
      <CapSelect
        caption={tr('compare_SkillSelectors.tag_active_skill', { tag })}
        ariaLabel={tr('compare_SkillSelectors.tag_active_skill_2', { tag })}
        valueLabel={active?.name ?? tr('compare_SkillSelectors.none')}
        value={String(calcsActive)}
        width={170}
        size="short"
        disabled={!group || group.activeSkills.length < 2}
        options={(group?.activeSkills ?? []).map((s) => ({ value: String(s.index), label: s.name }))}
        onChange={(v) =>
          void (async () => {
            if (mode === 'main') await apply({ kind: 'setMainActiveSkill', group: groupNo, skill: Number(v) });
            await apply({ kind: 'setGroup', group: groupNo, attr: 'mainActiveSkillCalcs', value: Number(v) });
          })()
        }
      />
      {ctl.part && view && (
        <CapSelect caption={tr('compare_SkillSelectors.tag_skill_part', { tag })} ariaLabel={tr('compare_SkillSelectors.tag_skill_part_2', { tag })} valueLabel={view.parts[view.part - 1] ?? ''} value={String(view.part)} width={150} size="short" options={view.parts.map((n, i) => ({ value: String(i + 1), label: n }))} onChange={(v) => void setGem('skillPart', Number(v))} />
      )}
      {ctl.stages && view && <NumField caption={tr('compare_SkillSelectors.tag_stages', { tag })} value={view.stageCount ?? view.stageDefault} onCommit={(n) => void setGem('skillStageCount', n)} />}
      {ctl.mines && view && <NumField caption={tr('compare_SkillSelectors.tag_mines', { tag })} value={view.mineCount} onCommit={(n) => void setGem('skillMineCount', n)} />}
      {ctl.minion && view && view.minions.length > 0 && (
        <CapSelect caption={tr('compare_SkillSelectors.tag_minion', { tag })} ariaLabel={tr('compare_SkillSelectors.tag_minion_2', { tag })} valueLabel={view.minions.find((m) => m.id === view.minion)?.label ?? ''} value={view.minion ?? ''} width={160} size="short" options={view.minions.map((m) => ({ value: m.id, label: m.label }))} onChange={(v) => void setGem('skillMinion', v)} />
      )}
      {ctl.minionSkill && view && (
        <CapSelect caption={tr('compare_SkillSelectors.tag_minion_skill', { tag })} ariaLabel={tr('compare_SkillSelectors.tag_minion_skill_2', { tag })} valueLabel={view.minionSkills[view.minionSkill - 1] ?? ''} value={String(view.minionSkill)} width={160} size="short" options={view.minionSkills.map((n, i) => ({ value: String(i + 1), label: n }))} onChange={(v) => void setGem('skillMinionSkill', Number(v))} />
      )}
      {withMode && (
        <div className="cmp-moderow">
          <CapSelect caption={tr('compare_SkillSelectors.tag_calc_mode', { tag })} ariaLabel={tr('compare_SkillSelectors.tag_calculation_mode', { tag })} valueLabel={CALC_MODES.find((m) => m.value === inputs.buffMode)?.label ?? inputs.buffMode} value={inputs.buffMode} width={150} size="short" options={CALC_MODES} onChange={(v) => void input('misc_buffMode', { string: v })} />
          {ctl.showMinion && <SwitchRow checked={!!view?.showMinion} onChange={(v) => void input('showMinion', { boolean: v })} label={tr('compare_SkillSelectors.show_minion_stats')} title={tr('compare_SkillSelectors.show_minion_stats_for_build', { tag })} />}
        </div>
      )}
    </>
  );
}
