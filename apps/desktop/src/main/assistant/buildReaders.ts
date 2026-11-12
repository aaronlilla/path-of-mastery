import { createHash } from 'node:crypto';
import { activeSetOf, readItems } from '../../shared/itemsXml.js';
import { getNotes, parseXml, readBuildInfo, type XmlNode } from '../../shared/buildXml.js';

/** Plain reads of a build file for the assistant's tools. The engine stays the source of every calculated number. */

export function xmlHash(xml: string): string {
  return createHash('sha1').update(xml).digest('hex');
}

function kids(n: XmlNode | undefined, tag: string): XmlNode[] {
  return n?.children.filter((c) => c.tag === tag) ?? [];
}

export interface GemRead {
  index: number;
  name: string;
  level: number | null;
  quality: number | null;
  enabled: boolean;
  support: boolean;
}
export interface GroupRead {
  index: number;
  label: string;
  slot: string;
  enabled: boolean;
  includeInFullDPS: boolean;
  isMain: boolean;
  gems: GemRead[];
}

/** The active skill set's socket groups, numbered from 1 as the engine's edits number them. */
export function readSkills(xml: string): GroupRead[] {
  const root = parseXml(xml);
  const skills = kids(root, 'Skills')[0];
  if (!skills) return [];
  const sets = kids(skills, 'SkillSet');
  let groups: XmlNode[];
  if (sets.length) {
    const active = sets.find((s) => s.attrs.id === (skills.attrs.activeSkillSet ?? '1')) ?? sets[0]!;
    groups = kids(active, 'Skill');
  } else {
    groups = kids(skills, 'Skill');
  }
  const mainGroup = parseInt(kids(root, 'Build')[0]?.attrs.mainSocketGroup ?? '1', 10) || 1;
  return groups.map((g, i) => ({
    index: i + 1,
    label: g.attrs.label ?? '',
    slot: g.attrs.slot ?? '',
    enabled: g.attrs.enabled !== 'false',
    includeInFullDPS: g.attrs.includeInFullDPS === 'true',
    isMain: i + 1 === mainGroup,
    gems: kids(g, 'Gem').map((gem, j) => {
      const name = gem.attrs.nameSpec || gem.attrs.skillId || '';
      const lv = parseInt(gem.attrs.level ?? '', 10);
      const q = parseInt(gem.attrs.quality ?? '', 10);
      return {
        index: j + 1,
        name,
        level: Number.isFinite(lv) ? lv : null,
        quality: Number.isFinite(q) ? q : null,
        enabled: gem.attrs.enabled !== 'false',
        support: /^Support/.test(gem.attrs.skillId ?? '') || / Support$/.test(name),
      };
    }),
  }));
}

export interface ConfigRead {
  name: string;
  value: string | number | boolean;
}

/** The active config set's inputs. */
export function readConfig(xml: string): ConfigRead[] {
  const root = parseXml(xml);
  const config = kids(root, 'Config')[0];
  if (!config) return [];
  const sets = kids(config, 'ConfigSet');
  const holder = sets.length ? (sets.find((s) => s.attrs.id === (config.attrs.activeConfigSet ?? '1')) ?? sets[0]!) : config;
  const out: ConfigRead[] = [];
  for (const i of kids(holder, 'Input')) {
    const name = i.attrs.name;
    if (!name) continue;
    if (i.attrs.boolean !== undefined) out.push({ name, value: i.attrs.boolean === 'true' });
    else if (i.attrs.number !== undefined) out.push({ name, value: Number(i.attrs.number) });
    else if (i.attrs.string !== undefined) out.push({ name, value: i.attrs.string });
  }
  return out;
}

export interface ItemRead {
  slot: string;
  name: string;
  rarity: string;
  base: string;
  text: string;
}

/** The items in the active item set's slots. Item text is player- or game-supplied and is passed on as data only. */
export function readEquipped(xml: string): ItemRead[] {
  const model = readItems(xml);
  const set = activeSetOf(model);
  const byId = new Map(model.items.map((i) => [i.id, i.text]));
  const out: ItemRead[] = [];
  for (const [slot, ref] of set.slots) {
    if (!ref.itemId) continue;
    const text = byId.get(ref.itemId);
    if (!text) continue;
    const lines = text.split('\n');
    const rarity = (lines[0] ?? '').replace(/^Rarity:\s*/i, '').trim();
    out.push({ slot, name: (lines[1] ?? '').trim(), rarity, base: (lines[2] ?? '').trim(), text });
  }
  return out;
}

export function readBuildMeta(xml: string): { className: string; ascendClassName: string; level: number; mainSkill: string; treeVersion: string; notes: string } {
  const info = readBuildInfo(xml);
  return { className: info.className, ascendClassName: info.ascendClassName, level: info.level, mainSkill: info.mainSkill, treeVersion: info.treeVersion, notes: getNotes(xml) };
}
