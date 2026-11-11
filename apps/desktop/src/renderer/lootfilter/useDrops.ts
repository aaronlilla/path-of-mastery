import { useEffect, useState } from 'react';
import type { DropSession } from '../../shared/lootfilter/drops.js';

type View = { sessions?: DropSession[] };
type Wealth = { get(): Promise<View>; onChange?(cb: (v: View) => void): () => void };

/** The loot the player's Wealth sessions recorded, read only. null until the first read; empty when Wealth has none. */
export function useDrops(): DropSession[] | null {
  const [drops, setDrops] = useState<DropSession[] | null>(null);
  useEffect(() => {
    let live = true;
    const w = (window as unknown as { pom?: { wealth?: Wealth } }).pom?.wealth;
    if (!w) {
      setDrops([]);
      return;
    }
    w.get().then((v) => live && setDrops(v.sessions ?? [])).catch(() => live && setDrops([]));
    // Sessions are recorded while the player plays and the first read can come before they are loaded: follow the changes.
    const off = w.onChange?.((v) => live && setDrops(v.sessions ?? []));
    return () => {
      live = false;
      off?.();
    };
  }, []);
  return drops;
}
