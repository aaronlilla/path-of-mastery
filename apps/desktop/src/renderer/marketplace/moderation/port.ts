import type { Action, CaseDetail, CaseKind, ModResult, QueueRow, ReportReason } from './presenter';

/** Injected by the app shell. Each method maps 1:1 to the moderation endpoint (`operation` names) and the report route. */
export type ModerationPort = {
  online(): boolean;
  signedIn(): boolean;
  signIn(): Promise<boolean>;
  report(input: { request: { postId?: string; reason: ReportReason; text: string; idempotencyKey: string }; revisionId: string | null; creatorId: string | null; evidenceUrl: string | null }): Promise<ModResult<{ submissionId: string }>>;
  queue(kind: CaseKind, status: 'open' | 'decided'): Promise<ModResult<QueueRow[]>>;
  readCase(caseId: string): Promise<ModResult<CaseDetail>>;
  claim(caseId: string, expectedCaseVersion: number): Promise<ModResult<{ caseVersion: number; concurrentReviewer: boolean }>>;
  decide(input: { caseId: string; expectedCaseVersion: number; action: Action; reason: string; expectedTargetVersion: number | null }): Promise<ModResult<unknown>>;
  viewLive(caseId: string): void;
  gotoFeedback(target: { postId: string; revisionId: string }): void;
};
