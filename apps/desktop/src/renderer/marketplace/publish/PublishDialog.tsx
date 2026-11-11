import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { PublicItemPayload, PublishedRevisionRef } from '@pom/mastery-contracts';
import { Dialog, Segmented, Select, Switch } from '../../ui.js';
import { BuildDetail } from '../detail/BuildDetail.js';
import { AtlasDetail } from '../detail/AtlasDetail.js';
import { TimelineDetail } from '../detail/TimelineDetail.js';
import type { MarketplaceProps } from '../services.js';
import type { PublishPort, PublishSource, PublishType } from './port.js';
import { AttemptBook, BUDGETS, COPY, TYPE_LABEL, archiveLabel, blockText, budgetLabel, buildPublication, classLine, draftFromSource, firstError, fingerprint, isOldLeague, leagueOf, mechanicLabel, normalizeDraft, requestReview,
  submitPublish, timelineFacts, validateDraft, videoKind, descLength, type Built, type Draft, type Errors, type Field, type PublishView } from './presenter.js';
import './publish.css';

const books = new WeakMap<PublishPort, AttemptBook>();
const bookFor = (port: PublishPort) => { let b = books.get(port); if (!b) { b = new AttemptBook(); books.set(port, b); } return b; };

export type PublishDialogProps = {
  port: PublishPort;
  /** Source-origin Publish skips the picker. Feed-origin Publish passes none. */
  source?: PublishSource | null;
  /** Source type when the person chose it elsewhere. */
  type?: PublishType;
  onClose(): void;
  onPublished?(ref: PublishedRevisionRef, payload: PublicItemPayload): void;
  onOpenMyPosts?(): void;
};

/** Details -> Preview -> Publish. Nothing is sent before the final Publish on the preview. */
export function PublishDialog({ port, source: initial = null, type: initialType, onClose, onPublished, onOpenMyPosts }: PublishDialogProps) {
  const [type, setType] = useState<PublishType | null>(initial?.kind ?? initialType ?? null);
  const [source, setSource] = useState<PublishSource | null>(initial);
  const [list, setList] = useState<PublishSource[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(() => initial ? loaded(port, initial) : null);
  const [tab, setTab] = useState<'details' | 'preview'>('details');
  const [shown, setShown] = useState<Errors>({});
  const [view, setView] = useState<PublishView | null>(null), [busy, setBusy] = useState(false), [note, setNote] = useState('');
  const [review, setReview] = useState<{ text: string; ok: boolean } | null>(null), [focusField, setFocusField] = useState<Field | null>(null);
  const [tagsRaw, setTagsRaw] = useState(() => draft?.tags.join(', ') ?? '');
  const heading = useRef<HTMLDivElement>(null), book = bookFor(port);

  useEffect(() => {
    if (!type || source) return;
    let live = true; setList(null);
    port.sources(type).then(s => { if (live) setList(s); }, () => { if (live) setList([]); });
    return () => { live = false; };
  }, [type, source]);
  useEffect(() => { if (focusField && tab === 'details') { document.getElementById(`pub-f-${focusField}`)?.focus(); setFocusField(null); } }, [focusField, tab]);

  const errors = useMemo(() => draft && type ? validateDraft(draft, source, type, port.activeLeague) : {}, [draft, source, type, port.activeLeague]);
  const key = source && draft ? book.keyFor(fingerprint(source, draft)) : '';
  const built = useMemo(() => source && draft && tab === 'preview' ? buildPublication(source, draft, port, key) : null, [source, draft, tab, key]);
  const set = (patch: Partial<Draft>) => { setDraft(d => d ? { ...d, ...patch } : d); setView(v => v?.kind === 'published' ? v : null); setReview(null); };
  const pick = (s: PublishSource) => { setSource(s); const d = loaded(port, s); setDraft(d); setTagsRaw(d.tags.join(', ')); };
  const saveDraft = () => { if (!source || !draft) return; const next = { ...draft, draftVersion: draft.draftVersion + 1 }; setDraft(next); port.saveDraft(source.objectId, next); setNote('Draft saved.'); };
  const toPreview = () => {
    if (!source || !draft || !type) return;
    const e = validateDraft(draft, source, type, port.activeLeague);
    setShown(e); const f = firstError(e);
    if (f) { setFocusField(f); return; }
    setNote(''); setTab('preview'); setView(null);
  };
  const publish = async (acceptChangedSource = false) => {
    if (!source || !built || !built.ok || busy) return;
    setBusy(true); setNote(''); setReview(null);
    const v = await submitPublish(port, built.value, source, { acceptChangedSource });
    setBusy(false); setView(v);
    if (v.kind === 'published') onPublished?.(v.ref, built.value.preview);
  };
  const continueBlocked = async (kind: 'sign_in' | 'human_check') => {
    setBusy(true); const back = await port.continueBlocked(kind); setBusy(false);
    if (back) { setView(null); setNote(blockText(kind)); } // back on the preview; the person presses Publish again
  };
  const refresh = async () => {
    if (!source) return;
    const fresh = (await port.sources(source.kind)).find(s => s.objectId === source.objectId);
    if (fresh) { setSource(fresh); setView(null); setNote('Preview refreshed.'); }
  };
  const editDetails = (field: Field | null) => { setTab('details'); setView(null); if (field) setFocusField(field); };
  const askReview = async () => { setBusy(true); const r = await requestReview(port, key); setBusy(false); setReview({ text: r.text, ok: r.ok }); };
  const onKey = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveDraft(); }
    else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && tab === 'details' && source) { e.preventDefault(); toPreview(); }
  };

  const title = `Publish ${type ? TYPE_LABEL[type] : ''}`.trim();
  const done = view?.kind === 'published';
  const cancel = () => { if (tab === 'preview' && !done) editDetails(null); else onClose(); };

  // Feed-origin picker
  if (!source || !draft) return <Dialog title="Publish" size="medium" confirmLabel={null} cancelLabel="Cancel" onCancel={onClose}>
    <div className="pub" onKeyDown={onKey}>
      <p className="pub-hint">What do you want to publish?</p>
      <Segmented ariaLabel="Source type" value={(type ?? '') as PublishType} onChange={setType} options={(['build', 'atlas', 'timeline'] as const).map(t => ({ value: t, label: TYPE_LABEL[t] }))} />
      {type && <div className="pub-sources" role="list" aria-label={`Saved ${TYPE_LABEL[type]}`}>
        <p className="pub-hint">{`Choose a saved ${TYPE_LABEL[type]}`}</p>
        {list === null ? <p className="pub-hint" role="status">Loading...</p> : list.length === 0 ? <p className="pub-hint">{`No saved ${TYPE_LABEL[type]} to publish yet.`}</p>
          : list.map(s => <button key={s.objectId} type="button" role="listitem" className="btn pub-source" onClick={() => pick(s)}><strong>{s.title}</strong><small>{leagueOf(s)} / Version {s.localRevision}</small></button>)}
      </div>}
    </div></Dialog>;

  const err = (f: Field) => shown[f] ?? undefined;
  const field = (f: Field, label: string, control: ReactNode, hint?: string) => <label className="pub-field" htmlFor={`pub-f-${f}`}><span>{label}</span>{control}
    {err(f) ? <small className="pub-err" role="alert">{err(f)}</small> : hint ? <small className="pub-hint">{hint}</small> : null}</label>;
  const plain = (id: string, label: string, value: string, on: (v: string) => void) => <label className="pub-field" htmlFor={`pub-f-${id}`}><span>{label}</span><input id={`pub-f-${id}`} className="mp-input" value={value} onChange={e => on(e.target.value)} /></label>;
  const typeFields = () => {
    if (source.kind === 'build') return <>
      <div className="pub-row">{plain('skill', 'Main skill', draft.mainSkill, mainSkill => set({ mainSkill }))}
        <div className="pub-field"><span>Class</span><div className="pub-static" id="pub-f-class">{classLine(draft.className, draft.ascendancy) || 'Not in the build'}<small>From the build. Used by the Class filter.</small></div></div></div>
      <p className="pub-hint">{source.document.kind === 'build' ? `Includes leveling guide: ${source.document.payload.guide.length ? `yes, ${source.document.payload.guide.length} steps` : 'no'}. Required items: ${source.document.payload.gear.length}.` : ''}</p></>;
    if (source.kind === 'atlas') return <><div className="pub-field"><span>Mechanics</span><div className="pub-static" id="pub-f-mech">{draft.mechanics.length ? draft.mechanics.map(mechanicLabel).join(', ') : 'None found in this plan'}<small>From the nodes this plan allocates. Used by the Mechanics filter.</small></div></div>
      <p className="pub-hint">{source.document.kind === 'atlas' ? (() => { const steps = Object.values(source.document.payload.stepsById); return `Includes maps: ${steps.some(s => s.maps.length) ? 'yes' : 'no'}. Includes scarabs: ${steps.some(s => s.scarabs.length) ? 'yes' : 'no'}. Steps: ${steps.length}.`; })() : ''}</p></>;
    return null;
  };
  const facts = built?.ok ? built.value.timeline : null;

  return <Dialog title={done ? 'Published' : title} size="large" confirmLabel={null} cancelLabel={null} onCancel={cancel}>
    <div className="pub" onKeyDown={onKey} ref={heading}>
      {!done && <div className="seg" role="tablist" aria-label="Publish steps">{(['details', 'preview'] as const).map(t =>
        <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => t === 'preview' ? toPreview() : editDetails(null)}>{t === 'details' ? 'Details' : 'Preview'}</button>)}</div>}
      {source.existing && !done && <p className="pub-hint">{`Updates ${source.existing.title}. Votes and the first publication date stay; this adds version ${source.existing.displayRevision + 1}.`}</p>}
      {view?.kind === 'offline' && <p className="pub-banner" role="alert">{COPY.offline}</p>}
      {view?.kind === 'rejected' && <div className="pub-banner pub-reject" role="alert"><strong>Could not publish.</strong> <span>{view.rejection.text}</span>
        <span className="pub-actions"><button type="button" className="btn" onClick={() => editDetails(view.rejection.field)}>Edit details</button>
          {view.rejection.canReview && !review && <button type="button" className="btn" disabled={busy} onClick={() => void askReview()}>Request review</button>}</span></div>}
      {review && <p className={review.ok ? 'pub-banner' : 'pub-banner pub-reject'} role="status">{review.text}</p>}
      {view?.kind === 'unknown' && <p className="pub-banner" role="alert">{COPY.unknown}</p>}
      {view?.kind === 'source_changed' && <div className="pub-banner" role="alert"><span>{COPY.sourceChanged}</span>
        <span className="pub-actions"><button type="button" className="btn" onClick={() => void refresh()}>Refresh preview</button><button type="button" className="btn" onClick={() => void publish(true)}>Publish reviewed version</button></span></div>}
      {(view?.kind === 'sign_in' || view?.kind === 'human_check') && <div className="pub-banner" role="alert">
        <span>{view.kind === 'sign_in' ? 'Sign in to publish. Your preview stays as it is.' : 'One quick check before publishing. Your preview stays as it is.'}</span>
        <button type="button" className="btn" disabled={busy} onClick={() => void continueBlocked(view.kind as 'sign_in' | 'human_check')}>{view.kind === 'sign_in' ? 'Continue with Discord' : 'Continue'}</button></div>}
      {note && !view && <p className="pub-hint" role="status">{note}</p>}

      {done && view.kind === 'published' && <div className="pub-done" role="status"><p>{draft.visibility === 'public' ? 'Your post is live. Anyone can open, follow and copy it.' : 'Your post is live as Unlisted. Only people with the link can open it.'}</p>
        <p className="pub-hint">{`${draft.title.trim()} / Version ${view.ref.displayRevision}`}</p>
        <div className="pub-foot"><button type="button" className="btn ghost" onClick={onClose}>Close</button>{onOpenMyPosts && <button type="button" className="btn gold" onClick={onOpenMyPosts}>My posts</button>}</div></div>}

      {!done && tab === 'details' && <form className="pub-form" onSubmit={e => { e.preventDefault(); toPreview(); }}>
        <div className="pub-row"><div className="pub-field"><span>Source</span><div className="pub-static">{source.title}<small>{leagueOf(source)} / Version {source.localRevision}</small></div></div>
          {field('title', 'Title', <input id="pub-f-title" className="mp-input" value={draft.title} maxLength={160} aria-invalid={!!err('title')} onChange={e => set({ title: e.target.value })} />)}</div>
        {field('description', 'Description', <textarea id="pub-f-description" className="mp-input" rows={5} value={draft.description} aria-invalid={!!err('description')} onChange={e => set({ description: e.target.value })} />,
          `${descLength(draft.description)} characters. Short lists, bold, italic and https links work.`)}
        <div className="pub-row pub-modes"><div className="pub-field"><span>Mode</span><Segmented ariaLabel="Mode" value={draft.economy} onChange={economy => set({ economy })} options={[{ value: 'trade', label: 'Trade' }, { value: 'ssf', label: 'SSF' }]} /></div>
          <span className="pub-sw"><Switch checked={draft.hardcore} onChange={hardcore => set({ hardcore })} label="Hardcore" /><span>Hardcore</span></span><span className="pub-sw"><Switch checked={draft.ruthless} onChange={ruthless => set({ ruthless })} label="Ruthless" /><span>Ruthless</span></span>
          <div className="pub-field"><span>Budget</span><Select ariaLabel="Budget" width={140} value={draft.budget} options={BUDGETS} onChange={budget => set({ budget })} /></div>
          <label className="pub-check" htmlFor="pub-f-starter" title="A creator claim. Budget bands carry no currency guarantee."><input id="pub-f-starter" type="checkbox" checked={draft.leagueStarter} onChange={e => set({ leagueStarter: e.target.checked })} /><span>League starter</span></label></div>
        {typeFields()}
        {source.kind === 'timeline' && (() => { const t = timelineFactsOf(source); return t ? <div className="pub-facts"><p>{`Included lanes: ${t.included.length ? t.included.join(', ') : 'none'}.`}</p>{t.text && <p>{t.text}</p>}
          {t.range && <p>{`Starts at level ${t.range.start}. Ends at level ${t.range.end - 1}.`} {t.choices ? `Required choices: ${t.choices}.` : ''}</p>}
          {t.missing.map(m => <p key={m} className="pub-hint">{m}.</p>)}</div> : null; })()}
        {field('tags', 'Tags', <input id="pub-f-tags" className="mp-input" value={tagsRaw} placeholder="Comma separated, up to 10" aria-invalid={!!err('tags')}
          onChange={e => { setTagsRaw(e.target.value); set({ tags: e.target.value.split(',').map(t => t.trim()).filter(Boolean) }); }} />)}
        <div className="pub-row"><div className="pub-field"><span>Visibility</span><Segmented ariaLabel="Visibility" value={draft.visibility} onChange={visibility => set({ visibility })} options={[{ value: 'public', label: 'Public' }, { value: 'unlisted', label: 'Unlisted' }]} />
            <small className="pub-hint">{draft.visibility === 'unlisted' ? 'Only people with the link can open it. It stays out of the feed and search.' : 'Shown in the feed and search.'}</small></div>
          {field('video', 'Video (optional)', <input id="pub-f-video" className="mp-input" inputMode="url" value={draft.video} placeholder="https://" aria-invalid={!!err('video')} onChange={e => set({ video: e.target.value })} />,
            draft.video.trim() && videoKind(draft.video.trim()) ? `Shown as a ${videoKind(draft.video.trim())} link.` : undefined)}</div>
        <fieldset className="pub-included"><legend>Included content</legend>
          <span className="pub-sw"><Switch checked={false} disabled onChange={() => undefined} label="Include edit history" /><span>Include edit history</span></span><span className="pub-sw"><Switch checked={false} disabled onChange={() => undefined} label="Include private notes" /><span>Include private notes</span></span>
          <small className="pub-hint">Both stay off for shared posts. You can check exactly what goes out under Preview.</small></fieldset>
        {isOldLeague(source, port.activeLeague) && <label className="pub-check" htmlFor="pub-f-archive"><input id="pub-f-archive" type="checkbox" checked={draft.archiveOk} onChange={e => set({ archiveOk: e.target.checked })} /><span>{archiveLabel(source)}</span>
          {err('archive') && <small className="pub-err" role="alert">{err('archive')}</small>}</label>}
        {source.credits.length > 0 && <p className="pub-hint">{`Source credits: ${source.credits.map(c => `${c.title} by ${c.creatorName}`).join(', ')}`}</p>}
        <div className="pub-foot"><span className="pub-hint">{note}</span><button type="button" className="btn ghost" onClick={onClose}>Cancel</button><button type="button" className="btn" onClick={saveDraft}>Save draft</button>
          <button type="submit" className="btn gold">Preview</button></div>
      </form>}

      {!done && tab === 'preview' && built && !built.ok && <div className="pub-banner pub-reject" role="alert">{Object.values(built.errors)[0]}</div>}
      {!done && tab === 'preview' && built?.ok && <div className="pub-preview">
        <PreviewSummary built={built.value} draft={draft} source={source} facts={facts} />
        <div className="mp-area pub-detail" aria-label="Preview of the published post"><PreviewBody item={built.value.preview} /></div>
        <div className="pub-foot"><span className="pub-hint">{!port.online() ? COPY.offline : note}</span><button type="button" className="btn ghost" onClick={() => editDetails(null)}>Back</button>
          <button type="button" className="btn gold" disabled={busy} aria-busy={busy || undefined} onClick={() => void publish()}>{busy ? 'Publishing...' : 'Publish'}</button></div>
      </div>}
    </div></Dialog>;
}

const timelineFactsOf = (s: PublishSource) => timelineFacts(s.document);
/** The saved local draft for this source (normalized: derived fields come from the source again), or a new one. */
const loaded = (port: PublishPort, s: PublishSource): Draft => { const d = port.loadDraft(s.objectId); return d ? normalizeDraft(d, s) : draftFromSource(s); };

function PreviewSummary({ built, draft, source, facts }: { built: Built; draft: Draft; source: PublishSource; facts: ReturnType<typeof timelineFacts> }) {
  const inc = built.included;
  return <div className="pub-summary">
    <p><strong>{draft.visibility === 'public' ? 'Public' : 'Unlisted'}</strong> / {leagueOf(source)} / {draft.economy === 'ssf' ? 'SSF' : 'Trade'}{draft.hardcore ? ' / Hardcore' : ''}{draft.ruthless ? ' / Ruthless' : ''}{draft.budget !== 'not_stated' ? ` / ${budgetLabel(draft.budget)} budget` : ''}{draft.leagueStarter ? ' / League starter' : ''}</p>
    {draft.tags.length > 0 && <p className="pub-tags">{draft.tags.map(t => <span key={t} className="pub-tag">{t}</span>)}</p>}
    <p>{`Included: ${TYPE_LABEL[source.kind]} version ${inc.version}.`} {inc.omitted.length ? `Left out: ${inc.omitted.join(', ')}.` : 'No private notes or edit history in this source.'}</p>
    <p className="pub-hint">{inc.fixed}</p>
    {facts?.text && <p role="status">{facts.text}</p>}
    {facts?.missing.map(m => <p key={m} className="pub-hint">{m}.</p>)}
    {built.preview.credits.length > 0 && <p className="pub-hint">{`Source credits: ${built.preview.credits.map(c => c.status === 'original_removed' ? 'Original removed' : `Copied from ${c.title} by ${c.creatorName}`).join(' / ')}`}</p>}
  </div>;
}

/** The same detail bodies the Marketplace shows, with every action switched off. */
function PreviewBody({ item }: { item: PublicItemPayload }) {
  const props = useMemo<MarketplaceProps>(() => ({
    services: { feed: async () => never(), count: async () => never(), item: async () => never(), vote: async () => never(), save: async () => never(), run: async () => never(), editCopy: async () => never(),
      share: async () => ({ url: '' }), copyText: async () => false, openExternal: () => undefined },
    viewer: { signedIn: true, ownPostIds: [], votes: {}, saved: {}, activeLeague: null }, online: true, league: item.stamp, leagues: [],
    onSignIn: () => undefined, onPublish: () => undefined, onNavigate: () => undefined, onReport: () => undefined, onCreator: () => undefined, onOpenCopy: () => undefined, onSendToTimeline: () => undefined,
  }), [item]);
  const actions = { editCopy: () => undefined, run: () => undefined, send: () => undefined, busy: null, note: '' };
  const same = () => undefined;
  return item.document.kind === 'build' ? <BuildDetail item={item} document={item.document} props={props} actions={actions} onSelectRevision={same} />
    : item.document.kind === 'atlas' ? <AtlasDetail item={item} document={item.document} props={props} actions={actions} onSelectRevision={same} />
    : <TimelineDetail item={item} document={item.document} props={props} actions={actions} onSelectRevision={same} />;
}
function never(): never { throw new Error('Preview only'); }
