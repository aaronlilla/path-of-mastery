import { parseXml, type XmlNode } from '../buildXml.js';
import { CLASS_OF_TYPE, GEAR_KINDS, classOfBase, type RawBase } from './bases.js';
import type { BuildStageId } from './types.js';
import type { LevelingProfileLite } from '../leveling/types.js';

/**
 * Everything the Build Filter knows about one build, read from the build file and the engine's data tables.
 * Pure: no files, no network. Every derived field carries a `why` the preview and the assistant print word for word.
 */

export type Colour = 'R' | 'G' | 'B' | 'W';

/** The engine data the profile needs, reduced: the main process builds it with `reduceGameData` and sends it over. */
export interface GameGem {
  name: string;
  support: boolean;
  colour: Colour;
  /** Keys of the granted effect's weaponTypes, like "Bow" or "None". */
  weaponTypes: string[];
  /** The gem's game id when it differs from the record key (a variant record like SkillGemSpectralShieldThrow is `SkillGemThrownShieldProjectile`); the leveling data is keyed by it. */
  gameId?: string;
}

export interface GameData {
  bases: Record<string, RawBase>;
  /** By gemId (`Metadata/Items/Gems/...`), under both spellings the engine and build files use. */
  gems: Record<string, GameGem>;
  /** Lower-case gem name to gemId. */
  gemByName: Record<string, string>;
  /** Item names of the Vaal versions of a gem, by the gemId of the gem they are made from (transfigured gems have their own). */
  vaalByBase?: Record<string, string[]>;
}

interface RawGem {
  name?: string;
  baseTypeName?: string;
  gameId?: string;
  reqStr?: number;
  reqDex?: number;
  reqInt?: number;
  grantedEffect?: { support?: boolean; weaponTypes?: Record<string, boolean> };
}

export function gemColour(g: { reqStr?: number; reqDex?: number; reqInt?: number }): Colour {
  const s = g.reqStr ?? 0;
  const d = g.reqDex ?? 0;
  const i = g.reqInt ?? 0;
  const m = Math.max(s, d, i);
  if (m <= 0) return 'W';
  return s === m ? 'R' : d === m ? 'G' : 'B';
}

/** Reduces `data_itemBases.json`, `data_gems.json` and `data_gemForBaseName.json` to a `GameData`. */
export function reduceGameData(raw: { itemBases: Record<string, RawBase>; gems: Record<string, RawGem>; gemForBaseName?: Record<string, string>; /** `data_gemVaalGemIdForBaseGemId.json`: Vaal gemId to the gemId it is made from. */ vaalForBase?: Record<string, string> }): GameData {
  const gems: Record<string, GameGem> = {};
  for (const [key, g] of Object.entries(raw.gems)) {
    const v: GameGem = { name: g.name ?? g.baseTypeName ?? key, support: !!g.grantedEffect?.support, colour: gemColour(g), weaponTypes: Object.keys(g.grantedEffect?.weaponTypes ?? {}), ...(g.gameId && g.gameId !== key ? { gameId: g.gameId } : {}) };
    gems[key] = v;
    if (g.gameId && !gems[g.gameId]) gems[g.gameId] = v;
  }
  const vaalByBase: Record<string, string[]> = {};
  for (const [vaalId, baseId] of Object.entries(raw.vaalForBase ?? {})) {
    const name = raw.gems[vaalId]?.name ?? raw.gems[vaalId]?.baseTypeName;
    if (name) (vaalByBase[baseId] ??= []).push(name);
  }
  return { bases: raw.itemBases, gems, gemByName: raw.gemForBaseName ?? {}, ...(raw.vaalForBase ? { vaalByBase } : {}) };
}

/** The build's name as every screen prints it: the ascendancy (or class) and the main skill the profile picked. */
export function buildLead(p: Pick<BuildProfile, 'ascendancy' | 'className' | 'mainSkill'>): string {
  return [p.ascendancy || p.className, p.mainSkill?.name].filter(Boolean).join(' · ');
}

export interface Why {
  why: string;
}

export interface GemRef {
  gemId: string;
  name: string;
  /** What BaseType matches in the game: supports end in " Support". */
  itemName: string;
  support: boolean;
  colour: Colour;
  /** A transfigured gem, with the gem it is made from. */
  transfigured: boolean;
  baseGemId?: string;
  weaponTypes: string[];
}

export interface SkillGroupReq extends Why {
  slot: string;
  /** The active gem first, then the supports in file order. */
  gems: GemRef[];
  main: boolean;
  /** How many sockets the group asks for: its gems, capped at what the slot can hold. */
  size: number;
  /** The sorted colours of the first `size` gems, like `GGGGGB`. */
  colours: string;
}

export interface SlotUse extends Why {
  slot: string;
  name: string;
  base: string;
  rarity: string;
  class: string;
  itemLevel?: number;
}

export type Archetype = { tag: string } & Why & { base?: string; slot?: string };

export interface JewelUse extends Why {
  kind: 'regular' | 'abyss' | 'cluster' | 'timeless' | 'unique';
  base: string;
  name: string;
  enchant?: string;
  passives?: number;
}

export interface FlaskUse extends Why {
  slot: string;
  base: string;
  class: string;
  unique?: string;
}

export interface CurrencyNeed extends Why {
  item: string;
  /** 'weapons': shown for as long as the build uses a weapon. */
  stages: 'all' | 'weapons' | BuildStageId[];
  ssfOnly?: boolean;
  /** NeverSink class the item sits in. */
  class: string;
}

export interface CardUse extends Why {
  card: string;
  reward: string;
}

/** Card name to what it turns into, from poe.ninja (or the bundled snapshot). */
export type CardRewards = Record<string, { kind: 'unique' | 'gem' | 'currency'; reward: string; stack: number }>;

export interface BuildProfile {
  className: string;
  ascendancy: string;
  level: number;
  ruthless: boolean;
  mainSkill: GemRef | null;
  skillGroups: SkillGroupReq[];
  /** Every enabled gem of every group, once each. */
  gems: GemRef[];
  slots: SlotUse[];
  weaponClasses: string[];
  weaponWhy: string;
  armour: Record<string, Archetype>;
  uniques: (Why & { name: string; base: string; slot: string })[];
  flasks: FlaskUse[];
  jewels: JewelUse[];
  currencyNeeds: CurrencyNeed[];
  cards: CardUse[];
  chromaticNeed: boolean;
}

export const ARMOUR_CLASSES = ['Helmets', 'Body Armours', 'Gloves', 'Boots', 'Shields'];
export const WEAPON_CLASSES: string[] = GEAR_KINDS.find((k) => k.id === 'weapon')!.classes;
const ARCH_RE = /^(str|dex|int)(_(dex|int))*(_int)?_armour$|^ward_armour$/;
const CLASS_ARCH: Record<string, string> = { Marauder: 'str', Ranger: 'dex', Witch: 'int', Duelist: 'str_dex', Templar: 'str_int', Shadow: 'dex_int', Scion: 'str_dex_int' };
const SLOT_OF_CLASS: Record<string, string> = { Helmets: 'Helmet', 'Body Armours': 'Body Armour', Gloves: 'Gloves', Boots: 'Boots', Shields: 'Weapon 2' };

function find(n: XmlNode, tag: string, out: XmlNode[] = []): XmlNode[] {
  if (n.tag === tag) out.push(n);
  for (const c of n.children) find(c, tag, out);
  return out;
}

export function archetypeTag(raw: RawBase | undefined): string | null {
  for (const k of Object.keys(raw?.tags ?? {})) if (ARCH_RE.test(k)) return k;
  return null;
}

/** `str_dex_armour` as "strength and dexterity". */
export function archetypeWords(tag: string): string {
  const w: Record<string, string> = { str: 'strength', dex: 'dexterity', int: 'intelligence' };
  if (tag === 'ward_armour') return 'ward';
  return tag.replace(/_armour$/, '').split('_').map((x) => w[x] ?? x).join(' and ');
}

/** The attribute letters an archetype carries, as socket colours: R strength, G dexterity, B intelligence. */
export function archetypeColours(tag: string): Colour[] {
  const out: Colour[] = [];
  if (/(^|_)str(_|$)/.test(tag)) out.push('R');
  if (/(^|_)dex(_|$)/.test(tag)) out.push('G');
  if (/(^|_)int(_|$)/.test(tag)) out.push('B');
  return out;
}

interface ParsedItem {
  rarity: string;
  name: string;
  base: string;
  itemLevel?: number;
  text: string;
}

function baseFromMagicName(name: string, bases: Record<string, RawBase>): string {
  let best = '';
  for (const b of Object.keys(bases)) if (b.length > best.length && name.includes(b)) best = b;
  return best;
}

function parseItem(text: string, bases: Record<string, RawBase>): ParsedItem | null {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const rar = /^Rarity:\s*(\w+)/i.exec(lines[0] ?? '');
  if (!rar) return null;
  const rarity = rar[1]!.toUpperCase();
  const name = lines[1] ?? '';
  let base = '';
  if (rarity === 'UNIQUE' || rarity === 'RARE') base = lines[2] ?? '';
  else if (rarity === 'NORMAL') base = name.replace(/^Superior /, '');
  else base = baseFromMagicName(name, bases);
  const il = /^Item Level:\s*(\d+)/m.exec(text);
  return { rarity, name, base, ...(il ? { itemLevel: Number(il[1]) } : {}), text };
}

function resolveGem(g: XmlNode, game: GameData): GemRef | null {
  const nameSpec = (g.attrs.nameSpec ?? '').trim();
  let id = g.attrs.gemId ?? '';
  if (!id || !game.gems[id]) {
    const byName = game.gemByName[nameSpec.toLowerCase()] ?? game.gemByName[nameSpec.replace(/ Support$/, '').toLowerCase() + ' support'];
    if (byName) id = byName;
  }
  const data = game.gems[id];
  if (!data && !nameSpec) return null;
  const name = data?.name ?? nameSpec;
  const support = data ? data.support : /Support$/.test(nameSpec) || /^Support/.test(g.attrs.skillId ?? '');
  const alt = /^(.*)Alt[A-Z]$/.exec(id);
  return {
    gemId: id || nameSpec,
    name,
    itemName: support && !/ Support$/.test(name) ? `${name} Support` : name,
    support,
    colour: data?.colour ?? 'W',
    transfigured: !!alt,
    ...(alt ? { baseGemId: alt[1]! } : {}),
    weaponTypes: data?.weaponTypes ?? [],
  };
}

/** The filter classes a skill can be used with; none for unarmed skills. */
export function weaponClassesOfTypes(types: string[]): string[] {
  const out: string[] = [];
  for (const t of types) {
    if (t === 'None') continue;
    const c = CLASS_OF_TYPE[t];
    if (c && WEAPON_CLASSES.includes(c) && !out.includes(c)) out.push(c);
    if (t === 'Dagger' && !out.includes('Rune Daggers')) out.push('Rune Daggers');
  }
  return out;
}

const SLOTS_WITH_SOCKETS = (slot: string, itemClass: string): number => {
  if (slot === 'Body Armour') return 6;
  if (slot === 'Helmet' || slot === 'Gloves' || slot === 'Boots') return 4;
  if (/^Weapon 1/.test(slot)) return TWO_HAND.has(itemClass) ? 6 : 3;
  return 3;
};
const TWO_HAND = new Set(['Bows', 'Staves', 'Warstaves', 'Two Hand Axes', 'Two Hand Maces', 'Two Hand Swords']);

export interface ProfileOptions {
  cardRewards?: CardRewards;
}

export function readBuildProfile(xml: string, game: GameData, opts: ProfileOptions = {}): BuildProfile | null {
  let root: XmlNode;
  try {
    root = parseXml(xml);
  } catch {
    return null;
  }
  const build = find(root, 'Build')[0];
  if (!build) return null;
  const className = build.attrs.className ?? '';

  // ---- items of the active set
  const itemsNode = find(root, 'Items')[0];
  const itemsById = new Map<string, ParsedItem>();
  for (const it of find(root, 'Item')) {
    const p = parseItem(it.text, game.bases);
    if (p) itemsById.set(it.attrs.id ?? '', p);
  }
  const sets = find(root, 'ItemSet');
  const active = sets.find((s) => s.attrs.id === itemsNode?.attrs.activeItemSet) ?? sets[0];
  const itemOf = new Map<string, ParsedItem>();
  for (const s of find(active ?? root, 'Slot')) {
    const it = itemsById.get(s.attrs.itemId ?? '');
    if (it && it.base) itemOf.set(s.attrs.name ?? '', it);
  }
  const slots: SlotUse[] = [];
  const classOf = (base: string): string => classOfBase(game.bases[base] ?? {}) ?? '';
  for (const [slot, it] of itemOf) {
    if (!/^(Weapon 1|Weapon 2|Helmet|Body Armour|Gloves|Boots|Belt|Amulet|Ring 1|Ring 2)$/.test(slot)) continue;
    slots.push({ slot, name: it.name, base: it.base, rarity: it.rarity, class: classOf(it.base), ...(it.itemLevel ? { itemLevel: it.itemLevel } : {}), why: `Your ${slot.toLowerCase()}: ${it.name && it.name !== it.base ? `${it.name}, a ${it.base}` : it.base}.` });
  }

  // ---- skills
  const skillsNode = find(root, 'Skills')[0];
  const skillSets = skillsNode ? find(skillsNode, 'SkillSet') : [];
  const skillSet = skillSets.find((s) => s.attrs.id === skillsNode?.attrs.activeSkillSet) ?? skillSets[0];
  const groups = skillSet ? find(skillSet, 'Skill') : skillsNode ? find(skillsNode, 'Skill') : find(root, 'Skill');
  const mainIdx = Number(build.attrs.mainSocketGroup ?? '1') - 1;
  const allGems: GemRef[] = [];
  const addGem = (g: GemRef): void => {
    if (!allGems.some((x) => x.gemId === g.gemId)) allGems.push(g);
  };
  const skillGroups: SkillGroupReq[] = [];
  let mainSkill = null as GemRef | null;
  let mainFloating = false;
  groups.forEach((grp, gi) => {
    if (grp.attrs.enabled === 'false') return;
    const gems = grp.children.filter((c) => c.tag === 'Gem' && c.attrs.enabled !== 'false').map((g) => resolveGem(g, game)).filter((g): g is GemRef => !!g);
    for (const g of gems) addGem(g);
    const actives = gems.filter((g) => !g.support);
    const isMain = gi === mainIdx;
    if (isMain) {
      const n = Math.max(1, Number(grp.attrs.mainActiveSkill ?? '1')) - 1;
      mainSkill = actives[n] ?? actives[0] ?? null;
    }
    const slot = grp.attrs.slot;
    if (isMain && !slot) mainFloating = true;
    if (!slot || !gems.length) return;
    const ordered = [...actives.slice(0, 1), ...gems.filter((g) => g !== actives[0])];
    const item = itemOf.get(slot.replace(/ Swap$/, ''));
    const cap = SLOTS_WITH_SOCKETS(slot, item ? classOf(item.base) : '');
    const size = Math.min(ordered.length, cap);
    const colours = ordered.slice(0, size).map((g) => g.colour).sort().join('');
    skillGroups.push({ slot, gems: ordered, main: isMain, size, colours, why: `${ordered[0]!.name}${ordered.length > 1 ? ` with ${ordered.length - 1} support${ordered.length > 2 ? 's' : ''}` : ''} sits in your ${slot.toLowerCase()}, so it needs ${size} linked sockets (${colours}).` });
  });

  // A main group that sits in no gear (a calc-only group) cannot be leveled toward: take the slotted group with the most supports.
  if (mainFloating || !mainSkill) {
    const pick = [...skillGroups].sort((a, b) => b.gems.filter((g) => g.support).length - a.gems.filter((g) => g.support).length || b.size - a.size)[0];
    if (pick) {
      for (const g of skillGroups) g.main = g === pick;
      mainSkill = pick.gems[0]!.support ? mainSkill : pick.gems[0]!;
    }
  }

  // ---- weapons
  const w1 = itemOf.get('Weapon 1');
  const w2 = itemOf.get('Weapon 2');
  // "None" in a gem's weapon types means it CAN be used bare-handed (Ground Slam, Earthshatter and Cyclone list it beside their
  // weapons). A skill that lists only "None" (the Concoctions) is unarmed. One that lists weapons too is unarmed only when the build wields none; a weapon it wields is never hidden.
  const wields = [w1, w2].some((it) => !!it && WEAPON_CLASSES.includes(classOf(it.base)));
  const unarmed = !!mainSkill && mainSkill.weaponTypes.includes('None') && (mainSkill.weaponTypes.every((t) => t === 'None') || !wields);
  let weaponClasses: string[] = [];
  let weaponWhy = '';
  if (unarmed) {
    weaponWhy = `${mainSkill!.name} is an unarmed skill, so weapons are never part of this build.`;
  } else {
    for (const it of [w1, w2]) {
      const c = it ? classOf(it.base) : '';
      if (c && WEAPON_CLASSES.includes(c) && !weaponClasses.includes(c)) weaponClasses.push(c);
    }
    if (weaponClasses.length) weaponWhy = `You wield ${weaponClasses.join(' and ').toLowerCase()}.`;
    else if (mainSkill) {
      weaponClasses = weaponClassesOfTypes(mainSkill!.weaponTypes);
      if (weaponClasses.length) weaponWhy = `${mainSkill!.name} needs ${weaponClasses.join(', ').toLowerCase()}.`;
    }
    const swap = itemOf.get('Weapon 1 Swap');
    const swapGroup = skillGroups.find((g) => g.slot === 'Weapon 1 Swap' && g.gems.some((x) => !x.support));
    if (swap && swapGroup) {
      const c = classOf(swap.base);
      if (WEAPON_CLASSES.includes(c) && !weaponClasses.includes(c)) {
        weaponClasses.push(c);
        weaponWhy += ` Your swap weapon socket holds ${swapGroup.gems[0]!.name}.`;
      }
    }
    if (w2 && classOf(w2.base) === 'Quivers') weaponClasses.push('Quivers');
    weaponWhy = weaponWhy.trim();
  }

  // ---- armour archetypes
  const armour: Record<string, Archetype> = {};
  const bySlot = new Map(slots.map((s) => [s.slot, s]));
  const known: string[] = [];
  for (const c of ARMOUR_CLASSES) {
    const s = bySlot.get(SLOT_OF_CLASS[c]!) ?? (c === 'Shields' && w2 && classOf(w2.base) === 'Shields' ? { slot: 'Weapon 2', base: w2.base, name: w2.name } : undefined);
    if (!s || (c === 'Shields' && classOf(s.base) !== 'Shields')) continue;
    const tag = archetypeTag(game.bases[s.base]);
    if (!tag) continue;
    armour[c] = { tag, base: s.base, slot: s.slot, why: `Your ${s.slot.toLowerCase()}: ${s.base}, a ${archetypeWords(tag)} base.` };
    known.push(tag);
  }
  const counts = new Map<string, number>();
  for (const t of known) counts.set(t, (counts.get(t) ?? 0) + 1);
  const majority = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  const classTag = CLASS_ARCH[className] ? `${CLASS_ARCH[className]}_armour` : '';
  for (const c of ARMOUR_CLASSES) {
    if (armour[c]) continue;
    if (c === 'Shields') continue;
    if (majority) armour[c] = { tag: majority, why: `Most of your armour is ${archetypeWords(majority)}.` };
    else if (classTag) armour[c] = { tag: classTag, why: `No gear in the build, using your class: ${archetypeWords(classTag)}.` };
  }

  // ---- uniques, flasks
  const uniques: BuildProfile['uniques'] = [];
  const flasks: FlaskUse[] = [];
  for (const [slot, it] of itemOf) {
    if (it.rarity === 'UNIQUE' && it.base) uniques.push({ name: it.name, base: it.base, slot, why: `Your ${slot.toLowerCase()}: ${it.name}. A unique is found by its base, ${it.base}.` });
    const fm = /^Flask (\d)$/.exec(slot);
    if (fm) {
      const cls = classOf(it.base) || 'Utility Flasks';
      flasks.push({ slot, base: it.base, class: cls, ...(it.rarity === 'UNIQUE' ? { unique: it.name } : {}), why: `Flask ${fm[1]} is a ${it.base}.` });
    }
  }

  // ---- jewels in the active tree
  const jewels: JewelUse[] = [];
  const treeNode = find(root, 'Tree')[0];
  const specs = treeNode ? find(treeNode, 'Spec') : [];
  const spec = specs[Number(treeNode?.attrs.activeSpec ?? '1') - 1] ?? specs[0];
  const ruthless = /ruthless/i.test(spec?.attrs.treeVersion ?? '') || /ruthless/i.test(build.attrs.targetVersion ?? '');
  for (const s of spec ? find(spec, 'Socket') : []) {
    const it = itemsById.get(s.attrs.itemId ?? '');
    if (!it || !it.base) continue;
    const common = { base: it.base, name: it.name };
    if (it.rarity === 'UNIQUE') {
      const timeless = it.base === 'Timeless Jewel';
      jewels.push({ kind: timeless ? 'timeless' : 'unique', ...common, why: `${it.name} sits in your tree.` });
    } else if (/Cluster Jewel$/.test(it.base)) {
      const ench = /Added Small Passive Skills grant:\s*([^\n]+)/.exec(it.text)?.[1]?.trim();
      const num = /Adds (\d+) Passive Skills/.exec(it.text)?.[1];
      jewels.push({ kind: 'cluster', ...common, ...(ench ? { enchant: ench } : {}), ...(num ? { passives: Number(num) } : {}), why: `Your tree has a ${it.base}${ench ? ` that grants ${ench}` : ''}.` });
    } else if (/Eye Jewel$/.test(it.base)) jewels.push({ kind: 'abyss', ...common, why: `Your tree has a ${it.base}.` });
    else jewels.push({ kind: 'regular', ...common, why: `Your tree has a ${it.base}.` });
  }

  // ---- socket colours
  let chromaticNeed = false;
  for (const g of skillGroups) {
    const item = itemOf.get(g.slot.replace(/ Swap$/, ''));
    const tag = item ? archetypeTag(game.bases[item.base]) : null;
    const attrs: Colour[] = tag ? archetypeColours(tag) : item ? attrsOfReq(game.bases[item.base]) : [];
    if (!attrs.length) continue;
    const need = g.gems.slice(0, g.size).map((x) => x.colour).filter((c) => c !== 'W');
    const lacking = [...new Set(need.filter((c) => !attrs.includes(c)))];
    if (lacking.length >= 2 || lacking.some((c) => need.filter((x) => x === c).length >= 3)) chromaticNeed = true;
  }

  const cards = opts.cardRewards ? matchCards(opts.cardRewards, uniques.map((u) => ({ name: u.name, slot: u.slot })), allGems.map((g) => g.name)) : [];
  const profile: BuildProfile = {
    className,
    ascendancy: build.attrs.ascendClassName ?? '',
    level: Number(build.attrs.level ?? '1') || 1,
    ruthless,
    mainSkill,
    skillGroups,
    gems: allGems,
    slots,
    weaponClasses,
    weaponWhy,
    armour,
    uniques,
    flasks,
    jewels,
    currencyNeeds: [],
    cards,
    chromaticNeed,
  };
  profile.currencyNeeds = currencyNeedsFor(profile);
  return profile;
}

function attrsOfReq(raw: RawBase | undefined): Colour[] {
  const r = (raw as { req?: { str?: number; dex?: number; int?: number } } | undefined)?.req ?? {};
  const out: Colour[] = [];
  if ((r.str ?? 0) > 0) out.push('R');
  if ((r.dex ?? 0) > 0) out.push('G');
  if ((r.int ?? 0) > 0) out.push('B');
  return out;
}

/** Cards whose reward is one of the build's uniques or gems. */
export function matchCards(rewards: CardRewards, uniques: { name: string; slot: string }[], gemNames: string[]): CardUse[] {
  const out: CardUse[] = [];
  const gems = new Set(gemNames.map((g) => g.toLowerCase()));
  for (const [card, r] of Object.entries(rewards)) {
    if (r.kind === 'unique') {
      const u = uniques.find((x) => x.name.toLowerCase() === r.reward.toLowerCase());
      if (u) out.push({ card, reward: r.reward, why: `Turn in ${r.stack} for ${r.reward}, your ${u.slot.toLowerCase()}.` });
    } else if (r.kind === 'gem' && gems.has(r.reward.toLowerCase())) {
      out.push({ card, reward: r.reward, why: `Turn in ${r.stack} for ${r.reward}, a gem in your build.` });
    }
  }
  return out.sort((a, b) => a.card.localeCompare(b.card));
}

/** The crafting and utility currency a build wants shown (section 1.8 of the design). */
export function currencyNeedsFor(p: Pick<BuildProfile, 'chromaticNeed' | 'flasks' | 'armour' | 'weaponClasses'>): CurrencyNeed[] {
  const C = 'Stackable Currency';
  const n = (item: string, stages: CurrencyNeed['stages'], why: string, extra: Partial<CurrencyNeed> = {}): CurrencyNeed => ({ item, stages, why, class: C, ...extra });
  const out: CurrencyNeed[] = [
    n('Scroll of Wisdom', ['S0', 'S1', 'S2'], 'Identify and sell while you level.'),
    n('Portal Scroll', ['S0', 'S1', 'S2'], 'Town trips while you level.'),
    n('Orb of Transmutation', ['S0', 'S1', 'S2', 'S3'], 'Self-found: you craft your own flasks and bases.'),
    n('Orb of Augmentation', ['S0', 'S1', 'S2', 'S3'], 'Self-found: you craft your own flasks and bases.'),
    n('Orb of Alteration', ['S0', 'S1', 'S2', 'S3'], 'Self-found: you craft your own flasks and bases.'),
    p.chromaticNeed ? n('Chromatic Orb', 'all', 'Your links ask for colours your gear does not carry.') : n('Chromatic Orb', ['S0', 'S1', 'S2'], 'Fix socket colours while you level.'),
    n("Jeweller's Orb", 'all', 'Sockets for your links.'),
    n('Orb of Fusing', 'all', 'Links for your skills.'),
  ];
  if (Object.keys(p.armour).length) out.push(n("Armourer's Scrap", 'all', 'You wear armour; quality is free defence.'));
  out.push(n("Blacksmith's Whetstone", 'weapons', 'Quality on the weapons you use.'));
  if (p.flasks.length) out.push(n("Glassblower's Bauble", 'all', 'Quality on your flasks.'));
  out.push(n("Gemcutter's Prism", 'all', 'Gem quality.'));
  for (const item of ['Orb of Scouring', 'Regal Orb', 'Chaos Orb', 'Vaal Orb', 'Exalted Orb', 'Divine Orb', 'Orb of Annulment', 'Blessed Orb']) out.push(n(item, 'all', 'Crafting currency is never hidden by the build.'));
  out.push(n('Fossil', ['S3', 'S4'], 'Self-found crafting at map level.', { ssfOnly: true, class: 'Delve Stackable Socketable Currency' }));
  out.push(n('Resonator', ['S3', 'S4'], 'Self-found crafting at map level.', { ssfOnly: true, class: 'Delve Socketable Currency' }));
  return out;
}

/** What the leveling planner needs from a profile. */
export function levelingLite(p: BuildProfile): LevelingProfileLite {
  const main = p.skillGroups.find((g) => g.main) ?? p.skillGroups[0];
  return {
    className: p.className,
    mainSkillId: p.mainSkill?.baseGemId ?? p.mainSkill?.gemId ?? '',
    mainSupportIds: (main?.gems ?? []).filter((g) => g.support).map((g) => g.gemId),
    ruthless: p.ruthless,
  };
}

/** The show list of an armour class: its bases with the archetype's tag. The hide list is every other base of the class. */
export function armourBases(game: GameData, cls: string, tag: string): { show: string[]; hide: string[] } {
  const show: string[] = [];
  const hide: string[] = [];
  for (const [name, raw] of Object.entries(game.bases)) {
    if (classOfBase(raw) !== cls) continue;
    if (archetypeTag(raw) === tag) show.push(name);
    else hide.push(name);
  }
  return { show: show.sort(), hide: hide.sort() };
}
