/**
 * The leveling guide: the exile-leveling route with our gem, link, swap, tree, lab, gear and flask steps attached.
 * Pure and deterministic: no network, no model. Step ids are hashes of the step's content, so ticks survive a regenerate.
 */
import { activeSpecOf, readFacts } from '../buildFacts.js';
import { parseAttrs } from '../buildXml.js';
import { offersFor, resolveGem, type GemIndex } from './offers.js';
import { colourString } from './plan.js';
import { parseRoute, type RouteOptions, type RouteStep } from './route.js';
import { orderPassives, type LevelingTree } from './treeOrder.js';
import type { Guide, GuideStep, LevelingData, LevelingPlan, StageId, StageRef } from './types.js';

export interface GuideGroup {
  /** Equipment slot the group is socketed in ("Body Armour"), '' when the build did not say. */
  slot: string;
  /** Resolved gemIds, active gem first. */
  gemIds: string[];
  main: boolean;
}

export interface GuideBuild {
  className: string;
  ascendancy: string;
  level: number;
  ruthless: boolean;
  groups: GuideGroup[];
  mainSkillId: string;
  mainSupportIds: string[];
  /** Set when the build's main skill is a transfigured gem. */
  transfigured?: { name: string; baseName: string };
  finalNodes: number[];
  /** Tree specs whose titles carry a level ("Level 30", "lvl30"). */
  checkpoints: { title: string; level: number; nodes: number[] }[];
}

export interface GuideOptions {
  route?: RouteOptions;
  tree?: LevelingTree | null;
}

// ---- reading a build file ----

/** A level in a spec title: "Level 30", "lvl30", "lvl 30", "L30". Acts ("Act 3") map to the level the route reaches there. */
export function levelInTitle(title: string): number | null {
  // "LVL 1-11" is a tree for levels 1 to 11: the checkpoint is its end, not its start
  const m = /\b(?:level|lvl|lv|l)\s*(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?\b/i.exec(title);
  if (m) return Number(m[2] ?? m[1]);
  return null;
}

export function readGuideBuild(xml: string, idx: GemIndex, data: LevelingData): GuideBuild {
  const f = readFacts(xml);
  const set = f.skillSets.find((s) => s.id === f.activeSkillSet) ?? f.skillSets[0];
  const spec = activeSpecOf(f);
  const isSupport = (id: string) => data.gems[id]?.isSupport ?? false;
  const groups: GuideGroup[] = [];
  let mainSkillId = '';
  let mainSupportIds: string[] = [];
  let transfigured: GuideBuild['transfigured'];
  (set?.groups ?? []).forEach((g, i) => {
    const isMainGroup = i + 1 === f.mainSocketGroup;
    if (!g.enabled || (!g.slot && !isMainGroup)) return;
    const ids: string[] = [];
    let activeIdx = -1;
    let activeCount = 0;
    const mainActive = Number(parseAttrs(/<Skill\b([^>]*)>/.exec(g.xml)?.[1] ?? '').mainActiveSkill ?? 1) || 1;
    for (const gem of g.gems) {
      if (!gem.enabled) continue;
      const a = parseAttrs(/<Gem\b([^>]*?)\/?>/.exec(gem.xml)?.[1] ?? '');
      const id = resolveGem({ gemId: a.gemId, skillId: a.skillId, nameSpec: a.nameSpec ?? gem.name }, idx);
      if (!id) continue;
      if (!isSupport(id)) {
        activeCount++;
        if (activeCount === mainActive) activeIdx = ids.length;
      }
      ids.push(id);
    }
    if (!ids.length) return;
    const actives = ids.filter((x) => !isSupport(x));
    const lead = activeIdx >= 0 ? ids[activeIdx]! : actives[0] ?? ids[0]!;
    const li = ids.indexOf(lead);
    const ordered = [lead, ...ids.filter((_, k) => k !== li)];
    groups.push({ slot: g.slot, gemIds: ordered, main: isMainGroup });
    if (isMainGroup) {
      mainSkillId = lead;
      mainSupportIds = ordered.slice(1).filter(isSupport);
      const gem = g.gems.find((x) => x.enabled && /Alt[XYZ]\b/.test(x.skillId));
      const gm = gem && data.gems[lead];
      if (gem && gm) transfigured = { name: gem.name, baseName: gm.name };
    }
  });
  if (!mainSkillId && groups[0]) {
    mainSkillId = groups[0].gemIds[0]!;
    mainSupportIds = groups[0].gemIds.slice(1).filter(isSupport);
  }
  const checkpoints: GuideBuild['checkpoints'] = [];
  for (const s of f.specs) {
    const level = levelInTitle(s.title);
    if (level !== null && s.nodes.length) checkpoints.push({ title: s.title, level, nodes: s.nodes });
  }
  return {
    className: f.className,
    ascendancy: f.ascendClassName,
    level: f.level,
    ruthless: /ruthless/i.test(spec?.treeVersion ?? ''),
    groups,
    mainSkillId,
    mainSupportIds,
    transfigured,
    finalNodes: spec?.nodes ?? [],
    checkpoints: checkpoints.sort((a, b) => a.level - b.level),
  };
}

// ---- helpers ----

function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

export function stagesFor(plan: LevelingPlan): StageRef[] {
  const swap = plan.swap?.level ?? 0;
  const out: StageRef[] = [];
  if (swap > 4) out.push({ id: 'S0', name: 'Leveling skill', lo: 1, hi: swap - 1 });
  if (swap < 45) out.push({ id: 'S1', name: 'Transition', lo: swap > 4 ? swap : 1, hi: 44 });
  out.push({ id: 'S2', name: 'Late campaign', lo: Math.max(45, swap), hi: 67 });
  out.push({ id: 'S3', name: 'Early maps', lo: 68, hi: 77 });
  out.push({ id: 'S4', name: 'Endgame', lo: 78, hi: 100 });
  return out;
}

const LAB: { which: 'Normal' | 'Cruel' | 'Merciless' | 'Eternal'; key: string }[] = [
  { which: 'Normal', key: 'normal' },
  { which: 'Cruel', key: 'cruel' },
  { which: 'Merciless', key: 'merciless' },
  { which: 'Eternal', key: 'eternal' },
];

interface Anchor {
  /** first arrive step with monsterLevel >= level (or 0 for level 1) */
  level?: number;
  /** first arrive step of this act */
  actStart?: number;
  /** after the hand-in of this quest */
  afterQuest?: string;
  /** when the quest has no hand-in on the route: before the first field zone at this level */
  fallbackLevel?: number;
  /** after the last step of this act */
  actEnd?: number;
  /** after this route step (by index) */
  afterStep?: number;
  /** very end of the guide */
  end?: boolean;
  step: GuideStep;
}

function gearLines(stage: StageRef, plan: LevelingPlan, data: LevelingData, build: GuideBuild): string[] {
  const first = plan.skills[0];
  const wc = first?.weaponClasses.length ? first.weaponClasses.join(', ') : '';
  switch (stage.id) {
    case 'S0':
      return [
        first ? `Level with ${first.name}${wc ? `. Keep a ${wc.replace(/s$/, '')} for it` : '. It needs no weapon'}.` : 'Level with your starting skill.',
        'Movement speed boots, life and resistances matter most.',
        first ? `Socket colours: ${first.colours}.` : '',
      ].filter(Boolean);
    case 'S1':
      return [data.gems[build.mainSkillId]?.name ? `${data.gems[build.mainSkillId]!.name} is your main skill now.` : 'Pick your main skill in the Skills tab; this guide follows it from here.','Weapons your build does not use are hidden from here on.', 'Chase a 4 link in your main colours, then 5.'];
    case 'S2':
      return ['Cap your resistances: the penalty is -30% by the end of Act 10.', 'Hunt the 5 link, then buy or craft the 6 link.'];
    case 'S3':
      return ['White and yellow maps. Craft your final bases here.', 'Armour that does not match your build is hidden.'];
    default:
      return ['Red maps and up. Only item level 86 bases of your gear types show.', 'Anything 6 linked or 6 socketed always shows.'];
  }
}

/** Quests a reward, purchase or swap hangs on whose hand-in the route never reaches. */
function missingQuests(g: Guide, plan: LevelingPlan): Set<string> {
  const steps = g.acts.flatMap((a) => a.steps);
  const handins = new Set(steps.flatMap((s) => (s.kind === 'handin' ? s.questIds : [])));
  const has = (q: string) => handins.has(q) || handins.has(q.replace(/[a-z]$/, ''));
  const out = new Set<string>();
  for (const s of steps) if ((s.kind === 'quest-reward' || s.kind === 'buy') && s.questId && !has(s.questId)) out.add(s.questId);
  if (plan.swap?.questId && !has(plan.swap.questId)) out.add(plan.swap.questId);
  return out;
}

/**
 * The default route skips quests that only the league-start route and the Library detour hand in (Mercy Mission, A Fixture of
 * Fate), yet Nessa's and Siosa's gems hang on them. When the guide needs such a quest, turn on the branch that visits it.
 */
export function buildGuide(build: GuideBuild, plan: LevelingPlan, data: LevelingData, opts: GuideOptions = {}): Guide {
  const g = buildGuideOnce(build, plan, data, opts);
  const missing = missingQuests(g, plan);
  if (!missing.size) return g;
  const tries: RouteOptions[] = [{ leagueStart: true }, { library: true }, { leagueStart: true, library: true }].map((r) => ({ ...opts.route, ...r }));
  for (const route of tries) {
    if (route.leagueStart === opts.route?.leagueStart && route.library === opts.route?.library) continue;
    const g2 = buildGuideOnce(build, plan, data, { ...opts, route });
    if (!missingQuests(g2, plan).size) return g2;
  }
  return g;
}

function buildGuideOnce(build: GuideBuild, plan: LevelingPlan, data: LevelingData, opts: GuideOptions = {}): Guide {
  const parsed = parseRoute(data.routes, data.zones, opts.route);
  const route = parsed.steps;
  // towns carry a monster level too (Lioneye's Watch says 13); only the fields count for "you are at level N"
  const zoneLevel = new Map(data.zones.map((z) => [z.id, z.town ? 0 : z.monsterLevel]));
  const nameOf = (id: string) => data.gems[id]?.name ?? id;
  const className = build.className || 'Scion';
  const stages = stagesFor(plan);
  const anchors: Anchor[] = [];
  const counter = new Map<string, number>();
  const mk = <T extends GuideStep>(kind: T['kind'], key: string, rest: Omit<T, 'id' | 'kind'>): T => {
    const base = kind + '|' + key;
    const n = counter.get(base) ?? 0;
    counter.set(base, n + 1);
    return { id: hash(base + (n ? '#' + n : '')), kind, ...rest } as T;
  };

  // ---- gem pickups ----
  type Want = { gemId: string; why: string; needBy: number };
  const wants: Want[] = [];
  const addWant = (gemId: string, why: string, needBy: number) => {
    if (!gemId || wants.some((w) => w.gemId === gemId)) return;
    wants.push({ gemId, why, needBy });
  };
  plan.skills.forEach((s, i) => {
    addWant(s.gemId, i === 0 ? `Your leveling skill until level ${s.to + 1}` : `Bridge skill until level ${s.to + 1}`, s.from);
    for (const sup of s.supports) addWant(sup, `Support for ${s.name}`, s.from);
  });
  const mainName = nameOf(build.mainSkillId);
  addWant(build.mainSkillId, 'Your main skill', plan.swap?.level ?? 1);
  for (const s of build.mainSupportIds) addWant(s, `Support for ${mainName}`, plan.swap?.level ?? 1);
  for (const g of build.groups) {
    if (g.main) continue;
    const lead = data.gems[g.gemIds[0]!]?.name ?? 'another skill';
    const where = g.slot ? ` in your ${g.slot.toLowerCase()}` : '';
    for (const id of g.gemIds) addWant(id, id === g.gemIds[0] ? `Another skill your build uses${where}` : `Support for ${lead}${where}`, 1);
  }

  const startText: string[] = [];
  const rewardTaken = new Map<string, string>(); // questId -> gemId
  const buys = new Map<string, { npc: string; questId: string; act: number; gems: { gemId: string; name: string; cost: string }[]; why: string[] }>();
  const gemLevels = new Map<string, number>();
  for (const w of wants) {
    const offers = offersFor(data, w.gemId, className, build.ruthless);
    const start = offers.find((o) => o.kind === 'start' || o.kind === 'chest');
    if (start) {
      gemLevels.set(w.gemId, 1);
      startText.push(`${nameOf(w.gemId)} ${start.kind === 'start' ? 'is your starting gem' : 'is in the chest in the first area'}`);
      continue;
    }
    // the earliest offer; a quest reward slot holds one gem, so a taken slot sends the gem to the vendor
    const pick = offers.find((o) => o.kind !== 'quest' || !rewardTaken.has(o.questId));
    if (!pick) continue;
    gemLevels.set(w.gemId, pick.level);
    if (pick.kind === 'quest') {
      rewardTaken.set(pick.questId, w.gemId);
    } else {
      const key = pick.npc + '|' + pick.questId;
      const b = buys.get(key) ?? { npc: pick.npc, questId: pick.questId, act: pick.act, gems: [], why: [] };
      b.gems.push({ gemId: w.gemId, name: nameOf(w.gemId), cost: '' });
      b.why.push(w.why);
      buys.set(key, b);
    }
  }

  const questName = new Map<string, string>();
  const questZone = new Map<string, string>();
  for (const r of route) if (r.kind === 'handin') for (const q of r.questIds) (questName.set(q, r.quest), questZone.set(q, r.zone));
  // an offer's quest id may carry a letter ("a1q5b": the same quest as "a1q5" for a second class group); the route knows the plain one
  const plainQ = (q: string) => q.replace(/[a-z]$/, '');
  const qName = (q: string) => questName.get(q) ?? questName.get(plainQ(q));
  const qZone = (q: string) => questZone.get(q) ?? questZone.get(plainQ(q)) ?? '';
  const wantOf = new Map(wants.map((w) => [w.gemId, w]));

  // every act that has a class reward gets a pick, even when nothing in the build comes from it
  const rewardQuests = new Map<string, number>(); // questId -> act, for quests with a reward for this class
  for (const [id, byClass] of Object.entries(data.offers)) {
    for (const o of byClass[className] ?? []) if (o.kind === 'quest' && o.act > 0) rewardQuests.set(o.questId, o.act);
    void id;
  }
  // a free pick leans toward gems that share tags with the main skill, so it is something the build may use later
  const mainTags = new Set((data.gems[build.mainSkillId]?.tags ?? []).map((t) => t.toLowerCase()).filter((t) => t !== 'support'));
  const extraRewards = new Map<string, string>();
  const buildGems = new Set([...wants.map((w) => w.gemId)]);
  const actHasPick = new Set<number>();
  for (const q of rewardTaken.keys()) actHasPick.add(rewardQuests.get(q) ?? 0);
  const questsInRouteOrder: string[] = [];
  for (const r of route) if (r.kind === 'handin') for (const q of r.questIds) if (rewardQuests.has(q) && !questsInRouteOrder.includes(q)) questsInRouteOrder.push(q);
  for (const q of questsInRouteOrder) {
    const act = rewardQuests.get(q)!;
    if (actHasPick.has(act) || rewardTaken.has(q)) continue;
    const pool = Object.keys(data.offers)
      .filter((id) => (data.offers[id]?.[className] ?? []).some((o) => o.kind === 'quest' && o.questId === q))
      .map((id) => ({ id, own: buildGems.has(id) ? 0 : 1, rank: data.skills.find((s) => s.gemId === id)?.rank ?? 500, level: data.gems[id]?.isSupport ? 1 : 0, alike: -(data.gems[id]?.tags ?? []).filter((t) => mainTags.has(t.toLowerCase())).length }))
      .sort((a, b) => a.own - b.own || a.alike - b.alike || a.rank - b.rank || a.level - b.level || a.id.localeCompare(b.id));
    const pick = pool[0];
    if (!pick) continue;
    actHasPick.add(act);
    extraRewards.set(q, pick.id);
  }
  for (const [questId, gemId] of extraRewards) {
    rewardTaken.set(questId, gemId);
    if (!wantOf.has(gemId)) wantOf.set(gemId, { gemId, why: 'A free pick. Nothing your build needs comes from this quest, so take a gem you can use later.', needBy: 0 });
  }
  for (const [questId, gemId] of rewardTaken) {
    const alts = Object.keys(data.offers)
      .filter((id) => id !== gemId && (data.offers[id]?.[className] ?? []).some((o) => o.kind === 'quest' && o.questId === questId))
      .map((id) => ({ id, rank: data.skills.find((s) => s.gemId === id)?.rank ?? 999 }))
      .filter((x) => x.rank < 999)
      .sort((a, b) => a.rank - b.rank)
      .slice(0, 3)
      .map((x) => nameOf(x.id));
    const step = mk<Extract<GuideStep, { kind: 'quest-reward' }>>('quest-reward', questId + gemId, {
      zone: qZone(questId),
      quest: qName(questId) ?? questId,
      questId,
      take: nameOf(gemId),
      gemId,
      ...(alts.length ? { alt: alts } : {}),
      why: wantOf.get(gemId)?.why ?? '',
    });
    anchors.push({ afterQuest: questId, fallbackLevel: gemLevels.get(gemId) ?? 1, step });
  }
  for (const b of buys.values()) {
    const who = b.npc === 'Siosa' ? 'Siosa sells every gem' : b.npc === 'Lilly Roth' ? 'Lilly Roth sells every gem' : `${b.npc} sells these to your class`;
    const step = mk<Extract<GuideStep, { kind: 'buy' }>>('buy', b.npc + b.questId + b.gems.map((g) => g.gemId).join(), {
      npc: b.npc,
      zone: qZone(b.questId),
      questId: b.questId,
      gems: b.gems,
      why: `${who}. ${[...new Set(b.why)].slice(0, 3).join('; ')}.`,
    });
    anchors.push({ afterQuest: b.questId, fallbackLevel: Math.max(...b.gems.map((g) => gemLevels.get(g.gemId) ?? 1)), step });
  }
  if (startText.length) {
    anchors.push({ level: 1, step: mk<Extract<GuideStep, { kind: 'text' }>>('text', 'start-gems', { text: startText.join('. ') + '.', notes: [] }) });
  }

  // ---- links, swap, transfigure ----
  const bodySlot = build.groups.find((g) => g.main)?.slot || 'Body Armour';
  // A link names only gems the player can own by then: the active skill, and supports an NPC sells or gives by that level.
  // A drop-only support waits for the endgame step. Fewer than two gems is nothing to link.
  const ownableBy = (id: string, level: number): boolean => {
    const o = offersFor(data, id, className, build.ruthless)[0];
    return !!o && o.level <= Math.max(level, 1);
  };
  const linkStep = (level: number, gemIds: string[], slot: string, max: number): GuideStep | null => {
    const ids = gemIds.filter((id, i) => i === 0 || ownableBy(id, level)).slice(0, max);
    if (ids.length < 2) return null;
    return mk<Extract<GuideStep, { kind: 'links' }>>('links', `${level}|${slot}|${ids.join()}`, {
      at: { level, zone: '' },
      groups: [{ slot, gems: ids.map(nameOf), colours: colourString(ids.map((g) => data.gems[g]?.colour ?? 'W')) }],
    });
  };
  const pushLinks = (a: Omit<Anchor, 'step'>, step: GuideStep | null): void => {
    if (step) anchors.push({ ...a, step });
  };
  const mainGroup = [build.mainSkillId, ...build.mainSupportIds];
  const first = plan.skills[0];
  if (first) {
    pushLinks({ level: 1 }, linkStep(1, [first.gemId, ...first.supports], 'Body Armour', 3));
    if (!plan.swap || plan.swap.level > 13) {
      const cur = plan.skills[plan.skills.length - 1]!;
      pushLinks({ level: 13 }, linkStep(13, [cur.gemId, ...cur.supports], 'Body Armour', 4));
    }
  } else {
    pushLinks({ level: 1 }, linkStep(1, mainGroup, bodySlot, 3));
    pushLinks({ level: 13 }, linkStep(13, mainGroup, bodySlot, 4));
  }
  if (plan.swap) {
    const sw = plan.swap;
    const from = plan.skills.map((s) => s.name).join(' and ');
    const swapStep = mk<Extract<GuideStep, { kind: 'swap' }>>('swap', String(sw.level), { level: sw.level, from, to: mainName });
    if (!!qName(sw.questId)) anchors.push({ afterQuest: sw.questId, step: swapStep });
    else anchors.push({ level: sw.level, step: swapStep });
    pushLinks({ afterQuest: !!qName(sw.questId) ? sw.questId : undefined, level: !!qName(sw.questId) ? undefined : sw.level }, linkStep(sw.level, mainGroup, bodySlot, 4));
  }
  const act6 = route.find((r) => r.kind === 'arrive' && r.act === 6 && (zoneLevel.get(r.zoneId) ?? 0) > 0);
  if (act6) pushLinks({ actStart: 6 }, linkStep(zoneLevel.get((act6 as Extract<RouteStep, { kind: 'arrive' }>).zoneId) || 40, mainGroup, bodySlot, 5));
  anchors.push({
    end: true,
    step: mk<Extract<GuideStep, { kind: 'links' }>>('links', 'endgame', {
      at: { level: 80, zone: 'Maps' },
      groups: build.groups.map((g) => ({ slot: g.slot, gems: g.gemIds.map(nameOf), colours: colourString(g.gemIds.map((x) => data.gems[x]?.colour ?? 'W')) })),
    }),
  });
  if (build.transfigured) {
    anchors.push({
      actStart: 9,
      step: mk<Extract<GuideStep, { kind: 'transfigure' }>>('transfigure', build.transfigured.name, {
        gem: build.transfigured.name,
        how: `Turn ${build.transfigured.baseName} into ${build.transfigured.name} with the Hidden Gem: Transfigured in the Act 9 Trial of Ascendancy, or at a Labyrinth gem font. Dialla's Desire also works.`,
      }),
    });
  }

  // ---- gear and flasks ----
  for (const st of stages) {
    const atSwap = plan.swap && st.lo === plan.swap.level && st.id === 'S1' && !!qName(plan.swap.questId);
    anchors.push({ ...(atSwap ? { afterQuest: plan.swap!.questId } : { level: st.lo }), step: mk<Extract<GuideStep, { kind: 'gear' }>>('gear', st.id, { stage: st.id as StageId, lines: gearLines(st, plan, data, build) }) });
  }
  anchors.push({ level: 1, step: mk<Extract<GuideStep, { kind: 'flask' }>>('flask', 'qsilver', { level: 1, lines: ['Buy a Quicksilver Flask from the Act 1 vendor, and keep a life flask running.'] }) });
  for (let a = 2; a <= 10; a++) {
    anchors.push({ actStart: a, step: mk<Extract<GuideStep, { kind: 'flask' }>>('flask', 'life' + a, { level: 0, lines: ['Swap your life flask for the best one your level allows.'] }) });
  }

  // ---- passive tree and labs ----
  const tree = opts.tree ?? null;
  const order = tree ? orderPassives(tree, build.finalNodes) : { order: [] as number[], ascend: [] as number[] };
  const total = order.order.length;
  const nodeName = (id: number) => tree?.name(id) ?? String(id);
  const nodeKind = new Map((tree?.nodes ?? []).map((n) => [n.id, n.t]));
  const extras = data.questExtras;
  let questPoints = 0;
  const countedQuests = new Set<string>();
  let treeN = 0;
  let given = 0;
  const taken = new Set<number>();
  const idxOf = new Map(order.order.map((id, i) => [id, i]));
  const treeStep = (level: number, points: number, act: number, nodes?: number[], where?: string): GuideStep | null => {
    let add: number[];
    if (nodes) {
      const set = new Set(nodes);
      add = order.order.filter((id) => set.has(id) && !taken.has(id));
      for (const id of add) taken.add(id);
      given = Math.max(given, taken.size);
    } else {
      const want = Math.min(total, Math.max(given, points));
      add = order.order.filter((id) => !taken.has(id)).slice(0, Math.max(0, want - taken.size));
      for (const id of add) taken.add(id);
      given = Math.max(given, taken.size);
    }
    if (!add.length && treeN > 0) return null;
    treeN++;
    return mk<Extract<GuideStep, { kind: 'tree' }>>('tree', `${treeN}|${level}`, {
      level,
      points: Math.max(given, 0),
      add,
      notables: add.filter((id) => nodeKind.get(id) === 1 || nodeKind.get(id) === 2).map(nodeName),
      specTitle: `Leveling ${treeN}: ${where ?? `Act ${act}`} (lvl ${level})`,
    });
  };

  if (tree && total) {
    if (build.checkpoints.length >= 2) {
      for (const cp of build.checkpoints) {
        const pts = cp.nodes.filter((id) => idxOf.has(id)).length;
        const s = treeStep(cp.level, pts, actAtLevel(route, zoneLevel, cp.level), cp.nodes);
        if (s) anchors.push({ level: cp.level, step: s });
      }
    } else {
      let lvl = 1;
      for (let act = 1; act <= 10; act++) {
        const inAct = route.filter((r) => r.act === act);
        if (!inAct.length) continue;
        for (const r of inAct) if (r.kind === 'handin') for (const q of r.questIds) if (!countedQuests.has(q)) (countedQuests.add(q), (questPoints += extras[q]?.passives ?? 0)); // a quest is handed in more than once on the route (a9q5 three times): count it once
        for (const r of inAct) if (r.kind === 'arrive') lvl = Math.max(lvl, zoneLevel.get(r.zoneId) || 1);
        const level = Math.min(100, Math.max(lvl, 1));
        const s = treeStep(level, level - 1 + questPoints, act);
        if (s) anchors.push({ actEnd: act, step: s });
      }
      // the rest of the tree comes in the maps
      const rest = treeStep(Math.max(build.level, lvl), total, 10, undefined, 'Maps');
      if (rest) anchors.push({ end: true, step: rest });
    }
  }
  // labs: where the route says {ascend|x}; Eternal at the end
  const labStep = (which: (typeof LAB)[number]['which'], i: number) => {
    const ids = order.ascend.slice(i * 2, i * 2 + 2);
    return mk<Extract<GuideStep, { kind: 'lab' }>>('lab', which, { which, ascend: ids, ascendNames: ids.map(nodeName) });
  };
  route.forEach((r, i) => {
    if (r.kind !== 'text' || !r.ascend) return;
    const k = LAB.findIndex((l) => l.key === r.ascend);
    if (k < 0) return;
    anchors.push({ afterStep: i, step: labStep(LAB[k]!.which, k) });
  });
  anchors.push({ end: true, step: labStep('Eternal', 3) });

  // ---- assemble ----
  const arrivals: { i: number; level: number }[] = [];
  route.forEach((r, i) => {
    if (r.kind === 'arrive') arrivals.push({ i, level: zoneLevel.get(r.zoneId) ?? 0 });
  });
  const before = new Map<number, GuideStep[]>();
  const after = new Map<number, GuideStep[]>();
  const tail: GuideStep[] = [];
  const put = (m: Map<number, GuideStep[]>, i: number, s: GuideStep) => (m.get(i) ?? m.set(i, []).get(i)!).push(s);
  const lastOfAct = new Map<number, number>();
  const firstArriveOfAct = new Map<number, number>();
  route.forEach((r, i) => {
    lastOfAct.set(r.act, i);
    if (r.kind === 'arrive' && !firstArriveOfAct.has(r.act)) firstArriveOfAct.set(r.act, i);
  });
  const handinIdx = new Map<string, number>();
  route.forEach((r, i) => {
    if (r.kind === 'handin') for (const q of r.questIds) if (!handinIdx.has(q)) handinIdx.set(q, i);
  });
  for (const a of anchors) {
    if (a.afterQuest !== undefined) {
      const i = handinIdx.get(a.afterQuest) ?? handinIdx.get(a.afterQuest.replace(/[a-z]$/, ''));
      if (i !== undefined) put(after, i, a.step);
      else if (a.fallbackLevel !== undefined) {
        const hit = a.fallbackLevel <= 1 ? arrivals[0] : arrivals.find((x) => x.level > 0 && x.level >= a.fallbackLevel!);
        if (hit) put(before, hit.i, a.step);
        else tail.push(a.step);
      } else tail.push(a.step);
    } else if (a.afterStep !== undefined) put(after, a.afterStep, a.step);
    else if (a.actStart !== undefined) {
      const i = firstArriveOfAct.get(a.actStart);
      if (i !== undefined) put(before, i, a.step);
      else tail.push(a.step);
    } else if (a.actEnd !== undefined) {
      const i = lastOfAct.get(a.actEnd);
      if (i !== undefined) put(after, i, a.step);
      else tail.push(a.step);
    } else if (a.level !== undefined) {
      const hit = a.level <= 1 ? arrivals[0] : arrivals.find((x) => x.level > 0 && x.level >= a.level!);
      if (hit) put(before, a.level <= 1 ? 0 : hit.i, a.step);
      else tail.push(a.step);
    } else tail.push(a.step);
  }
  const zoneAt = (i: number): string => {
    for (let k = i; k >= 0; k--) {
      const r = route[k]!;
      if (r.kind === 'arrive') return r.zoneName;
    }
    return '';
  };
  const acts = new Map<number, GuideStep[]>();
  const push = (act: number, s: GuideStep) => (acts.get(act) ?? acts.set(act, []).get(act)!).push(s);
  route.forEach((r, i) => {
    for (const s of before.get(i) ?? []) {
      if (s.kind === 'links' && !s.at.zone) s.at.zone = zoneAt(i) || (s.at.level <= 1 ? 'The Twilight Strand' : '');
      push(r.act, s);
    }
    if (r.kind === 'arrive') push(r.act, mk<Extract<GuideStep, { kind: 'arrive' }>>('arrive', r.zoneId, { zone: r.zoneName, zoneId: r.zoneId, areaLevel: zoneLevel.get(r.zoneId) ?? 0, text: r.text, notes: r.notes }));
    else if (r.kind === 'handin') push(r.act, mk<Extract<GuideStep, { kind: 'handin' }>>('handin', r.questIds.join(), { questIds: r.questIds, quest: r.quest, zone: r.zone, text: r.text }));
    else push(r.act, mk<Extract<GuideStep, { kind: 'text' }>>('text', r.text, { text: r.text, notes: r.notes }));
    for (const s of after.get(i) ?? []) {
      if (s.kind === 'links' && !s.at.zone) s.at.zone = r.kind === 'handin' && r.zone ? r.zone : zoneAt(i);
      push(r.act, s);
    }
  });
  const lastAct = route.length ? route[route.length - 1]!.act : 10;
  const tailRank = (s: GuideStep) => (s.kind === 'gear' || s.kind === 'flask' ? 1 : s.kind === 'tree' ? 2 : s.kind === 'links' ? 3 : s.kind === 'lab' ? 4 : 0);
  tail.sort((a, b) => tailRank(a) - tailRank(b) || (a.kind === 'gear' && b.kind === 'gear' ? a.stage.localeCompare(b.stage) : 0));
  for (const s of tail) push(lastAct, s);

  placeLinksAfterGems(acts, nameOf, data.starts[className]);
  return {
    league: data.league,
    class: className,
    stages,
    acts: [...acts.entries()].sort((a, b) => a[0] - b[0]).map(([act, steps]) => ({ act, steps })),
  };
}

/**
 * A links step lists gems the player may not own yet: the level 1 step comes before the first hand-in, but the leveling skill
 * is that quest's reward. Move each links step (not the endgame one) to just after the last step that gives one of its gems.
 */
function placeLinksAfterGems(acts: Map<number, GuideStep[]>, nameOf: (id: string) => string, start: { start: string; chest: string } | undefined): void {
  const flat: { act: number; s: GuideStep }[] = [...acts.entries()].sort((a, b) => a[0] - b[0]).flatMap(([act, steps]) => steps.map((s) => ({ act, s })));
  const given = new Map<string, number>(); // gem name -> index of the first step that gives it
  const note = (name: string, i: number) => {
    if (!given.has(name)) given.set(name, i);
  };
  flat.forEach(({ s }, i) => {
    if (s.kind === 'quest-reward') note(nameOf(s.gemId), i);
    else if (s.kind === 'buy') for (const g of s.gems) note(g.name, i);
  });
  const own = new Set([start?.start, start?.chest].filter((x): x is string => !!x).map(nameOf));
  const keyed = flat.map((x, i) => {
    let key = i;
    let act = x.act;
    let zone: string | undefined;
    if (x.s.kind === 'links' && x.s.at.zone !== 'Maps') {
      let last = -1;
      for (const nm of x.s.groups.flatMap((g) => g.gems)) {
        const at = own.has(nm) ? undefined : given.get(nm);
        if (at !== undefined && at > i && at > last) last = at;
      }
      if (last > i) {
        key = last + 0.5 + i / 1e6;
        act = flat[last]!.act;
        const g = flat[last]!.s;
        zone = g.kind === 'quest-reward' || g.kind === 'buy' ? g.zone : undefined;
      }
    }
    return { key, act, s: x.s, zone };
  });
  if (!keyed.some((k, i) => k.key !== i)) return;
  keyed.sort((a, b) => a.key - b.key);
  acts.clear();
  for (const k of keyed) {
    if (k.zone && k.s.kind === 'links') k.s.at.zone = k.zone;
    (acts.get(k.act) ?? acts.set(k.act, []).get(k.act)!).push(k.s);
  }
}

function actAtLevel(route: RouteStep[], zoneLevel: Map<string, number>, level: number): number {
  for (const r of route) if (r.kind === 'arrive' && (zoneLevel.get(r.zoneId) ?? 0) >= level) return r.act;
  return route.length ? route[route.length - 1]!.act : 10;
}
