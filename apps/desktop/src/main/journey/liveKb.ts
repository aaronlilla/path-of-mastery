/**
 * The knowledge-base tables Live reads, as one synchronous view that refreshes when the KB changes. A missing table turns
 * off only the feature that needs it (DESIGN.md 0.4).
 */
import type { ZoneInfo } from '../../shared/leveling/types.js';
import { KbMissing, type KbTable, type KnowledgeBase, type ResistPenaltyRow, type XpPenaltyTable } from '../../shared/journey/kb.js';
import type { LiveKbView } from './live.js';

/** The engine's default maximum resistance. Live prefers the cap the engine reports for the character when it has one. */
const DEFAULT_RESIST_CAP = 75;

async function tryTable<T>(kb: KnowledgeBase, name: Parameters<KnowledgeBase['table']>[0]): Promise<KbTable<T> | null> {
  try {
    return await kb.table<T>(name);
  } catch (e) {
    if (e instanceof KbMissing) return null;
    return null;
  }
}

export async function loadLiveKb(kb: KnowledgeBase): Promise<LiveKbView | null> {
  const zonesT = await tryTable<ZoneInfo[] | { route: ZoneInfo[] }>(kb, 'zones');
  if (!zonesT) return null;
  const zones = Array.isArray(zonesT.data) ? zonesT.data : zonesT.data.route;
  const pen = await tryTable<ResistPenaltyRow[]>(kb, 'resist-penalties');
  const xp = await tryTable<XpPenaltyTable>(kb, 'xp-penalty');
  const behind = zonesT.behind || !!pen?.behind || !!xp?.behind;
  const penalties = pen ? [...pen.data].sort((a, b) => a.fromAct - b.fromAct) : null;
  return {
    zones,
    penaltyAtAct: (act) => {
      if (!penalties) return null;
      let p = 0;
      for (const r of penalties) if (act >= r.fromAct) p = r.penalty;
      return p;
    },
    xpSafe: (level) => {
      const r = xp?.data.safeRange.find((x) => level >= x.fromLevel && level <= x.toLevel);
      return r ? { below: r.below, above: r.above } : null;
    },
    resistCap: DEFAULT_RESIST_CAP,
    dataPatch: { patch: zonesT.patch, behind, livePatch: zonesT.livePatch },
  };
}
