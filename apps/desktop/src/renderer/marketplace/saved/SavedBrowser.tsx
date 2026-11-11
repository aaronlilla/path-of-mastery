import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Collection, LeagueStamp, ObjectId, PublicItemPayload } from '@pom/mastery-contracts';
import { Dialog, Icon, PortalMenu, Segmented, Select, useToast } from '../../ui.js';
import type { SavedReference } from '../../../main/marketplace/cache.js';
import { COPY, applyUpdate, filterRows, loadSaved, noUsage, pinnedLink, previewUpdate, rowLine, syncSaved, syncText, videoDescription,
  type FieldChange, type SavedClient, type SavedRow, type SavedUsage, type UpdatePreview } from './presenter.js';
import './saved.css';

export type SavedBrowserProps = {
  client: SavedClient;
  online: boolean;
  /** The league being played now; "Current league" shows only this one. */
  activeLeague: string | null;
  /** Used to start a new collection in the active league. */
  stamp: LeagueStamp;
  copyText(text: string): Promise<boolean>;
  openExternal(url: string): void;
  /** Sign-in for Sync saved items. Resolves true when signed in. */
  signIn(): Promise<boolean>;
  signedIn: boolean;
  usage?(row: { objectId: ObjectId; payload: PublicItemPayload }): Promise<SavedUsage>;
  onOpen(payload: PublicItemPayload, row: SavedRow): void;
  onSendToTimeline(payload: PublicItemPayload): void;
  onBrowse(): void;
};

/** Saved browser: search, collections, update preview, share. Everything reads through the marketplace client. */
export function SavedBrowser(props: SavedBrowserProps) {
  const { client, online, activeLeague } = props, toast = useToast();
  const [rows, setRows] = useState<SavedRow[] | null>(null), [collections, setCollections] = useState<Collection[]>([]), [error, setError] = useState('');
  const [search, setSearch] = useState(''), [collection, setCollection] = useState<ObjectId | 'all'>('all'), [scope, setScope] = useState<'current' | 'all'>('current');
  const [busy, setBusy] = useState<string | null>(null), [note, setNote] = useState(''), [update, setUpdate] = useState<{ row: SavedRow; preview: UpdatePreview } | null>(null);
  const [popover, setPopover] = useState<{ kind: 'collections' | 'share'; id: ObjectId } | null>(null), [creating, setCreating] = useState(false), [name, setName] = useState('');
  const [kept, setKept] = useState<Record<string, boolean>>({});
  const searchRef = useRef<HTMLInputElement>(null), anchors = useRef(new Map<string, HTMLButtonElement>());
  const reload = useCallback(async () => {
    try { const l = await loadSaved(client); setRows(l.rows); setCollections(l.collections); setError(''); } catch { setError('Could not read your saved items. Try again.'); }
  }, [client]);
  useEffect(() => { void reload(); }, [reload]);
  // The "New revision" badge needs the site's newest revision, and only previewUpdate records it: ask once per saved item while Saved is open and online.
  const asked = useRef(new Set<string>());
  useEffect(() => {
    if (!online || !rows) return;
    const todo = rows.filter(r => r.status === 'ready' && !asked.current.has(r.objectId)).slice(0, 25);
    if (!todo.length) return;
    for (const r of todo) asked.current.add(r.objectId);
    let live = true;
    void (async () => {
      for (const r of todo) await client.call('previewUpdate', { objectId: r.objectId }).catch(() => null);
      if (live) await reload();
    })();
    return () => { live = false; };
  }, [online, rows, client, reload]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); searchRef.current?.focus(); searchRef.current?.select(); } };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, []);
  const shown = useMemo(() => filterRows(rows ?? [], { search, collection, scope, activeLeague }), [rows, search, collection, scope, activeLeague]);
  const run = async (id: string, fn: () => Promise<void>) => { setBusy(id); setNote(''); try { await fn(); } catch { setNote('That did not work. Try again.'); } finally { setBusy(null); } };

  const remove = (row: SavedRow) => void run(row.objectId, async () => {
    const r = await client.call('remove', { objectId: row.objectId });
    if (!r.ok) { setNote('Could not remove it. Try again.'); return; }
    await reload();
    toast({ text: 'Removed from Saved.', kind: 'info', key: 'saved-removed', action: { label: 'Undo', run: () => { void client.call('undoRemove', { objectId: row.objectId }).then(reload); } } });
  });
  const download = (row: SavedRow) => void run(row.objectId, async () => { const r = await client.call('download', { objectId: row.objectId }); if (!r.ok || r.value.cacheStatus !== 'ready') setNote('Download needed. Connect and try again.'); await reload(); });
  const open = (row: SavedRow) => { if (row.payload) props.onOpen(row.payload, row); };
  const startUpdate = (row: SavedRow) => void run(row.objectId, async () => {
    const p = await previewUpdate(client, row);
    if (p === null) { setNote('This is already the newest version.'); await reload(); return; }
    if ('error' in p) { setNote(p.error); return; }
    setUpdate({ row, preview: p });
  });
  const create = () => void run('new', async () => {
    const title = name.trim();
    if ([...title].length < 1 || [...title].length > 80) { setNote('Collection names need 1 to 80 characters.'); return; }
    const r = await client.call('createCollection', { title, stamp: props.stamp });
    if (!r.ok) { setNote(r.error.message); return; }
    setName(''); setCreating(false); await reload(); setCollection(r.value.objectId);
  });
  const sync = () => void run('sync', async () => {
    if (!props.signedIn && !(await props.signIn())) return;
    setNote(syncText(await syncSaved(client, rows ?? [], collections)));
  });
  const rowKey = (row: SavedRow) => (e: React.KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.key === 'Delete') { e.preventDefault(); remove(row); }
  };

  const list = rows === null ? null : shown;
  return <section className="sv sv-saved" aria-label="Saved items">
    <header className="sv-head"><h1>Saved items</h1>
      <div className="sv-tools">
        <div className="mp-search sv-search"><Icon name="search" size={16} /><input ref={searchRef} className="mp-input" aria-label="Search saved items" placeholder="Search saved items" value={search} onChange={e => setSearch(e.target.value)} /></div>
        <Select ariaLabel="Collection" width={200} value={collection as string} options={[{ value: 'all', label: 'All saved' }, ...collections.map(c => ({ value: c.objectId as string, label: c.title }))]} onChange={v => setCollection(v as ObjectId | 'all')} />
        <Segmented ariaLabel="League" value={scope} onChange={setScope} options={[{ value: 'current', label: 'Current league' }, { value: 'all', label: 'All leagues' }]} />
      </div></header>
    {!online && <p className="sv-banner" role="status">Offline. Saved items you have already copied still open.</p>}
    {note && <p className="sv-banner" role="status">{note}</p>}
    {error && <p className="sv-banner" role="alert">{error} <button type="button" className="btn" onClick={() => void reload()}>Retry</button></p>}
    {list === null && !error ? <p className="sv-empty" role="status">Loading...</p>
      : list && list.length === 0 ? <div className="sv-empty">{(rows?.length ?? 0) === 0 ? <><p>{COPY.empty}</p><button type="button" className="btn gold" onClick={props.onBrowse}>Browse Marketplace</button></>
        : <p>Nothing matches. {scope === 'current' && <button type="button" className="mp-link" onClick={() => setScope('all')}>Show all leagues</button>}</p>}</div>
      : <ul className="sv-list" aria-label="Saved items">{list?.map(row => <li key={row.objectId} className="sv-row" tabIndex={0} onKeyDown={rowKey(row)}
        onDoubleClick={() => open(row)} aria-label={row.title}>
        <div className="sv-main"><button type="button" className="sv-title" disabled={row.status !== 'ready'} onClick={() => open(row)}>{row.title}</button>
          <span className="sv-line">{rowLine(row)}{row.creator ? ` / By ${row.creator}` : ''}</span>
          <span className="sv-flags">
            {row.status === 'download_needed' && <span className="sv-flag">{busy === row.objectId ? COPY.downloading : COPY.downloadNeeded}</span>}
            {row.originalRemoved && <span className="sv-flag">{COPY.removed}</span>}
            {row.collectionIds.length > 0 && <span className="sv-flag">{row.collectionIds.map(id => collections.find(c => c.objectId === id)?.title).filter(Boolean).join(', ')}</span>}</span>
          {row.newVersion !== null && !kept[`${row.objectId}:${row.newVersion}`] && <div className="sv-new" role="status"><strong>{COPY.newRevision}</strong> (version {row.newVersion})
            <button type="button" className="btn" disabled={busy === row.objectId || !online} onClick={() => startUpdate(row)}>Preview update</button>
            <button type="button" className="btn ghost" onClick={() => setKept(k => ({ ...k, [`${row.objectId}:${row.newVersion}`]: true }))}>Keep saved version</button></div>}</div>
        <div className="sv-actions">
          {row.status === 'download_needed' ? <button type="button" className="btn" disabled={busy === row.objectId || !online} onClick={() => download(row)}>Download</button>
            : <><button type="button" className="btn" onClick={() => open(row)}>Open</button><button type="button" className="btn" onClick={() => row.payload && props.onSendToTimeline(row.payload)}>Send to timeline</button></>}
          <button type="button" className="btn ghost" ref={el => { if (el) anchors.current.set(`c${row.objectId}`, el); }} aria-haspopup="dialog" onClick={() => setPopover({ kind: 'collections', id: row.objectId })}>Collections</button>
          {row.payload && <button type="button" className="btn ghost" ref={el => { if (el) anchors.current.set(`s${row.objectId}`, el); }} aria-haspopup="dialog" onClick={() => setPopover({ kind: 'share', id: row.objectId })}><Icon name="share" /> Share</button>}
          <button type="button" className="btn ghost" disabled={busy === row.objectId} onClick={() => remove(row)}>Remove</button></div></li>)}</ul>}
    <footer className="sv-foot">
      {creating ? <form className="sv-new-collection" onSubmit={e => { e.preventDefault(); create(); }}><input className="mp-input" autoFocus aria-label="Collection name" placeholder="Collection name" maxLength={80} value={name} onChange={e => setName(e.target.value)} />
        <button type="submit" className="btn gold">Create</button><button type="button" className="btn ghost" onClick={() => { setCreating(false); setName(''); }}>Cancel</button></form>
        : <button type="button" className="btn" onClick={() => setCreating(true)}>New collection</button>}
      <button type="button" className="btn" disabled={busy === 'sync' || !online || (rows?.length ?? 0) + collections.length === 0} onClick={sync}>Sync saved items</button></footer>

    {popover?.kind === 'collections' && (() => { const row = rows?.find(r => r.objectId === popover.id); const a = { current: anchors.current.get(`c${popover.id}`) ?? null };
      return row ? <SavePopover client={client} reference={row.ref} collections={collections} stamp={props.stamp} anchor={a} open onClose={() => { setPopover(null); void reload(); }} /> : null; })()}
    {popover?.kind === 'share' && (() => { const row = rows?.find(r => r.objectId === popover.id); const a = { current: anchors.current.get(`s${popover.id}`) ?? null };
      return row?.payload ? <ShareBlock payload={row.payload} anchor={a} open copyText={props.copyText} openExternal={props.openExternal} onClose={() => setPopover(null)} /> : null; })()}
    {update && <UpdateDialog row={update.row} preview={update.preview} usage={props.usage} onKeep={() => { setKept(k => ({ ...k, [`${update.row.objectId}:${update.row.newVersion}`]: true })); setUpdate(null); }}
      onApply={async () => { const r = await applyUpdate(client, update.row, update.preview.payload); if (!r.ok) return r.error; setUpdate(null); setNote('Saved item updated. Your timelines and Runs were not changed.'); await reload(); return null; }} />}
  </section>;
}

/** Collection check list shown after Save or from a row. Save itself never asks for a collection. */
export function SavePopover({ client, reference, collections, stamp, anchor, open, onClose }: { client: SavedClient; reference: SavedReference; collections: Collection[]; stamp: LeagueStamp;
  anchor: React.RefObject<HTMLElement | null>; open: boolean; onClose: () => void }) {
  const [cols, setCols] = useState(collections), [name, setName] = useState(''), [err, setErr] = useState('');
  const has = (c: Collection) => c.members.some(m => m.publishedRevision.postId === reference.selectedRevision.postId && m.publishedRevision.revisionId === reference.selectedRevision.revisionId);
  const refresh = async () => { const r = await client.call('collections', {}); if (r.ok) setCols(r.value); };
  useEffect(() => { void refresh(); }, []);
  // The box flips at once; the saved state follows when the call returns (and wins if the call failed).
  const [shownAs, setShownAs] = useState<Record<string, boolean>>({});
  const toggle = async (c: Collection, present: boolean) => {
    setShownAs(m => ({ ...m, [c.objectId]: present }));
    const r = await client.call('member', { collectionId: c.objectId, saveId: reference.objectId, present });
    if (!r.ok) setErr('Could not change that collection.');
    await refresh(); setShownAs(m => { const { [c.objectId]: _gone, ...rest } = m; return rest; });
  };
  const create = async () => {
    const title = name.trim(); if ([...title].length < 1 || [...title].length > 80) { setErr('Collection names need 1 to 80 characters.'); return; }
    const r = await client.call('createCollection', { title, stamp }); if (!r.ok) { setErr(r.error.message); return; }
    await client.call('member', { collectionId: r.value.objectId, saveId: reference.objectId, present: true }); setName(''); setErr(''); await refresh();
  };
  return <PortalMenu anchor={anchor} open={open} onClose={onClose} label="Collections" role="dialog" minWidth={300}>
    <div className="sv-pop"><strong>{COPY.savedOnPc}</strong>
      <fieldset className="sv-checks"><legend>Collection</legend>
        {cols.length === 0 ? <p className="mp-note">No collections yet.</p> : cols.map(c => <label key={c.objectId} className="sv-check"><input type="checkbox" checked={shownAs[c.objectId] ?? has(c)} onChange={e => void toggle(c, e.target.checked)} /> <span>{c.title}</span></label>)}</fieldset>
      <div className="sv-new-collection"><input className="mp-input" aria-label="New collection name" placeholder="New collection" maxLength={80} value={name} onChange={e => setName(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void create(); } }} /><button type="button" className="btn" onClick={() => void create()}>New collection</button></div>
      {err && <p role="alert" className="sv-err">{err}</p>}
      <div className="sv-pop-foot"><button type="button" className="btn gold" onClick={onClose}>Done</button></div></div></PortalMenu>;
}

/** Pinned HTTPS link plus the video description block. Needs no account and no hosted write. */
export function ShareBlock({ payload, anchor, open, onClose, copyText, openExternal }: { payload: PublicItemPayload; anchor: React.RefObject<HTMLElement | null>; open: boolean; onClose: () => void;
  copyText(t: string): Promise<boolean>; openExternal(url: string): void }) {
  const [copied, setCopied] = useState<'link' | 'video' | null>(null), url = pinnedLink(payload);
  const copy = async (what: 'link' | 'video') => { if (await copyText(what === 'link' ? url : videoDescription(payload))) setCopied(what); };
  return <PortalMenu anchor={anchor} open={open} onClose={onClose} label="Share" role="dialog" minWidth={320}>
    <div className="sv-pop"><strong>Share this version</strong><p className="mp-note">This link opens version {payload.publishedRevision.displayRevision as number}.</p>
      <input className="mp-input" readOnly aria-label="Pinned link" value={url} onFocus={e => e.currentTarget.select()} />
      <div className="sv-pop-foot"><button type="button" className="btn" onClick={() => void copy('link')}><Icon name="copy" /> {copied === 'link' ? 'Copied' : 'Copy link'}</button>
        <button type="button" className="btn" onClick={() => openExternal(url)}>Open web preview</button></div>
      <button type="button" className="btn ghost" onClick={() => void copy('video')}>{copied === 'video' ? 'Copied' : 'Copy for video description'}</button></div></PortalMenu>;
}

function Changes({ title, items, empty }: { title: string; items: FieldChange[]; empty: string }) {
  return <section className="sv-group"><h3>{title}</h3>{items.length === 0 ? <p className="mp-note">{empty}</p>
    : <ul>{items.map(c => <li key={c.label}><strong>{c.label}</strong><span className="sv-before">{c.before}</span><span className="sv-after">{c.after}</span></li>)}</ul>}</section>;
}
function UpdateDialog({ row, preview, usage, onKeep, onApply }: { row: SavedRow; preview: UpdatePreview; usage?: SavedBrowserProps['usage']; onKeep: () => void; onApply: () => Promise<string | null> }) {
  const [use, setUse] = useState<SavedUsage>(noUsage), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { if (row.payload && usage) void usage({ objectId: row.objectId, payload: row.payload }).then(setUse, () => undefined); }, []);
  const r = preview.review, version = preview.payload.publishedRevision.displayRevision as number;
  return <Dialog title={`Update ${row.title}`} subtitle={`Saved version ${row.version} to version ${version}`} size="large" cancelLabel="Keep saved version" confirmLabel="Apply update" confirmBusy={busy}
    onCancel={onKeep} onConfirm={() => { setBusy(true); void onApply().then(e => { setBusy(false); if (e) setError(e); }); }} note={error ? <span role="alert">{error}</span> : undefined}>
    <div className="sv-update">
      <Changes title="Creator changes" items={r.creator} empty="No visible differences. Only the version number changes." />
      <Changes title="Your changes" items={r.yours} empty={COPY.yoursNone} />
      <Changes title="Conflicts" items={r.conflicts} empty="None." />
      <section className="sv-group"><h3>Not changed by this</h3><p className="mp-note">{COPY.stays}</p>
        {use.clips.length === 0 && use.runs.length === 0 ? <p className="mp-note">No timelines or Runs use this saved item.</p>
          : <ul>{use.clips.map((c, i) => <li key={`c${i}`}><span>{c.timelineTitle} / {c.clipLabel} stays on version {c.version}</span>{c.open && <button type="button" className="btn ghost" onClick={c.open}>Preview update there</button>}</li>)}
            {use.runs.map((x, i) => <li key={`r${i}`}><span>Run: {x.title} stays on version {x.version}</span>{x.open && <button type="button" className="btn ghost" onClick={x.open}>Review edited version</button>}</li>)}</ul>}</section>
    </div></Dialog>;
}
