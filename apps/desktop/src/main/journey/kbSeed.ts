/**
 * A KnowledgeBase over the bundled leveling files, for the app until the real KB service lands (DESIGN.md section 9). It
 * serves the tables Live reads. Every Journey file depends on the `KnowledgeBase` interface only, so swapping this for the
 * real one is one line in main/index.ts.
 */
import type { LevelingData } from '../../shared/leveling/types.js';
import { KbMissing, type KbTable, type KbTableName, type KnowledgeBase, type ResistPenaltyRow, type XpPenaltyTable } from '../../shared/journey/kb.js';

export interface SeedOptions {
  patch?: string;
  /** Pretend the live game is ahead of the rows (the amber chip). */
  behind?: boolean;
  livePatch?: string | null;
  now?: () => number;
}

/** From main/character/convert.ts `resistancePenaltyFor`: -30 once past Act 5, -60 in the endgame. */
const PENALTIES: ResistPenaltyRow[] = [
  { fromAct: 1, penalty: 0, source: 'seed: main/character/convert.ts resistancePenaltyFor' },
  { fromAct: 6, penalty: -30, source: 'seed: main/character/convert.ts resistancePenaltyFor' },
  { fromAct: 11, penalty: -60, source: 'seed: main/character/convert.ts resistancePenaltyFor' },
];

/** From shared/experience.ts: the free range is 3 + floor(level / 16) levels either way. */
function xpTable(): XpPenaltyTable {
  const safeRange = [];
  for (let level = 1; level <= 100; level++) {
    const safe = 3 + Math.floor(level / 16);
    safeRange.push({ fromLevel: level, toLevel: level, below: safe, above: safe });
  }
  return { safeRange, source: 'seed: shared/experience.ts safeZone' };
}

export function seedKnowledgeBase(data: LevelingData, o: SeedOptions = {}): KnowledgeBase {
  const patch = o.patch ?? data.league;
  const behind = !!o.behind;
  const now = o.now ?? Date.now;
  const table = <T>(rows: T): KbTable<T> => ({ patch, livePatch: o.livePatch ?? (behind ? bump(patch) : null), checkedAt: now(), behind, data: rows });
  const subs = new Set<(n: KbTableName) => void>();
  return {
    async table<T>(name: KbTableName): Promise<KbTable<T>> {
      switch (name) {
        case 'zones':
          return table(data.zones) as KbTable<T>;
        case 'quest-extras':
          return table(data.questExtras) as KbTable<T>;
        case 'resist-penalties':
          return table(PENALTIES) as KbTable<T>;
        case 'xp-penalty':
          return table(xpTable()) as KbTable<T>;
        default:
          throw new KbMissing(name);
      }
    },
    onChange(cb) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
  };
}

function bump(patch: string): string {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(patch);
  if (!m) return patch;
  return `${m[1]}.${m[2]}.${(+(m[3] ?? 0)) + 1}`;
}
