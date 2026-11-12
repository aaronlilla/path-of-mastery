import type { CommunityBuild, CommunityFull, CommunityPublishInput } from './community.js';
/**
 * Types shared by the main process, the preload bridge and the renderer for accounts, cloud sync,
 * version history and share links. Plain data only.
 */

export type ProviderId = 'google' | 'discord' | 'github';

export interface AccountUser {
  id: string;
  email: string;
  /** Display name from the provider; falls back to the part of the email before the @. */
  name: string;
  avatarUrl: string;
}

export type AuthView =
  | { state: 'signedOut' }
  /** The stored session is being refreshed on launch. */
  | { state: 'restoring'; user: AccountUser }
  /** The browser has the provider's page open. */
  | { state: 'browser'; provider: ProviderId }
  /** An email link was sent and we wait for it to be opened on this computer. */
  | { state: 'emailSent'; email: string; resendAt: number }
  | { state: 'signedIn'; user: AccountUser; /** False when the OS has no secure storage, so the session ends with the app. */ persistent: boolean };

export interface ProviderStatus {
  id: ProviderId;
  /** The app's switch for this provider (GitHub stays off until the GitHub app is set up). */
  allowed: boolean;
  /** Whether the Supabase project has it switched on; null when that could not be read. */
  enabled: boolean | null;
}

export type SyncState = 'local' | 'synced' | 'syncing' | 'offline' | 'conflict' | 'error';

/** One build's place in the sync, shown on its card in the Library. */
export interface BuildSyncStatus {
  status: 'synced' | 'syncing' | 'offline' | 'conflict' | 'error';
  /** Local changes not yet in the cloud. */
  pending: number;
  /** What changed, in words, for a pending build ("Tree, items"). */
  what?: string;
}

export interface SyncConflict {
  localId: string;
  name: string;
  className: string;
  /** This device's name and when the local file was edited. */
  mine: ConflictSide;
  theirs: ConflictSide;
}

export interface ConflictSide {
  deviceName: string;
  /** True for the copy on this PC. */
  here: boolean;
  editedAt: number;
  /** The rows the dialog compares: values of the engine's stats and the item in the first slot, filled in by the renderer. */
  xml?: string;
}

export interface SyncView {
  state: SyncState;
  /** One line for the pill popover. */
  meta: string;
  lastSyncAt: number | null;
  /** Cloud builds (not deleted). */
  cloudCount: number;
  pending: { localId: string; name: string; className: string; what: string }[];
  conflicts: SyncConflict[];
  /** By local build id. Only builds that sync appear here. */
  builds: Record<string, BuildSyncStatus>;
  /** Plain-language reason when state is 'error' or 'offline'. */
  detail?: string;
}

/** What a feature says when it needs the hosted backend and this build has none. */
export const OFFICIAL_ONLY = 'Account features are part of the official build.';

export interface AccountView {
  auth: AuthView;
  /** The last sign-in problem, cleared by the next attempt. */
  error?: string;
  /** Present when signed in. */
  sync: SyncView | null;
  deviceName: string;
  /** True in a build without the hosted backend: there is nothing to sign in to. */
  unavailable?: true;
}

export interface VersionInfo {
  rev: number;
  name: string;
  deviceName: string;
  /** True when this PC made it. */
  here: boolean;
  note: string;
  at: number;
  size: number;
  current: boolean;
}

/** A build deleted from the cloud that can still be brought back. */
export interface DeletedCloudBuild {
  cloudId: string;
  name: string;
  folder: string;
  className: string;
  ascendClassName: string;
  level: number;
  deletedAt: number;
  /** The device that last saved it before it was deleted. */
  deviceName: string;
}

export interface ShareSettings {
  access: 'link' | 'private';
  includeNotes: boolean;
  includeLoadouts: boolean;
  allowDuplicate: boolean;
}

export interface ShareInfo extends ShareSettings {
  token: string;
  /** The link to copy. */
  url: string;
  updatedAt: number;
}

/** What opening a share link returns. */
export interface SharedBuild {
  name: string;
  className: string;
  ascendClassName: string;
  level: number;
  mainSkill: string;
  xml: string;
  allowDuplicate: boolean;
  updatedAt: number;
}

export type ConflictChoice = 'mine' | 'theirs' | 'both';

/** The link a player copies: a web page that opens without the app (/b/[id]). */
export const SHARE_WEB_BASE = 'https://pathofmastery.gg/b/';
/** The same share opened in the app. The web page's "Open in Path of Mastery" button uses it. */
export const SHARE_LINK_PREFIX = 'pathofmastery://share/';

export function shareUrl(token: string): string {
  return SHARE_WEB_BASE + token;
}

export function appShareUrl(token: string): string {
  return SHARE_LINK_PREFIX + token;
}

/** Pulls a share token out of a pasted link (`https://pathofmastery.gg/b/<token>` or `pathofmastery://share/<token>`). */
export function parseShareToken(text: string): string | null {
  const t = text.trim();
  const m = /^(?:pathofmastery:\/\/share\/|https:\/\/(?:www\.)?pathofmastery\.gg\/b\/)([A-Za-z0-9_-]{8,64})\/?$/.exec(t);
  if (m) return m[1]!;
  return null;
}

/** What the renderer can ask of the main process (window.pom.account). Every call answers `{ ok, value }` or `{ ok: false, error }`. */
export interface AccountApi {
  view(): Promise<AccountResult<AccountView>>;
  providers(): Promise<AccountResult<ProviderStatus[]>>;
  signInProvider(p: ProviderId): Promise<AccountResult<void>>;
  signInEmail(email: string): Promise<AccountResult<void>>;
  cancelSignIn(): Promise<AccountResult<void>>;
  signOut(): Promise<AccountResult<void>>;
  syncNow(): Promise<AccountResult<void>>;
  /** Puts a local build in the cloud. */
  enroll(localId: string): Promise<AccountResult<void>>;
  /** Puts every local build in the cloud; answers how many were added. */
  enrollAll(): Promise<AccountResult<number>>;
  unenroll(localId: string, removeFromCloud: boolean): Promise<AccountResult<void>>;
  conflictTexts(localId: string): Promise<AccountResult<{ mine: string; theirs: string } | null>>;
  resolve(localId: string, choice: ConflictChoice): Promise<AccountResult<void>>;
  versions(localId: string): Promise<AccountResult<VersionInfo[] | null>>;
  versionText(localId: string, rev: number): Promise<AccountResult<string | null>>;
  restore(localId: string, rev: number, label: string): Promise<AccountResult<boolean>>;
  restoreAsCopy(localId: string, rev: number, label: string): Promise<AccountResult<{ id: string; name: string } | null>>;
  /** Builds deleted from the cloud in the last 90 days. */
  deletedBuilds(): Promise<AccountResult<DeletedCloudBuild[]>>;
  /** Puts one back; this PC downloads it as a new build. Answers false when it can no longer be restored. */
  restoreDeleted(cloudId: string): Promise<AccountResult<boolean>>;
  shareGet(localId: string): Promise<AccountResult<ShareInfo | null>>;
  shareSet(localId: string, s: ShareSettings): Promise<AccountResult<ShareInfo>>;
  shareRevoke(localId: string): Promise<AccountResult<void>>;
  sharedOpen(token: string): Promise<AccountResult<SharedBuild | null>>;
  /** The feedback form: works signed out too. */
  feedbackSend(i: { message: string; kind: 'feedback' | 'bug' | 'idea'; contact: string; version: string; platform: string }): Promise<AccountResult<void>>;
  /** Community builds. The reads work signed out; publish, unpublish, report and delete need an account. */
  communityList(i?: { limit?: number; offset?: number }): Promise<AccountResult<CommunityBuild[]>>;
  communitySimilar(i: { className: string; ascendClassName: string; mainSkill: string; exclude?: string }): Promise<AccountResult<CommunityBuild[]>>;
  communityGet(id: string): Promise<AccountResult<CommunityFull | null>>;
  communityMine(): Promise<AccountResult<CommunityBuild[]>>;
  communityPublish(i: CommunityPublishInput): Promise<AccountResult<{ id: string; existing: boolean }>>;
  communityUnpublish(id: string): Promise<AccountResult<void>>;
  communityReport(id: string, reason: string): Promise<AccountResult<{ ok: boolean; hidden: boolean }>>;
  /** Removes everything this player published or contributed to the community side. */
  deleteMyCommunityData(): Promise<AccountResult<void>>;
  /** Deletes the account and everything of it on the server (site route /api/account/delete), then signs this PC out. Local builds stay. */
  deleteAccount(): Promise<AccountResult<void>>;
  /** The delete dialog was closed after a failed try: ends the attempt so this account syncs again. */
  cancelDeleteAccount(): Promise<AccountResult<void>>;
  onChanged(listener: (v: AccountView) => void): () => void;
  /** Build ids the sync wrote or removed. */
  onLibraryChanged(listener: (ids: string[]) => void): () => void;
}

export type AccountResult<T> = { ok: true; value: T } | { ok: false; error: string };
