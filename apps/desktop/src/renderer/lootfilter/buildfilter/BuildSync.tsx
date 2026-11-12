import { useBuildFilter } from '../useBuildFilter';

/** Keeps the Build Filter's rules in step with the open build and its settings while the Loot Filter area is open. */
export function BuildSync() {
  useBuildFilter({ autoSync: true });
  return null;
}
