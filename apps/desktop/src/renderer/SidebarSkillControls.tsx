// The sidebar's main-skill controls: skill part, stages, active mines, minion (or minion item set), Manage Spectres and
// the minion skill, as upstream's side bar shows them under the main skill (Build.lua mainSkillPart ... mainSkillMinionSkill).
// They drive the MAIN skill's own choices (skillPart, skillStageCount, skillMineCount, skillMinion, skillMinionItemSet,
// skillMinionSkill), never the Calcs tab's copies.
import { useMemo, useState } from 'react';
import type { CalcSkillView } from '@pom/protocol';
import { activeGroupsOf, readFacts } from '../shared/buildFacts';
import { readSpectres, setSpectres, skillControls } from '../shared/calcsLogic';
import type { EngineHandle } from './engineHandle';
import { CalcSelect, NumField } from './calcs/CalcControls';
import { SpectreDialog } from './calcs/SpectreDialog';
import { minionOptions, useSpectreInfo, useSpectreNames } from './calcs/spectres';
import { tr } from './i18n';

export function SidebarSkillControls({ xml, engine, view, gem, mainGroup }: { xml: string; engine: EngineHandle | null; view: CalcSkillView | null; gem: number | null; mainGroup: number }) {
  const [spectreOpen, setSpectreOpen] = useState(false);
  const spectreNames = useSpectreNames();
  const spectreInfo = useSpectreInfo();
  const library = useMemo(() => readSpectres(xml), [xml]);
  const facts = useMemo(() => readFacts(xml), [xml]);
  const itemSets = facts.itemSets;
  // The minion the main gem has saved: the engine does not know the Spectre Library's entries, so the choice is read from the file.
  const savedMinion = useMemo(() => {
    const g = activeGroupsOf(facts)[mainGroup - 1];
    const el = gem !== null ? g?.gems[gem - 1]?.xml : undefined;
    return el ? /\sskillMinion="([^"]*)"/.exec(el)?.[1] : undefined;
  }, [facts, mainGroup, gem]);
  const ctl = skillControls(view);
  const set = (attr: string, value: string | number | null) => {
    if (engine && gem !== null) void engine.edit({ kind: 'setGem', group: mainGroup, gem, attr, value });
  };
  if (!view) return null;
  const minions = minionOptions(view, library, spectreNames);
  const minionValue = minions.find((m) => m.id === (view.spectre ? savedMinion : view.minion)) ?? (view.spectre ? undefined : minions.find((m) => m.id === savedMinion)) ?? minions[0];
  // A spectre's own skills (the engine lists those of its default minion for a Raise Spectre gem).
  const minionSkills = view.spectre && minionValue && spectreInfo[minionValue.id]?.skills.length ? spectreInfo[minionValue.id]!.skills : view.minionSkills;
  const minionSkill = Math.max(1, Math.min(view.minionSkill, minionSkills.length));
  const showAny = ctl.part || ctl.stages || ctl.mines || view.minionHasItemSet || (ctl.minion && (view.spectre || minions.length > 0)) || ctl.spectre || (ctl.minionSkill && minionSkills.length > 0);
  if (!showAny) return null;
  return (
    <div className="sb-ctls" data-testid="sidebar-skill-controls">
      {ctl.part && (
        <CalcSelect
          caption={tr('SidebarSkillControls.skill_part')}
          ariaLabel={tr('SidebarSkillControls.skill_part_2')}
          grow={1}
          basis={120}
          title={`${view.skillName}: ${view.parts[view.part - 1] ?? ''}`}
          value={String(view.part)}
          valueNode={<span className="gn">{view.parts[view.part - 1] ?? ''}</span>}
          options={view.parts.map((n, i) => ({ value: String(i + 1), node: <span className="gn">{n}</span> }))}
          onChange={(v) => set('skillPart', Number(v))}
        />
      )}
      {(ctl.stages || ctl.mines) && (
        <div className="sb-nums">
          {ctl.stages && <NumField caption={tr('SidebarSkillControls.stages')} label={tr('SidebarSkillControls.skill_stages')} value={view.stageCount ?? view.stageDefault} onCommit={(n) => set('skillStageCount', n)} />}
          {ctl.mines && <NumField caption={tr('SidebarSkillControls.active_mines')} label={tr('SidebarSkillControls.active_mines_2')} value={view.mineCount} placeholder="" onCommit={(n) => set('skillMineCount', n)} />}
        </div>
      )}
      {view.minionHasItemSet ? (
        <CalcSelect
          caption={tr('SidebarSkillControls.minion')}
          ariaLabel={tr('SidebarSkillControls.minion_item_set')}
          grow={1}
          basis={120}
          disabled={itemSets.length < 2}
          title={tr('SidebarSkillControls.the_item_set_the_minion')}
          value={String(view.minionItemSet ?? itemSets[0]?.id ?? 1)}
          valueNode={<span className="gn">{itemSets.find((s) => s.id === (view.minionItemSet ?? itemSets[0]?.id))?.title || tr('SidebarSkillControls.default_item_set')}</span>}
          options={itemSets.map((s) => ({ value: String(s.id), node: <span className="gn">{s.title || tr('SidebarSkillControls.default_item_set')}</span> }))}
          onChange={(v) => set('skillMinionItemSet', Number(v))}
        />
      ) : (
        ctl.minion &&
        (view.spectre || minions.length > 0) && (
          <CalcSelect
            caption={tr('SidebarSkillControls.minion')}
            ariaLabel={tr('SidebarSkillControls.minion_2')}
            grow={1}
            basis={120}
            disabled={minions.length < 2}
            title={minionValue?.label ?? tr('SidebarSkillControls.no_spectres_in_your_library')}
            value={minionValue?.id ?? ''}
            valueNode={<span className="gn">{minionValue?.label ?? tr('SidebarSkillControls.no_spectres_yet')}</span>}
            options={minions.map((m) => ({ value: m.id, node: <span className="gn">{m.label}</span> }))}
            onChange={(v) => set('skillMinion', v)}
            emptyOption={{ label: tr('SidebarSkillControls.no_spectres_in_your_library'), action: 'Manage Spectres' }}
          />
        )
      )}
      {ctl.spectre && (
        <button type="button" className="calc-btn sb-wide" title={tr('SidebarSkillControls.choose_the_spectres_your_raise')} onClick={() => setSpectreOpen(true)}>
          {tr('SidebarSkillControls.manage_spectres')}
        </button>
      )}
      {ctl.minionSkill && minionSkills.length > 0 && (
        <CalcSelect
          caption={tr('SidebarSkillControls.minion_skill')}
          ariaLabel={tr('SidebarSkillControls.minion_skill_2')}
          grow={1}
          basis={120}
          disabled={minionSkills.length < 2}
          title={minionSkills[minionSkill - 1] ?? ''}
          value={String(minionSkill)}
          valueNode={<span className="gn">{minionSkills[minionSkill - 1] ?? ''}</span>}
          options={minionSkills.map((n, i) => ({ value: String(i + 1), node: <span className="gn">{n}</span> }))}
          onChange={(v) => set('skillMinionSkill', Number(v))}
        />
      )}
      {spectreOpen && (
        <SpectreDialog
          current={library}
          onCancel={() => setSpectreOpen(false)}
          onSave={(ids) => {
            setSpectreOpen(false);
            if (engine) void engine.edit({ kind: 'setXml', xml: setSpectres(xml, ids) });
          }}
        />
      )}
    </div>
  );
}
