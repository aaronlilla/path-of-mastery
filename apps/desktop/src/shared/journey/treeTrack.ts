/**
 * The live passive tree, kept from the game log alone. The log names a passive by its game data id
 * ("life1213") and its name ("Life"), not by the tree's node hash. Until the knowledge base serves the id-to-hash table
 * the tracker matches by name and picks the node that touches what is already allocated or what the plan wants next.
 */
import type { LogEvent } from './logEvent.js';

export interface TreeNodeInfo {
  id: number;
  name: string;
  /** Neighbouring node ids (both directions). */
  links: number[];
  /** Ascendancy name, when the node is an ascendancy node. */
  ascendancy?: string;
  /** Class starts and masteries are never allocated by a log line. */
  kind?: 'normal' | 'notable' | 'keystone' | 'mastery' | 'socket' | 'start';
}

export class PassiveResolver {
  private readonly byName = new Map<string, TreeNodeInfo[]>();
  private readonly byId = new Map<number, TreeNodeInfo>();
  /** Class starts count as taken: the character stands on one. */
  private readonly starts = new Set<number>();

  /** `logIds`: the KB passive-ids table (game data id to node hash), when it exists. */
  constructor(nodes: Iterable<TreeNodeInfo>, private readonly logIds: Map<string, number> | null = null) {
    for (const n of nodes) {
      this.byId.set(n.id, n);
      if (n.kind === 'start') this.starts.add(n.id);
      const key = n.name.toLowerCase();
      const l = this.byName.get(key);
      if (l) l.push(n);
      else this.byName.set(key, [n]);
    }
  }

  get size(): number {
    return this.byId.size;
  }
  node(id: number): TreeNodeInfo | undefined {
    return this.byId.get(id);
  }
  /** True when the exact id came from the KB table, not a name guess. */
  hasIdTable(): boolean {
    return !!this.logIds && this.logIds.size > 0;
  }

  private touching(n: TreeNodeInfo, allocated: ReadonlySet<number>): number {
    let c = 0;
    for (const o of n.links) if (allocated.has(o) || this.starts.has(o)) c++;
    return c;
  }

  /**
   * The node a log line means. `allocated` is what is taken now, `wanted` the nodes the plan will take next (they win
   * ties). Returns null when nothing in the tree has that name.
   */
  resolve(id: string, name: string, op: 'add' | 'remove', allocated: ReadonlySet<number>, wanted: ReadonlySet<number>): number | null {
    const exact = this.logIds?.get(id);
    if (exact !== undefined && this.byId.has(exact)) return exact;
    const cands = (this.byName.get(name.toLowerCase()) ?? []).filter((n) => n.kind !== 'start' && n.kind !== 'mastery');
    if (!cands.length) return null;
    if (op === 'remove') {
      const have = cands.filter((n) => allocated.has(n.id));
      if (!have.length) return null;
      // a refund takes the one that leaves the rest connected: prefer a leaf (touches one allocated neighbour)
      have.sort((a, b) => this.touching(a, allocated) - this.touching(b, allocated));
      return have[0]!.id;
    }
    const free = cands.filter((n) => !allocated.has(n.id));
    if (!free.length) return null;
    const score = (n: TreeNodeInfo): number => (this.touching(n, allocated) > 0 ? 2 : 0) + (wanted.has(n.id) ? 1 : 0) + (wanted.has(n.id) && this.touching(n, allocated) > 0 ? 1 : 0);
    free.sort((a, b) => score(b) - score(a) || a.id - b.id);
    return free[0]!.id;
  }
}


/** The allocated set, moved by passive lines. Atlas passives are ignored. */
export class TreeTracker {
  private set: Set<number>;
  /** Log lines the tracker could not place, for the "tracked from the log" note. */
  unplaced = 0;

  constructor(private readonly resolver: PassiveResolver, base: Iterable<number> = []) {
    this.set = new Set(base);
  }

  /** The authoritative tree from a sync replaces everything. */
  reset(base: Iterable<number>): void {
    this.set = new Set(base);
  }

  allocated(): ReadonlySet<number> {
    return this.set;
  }

  /** Applies one event. Returns true when the tree changed. */
  apply(e: LogEvent, wanted: ReadonlySet<number> = new Set()): boolean {
    if (e.t !== 'passive' || e.atlas) return false;
    const id = this.resolver.resolve(e.id, e.name, e.op, this.set, wanted);
    if (id === null) {
      this.unplaced++;
      return false;
    }
    if (e.op === 'add') {
      if (this.set.has(id)) return false;
      this.set.add(id);
    } else {
      if (!this.set.delete(id)) return false;
    }
    return true;
  }
}

export interface TreeDiff {
  /** Nodes of the checkpoint tree that are not allocated yet, in plan order. */
  toTake: number[];
  /** Allocated nodes that are not in the checkpoint tree and not a scheduled detour. */
  offPlan: number[];
  /** Points the character has but has not spent. */
  unspent: number;
}

/**
 * The tree to the next checkpoint. `plan` is that checkpoint's whole tree in plan order (ascendancy nodes included),
 * `detours` the nodes the plan will refund later (they are fine to hold), `pointsEarned` the level-ups plus quest points.
 */
export function treeDiff(live: ReadonlySet<number>, plan: readonly number[], detours: readonly number[], pointsEarned: number | null, ignore?: (id: number) => boolean): TreeDiff {
  const inPlan = new Set(plan);
  const keep = new Set(detours);
  const toTake = plan.filter((n) => !live.has(n));
  const offPlan = [...live].filter((n) => !inPlan.has(n) && !keep.has(n) && !(ignore?.(n) ?? false));
  const spent = [...live].filter((n) => !(ignore?.(n) ?? false)).length;
  return { toTake, offPlan, unspent: pointsEarned === null ? 0 : Math.max(0, pointsEarned - spent) };
}
