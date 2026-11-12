import { readItems, activeSetOf } from './itemsXml.js';
import { parseXml } from './buildXml.js';

/** Reads and writes the bits of build text the Import/Export tab owns. */

/** The Export Support switch: the `exportParty` attribute of `<Import>`, as upstream saves it. */
export function readExportParty(xml: string): boolean {
  const m = /<Import\b([^>]*?)\/?>/.exec(xml);
  return !!m && /\bexportParty="true"/.test(m[1]!);
}

export function setExportParty(xml: string, on: boolean): string {
  const value = on ? 'true' : 'false';
  const m = /<Import\b([^>]*?)(\/?)>/.exec(xml);
  if (m) {
    const attrs = /\bexportParty="[^"]*"/.test(m[1]!) ? m[1]!.replace(/\bexportParty="[^"]*"/, `exportParty="${value}"`) : `${m[1]!.trimEnd()} exportParty="${value}"`;
    return xml.slice(0, m.index) + `<Import${attrs}${m[2] ? ' /' : ''}>` + xml.slice(m.index + m[0].length);
  }
  const eol = xml.includes('\r\n') ? '\r\n' : '\n';
  const build = /<\/Build>|<Build\b[^>]*?\/>/.exec(xml);
  if (!build) return xml;
  const at = build.index + build[0].length;
  return xml.slice(0, at) + `${eol}\t<Import exportParty="${value}" />` + xml.slice(at);
}

export interface BuildCounts {
  /** Jewels sitting in tree sockets. */
  jewels: number;
  /** Items in the active item set's slots, tree jewels not counted. */
  items: number;
  /** Socket groups of the active skill set. */
  skillGroups: number;
  /** Passive nodes allocated in the active spec. */
  nodes: number;
}

/** What an import would replace: the numbers in "Delete 4 jewels first". */
export function buildCounts(xml: string): BuildCounts {
  if (!xml.trim()) return { jewels: 0, items: 0, skillGroups: 0, nodes: 0 };
  const m = readItems(xml);
  const spec = m.specs[m.activeSpec - 1] ?? m.specs[0];
  const jewels = [...(spec?.sockets.values() ?? [])].filter((i) => i > 0).length;
  const items = [...(m.sets.length ? activeSetOf(m).slots : new Map<string, { itemId: number }>()).entries()].filter(([name, s]) => s.itemId > 0 && !/^Jewel /.test(name)).length;
  let skillGroups = 0;
  let nodes = 0;
  try {
    const root = parseXml(xml);
    const skills = root.children.find((c) => c.tag === 'Skills');
    if (skills) {
      const sets = skills.children.filter((c) => c.tag === 'SkillSet');
      const set = sets.length ? (sets.find((s) => (s.attrs.id ?? '1') === (skills.attrs.activeSkillSet ?? '1')) ?? sets[0]!) : skills;
      skillGroups = set.children.filter((c) => c.tag === 'Skill').length;
    }
    const tree = root.children.find((c) => c.tag === 'Tree');
    const specs = tree?.children.filter((c) => c.tag === 'Spec') ?? [];
    const active = specs[(parseInt(tree?.attrs.activeSpec ?? '1', 10) || 1) - 1] ?? specs[0];
    const list = active?.attrs.nodes ?? '';
    nodes = list ? list.split(',').filter(Boolean).length : 0;
  } catch {
    /* unreadable text: no counts */
  }
  return { jewels, items, skillGroups, nodes };
}
