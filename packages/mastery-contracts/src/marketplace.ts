import type { AtlasPlan } from './atlas.js';
import type { ApiResult, AiAuthorizationRequest, EntitlementDecision } from './gate.js';
import type { CompletionReceipt } from './run.js';
import type { BuildSnapshot, TimelineBundle } from './timeline.js';
import type { ActionId, ClipId, LeagueStamp, ObjectId, PostId, PublicId, PublishedRevisionRef, RevisionRef, RowVersion, SourceCredit } from './stamp.js';

export type PublicInline = { kind: 'text' | 'strong' | 'emphasis' | 'code'; text: string }
  | { kind: 'link'; text: string; href: string };
export type PublicTextBlock = { kind: 'paragraph' | 'list_item'; content: PublicInline[] }
  | { kind: 'heading'; level: 1 | 2 | 3; content: PublicInline[] };
export type PublicRichText = PublicTextBlock[];
export type PublicDocument = { kind: 'build'; payload: BuildSnapshot }
  | { kind: 'atlas'; payload: AtlasPlan }
  | { kind: 'timeline'; payload: TimelineBundle };
export const BUDGET_BANDS = ['not_stated', 'cheap', 'medium', 'expensive'] as const;
export type BudgetBand = typeof BUDGET_BANDS[number];
/**
 * Listing metadata (filters, publish fields). Budget, League starter, tags and the video link are creator claims;
 * class/ascendancy come from the build and mechanics from the plan's allocated nodes, both derived at publish time.
 */
export type ListingMetadata = {
  budget: BudgetBand;
  leagueStarter: boolean;
  tags: string[];
  video: string | null;
  className: string | null;
  ascendancy: string | null;
  mechanics: string[];
};
export type PublicHistoryEntry = { revision: RevisionRef; label: string; createdAt: string; snapshot: PublicDocument };
export type PublicItemPayload = {
  schemaVersion: 1;
  publicId: PublicId;
  publishedRevision: PublishedRevisionRef;
  visibility: 'public' | 'unlisted';
  stamp: LeagueStamp;
  title: string;
  creator: { displayName: string; identityVerified: boolean };
  description: PublicRichText;
  document: PublicDocument;
  credits: SourceCredit[];
  /**
   * `revision`: the post's vote revision the counts were read at (it grows with every change); the app keeps the highest.
   * `myVote`: the reading viewer's own vote counted in `net` at that revision (0 signed out). Both absent on stored copies.
   */
  votes: { up: number; down: number; net: number; revision?: number; myVote?: -1 | 0 | 1 };
  finishes: { finalTriggerObserved: number; playerConfirmed: number };
  publishedAt: string;
  history?: PublicHistoryEntry[];
  /** Absent on posts published before listing metadata existed. */
  listing?: ListingMetadata;
};
export type MarketplacePost = {
  schemaVersion: 1;
  postId: PostId;
  publicId: PublicId;
  sourceObjectId: ObjectId;
  stamp: LeagueStamp;
  status: 'draft' | 'pending' | 'published' | 'rejected' | 'removed';
  visibility: 'public' | 'unlisted';
  currentRevision: PublishedRevisionRef | null;
  rowVersion: RowVersion;
};
export type SavedItem = { schemaVersion: 1; objectId: ObjectId; stamp: LeagueStamp; selectedRevision: PublishedRevisionRef; source: RevisionRef; cachedPayload: PublicItemPayload };
export type Collection = { schemaVersion: 1; objectId: ObjectId; title: string; stamp: LeagueStamp; members: { publishedRevision: PublishedRevisionRef; source: RevisionRef }[] };
export type ResolvePublicItemRequest = { publicId: PublicId; revision?: number };
export type FeedRequest = {
  scope: LeagueStamp;
  type: 'all' | 'build' | 'atlas' | 'timeline';
  sort: 'hot' | 'top' | 'new' | 'old' | 'rising';
  window: '24_hours' | '7_days' | '30_days' | 'league' | 'all_time';
  search: string;
  cursor: string | null;
};
export type PublishRequest = { source: RevisionRef; visibility: 'public' | 'unlisted'; payload: PublicDocument; description: PublicRichText; includeNotes: boolean; includeHistory: boolean; idempotencyKey: string };
export type VoteRequest = { postId: PostId; direction: -1 | 0 | 1; idempotencyKey: string };
export type FeedbackRequest = { publishedRevision: PublishedRevisionRef; clipId: ClipId; actionId: ActionId; reason: string; text: string; idempotencyKey: string };
export type ReportRequest = { postId: PostId; reason: string; text: string; idempotencyKey: string };
export type MasteryApi = {
  resolvePublicItem: { request: ResolvePublicItemRequest; response: ApiResult<PublicItemPayload> };
  listPublicItems: { request: FeedRequest; response: ApiResult<{ items: PublicItemPayload[]; nextCursor: string | null }> };
  publish: { request: PublishRequest; response: ApiResult<PublishedRevisionRef> };
  vote: { request: VoteRequest; response: ApiResult<{ direction: -1 | 0 | 1; net: number }> };
  completionReceipt: { request: CompletionReceipt; response: ApiResult<{ counted: boolean }> };
  feedback: { request: FeedbackRequest; response: ApiResult<{ submissionId: string }> };
  report: { request: ReportRequest; response: ApiResult<{ submissionId: string }> };
  authorizeAi: { request: AiAuthorizationRequest; response: ApiResult<EntitlementDecision> };
};

/**
 * Feed filter limits. The site rejects a feed or count request past them, and the app's filters drawer stops at them, so the two
 * can never disagree. Lengths count characters (code points), like the listing contract and Postgres.
 */
export const FEED_FILTER_LIMITS = { selections: 10, selectionLength: 128, tagLength: 30, searchLength: 1000 } as const;
const textLength = (value: string) => [...value].length;
const hasControl = (value: string) => [...value].some(ch => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127);
/** One chosen value of a list filter (a skill id, class, mechanic id, lane or budget band). */
export function isFeedSelection(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && textLength(value) <= FEED_FILTER_LIMITS.selectionLength && !hasControl(value);
}
/** One chosen creator tag. */
export function isFeedTag(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && textLength(value) <= FEED_FILTER_LIMITS.tagLength && !hasControl(value);
}
/** The search text (title, skill, tag, creator, description). */
export const isFeedSearch = (value: string) => textLength(value) <= FEED_FILTER_LIMITS.searchLength;
