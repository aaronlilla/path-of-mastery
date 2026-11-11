/**
 * Tree sets (upstream's "specs"): the `<Spec>` elements of a build file's `<Tree>`. Everything here edits the build
 * text and nothing else, the way upstream's Manage Passive Trees window edits its spec list: new, copy, rename, delete,
 * reorder, import a tree link, convert every tree to another game version. The renderer sends the edited text to the engine
 * (a `setXml` edit), so each of these is one undo step and the numbers always come from the engine.
 *
 * The tree link format is the official site's (PassiveSpec.lua `EncodeURL` / `DecodeURL`).
 */
import { escapeXml, parseAttrs, unescapeXml } from './buildXml.js';

export interface SpecPieces {
  /** Text before the `<Tree>` start tag. */
  head: string;
  /** The `<Tree>` start tag (without the end of the element). */
  open: string;
  /** Each `<Spec>` element as written. */
  specs: string[];
  /** Text after `</Tree>`. */
  tail: string;
  active: number;
}

const TREE_OPEN = /<Tree\b((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/;

/** Splits the build text around its `<Tree>` element into its `<Spec>` elements. Null when there is no tree element. */
export function splitSpecs(xml: string): SpecPieces | null {
  const m = TREE_OPEN.exec(xml);
  if (!m) return null;
  const open = m[0];
  const active = Math.max(1, parseInt(parseAttrs(m[1] ?? '').activeSpec ?? '1', 10) || 1);
  const start = m.index;
  if (m[2] === '/') return { head: xml.slice(0, start), open: open.replace(/\/>$/, '>'), specs: [], tail: xml.slice(start + open.length), active };
  const close = xml.indexOf('</Tree>', start + open.length);
  if (close < 0) return null;
  const inner = xml.slice(start + open.length, close);
  const specs: string[] = [];
  const re = /<Spec\b((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  for (let s = re.exec(inner); s; s = re.exec(inner)) {
    if (s[2] === '/') {
      specs.push(s[0]);
      continue;
    }
    const end = inner.indexOf('</Spec>', s.index + s[0].length);
    if (end < 0) break;
    specs.push(inner.slice(s.index, end + '</Spec>'.length));
    re.lastIndex = end + '</Spec>'.length;
  }
  return { head: xml.slice(0, start), open, specs, tail: xml.slice(close + '</Tree>'.length), active };
}

/** The build text with the given spec elements and active spec. */
export function joinSpecs(p: SpecPieces, specs: string[], active: number): string {
  const a = Math.max(1, Math.min(active, Math.max(1, specs.length)));
  const open = /\sactiveSpec=/.test(p.open) ? p.open.replace(/(\sactiveSpec=)(["'])[^"']*\2/, `$1"${a}"`) : p.open.replace(/>$/, ` activeSpec="${a}">`);
  return `${p.head}${open}\n\t\t${specs.join('\n\t\t')}\n\t</Tree>${p.tail}`;
}

const specOpenTag = (spec: string): string => /^<Spec\b(?:[^>"']|"[^"]*"|'[^']*')*?\/?>/.exec(spec)?.[0] ?? '<Spec>';

export function specAttr(spec: string, name: string): string | undefined {
  const a = parseAttrs(specOpenTag(spec).replace(/^<Spec\b/, '').replace(/\/?>$/, ''));
  return a[name];
}

/** Sets (or adds) an attribute on a spec's start tag. */
export function setSpecAttr(spec: string, name: string, value: string): string {
  const open = specOpenTag(spec);
  const re = new RegExp(`(\\s${name}=)(["'])[^"']*\\2`);
  const next = re.test(open) ? open.replace(re, `$1"${escapeXml(value)}"`) : open.replace(/^<Spec\b/, `<Spec ${name}="${escapeXml(value)}"`);
  return next + spec.slice(open.length);
}

export interface SpecSummary {
  index: number;
  title: string;
  treeVersion: string;
  classId: number;
  ascendClassId: number;
  secondaryAscendClassId: number;
  nodes: number[];
  masteries: Array<[number, number]>;
}

const nums = (text: string | undefined): number[] => (text ?? '').split(',').map(Number).filter((n) => Number.isFinite(n) && n > 0);

/** What the dialogs show of each spec. Old builds keep their tree only as a `<URL>` link: that is read too. */
export function summariseSpec(spec: string, index: number): SpecSummary {
  const a = parseAttrs(specOpenTag(spec).replace(/^<Spec\b/, '').replace(/\/?>$/, ''));
  let nodes = nums(a.nodes);
  let masteries: Array<[number, number]> = [];
  for (const m of (a.masteryEffects ?? '').matchAll(/\{(\d+),(\d+)\}/g)) masteries.push([Number(m[1]), Number(m[2])]);
  let classId = Number(a.classId) || 0;
  let ascendClassId = Number(a.ascendClassId) || 0;
  let secondaryAscendClassId = Number(a.secondaryAscendClassId) || 0;
  if (!nodes.length && !('nodes' in a)) {
    const url = /<URL>([\s\S]*?)<\/URL>/.exec(spec)?.[1]?.trim();
    const d = url ? decodeTreeLink(unescapeXml(url)) : null;
    if (d && d.ok) {
      nodes = d.nodes;
      masteries = d.masteries;
      classId = d.classId;
      ascendClassId = d.ascendClassId;
      secondaryAscendClassId = d.secondaryAscendClassId;
    }
  }
  return { index, title: a.title ?? '', treeVersion: a.treeVersion ?? '3_0', classId, ascendClassId, secondaryAscendClassId, nodes, masteries };
}

export function readSpecSummaries(xml: string): { active: number; specs: SpecSummary[] } {
  const p = splitSpecs(xml);
  if (!p) return { active: 1, specs: [] };
  return { active: p.active, specs: p.specs.map((s, i) => summariseSpec(s, i + 1)) };
}

// ---- edits ------------------------------------------------------------------------------------------------------

export const LATEST_TREE_VERSION = '3_29';

export interface NewSpecBase {
  classId: number;
  ascendClassId: number;
  secondaryAscendClassId: number;
}

/** A tree with nothing allocated, in the latest version, in the class and ascendancies given (upstream's "New"). */
export function emptySpecXml(title: string, base: NewSpecBase, version = LATEST_TREE_VERSION): string {
  return `<Spec title="${escapeXml(title)}" treeVersion="${version}" classId="${base.classId}" ascendClassId="${base.ascendClassId}"${base.secondaryAscendClassId ? ` secondaryAscendClassId="${base.secondaryAscendClassId}"` : ''} masteryEffects="" nodes="">\n\t\t\t<Sockets>\n\t\t\t</Sockets>\n\t\t</Spec>`;
}

/** Adds a spec at the end and makes it the active one when `activate` is set. */
export function addSpec(xml: string, spec: string, activate = false): string {
  const p = splitSpecs(xml);
  if (!p) return xml;
  const specs = [...p.specs, spec];
  return joinSpecs(p, specs, activate ? specs.length : p.active);
}

export function copySpec(xml: string, index: number, title: string): string {
  const p = splitSpecs(xml);
  const src = p?.specs[index - 1];
  if (!p || src === undefined) return xml;
  return joinSpecs(p, [...p.specs, setSpecAttr(src, 'title', title)], p.active);
}

export function renameSpec(xml: string, index: number, title: string): string {
  const p = splitSpecs(xml);
  if (!p || !p.specs[index - 1]) return xml;
  const specs = [...p.specs];
  specs[index - 1] = setSpecAttr(specs[index - 1]!, 'title', title);
  return joinSpecs(p, specs, p.active);
}

/** Deletes a spec (never the last one). The active spec stays the same tree, or the one before it when it was the one deleted. */
export function deleteSpec(xml: string, index: number): string {
  const p = splitSpecs(xml);
  if (!p || p.specs.length < 2 || !p.specs[index - 1]) return xml;
  const specs = p.specs.filter((_s, i) => i !== index - 1);
  const active = p.active === index ? Math.max(1, index - 1) : p.active > index ? p.active - 1 : p.active;
  return joinSpecs(p, specs, active);
}

/** Moves a spec to a new place in the list; the active spec follows its tree. */
export function moveSpec(xml: string, from: number, to: number): string {
  const p = splitSpecs(xml);
  if (!p || !p.specs[from - 1] || to < 1 || to > p.specs.length || from === to) return xml;
  const ids = p.specs.map((_s, i) => i + 1);
  const [moved] = ids.splice(from - 1, 1);
  ids.splice(to - 1, 0, moved!);
  return joinSpecs(p, ids.map((i) => p.specs[i - 1]!), ids.indexOf(p.active) + 1);
}

/**
 * Upstream's "Convert all trees": every tree that is not in `version` is replaced by the same tree in it. A tree on a
 * sub-type (ruthless, alternate) stays on it when the new version has one. `known` is the list of valid version names.
 */
export function convertAllSpecs(xml: string, version: string, known: string[]): string {
  const p = splitSpecs(xml);
  if (!p) return xml;
  const base = version.replace(/_[a-z]+(?:_[a-z]+)?$/, '');
  const specs = p.specs.map((s) => {
    const cur = specAttr(s, 'treeVersion') ?? '';
    if (cur === version) return s;
    let to = version;
    const sub = /(_[a-z]+_?[a-z]*)/.exec(cur)?.[1];
    if (sub && !version.includes(sub) && known.includes(base + sub)) to = base + sub;
    return cur === to ? s : setSpecAttr(s, 'treeVersion', to);
  });
  return joinSpecs(p, specs, p.active);
}

// ---- allocated points ---------------------------------------------------------------------------------------------

export interface NodeKinds {
  /** Node id to [type, ascendancy name, multiple choice option]. */
  get(id: number): { t: number; a?: string; mc?: boolean } | undefined;
  /** Names of the secondary (bloodline) ascendancies. */
  secondary: Set<string>;
}

export interface PointCounts {
  used: number;
  asc: number;
  secondaryAsc: number;
  sockets: number;
}

/** Upstream's `CountAllocNodes`: passive points (not the class start, not ascendancy), ascendancy points, jewel sockets. */
export function countPoints(nodes: number[], kinds: NodeKinds): PointCounts {
  const c: PointCounts = { used: 0, asc: 0, secondaryAsc: 0, sockets: 0 };
  for (const id of nodes) {
    const n = kinds.get(id);
    // Cluster jewel nodes (ids from 65536) are not in the static tree; each costs a passive point like any other node.
    if (!n) {
      if (id >= 65536) c.used++;
      continue;
    }
    if (n.t === 5 || n.t === 6) continue;
    if (n.a) {
      if (!n.mc) {
        c.asc++;
        if (kinds.secondary.has(n.a)) c.secondaryAsc++;
      }
    } else c.used++;
    if (n.t === 4) c.sockets++;
  }
  return c;
}

/** Gold the game charges for a respec, by character level (Data/Misc.lua `goldRespecPrices`). */
export const GOLD_RESPEC_PRICES = [4, 4, 4, 5, 5, 6, 6, 7, 8, 8, 9, 11, 12, 14, 15, 17, 18, 20, 22, 24, 26, 28, 31, 34, 36, 39, 43, 46, 50, 54, 58, 62, 67, 72, 83, 90, 97, 105, 113, 121, 130, 151, 161, 171, 182, 209, 222, 237, 252, 267, 295, 313, 333, 354, 376, 427, 452, 482, 513, 546, 618, 656, 694, 733, 773, 816, 860, 892, 921, 1055, 1203, 1365, 1541, 1748, 1974, 2221, 2490, 2770, 3073, 3400, 3752, 4131, 4538, 4976, 5444, 5967, 6526, 7126, 7766, 8450, 9851, 11380, 13042, 14847, 16801, 18914, 21192, 23647, 26286, 29119];

export interface RespecCost {
  passive: number;
  ascendancy: number;
  gold: number;
}

/**
 * What switching from the current tree to another costs (TreeTab.lua's spec tooltip): only when both trees share the class,
 * the passive nodes the current tree has and the other lacks are refunded (class starts, cluster-jewel nodes and nodes of
 * generated jewels do not count), ascendancy nodes cost five times as much.
 */
export function respecCost(current: number[], other: number[], level: number, kinds: NodeKinds): RespecCost {
  const has = new Set(other);
  let passive = 0;
  let ascendancy = 0;
  for (const id of current) {
    if (id >= 65536 || has.has(id)) continue;
    const n = kinds.get(id);
    if (!n || n.t === 5 || n.t === 6) continue;
    if (n.a) ascendancy++;
    else passive++;
  }
  const price = GOLD_RESPEC_PRICES[Math.max(1, Math.min(100, level)) - 1] ?? 0;
  return { passive, ascendancy, gold: passive * price + ascendancy * price * 5 };
}

// ---- tree links ---------------------------------------------------------------------------------------------------

export interface DecodedTree {
  ok: true;
  classId: number;
  ascendClassId: number;
  secondaryAscendClassId: number;
  nodes: number[];
  masteries: Array<[number, number]>;
}
export interface DecodeFail {
  ok: false;
  error: string;
}

function fromBase64Url(text: string): Uint8Array | null {
  const t = text.replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/]/g, '');
  const pad = t + '='.repeat((4 - (t.length % 4)) % 4);
  try {
    const bin = atob(pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function toBase64Url(b: number[]): string {
  let s = '';
  for (const v of b) s += String.fromCharCode(v);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_');
}

/** `PassiveSpec:DecodeURL`: the official site's link (the part after the last slash is the code). */
export function decodeTreeLink(link: string): DecodedTree | DecodeFail {
  const code = link.trim().replace(/^.+\//, '');
  const b = fromBase64Url(code);
  if (!b || b.length < 6) return { ok: false, error: 'Invalid tree link (unrecognised format)' };
  const ver = b[0]! * 16777216 + b[1]! * 65536 + b[2]! * 256 + b[3]!;
  if (ver > 6) return { ok: false, error: `Invalid tree link (unknown version number '${ver}')` };
  const classId = b[4]!;
  if (classId > 6) return { ok: false, error: `Invalid tree link (bad class ID '${classId}')` };
  const ids = ver >= 4 ? b[5]! : 0;
  const ascendClassId = ids & 3;
  const secondaryAscendClassId = (ids & 12) >> 2;
  const pairs = (from: number, count: number): number[] => {
    const out: number[] = [];
    for (let i = 0; i < count && from + i * 2 + 1 < b.length; i++) out.push(b[from + i * 2]! * 256 + b[from + i * 2 + 1]!);
    return out;
  };
  const nodes: number[] = [];
  const masteries: Array<[number, number]> = [];
  const nodesStart = ver >= 4 ? 7 : 6;
  if (ver >= 5) {
    const n = b[6] ?? 0;
    nodes.push(...pairs(7, n));
    let at = 7 + n * 2;
    const c = b[at] ?? 0;
    nodes.push(...pairs(at + 1, c).map((x) => x + 65536));
    at += 1 + c * 2;
    if (ver >= 6) {
      const m = b[at] ?? 0;
      for (let i = 0; i < m; i++) {
        const o = at + 1 + i * 4;
        if (o + 3 >= b.length) break;
        masteries.push([b[o + 2]! * 256 + b[o + 3]!, b[o]! * 256 + b[o + 1]!]);
      }
    }
  } else {
    for (let i = nodesStart; i + 1 < b.length; i += 2) nodes.push(b[i]! * 256 + b[i + 1]!);
  }
  return { ok: true, classId, ascendClassId, secondaryAscendClassId, nodes: [...new Set(nodes)], masteries };
}

export interface EncodableTree {
  classId: number;
  ascendClassId: number;
  secondaryAscendClassId: number;
  nodes: number[];
  masteries: Array<[number, number]>;
}

/** `PassiveSpec:EncodeURL`: the tree as the official site's link. `isStart` tells class and ascendancy start nodes, which the link omits. */
export function encodeTreeLink(t: EncodableTree, prefix: string, isStart: (id: number) => boolean): string {
  const effect = new Map(t.masteries);
  const a: number[] = [0, 0, 0, 6, t.classId, ((t.secondaryAscendClassId || 0) << 2) | t.ascendClassId];
  const nodeBytes: number[] = [];
  const clusterBytes: number[] = [];
  const masteryBytes: number[] = [];
  let nodeCount = 0;
  let clusterCount = 0;
  let masteryCount = 0;
  for (const id of t.nodes) {
    if (id < 65536) {
      if (isStart(id) || nodeCount >= 255) continue;
      nodeBytes.push(Math.floor(id / 256), id % 256);
      nodeCount++;
      const e = effect.get(id);
      if (e !== undefined) {
        masteryBytes.push(Math.floor(e / 256), e % 256, Math.floor(id / 256), id % 256);
        masteryCount++;
      }
    } else {
      const c = id - 65536;
      clusterBytes.push(Math.floor(c / 256), c % 256);
      clusterCount++;
    }
  }
  return prefix + toBase64Url([...a, nodeCount, ...nodeBytes, clusterCount, ...clusterBytes, masteryCount, ...masteryBytes]);
}

/**
 * The tree version a pasted link names (TreeTab.lua `validateTreeVersion`): `tree/3.15.0/` is 3_15, `tree/ruthless/` and
 * `tree/alternate/` are the latest version's sub-types. A version this app has no tree for falls back to the latest.
 */
export function versionFromLink(link: string, known: string[]): string {
  const sub = /tree\/([a-z]+-?[a-z]*)\//.exec(link)?.[1];
  const suffix = sub ? '_' + sub.replace(/-/g, '_') : '';
  const v = /tree\/(\d+)\.(\d+)\.\d+\//.exec(link);
  if (v) {
    const name = `${v[1]}_${v[2]}${suffix}`;
    if (known.includes(name)) return name;
  }
  const latest = LATEST_TREE_VERSION + suffix;
  return known.includes(latest) ? latest : LATEST_TREE_VERSION;
}

/** The spec element for an imported tree. */
export function importedSpecXml(title: string, version: string, d: DecodedTree): string {
  const eff = d.masteries.map(([n, e]) => `{${n},${e}}`).join(',');
  return `<Spec title="${escapeXml(title)}" treeVersion="${version}" classId="${d.classId}" ascendClassId="${d.ascendClassId}"${d.secondaryAscendClassId ? ` secondaryAscendClassId="${d.secondaryAscendClassId}"` : ''} masteryEffects="${eff}" nodes="${d.nodes.join(',')}">\n\t\t\t<Sockets>\n\t\t\t</Sockets>\n\t\t</Spec>`;
}

/** How a pasted link should be read. */
export type TreeLinkKind = 'poeurl' | 'build-site' | 'poeplanner' | 'ggg';

export function classifyTreeLink(link: string): TreeLinkKind {
  const t = link.trim();
  if (/poeurl\.com\//i.test(t)) return 'poeurl';
  if (/poeplanner\.com\//i.test(t)) return 'poeplanner';
  if (/^https?:\/\/(?:www\.)?(?:pobb\.in|poe\.ninja|pastebin\.com|pob\.codes|rentry\.co|maxroll\.gg|poedb\.tw)\//i.test(t) && !/pathofexile\.com|poeskilltree/i.test(t)) return 'build-site';
  return 'ggg';
}

export const specDisplayTitle = (title: string): string => title || 'Default';

/** The official site's address for a tree version (GameVersions.lua `url`): the prefix an exported link starts with. */
export function treeUrlPrefix(version: string): string {
  const base = 'https://www.pathofexile.com/passive-skill-tree/';
  const sub = /^\d+_\d+_(.+)$/.exec(version)?.[1];
  if (sub) return `${base}${sub.replace(/_/g, '-')}/`;
  const m = /^(\d+)_(\d+)$/.exec(version);
  if (!m) return base;
  return `${base}${m[1]}.${m[2]}.${version === '2_6' ? 2 : 0}/`;
}
