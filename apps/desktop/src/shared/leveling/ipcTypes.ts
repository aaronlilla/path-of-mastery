/** Channel names and payloads of the Leveling tab's IPC (main/leveling/ipc.ts, preload/leveling.ts). */
import type { Guide, LevelingPlan } from './types.js';

export const LVL = {
  GUIDE: 'pom:lvl-guide',
  TICK: 'pom:lvl-tick',
  SETTINGS: 'pom:lvl-settings',
  /** main -> renderer: the game log says the character entered a zone */
  ZONE: 'pom:lvl-zone',
} as const;

export interface LevelingProgressDto {
  ticked: string[];
  autoTick: boolean;
  leagueStart: boolean;
  levelingSkill?: string;
}

export interface GuideRequest {
  buildId: string;
  xml: string;
}

export interface CandidateDto {
  gemId: string;
  name: string;
  score: number;
  reason: string;
  availLevel: number;
}

export interface GuideResult {
  guide: Guide;
  plan: LevelingPlan;
  progress: LevelingProgressDto;
  candidates: CandidateDto[];
  build: { className: string; ascendancy: string; mainSkill: string; level: number; ruthless: boolean };
  /** Node ids to names for the tree steps. */
  nodeNames: Record<number, string>;
  /** Set when the passive tree data for the build's version is missing: tree steps are left out. */
  treeNote?: string;
  /** Set when the leveling data is from another league than the build's tree. */
  warning?: string;
  /** Steps of the guide: gem names by gemId, for the chips. */
  gems: Record<string, { name: string; colour: string }>;
}

export interface SettingsPatch {
  autoTick?: boolean;
  leagueStart?: boolean;
  /** gemId, or '' to go back to the computed one */
  levelingSkill?: string;
}

export interface ZoneEvent {
  name: string;
  at: number;
}

export interface LevelingBridge {
  guide(req: GuideRequest): Promise<{ ok: true; value: GuideResult } | { ok: false; error: string }>;
  tick(buildId: string, stepIds: string[], done: boolean): Promise<{ ok: true; value: LevelingProgressDto } | { ok: false; error: string }>;
  settings(buildId: string, patch: SettingsPatch): Promise<{ ok: true; value: LevelingProgressDto } | { ok: false; error: string }>;
  onZone(cb: (e: ZoneEvent) => void): () => void;
}
