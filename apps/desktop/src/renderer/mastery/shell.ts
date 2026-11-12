// What the App shell hands every new area host (Atlas, Timelines, Marketplace).
import type { Area } from '../shell/routes.js';

/** A cross-area request: "open this", "publish that". Each host reads only the kinds meant for it. */
export type AreaIntent =
  | { kind: 'open-document'; objectId: string; revisionId?: string }
  | { kind: 'public-item'; publicId: string; revision?: number; view?: 'run' }
  | { kind: 'publish'; source?: { kind: 'build' | 'atlas' | 'timeline'; objectId: string } }
  | { kind: 'send-to-timeline'; source: { kind: 'build' | 'atlas' | 'filter' | 'saved'; objectId: string };
      /** An Atlas step transition (its text and the plan's stamp): sent as a note instead of the whole plan. */
      transition?: { text: string; title: string; stamp: import('@pom/mastery-contracts').LeagueStamp } }
  | { kind: 'creator'; name: string }
  /** Atlas: open Compare with this (read-only saved) plan on the right and the person's own plan on the left. */
  | { kind: 'compare-plan'; objectId: string }
  | { kind: 'marketplace-view'; view: 'feed' | 'saved' | 'mine' | 'inbox' | 'moderation' };

export type MasteryShell = {
  online: boolean;
  /** True while this area is the one on screen (areas stay mounted, hidden, when you leave them). */
  active: boolean;
  signedIn: boolean;
  aiAccess: boolean;
  /** The current account id (null signed out). */
  accountId: string | null;
  /** Opens the existing sign-in dialog. */
  signIn(): void;
  /** Asks for AI access (the sign-in flow). */
  requestAiAccess(): void;
  /** Switch area, optionally carrying an intent the target host consumes once. */
  go(area: Area, intent?: AreaIntent): void;
  /** Pending intent for this host (consume it, then call clearIntent). */
  intent: AreaIntent | null;
  clearIntent(): void;
  toast(text: string): void;
  copyText(text: string): Promise<boolean>;
  openExternal(url: string): void;
  /** Saves a league-start guide's build to the library and opens it (the same path as the first-launch chooser). */
  followStarter?(starterId: string): Promise<void>;
};
