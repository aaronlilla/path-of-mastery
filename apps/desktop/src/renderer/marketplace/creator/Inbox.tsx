import { useEffect, useRef, useState } from 'react';
import { Segmented, Select } from '../../ui.js';
import type { CreatorPort } from './port.js';
import { FIXED_LABEL, INBOX_EMPTY, REPLIES_OFF, REPLY_MAX, afterFixed, afterOpen, afterResolve, cachedStamp, errorCopy, fixedChoices, fixedGate, inboxView, replyGate, type InboxTab, type InboxThread } from './presenter.js';
import { useLoad } from './useLoad.js';

const TABS: { value: InboxTab; label: string }[] = [{ value: 'unread', label: 'Unread' }, { value: 'all', label: 'All' }, { value: 'resolved', label: 'Resolved' }];

function Thread({ t, port, onChange, onClose }: { t: InboxThread; port: CreatorPort; onChange(n: InboxThread): void; onClose(): void }) {
  const [draft, setDraft] = useState(() => port.replyDraft(t.threadId)), [busy, setBusy] = useState(false), [err, setErr] = useState(''), [limited, setLimited] = useState(false);
  const [fixed, setFixed] = useState<number | null>(t.fixedIn), [picking, setPicking] = useState(false);
  const key = useRef(crypto.randomUUID()), box = useRef<HTMLDivElement>(null);
  useEffect(() => { box.current?.focus(); }, [t.threadId]);
  const online = port.online();
  const gate = replyGate(t, draft, { online, busy, rateLimited: limited });
  const send = async () => {
    if (!gate.canSend) return;
    setBusy(true); setErr('');
    const r = await port.reply(t.threadId, draft.trim(), key.current);
    setBusy(false);
    if (!r.ok) { if (r.code === 'RATE_LIMITED') setLimited(true); setErr(errorCopy(r.code)); return; }
    key.current = crypto.randomUUID(); setDraft(''); port.saveReplyDraft(t.threadId, '');
    onChange({ ...t, messages: [...t.messages, { messageId: r.value.messageId, role: 'creator', text: draft.trim(), sentAt: r.value.sentAt }] });
  };
  const saveFixed = async (rev: number | null) => {
    const g = rev === null ? { ok: online, hint: 'Connect to save.' } : fixedGate(t, rev, { online });
    if (!g.ok) { setErr(g.hint); return; }
    setErr(''); const r = await port.setFixed(t.threadId, rev);
    if (r.ok) { setFixed(rev); setPicking(false); onChange(afterFixed(t, rev)); } else setErr(errorCopy(r.code));
  };
  const resolve = async (on: boolean) => {
    if (!online) { setErr('Connect to save.'); return; }
    setErr(''); const r = await port.resolve(t.threadId, on);
    if (r.ok) onChange(afterResolve(t, on)); else setErr(errorCopy(r.code));
  };
  const choices = fixedChoices(t);
  return <section className="cr-thread" ref={box} tabIndex={-1} aria-label={`Feedback on ${t.postTitle}`} onKeyDown={(e) => {
    if (e.key === 'Escape' && !(e.target as HTMLElement).closest('[data-popup]')) { port.saveReplyDraft(t.threadId, draft); onClose(); }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && (e.target as HTMLElement).tagName === 'TEXTAREA') { e.preventDefault(); void send(); }
  }}>
    <div className="cr-row"><strong>{t.postTitle} / v{t.revision}{t.chunk ? ` / ${t.chunk}` : ''}</strong><span className="cr-muted">{t.reason}</span><button className="btn" onClick={() => { port.saveReplyDraft(t.threadId, draft); onClose(); }}>Close</button></div>
    {t.instruction && <blockquote className="cr-quote" aria-label="Instruction the runner was on">{t.instruction}</blockquote>}
    <div className="cr-msgs">
      <p className="cr-msg"><span className="cr-muted">Runner</span><br />{t.text}</p>
      {t.messages.map((m) => <p key={m.messageId} className={`cr-msg ${m.role}`}><span className="cr-muted">{m.role === 'creator' ? 'You' : 'Runner'}</span><br />{m.text}</p>)}
    </div>
    {t.allowReplies ? <div className="cr-field">
      <textarea className="input" rows={3} aria-label="Reply" value={draft} maxLength={REPLY_MAX + 50} placeholder="Write a reply" onChange={(e) => { setDraft(e.target.value); port.saveReplyDraft(t.threadId, e.target.value); }} />
      <div className="cr-row"><button className="btn primary" disabled={!gate.canSend} onClick={() => void send()}>Send reply</button><span className="cr-muted">{gate.hint}</span></div>
    </div> : <p className="cr-muted">{REPLIES_OFF}</p>}
    <div className="cr-btns">
      {!t.read && <button className="btn" onClick={() => void port.markRead(t.threadId).then((r) => r.ok && onChange(afterOpen(t)))}>Mark read</button>}
      {fixed !== null ? <button className="btn" onClick={() => void saveFixed(null)}>{FIXED_LABEL(fixed)} (undo)</button>
        : <button className="btn" disabled={choices.length === 0} aria-expanded={picking} onClick={() => setPicking(!picking)}>Fixed in</button>}
      {picking && <Select ariaLabel="Fixed in version" width={140} value={'' as never} onChange={(v) => void saveFixed(Number(v))} options={choices.map((r) => ({ value: String(r), label: FIXED_LABEL(r) }))} up />}
      {t.resolved ? <button className="btn" onClick={() => void resolve(false)}>Reopen</button> : <button className="btn primary" onClick={() => void resolve(true)}>Resolve</button>}
    </div>
    {err && <p className="cr-err" role="alert">{err}</p>}
  </section>;
}

/** Private, no external contact. Opening a thread marks it read; reading never resolves it. */
export function Inbox({ port, account, onBack }: { port: CreatorPort; account: string | null; onBack?(): void }) {
  const [data, reload, setData] = useLoad(() => port.inbox(), []);
  const [tab, setTab] = useState<InboxTab>('unread'), [q, setQ] = useState(''), [openId, setOpenId] = useState<string | null>(null);
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); search.current?.focus(); } };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, []);
  if (!port.signedIn()) return <div className="cr-root"><div className="cr-state"><p>Sign in to read your feedback.</p><button className="btn primary" onClick={() => void port.signIn()}>Sign in</button></div></div>;
  const threads = data.status === 'ready' ? data.value.threads.filter((t) => !t.participants || (account !== null && t.participants.includes(account))) : [];
  const update = (n: InboxThread) => { if (data.status === 'ready') setData({ ...data.value, threads: data.value.threads.map((t) => (t.threadId === n.threadId ? n : t)) }); };
  const open = (t: InboxThread) => { setOpenId(t.threadId); if (!t.read) { update(afterOpen(t)); void port.markRead(t.threadId); } };
  const groups = inboxView(threads, tab, q, openId), current = threads.find((t) => t.threadId === openId) ?? null;
  return <div className="cr-root">
    <header className="cr-head2">
      {onBack && <button className="btn" onClick={onBack}>Back</button>}
      <h1>Feedback inbox</h1>
      <Segmented ariaLabel="Show" value={tab} options={TABS} onChange={setTab} />
      <input ref={search} className="input cr-search" aria-label="Search feedback" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
    </header>
    {data.status === 'ready' && data.value.cachedAt && <p className="cr-muted" role="status">{cachedStamp(data.value.cachedAt)}</p>}
    {data.status === 'loading' && <div className="cr-skel" aria-busy="true" />}
    {data.status === 'error' && <div className="cr-state"><p>{errorCopy(data.code)}</p><button className="btn" onClick={reload}>Retry</button></div>}
    {data.status === 'ready' && threads.length === 0 && <div className="cr-state">{INBOX_EMPTY}</div>}
    {data.status === 'ready' && threads.length > 0 && groups.length === 0 && <div className="cr-state">Nothing here.</div>}
    <div className={`cr-split${current ? ' has-thread' : ''}`}>
      <div className="cr-groups">{groups.map((g) => <div key={g.key} className="cr-group"><h2>{g.title}</h2>
        <ul className="cr-list">{g.threads.map((t) => <li key={t.threadId}><button type="button" className={`cr-trow${t.threadId === openId ? ' on' : ''}${t.read ? '' : ' unread'}`} onClick={() => open(t)}>
          <span className="cr-title">{t.reason}</span><span className="cr-muted">{t.text.slice(0, 90)}</span><span className="cr-muted">{t.at.slice(0, 10)}</span>
          {!t.read && <span className="cr-dot" aria-label="Unread" />}{t.fixedIn !== null && <span className="cr-muted">{FIXED_LABEL(t.fixedIn)}</span>}</button></li>)}</ul></div>)}</div>
      {current && <Thread key={current.threadId} t={current} port={port} onChange={update} onClose={() => setOpenId(null)} />}
    </div>
  </div>;
}
