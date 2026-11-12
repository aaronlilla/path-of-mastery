import type { CalcsViewOut, SkillGroup } from '@pom/protocol';
import { useEffect, useRef, useState } from 'react';

export interface SideData {
  view: CalcsViewOut | null;
  groups: SkillGroup[];
  loading: boolean;
}

/** The Calcs view and socket groups of one engine session, read again whenever `key` changes. Nothing runs while `on` is false. */
export function useSide(engineId: string | null | undefined, key: unknown, on: boolean): SideData {
  const [d, setD] = useState<SideData>({ view: null, groups: [], loading: false });
  const seq = useRef(0);
  useEffect(() => {
    if (!on || !engineId) {
      setD({ view: null, groups: [], loading: false });
      return;
    }
    const mine = ++seq.current;
    setD((x) => ({ ...x, loading: true }));
    void Promise.all([window.pom.sendCommand('calcsView', { buildId: engineId }), window.pom.sendCommand('skillsState', { buildId: engineId })]).then(([v, s]) => {
      if (mine !== seq.current) return;
      setD({ view: v.ok ? v.result : null, groups: s.ok ? s.result.state.groups : [], loading: false });
    });
  }, [engineId, key, on]);
  return d;
}
