import type { FeedbackRequest } from '@pom/mastery-contracts';

/** Public-side services the app injects (marketplace client, publish, loot filter). All optional: Run works without any of them. */
export type RunServices = {
  /** Explicit click only. Returns the new net votes, or 'signin' when sign-in is needed. */
  vote?(direction: 1 | -1): Promise<{ net: number } | 'signin'>;
  netVotes?: number | null;
  /** Local draft on this PC (saveFeedback). */
  saveFeedbackLocal?(request: FeedbackRequest, allowReplies: boolean): Promise<void>;
  /** Explicit Send. 'signin' means show sign-in, keep the draft, and let the player press Send again. */
  sendFeedback?(request: FeedbackRequest, allowReplies: boolean): Promise<'sent' | 'signin' | 'creator_unavailable' | 'rejected'>;
  openLootFilter?(): void;
  publish?(): void;
  /** Detected Client.txt, if one is really there. */
  detectedLog?: { filename: string } | null;
};
