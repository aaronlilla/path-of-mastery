import { useState } from 'react';
import type { Rule } from '../../../../shared/lootfilter/types.js';
import { LabelChip, groundFor } from '../../LabelChip';
import { useLf } from '../../lfStore';
import { currentLook, customNames } from '../shell/edits';
import { useAdvShell } from '../shell/selection';
import { Frame } from './TierList';
import { tr } from '../../../i18n';
import { lfBuild } from '../../mainText';

/** The three groups the rules made from the open build fall into, named as in the design. */
const GROUPS: { id: string; name: string; has: (id: string) => boolean }[] = [
  { id: 'up', name: tr('lootfilter_advanced_customize_BuildTiers_2.s_tier_upgrades_for_you'), has: (id) => id.startsWith('build:up:') || id.startsWith('build:res:') },
  { id: 'base', name: tr('lootfilter_advanced_customize_BuildTiers_2.a_tier_bases_you_use'), has: (id) => id.startsWith('build:base:') || id.startsWith('build:use:') },
  { id: 'gem', name: tr('lootfilter_advanced_customize_BuildTiers_2.b_tier_gems_and_links'), has: (id) => id.startsWith('build:gem:') },
];

export function groupOfBuildRule(r: Rule): string {
  return GROUPS.find((g) => g.has(r.id))?.id ?? 'base';
}

/** "Your build": the rules made from the open build, as tiers of chips. Each rule says why it is here. */
export function BuildTiers() {
  const lf = useLf();
  const sh = useAdvShell();
  const [coll, setColl] = useState<Record<string, boolean>>({});
  const bright = sh.ground === 'bright';
  const rules = lf.doc.rules.filter((r) => r.source === 'build').sort((a, b) => a.priority - b.priority);
  if (!rules.length)
    return (
      <div style={{ padding: '28px 12px', color: 'var(--text-muted)', textAlign: 'center', lineHeight: 1.5 }}>
        {lf.build ? tr('lootfilter_advanced_customize_BuildTiers.no_rules_came_from_your') : tr('lootfilter_advanced_customize_BuildTiers.no_build_is_open_open')}
      </div>
    );
  return (
    <>
      {GROUPS.map((g) => {
        const rs = rules.filter((r) => groupOfBuildRule(r) === g.id);
        if (!rs.length) return null;
        const off = rs.every((r) => !r.enabled);
        const open = !coll[g.id];
        const look = currentLook(lf, { kind: 'rule', rule: rs[0]! });
        return (
          <Frame
            key={g.id}
            id={`adv-cz-tier-build-${g.id}`}
            open={open}
            onToggle={() => setColl((c) => ({ ...c, [g.id]: open }))}
            off={off}
            onSwitch={() => {
              const ids = new Set(rs.map((r) => r.id));
              lf.setRules(off ? tr('lootfilter_advanced_customize_BuildTiers.switched_on_name', { name: g.name }) : tr('lootfilter_advanced_customize_BuildTiers.switched_off_name', { name: g.name }), (all) => all.map((r) => (ids.has(r.id) ? { ...r, enabled: off } : r)));
            }}
            name={g.name}
            nameTitle={tr('lootfilter_advanced_customize_BuildTiers.made_from_your_build')}
            count={tr('lootfilter_advanced_customize_BuildTiers.count_items', { count: rs.length })}
            look={look}
            selected={false}
            onSelect={() => {
              sh.select({ kind: 'rule', id: rs[0]!.id });
              sh.openInspector();
            }}
            onLook={() => {
              sh.select({ kind: 'rule', id: rs[0]!.id });
              sh.openInspector('style');
            }}
            actions={null}
          >
            <div className="adv-cz-tground" style={{ background: groundFor(bright ? 'bright' : 'desert') }}>
              {rs.map((r) => {
                const name = customNames(r)[0] ?? lfBuild(r.name ?? tr('lootfilter_advanced_customize_BuildTiers_2.rule'));
                const sel = sh.selected?.kind === 'rule' && sh.selected.id === r.id;
                return (
                  <LabelChip
                    key={r.id}
                    name={name}
                    style={currentLook(lf, { kind: 'rule', rule: r })}
                    bright={bright}
                    selected={sel}
                    hidden={!r.enabled}
                    hiddenLook="fade"
                    title={`${name}${r.why ? '. ' + lfBuild(r.why) : ''}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      sh.select({ kind: 'rule', id: r.id });
                      sh.openInspector();
                    }}
                  />
                );
              })}
            </div>
          </Frame>
        );
      })}
    </>
  );
}
