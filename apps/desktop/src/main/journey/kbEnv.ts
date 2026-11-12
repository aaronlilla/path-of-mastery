import type { LevelingData } from '../../shared/leveling/types.js';
import type { KbTable, KbTableName, KnowledgeBase } from '../../shared/journey/kb.js';
import { seedKnowledgeBase } from './kbSeed.js';

/** The seed KB, built when first asked. POM_KB_BEHIND=1 makes it report that the live game is ahead (the amber chip). */
export function kbSeedFromEnv(data: () => Promise<LevelingData>): KnowledgeBase {
  let kb: Promise<KnowledgeBase> | undefined;
  const get = (): Promise<KnowledgeBase> => (kb ??= data().then((d) => seedKnowledgeBase(d, { behind: process.env.POM_KB_BEHIND === '1' })));
  const subs = new Set<(n: KbTableName) => void>();
  return {
    async table<T>(name: KbTableName): Promise<KbTable<T>> {
      return (await get()).table<T>(name);
    },
    onChange(cb) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
  };
}
