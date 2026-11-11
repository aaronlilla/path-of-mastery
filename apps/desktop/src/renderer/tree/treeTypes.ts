// The engine's per-build tree state. Same shape as `TreeState` in @pom/protocol (commands.ts); kept here so the
// tree module has no build-time dependency on the protocol package.

export interface TreeStateNode {
  id: number;
  kind?: string;
  name: string;
  stats: string[];
  group?: number | null;
  orbit?: number;
  orbitIndex?: number;
  linked?: number[];
  ascendancy?: string | null;
  socket?: boolean;
  conquered?: boolean;
  tattoo?: boolean;
  conqueredBy?: 'abyss' | 'timeless' | 'other' | null;
}

export interface TreeState {
  treeVersion: string;
  classId: number;
  ascendClassId: number;
  secondaryAscendClassId: number;
  /** Allocated node ids, in the order they were allocated. */
  allocated: number[];
  /** [mastery node, effect] pairs. */
  masteries: Array<[number, number]>;
  /** [socket node, item id] pairs. */
  jewels: Array<[number, number]>;
  generated: TreeStateNode[];
  changed: TreeStateNode[];
}

/** What the tree needs to know about a socketed jewel (the engine's tree state only has the item id). */
export interface JewelInfo {
  /** Item name, e.g. "Glorious Vanity". */
  title: string;
  /** Base type, e.g. "Timeless Jewel", "Large Cluster Jewel", "Crimson Jewel". */
  base: string;
  /** Radius label from the item ("Large", "Variable"...), when it has one. */
  radius?: string;
}
