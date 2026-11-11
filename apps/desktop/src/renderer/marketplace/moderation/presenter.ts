// Pure rules for reports and the moderation queue. No React, no IPC.
// The server owns every decision; this file only decides what the UI may offer.

export type ModResult<T> = { ok: true; value: T } | { ok: false; code: string; message?: string };

// ---------- report ----------
export type ReportReason = 'spam' | 'harassment' | 'impersonation' | 'unusable_file' | 'other';
export const REPORT_REASONS: { value: ReportReason; label: string }[] = [
  { value: 'spam', label: 'Spam' }, { value: 'harassment', label: 'Harassment' },
  { value: 'impersonation', label: 'Impersonation' }, { value: 'unusable_file', label: 'Unusable file' }, { value: 'other', label: 'Other' },
];
/** Gameplay trouble is not abuse: it goes to private creator feedback. */
export const FEEDBACK_ROUTE_LABEL = "Instructions didn't work";
export const DETAILS_MAX = 2000;
export type ReportTarget = { kind: 'item'; postId: string; revisionId: string; title: string; revisionLabel: string } | { kind: 'creator'; creatorId: string; name: string };
export type ReportDraft = { reason: ReportReason | ''; details: string; evidence: string };
export const emptyReportDraft = (): ReportDraft => ({ reason: '', details: '', evidence: '' });
export const targetKey = (t: ReportTarget) => t.kind === 'item' ? `post:${t.postId}:${t.revisionId}` : `creator:${t.creatorId}`;

export function validEvidenceUrl(value: string): boolean {
  if (!value) return true;
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && value.length <= 2000; } catch { return false; }
}
export type ReportErrors = { reason?: string; details?: string; evidence?: string };
export function validateReport(draft: ReportDraft): { ok: boolean; errors: ReportErrors } {
  const errors: ReportErrors = {};
  if (!draft.reason) errors.reason = 'Pick a reason.';
  if (draft.details.length > DETAILS_MAX) errors.details = `Use ${DETAILS_MAX} characters or fewer.`;
  else if (draft.reason === 'other' && !draft.details.trim()) errors.details = 'Tell us what is wrong.';
  if (!validEvidenceUrl(draft.evidence.trim())) errors.evidence = 'Use a link that starts with https://.';
  return { ok: Object.keys(errors).length === 0, errors };
}

/** One draft per target; it survives Cancel and sign-in, and resets when the target changes. */
export function keepDraft(prev: { key: string; draft: ReportDraft } | null, target: ReportTarget): { key: string; draft: ReportDraft } {
  const key = targetKey(target);
  return prev && prev.key === key ? prev : { key, draft: emptyReportDraft() };
}
export type SubmitGate = { canSubmit: boolean; hint: string; action: 'submit' | 'sign_in' | 'wait' };
export function submitGate(draft: ReportDraft, ctx: { signedIn: boolean; online: boolean; busy: boolean }): SubmitGate {
  if (!validateReport(draft).ok) return { canSubmit: false, hint: '', action: 'wait' };
  if (!ctx.online) return { canSubmit: false, hint: 'Connect to submit report.', action: 'wait' };
  if (!ctx.signedIn) return { canSubmit: true, hint: 'Sign in with Discord, then submit.', action: 'sign_in' };
  return { canSubmit: !ctx.busy, hint: '', action: 'submit' };
}
/** The reporter only ever sees a reference and open/closed. Anything else the server sends is dropped. */
export type ReportReceipt = { reference: string; status: 'submitted' | 'closed' };
export function receiptView(raw: unknown): ReportReceipt | null {
  const r = raw as { submissionId?: unknown; id?: unknown; status?: unknown } | null;
  const id = typeof r?.submissionId === 'string' ? r.submissionId : typeof r?.id === 'string' ? r.id : null;
  if (!id) return null;
  return { reference: id, status: r?.status === 'closed' ? 'closed' : 'submitted' };
}
export const receiptCopy = (r: ReportReceipt) => r.status === 'closed' ? `Report ${r.reference} is closed.` : `Report submitted. Reference ${r.reference}.`;
export function reportBody(target: ReportTarget, draft: ReportDraft, idempotencyKey: string) {
  return {
    request: { ...(target.kind === 'item' ? { postId: target.postId } : {}), reason: draft.reason as ReportReason, text: draft.details.trim(), idempotencyKey },
    revisionId: target.kind === 'item' ? target.revisionId : null, creatorId: target.kind === 'creator' ? target.creatorId : null,
    evidenceUrl: draft.evidence.trim() || null,
  };
}

// ---------- shared error copy ----------
export function errorCopy(code: string): string {
  switch (code) {
    case 'STALE_CASE': case 'STALE_TARGET': case 'STALE_REVIEW': return 'This case changed. Refresh before deciding.';
    case 'MODERATOR_REQUIRED': case 'FORBIDDEN': return 'You do not have access to moderation.';
    case 'SIGN_IN_REQUIRED': return 'Sign in to continue.';
    case 'HUMAN_CHECK_REQUIRED': return 'Finish the check, then try again.';
    case 'INVALID_DECISION': return 'That decision does not fit this case. Refresh and try again.';
    case 'VALIDATION_FAILED': return 'Check the fields and try again.';
    case 'OFFLINE': return 'You are offline.';
    case 'UNAVAILABLE': return 'This is not available right now.';
    default: return 'Something went wrong. Try again.';
  }
}

// ---------- moderation ----------
export type CaseKind = 'report' | 'publication' | 'verification';
export type Action = 'keep_content' | 'remove_listing' | 'restore_listing' | 'approve_publication' | 'request_changes' | 'verify_identity' | 'decline_verification';
export const ACTION_LABEL: Record<Action, string> = {
  keep_content: 'Keep content', remove_listing: 'Remove listing', restore_listing: 'Restore listing', approve_publication: 'Approve publication',
  request_changes: 'Request changes', verify_identity: 'Verify identity', decline_verification: 'Decline verification',
};
export type QueueTab = 'reports' | 'publication' | 'verification' | 'decided';
export const TABS: { value: QueueTab; label: string; kind: CaseKind | null }[] = [
  { value: 'reports', label: 'Reports', kind: 'report' }, { value: 'publication', label: 'Publish reviews', kind: 'publication' },
  { value: 'verification', label: 'Verification', kind: 'verification' }, { value: 'decided', label: 'Decided', kind: null },
];
export type QueueRow = { id: string; kind: CaseKind; status: 'open' | 'decided'; case_version: number; claimed_by: string | null; opened_at: string; target?: string; category?: string; lastAction?: string | null };
export type CaseDetail = {
  case: { id: string; kind: CaseKind; status: 'open' | 'decided'; case_version: number; claimed_by: string | null; last_action: string | null; opened_at: string; post_id: string | null; revision_no: number | null; target_snapshot: Record<string, unknown> };
  report: { reason: string; text: string; evidence_url: string | null; submitted_at: string } | null; // present only for an authorized role
  audit: { event: 'claim' | 'decision'; moderator_id: string; case_version: number; created_at: string }[];
  decisions: { action: Action; reason: string; moderator_id: string; decided_at: string }[];
  /** Live listing or application as it is now, kept apart from the snapshot. Needs the moderation read to expose it. */
  live?: { title: string; status: string; targetVersion: number | null } | null;
};
export type ModView = { access: 'unknown' | 'granted' | 'denied' };

export function applicableActions(c: CaseDetail['case']): Action[] {
  if (c.status === 'decided') return c.kind === 'report' && c.last_action === 'remove_listing' && c.post_id ? ['restore_listing'] : [];
  if (c.kind === 'report') return c.post_id ? ['keep_content', 'remove_listing'] : ['keep_content']; // creator reports never offer listing removal
  if (c.kind === 'publication') return ['approve_publication', 'request_changes'];
  return ['verify_identity', 'request_changes', 'decline_verification'];
}
const REASON_MAX = 2000;
export const needsConfirm = (a: Action | '') => a === 'remove_listing';
export type DecisionPreview = { headline: string; lines: string[]; creatorSees: string | null; confirm: string | null };
/** What will happen, in the words the creator will see. Never includes reporter details. */
export function decisionPreview(d: CaseDetail, action: Action, reason: string): DecisionPreview {
  const snap = d.case.target_snapshot, title = String((snap.title ?? snap.displayName ?? snap.publicName ?? 'this item'));
  const rev = d.case.revision_no != null ? ` revision ${d.case.revision_no}` : '';
  const clean = reason.trim();
  const creatorSees = action === 'keep_content' ? null : clean ? creatorNotice(action, clean) : null;
  const lines = [
    action === 'remove_listing' ? `Hides ${title}${rev} from the feed. Saved copies stay with their owners.` :
    action === 'restore_listing' ? `Puts ${title}${rev} back in the feed.` :
    action === 'keep_content' ? 'Leaves the listing as it is and closes the report. Nobody is told who reported it.' :
    action === 'approve_publication' ? `Publishes ${title}.` : action === 'request_changes' ? 'Sends the reason back to the creator.' :
    action === 'verify_identity' ? 'Shows the verified mark on the profile.' : 'Closes the application without the mark.',
  ];
  return { headline: ACTION_LABEL[action], lines, creatorSees,
    confirm: needsConfirm(action) ? `Remove ${title}${rev}? The reason below is shown to the creator.` : null };
}
export function creatorNotice(action: Action | string, reason: string): string {
  const r = reason.trim().replace(/[.\s]+$/, '');
  switch (action) {
    case 'remove_listing': return `Your listing was removed: ${r}.`;
    case 'restore_listing': return `Your listing was restored: ${r}.`;
    case 'request_changes': return `Changes requested: ${r}.`;
    case 'decline_verification': return `Verification declined: ${r}.`;
    case 'verify_identity': return `Identity verified: ${r}.`;
    case 'approve_publication': return `Your post was approved: ${r}.`;
    default: return r;
  }
}
export type DecideState = { action: Action | ''; reason: string; confirmed: boolean; busy: boolean };
export function canApply(d: CaseDetail | null, s: DecideState, ctx: { access: ModView['access']; online: boolean; stale: boolean }): { ok: boolean; why: string } {
  if (!d || !s.action) return { ok: false, why: '' };
  if (ctx.access !== 'granted') return { ok: false, why: errorCopy('MODERATOR_REQUIRED') };
  if (!ctx.online) return { ok: false, why: 'Connect to apply a decision.' };
  if (ctx.stale) return { ok: false, why: errorCopy('STALE_CASE') };
  if (!applicableActions(d.case).includes(s.action)) return { ok: false, why: errorCopy('INVALID_DECISION') };
  if (!s.reason.trim()) return { ok: false, why: 'Add a reason.' };
  if (s.reason.length > REASON_MAX) return { ok: false, why: `Use ${REASON_MAX} characters or fewer.` };
  if (needsConfirm(s.action) && !s.confirmed) return { ok: false, why: '' };
  return { ok: !s.busy, why: '' };
}
export function decideBody(d: CaseDetail, s: DecideState) {
  return { caseId: d.case.id, expectedCaseVersion: d.case.case_version, action: s.action as Action, reason: s.reason.trim(), expectedTargetVersion: d.live?.targetVersion ?? null };
}
/** After an error the drawer decides what to do. Role loss and stale cases stop writes at once. */
export function afterError(code: string): { access?: ModView['access']; stale?: boolean; message: string } {
  return { ...(code === 'MODERATOR_REQUIRED' || code === 'FORBIDDEN' ? { access: 'denied' as const } : {}),
    ...(['STALE_CASE', 'STALE_TARGET', 'STALE_REVIEW'].includes(code) ? { stale: true } : {}), message: errorCopy(code) };
}
export function queueView(rows: QueueRow[], q: { search: string; order: 'oldest' | 'newest' }): QueueRow[] {
  const s = q.search.trim().toLowerCase();
  const out = rows.filter((r) => !s || r.id.toLowerCase().includes(s));
  // Oldest first by default; never ranked by anything else.
  return out.sort((a, b) => (a.opened_at < b.opened_at ? -1 : a.opened_at > b.opened_at ? 1 : a.id < b.id ? -1 : 1) * (q.order === 'oldest' ? 1 : -1));
}
export function moveRow(key: string, index: number, count: number): number | null {
  if (!count) return null;
  if (key === 'ArrowDown' || key === 'j' || key === 'J') return Math.min(count - 1, index + 1);
  if (key === 'ArrowUp' || key === 'k' || key === 'K') return Math.max(0, index - 1);
  return null;
}
export const queueEmptyCopy = 'No cases in this queue.';
export const concurrentWarning = 'Another reviewer has this case open.';
export const shortId = (id: string) => id.slice(0, 8);
