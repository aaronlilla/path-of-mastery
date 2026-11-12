// Tattoos on the passive tree: which tattoos fit a node (upstream's ModifyNodePopup rules). Adding and removing one is
// the engine edit `setTattoo`.
import { luaPatternToRegExp } from './treeSearch.js';

export interface Tattoo {
  key: string;
  dn: string;
  sd: string[];
  reminder?: string;
  targetType: string;
  targetValue: string;
  minConnected: number;
  legacy?: boolean;
  icon: string;
  effectImage: string;
}

/** The node facts the rules look at. */
export interface TattooTarget {
  name: string;
  /** Normal, Notable, Keystone, Mastery... */
  type: string;
  /** The node's own first stat line. */
  firstStat: string;
  /** How many nodes link to it. */
  linked: number;
}

const luaFind = (hay: string, pattern: string): boolean => {
  const re = luaPatternToRegExp(pattern);
  return !!re && re.test(hay);
};

/** The tattoos that can replace this node's modifier, in upstream's list order. */
export function tattoosFor(all: Tattoo[], node: TattooTarget, showLegacy: boolean): Tattoo[] {
  const attr = node.name === 'Intelligence' || node.name === 'Strength' || node.name === 'Dexterity';
  return all
    .filter((t) => {
      const fits =
        luaFind(node.name, t.targetType.replace(/^Small /, '')) ||
        (t.targetValue !== '' && luaFind(node.firstStat, t.targetValue)) ||
        (t.targetType === 'Small Attribute' && attr) ||
        (t.targetType === 'Keystone' && node.type === 'Keystone');
      return fits && t.minConnected <= node.linked && (!t.legacy || showLegacy);
    })
    .sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
}

/** Upstream's sort text for its list (`label` there: the name, 48 spaces, the lines joined by commas), compared byte by byte. */
const sortKey = (t: Tattoo): string => t.dn + ' '.repeat(48) + t.sd.join(',');

export const label = (t: Tattoo): string => `${t.dn} – ${t.sd.join(', ')}`;

/** The lines the dialog prints under the picker for one tattoo. */
export const descriptionOf = (t: Tattoo): string[] => (t.reminder ? [...t.sd, t.reminder] : t.sd);

/**
 * Whether a node may be right-clicked for a tattoo (`PassiveTreeView`'s right click): a tattooed node, an attribute node, a +30
 * attribute notable, a keystone, or a mastery that is not allocated yet (upstream offers runegrafts there). Ascendancy nodes
 * are not left out: upstream does not leave them out.
 */
export function tattooEligible(node: TattooTarget & { tattooed: boolean; unallocatedMastery?: boolean }): boolean {
  if (node.tattooed || node.type === 'Keystone' || node.unallocatedMastery) return true;
  if (node.type === 'Normal' && /^(Strength|Dexterity|Intelligence)$/.test(node.name)) return true;
  return node.type === 'Notable' && /\+30 to (Dexterity|Strength|Intelligence)/.test(node.firstStat);
}

/** The build text's tattoo count for a tree set (upstream counts every tattoo override that is not a runegraft). */
export function tattooCount(xml: string, specIndex: number): number {
  const re = /<Spec\b[^>]*?(\/?)>/g;
  let n = 0;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    if (++n !== specIndex) continue;
    if (m[1] === '/') return 0;
    const close = xml.indexOf('</Spec>', m.index);
    const body = xml.slice(m.index, close < 0 ? undefined : close);
    return (body.match(/<Override\b[^>]*\bdn="(?!Runegraft)[^"]*"/g) ?? []).filter((x) => !/dn="[^"]*Runegraft/.test(x)).length;
  }
  return 0;
}

/** The tattoos of a tree as the tree state lists them: every tattoo that is not a runegraft. */
export const countedTattoos = <T extends { name: string; tattoo?: boolean; isTattoo?: boolean }>(nodes: T[]): T[] => nodes.filter((n) => (n.tattoo || n.isTattoo) && !n.name.includes('Runegraft'));

/**
 * The "Tattoo Count" tooltip of upstream (`getTattooCount`): each distinct tattoo text with how many nodes carry it,
 * "(2) +5% to Fire Resistance". The stat lines join with a space; the "Limited" and "Requires" lines of legacy tattoos are left out.
 */
export function tattooTooltip(nodes: Array<{ name: string; stats: string[]; tattoo?: boolean; isTattoo?: boolean }>): string {
  const counts = new Map<string, number>();
  for (const n of countedTattoos(nodes)) {
    const text = n.stats.filter((l) => !/Limited|Requires/.test(l)).join(' ');
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  return [...counts].map(([text, n]) => `(${n}) ${text}`).join('\n');
}
