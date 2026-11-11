import type { FeedSort } from '../ranking.js';
import type { FeedType } from '../presenter.js';
import type { PublicItemPayload } from '@pom/mastery-contracts';
import type { InboxThread, OwnPost, ProfileDraft, Reputation, Result, VerifyDraft, VerifyStatus } from './presenter.js';

export type ProfileData = {
  creatorId: string; name: string; bio: string; links: string[]; verified: boolean; own: boolean; following: boolean;
  reputation: Reputation; leagues: { id: string; label: string }[]; cachedAt: string | null;
};
export type VerificationState = { status: VerifyStatus; publicName: string; profileLink: string; explanation: string; challenge: string | null; note: string | null };
/**
 * Injected by the app shell. Reads map onto the marketplace client (renderer/marketplace/client.ts): `inbox` + `refreshInbox` for the inbox list; the rest need new
 * client calls (profile, follow, verification, own posts, review, mark read, reply, fixed-in, resolve). No IPC is registered here.
 */
export type CreatorPort = {
  online(): boolean;
  signedIn(): boolean;
  signIn(): Promise<boolean>;
  profile(who: { name: string; publicId?: string } | { own: true }, league: string): Promise<Result<ProfileData>>;
  saveProfile(draft: ProfileDraft): Promise<Result<ProfileData>>;
  follow(creatorId: string, on: boolean): Promise<Result<null>>;
  items(creatorId: string, q: { type: FeedType; sort: FeedSort; league: string }): Promise<Result<PublicItemPayload[]>>;
  verification(): Promise<Result<VerificationState>>;
  saveVerificationDraft(d: VerifyDraft): Promise<Result<null>>;
  checkProof(d: VerifyDraft): Promise<Result<{ found: boolean }>>;
  submitVerification(d: VerifyDraft): Promise<Result<{ status: VerifyStatus }>>;
  posts(): Promise<Result<{ posts: OwnPost[]; cachedAt: string | null }>>;
  requestReview(postId: string, idempotencyKey: string): Promise<Result<null>>;
  inbox(): Promise<Result<{ threads: InboxThread[]; cachedAt: string | null }>>;
  markRead(threadId: string): Promise<Result<null>>;
  reply(threadId: string, text: string, idempotencyKey: string): Promise<Result<{ messageId: string; sentAt: string }>>;
  setFixed(threadId: string, revision: number | null): Promise<Result<null>>;
  resolve(threadId: string, on: boolean): Promise<Result<null>>;
  saveReplyDraft(threadId: string, text: string): void;
  replyDraft(threadId: string): string;
  copyText(text: string): Promise<boolean>;
  openExternal(url: string): void;
};
