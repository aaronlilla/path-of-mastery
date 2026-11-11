// Passive tree geometry, ported from upstream's PassiveTree.lua (orbit angles, node positions, connector quads) and
// PassiveSpec.lua (cluster jewel subgraph placement, path finding). Pure functions, no DOM: the renderer and the
// unit tests both use them.

import type { TreeStateNode } from './treeTypes.js';

/** Upstream draws every sprite at (pixels * 1.33) on each side of the node centre: tree units per sprite pixel, halved. */
export const SPRITE_HALF = 1.33;

export const NODE_NORMAL = 0;
export const NODE_NOTABLE = 1;
export const NODE_KEYSTONE = 2;
export const NODE_MASTERY = 3;
export const NODE_SOCKET = 4;
export const NODE_CLASS_START = 5;
export const NODE_ASCEND_START = 6;

// ---------------------------------------------------------------------------------------------------------------
// Orbit angles and node positions (PassiveTree.lua CalcOrbitAngles, ProcessNode)

const ANGLES_16 = [0, 30, 45, 60, 90, 120, 135, 150, 180, 210, 225, 240, 270, 300, 315, 330];
const ANGLES_40 = [
  0, 10, 20, 30, 40, 45, 50, 60, 70, 80, 90, 100, 110, 120, 130, 135, 140, 150, 160, 170, 180, 190, 200, 210, 220, 225, 230, 240, 250, 260,
  270, 280, 290, 300, 310, 315, 320, 330, 340, 350,
];

/** Angles in radians of the node slots of an orbit holding `nodesInOrbit` nodes. */
export function calcOrbitAngles(nodesInOrbit: number): number[] {
  let degrees: number[];
  if (nodesInOrbit === 16) {
    degrees = ANGLES_16;
  } else if (nodesInOrbit === 40) {
    degrees = ANGLES_40;
  } else {
    // Upstream loops `for i = 0, nodesInOrbit`, so the table has one extra entry (a full turn).
    degrees = [];
    for (let i = 0; i <= nodesInOrbit; i++) degrees.push((360 * i) / nodesInOrbit);
  }
  return degrees.map((d) => (d * Math.PI) / 180);
}

export function orbitAnglesByOrbit(skillsPerOrbit: readonly number[]): number[][] {
  return skillsPerOrbit.map((n) => calcOrbitAngles(n));
}

export interface NodePosition {
  x: number;
  y: number;
  angle: number;
}

/** Where a node sits: on orbit `orbit` of its group, slot `orbitIndex`. */
export function nodePosition(
  group: { x: number; y: number },
  orbit: number,
  orbitIndex: number,
  orbitAngles: readonly (readonly number[])[],
  orbitRadii: readonly number[],
): NodePosition {
  const angle = orbitAngles[orbit]?.[orbitIndex] ?? 0;
  const radius = orbitRadii[orbit] ?? 0;
  return { x: group.x + Math.sin(angle) * radius, y: group.y - Math.cos(angle) * radius, angle };
}

// ---------------------------------------------------------------------------------------------------------------
// Connectors (PassiveTree.lua BuildConnector, BuildArc)

export type ConnState = 'Normal' | 'Intermediate' | 'Active';
export const CONN_STATES: ConnState[] = ['Normal', 'Intermediate', 'Active'];

export interface ConnNode {
  id: number;
  x: number;
  y: number;
  angle: number;
  /** Orbit (o) and the identity of the group: two nodes on the same orbit of the same group get an arc. */
  orbit: number;
  groupKey: string | number | undefined;
  groupX: number;
  groupY: number;
  asc?: string;
}

export interface Connector {
  n1: number;
  n2: number;
  /** 'LineConnector' or 'Orbit<n>'. */
  type: string;
  asc?: string;
  /** Quad corners (x1,y1 .. x4,y4) in tree space for each state. Lines share one quad across states. */
  vert: Record<ConnState, number[]>;
  /** Texture coordinates of the corners within the sprite, 0..1 (lines: u runs 0..endS and tiles). */
  uv: number[];
  /** Lines only: length in sprite widths; the sprite tiles that many times. */
  endS?: number;
}

export type ArtSize = (name: string) => { w: number; h: number } | undefined;

/** The connectors between two linked nodes: one line, or one or two arcs when both sit on one orbit of one group. */
export function buildConnectors(a: ConnNode, b: ConnNode, art: ArtSize): Connector[] {
  let n1 = a;
  let n2 = b;
  if (n1.groupKey !== undefined && n1.groupKey === n2.groupKey && n1.orbit === n2.orbit) {
    if (n1.angle > n2.angle) [n1, n2] = [n2, n1];
    let arcAngle = n2.angle - n1.angle;
    if (arcAngle >= Math.PI) {
      [n1, n2] = [n2, n1];
      arcAngle = Math.PI * 2 - arcAngle;
    }
    if (arcAngle <= Math.PI) {
      const out: Connector[] = [];
      if (arcAngle > Math.PI / 2) {
        // Orbit art covers at most 90 degrees: a second, mirrored arc covers the rest.
        arcAngle /= 2;
        out.push(buildArc(arcAngle, n1, n2, art, true));
      }
      out.push(buildArc(arcAngle, n1, n2, art, false));
      // Upstream lists the primary arc first.
      return out.length === 2 ? [out[1]!, out[0]!] : out;
    }
  }
  return [buildLine(n1, n2, art)];
}

function buildLine(n1: ConnNode, n2: ConnNode, art: ArtSize): Connector {
  const a = art('LineConnectorNormal') ?? { w: 368, h: 13 };
  const vX = n2.x - n1.x;
  const vY = n2.y - n1.y;
  const dist = Math.sqrt(vX * vX + vY * vY);
  const scale = (a.h * 1.33) / dist;
  const nX = vX * scale;
  const nY = vY * scale;
  const endS = dist / (a.w * 1.33);
  const v = [n1.x - nY, n1.y + nX, n1.x + nY, n1.y - nX, n2.x + nY, n2.y - nX, n2.x - nY, n2.y + nX];
  return {
    n1: n1.id,
    n2: n2.id,
    type: 'LineConnector',
    asc: n1.asc,
    vert: { Normal: v, Intermediate: v, Active: v },
    uv: [0, 1, 0, 0, endS, 0, endS, 1],
    endS,
  };
}

function buildArc(arcAngle: number, n1: ConnNode, n2: ConnNode, art: ArtSize, mirrored: boolean): Connector {
  const type = `Orbit${n1.orbit}`;
  // A quarter-ring sprite on a kite-shaped quad, clipped so both ends of the arc stop at the nodes.
  const clipAngle = Math.PI / 4 - arcAngle / 2;
  const p = 1 - Math.max(Math.tan(clipAngle), 0);
  let angle = n1.angle - clipAngle;
  if (mirrored) angle += arcAngle;
  const vert = {} as Record<ConnState, number[]>;
  for (const state of CONN_STATES) {
    const a = art(type + state) ?? { w: 100, h: 100 };
    const size = a.w * 2 * 1.33;
    const oX = size * Math.SQRT2 * Math.sin(angle + Math.PI / 4);
    const oY = size * Math.SQRT2 * -Math.cos(angle + Math.PI / 4);
    const cX = n1.groupX + oX;
    const cY = n1.groupY + oY;
    const v = [
      n1.groupX,
      n1.groupY,
      cX + (size * Math.sin(angle) - oX) * p,
      cY + (size * -Math.cos(angle) - oY) * p,
      cX,
      cY,
      cX + (size * Math.cos(angle) - oX) * p,
      cY + (size * Math.sin(angle) - oY) * p,
    ];
    if (mirrored) {
      const t1 = v[2]!;
      const t2 = v[3]!;
      v[2] = v[6]!;
      v[3] = v[7]!;
      v[6] = t1;
      v[7] = t2;
    }
    vert[state] = v;
  }
  return { n1: n1.id, n2: n2.id, type, asc: n1.asc, vert, uv: [1, 1, 0, p, 0, 0, p, 0] };
}

// ---------------------------------------------------------------------------------------------------------------
// Static tree data (written by scripts/build-tree-data.mjs) and the built, ready-to-draw tree

export interface RawNode {
  id: number;
  t: number;
  n: string;
  g?: number;
  o?: number;
  i?: number;
  out?: number[];
  s?: string[];
  a?: string;
  bl?: 1;
  /** Anoint recipe (oil names). */
  rc?: string[];
  px?: 1;
  as?: 1;
  mc?: 1;
  ex?: { size: number; index: number; proxy: number; parent: number | null };
  sa?: number;
  /** Name of the class start art; its sprite is looked up after the atlas is packed (old trees draw it from a loose PNG). */
  san?: string;
  ci?: number;
  me?: Array<{ e: number; s: string[] }>;
  ma?: number;
  mi?: number;
  mn?: number;
  mf?: number;
  ia?: number;
  ii?: number;
}

export interface RawGroup {
  x: number;
  y: number;
  oo: number[];
  a?: string;
  as?: 1;
  px?: 1;
}

export interface AscendancyInfo {
  id: string;
  name: string;
  start: number;
  rect?: { x: number; y: number; width: number; height: number };
  color?: string;
  text?: string;
}

export interface ExtraSprite {
  name: string;
  file: string;
  w: number;
  h: number;
}

export interface TreeData {
  /** Separate PNGs upstream draws instead of web sprite sheet entries (the connector line and orbit arcs). */
  extra?: ExtraSprite[];
  /** Abyss frame name -> [x, y, w, h] inside the `LegionArt` extra sprite. */
  abyssFrames?: Record<string, [number, number, number, number]>;
  /** Tattoo name -> node type, icon sprites [active, inactive] and the glow sprite. */
  tattoos?: Record<string, { t: number; ic: [number, number]; fx: number }>;
  version: string;
  size: number;
  bounds: [number, number, number, number];
  orbitRadii: number[];
  skillsPerOrbit: number[];
  sheets: Array<{ file: string; w: number; h: number }>;
  /** [sheet, x, y, w, h] in sheet pixels. */
  sprites: number[][];
  named: Record<string, number>;
  prefixes: Record<string, string>;
  overlays: Record<string, Record<string, string | number>>;
  nodes: RawNode[];
  groups: Record<string, RawGroup>;
  classes: Record<string, { name: string; start: number; asc: Record<string, AscendancyInfo> }>;
  alt: Record<string, AscendancyInfo>;
  jewelRadius: Array<{ inner: number; outer: number; col: string; label: string }>;
  cluster: {
    jewels: Record<string, { size: string; socketIndicies: number[]; totalIndicies: number }>;
    orbitOffsets: Record<string, Record<string, number>>;
    skillIcons: Record<string, number[]>;
    notableIcons: Record<string, { t: number; ic: number[] }>;
  };
}

export interface ExtraPlacement {
  file: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Lays the `extra` PNGs out in one atlas sheet and points `named[name]` at the new sprites (so the connector art uses the
 * exact files upstream loads, sizes included). Appends the sheet (file '') and sprites to `data`; returns where each file goes,
 * for the renderer to draw into the atlas. Safe to call once per TreeData.
 */
export function packExtraSprites(data: TreeData): ExtraPlacement[] {
  const extra = data.extra ?? [];
  if (!extra.length) return [];
  const PAD = 4;
  // The class illustrations are about 1000 px wide: a wider sheet keeps the atlas short.
  const W = extra.some((e) => e.w > 700) ? 4096 : 1024;
  const order = [...extra].sort((a, b) => b.h - a.h || a.name.localeCompare(b.name));
  const placed: ExtraPlacement[] = [];
  let x = 0;
  let y = 0;
  let rowH = 0;
  const sheet = data.sheets.length;
  const pos = new Map<string, ExtraPlacement>();
  for (const e of order) {
    if (x + e.w + PAD > W) {
      x = 0;
      y += rowH + PAD;
      rowH = 0;
    }
    const p = { file: e.file, x: x + PAD / 2, y: y + PAD / 2, w: e.w, h: e.h };
    pos.set(e.name, p);
    placed.push(p);
    x += e.w + PAD;
    rowH = Math.max(rowH, e.h);
  }
  const H = y + rowH + PAD;
  data.sheets.push({ file: '', w: W, h: H });
  for (const e of extra) {
    const p = pos.get(e.name)!;
    data.named[e.name] = data.sprites.length;
    data.sprites.push([sheet, p.x, p.y, e.w, e.h]);
  }
  const art = pos.get('LegionArt');
  if (art && data.abyssFrames) {
    for (const [name, [x, y, w, h]] of Object.entries(data.abyssFrames)) {
      data.named[name] = data.sprites.length;
      data.sprites.push([sheet, art.x + x, art.y + y, w, h]);
    }
  }
  return placed;
}

export interface TGroup {
  key: string;
  x: number;
  y: number;
  oo: Set<number>;
  asc?: string;
  ascStart: boolean;
  proxy: boolean;
  /** Cluster-jewel subgraph groups draw the "Alt" group art. */
  expansion: boolean;
}

export interface TNode {
  id: number;
  /** Index into BuiltTree.nodes. */
  idx: number;
  t: number;
  name: string;
  stats: string[];
  x: number;
  y: number;
  angle: number;
  orbit: number;
  oidx: number;
  group: TGroup | null;
  asc?: string;
  blighted: boolean;
  /** Anoint recipe: the oils, e.g. ["TealOil", "CrimsonOil"]. */
  recipe?: string[];
  /** Sprite indices: icon when allocated / unallocated (-1: none). */
  iconActive: number;
  iconInactive: number;
  mastery?: { effects: Array<{ e: number; s: string[] }>; active: number; inactive: number; connected: number; effect: number };
  masteryBase: number;
  startArt: number;
  classStart?: number;
  ex?: RawNode['ex'];
  multipleChoice: boolean;
  generated: boolean;
  /** Hover radius squared and overlay size (tree units). */
  rsq: number;
  size: number;
  /** Linked node ids that are drawn (no proxies). */
  linked: number[];
  /** Search text (lower case). */
  text: string;
}

export interface BuiltTree {
  data: TreeData;
  orbitAngles: number[][];
  nodes: TNode[];
  byId: Map<number, TNode>;
  groups: Map<string, TGroup>;
  connectors: Connector[];
  art: ArtSize;
  classStarts: Record<number, number>;
  ascStarts: TNode[];
}

const EMPTY: number[] = [];

export function makeArtSize(data: TreeData): ArtSize {
  return (name) => {
    const i = data.named[name];
    if (i === undefined || i < 0) return undefined;
    const s = data.sprites[i];
    return s ? { w: s[3]!, h: s[4]! } : undefined;
  };
}

function overlayOf(data: TreeData, t: number): Record<string, string | number> | undefined {
  const key = ['Normal', 'Notable', 'Keystone', 'Mastery', 'Socket'][t];
  return key ? data.overlays[key] : undefined;
}

function toConn(n: TNode): ConnNode {
  return { id: n.id, x: n.x, y: n.y, angle: n.angle, orbit: n.orbit, groupKey: n.group?.key, groupX: n.group?.x ?? 0, groupY: n.group?.y ?? 0, asc: n.asc };
}

/** The static tree: node positions from the orbit formula and the connectors upstream pregenerates at load. */
export function buildTree(data: TreeData): BuiltTree {
  const orbitAngles = orbitAnglesByOrbit(data.skillsPerOrbit);
  const groups = new Map<string, TGroup>();
  for (const [key, g] of Object.entries(data.groups)) {
    groups.set(key, { key, x: g.x, y: g.y, oo: new Set(g.oo), asc: g.a, ascStart: !!g.as, proxy: !!g.px, expansion: false });
  }
  const nodes: TNode[] = [];
  const byId = new Map<number, TNode>();
  const rawById = new Map<number, RawNode>();
  for (const r of data.nodes) rawById.set(r.id, r);
  for (const r of data.nodes) {
    const group = r.g !== undefined ? groups.get(String(r.g)) ?? null : null;
    const orbit = r.o ?? 0;
    const oidx = r.i ?? 0;
    let x = 0;
    let y = 0;
    let angle = 0;
    if (group) ({ x, y, angle } = nodePosition(group, orbit, oidx, orbitAngles, data.orbitRadii));
    const ov = overlayOf(data, r.t);
    const n: TNode = {
      id: r.id,
      idx: nodes.length,
      t: r.t,
      name: r.n,
      stats: r.s ?? EMPTY as unknown as string[],
      x,
      y,
      angle,
      orbit,
      oidx,
      group,
      asc: r.a,
      blighted: !!r.bl,
      recipe: r.rc,
      iconActive: r.ia ?? -1,
      iconInactive: r.ii ?? -1,
      masteryBase: r.t === NODE_MASTERY && !r.me ? r.mi ?? -1 : -1,
      startArt: r.sa !== undefined && r.sa >= 0 ? r.sa : r.san !== undefined ? data.named[r.san] ?? -1 : -1,
      classStart: r.ci,
      ex: r.ex,
      multipleChoice: !!r.mc,
      generated: false,
      rsq: (ov?.rsq as number | undefined) ?? 0,
      size: (ov?.size as number | undefined) ?? 0,
      linked: [],
      text: '',
    };
    if (r.me) n.mastery = { effects: r.me, active: r.ma ?? -1, inactive: r.mi ?? -1, connected: r.mn ?? -1, effect: r.mf ?? -1 };
    // Hidden nodes: proxies, anything in a proxy group, groupless cluster-template nodes.
    const hidden = !group || group.proxy || !!r.px;
    if (hidden) {
      n.rsq = 0;
    }
    nodes.push(n);
    byId.set(n.id, n);
  }
  const art = makeArtSize(data);
  const connectors: Connector[] = [];
  const classStarts: Record<number, number> = {};
  const ascStarts: TNode[] = [];
  for (const n of nodes) {
    if (n.t === NODE_CLASS_START && n.classStart !== undefined) classStarts[n.classStart] = n.id;
    if (n.t === NODE_ASCEND_START) ascStarts.push(n);
  }
  for (const r of data.nodes) {
    const a = byId.get(r.id)!;
    for (const oid of r.out ?? EMPTY) {
      const b = byId.get(oid);
      if (!b) continue;
      if (isDrawn(a) && isDrawn(b)) {
        a.linked.push(b.id);
        b.linked.push(a.id);
      }
      if (a.t !== NODE_CLASS_START && b.t !== NODE_CLASS_START && a.t !== NODE_MASTERY && b.t !== NODE_MASTERY && a.asc === b.asc && a.group && b.group && !a.group.proxy && !b.group.proxy && !rawById.get(a.id)!.px && !rawById.get(b.id)!.px) {
        connectors.push(...buildConnectors(toConn(a), toConn(b), art));
      }
    }
  }
  for (const n of nodes) {
    n.text = (n.name + '\n' + n.stats.join('\n') + (n.mastery ? '\n' + n.mastery.effects.map((e) => e.s.join(' ')).join('\n') : '')).toLowerCase();
  }
  return { data, orbitAngles, nodes, byId, groups, connectors, art, classStarts, ascStarts };

  function isDrawn(n: TNode): boolean {
    return !!n.group && !n.group.proxy && !rawById.get(n.id)!.px;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Cluster jewel subgraphs (PassiveSpec.lua BuildSubgraph): the engine's generated nodes, placed on their proxy group

/** PassiveSpecClass:TranslateClusterOrbitIndex */
export function translateClusterOrbitIndex(src: number, srcPerOrbit: number, destPerOrbit: number): number {
  if (srcPerOrbit === destPerOrbit) return src;
  if (srcPerOrbit === 12 && destPerOrbit === 16) return [0, 1, 3, 4, 5, 7, 8, 9, 11, 12, 13, 15][src] ?? 0;
  if (srcPerOrbit === 16 && destPerOrbit === 12) return [0, 1, 1, 2, 3, 4, 4, 5, 6, 7, 7, 8, 9, 10, 10, 11][src] ?? 0;
  if (srcPerOrbit === 6 && destPerOrbit === 16) return [0, 3, 5, 8, 11, 13][src] ?? 0;
  if (srcPerOrbit === 16 && destPerOrbit === 6) return [0, 0, 0, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 5, 5, 5][src] ?? 0;
  return Math.floor((src * destPerOrbit) / srcPerOrbit);
}

/** Cluster jewel size index (0 small, 1 medium, 2 large) is the orbit minus one. */
const SOCKET_ORDER: Record<number, number> = { 0: 0, 2: 1, 1: 2 };

export interface Subgraph {
  group: TGroup;
  /** The socket the cluster jewel sits in. */
  parentSocket: number;
  nodes: TNode[];
  /** Nested sockets of this cluster, placed (they are static tree nodes the engine does not list as generated). */
  sockets: TNode[];
}

export interface Extension {
  nodes: TNode[];
  byId: Map<number, TNode>;
  subgraphs: Subgraph[];
  connectors: Connector[];
  /** Extra links (both directions) between node ids, for path finding. */
  links: Array<[number, number]>;
}

function generatedKind(kind: string | undefined): number {
  switch (kind) {
    case 'Notable': return NODE_NOTABLE;
    case 'Keystone': return NODE_KEYSTONE;
    case 'Mastery': return NODE_MASTERY;
    case 'Socket': return NODE_SOCKET;
    default: return NODE_NORMAL;
  }
}

/**
 * Places the engine's generated nodes on the group they carry (upstream gives every node of one cluster subgraph the group of
 * the proxy node of the socket the jewel sits in; an engine without that field is handled by finding that socket from
 * the entrance link). Sockets of the cluster itself are static tree
 * nodes (hidden in the proxy group) the engine does not list; upstream puts them at the cluster template's socket slots.
 */
export function buildExtension(tree: BuiltTree, generated: TreeStateNode[]): Extension {
  const ext: Extension = { nodes: [], byId: new Map(), subgraphs: [], connectors: [], links: [] };
  if (!generated.length) return ext;
  const data = tree.data;
  // The engine also lists the cluster jewels' sockets, which are ordinary tree nodes with their own ids (`ex` on the tree
  // node): they are sockets to hang a cluster on, not nodes of one, so they leave the generated list.
  const isTreeSocket = (id: number): boolean => !!tree.byId.get(id)?.ex;
  // The sockets' own link lists still matter: a ring socket links to its neighbour sockets and to tree nodes, and dropping
  // those links cuts the ring in two for path finding (the tooltip then promises far more points than a click frees).
  const socketLinks = generated.filter((g) => isTreeSocket(g.id));
  generated = generated.filter((g) => !isTreeSocket(g.id));
  if (!generated.length) return ext;
  const genById = new Map<number, TreeStateNode>();
  for (const g of generated) genById.set(g.id, g);

  // One subgraph per cluster jewel. Upstream numbers a subgraph's nodes id = subgraphId + nodeIndex, with the low 4 bits the
  // node index (0-11, 12 for the mastery) and the bits above identifying the jewel (size and socket indices). The ring
  // runs through the cluster's own sockets, so grouping by links would split it.
  const bySub = new Map<number, TreeStateNode[]>();
  for (const g of generated) {
    const key = g.id >> 4;
    let l = bySub.get(key);
    if (!l) bySub.set(key, (l = []));
    l.push(g);
  }
  const comps = [...bySub.values()];

  const cluster = data.cluster;
  const art = tree.art;
  const pending: Array<{ a: number; b: number }> = [];
  for (const list of comps) {
    // Static socket neighbours of this component.
    const socketIds = new Set<number>();
    for (const g of list) for (const l of g.linked ?? []) {
      if (genById.has(l)) continue;
      const s = tree.byId.get(l);
      if (s?.ex) socketIds.add(l);
    }
    const sockets = [...socketIds].map((id) => tree.byId.get(id)!);
    const parent = sockets.find((s) => sockets.every((o) => o === s || o.ex!.parent === s.id)) ?? sockets[0];
    if (!parent?.ex) continue;
    // The engine gives every generated node the proxy group of its socket (`group`); the proxy lookup is the fallback
    // for an engine that does not.
    const engineGroup = list.find((g) => g.group != null)?.group;
    const pg = (engineGroup != null ? tree.groups.get(String(engineGroup)) : undefined) ?? tree.byId.get(parent.ex.proxy)?.group;
    if (!pg) continue;
    const group: TGroup = { key: `sub${list[0]!.id}`, x: pg.x, y: pg.y, oo: new Set(), ascStart: false, proxy: false, expansion: true };
    // The orbit the cluster's nodes sit on tells its size.
    let orbit = 0;
    for (const g of list) if ((g.orbit ?? 0) > 0) { orbit = g.orbit!; break; }
    if (orbit > 0) group.oo.add(orbit);
    if (list.some((g) => g.kind === 'Mastery')) group.oo.add(0);

    const sub: Subgraph = { group, parentSocket: parent.id, nodes: [], sockets: [] };
    for (const g of list) {
      const kind = generatedKind(g.kind);
      const o = g.orbit ?? 0;
      const pos = nodePosition(group, o, g.orbitIndex ?? 0, tree.orbitAngles, data.orbitRadii);
      const n = makeGenerated(tree, g, kind, group, pos, ext.nodes.length);
      ext.nodes.push(n);
      ext.byId.set(n.id, n);
      sub.nodes.push(n);
    }
    // The cluster's own sockets.
    const sizeIndex = orbit - 1;
    const jewel = cluster.jewels[String(sizeIndex)];
    const offset = cluster.orbitOffsets[String(parent.ex.proxy)]?.[String(sizeIndex)] ?? 0;
    for (const s of sockets) {
      if (s === parent) continue;
      let pos: NodePosition;
      let oidx = s.oidx;
      if (jewel && s.ex) {
        const slot = jewel.socketIndicies[SOCKET_ORDER[s.ex.index] ?? 0] ?? 0;
        const perOrbit = data.skillsPerOrbit[orbit] ?? 16;
        oidx = translateClusterOrbitIndex((slot + offset) % jewel.totalIndicies, jewel.totalIndicies, perOrbit);
        pos = nodePosition(group, orbit, oidx, tree.orbitAngles, data.orbitRadii);
      } else {
        pos = { x: s.x, y: s.y, angle: s.angle };
      }
      const n: TNode = { ...s, idx: -1, x: pos.x, y: pos.y, angle: pos.angle, orbit, oidx, group, generated: true, linked: [], rsq: tree.byId.get(s.id)?.rsq || overlaySocketRsq(tree), size: s.size || 77.14 };
      if (!n.rsq) n.rsq = overlaySocketRsq(tree);
      n.idx = ext.nodes.length;
      ext.nodes.push(n);
      ext.byId.set(n.id, n);
      sub.sockets.push(n);
    }
    ext.subgraphs.push(sub);
    for (const g of list) for (const l of g.linked ?? []) pending.push({ a: g.id, b: l });
  }
  for (const sk of socketLinks) if (ext.byId.has(sk.id)) for (const l of sk.linked ?? []) pending.push({ a: sk.id, b: l });

  // Links and connectors (each pair once).
  const seen = new Set<string>();
  const find = (id: number): TNode | undefined => ext.byId.get(id) ?? tree.byId.get(id);
  for (const { a, b } of pending) {
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const na = find(a);
    const nb = find(b);
    if (!na || !nb) continue;
    ext.links.push([a, b]);
    ext.connectors.push(...buildConnectors(toConn(na), toConn(nb), art));
  }
  return ext;
}

function overlaySocketRsq(tree: BuiltTree): number {
  return (tree.data.overlays.Socket?.rsq as number | undefined) ?? 5950.58;
}

function makeGenerated(tree: BuiltTree, g: TreeStateNode, kind: number, group: TGroup, pos: NodePosition, idx: number): TNode {
  const ov = overlayOf(tree.data, kind);
  const cluster = tree.data.cluster;
  let ia = -1;
  let ii = -1;
  if (kind === NODE_NOTABLE || kind === NODE_KEYSTONE) {
    const ic = cluster.notableIcons[g.name]?.ic;
    if (ic) [ia, ii] = [ic[0] ?? -1, ic[1] ?? -1];
  } else if (kind === NODE_NORMAL) {
    const ic = cluster.skillIcons[g.name];
    if (ic) [ia, ii] = [ic[0] ?? -1, ic[1] ?? -1];
  }
  const stats = g.stats ?? [];
  return {
    id: g.id,
    idx,
    t: kind,
    name: g.name,
    stats,
    x: pos.x,
    y: pos.y,
    angle: pos.angle,
    orbit: g.orbit ?? 0,
    oidx: g.orbitIndex ?? 0,
    group,
    asc: undefined,
    blighted: false,
    iconActive: ia,
    iconInactive: ii,
    masteryBase: kind === NODE_MASTERY ? tree.data.named['MasteryBlank'] ?? -1 : -1,
    startArt: -1,
    multipleChoice: false,
    generated: true,
    rsq: kind === NODE_MASTERY ? 0 : (ov?.rsq as number | undefined) ?? 0,
    size: (ov?.size as number | undefined) ?? 0,
    linked: [],
    text: (g.name + '\n' + stats.join('\n')).toLowerCase(),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Path finding (PassiveSpec.lua BuildAllDependsAndPaths): the path a click would allocate, and dependents

export interface Graph {
  neighbors(id: number): readonly number[];
  node(id: number): TNode | undefined;
}

export function makeGraph(tree: BuiltTree, ext: Extension): Graph {
  const extra = new Map<number, number[]>();
  for (const [a, b] of ext.links) {
    (extra.get(a) ?? extra.set(a, []).get(a)!).push(b);
    (extra.get(b) ?? extra.set(b, []).get(b)!).push(a);
  }
  // Hidden (proxy) static nodes never appear in paths; a nested socket only exists through its subgraph.
  const node = (id: number) => ext.byId.get(id) ?? tree.byId.get(id);
  return {
    node,
    neighbors(id) {
      const n = node(id);
      if (!n) return EMPTY;
      const e = extra.get(id);
      if (!e) return n.linked;
      return [...n.linked, ...e];
    },
  };
}

/**
 * The nodes a click on `target` would allocate (target first), or null when it can't be reached. Upstream's multi-source 0-1
 * search from the allocated nodes: allocated nodes cost nothing, others one point; paths don't pass through class or
 * ascendancy starts, don't leave masteries, and don't cross into another ascendancy (except from distance zero).
 */
export function findPath(graph: Graph, allocated: ReadonlySet<number>, roots: readonly number[], target: number): number[] | null {
  const dist = new Map<number, number>();
  const prev = new Map<number, number | null>();
  const deque: number[] = [];
  let head = 0;
  for (const r of roots) {
    dist.set(r, 0);
    prev.set(r, null);
    deque.push(r);
  }
  // 0-1 BFS with an array deque: free nodes go in front.
  const front: number[] = [];
  const pop = (): number | undefined => (front.length ? front.pop() : deque[head++]);
  for (;;) {
    const cur = pop();
    if (cur === undefined) break;
    const cd = dist.get(cur)!;
    const cn = graph.node(cur);
    if (!cn) continue;
    for (const nb of graph.neighbors(cur)) {
      const on = graph.node(nb);
      if (!on) continue;
      const w = allocated.has(nb) ? 0 : 1;
      const nd = cd + w;
      const can = cn.t !== NODE_MASTERY && on.t !== NODE_CLASS_START && on.t !== NODE_ASCEND_START && (cn.asc === on.asc || (cd === 0 && !on.asc));
      if (!can) continue;
      const old = dist.get(nb);
      if (old !== undefined && nd >= old) continue;
      dist.set(nb, nd);
      prev.set(nb, cur);
      if (w === 0) front.push(nb);
      else deque.push(nb);
    }
  }
  if (!dist.has(target) || allocated.has(target)) return null;
  const path: number[] = [];
  let c: number | null | undefined = target;
  while (c != null && !allocated.has(c)) {
    path.push(c);
    c = prev.get(c);
  }
  return path;
}

/**
 * Allocated nodes that would stop being connected to a start if `node` were removed (not including `node`). Nodes that are
 * already cut off before the removal (allocated through an Intuitive Leap-like jewel, whose radius frees them from the
 * path) are not counted: the engine keeps them when the node goes.
 */
export function dependents(graph: Graph, allocated: ReadonlySet<number>, roots: readonly number[], node: number): number[] {
  const unreached = (skip: number): Set<number> => {
    const seen = new Set<number>(roots.filter((r) => r !== skip));
    const stack = [...seen];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const nb of graph.neighbors(cur)) {
        if (nb === skip || seen.has(nb) || !allocated.has(nb)) continue;
        const cn = graph.node(cur);
        const on = graph.node(nb);
        if (!cn || !on || cn.t === NODE_MASTERY) continue;
        seen.add(nb);
        stack.push(nb);
      }
    }
    const out = new Set<number>();
    for (const a of allocated) if (a !== skip && !seen.has(a)) out.add(a);
    return out;
  };
  const before = unreached(-1);
  const out: number[] = [];
  for (const a of unreached(node)) if (a !== node && !before.has(a)) out.push(a);
  return out;
}
