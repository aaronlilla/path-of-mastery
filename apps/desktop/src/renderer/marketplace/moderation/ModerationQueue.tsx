import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Segmented, Select } from '../../ui';
import { ACTION_LABEL, TABS, afterError, applicableActions, canApply, concurrentWarning, decideBody, decisionPreview, errorCopy, moveRow, queueEmptyCopy, queueView, shortId,
  type Action, type CaseDetail, type DecideState, type ModView, type QueueRow, type QueueTab } from './presenter';
import type { ModerationPort } from './port';
import './moderation.css';

const kinds = ['report', 'publication', 'verification'] as const;
type Load = 'loading' | 'ready' | 'error';
const blank: DecideState = { action: '', reason: '', confirmed: false, busy: false };

export function ModerationQueue({ port, access: initialAccess = 'unknown' }: { port: ModerationPort; access?: ModView['access'] }) {
  const [access, setAccess] = useState<ModView['access']>(initialAccess);
  const [tab, setTab] = useState<QueueTab>('reports'), [search, setSearch] = useState(''), [order, setOrder] = useState<'oldest' | 'newest'>('oldest');
  const [rows, setRows] = useState<QueueRow[]>([]), [load, setLoad] = useState<Load>('loading'), [cached, setCached] = useState<string | null>(null), [listErr, setListErr] = useState('');
  const [sel, setSel] = useState(-1), [detail, setDetail] = useState<CaseDetail | null>(null), [drawerErr, setDrawerErr] = useState('');
  const [stale, setStale] = useState(false), [concurrent, setConcurrent] = useState(false), [showAudit, setShowAudit] = useState(false);
  const [d, setD] = useState<DecideState>(blank);
  const searchRef = useRef<HTMLInputElement>(null), listRef = useRef<HTMLDivElement>(null);
  const online = port.online();
  const shown = useMemo(() => queueView(rows, { search, order }), [rows, search, order]);

  const refresh = useCallback(async () => {
    setLoad('loading'); setListErr('');
    const wanted = TABS.find((t) => t.value === tab)!;
    const res = await Promise.all((wanted.kind ? [wanted.kind] : kinds).map((k) => port.queue(k, wanted.kind ? 'open' : 'decided')));
    const bad = res.find((r) => !r.ok);
    if (bad && !bad.ok) { const a = afterError(bad.code); if (a.access) setAccess(a.access); setLoad('error'); setListErr(a.message); return; }
    setAccess('granted'); setRows(res.flatMap((r) => (r.ok ? r.value : []))); setLoad('ready'); setCached(online ? null : new Date().toLocaleTimeString());
  }, [port, tab, online]);
  useEffect(() => { setDetail(null); setSel(-1); void refresh(); }, [refresh]);
  useEffect(() => {
    const f = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); searchRef.current?.focus(); } };
    window.addEventListener('keydown', f); return () => window.removeEventListener('keydown', f);
  }, []);

  async function open(i: number) {
    const row = shown[i]; if (!row) return;
    setSel(i); setDrawerErr(''); setStale(false); setConcurrent(false); setShowAudit(false); setD(blank);
    const r = await port.readCase(row.id);
    if (!r.ok) { const a = afterError(r.code); if (a.access) setAccess(a.access); setDetail(null); setDrawerErr(a.message); return; }
    let det = r.value;
    if (det.case.status === 'open' && online && access === 'granted') { // soft claim
      const c = await port.claim(det.case.id, det.case.case_version);
      if (c.ok) { setConcurrent(c.value.concurrentReviewer); det = { ...det, case: { ...det.case, case_version: c.value.caseVersion } }; }
      else { const a = afterError(c.code); if (a.stale) setStale(true); if (a.access) setAccess(a.access); setDrawerErr(a.message); }
    }
    setDetail(det);
  }
  async function apply() {
    if (!detail) return;
    setD({ ...d, busy: true }); setDrawerErr('');
    const r = await port.decide(decideBody(detail, d));
    if (!r.ok) { const a = afterError(r.code); if (a.access) setAccess(a.access); if (a.stale) setStale(true); setDrawerErr(a.message); setD({ ...d, busy: false }); return; }
    setDetail(null); setSel(-1); setD(blank); void refresh();
  }
  const close = () => { setDetail(null); setDrawerErr(''); };

  if (access === 'denied') return <div className="mod-root"><p role="alert" className="mod-state">{errorCopy('MODERATOR_REQUIRED')}</p></div>;
  const gate = canApply(detail, d, { access, online, stale });
  const actions = detail ? applicableActions(detail.case) : [];
  const preview = detail && d.action ? decisionPreview(detail, d.action, d.reason) : null;
  const drawer = detail || (drawerErr && sel >= 0);
  return <div className="mod-root">
    <header className="mod-head"><h1>Moderation</h1>
      <Segmented ariaLabel="Queue" value={tab} onChange={setTab} options={TABS.map((t) => ({ value: t.value, label: t.label }))} /></header>
    <div className="mod-filters">
      <input ref={searchRef} aria-label="Search case ID" placeholder="Search case ID..." value={search} onChange={(e) => setSearch(e.target.value)} />
      <Select ariaLabel="Order" width={150} value={order} onChange={setOrder} options={[{ value: 'oldest', label: 'Oldest first' }, { value: 'newest', label: 'Newest first' }]} />
      {cached && <span className="mod-muted">Offline. Showing cases from {cached}. Decisions are unavailable.</span>}
    </div>
    <div className={`mod-main${drawer ? ' has-drawer' : ''}`}>
      <div className="mod-list" ref={listRef} role="listbox" aria-label="Cases"
        onKeyDown={(e) => {
          const n = moveRow(e.key, sel, shown.length);
          if (n != null) { e.preventDefault(); setSel(n); listRef.current?.querySelectorAll<HTMLElement>('[role=option]')[n]?.focus(); }
          else if (e.key === 'Enter' && sel >= 0) void open(sel);
        }}>
        {load === 'loading' && <div className="mod-skel" aria-busy="true" aria-label="Loading" />}
        {load === 'error' && <p role="alert" className="mod-state">{listErr} <button className="btn" onClick={() => void refresh()}>Try again</button></p>}
        {load === 'ready' && shown.length === 0 && <p className="mod-state">{queueEmptyCopy}</p>}
        {load === 'ready' && shown.map((r, i) => <div key={r.id} role="option" aria-selected={i === sel} tabIndex={i === Math.max(sel, 0) ? 0 : -1} className={`mod-row${i === sel ? ' on' : ''}`}
          onClick={() => void open(i)} onFocus={() => setSel(i)}>
          <strong>{shortId(r.id)}</strong><span>{r.target ?? r.kind}</span><span>{r.category ?? r.kind}</span>
          <span className="mod-muted">{new Date(r.opened_at).toLocaleString()}</span><span className="mod-muted">{r.claimed_by ? 'Claimed' : 'Unclaimed'}</span>
        </div>)}
      </div>
      {drawer && <aside className="mod-drawer" aria-label="Case" onKeyDown={(e) => { if (e.key === 'Escape') close(); }}>
        <div className="mod-drawer-head"><strong>CASE {detail ? shortId(detail.case.id) : ''}</strong><button className="btn ghost" aria-label="Close" onClick={close}>X</button></div>
        {concurrent && <p role="status" className="mod-warn">{concurrentWarning}</p>}
        {drawerErr && <p role="alert" className="mod-err">{drawerErr} {stale && <button className="btn" onClick={() => void open(sel)}>Refresh</button>}</p>}
        {detail && <>
          <section><h2>Reported version snapshot</h2><pre className="mod-snap">{JSON.stringify(detail.case.target_snapshot, null, 2)}</pre></section>
          {detail.live && <section><h2>Live now</h2><p>{detail.live.title} / {detail.live.status}</p></section>}
          {detail.report && <section><h2>Reporter evidence</h2><p>{detail.report.reason}</p><p className="mod-text">{detail.report.text}</p>{detail.report.evidence_url && <p className="mod-text">{detail.report.evidence_url}</p>}</section>}
          <div className="mod-btns"><button className="btn" onClick={() => port.viewLive(detail.case.id)}>View live item</button>
            <button className="btn" aria-expanded={showAudit} onClick={() => setShowAudit(!showAudit)}>Audit history</button></div>
          {showAudit && <ul className="mod-audit">{detail.audit.map((a, i) => <li key={i}>{a.event} / {new Date(a.created_at).toLocaleString()}</li>)}
            {detail.decisions.map((x, i) => <li key={`d${i}`}>{ACTION_LABEL[x.action] ?? x.action}: {x.reason}</li>)}
            {!detail.audit.length && !detail.decisions.length && <li>Nothing yet.</li>}</ul>}
          {actions.length === 0 ? <p className="mod-muted">No decision needed.</p> : <>
            <label className="mod-field">Decision
              <Select ariaLabel="Decision" width="100%" value={(d.action || ('' as never)) as Action} onChange={(v) => setD({ ...d, action: v, confirmed: false })}
                options={actions.map((a) => ({ value: a, label: ACTION_LABEL[a] }))} /></label>
            <label className="mod-field">Reason<textarea rows={3} value={d.reason} onChange={(e) => setD({ ...d, reason: e.target.value })} placeholder="Plain words the creator can read" /></label>
            {preview && <div className="mod-preview"><strong>{preview.headline}</strong>{preview.lines.map((l) => <p key={l}>{l}</p>)}
              {preview.creatorSees && <p className="mod-muted">Creator sees: {preview.creatorSees}</p>}
              {preview.confirm && <label className="mod-check"><input type="checkbox" checked={d.confirmed} onChange={(e) => setD({ ...d, confirmed: e.target.checked })} />{preview.confirm}</label>}</div>}
            {gate.why && <p className="mod-muted">{gate.why}</p>}
            <div className="mod-btns">
              {detail.case.kind === 'report' && detail.case.status === 'open' && <button className="btn" disabled={access !== 'granted' || !online || stale || d.busy || !d.reason.trim()} onClick={() => setD({ ...d, action: 'keep_content' })}>Keep content</button>}
              <button className="btn primary" disabled={!gate.ok} onClick={() => void apply()}>Apply decision</button></div>
          </>}
        </>}
      </aside>}
    </div>
  </div>;
}
