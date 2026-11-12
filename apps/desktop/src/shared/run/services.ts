import type { FeedbackRequest } from '@pom/mastery-contracts';

/** What the Run window may ask the main process for on the public side (votes, private feedback, publish). The Run preload exposes only this. */
export type RunInfo = {
  ownership: 'owned' | 'public';
  netVotes: number | null;
  /** A Client.txt that exists on this PC at a known install location. Only the file name leaves main. */
  detectedLog: { filename: string } | null;
  signedIn: boolean;
};
export type RunServiceCall =
  | { kind: 'info' }
  | { kind: 'vote'; direction: 1 | -1 }
  | { kind: 'saveFeedback'; request: FeedbackRequest; allowReplies: boolean }
  | { kind: 'sendFeedback'; request: FeedbackRequest; allowReplies: boolean }
  | { kind: 'publish' }
  | { kind: 'openLootFilter' };
export type RunServiceResult =
  | RunInfo
  | { net: number } | 'signin'
  | null
  | 'sent' | 'creator_unavailable' | 'rejected';
/** Main-side implementation of the public calls; the Marketplace wiring supplies it. Every method throws on failure. */
export type RunPublicServices = {
  signedIn(): boolean;
  vote(postId: string, direction: 1 | -1): Promise<{ net: number } | 'signin'>;
  saveFeedback(request: FeedbackRequest, allowReplies: boolean): Promise<void>;
  sendFeedback(request: FeedbackRequest, allowReplies: boolean): Promise<'sent' | 'signin' | 'creator_unavailable' | 'rejected'>;
};
