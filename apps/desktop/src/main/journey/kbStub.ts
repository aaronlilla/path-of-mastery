// A stand-in for the knowledge base until the real one merges (DESIGN.md 9). It serves the bundled leveling files
// (resources/leveling/<league>/) behind the KnowledgeBase interface with a fixed patch. Every Journey file depends only on
// the interface, so the swap is one line. Tables the bundled files do not have throw KbMissing.
import type { LevelingData } from '../../shared/leveling/types.js';
import { KbMissing, type KbTable, type KbTableName, type KnowledgeBase, type ResistPenaltyRow } from '../../shared/journey/kb.js';
import { loadLevelingData } from '../leveling/data.js';

export interface KbStubOptions {
  /** The patch the rows are labelled with. */
  patch?: string;
  /** The live patch; null means offline. */
  livePatch?: string | null;
  /** Mark every table as older than the live game. */
  behind?: boolean;
  /** Extra tables (tests). */
  extra?: Partial<Record<KbTableName, unknown>>;
}

/** The penalty rows the app already applied when it imported a character (main/character/convert.ts resistancePenaltyFor): past Act 5 -30, past Act 10 -60. */
export const STUB_RESIST_PENALTIES: ResistPenaltyRow[] = [
  { fromAct: 6, penalty: -30, source: 'app code resistancePenaltyFor (stub, not checked against the live patch)' },
  { fromAct: 11, penalty: -60, source: 'app code resistancePenaltyFor (stub, not checked against the live patch)' },
];

export function createKbStub(resourcesDir: string, league = '3.29', opts: KbStubOptions = {}): KnowledgeBase {
  let loaded: Promise<LevelingData> | undefined;
  const data = (): Promise<LevelingData> => (loaded ??= loadLevelingData(resourcesDir, league).then((r) => r.data));
  const patch = opts.patch ?? league;
  const livePatch = opts.livePatch === undefined ? patch : opts.livePatch;
  const listeners = new Set<(n: KbTableName) => void>();
  const wrap = <T>(d: T): KbTable<T> => ({ patch, livePatch, checkedAt: 0, behind: opts.behind ?? false, data: d });
  return {
    async table<T>(name: KbTableName): Promise<KbTable<T>> {
      if (opts.extra && name in opts.extra) return wrap(opts.extra[name] as T);
      const d = await data();
      switch (name) {
        case 'zones':
          return wrap(d.zones as T);
        case 'quest-extras':
          return wrap({ quests: d.questExtras, questZones: d.questZones } as T);
        case 'gem-offers':
          return wrap({ offers: d.offers, gems: d.gems, starts: d.starts } as T);
        case 'leveling-skills':
          return wrap(d.skills as T);
        case 'routes':
          return wrap(d.routes as T);
        case 'resist-penalties':
          return wrap(STUB_RESIST_PENALTIES as T);
        default:
          throw new KbMissing(name);
      }
    },
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

/** What the guide generator reads, rebuilt from KB tables, plus the patch of every table it used. */
export async function levelingDataFromKb(kb: KnowledgeBase, league: string): Promise<{ data: LevelingData; dataPatch: Partial<Record<KbTableName, string>> }> {
  const [zones, extras, offers, skills, routes] = await Promise.all([
    kb.table<LevelingData['zones']>('zones'),
    kb.table<{ quests: LevelingData['questExtras']; questZones: LevelingData['questZones'] }>('quest-extras'),
    kb.table<{ offers: LevelingData['offers']; gems: LevelingData['gems']; starts: LevelingData['starts'] }>('gem-offers'),
    kb.table<LevelingData['skills']>('leveling-skills'),
    kb.table<LevelingData['routes']>('routes'),
  ]);
  const data: LevelingData = {
    league,
    offers: offers.data.offers,
    gems: offers.data.gems,
    zones: zones.data,
    skills: skills.data,
    questExtras: extras.data.quests,
    starts: offers.data.starts,
    routes: routes.data,
    questZones: extras.data.questZones,
  };
  return { data, dataPatch: { zones: zones.patch, 'quest-extras': extras.patch, 'gem-offers': offers.patch, 'leveling-skills': skills.patch, routes: routes.patch } };
}
