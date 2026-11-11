import type { ApiResult, LeagueStamp, ObjectId, PostId, PublicDocument, PublicHistoryEntry, PublicId, PublicItemPayload, PublishedRevisionRef, PublishRequest, RevisionRef,
  SourceCredit, ValidationLimits } from '@pom/mastery-contracts';
import type { Draft } from './presenter.js';

export type PublishType = 'build' | 'atlas' | 'timeline';
/** An owned local source, with its full local content (private notes and edit history included; the presenter strips them). */
export type PublishSource = {
  kind: PublishType;
  objectId: ObjectId;
  title: string;
  ref: RevisionRef;
  /** Shown as "Version {localRevision}". */
  localRevision: string;
  document: PublicDocument;
  history: PublicHistoryEntry[];
  credits: SourceCredit[];
  /** Creator defaults, plus what is derived from the source: class/ascendancy (Build) and mechanics ids (Atlas plan, `mechanic:*`). */
  defaults: { economy: 'trade' | 'ssf'; hardcore: boolean; ruthless: boolean; budget: string; leagueStarter?: boolean; tags: string[]; mainSkill: string; className: string; ascendancy?: string; mechanics: string[] | string };
  /** Set when this source already has an own listing: Publish adds a revision and keeps votes and date. */
  existing: { postId: PostId; publicId: PublicId; displayRevision: number; rowVersion: number; title: string } | null;
};
/** Body of the `publish` operation. */
export type PublishBody = { request: PublishRequest; preview: PublicItemPayload; expectedPostRowVersion: number; draftVersion: number; successorOf: string | null };
export type PublicationStatus = { submissionId: string; reviewedHash: string; status: 'pending' | 'approved' | 'published' | 'rejected' | 'needs_review' | string;
  publishedRevision: PublishedRevisionRef | null; findings: { field: string; message: string }[] };
export type BlockKind = 'sign_in' | 'human_check';

/**
 * Everything the publish dialog does goes through this port. The app shell builds it from the account session
 * and the marketplace endpoints; each method maps one to one onto an operation named below.
 * Not in the marketplace client yet: publish, status and requestReview need their own calls.
 */
export type PublishPort = {
  online(): boolean;
  signedIn(): boolean;
  limits: ValidationLimits;
  /** Name shown on the preview; the server fills the real creator on publish. */
  creator: { displayName: string; identityVerified: boolean };
  /** The league the person is playing now; an older source needs the archive checkbox. */
  activeLeague: string | null;
  sources(kind: PublishType): Promise<PublishSource[]>;
  /** Latest local revision of a source, to notice "Source changed". */
  currentRef(objectId: ObjectId): Promise<RevisionRef>;
  /** Local draft store, works offline. */
  loadDraft(objectId: ObjectId): Draft | null;
  saveDraft(objectId: ObjectId, draft: Draft): void;
  /** `publish`. A thrown error or timeout is an unknown outcome. */
  publish(body: PublishBody): Promise<ApiResult<PublishedRevisionRef>>;
  /** `publication-status` by idempotency key. */
  status(idempotencyKey: string): Promise<ApiResult<PublicationStatus>>;
  /** Moderation `request-review`. */
  requestReview(input: { submissionId: string; reviewedHash: string }): Promise<ApiResult<{ caseId: string }>>;
  /** Sign-in or the human check. Resolves true when the person came back; never publishes. */
  continueBlocked(kind: BlockKind): Promise<boolean>;
};
export type { LeagueStamp };
