import { useEffect, useMemo, useRef, useState } from 'react';
import type { ActionId } from '@pom/mastery-contracts';
import type { RunCtx } from './RunApp';
import { Frame } from './Panels';
import { FEEDBACK_MAX, FEEDBACK_REASONS, LANE_LABEL, clearDraft, completionModel, feedbackProblem, feedbackRequest, laneType, loadDraft, newId, saveDraft, type FeedbackForm } from './presenter';

const store = (): Storage | null => { try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; } };

// ---- End of Run ----
export function CompletionPanel({ ctx, onClose }: { ctx: RunCtx; onClose(): void }) {
  const { view, services } = ctx;
  const m = completionModel(view);
  const owned = ctx.meta.ownership !== 'public';
  const [vote, setVote] = useState<string | null>(null);
  const [net, setNet] = useState<number | null>(services.netVotes ?? null);
  const castVote = async (d: 1 | -1) => {
    if (!services.vote) return;
    try {
      const r = await services.vote(d);
      if (r === 'signin') setVote('Sign in to vote. Nothing was sent.'); else { setNet(r.net); setVote(null); }
    } catch { setVote('Your vote was not saved. Try again.'); }
  };
  return <Frame title={m.title} onClose={onClose}>
    <p className="run-first">{ctx.meta.title ?? view.title} / {view.snapshot.publishedOrigin ? `Version ${view.snapshot.timelineRevision.revisionId.slice(0, 8)}` : 'Your timeline'} / {view.snapshot.stamp.leagueId.status === 'known' ? view.snapshot.stamp.leagueId.value : 'League unknown'}</p>
    <p>{m.summary}</p>
    <p className="run-support">{m.label}</p>
    <div className="run-row">
      <button className="run-btn" onClick={() => ctx.open('details', { tab: 'missed' })} disabled={m.outstanding === 0}>Review outstanding actions</button>
      <button className="run-btn" onClick={() => ctx.open('feedback', { actionId: view.displayed.actionIds[0] })}>This step didn't work</button>
    </div>
    <div className="run-row">
      {m.recorded ? <span className="run-chip">{m.recorded}</span>
        : <button className="run-btn run-primary" disabled={!m.canConfirm} onClick={() => void ctx.send({ kind: 'confirmFinished' })}>I finished this timeline</button>}
      <span className="run-note">{m.counting}</span>
      <button className="run-link" onClick={() => ctx.open('settings')}>Settings</button>
    </div>
    <div className="run-row" aria-label="Vote on this timeline">Vote on this timeline:
      <button className="run-btn" disabled={!services.vote} onClick={() => void castVote(1)}>Upvote</button>
      <span>{net ?? '-'}</span>
      <button className="run-btn" disabled={!services.vote} onClick={() => void castVote(-1)}>Downvote</button>
    </div>
    {vote && <p className="run-note" role="status">{vote}</p>}
    <div className="run-row run-end">
      <button className="run-btn" onClick={() => void ctx.bridge.openTimeline()}>{owned ? 'Open timeline' : 'View timeline'}</button>
      {owned && <button className="run-btn" disabled={!services.publish} onClick={() => services.publish?.()}>Publish</button>}
      <button className="run-btn" onClick={() => void ctx.bridge.runAgain(view.snapshot.runId).then(r => { if (r.ok) onClose(); })}>Run again</button>
      <button className="run-btn run-primary" onClick={() => void ctx.bridge.close()}>Close Run</button>
    </div>
  </Frame>;
}

// ---- This step didn't work ----
export function FeedbackPanel({ ctx, onClose, actionId }: { ctx: RunCtx; onClose(): void; actionId?: string }) {
  const { view, services } = ctx;
  const presented = useMemo(() => view.state.presentedBundleIds.flatMap(id => view.snapshot.bundles.find(b => b.bundleId === id)?.actionIds ?? [])
    .map(id => view.snapshot.actions.find(a => a.actionId === id)).filter((a): a is NonNullable<typeof a> => !!a), [view]);
  const [form, setForm] = useState<FeedbackForm>(() => loadDraft(store(), (actionId ?? presented[0]?.actionId ?? null) as ActionId | null));
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const formRef = useRef(form); formRef.current = form;
  const problem = feedbackProblem(form);
  const action = view.snapshot.actions.find(a => a.actionId === form.actionId);
  // Escape (and any close) keeps the draft on this PC; Send and Save clear it.
  useEffect(() => () => saveDraft(store(), formRef.current), []);
  const request = () => feedbackRequest(view, form, newId('feedback'));
  const saveLocal = async () => {
    const req = request();
    if (!req) { setStatus(view.snapshot.publishedOrigin ? problem : 'Local notes are kept on this PC only.'); saveDraft(store(), form); return; }
    await services.saveFeedbackLocal?.(req, form.allowReplies); saveDraft(store(), form); setStatus('Saved on this PC.');
  };
  const send = async () => {
    const req = request();
    if (!req || !services.sendFeedback || busy) return;
    setBusy(true);
    try {
      const r = await services.sendFeedback(req, form.allowReplies);
      if (r === 'sent') { clearDraft(store()); onClose(); }
      else setStatus(r === 'signin' ? 'Sign in, then press Send again. Your draft is kept.' : r === 'creator_unavailable' ? 'This creator cannot receive feedback. Save a local note instead.' : 'The report was not accepted. Edit it and try again.');
    } finally { setBusy(false); }
  };
  const onKey = (e: React.KeyboardEvent) => { if (e.key === 'Enter' && e.ctrlKey && !problem) { e.preventDefault(); void send(); } };
  return <Frame title="This step didn't work" onClose={onClose} footer={<>
    <button className="run-btn" onClick={() => void saveLocal()}>Save feedback on this PC</button><span className="run-grow" />
    <button className="run-btn" onClick={onClose}>Cancel</button>
    <button className="run-btn run-primary" disabled={!!problem || busy || !services.sendFeedback || !view.snapshot.publishedOrigin} onClick={() => void send()}>Send</button></>}>
    <div onKeyDown={onKey}>
      <p className="run-note">{ctx.meta.title ?? view.title} / Version {view.snapshot.timelineRevision.revisionId.slice(0, 8)} / {action ? `${LANE_LABEL[laneType(view, action)]} / ${action.instruction.firstAction}` : 'No step picked'}</p>
      <label className="run-field">Step <select value={form.actionId ?? ''} onChange={e => setForm({ ...form, actionId: e.target.value as ActionId })}>
        {presented.map(a => <option key={a.actionId} value={a.actionId}>{LANE_LABEL[laneType(view, a)]}: {a.instruction.firstAction.slice(0, 80)}</option>)}</select></label>
      <fieldset className="run-reasons"><legend>What happened?</legend>{FEEDBACK_REASONS.map(r =>
        <label key={r.value}><input type="radio" name="reason" checked={form.reason === r.value} onChange={() => setForm({ ...form, reason: r.value })} /> {r.label}</label>)}</fieldset>
      <label className="run-field">Details (optional)
        <textarea value={form.details} maxLength={FEEDBACK_MAX} rows={4} onChange={e => setForm({ ...form, details: e.target.value })} />
        <span className="run-note">{form.details.length}/{FEEDBACK_MAX}. Don't include personal info.</span></label>
      <label><input type="checkbox" checked={form.allowReplies} onChange={e => setForm({ ...form, allowReplies: e.target.checked })} /> Allow replies in app (optional)</label>
      <p className="run-note">No character name or log file is included.</p>
      {!view.snapshot.publishedOrigin && <p className="run-note">This is your own timeline. Feedback can be saved on this PC only.</p>}
      {(status || (problem && form.reason)) && <p className="run-note" role="status">{status ?? problem}</p>}
    </div>
  </Frame>;
}
