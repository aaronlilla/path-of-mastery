// What the Tree tab reads from the build text: socket groups, tree specs, the build header, and the attribute edits
// upstream's header controls make (level, main socket group, active tree spec). The engine recalculates after each.
import { parseXml, type XmlNode } from '../shared/buildXml.js';
import { LATEST_TREE_VERSION } from '../shared/treeSets.js';

export interface ActiveInfo {
  /** 1-based among the group's active (non-support) gems, as `mainActiveSkill` counts. */
  index: number;
  name: string;
  level?: number;
  quality?: number;
}

export interface SocketGroupInfo {
  /** 1-based, as the XML counts. */
  index: number;
  slot: string;
  link: number;
  summary: string;
  activeName: string;
  /** Number of support gems, and whether the group has its own label (then `summary` is that label). */
  supports: number;
  labelled: boolean;
  /** `mainActiveSkill`, 1-based among the actives. */
  main: number;
  actives: ActiveInfo[];
  enabled: boolean;
}

export interface SpecInfo {
  index: number;
  title: string;
  treeVersion: string;
  classId: number;
  ascendClassId: number;
  secondaryAscendClassId: number;
  nodes: number[];
  masteries: Array<[number, number]>;
  jewels: Array<[number, number]>;
}

export interface BuildHeader {
  level: number;
  auto: boolean;
  mainSocketGroup: number;
  /** The main socket group's `mainActiveSkill` (1-based). */
  mainActive: number;
  className: string;
  ascendClassName: string;
  activeSpec: number;
  specs: SpecInfo[];
  groups: SocketGroupInfo[];
  /** Spec index each loadout (upstream's "Loadouts") maps to; one loadout per tree spec here. */
  tooManyPoints?: boolean;
}

const kids = (n: XmlNode | undefined, tag: string) => n?.children.filter((c) => c.tag === tag) ?? [];
const isSupport = (g: XmlNode) => /^Support/.test(g.attrs.skillId ?? '') || / Support$/.test(g.attrs.nameSpec ?? '');

function groupsOf(root: XmlNode): SocketGroupInfo[] {
  const skills = kids(root, 'Skills')[0];
  if (!skills) return [];
  const sets = kids(skills, 'SkillSet');
  const set = sets.length ? sets.find((s) => s.attrs.id === skills.attrs.activeSkillSet) ?? sets[0]! : skills;
  return kids(set, 'Skill').map((s, i) => {
    const gems = kids(s, 'Gem');
    const actives: ActiveInfo[] = [];
    for (const g of gems) {
      if (isSupport(g) || g.attrs.enabled === 'false') continue;
      const name = g.attrs.nameSpec || g.attrs.skillId || '';
      if (name) actives.push({ index: actives.length + 1, name, level: Number(g.attrs.level) || undefined, quality: Number(g.attrs.quality) || 0 });
    }
    const main = Math.max(1, Number(s.attrs.mainActiveSkill) || 1);
    const first = actives[Math.min(main, actives.length) - 1];
    const names = gems.map((g) => g.attrs.nameSpec || g.attrs.skillId || '').filter(Boolean);
    const supports = names.length - actives.length;
    const summary = s.attrs.label || (first ? `${first.name}${supports > 0 ? ` +${supports} support${supports === 1 ? '' : 's'}` : ''}` : names.slice(0, 3).join(' · '));
    return { index: i + 1, slot: s.attrs.slot ?? '', link: gems.length, summary, activeName: first?.name ?? '', supports: Math.max(0, supports), labelled: !!s.attrs.label, main, actives, enabled: s.attrs.enabled !== 'false' };
  });
}

function pairs(text: string | undefined): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const m of (text ?? '').matchAll(/\{(\d+),(\d+)\}/g)) out.push([Number(m[1]), Number(m[2])]);
  return out;
}

export function readHeader(xml: string): BuildHeader | null {
  let root: XmlNode;
  try {
    root = parseXml(xml);
  } catch {
    return null;
  }
  const build = kids(root, 'Build')[0];
  if (!build) return null;
  const tree = kids(root, 'Tree')[0];
  const specs: SpecInfo[] = kids(tree, 'Spec').map((s, i) => ({
    index: i + 1,
    title: s.attrs.title ?? '',
    treeVersion: s.attrs.treeVersion ?? '',
    classId: Number(s.attrs.classId) || 0,
    ascendClassId: Number(s.attrs.ascendClassId) || 0,
    secondaryAscendClassId: Number(s.attrs.secondaryAscendClassId) || 0,
    nodes: (s.attrs.nodes ?? '').split(',').map(Number).filter((n) => Number.isFinite(n) && n > 0),
    masteries: pairs(s.attrs.masteryEffects),
    jewels: kids(s, 'Sockets').flatMap((x) => kids(x, 'Socket')).map((k) => [Number(k.attrs.nodeId), Number(k.attrs.itemId)] as [number, number]),
  }));
  const level = Number(build.attrs.level);
  const groups = groupsOf(root);
  const mainSocketGroup = Number(build.attrs.mainSocketGroup) || 1;
  return {
    level: Number.isFinite(level) && level > 0 ? level : 1,
    auto: build.attrs.characterLevelAutoMode === 'true',
    mainSocketGroup,
    mainActive: groups[mainSocketGroup - 1]?.main ?? 1,
    className: build.attrs.className ?? '',
    ascendClassName: build.attrs.ascendClassName && build.attrs.ascendClassName !== 'None' ? build.attrs.ascendClassName : '',
    activeSpec: Number(tree?.attrs.activeSpec) || 1,
    specs,
    groups,
  };
}

/** Sets an attribute on the first `<Build ...>` start tag, leaving every other byte as is. */
export function setBuildAttr(xml: string, name: string, value: string): string {
  return xml.replace(/<Build\b([^>]*)>/, (_m, attrs: string) => {
    const re = new RegExp(`(\\s${name}=)(["'])[^"']*\\2`);
    return re.test(attrs) ? `<Build${attrs.replace(re, `$1"${value}"`)}>` : `<Build${attrs} ${name}="${value}">`;
  });
}

/** The active spec's tree version; an old file whose spec has none is on the latest tree, as upstream reads it. */
export function specTreeVersion(xml: string): string {
  const h = readHeader(xml);
  return (h?.specs[h.activeSpec - 1] ?? h?.specs[0])?.treeVersion || LATEST_TREE_VERSION;
}

/**
 * `<Build className ascendClassName>` from the active spec's class and ascendancy, as upstream's `buildMode:Save` writes
 * them (`spec.curClassName`, `spec.curAscendClassName`). Edits change only the spec, so the file is brought in line on save.
 * `classes` is the spec's tree's class table; a class it does not know leaves the text as it is.
 */
export function withSpecClassNames(xml: string, classes: Record<number, { name: string; asc: Array<[number, string]> }>): string {
  const h = readHeader(xml);
  const spec = h?.specs[h.activeSpec - 1] ?? h?.specs[0];
  const cls = spec && classes[spec.classId];
  if (!cls) return xml;
  const asc = spec.ascendClassId ? cls.asc.find((a) => a[0] === spec.ascendClassId)?.[1] : 'None';
  return setBuildAttr(setBuildAttr(xml, 'className', cls.name), 'ascendClassName', asc ?? 'None');
}

/** Sets `activeSpec` on `<Tree>`. */
/** The name a tree set shows everywhere: its title, or "Default" when it has none (upstream does the same). */
export const specTitle = (s: { title: string }): string => s.title || 'Default';

export function setActiveSpec(xml: string, index: number): string {
  return xml.replace(/<Tree\b([^>]*)>/, (_m, attrs: string) => {
    const re = /(\sactiveSpec=)(["'])[^"']*\2/;
    return re.test(attrs) ? `<Tree${attrs.replace(re, `$1"${index}"`)}>` : `<Tree${attrs} activeSpec="${index}">`;
  });
}

/** Upstream's `EstimatePlayerProgress`: the level the passive points used call for, and the act. */
const ACTS: Array<[number, number]> = [[1, 0], [12, 2], [22, 4], [32, 6], [40, 7], [44, 9], [50, 12], [54, 15], [60, 18], [64, 20], [67, 23]];
export function estimateLevel(pointsUsed: number, extra: number): { level: number; act: number | 'Endgame'; questPoints: number; extraSkillpoints: number; lab: string } {
  let act = 0;
  let level = 1;
  do {
    act++;
    const [lv, qp] = ACTS[act - 1]!;
    level = Math.min(Math.max(pointsUsed + 1 - qp - (act > 2 ? extra : 0), lv), 100);
  } while (act < 11 && level > ACTS[act]![0]);
  // The lab upstream suggests for the level (a hint for people mapping out a new character).
  const lab = level < 33 ? '' : level < 55 ? 'Normal Lab' : level < 68 ? 'Cruel Lab' : level < 75 ? 'Merciless Lab' : level < 90 ? 'Uber Lab' : '';
  return { level, act: level < 90 && act <= 10 ? act : 'Endgame', questPoints: ACTS[act - 1]![1], extraSkillpoints: act > 2 ? extra : 0, lab };
}

/**
 * Whether an Auto-level build's level text must be rewritten now. `settled` is the level the points called for when it was
 * last looked at (null before the first look). Only a change in that level rewrites the text, so opening a build, flipping a
 * Config switch or changing an item leaves the level (and every number that depends on it) alone; an undo or redo, a manual
 * level and a text with no edits behind it just take the new level as the settled one.
 */
export function autoLevelStep(settled: number | null, estimate: number, c: { auto: boolean; stepping: boolean; edited: boolean; level: number }): { settled: number; apply: boolean } {
  if (settled === null || settled === estimate) return { settled: estimate, apply: false };
  if (!c.auto || c.stepping || !c.edited || c.level === estimate) return { settled: estimate, apply: false };
  return { settled: estimate, apply: true };
}

/** Start and end offsets of the `index`-th (1-based) `<Spec>` element of the build text. */
export function specRange(xml: string, index: number): { start: number; end: number; open: string } | null {
  const re = /<Spec\b[^>]*?(\/?)>/g;
  let n = 0;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    if (++n !== index) continue;
    const start = m.index;
    if (m[1] === '/') return { start, end: start + m[0].length, open: m[0] };
    const close = xml.indexOf('</Spec>', start);
    return close < 0 ? null : { start, end: close + '</Spec>'.length, open: m[0] };
  }
  return null;
}

const setAttrIn = (tag: string, name: string, value: string): string => {
  const re = new RegExp(`(\\s${name}=)(["'])[^"']*\\2`);
  return re.test(tag) ? tag.replace(re, `$1"${value}"`) : tag.replace(/^<Spec\b/, `<Spec ${name}="${value}"`);
};

/**
 * Converts a tree spec to another tree version the way upstream's Version dropdown does: the spec keeps its class,
 * ascendancies, jewels and allocated nodes and takes the other version's tree, which drops the nodes it doesn't have (the
 * engine does that when it loads the text). With `copy` the old spec stays and the converted one follows it and becomes the
 * active one; otherwise the spec is converted in place.
 */
export function convertSpecVersion(xml: string, index: number, version: string, copy: boolean): string {
  const r = specRange(xml, index);
  if (!r) return xml;
  const text = xml.slice(r.start, r.end);
  const converted = setAttrIn(text.slice(0, r.open.length), 'treeVersion', version) + text.slice(r.open.length);
  if (!copy) return xml.slice(0, r.start) + converted + xml.slice(r.end);
  return setActiveSpec(xml.slice(0, r.end) + converted + xml.slice(r.end), index + 1);
}
