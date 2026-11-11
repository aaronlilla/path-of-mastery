/**
 * What the Live screen needs beyond the day-0 `LiveState`, and the channels only the Live and Link screens use.
 * `LiveStateX` is a superset of `LiveState`: everything in the contract is still there.
 */
import type { CharacterRow, Realm } from '../characterImport.js';
import type { Guide } from '../leveling/types.js';
import type { CharacterMatch, JrnResult } from './ipcTypes.js';
import type { CharacterLink, LiveState } from './types.js';

export const JRNX = {
  /** invoke: the build Journey follows { buildKey, name, xml } -> BuildInfo */
  SET_BUILD: 'pom:jrn-set-build',
  /** invoke: tick or untick guide steps { ids, done } -> LiveStateX */
  TICK: 'pom:jrn-tick',
  /** invoke: keep or refund an off-plan node { node, op } -> LiveStateX */
  OFFPLAN: 'pom:jrn-offplan',
  /** invoke: hide the town advice until the next zone */
  DISMISS_TOWN: 'pom:jrn-dismiss-town',
  /** invoke: the link for a build, or null */
  GET_LINK: 'pom:jrn-get-link',
  /** invoke: the current LiveStateX without changing anything */
  STATE: 'pom:jrn-state',
  /** invoke: the Journey tab's saved settings */
  SETTINGS: 'pom:jrn-settings',
} as const;

export interface BuildInfo {
  buildKey: string;
  name: string;
  className: string;
  ascendancy: string;
  mainSkill: string;
  level: number;
  guide: Guide;
  gems: Record<string, { name: string; colour: string }>;
  nodeNames: Record<number, string>;
}

export interface LiveStateX extends LiveState {
  buildKey: string | null;
  buildName: string | null;
  /** Who Journey thinks is playing. `known` is false until a log line names the linked character. */
  playing: { name: string; known: boolean } | null;
  /** Over or under the safe range of the zone's level, from the KB xp-penalty table. */
  xp: { state: 'over' | 'under' | 'ok'; by: number } | null;
  /** The checkpoint the tree diff and the gear gaps are measured against. */
  checkpoint: { id: string; name: string; level: number } | null;
  ticked: string[];
  names: { nodes: Record<number, string>; gems: Record<string, { name: string; colour: string }> };
  notes: string[];
  logPath: string;
  deaths: number;
  /** Nodes the player chose to keep or to refund. */
  kept: number[];
  refund: number[];
  /** What the nodes of `treeDiff` came from. */
  treeSource: 'log' | 'sync' | 'none';
  /** The last 5 unticked guide steps are in `next`; this is the full count still to do. */
  stepsLeft: number;
  /** AI access unlocks the AI features: Jev-decided town advice, explanations and Best setup. Free keeps the code-only rest. */
  aiAccess: boolean;
}

export interface LinkRowsRequest {
  realm: Realm;
  league?: string;
  /** The build to match against. */
  buildKey: string;
}

export type LinkRows = { rows: (CharacterRow & { match: CharacterMatch })[]; account: string };

export interface JourneyLiveBridge {
  setBuild(b: { buildKey: string; name: string; xml: string }): Promise<JrnResult<BuildInfo>>;
  tick(ids: string[], done: boolean): Promise<JrnResult<LiveStateX>>;
  offPlan(node: number, op: 'keep' | 'refund'): Promise<JrnResult<LiveStateX>>;
  dismissTown(): Promise<JrnResult<LiveStateX>>;
  getLink(): Promise<JrnResult<CharacterLink | null>>;
  state(): Promise<JrnResult<LiveStateX>>;
}
