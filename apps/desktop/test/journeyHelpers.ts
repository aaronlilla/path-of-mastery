import type { Guide, GuideStep, LevelingPlan, ZoneInfo } from '../src/shared/leveling/types.js';
import { PassiveResolver, type TreeNodeInfo } from '../src/shared/journey/treeTrack.js';
import type { LiveBuild, LiveKbView } from '../src/main/journey/live.js';

export const ZONES: ZoneInfo[] = [
  { order: 1, id: '1_1_town', name: "Lioneye's Watch", act: 1, monsterLevel: 13, town: true, waypoint: true },
  { order: 2, id: '1_1_2', name: 'The Coast', act: 1, monsterLevel: 2, town: false, waypoint: true },
  { order: 3, id: '1_1_3', name: 'The Mud Flats', act: 1, monsterLevel: 4, town: false, waypoint: false },
  { order: 4, id: '5_2_town', name: 'Overseer\'s Tower', act: 5, monsterLevel: 40, town: true, waypoint: true },
  { order: 5, id: '6_1_town', name: 'Lioneye\'s Watch (Act 6)', act: 6, monsterLevel: 45, town: true, waypoint: true },
  { order: 6, id: '6_1_2', name: 'The Twilight Strand (Act 6)', act: 6, monsterLevel: 45, town: false, waypoint: false },
];

export function synthKb(over: Partial<LiveKbView> = {}): LiveKbView {
  return {
    zones: ZONES,
    penaltyAtAct: (a) => (a >= 6 ? -30 : 0),
    xpSafe: (l) => ({ below: 3 + Math.floor(l / 16), above: 3 + Math.floor(l / 16) }),
    resistCap: 75,
    dataPatch: { patch: '3.29', behind: false, livePatch: null },
    ...over,
  };
}

const step = (s: GuideStep): GuideStep => s;

export const GUIDE: Guide = {
  league: '3.29',
  class: 'Ranger',
  stages: [],
  acts: [
    {
      act: 1,
      steps: [
        step({ id: 's-town', kind: 'arrive', zone: "Lioneye's Watch", zoneId: '1_1_town', areaLevel: 0, text: 'Town', notes: [] }),
        step({ id: 's-coast', kind: 'arrive', zone: 'The Coast', zoneId: '1_1_2', areaLevel: 2, text: 'The Coast', notes: [] }),
        step({ id: 's-mud', kind: 'arrive', zone: 'The Mud Flats', zoneId: '1_1_3', areaLevel: 4, text: 'The Mud Flats', notes: [] }),
        step({ id: 's-reward', kind: 'quest-reward', zone: "Lioneye's Watch", quest: 'Enemy at the Gate', questId: 'a1q1', take: 'Frost Blades', gemId: 'g-fb', why: 'main', }),
        step({ id: 's-tree', kind: 'tree', level: 12, points: 13, add: [10, 11, 20], notables: ["Hunter's Gambit"], specTitle: 'Leveling 1' }),
        step({ id: 's-hand', kind: 'handin', questIds: ['a1q1'], quest: 'Enemy at the Gate', zone: "Lioneye's Watch", text: 'Hand in' }),
      ],
    },
  ],
};

export const PLAN: LevelingPlan = { swap: null, skills: [{ gemId: 'g-fb', name: 'Frost Blades', from: 1, to: 12, supports: [], weaponClasses: [], colours: 'G' }] };

export const NODES: TreeNodeInfo[] = [
  { id: 1, name: 'Ranger', links: [10, 30], kind: 'start' },
  { id: 10, name: 'Life', links: [1, 11], kind: 'normal' },
  { id: 11, name: 'Life', links: [10, 12], kind: 'normal' },
  { id: 12, name: 'Life', links: [11, 20], kind: 'normal' },
  { id: 20, name: "Hunter's Gambit", links: [12], kind: 'notable' },
  { id: 30, name: 'Dexterity', links: [1], kind: 'normal' },
];

export function synthBuild(over: Partial<LiveBuild> = {}): LiveBuild {
  return {
    buildKey: 'b1',
    name: 'PConc',
    className: 'Ranger',
    ascendancy: 'Pathfinder',
    mainSkill: 'Poisonous Concoction',
    level: 90,
    guide: GUIDE,
    plan: PLAN,
    data: { questExtras: { a1q1: { passives: 2 } }, gems: { 'g-fb': { name: 'Frost Blades', isSupport: false, colour: 'G' } }, offers: {} },
    checkpoints: [{ id: 'cp1', name: 'Leveling 1', level: 12, tree: [10, 11, 20], detours: [] }],
    resolver: new PassiveResolver(NODES),
    notCounted: (id) => id === 1,
    nodeNames: { 10: 'Life', 11: 'Life', 20: "Hunter's Gambit", 12: 'Life', 30: 'Dexterity' },
    ...over,
  };
}
