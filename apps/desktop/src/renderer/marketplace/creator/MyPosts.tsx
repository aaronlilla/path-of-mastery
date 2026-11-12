import { useEffect, useRef, useState } from 'react';
import { Segmented, Select } from '../../ui.js';
import type { CreatorPort } from './port.js';
import { NO_POSTS, POST_STATUS_LABEL, analyticsRows, cachedStamp, errorCopy, feedbackLine, postsView, reviewGate, reviewKey, type OwnPost, type PostStatus } from './presenter.js';
import { useLoad } from './useLoad.js';

type Filter = PostStatus | 'all';
const FILTERS: { value: Filter; label: string }[] = [{ value: 'all', label: 'All' }, { value: 'draft', label: 'Draft' }, { value: 'published', label: 'Published' }, { value: 'needs_review', label: 'Needs review' }, { value: 'removed', label: 'Removed' }];

function AnalyticsPanel({ post, onClose }: { post: OwnPost; onClose(): void }) {
  const a = post.analytics, [rev, setRev] = useState('all'), [chunk, setChunk] = useState('all');
  const ref = useRef<HTMLElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  if (!a) return <aside className="cr-panel" ref={ref} tabIndex={-1}><p>No measurements yet.</p><button className="btn" onClick={onClose}>Close</button></aside>;
  const shown = rev === 'all' ? a.revisions[a.revisions.length - 1] ?? post.revision ?? 1 : Number(rev);
  return <aside className="cr-panel" ref={ref} tabIndex={-1} aria-label={`Analytics for ${post.title}`} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
    <div className="cr-row">
      <Select ariaLabel="Version" width={140} value={rev} onChange={setRev} options={[{ value: 'all', label: 'All versions' }, ...a.revisions.map((r) => ({ value: String(r), label: `v${r}` }))]} />
      {a.chunks.length > 0 && <Select ariaLabel="Chunk" width={180} value={chunk} onChange={setChunk} options={[{ value: 'all', label: 'All chunks' }, ...a.chunks.map((c) => ({ value: c.id, label: c.name }))]} />}
      <button className="btn" onClick={onClose}>Close</button>
    </div>
    <dl className="cr-rep">{analyticsRows(a).map((r) => <div key={r.label}><dt>{r.label}</dt><dd>{r.value}</dd></div>)}</dl>
    <p>{feedbackLine(a, shown)}</p>
    {post.analyticsAt && <p className="cr-muted">{cachedStamp(post.analyticsAt)}</p>}
  </aside>;
}

export function MyPosts({ port, onEdit, onView, onNewPost, onInbox, onBack }: { port: CreatorPort; onEdit(p: OwnPost): void; onView(p: OwnPost): void; onNewPost(): void; onInbox(): void; onBack?(): void }) {
  const [data, reload, setData] = useLoad(() => port.posts(), []);
  const [filter, setFilter] = useState<Filter>('all'), [q, setQ] = useState(''), [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null), [note, setNote] = useState('');
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); search.current?.focus(); } };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, []);
  const posts = data.status === 'ready' ? data.value.posts : [];
  const rows = postsView(posts, filter, q);
  const request = async (p: OwnPost) => {
    setBusy(p.postId); setNote('');
    const r = await port.requestReview(p.postId, reviewKey(p.postId, p.revision));
    setBusy(null);
    if (r.ok && data.status === 'ready') setData({ ...data.value, posts: data.value.posts.map((x) => (x.postId === p.postId ? { ...x, reviewRequested: true } : x)) });
    else if (!r.ok) setNote(errorCopy(r.code));
  };
  return <div className="cr-root">
    <header className="cr-head2">
      {onBack && <button className="btn" onClick={onBack}>Back</button>}
      <h1>My posts</h1>
      <Segmented ariaLabel="Status" value={filter} options={FILTERS} onChange={setFilter} />
      <input ref={search} className="input cr-search" aria-label="Search my posts" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
      <button className="btn" onClick={onInbox}>Inbox</button>
      <button className="btn primary" onClick={onNewPost}>New post</button>
    </header>
    {data.status === 'ready' && data.value.cachedAt && <p className="cr-muted" role="status">{cachedStamp(data.value.cachedAt)}</p>}
    {note && <p className="cr-err" role="alert">{note}</p>}
    {data.status === 'loading' && <div className="cr-skel" aria-busy="true" />}
    {data.status === 'error' && <div className="cr-state"><p>{errorCopy(data.code)}</p><button className="btn" onClick={reload}>Retry</button></div>}
    {data.status === 'ready' && posts.length === 0 && <div className="cr-state"><p>{NO_POSTS}</p><button className="btn primary" onClick={onNewPost}>New post</button></div>}
    {data.status === 'ready' && posts.length > 0 && rows.length === 0 && <div className="cr-state">Nothing matches.</div>}
    <ul className="cr-list">{rows.map((p) => {
      const gate = reviewGate(p, { online: port.online(), busy: busy === p.postId });
      return <li key={p.postId} className="cr-post">
        <div className="cr-post-main">
          <strong className="cr-title">{p.title}</strong>
          <span className="cr-muted">{p.revision ? `v${p.revision}` : 'No version yet'} / {p.league} / <span className={`cr-status cr-${p.status}`}>{POST_STATUS_LABEL[p.status]}</span></span>
          {p.moderationReason && <p className="cr-reason">{p.moderationReason}</p>}
          {gate.hint && <p className="cr-muted">{gate.hint}</p>}
        </div>
        <div className="cr-btns">
          <button className="btn" onClick={() => onEdit(p)}>Edit</button>
          <button className="btn" disabled={p.status === 'draft'} onClick={() => onView(p)}>View</button>
          <button className="btn" aria-expanded={open === p.postId} onClick={() => setOpen(open === p.postId ? null : p.postId)}>Analytics</button>
          {gate.show && <button className="btn" disabled={gate.disabled} onClick={() => void request(p)}>{gate.label}</button>}
        </div>
        {open === p.postId && <AnalyticsPanel post={p} onClose={() => setOpen(null)} />}
      </li>;
    })}</ul>
  </div>;
}
