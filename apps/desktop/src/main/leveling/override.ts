/**
 * The leveling skill override has one home: the filter's FilterDoc.setup.build.levelingSkill (a gemId). The Leveling tab, the
 * Build Filter and the assistant all read and write it there.
 */
import { DEFAULT_BUILD_SETUP } from '../../shared/lootfilter/types.js';
import type { LootFilterStore } from '../lootfilter/store.js';

export async function readLevelingOverride(store: LootFilterStore): Promise<string> {
  const st = await store.load();
  const doc = st.filters.find((f) => f.id === st.activeId) ?? st.filters[0];
  return doc?.setup.build?.levelingSkill ?? '';
}

/** Sets the override on the active filter; '' goes back to the computed skill. */
export async function writeLevelingOverride(store: LootFilterStore, gemId: string): Promise<void> {
  const st = await store.load();
  const filters = st.filters.map((f) => {
    if (f.id !== st.activeId) return f;
    const { levelingSkill: _old, ...rest } = f.setup.build ?? DEFAULT_BUILD_SETUP;
    void _old;
    return { ...f, editedAt: Date.now(), setup: { ...f.setup, build: { ...rest, ...(gemId ? { levelingSkill: gemId } : {}) } } };
  });
  await store.save({ ...st, filters });
}
