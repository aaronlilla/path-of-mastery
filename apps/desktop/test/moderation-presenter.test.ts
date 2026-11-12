import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ACTION_LABEL, afterError, applicableActions, canApply, creatorNotice, decideBody, decisionPreview, errorCopy, keepDraft, moveRow, queueView, receiptCopy, receiptView,
  reportBody, submitGate, validateReport, emptyReportDraft, type CaseDetail, type DecideState } from '../src/renderer/marketplace/moderation/presenter.js';

const base = (over: Partial<CaseDetail['case']> = {}): CaseDetail => ({
  case: { id: 'c1', kind: 'report', status: 'open', case_version: 3, claimed_by: null, last_action: null, opened_at: '2026-10-01T00:00:00Z', post_id: 'p1', revision_no: 2, target_snapshot: { title: 'Cold Build' }, ...over },
  report: { reason: 'spam', text: 'x', evidence_url: null, submitted_at: '2026-10-01T00:00:00Z' }, audit: [], decisions: [], live: { title: 'Cold Build', status: 'published', targetVersion: 7 },
});
const ok = { access: 'granted' as const, online: true, stale: false };
const st = (over: Partial<DecideState> = {}): DecideState => ({ action: 'keep_content', reason: 'Fine.', confirmed: false, busy: false, ...over });

test('report form: reason required, Other needs details, https evidence only, 2000 cap', () => {
  assert.equal(validateReport(emptyReportDraft()).errors.reason, 'Pick a reason.');
  assert.ok(validateReport({ reason: 'other', details: ' ', evidence: '' }).errors.details);
  assert.ok(validateReport({ reason: 'spam', details: '', evidence: 'http://a.com' }).errors.evidence);
  assert.ok(validateReport({ reason: 'spam', details: '', evidence: 'https://u:p@a.com' }).errors.evidence);
  assert.ok(validateReport({ reason: 'spam', details: 'x'.repeat(2001), evidence: '' }).errors.details);
  assert.equal(validateReport({ reason: 'spam', details: '', evidence: 'https://a.com/x' }).ok, true);
});
test('report submit gate: offline text, signed-out continues to sign-in first, draft survives until target changes', () => {
  const d = { reason: 'spam' as const, details: '', evidence: '' };
  assert.equal(submitGate(d, { signedIn: true, online: false, busy: false }).hint, 'Connect to submit report.');
  assert.equal(submitGate(d, { signedIn: false, online: true, busy: false }).action, 'sign_in');
  assert.equal(submitGate(d, { signedIn: true, online: true, busy: false }).action, 'submit');
  const t1 = { kind: 'item' as const, postId: 'p', revisionId: 'r1', title: 't', revisionLabel: '1' };
  const prev = { key: 'post:p:r1', draft: d };
  assert.equal(keepDraft(prev, t1), prev);
  assert.deepEqual(keepDraft(prev, { ...t1, revisionId: 'r2' }).draft, emptyReportDraft());
});
test('reporter receipt shows only reference and status; creator is never named', () => {
  const r = receiptView({ submissionId: 'abc', status: 'submitted', reporter: 'me', creator: 'bob', decision: 'remove_listing' });
  assert.deepEqual(r, { reference: 'abc', status: 'submitted' });
  assert.equal(receiptCopy(r!), 'Report submitted. Reference abc.');
  assert.equal(receiptCopy({ reference: 'abc', status: 'closed' }), 'Report abc is closed.');
  assert.equal(receiptView({}), null);
  const body = reportBody({ kind: 'item', postId: 'p', revisionId: 'r', title: 't', revisionLabel: '1' }, { reason: 'spam', details: ' hi ', evidence: '' }, 'k');
  assert.deepEqual(body.request, { postId: 'p', reason: 'spam', text: 'hi', idempotencyKey: 'k' });
  assert.equal(body.revisionId, 'r');
});
test('only applicable actions are offered; creator reports cannot remove a listing; restore only after removal', () => {
  assert.deepEqual(applicableActions(base().case), ['keep_content', 'remove_listing']);
  assert.deepEqual(applicableActions(base({ post_id: null }).case), ['keep_content']);
  assert.deepEqual(applicableActions(base({ status: 'decided', last_action: 'remove_listing' }).case), ['restore_listing']);
  assert.deepEqual(applicableActions(base({ status: 'decided', last_action: 'keep_content' }).case), []);
  assert.deepEqual(applicableActions(base({ kind: 'publication', post_id: null }).case), ['approve_publication', 'request_changes']);
  assert.deepEqual(applicableActions(base({ kind: 'verification', post_id: null }).case), ['verify_identity', 'request_changes', 'decline_verification']);
});
test('apply gate: reason required, removal needs confirmation, stale/denied/offline block writes', () => {
  const d = base();
  assert.equal(canApply(d, st(), ok).ok, true);
  assert.equal(canApply(d, st({ reason: '  ' }), ok).why, 'Add a reason.');
  assert.equal(canApply(d, st({ action: 'remove_listing' }), ok).ok, false);
  assert.equal(canApply(d, st({ action: 'remove_listing', confirmed: true }), ok).ok, true);
  assert.equal(canApply(d, st(), { ...ok, stale: true }).why, 'This case changed. Refresh before deciding.');
  assert.equal(canApply(d, st(), { ...ok, access: 'denied' }).why, 'You do not have access to moderation.');
  assert.equal(canApply(d, st(), { ...ok, online: false }).ok, false);
  assert.equal(canApply(d, st({ action: 'verify_identity' }), ok).ok, false, 'wrong-kind action refused');
  assert.equal(canApply(d, st({ reason: 'x'.repeat(2001) }), ok).ok, false);
});
test('server errors stop writes: revoked role denies, stale case marks stale', () => {
  assert.equal(afterError('MODERATOR_REQUIRED').access, 'denied');
  assert.equal(afterError('STALE_CASE').stale, true);
  assert.equal(afterError('STALE_TARGET').message, 'This case changed. Refresh before deciding.');
  assert.equal(afterError('SOMETHING').message, errorCopy(''));
});
test('decision preview names the exact listing and revision, shows creator wording, never reporter data', () => {
  const p = decisionPreview(base(), 'remove_listing', 'Spam links.');
  assert.match(p.confirm ?? '', /Cold Build revision 2/);
  assert.equal(p.creatorSees, 'Your listing was removed: Spam links.');
  assert.doesNotMatch(JSON.stringify(p), /reporter|spam"|evidence/i);
  assert.equal(decisionPreview(base(), 'keep_content', 'ok').creatorSees, null);
  assert.equal(decisionPreview(base(), 'keep_content', 'ok').confirm, null);
  assert.equal(creatorNotice('restore_listing', 'Mistake.'), 'Your listing was restored: Mistake.');
  for (const a of Object.keys(ACTION_LABEL)) assert.ok(decisionPreview(base(), a as keyof typeof ACTION_LABEL, 'r').lines[0]);
});
test('decision body carries the case version and live target version it was read at', () => {
  assert.deepEqual(decideBody(base(), st({ action: 'remove_listing', reason: ' why ' })), { caseId: 'c1', expectedCaseVersion: 3, action: 'remove_listing', reason: 'why', expectedTargetVersion: 7 });
});
test('queue: oldest first by default, search by case id, no other ranking; J/K and arrows move', () => {
  const r = (id: string, t: string) => ({ id, kind: 'report' as const, status: 'open' as const, case_version: 1, claimed_by: null, opened_at: t });
  const rows = [r('bb', '2026-10-02'), r('aa', '2026-10-01'), r('ab', '2026-10-03')];
  assert.deepEqual(queueView(rows, { search: '', order: 'oldest' }).map((x) => x.id), ['aa', 'bb', 'ab']);
  assert.deepEqual(queueView(rows, { search: 'A', order: 'newest' }).map((x) => x.id), ['ab', 'aa']);
  assert.equal(moveRow('j', 0, 3), 1); assert.equal(moveRow('ArrowUp', 0, 3), 0); assert.equal(moveRow('K', 2, 3), 1); assert.equal(moveRow('x', 0, 3), null);
});
