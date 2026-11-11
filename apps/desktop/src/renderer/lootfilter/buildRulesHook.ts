import { useEffect, useMemo, useState } from 'react';
import { mergeBuildRules, proposalsFor, proposalsForUse, proposalsFromStats, readBuildFacts, type BuildFacts, type BuildProposal, type ResistAffix } from '../../shared/lootfilter/buildRules.js';
import { useLf } from './lfStore';
import { tr } from '../i18n';

export interface BuildRules {
  hasBuild: boolean;
  facts: BuildFacts | null;
  proposals: BuildProposal[];
  /** Build-sourced rules already in the filter. */
  applied: number;
  /** Proposals not yet in the filter (new since the last apply). */
  fresh: number;
  /** True while the engine's numbers for the build are still being read. */
  readingStats: boolean;
  /** Writes the proposals into the filter as rules, keeping the player's on/off choices. */
  apply(): void;
  /** Removes every rule that came from the build. */
  clear(): void;
}

let affixCache: ResistAffix[] | null = null;

/** "Loot filter for this build": proposals from the open build's items and skills and from the engine's numbers for it, or from the gear kinds the player picked. */
export function useBuildRules(): BuildRules {
  const lf = useLf();
  const xml = lf.build?.xml ?? '';
  const facts = useMemo(() => (xml ? readBuildFacts(xml) : null), [xml]);
  const follow = lf.doc.setup.followBuild && !!facts;
  const engine = lf.build?.engine;
  const buildId = engine && engine.state === 'ready' ? engine.summary.buildId : null;
  const [stats, setStats] = useState<Record<string, number | string | boolean | null> | null>(null);
  const [affixes, setAffixes] = useState<ResistAffix[]>(affixCache ?? []);
  const [reading, setReading] = useState(false);

  useEffect(() => {
    if (affixCache) return;
    void window.pom.lootFilter.resistAffixes().then((r) => {
      if (r.ok) {
        affixCache = r.value;
        setAffixes(r.value);
      }
    });
  }, []);
  useEffect(() => {
    if (!buildId || !follow) {
      setStats(null);
      return;
    }
    let alive = true;
    setReading(true);
    void window.pom.sendCommand('getStats', { buildId }).then((r) => {
      if (!alive) return;
      setReading(false);
      if (r.ok) setStats(Object.fromEntries(r.result.stats.filter((s) => s.value === null || typeof s.value !== 'object').map((s) => [s.id, s.value as number | string | boolean | null])));
    });
    return () => {
      alive = false;
    };
  }, [buildId, follow, xml]);

  const stagedOn = !!lf.doc.setup.build?.on;
  const proposals = useMemo(() => {
    // The Build Filter writes the build rules itself; these older proposals would replace them.
    if (stagedOn) return [];
    if (follow && facts) return [...proposalsFor(facts, lf.catalog, -1000), ...(stats ? proposalsFromStats(stats, affixes, -900) : [])];
    if (!follow && lf.doc.setup.use.length) return proposalsForUse(lf.doc.setup.use, -1000);
    return [];
  }, [stagedOn, follow, facts, lf.catalog, lf.doc.setup.use, stats, affixes]);
  const have = new Set(lf.doc.rules.filter((r) => r.source === 'build').map((r) => r.id));
  const apply = (): void => {
    if (stagedOn) return;
    lf.edit(follow ? tr('lootfilter_buildRulesHook.added_rules_from_the_build') : tr('lootfilter_buildRulesHook.added_rules_for_the_gear'), (d) => ({
      ...d,
      rules: mergeBuildRules(d.rules, proposals),
      ...(follow && lf.build ? { buildId: lf.build.id, buildName: lf.build.name } : {}),
    }));
  };
  const clear = (): void => lf.edit(tr('lootfilter_buildRulesHook.removed_the_build_rules'), (d) => ({ ...d, rules: d.rules.filter((r) => r.source !== 'build') }));
  return { hasBuild: !!facts, facts, proposals, applied: have.size, fresh: proposals.filter((p) => !have.has(p.id)).length, readingStats: reading, apply, clear };
}
