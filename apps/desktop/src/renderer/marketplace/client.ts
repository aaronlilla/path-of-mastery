import type { ApiResult, Collection, LeagueStamp, ObjectId, PublicItemPayload, PublishedRevisionRef, ResolvePublicItemRequest, VoteRequest } from '@pom/mastery-contracts';
import type { CachedRead, FeedQuery } from '../../main/marketplace/reads.js';
import type { PublicationStatus, PublishBody, PublishSource, PublishType } from './publish/port.js';
import type { SavedReference } from '../../main/marketplace/cache.js';
import type { OutboxEntry } from '../../main/marketplace/outbox.js';
import type { FeedbackDraft, PrivateThread } from '../../main/marketplace/privateCache.js';

export const MARKETPLACE_CHANNEL = 'mastery:marketplace';
/** Server answers the main process passes through untouched. The renderer adapters (renderer/mastery/marketplacePorts.ts) read them defensively. */
export type Raw = Record<string, unknown>;
export type VerifyDraftIn = { publicName: string; profileLink: string; explanation: string; alternative: boolean };
export type MarketplaceCalls = {
  saved: { args: Record<string, never>; result: SavedReference[] };
  save: { args: { payload: PublicItemPayload }; result: SavedReference };
  open: { args: { objectId: ObjectId }; result: { saved: import('@pom/mastery-contracts').SavedItem; originalRemoved: boolean } };
  download: { args: { objectId: ObjectId }; result: SavedReference };
  remove: { args: { objectId: ObjectId }; result: SavedReference };
  undoRemove: { args: { objectId: ObjectId }; result: null };
  previewUpdate: { args: { objectId: ObjectId }; result: PublicItemPayload | null };
  applyUpdate: { args: { objectId: ObjectId; expected: PublishedRevisionRef; payload: PublicItemPayload }; result: null };
  collections: { args: Record<string, never>; result: Collection[] };
  createCollection: { args: { title: string; stamp: LeagueStamp }; result: Collection };
  member: { args: { collectionId: ObjectId; saveId: ObjectId; present: boolean }; result: null };
  enrollSave: { args: { objectId: ObjectId; expectedRowVersion?: number }; result: string };
  enrollCollection: { args: { objectId: ObjectId; expectedRowVersion?: number }; result: null };
  vote: { args: { postId: VoteRequest['postId']; direction: VoteRequest['direction'] }; result: OutboxEntry };
  activity: { args: Record<string, never>; result: OutboxEntry[] };
  cancel: { args: { requestId: string }; result: null };
  retry: { args: { requestId: string }; result: null };
  saveFeedback: { args: { draftId: string; draft: FeedbackDraft }; result: null };
  feedbackDrafts: { args: Record<string, never>; result: FeedbackDraft[] };
  inbox: { args: Record<string, never>; result: PrivateThread[] };
  refreshInbox: { args: { view: 'received' | 'sent' | 'unread' | 'resolved'; threadId?: string }; result: null };
  // ---- public reads (MarketplaceReads: cached, offline fallback) ----
  feed: { args: { request: FeedQuery }; result: CachedRead<{ items: PublicItemPayload[]; nextCursor: string | null }> };
  count: { args: { request: FeedQuery }; result: CachedRead<{ total: number; timeBasis: string }> };
  item: { args: { request: ResolvePublicItemRequest }; result: CachedRead<PublicItemPayload> };
  // ---- Run of a published timeline: saves the pinned reference, then hands the bundle to the Run launcher ----
  runStart: { args: { payload: PublicItemPayload; choice?: 'replace' | 'keep' }; result: { status: 'started' } | { status: 'blocked'; reason: string; competing?: true } };
  // ---- publication (POST /api/marketplace/publish, /publication-status, /review) ----
  publish: { args: { body: PublishBody }; result: ApiResult<PublishedRevisionRef> };
  /** Owned local documents that can be published, with their full content (private notes are removed by the publish dialog). */
  publishSources: { args: { kind?: PublishType }; result: PublishSource[] };
  publicationStatus: { args: { idempotencyKey: string }; result: ApiResult<PublicationStatus> };
  requestReview: { args: { submissionId: string; reviewedHash: string }; result: ApiResult<{ caseId: string }> };
  // ---- creator: profile, follows, verification, own posts, inbox writes ----
  profile: { args: { creatorId?: string; publicId?: string }; result: ApiResult<Raw> };
  ownCreator: { args: Record<string, never>; result: { creatorId: string; slug: string } | null };
  saveProfile: { args: { displayName: string; bio: string; links: string[] }; result: ApiResult<{ creatorId: string }> };
  follow: { args: { creatorId: string; following: boolean }; result: ApiResult<Raw> };
  follows: { args: Record<string, never>; result: ApiResult<{ creators: { creatorId: string; followedAt: string }[] }> };
  /** No `showNewPostDot` reads the setting; with it, writes it. */
  creatorPreference: { args: { showNewPostDot?: boolean }; result: ApiResult<{ showNewPostDot: boolean }> };
  verification: { args: Record<string, never>; result: ApiResult<{ applicationId: string; publicNonce: string; caseVersion: number; status: string } | null> };
  saveVerificationDraft: { args: { draft: VerifyDraftIn }; result: null };
  verificationDraft: { args: Record<string, never>; result: VerifyDraftIn | null };
  submitVerification: { args: { draft: VerifyDraftIn; stamp: LeagueStamp }; result: ApiResult<{ applicationId: string; publicNonce: string; caseVersion: number }> };
  checkProof: { args: Record<string, never>; result: ApiResult<{ applicationId: string; caseVersion: number; proof: Raw }> };
  posts: { args: Record<string, never>; result: ApiResult<{ items: Raw[]; notices: Raw[] }> };
  analytics: { args: { postId: string; revisionId: string | null }; result: ApiResult<Raw> };
  /** Omitted fields keep the thread's current value; main supplies the row version it cached. */
  feedbackState: { args: { threadId: string; read?: boolean; resolved?: boolean; fixedRevision?: number | null }; result: ApiResult<Raw> };
  feedbackMessage: { args: { threadId: string; text: string; idempotencyKey: string }; result: ApiResult<Raw> };
  // ---- reports and moderation (report route, review route) ----
  report: { args: { request: { postId?: string; reason: string; text: string; idempotencyKey: string }; revisionId: string | null; creatorId: string | null; evidenceUrl: string | null }; result: ApiResult<{ submissionId: string }> };
  modQueue: { args: { kind: 'report' | 'publication' | 'verification'; status: 'open' | 'decided' }; result: ApiResult<unknown> };
  modCase: { args: { caseId: string }; result: ApiResult<unknown> };
  modClaim: { args: { caseId: string; expectedCaseVersion: number }; result: ApiResult<unknown> };
  modDecide: { args: { caseId: string; expectedCaseVersion: number; action: string; reason: string; expectedTargetVersion: number | null }; result: ApiResult<unknown> };
};
export type MarketplaceCall = { [K in keyof MarketplaceCalls]: { schemaVersion: 1; method: K } & MarketplaceCalls[K]['args'] }[keyof MarketplaceCalls];
export type LocalResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };
export function createMarketplaceClient(invoke: (channel: string, input: MarketplaceCall) => Promise<unknown>) {
  return { async call<K extends keyof MarketplaceCalls>(method: K, args: MarketplaceCalls[K]['args']): Promise<LocalResult<MarketplaceCalls[K]['result']>> {
    return await invoke(MARKETPLACE_CHANNEL, { schemaVersion: 1, method, ...args } as MarketplaceCall) as LocalResult<MarketplaceCalls[K]['result']>;
  } };
}
