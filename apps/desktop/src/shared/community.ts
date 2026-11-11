/** Community builds: what the list shows, and what publishing sends. */
export interface CommunityBuild {
  id: string;
  name: string;
  /** The display name the owner chose when publishing. Plain text. */
  author: string;
  /** 'curated' builds are picked by the app's owner and say so; everything else is 'user'. */
  source: 'user' | 'curated';
  className: string;
  ascendClassName: string;
  level: number;
  mainSkill: string;
  stats: Record<string, number>;
  updatedAt: number;
  /** Only on the caller's own list: the build was reported by three players and is hidden from everyone else. */
  hidden?: boolean;
}

export interface CommunityFull extends CommunityBuild {
  xml: string;
  treeVersion: string;
}

export interface CommunityPublishInput {
  name: string;
  author: string;
  xml: string;
  className: string;
  ascendClassName: string;
  level: number;
  mainSkill: string;
  treeVersion: string;
  stats?: Record<string, number>;
}

/** What a row of the community list reads as: "Slayer · Lv 95" (the ascendancy when there is one, else the class). */
export function communityClassLabel(b: Pick<CommunityBuild, 'className' | 'ascendClassName'>): string {
  return b.ascendClassName && b.ascendClassName !== 'None' ? b.ascendClassName : b.className;
}

/** Removes the Notes block so a published build carries no private writing unless the player chose to include it. */
export function stripNotes(xml: string): string {
  return xml.replace(/<Notes>[\s\S]*?<\/Notes>/g, '<Notes></Notes>').replace(/<Notes\s*\/>/g, '<Notes></Notes>');
}

export const PUBLISH_CONSENT = 'I understand this build becomes public to all players and can be removed any time under My published builds.';
