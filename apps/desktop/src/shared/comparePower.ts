/**
 * The Compare tab's Power Report (CompareTab.lua `ComparePowerBuilder`): every element of the compared build that this
 * build does not have, tried in this build on its own through the engine's `previewEdit`, and the change it makes to
 * the chosen stat. This file plans the tries and reads the answers; the tab runs them.
 *
 * Differences from upstream, all in what is skipped: jewels in sockets this build has not allocated (upstream
 * tries every socket), abyssal jewels of a swapped item, and minion stats (the engine output has none).
 */
import type { BuildEdit } from '@pom/protocol';
import { activeConfigOf, activeGroupsOf, activeSpecOf, addGemXml, addGroupXml, equipped, setJewelXml, swapItemsXml, type BuildFacts, type ConfigValue } from './buildFacts.js';
import type { TreeNodeInfo } from './library.js';

export interface ConfigOption {
  var: string;
  type: string;
  label: string;
  section: string;
  apply?: boolean;
  list?: { val: string; label: string }[];
  /** `defaultState` / `defaultIndex` of upstream's option: what its input holds when a build never saved it. */
  defaultState?: boolean | number;
  defaultIndex?: number;
}

export interface ConfigSchema {
  sections: { name: string; col: number }[];
  options: ConfigOption[];
}

export interface PowerStat {
  stat: string;
  label: string;
  /** Upstream negates "taken damage" stats so that a higher number is better. */
  negate?: boolean;
}

/** `data.powerStatList` of upstream (the entries a node can be measured by). */
export const POWER_STATS: PowerStat[] = [
  { stat: 'FullDPS', label: 'Full DPS' },
  { stat: 'CombinedDPS', label: 'Combined DPS' },
  { stat: 'TotalDPS', label: 'Hit DPS' },
  { stat: 'WithImpaleDPS', label: 'Impale + Hit DPS' },
  { stat: 'AverageDamage', label: 'Average Hit' },
  { stat: 'Speed', label: 'Attack/Cast Speed' },
  { stat: 'TotalDot', label: 'DoT DPS' },
  { stat: 'BleedDPS', label: 'Bleed DPS' },
  { stat: 'IgniteDPS', label: 'Ignite DPS' },
  { stat: 'PoisonDPS', label: 'Poison DPS' },
  { stat: 'Life', label: 'Life' },
  { stat: 'LifeRegen', label: 'Life regen' },
  { stat: 'LifeLeechRate', label: 'Life leech' },
  { stat: 'Armour', label: 'Armour' },
  { stat: 'Evasion', label: 'Evasion' },
  { stat: 'EnergyShield', label: 'Energy Shield' },
  { stat: 'EnergyShieldRecoveryCap', label: 'Recoverable ES' },
  { stat: 'EnergyShieldRegen', label: 'Energy Shield regen' },
  { stat: 'EnergyShieldLeechRate', label: 'Energy Shield leech' },
  { stat: 'Mana', label: 'Mana' },
  { stat: 'ManaRegen', label: 'Mana regen' },
  { stat: 'ManaLeechRate', label: 'Mana leech' },
  { stat: 'Ward', label: 'Ward' },
  { stat: 'Str', label: 'Strength' },
  { stat: 'Dex', label: 'Dexterity' },
  { stat: 'Int', label: 'Intelligence' },
  { stat: 'TotalAttr', label: 'Total Attributes' },
  { stat: 'MeleeAvoidChance', label: 'Melee avoid chance' },
  { stat: 'SpellAvoidChance', label: 'Spell avoid chance' },
  { stat: 'ProjectileAvoidChance', label: 'Projectile avoid chance' },
  { stat: 'TotalEHP', label: 'Effective Hit Pool' },
  { stat: 'SecondMinimalMaximumHitTaken', label: 'Eff. Maximum Hit Taken' },
  { stat: 'PhysicalTakenHit', label: 'Taken Phys dmg', negate: true },
  { stat: 'LightningTakenHit', label: 'Taken Lightning dmg', negate: true },
  { stat: 'ColdTakenHit', label: 'Taken Cold dmg', negate: true },
  { stat: 'FireTakenHit', label: 'Taken Fire dmg', negate: true },
  { stat: 'ChaosTakenHit', label: 'Taken Chaos dmg', negate: true },
  { stat: 'CritChance', label: 'Crit Chance' },
  { stat: 'CritMultiplier', label: 'Crit Multiplier' },
  { stat: 'BleedChance', label: 'Bleed Chance' },
  { stat: 'FreezeChance', label: 'Freeze Chance' },
  { stat: 'IgniteChance', label: 'Ignite Chance' },
  { stat: 'ShockChance', label: 'Shock Chance' },
  { stat: 'EffectiveMovementSpeedMod', label: 'Move speed' },
  { stat: 'LightRadiusMod', label: 'Light Radius' },
  { stat: 'BlockChance', label: 'Block Chance' },
  { stat: 'SpellBlockChance', label: 'Spell Block Chance' },
  { stat: 'SpellSuppressionChance', label: 'Spell Suppression Chance' },
];

export type PowerCategory = 'Tree' | 'Items' | 'Skill gems' | 'Support gems' | 'Config';
export const POWER_CATEGORIES: PowerCategory[] = ['Tree', 'Items', 'Skill gems', 'Support gems', 'Config'];

export interface PowerTask {
  id: string;
  category: PowerCategory;
  kind: 'tree' | 'item' | 'gem' | 'support' | 'config';
  /** The thing's name; for config, the option with the change. */
  name: string;
  /** What names the art and colour: an item's name, a gem's name, a node's type. */
  art?: string;
  rarity?: string;
  /** A passive node's icon in the tree's skill sheet: x, y and size. */
  sprite?: [number, number, number];
  edit: BuildEdit;
  /** Other ways to try the same element; the best result of `edit` and these is the answer (a jewel in each socket). */
  alternatives?: BuildEdit[];
  /** The name shown gets this added when an alternative gave the best result. */
  bestNote?: string;
  /** Tasks with the same key give the same answer (tree nodes with the same mods), so it is asked once. */
  cacheKey?: string;
  /** A passive node: how many points it takes to reach it from this build's tree (the report's Points column). */
  points?: number;
  /** A passive node's id, for its tooltip. */
  nodeId?: number;
  /** An item: its slot, so the report can show the item's tooltip. */
  slot?: string;
  /** The item text, for its tooltip. */
  itemText?: string;
}

export interface PowerInputs {
  primary: BuildFacts;
  primaryXml: string;
  /** The nodes this build has allocated, from the engine. */
  primaryNodes: number[];
  compare: BuildFacts;
  /** Passive node names and types for the compared build's tree version; null when the data is not available. */
  nodes: Record<string, TreeNodeInfo> | null;
  schema: ConfigSchema;
  /** Every jewel socket node of this build's passive tree. */
  socketNodes?: number[];
  /** Whether a gem name is a support gem. */
  isSupport: (name: string, skillId: string) => boolean;
  categories: Record<PowerCategory, boolean>;
  /** Points to reach each unallocated node from this build's tree (the report's Points column). */
  treeDist?: Map<number, number>;
}

const BASE_SLOTS = ['Weapon 1', 'Weapon 2', 'Helmet', 'Body Armour', 'Gloves', 'Boots', 'Amulet', 'Ring 1', 'Ring 2', 'Belt', 'Flask 1', 'Flask 2', 'Flask 3', 'Flask 4', 'Flask 5'];

/** The slots the Items view and the report list: the base slots, a third ring when either build has one. */
export function itemSlots(a: BuildFacts, b: BuildFacts): string[] {
  const slots = [...BASE_SLOTS];
  const ring3 = [a, b].some((f) => equipped(f).has('Ring 3'));
  if (ring3) slots.splice(10, 0, 'Ring 3');
  // The second weapon set is listed when either build has something in it.
  const swap = ['Weapon 1 Swap', 'Weapon 2 Swap'].filter((n) => [a, b].some((f) => equipped(f).has(n)));
  if (swap.length) slots.splice(2, 0, ...swap);
  return slots;
}

const ABYSS_BASES = ['Weapon 1', 'Weapon 2', 'Weapon 1 Swap', 'Weapon 2 Swap', 'Helmet', 'Body Armour', 'Gloves', 'Boots', 'Belt'];

/** Abyssal socket slots (`Helmet Abyssal Socket 2`) that both builds' items have. */
export function abyssSlots(a: BuildFacts, b: BuildFacts): string[] {
  const ea = equipped(a);
  const eb = equipped(b);
  const out: string[] = [];
  for (const slot of ABYSS_BASES) for (let n = 1; n <= 6; n++) if ((ea.get(slot)?.abyssal ?? 0) >= n && (eb.get(slot)?.abyssal ?? 0) >= n) out.push(`${slot} Abyssal Socket ${n}`);
  return out;
}

const stripColour = (s: string): string => s.replace(/\^x[0-9A-Fa-f]{6}|\^\d/g, '');

/** What a config value reads as in the list: Yes/No for checks, the choice's label for lists. */
export function configText(opt: ConfigOption, v: ConfigValue | undefined): string {
  if (v === undefined) return '(not set)';
  if (opt.type === 'check') return v ? 'Yes' : 'No';
  if (opt.type === 'list' && opt.list) return opt.list.find((i) => i.val === v)?.label ?? String(v);
  return String(v);
}

/** The value an option's input has before anything is saved (ConfigTab.lua:673-691), or undefined when it has none. */
export function defaultOf(opt: ConfigOption): ConfigValue | undefined {
  if (opt.type === 'list' && opt.defaultIndex !== undefined) return opt.list?.[opt.defaultIndex - 1]?.val;
  return opt.defaultState;
}

/**
 * A build's config the way upstream's `configTab.input` holds it for the Compare tab: every option's default, then the
 * inputs the build saved. A saved build only lists what differs from the defaults, so a missing input means its default,
 * not "off". The quest and pantheon picks kept in <Build> only count for a build with no <Config> at all
 * (`ConfigTab:Load` starts from fresh config sets and drops what Build.lua put in the input before it).
 */
export function effectiveConfig(f: BuildFacts, schema: ConfigSchema): Map<string, ConfigValue> {
  const out = new Map<string, ConfigValue>();
  for (const o of schema.options) {
    const d = defaultOf(o);
    if (d !== undefined) out.set(o.var, d);
  }
  if (!f.configSets.length) for (const [k, v] of Object.entries(f.picks)) out.set(k, v);
  for (const [k, v] of activeConfigOf(f)) out.set(k, v);
  return out;
}

/** Config values that act the same compare equal: a missing check is off, a missing count is zero. */
export function normaliseConfig(opt: ConfigOption, p: ConfigValue | undefined, c: ConfigValue | undefined): [ConfigValue | undefined, ConfigValue | undefined] {
  if (opt.type === 'check') return [p ?? false, c ?? false];
  if (opt.type === 'count' || opt.type === 'integer' || opt.type === 'float') return [p ?? 0, c ?? 0];
  return [p, c];
}

const groupSignature = (g: { gems: { name: string }[] }): string =>
  g.gems
    .map((x) => x.name)
    .filter(Boolean)
    .sort()
    .join('+');

/** The tries the report makes, in upstream's order: tree, items, skill groups, support gems, config. */
export function planPower(i: PowerInputs): PowerTask[] {
  const tasks: PowerTask[] = [];
  const { primary, compare } = i;
  if (i.categories.Tree && i.nodes) {
    const have = new Set(i.primaryNodes);
    const cSpec = activeSpecOf(compare);
    for (const id of cSpec?.nodes ?? []) {
      const n = i.nodes[String(id)];
      if (have.has(id) || !n || !(n.t === 'Normal' || n.t === 'Notable' || n.t === 'Keystone') || n.a || !n.k) continue;
      tasks.push({ id: `tree:${id}`, category: 'Tree', kind: 'tree', name: n.n, art: n.t, sprite: n.sp, nodeId: id, points: i.treeDist?.get(id), edit: { kind: 'addNodes', nodeIds: [id] }, cacheKey: `tree:${n.k}` });
    }
  }
  if (i.categories.Items) {
    const cEq = equipped(compare);
    const pEq = equipped(primary);
    for (const slot of itemSlots(primary, compare)) {
      const c = cEq.get(slot);
      if (!c || pEq.get(slot)?.name === c.name) continue;
      if (c.abyssal > 0) {
        // The swapped item brings its abyssal jewels: this build's are taken out of those sockets, B's put in.
        const also: Array<[string, string | null]> = [];
        let n = 0;
        for (let k = 1; k <= c.abyssal; k++) {
          const sl = `${slot} Abyssal Socket ${k}`;
          const j = cEq.get(sl);
          also.push([sl, j ? j.raw : null]);
          if (j) n++;
        }
        tasks.push({ id: `item:${slot}`, category: 'Items', kind: 'item', name: `${c.name}, ${slot}${n ? `, ${n} Jewel${n > 1 ? 's' : ''}` : ''}`, art: c.rarity === 'UNIQUE' ? c.name : c.base, rarity: c.rarity, slot, itemText: c.raw, edit: { kind: 'setXml', xml: swapItemsXml(i.primaryXml, slot, c.raw, also) } });
        continue;
      }
      tasks.push({ id: `item:${slot}`, category: 'Items', kind: 'item', name: `${c.name}, ${slot}`, art: c.rarity === 'UNIQUE' ? c.name : c.base, rarity: c.rarity, slot, itemText: c.raw, edit: { kind: 'setItem', slot, itemText: c.raw } });
    }
    // Abyssal jewels in the item slots the two builds share (an item with that many abyssal sockets on both sides).
    for (const slot of abyssSlots(primary, compare)) {
      const c = cEq.get(slot);
      if (!c || pEq.get(slot)?.name === c.name) continue;
      tasks.push({ id: `item:${slot}`, category: 'Items', kind: 'item', name: `${c.name}, ${slot}`, art: c.rarity === 'UNIQUE' ? c.name : c.base, rarity: c.rarity, slot, itemText: c.raw, edit: { kind: 'setItem', slot, itemText: c.raw } });
    }
    // Jewels in tree sockets (GetJewelComparisonSlots): the union of sockets holding a jewel in either build.
    const pSpec = activeSpecOf(primary);
    const cSpec = activeSpecOf(compare);
    const have = new Set(i.primaryNodes);
    const sockets = [...new Set([...(pSpec?.jewels.keys() ?? []), ...(cSpec?.jewels.keys() ?? [])])].sort((x, y) => x - y);
    // The socket's label in upstream: "Socket #n" by rank among the sockets this build has allocated, else plain "Socket".
    const allocSockets = (i.socketNodes ?? []).filter((n) => have.has(n)).sort((x, y) => x - y);
    const labelOf = (node: number): string => (!i.socketNodes ? `Jewel ${node}` : have.has(node) ? `Socket #${allocSockets.indexOf(node) + 1}` : 'Socket');
    for (const node of sockets) {
      const cItem = compare.items.get(cSpec?.jewels.get(node) ?? 0);
      const pItem = primary.items.get(pSpec?.jewels.get(node) ?? 0);
      if (!cItem || pItem?.name === cItem.name) continue;
      const art = cItem.rarity === 'UNIQUE' ? cItem.name : cItem.base;
      if (have.has(node)) {
        tasks.push({ id: `jewel:${node}`, category: 'Items', kind: 'item', name: `${cItem.name}, ${labelOf(node)}`, art, rarity: cItem.rarity, slot: `Jewel ${node}`, itemText: cItem.raw, edit: { kind: 'setXml', xml: setJewelXml(i.primaryXml, node, cItem.raw) } });
        continue;
      }
      // The socket is not allocated here: try the jewel in every socket of this tree, counting that socket as allocated.
      const tries: BuildEdit[] = (i.socketNodes ?? []).map((sn) => ({ kind: 'addNodes', nodeIds: have.has(sn) ? [] : [sn], xml: setJewelXml(i.primaryXml, sn, cItem.raw) }));
      if (!tries.length) continue;
      tasks.push({ id: `jewel:${node}`, category: 'Items', kind: 'item', name: `${cItem.name}, ${labelOf(node)}`, art, rarity: cItem.rarity, slot: `Jewel ${node}`, itemText: cItem.raw, edit: tries[0]!, alternatives: tries.slice(1), bestNote: ' (best socket)' });
    }
  }
  const pGroups = activeGroupsOf(primary);
  if (i.categories['Skill gems']) {
    const have = new Set(pGroups.map(groupSignature));
    for (const [n, g] of activeGroupsOf(compare).entries()) {
      const sig = groupSignature(g);
      if (!sig || have.has(sig)) continue;
      const actives = g.gems.filter((x) => x.name && !i.isSupport(x.name, x.skillId)).map((x) => x.name);
      const label = (actives.length ? actives : g.gems.map((x) => x.name).filter(Boolean)).join(' + ') || '(empty group)';
      tasks.push({ id: `gem:${n}`, category: 'Skill gems', kind: 'gem', name: label, art: (actives[0] ?? g.gems[0]?.name) || undefined, edit: { kind: 'setXml', xml: addGroupXml(i.primaryXml, g.xml) } });
    }
  }
  if (i.categories['Support gems']) {
    const cMain = activeGroupsOf(compare)[compare.mainSocketGroup - 1];
    const pMain = pGroups[primary.mainSocketGroup - 1];
    if (cMain && pMain) {
      const names = new Set(pMain.gems.filter((x) => i.isSupport(x.name, x.skillId)).map((x) => x.name));
      for (const gem of cMain.gems) {
        if (!gem.name || !i.isSupport(gem.name, gem.skillId) || names.has(gem.name)) continue;
        tasks.push({ id: `support:${gem.name}`, category: 'Support gems', kind: 'support', name: gem.name, art: gem.name, edit: { kind: 'setXml', xml: addGemXml(i.primaryXml, primary.mainSocketGroup, gem.xml) } });
      }
    }
  }
  if (i.categories.Config) {
    const pIn = activeConfigOf(primary);
    const cIn = activeConfigOf(compare);
    for (const opt of i.schema.options) {
      if (!opt.apply || opt.type === 'text') continue;
      const p = pIn.get(opt.var);
      const c = cIn.get(opt.var);
      const [pn, cn] = normaliseConfig(opt, p, c);
      if (String(pn) === String(cn)) continue;
      tasks.push({
        id: `cfg:${opt.var}`,
        category: 'Config',
        kind: 'config',
        name: `${stripColour(opt.label).replace(/:$/, '')}  (${configText(opt, p)} -> ${configText(opt, c)})`,
        edit: { kind: 'setConfig', key: opt.var, value: c === undefined ? null : c },
      });
    }
  }
  return tasks;
}

/** The value of a power stat in an output: upstream negates the taken-damage stats; stats the output lacks read 0. */
export function powerValue(stat: PowerStat, value: unknown): number {
  const v = typeof value === 'number' ? value : value === 'Inf' ? Infinity : 0;
  return stat.negate ? -v : v;
}

/** The change a try made to the power stat, from the engine's changed-stat list. 0 when the stat did not move. */
export function impactOf(stat: PowerStat, changed: { statId: string; before: unknown; after: unknown }[]): number {
  const c = changed.find((x) => x.statId === stat.stat);
  if (!c) return 0;
  const d = powerValue(stat, c.after) - powerValue(stat, c.before);
  return Number.isFinite(d) ? d : 0;
}

export interface PowerRow {
  task: PowerTask;
  /** Added to the name: which alternative won ("(best socket)"). */
  note: string;
  impact: number;
  /** The impact as a percentage of this build's value of the stat, or null when that is zero. */
  percent: number | null;
}

/** The report rows: tries that changed the stat, biggest gain first. */
export function powerRows(tasks: PowerTask[], impacts: (number | null)[], base: number, notes: string[] = []): PowerRow[] {
  const out: PowerRow[] = [];
  tasks.forEach((task, i) => {
    const impact = impacts[i];
    if (impact === null || impact === undefined || impact === 0) return;
    out.push({ task, note: notes[i] ?? '', impact, percent: base !== 0 ? (impact / Math.abs(base)) * 100 : null });
  });
  return out.sort((a, b) => b.impact - a.impact);
}
