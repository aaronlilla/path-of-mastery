import type { LevelingPlan } from '../leveling/types.js';
import type { Catalog } from './catalog.js';
import { classOfBase } from './bases.js';
import { BUILD_LOOK, proposalsFromStats, type ResistAffix } from './buildRules.js';
import { armourBases, ARMOUR_CLASSES, readBuildProfile, WEAPON_CLASSES, type BuildProfile, type CardRewards, type GameData } from './profile.js';
import { OPEN_END, planStages, stageAt, stageBanner, type Stage } from './stages.js';
import type { BuildGroup, BuildMeta, BuildSetup, BuildStageId, Condition, LabelStyle, Rule } from './types.js';

/**
 * The Build Filter: ordinary `Rule` objects (`source: 'build'`) that show exactly what one build uses, hide what it never
 * uses, and change by AreaLevel from the first zone to endgame. NeverSink stays underneath, unchanged.
 *
 * Priority bands (higher wins; generateFilter writes highest first):
 *   safety net            1_000_000 and down
 *   the player's rules    around 0 to 10_000 (untouched)
 *   the player's changes  -900 and down
 *   resist-gap highlight  -950 and down
 *   build items, always   -1 and down
 *   stage k, shows        -1000 - 1000k and down
 *   stage k, hides        -1500 - 1000k and down (a stage's shows beat its hides, so doubt shows)
 */

export interface BuildContext {
  game: GameData;
  /** NeverSink's catalog, to copy the look of currency tiers. Without it the build look is used. */
  catalog?: Catalog | null;
  /** The engine's numbers for the build (`Missing<Element>Resist`). With the affixes they switch on the resist-gap highlight. */
  stats?: Record<string, number | string | boolean | null>;
  affixes?: ResistAffix[];
  /** Chaos price of each divination card, from poe.ninja. Trade mode shows the ones worth 5c or more. */
  cardPrices?: Record<string, number>;
}

/** The engine's stat list as the plain numbers the build filter reads (`Missing<Element>Resist`). One rule for every caller. */
export function statsOf(list: { id: string; value: unknown }[] | undefined): Record<string, number | string | boolean | null> | undefined {
  if (!Array.isArray(list)) return undefined;
  return Object.fromEntries(list.filter((x) => x.value === null || typeof x.value !== 'object').map((x) => [x.id, x.value as number | string | boolean | null]));
}

/** Chaos price of each divination card in a poe.ninja price table. One rule for every caller. */
export function cardPricesOf(byName: Record<string, { chaos: number; category: string }> | undefined): Record<string, number> | undefined {
  if (!byName) return undefined;
  const out: Record<string, number> = {};
  for (const [n, e] of Object.entries(byName)) if (e.category === 'DivinationCard') out[n] = e.chaos;
  return out;
}

/** Cards at or above this many chaos show in trade mode. */
export const TRADE_CARD_MIN_CHAOS = 5;
const RESIST_ESSENCE: Record<string, string> = { Fire: 'Anger', Cold: 'Hatred', Lightning: 'Wrath' };
const ESSENCE_TIERS = ['Whispering', 'Muttering', 'Weeping', 'Wailing', 'Screaming', 'Shrieking', 'Deafening'];
const CURRENCY_CLASSES = ['Stackable Currency', 'Currency', 'Delve Stackable Socketable Currency', 'Delve Socketable Currency'];

const c = (key: string, op: string, ...values: string[]): Condition => ({ key, op, values });

const SAFETY_LOOK: LabelStyle = { fg: [255, 255, 255], bd: [255, 255, 255], fs: 45, beam: { colour: 'White' }, icon: { size: 0, colour: 'White', shape: 'Star' } };
const QUIET_LOOK: LabelStyle = { bd: [62, 224, 106, 160], fs: 32 };
const LOUD_LOOK: LabelStyle = { fg: [255, 255, 255], bg: [25, 80, 55, 255], bd: [90, 220, 150], fs: 42, sound: { kind: 'builtin', id: 9, vol: 250 }, beam: { colour: 'Green', temp: true }, icon: { size: 0, colour: 'Green', shape: 'Kite' } };
export const BOOTS_LOOK: LabelStyle = { fg: [255, 255, 255], bg: [25, 80, 55, 255], bd: [90, 220, 150], fs: 40, sound: { kind: 'builtin', id: 2, vol: 200 }, icon: { size: 1, colour: 'Green', shape: 'Circle' } };
const UNIQUE_LOOK: LabelStyle = { ...BUILD_LOOK, fs: 40, beam: { colour: 'Green' } };
const CURRENCY_FALLBACK: LabelStyle = { fg: [255, 255, 255], bg: [40, 40, 40, 235], bd: [200, 200, 200], fs: 34 };

export const MOVEMENT_PREFIXES = ["Runner's", "Sprinter's", "Stallion's", "Gazelle's", "Cheetah's", "Hellion's"];
const STAGE_ORDER: BuildStageId[] = ['S0', 'S1', 'S2', 'S3', 'S4'];

interface Span {
  first: Stage;
  last: Stage;
}

/** AreaLevel conditions for a span of stages. The last stage has no upper bound. */
function band(sp: Span | Stage): Condition[] {
  const f = 'first' in sp ? sp.first : sp;
  const l = 'last' in sp ? sp.last : sp;
  const out = [c('AreaLevel', '>=', String(f.lo))];
  if (l.hi < OPEN_END) out.push(c('AreaLevel', '<=', String(l.hi)));
  return out;
}

/** Runs of neighbouring stages that share a key. Stages with a null key are skipped and break the run. */
function runs(stages: Stage[], key: (s: Stage) => string | null): (Span & { key: string })[] {
  const out: (Span & { key: string })[] = [];
  for (const s of stages) {
    const k = key(s);
    if (k === null) continue;
    const prev = out[out.length - 1];
    if (prev && prev.key === k && prev.last.hi + 1 === s.lo) prev.last = s;
    else out.push({ first: s, last: s, key: k });
  }
  return out;
}

const inStages = (s: Stage, ids: BuildStageId[]): boolean => ids.includes(s.id);
const idxOf = (id: BuildStageId): number => STAGE_ORDER.indexOf(id);
const lc = (s: string): string => s.toLowerCase();
const nice = (classes: string[]): string => classes.map((x) => x.toLowerCase()).join(', ');

interface Draft {
  id: string;
  name: string;
  stage: BuildStageId | 'all';
  kind: BuildMeta['kind'];
  group: BuildGroup;
  reason: string;
  vis: 'show' | 'hide';
  conds: Condition[];
  style?: LabelStyle;
  /** Sits above every stage rule. */
  override?: boolean;
  /** Sits above every stage rule but below the player's changes (`override`). */
  lift?: boolean;
}

export function buildFilterRules(profile: BuildProfile, plan: LevelingPlan | null, stages: Stage[], setup: BuildSetup, ctx: BuildContext): Rule[] {
  if (!setup.on) return [];
  const trade = setup.mode === 'trade';
  const drafts: Draft[] = [];
  const first = stages[0];
  const lastStage = stages[stages.length - 1];
  if (!first || !lastStage) return [];
  const allSpan: Span = { first, last: lastStage };
  const showIds = (...ids: BuildStageId[]): Stage[] => stages.filter((s) => inStages(s, ids));
  const spanOf = (list: Stage[]): Span | null => (list.length ? { first: list[0]!, last: list[list.length - 1]! } : null);

  // ---- who needs what, per stage
  const skillsIn = (s: Stage) => (plan?.skills ?? []).filter((k) => k.from <= s.hi && k.to >= s.lo);
  const levelingClasses = (s: Stage): string[] => [...new Set(skillsIn(s).flatMap((k) => k.weaponClasses))];
  const nameOfSkill = (gemId: string): string => ctx.game.gems[gemId]?.name ?? gemId;
  const mainGroup = profile.skillGroups.find((g) => g.main) ?? profile.skillGroups[0];

  const hideGuards = (s: Stage | Span): Condition[] => {
    const f = 'id' in s ? s : s.first;
    const l = 'id' in s ? s : s.last;
    const g = [c('Rarity', '<=', 'Rare'), c('LinkedSockets', '<', '6')];
    if (idxOf(l.id) <= 2 || idxOf(f.id) <= 2) g.push(c('Sockets', '<', '6'));
    g.push(c('HasInfluence', '', 'None'), c('FracturedItem', '', 'False'), c('SynthesisedItem', '', 'False'), c('Mirrored', '', 'False'), c('Replica', '', 'False'));
    if (trade) g.push(c('Rarity', '', 'Normal', 'Magic'), c('ItemLevel', '<', '82'));
    return g;
  };

  const add = (d: Draft): void => {
    drafts.push(d);
  };

  // ---- safety net: show anything in doubt
  const buildClasses = [...new Set([...profile.slots.map((s) => s.class).filter((x) => !WEAPON_CLASSES.includes(x)), ...profile.weaponClasses, ...Object.keys(profile.armour), ...profile.flasks.map((f) => f.class)].filter(Boolean))];
  add({ id: 'build:safety:6l', name: 'Six linked', stage: 'all', kind: 'safety', group: 'safety', reason: 'A six link is always worth a look. It vendors for 20 Orbs of Fusing.', vis: 'show', conds: [c('LinkedSockets', '', '6')], style: SAFETY_LOOK });
  add({ id: 'build:safety:6s', name: 'Six socket', stage: 'all', kind: 'safety', group: 'safety', reason: 'Six sockets vendor for 7 Jeweller\'s Orbs while you level.', vis: 'show', conds: [c('Sockets', '', '6'), c('AreaLevel', '<=', '67')], style: SAFETY_LOOK });
  if (buildClasses.length) {
    add({ id: 'build:safety:corrupt', name: 'Corrupted with mods', stage: 'all', kind: 'safety', group: 'safety', reason: 'Corrupted gear of a kind you wear can have an implicit you want.', vis: 'show', conds: [c('Class', '==', ...buildClasses), c('Corrupted', '', 'True'), c('CorruptedMods', '>=', '1')], style: SAFETY_LOOK });
    add({ id: 'build:safety:influence', name: 'Influenced', stage: 'all', kind: 'safety', group: 'safety', reason: 'Influenced gear of a kind you wear carries mods you cannot get elsewhere.', vis: 'show', conds: [c('Class', '==', ...buildClasses), c('HasInfluence', '', 'Shaper', 'Elder', 'Crusader', 'Hunter', 'Redeemer', 'Warlord')], style: SAFETY_LOOK });
  }

  // ---- build items that always show
  const seenBase = new Set<string>();
  for (const u of profile.uniques) {
    if (seenBase.has(u.base)) continue;
    seenBase.add(u.base);
    add({ id: `build:uniq:${u.base}`, name: `${u.name}`, stage: 'all', kind: 'force', group: 'uniques', reason: u.why, vis: 'show', conds: [c('Rarity', '', 'Unique'), c('BaseType', '==', u.base)], style: UNIQUE_LOOK });
  }
  for (const k of profile.cards) {
    add({ id: `build:card:${k.card}`, name: k.card, stage: 'all', kind: 'force', group: 'cards', reason: k.why, vis: 'show', conds: [c('Class', '==', 'Divination Cards'), c('BaseType', '==', k.card)], style: UNIQUE_LOOK });
  }

  if (trade && ctx.cardPrices) {
    const have = new Set(profile.cards.map((k) => k.card));
    const dear = Object.entries(ctx.cardPrices).filter(([n, v]) => v >= TRADE_CARD_MIN_CHAOS && !have.has(n)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    if (dear.length) add({ id: 'build:cards:trade', name: `Cards worth ${TRADE_CARD_MIN_CHAOS}c or more`, stage: 'all', kind: 'force', group: 'cards', reason: `Trade mode: ${dear.length} divination cards sell for ${TRADE_CARD_MIN_CHAOS} chaos or more on poe.ninja, so they always show.`, vis: 'show', conds: [c('Class', '==', 'Divination Cards'), c('BaseType', '==', ...dear.map(([n]) => n).sort())], style: UNIQUE_LOOK });
  }

  // gems
  const active = profile.gems.filter((g) => !g.support);
  const supports = profile.gems.filter((g) => g.support);
  const gemNames = (list: typeof profile.gems): string[] => [...new Set(list.flatMap((g) => [g.itemName, ...(g.baseGemId ? [ctx.game.gems[g.baseGemId]?.name ?? ''] : [])]).filter(Boolean))];
  // Vaal versions of the build's skills, and Awakened versions of its supports (only those the game has)
  const vaalNames = [...new Set(active.flatMap((g) => [g.gemId, ...(g.baseGemId ? [g.baseGemId] : [])]).flatMap((id) => ctx.game.vaalByBase?.[id] ?? []))].sort();
  const awakenedNames = [...new Set(supports.map((g) => `Awakened ${g.name.replace(/ Support$/, '')} Support`))].filter((n) => !!ctx.game.gemByName[lc(n)]).sort();
  if (active.length) add({ id: 'build:gems:skill', name: 'Your skill gems', stage: 'all', kind: 'force', group: 'gems', reason: `Gems in your build: ${active.map((g) => g.name).join(', ')}. Any level, any quality.${vaalNames.length ? ` Their Vaal versions show too: ${vaalNames.join(', ')}.` : ''}`, vis: 'show', conds: [c('Class', '==', 'Skill Gems'), c('BaseType', '==', ...gemNames(active), ...vaalNames)], style: BUILD_LOOK });
  if (supports.length) {
    const names = [...gemNames(supports), ...awakenedNames];
    add({ id: 'build:gems:support', name: 'Your support gems', stage: 'all', kind: 'force', group: 'gems', reason: `Supports in your build${awakenedNames.length ? `, plus their awakened versions: ${awakenedNames.join(', ')}` : ''}: ${supports.map((g) => g.name).join(', ')}.`, vis: 'show', conds: [c('Class', '==', 'Support Gems'), c('BaseType', '==', ...names)], style: BUILD_LOOK });
  }
  for (const g of profile.gems.filter((x) => x.transfigured)) {
    add({ id: `build:gems:transfigured:${g.name}`, name: g.name, stage: 'all', kind: 'force', group: 'gems', reason: `${g.name} is the transfigured version of a gem in your build.`, vis: 'show', conds: [c('TransfiguredGem', '', g.name)], style: BUILD_LOOK });
  }

  // currency
  const catalogStyle = (item: string): LabelStyle => {
    const it = ctx.catalog?.byName.get(item);
    return it && !it.hidden && Object.keys(it.style).length ? it.style : CURRENCY_FALLBACK;
  };
  for (const need of profile.currencyNeeds) {
    if (trade && need.ssfOnly) continue;
    let sp: Span | null;
    let stage: BuildStageId | 'all';
    if (need.stages === 'all') {
      sp = null;
      stage = 'all';
    } else if (need.stages === 'weapons') {
      if (profile.weaponClasses.length) {
        sp = null;
        stage = 'all';
      } else {
        const lw = stages.filter((s) => levelingClasses(s).length);
        sp = spanOf(lw);
        if (!sp) continue;
        stage = sp.first.id;
      }
    } else {
      sp = spanOf(showIds(...need.stages));
      if (!sp) continue;
      stage = sp.first.id;
    }
    const exactName = need.item !== 'Fossil' && need.item !== 'Resonator';
    add({
      id: `build:force:${need.item}`,
      name: need.item,
      stage,
      kind: 'force',
      group: 'currency',
      reason: need.why,
      vis: 'show',
      conds: [...(exactName ? [c('Class', '==', need.class)] : [c('Class', '==', need.class)]), c('BaseType', exactName ? '==' : '', need.item), ...(sp ? band(sp) : [])],
      style: catalogStyle(need.item),
    });
  }

  // ---- per stage
  // weapons: the leveling skill's weapons show until the main skill takes over, then everything that is not the build's is hidden
  for (const r of runs(stages, (s) => (levelingClasses(s).length ? levelingClasses(s).sort().join('|') : null))) {
    const classes = r.key.split('|');
    const names = skillsIn(r.first).filter((k) => k.weaponClasses.length).map((k) => nameOfSkill(k.gemId));
    add({ id: `build:${lc(r.first.id)}:levweap`, name: 'Leveling weapons', stage: r.first.id, kind: 'show', group: 'weapons', reason: `${names.join(' and ')} ${names.length > 1 ? 'need' : 'needs'} ${nice(classes)} until ${profile.mainSkill?.name ?? 'your main skill'} is ready.`, vis: 'show', conds: [...band(r), c('Class', '==', ...classes), c('Rarity', '<=', 'Rare')], style: QUIET_LOOK });
  }
  const keepWeapons = (s: Stage): string[] => [...new Set([...profile.weaponClasses, ...levelingClasses(s)])];
  for (const r of runs(stages.filter((s) => s.id !== 'S0'), (s) => WEAPON_CLASSES.filter((w) => !keepWeapons(s).includes(w)).join('|') || null)) {
    const hide = r.key.split('|');
    const why = profile.weaponWhy || 'Your build does not use these weapons.';
    add({ id: `build:${lc(r.first.id)}:hide:weapons`, name: 'Weapons you do not use', stage: r.first.id, kind: 'hide', group: 'weapons', reason: `${why} Hiding ${nice(hide).length > 90 ? `${hide.length} weapon classes` : nice(hide)}.`, vis: 'hide', conds: [...band(r), c('Class', '==', ...hide), ...hideGuards(r)] });
  }

  // armour by archetype
  for (const cls of ARMOUR_CLASSES) {
    const arch = profile.armour[cls];
    if (!arch) continue;
    const lists = armourBases(ctx.game, cls, arch.tag);
    if (!lists.show.length) continue;
    const slug = cls.toLowerCase().replace(/\s+/g, '');
    const archKey = arch.tag.replace(/_armour$/, '');
    // keep: every base of the build's archetype
    for (const r of runs(stages, (s) => (s.id === 'S4' ? null : s.id === 'S3' ? 'deep' : 'all'))) {
      const names = r.key === 'deep' ? lists.show.filter((n) => (ctx.game.bases[n]?.req?.level ?? 1) >= 50) : lists.show;
      if (!names.length) continue;
      add({ id: `build:${lc(r.first.id)}:${slug}:${archKey}`, name: `${cls} you can use`, stage: r.first.id, kind: 'show', group: 'armour', reason: `${arch.why} ${r.key === 'deep' ? 'Bases from level 50 up' : 'Every base'} of that kind shows.`, vis: 'show', conds: [...band(r), c('Class', '==', cls), c('BaseType', '==', ...names), c('Rarity', '', 'Normal', 'Magic', 'Rare')], style: QUIET_LOOK });
    }
    if (!lists.hide.length) continue;
    for (const r of runs(stages, (s) => (s.id === 'S0' ? null : s.id === 'S1' ? 'l4' : s.id === 'S2' ? 'l5' : 'none'))) {
      const extra = r.key === 'l4' ? [c('LinkedSockets', '<', '4')] : r.key === 'l5' ? [c('LinkedSockets', '<', '5')] : [];
      add({ id: `build:${lc(r.first.id)}:${slug}:other`, name: `Other ${cls.toLowerCase()}`, stage: r.first.id, kind: 'hide', group: 'armour', reason: `${arch.why} Other kinds of ${cls.toLowerCase()} are hidden${r.key === 'l4' ? ' unless they have 4 links' : r.key === 'l5' ? ' unless they have 5 links' : ''}.`, vis: 'hide', conds: [...band(r), c('Class', '==', cls), c('BaseType', '==', ...lists.hide), ...extra, ...hideGuards(r)] });
    }
  }

  // endgame crafting bases: the exact bases you wear, at an item level that can roll the top mods
  const craft = (ilvl: number, group: BuildGroup, label: string, list: { base: string; why: string }[]): void => {
    const s4 = showIds('S4');
    const sp = spanOf(s4) ?? spanOf(stages.slice(-1));
    if (!sp || !list.length) return;
    const bases = [...new Set(list.map((x) => x.base))];
    add({ id: `build:s4:craftbase:${label}`, name: `Crafting bases (${label})`, stage: sp.first.id, kind: 'show', group, reason: `${list.map((x) => x.why).join(' ')} Item level ${ilvl} or more can roll the top mods.`, vis: 'show', conds: [...band(sp), c('BaseType', '==', ...bases), c('Rarity', '', 'Normal', 'Magic', 'Rare'), c('ItemLevel', '>=', String(ilvl))], style: LOUD_LOOK });
  };
  const rare = profile.slots.filter((s) => s.rarity === 'RARE');
  craft(86, 'armour', 'Gear', rare.filter((s) => ARMOUR_CLASSES.includes(s.class) || WEAPON_CLASSES.includes(s.class)).map((s) => ({ base: s.base, why: s.why })));
  craft(84, 'jewellery', 'Jewellery', rare.filter((s) => ['Rings', 'Amulets', 'Belts'].includes(s.class)).map((s) => ({ base: s.base, why: s.why })));

  // movement speed boots, the best boot mod while leveling
  const early = spanOf(showIds('S0', 'S1', 'S2'));
  if (early) add({ id: `build:${lc(early.first.id)}:msboots`, name: 'Movement speed boots', stage: early.first.id, kind: 'show', group: 'boots', reason: 'Movement speed boots are the biggest speed-up you can find while leveling.', vis: 'show', conds: [...band(early), c('Class', '==', 'Boots'), c('Rarity', '', 'Magic', 'Rare'), c('HasExplicitMod', '', ...MOVEMENT_PREFIXES)], style: BOOTS_LOOK });

  // linked sockets in the build's colours
  const mainCols = mainGroup?.colours ?? '';
  const levelCols = (plan?.skills[0]?.colours ?? '').split('').sort().join('');
  for (const s of stages) {
    let n = 0;
    let cols = '';
    if (s.id === 'S0') {
      cols = levelCols.slice(0, 3);
      n = cols.length >= 3 ? 3 : 0;
    } else if (s.id !== 'S4' && mainCols.length >= 3) {
      n = Math.min(s.id === 'S1' ? 4 : 5, mainCols.length);
      cols = mainCols.slice(0, n);
    }
    if (n < 3) continue;
    add({ id: `build:${lc(s.id)}:links`, name: `${n} links in your colours`, stage: s.id, kind: 'show', group: 'links', reason: `${s.id === 'S0' ? (plan?.skills[0] ? nameOfSkill(plan.skills[0].gemId) : 'Your leveling skill') : (mainGroup?.gems[0]?.name ?? 'Your main skill')} needs ${n} linked sockets: ${cols}.`, vis: 'show', conds: [...band(s), c('SocketGroup', '>=', `${n}${cols}`), c('Rarity', '', 'Normal', 'Magic', 'Rare')], style: LOUD_LOOK });
  }

  // jewellery while leveling
  if (early) add({ id: `build:${lc(early.first.id)}:rares:jewellery`, name: 'Rare jewellery', stage: early.first.id, kind: 'show', group: 'jewellery', reason: 'Rare rings, amulets and belts are your resistance and life while you level.', vis: 'show', conds: [...band(early), c('Class', '==', 'Rings', 'Amulets', 'Belts'), c('Rarity', '', 'Rare')], style: QUIET_LOOK });

  // flasks
  const quick = spanOf(showIds('S0', 'S1', 'S2', 'S3'));
  if (quick) add({ id: `build:${lc(quick.first.id)}:flask:quicksilver`, name: 'Quicksilver Flask', stage: quick.first.id, kind: 'show', group: 'flasks', reason: 'A Quicksilver Flask is free movement speed until map level.', vis: 'show', conds: [...band(quick), c('BaseType', '==', 'Quicksilver Flask')], style: QUIET_LOOK });
  const flaskBases = [...new Set(profile.flasks.filter((f) => !f.unique).map((f) => f.base))];
  const late = spanOf(showIds('S3', 'S4'));
  if (late && flaskBases.length) {
    const why = `Flasks in your build: ${flaskBases.join(', ')}.`;
    add({ id: `build:${lc(late.first.id)}:flask:quality`, name: 'Your flasks, quality', stage: late.first.id, kind: 'show', group: 'flasks', reason: `${why} Quality 16 or more.`, vis: 'show', conds: [...band(late), c('BaseType', '==', ...flaskBases), c('Quality', '>=', '16')], style: LOUD_LOOK });
    add({ id: `build:${lc(late.first.id)}:flask:ilvl`, name: 'Your flasks, item level', stage: late.first.id, kind: 'show', group: 'flasks', reason: `${why} Item level 84 or more.`, vis: 'show', conds: [...band(late), c('BaseType', '==', ...flaskBases), c('ItemLevel', '>=', '84'), c('Rarity', '', 'Normal', 'Magic', 'Rare')], style: LOUD_LOOK });
  }

  // life flasks while leveling: only the two best drop levels that can drop at this area level
  const early3 = spanOf(showIds('S0', 'S1', 'S2'));
  const lifeFlasks = Object.entries(ctx.game.bases)
    .filter(([, r]) => classOfBase(r) === 'Life Flasks')
    .map(([name, r]) => ({ name, level: Math.max(1, r.req?.level ?? 1) }))
    .sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));
  if (early3 && lifeFlasks.length > 2) {
    const lo0 = early3.first.lo;
    const hi0 = early3.last.hi;
    for (let i = 0; i < lifeFlasks.length; i++) {
      const next = lifeFlasks[i + 1];
      const lo = Math.max(lifeFlasks[i]!.level, lo0);
      const hi = Math.min(next ? next.level - 1 : OPEN_END, hi0);
      if (lo > hi) continue;
      const top = lifeFlasks.slice(Math.max(0, i - 1), i + 1).map((x) => x.name);
      const lower = lifeFlasks.slice(0, Math.max(0, i - 1)).map((x) => x.name);
      const st = stageAt(stages, lo)!;
      const area = [c('AreaLevel', '>=', String(lo)), ...(hi < OPEN_END ? [c('AreaLevel', '<=', String(hi))] : [])];
      const tag = `${lo}-${hi}`;
      add({ id: `build:${lc(st.id)}:flask:life:${tag}`, name: `Life flasks, area ${lo}-${hi}`, stage: st.id, kind: 'show', group: 'flasks', reason: `At area ${lo}-${hi} the best life flasks that drop are ${top.join(' and ')}.`, vis: 'show', conds: [...area, c('Class', '==', 'Life Flasks'), c('BaseType', '==', ...top), c('Rarity', '', 'Normal', 'Magic')], style: QUIET_LOOK });
      if (lower.length) add({ id: `build:${lc(st.id)}:hide:flask:life:${tag}`, name: `Older life flasks, area ${lo}-${hi}`, stage: st.id, kind: 'hide', group: 'flasks', reason: `Only the two best life flasks that drop at area ${lo}-${hi} show. The smaller ones are hidden.`, vis: 'hide', conds: [...area, c('Class', '==', 'Life Flasks'), c('BaseType', '==', ...lower), ...hideGuards(early3)] });
    }
  }
  // from early maps on, a life flask shows only when it is one of yours with quality 16 or item level 84
  if (late) add({ id: `build:${lc(late.first.id)}:hide:flask:life`, name: 'Life flasks that are not yours', stage: late.first.id, kind: 'hide', group: 'flasks', reason: 'In maps only your own flask bases show, with quality 16 or more or item level 84 or more.', vis: 'hide', conds: [...band(late), c('Class', '==', 'Life Flasks'), ...hideGuards(late)] });

  // resistance gaps: rare gear that can close what the build is short on, from the late campaign on
  const resistSpan = spanOf(showIds('S2', 'S3', 'S4'));
  if (resistSpan && ctx.stats && ctx.affixes?.length) {
    for (const p of proposalsFromStats(ctx.stats, ctx.affixes)) {
      const el = p.id.replace('build:res:', '');
      add({ id: `build:${lc(resistSpan.first.id)}:resist:${el.toLowerCase()}`, name: p.title, stage: resistSpan.first.id, kind: 'show', group: 'resists', reason: p.why, vis: 'show', lift: true, conds: [...band(resistSpan), ...(p.rule.targets[0]?.conditions ?? [])], style: LOUD_LOOK });
      // the essence that guarantees that resistance, in NeverSink's own look for each tier
      const word = RESIST_ESSENCE[el];
      if (!word) continue;
      const names = ctx.catalog ? [...ctx.catalog.byName.keys()].filter((n) => n.endsWith(` Essence of ${word}`)) : ESSENCE_TIERS.map((t) => `${t} Essence of ${word}`);
      const byLook = new Map<string, { style: LabelStyle; names: string[] }>();
      for (const n of names.sort()) {
        const st = catalogStyle(n);
        const k = JSON.stringify(st);
        const e = byLook.get(k);
        if (e) e.names.push(n);
        else byLook.set(k, { style: st, names: [n] });
      }
      let i = 0;
      for (const e of byLook.values()) {
        add({ id: `build:${lc(resistSpan.first.id)}:resist:${el.toLowerCase()}:essence${byLook.size > 1 ? `:${++i}` : ''}`, name: `Essence of ${word}`, stage: resistSpan.first.id, kind: 'force', group: 'resists', lift: true, reason: `You are short on ${el.toLowerCase()} resistance, and Essence of ${word} guarantees it on a crafted item.`, vis: 'show', conds: [...band(resistSpan), c('Class', '==', 'Stackable Currency'), c('BaseType', '==', ...e.names)], style: e.style });
      }
    }
  }

  // Currency a build Hide block could reach (a change that hides a currency class) keeps NeverSink's top three tiers.
  // Uniques need no such block: every build Hide block carries `Rarity <= Rare`, so none can match one.
  const exposed = (setup.overrides ?? []).some((o) => o.action === 'hide' && (o.classes ?? []).some((cl) => CURRENCY_CLASSES.includes(cl)));
  if (exposed && ctx.catalog) {
    const top = ctx.catalog.items.filter((it) => !it.hidden && it.type === 'currency' && /^t[123]/.test(it.tier) && !!it.class && CURRENCY_CLASSES.includes(it.class));
    const byLook = new Map<string, { style: LabelStyle; names: string[]; cls: Set<string> }>();
    for (const it of top) {
      const k = JSON.stringify(it.style);
      const e = byLook.get(k) ?? { style: it.style, names: [], cls: new Set<string>() };
      e.names.push(it.name);
      e.cls.add(it.class!);
      byLook.set(k, e);
    }
    let i = 0;
    for (const e of byLook.values()) {
      add({ id: `build:safety:currency:${++i}`, name: 'Top currency', stage: 'all', kind: 'force', group: 'safety', reason: "NeverSink's top three currency tiers are never hidden by a change to the build filter.", vis: 'show', conds: [c('Class', '==', ...e.cls), c('BaseType', '==', ...e.names.sort())], style: e.style });
    }
  }

  // leveling gems stay until the main skill replaces them; other gems go quiet at the end of the campaign
  const planGems = (s: Stage): string[] => [...new Set(skillsIn(s).flatMap((k) => [nameOfSkill(k.gemId), ...k.supports.map((x) => (ctx.game.gems[x] ? `${ctx.game.gems[x]!.name} Support` : x))]))].filter((n) => !gemNames(profile.gems).includes(n));
  for (const r of runs(stages.filter((s) => s.id === 'S0' || s.id === 'S1'), (s) => (planGems(s).length ? planGems(s).sort().join('|') : null))) {
    add({ id: `build:${lc(r.first.id)}:levgems`, name: 'Leveling gems', stage: r.first.id, kind: 'show', group: 'gems', reason: 'Gems your leveling skill uses until the main skill takes over.', vis: 'show', conds: [...band(r), c('Class', '==', 'Skill Gems', 'Support Gems'), c('BaseType', '==', ...r.key.split('|'))], style: BUILD_LOOK });
  }
  const gemHide = spanOf(showIds('S2', 'S3', 'S4'));
  if (gemHide) add({ id: `build:${lc(gemHide.first.id)}:hide:gems`, name: 'Gems you do not use', stage: gemHide.first.id, kind: 'hide', group: 'gems', reason: 'After the campaign only your own gems and well-leveled ones matter.', vis: 'hide', conds: [...band(gemHide), c('Class', '==', 'Skill Gems', 'Support Gems'), c('Quality', '<', '10'), c('GemLevel', '<', '20'), ...hideGuards(gemHide)] });

  // jewels
  const jl = spanOf(showIds('S2', 'S3', 'S4'));
  if (jl) {
    const reg = [...new Set(profile.jewels.filter((j) => j.kind === 'regular').map((j) => j.base))];
    const aby = [...new Set(profile.jewels.filter((j) => j.kind === 'abyss').map((j) => j.base))];
    if (reg.length) add({ id: `build:${lc(jl.first.id)}:jewels`, name: 'Your jewels', stage: jl.first.id, kind: 'show', group: 'jewels', reason: `Your tree uses ${reg.join(', ')}.`, vis: 'show', conds: [...band(jl), c('Class', '==', 'Jewels'), c('BaseType', '==', ...reg), c('Rarity', '', 'Normal', 'Magic', 'Rare')], style: QUIET_LOOK });
    if (aby.length) add({ id: `build:${lc(jl.first.id)}:jewels:abyss`, name: 'Your abyss jewels', stage: jl.first.id, kind: 'show', group: 'jewels', reason: `Your tree uses ${aby.join(', ')}.`, vis: 'show', conds: [...band(jl), c('Class', '==', 'Abyss Jewels'), c('BaseType', '==', ...aby), c('Rarity', '', 'Normal', 'Magic', 'Rare')], style: QUIET_LOOK });
    for (const j of profile.jewels.filter((x) => x.kind === 'cluster')) {
      add({ id: `build:${lc(jl.first.id)}:cluster:${j.enchant ?? j.base}`, name: `${j.base}${j.enchant ? `: ${j.enchant}` : ''}`, stage: jl.first.id, kind: 'show', group: 'jewels', reason: j.why, vis: 'show', conds: [...band(jl), c('BaseType', '==', j.base), ...(j.enchant ? [c('EnchantmentPassiveNode', '==', j.enchant)] : []), ...(j.passives ? [c('EnchantmentPassiveNum', '', String(j.passives))] : []), c('Rarity', '', 'Normal', 'Magic', 'Rare')], style: LOUD_LOOK });
    }
  }

  // changes made on top of the stages
  (setup.overrides ?? []).forEach((o, i) => {
    const sp = o.stage === 'all' ? allSpan : spanOf(stages.filter((s) => s.id === o.stage));
    if (!sp) return;
    const what = [...(o.classes ?? []), ...(o.bases ?? [])];
    if (!what.length) return;
    add({
      id: `build:override:${i}`,
      name: `${o.action === 'hide' ? 'Hide' : 'Show'} ${what.slice(0, 3).join(', ')}${what.length > 3 ? '...' : ''}`,
      stage: o.stage,
      kind: o.action,
      group: 'custom',
      reason: o.reason,
      vis: o.action,
      override: true,
      conds: [...band(sp), ...(o.classes?.length ? [c('Class', '==', ...o.classes)] : []), ...(o.bases?.length ? [c('BaseType', '==', ...o.bases)] : []), ...(o.action === 'hide' ? hideGuards(sp) : [c('Rarity', '<=', 'Rare')])],
      ...(o.action === 'show' ? { style: QUIET_LOOK } : {}),
    });
  });

  return finish(drafts, stages, setup, allSpan);
}

function finish(drafts: Draft[], stages: Stage[], setup: BuildSetup, _all: Span): Rule[] {
  const counters = new Map<string, number>();
  const next = (bucket: string): number => {
    const n = counters.get(bucket) ?? 0;
    counters.set(bucket, n + 1);
    return n;
  };
  const used = new Set<string>();
  const out: Rule[] = [];
  for (const d of drafts) {
    let id = d.id;
    for (let i = 2; used.has(id); i++) id = `${d.id}#${i}`;
    used.add(id);
    const k = d.stage === 'all' ? -1 : Math.max(0, stages.findIndex((s) => s.id === d.stage));
    let priority: number;
    if (d.kind === 'safety') priority = 1_000_000 - next('safety');
    else if (d.override) priority = -900 - next('override');
    else if (d.lift) priority = -950 - next('lift');
    else if (d.stage === 'all') priority = -1 - next('all');
    else if (d.vis === 'hide') priority = -1500 - k * 1000 - next(`h${k}`);
    else priority = -1000 - k * 1000 - next(`s${k}`);
    const off = (d.kind === 'safety' && !setup.safetyNet) || setup.disabled.includes(d.group) || setup.disabled.includes(id);
    out.push({
      id,
      name: d.name,
      source: 'build',
      enabled: !off,
      priority,
      targets: [{ conditions: d.conds }],
      visibility: d.vis,
      ...(d.vis === 'show' && d.style ? { style: d.style } : {}),
      why: d.reason,
      build: { stage: d.stage, kind: d.kind, reason: d.reason, group: d.group },
    });
  }
  return out;
}

/** Header comment lines and per-stage banners for `generateFilter`. */
export function buildFilterHeader(profile: BuildProfile, stages: Stage[], setup: BuildSetup, buildName: string): { header: string[]; banners: Record<string, string> } {
  const banners: Record<string, string> = { all: 'ALL Safety net and the items your build always needs' };
  for (const s of stages) banners[s.id] = stageBanner(s);
  return {
    header: [`build: ${buildName} (${profile.className} ${profile.mainSkill?.name ?? ''})`.trim().replace(/\s+\)/, ')'), `build-mode: ${setup.mode}`, `stages: ${stages.map((s) => `${s.id} ${s.lo}${s.hi >= OPEN_END ? '+' : `-${s.hi}`}`).join(', ')}`],
    banners,
  };
}

export interface BuiltFilter {
  profile: BuildProfile;
  stages: Stage[];
  rules: Rule[];
  /** Pass to `generateFilter` as `buildHeader` and `stageBanners`. */
  header: string[];
  banners: Record<string, string>;
}

/** Everything the Build Filter makes from a build file and a leveling plan, in one call. Null when the file is not a build. */
export function makeBuildFilter(xml: string, plan: LevelingPlan | null, setup: BuildSetup, ctx: BuildContext & { buildName?: string; cardRewards?: CardRewards }): BuiltFilter | null {
  const profile = readBuildProfile(xml, ctx.game, ctx.cardRewards ? { cardRewards: ctx.cardRewards } : {});
  if (!profile) return null;
  const stages = planStages(plan, setup.bounds);
  const rules = buildFilterRules(profile, plan, stages, setup, ctx);
  const h = buildFilterHeader(profile, stages, setup, ctx.buildName ?? profile.ascendancy ?? profile.className);
  return { profile, stages, rules, header: h.header, banners: h.banners };
}
