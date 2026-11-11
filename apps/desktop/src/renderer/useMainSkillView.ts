// The main skill's control state (skill part, stages, mines, minion, minion skill) for the sidebar. The engine describes
// only the Calcs tab's skill, so this asks it about a throwaway session of the build text in which the Calcs tab's skill
// is the main skill (see shared/mainSkillProbe). It runs again only when the main skill's own choices change.
import { useEffect, useMemo, useState } from 'react';
import type { CalcSkillView } from '@pom/protocol';
import { activeGroupsOf, readFacts } from '../shared/buildFacts';
import { mainSkillProbeKey, mainSkillProbeXml } from '../shared/mainSkillProbe';
import { engineSend } from './engineBuild';

export interface MainSkillView {
  /** Null while the first answer is on its way, or when the engine has no skill to describe. */
  view: CalcSkillView | null;
  /** The main skill's gem in its socket group (1-based, what `setGem` takes). */
  gem: number | null;
  loading: boolean;
}

export function useMainSkillView(xml: string, buildId: string | null, mainGroup: number, mainActive: number, ready: boolean): MainSkillView {
  const key = useMemo(() => {
    if (!ready) return '';
    try {
      const g = activeGroupsOf(readFacts(xml))[mainGroup - 1];
      return mainSkillProbeKey(xml, mainGroup, mainActive, g?.xml);
    } catch {
      return '';
    }
  }, [xml, mainGroup, mainActive, ready]);
  const [state, setState] = useState<{ key: string; view: CalcSkillView | null; gem: number | null } | null>(null);
  useEffect(() => {
    if (!key) return;
    let live = true;
    const t = window.setTimeout(() => {
      void (async () => {
        let id: string | null = null;
        try {
          const l = await engineSend('loadBuild', { buildXml: mainSkillProbeXml(xml, mainGroup) });
          id = l.buildId;
          const v = await engineSend('calcsView', { buildId: id });
          const sk = buildId ? await engineSend('skillsState', { buildId }).catch(() => null) : null;
          const gem = sk?.state.groups[mainGroup - 1]?.activeSkills.find((a) => a.index === mainActive)?.gem ?? null;
          if (live) setState({ key, view: v.view, gem });
        } catch {
          if (live) setState({ key, view: null, gem: null });
        } finally {
          if (id) void window.pom.sendCommand('closeBuild', { buildId: id });
        }
      })();
    }, 150);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
    // The text only matters through `key`: the probe is not repeated for edits that leave the main skill alone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  // While a new answer is on its way (or the engine is loading a new build) the last one stays on screen, so the controls do not flicker.
  return { view: state?.view ?? null, gem: state?.gem ?? null, loading: !!key && (!state || state.key !== key) };
}
