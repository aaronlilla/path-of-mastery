import { useEffect, useRef, useState } from 'react';
import type { PublicItemPayload } from '@pom/mastery-contracts';
import { Dialog, Icon, PortalMenu, Segmented, Select } from '../../ui.js';
import { VotesProvider } from '../VoteControls.js';
import { FeedCard } from '../feed/FeedCard.js';
import type { FeedType, ViewerState } from '../presenter.js';
import { primarySorts, sortLabels, type FeedSort } from '../ranking.js';
import type { MarketplaceServices } from '../services.js';
import type { CreatorPort, ProfileData } from './port.js';
import { BIO_MAX, EMPTY_CREATOR, NAME_MAX, REPUTATION_HELP, VERIFIED_TIP, LINKS_MAX, bioView, cachedStamp, errorCopy, followGate, linkView, reputationView, validateProfile, type ProfileDraft } from './presenter.js';
import { useLoad } from './useLoad.js';
import { VerifyDialog } from './VerifyDialog.js';

export type CreatorProfileProps = {
  port: CreatorPort; services: MarketplaceServices; viewer: ViewerState; who: { name: string; publicId?: string } | { own: true };
  leagues: { id: string; label: string }[]; onBack(): void; onOpen(item: PublicItemPayload): void; onReport(creator: { id: string; name: string }): void;
  onMyPosts(): void; onSignIn(): void;
};
const TYPES: { value: FeedType; label: string }[] = [{ value: 'build', label: 'Builds' }, { value: 'atlas', label: 'Atlas' }, { value: 'timeline', label: 'Timelines' }];

function LinkIcon({ kind }: { kind: 'youtube' | 'twitch' | 'site' }) { return <Icon name={kind === 'site' ? 'link' : kind === 'youtube' ? 'play' : 'tv'} size={14} />; }

function EditForm({ profile, port, onDone, onCancel }: { profile: ProfileData; port: CreatorPort; onDone(p: ProfileData): void; onCancel(): void }) {
  const [d, setD] = useState<ProfileDraft>({ name: profile.name, bio: profile.bio, links: profile.links.length ? profile.links : [''] });
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const v = validateProfile(d);
  const save = async () => {
    if (!v.ok || busy) return;
    setBusy(true); setError('');
    const r = await port.saveProfile({ ...d, links: d.links.map((l) => l.trim()).filter(Boolean) });
    setBusy(false);
    if (r.ok) onDone(r.value); else setError(errorCopy(r.code));
  };
  return <Dialog title="Edit profile" size="medium" cancelLabel="Cancel" confirmLabel="Save" confirmDisabled={!v.ok || !port.online()} confirmBusy={busy} onCancel={onCancel} onConfirm={() => void save()}
    note={!port.online() ? 'Connect to save your profile.' : undefined}>
    <div className="cr-form">
      <label className="cr-field">Public creator name<input className={`input${v.errors.name ? ' bad' : ''}`} value={d.name} maxLength={NAME_MAX + 20} onChange={(e) => setD({ ...d, name: e.target.value })} />
        {v.errors.name && <span className="cr-err">{v.errors.name}</span>}</label>
      <label className="cr-field">Bio<textarea className={`input${v.errors.bio ? ' bad' : ''}`} rows={4} value={d.bio} onChange={(e) => setD({ ...d, bio: e.target.value })} />
        <span className="cr-muted">{d.bio.length} / {BIO_MAX}</span>{v.errors.bio && <span className="cr-err">{v.errors.bio}</span>}</label>
      <div className="cr-field">Links (up to {LINKS_MAX}, https only)
        {d.links.map((l, i) => <div key={i} className="cr-row"><input className={`input${v.errors.link[i] ? ' bad' : ''}`} aria-label={`Link ${i + 1}`} value={l} placeholder="https://"
          onChange={(e) => setD({ ...d, links: d.links.map((x, j) => (j === i ? e.target.value : x)) })} />
          <button type="button" className="btn" aria-label={`Remove link ${i + 1}`} onClick={() => setD({ ...d, links: d.links.filter((_, j) => j !== i) })}>Remove</button>
          {v.errors.link[i] && <span className="cr-err">{v.errors.link[i]}</span>}</div>)}
        {d.links.length < LINKS_MAX && <button type="button" className="btn" onClick={() => setD({ ...d, links: [...d.links, ''] })}>Add link</button>}
        {v.errors.links && <span className="cr-err">{v.errors.links}</span>}</div>
      {error && <p className="cr-err" role="alert">{error}</p>}
    </div>
  </Dialog>;
}

export function CreatorProfile(props: CreatorProfileProps) {
  const { port, services, viewer, who, leagues } = props;
  const [league, setLeague] = useState(leagues[0]?.id ?? 'all'), [type, setType] = useState<FeedType>('build'), [sort, setSort] = useState<FeedSort>('hot');
  const [profile, reload, setProfile] = useLoad(() => port.profile(who, league), [JSON.stringify(who), league]);
  const p = profile.status === 'ready' ? profile.value : null;
  const [items, reloadItems] = useLoad(() => (p ? port.items(p.creatorId, { type: type === 'all' ? 'build' : type, sort, league }) : Promise.resolve({ ok: true as const, value: [] as PublicItemPayload[] })), [p?.creatorId, type, sort, league]);
  const [helpOpen, setHelpOpen] = useState(false), [expanded, setExpanded] = useState(false), [edit, setEdit] = useState(false), [verify, setVerify] = useState(false);
  const [more, setMore] = useState(false), [note, setNote] = useState('');
  const moreBtn = useRef<HTMLButtonElement>(null), search = useRef<HTMLInputElement>(null), [q, setQ] = useState('');
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); search.current?.focus(); } };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, []);
  if (profile.status === 'loading') return <div className="cr-root" aria-busy="true"><div className="cr-skel" /><div className="cr-skel" /></div>;
  if (!p) return <div className="cr-root"><div className="cr-state"><p>{profile.status === 'error' ? errorCopy(profile.code) : ''}</p><button className="btn" onClick={reload}>Retry</button> <button className="btn" onClick={props.onBack}>Back</button></div></div>;
  const gate = followGate({ signedIn: port.signedIn(), online: port.online(), following: p.following, own: p.own });
  const toggleFollow = async () => {
    if (gate.action === 'sign_in') { props.onSignIn(); return; }
    setNote('');
    const on = !p.following, r = await port.follow(p.creatorId, on);
    if (r.ok) setProfile({ ...p, following: on }); else setNote(errorCopy(r.code));
  };
  const bio = bioView(p.bio, expanded);
  const links = p.links.map(linkView).filter((l): l is NonNullable<ReturnType<typeof linkView>> => !!l).slice(0, LINKS_MAX);
  const rows = items.status === 'ready' ? items.value.filter((i) => !q.trim() || i.title.toLowerCase().includes(q.trim().toLowerCase())) : [];
  return <VotesProvider services={services} viewer={viewer} online={port.online()} onSignIn={props.onSignIn}>
    <div className="cr-root">
      <nav className="cr-crumb"><button className="mp-link" onClick={props.onBack}>Marketplace</button> / {p.name}</nav>
      <header className="cr-head">
        <div className="cr-avatar" aria-hidden="true">{p.name.slice(0, 1).toUpperCase()}</div>
        <div className="cr-who">
          <h1>{p.name} {p.verified && <span className="mp-verified" tabIndex={0} title={VERIFIED_TIP} aria-label={`Verified creator. ${VERIFIED_TIP}`}><Icon name="check-circle" size={14} /> Verified creator</span>}</h1>
          {p.bio && <p className="cr-bio">{bio.text}{bio.collapsible && <> <button type="button" className="mp-link" onClick={() => setExpanded(!expanded)}>{expanded ? 'Show less' : 'Read more'}</button></>}</p>}
          {links.length > 0 && <ul className="cr-links">{links.map((l) => <li key={l.href}><button type="button" className="mp-link" onClick={() => services.openExternal(l.href)}><LinkIcon kind={l.kind} /> {l.label}</button></li>)}</ul>}
        </div>
        <div className="cr-actions">
          {!p.own && <button type="button" className="btn primary" aria-pressed={p.following} disabled={gate.disabled} onClick={() => void toggleFollow()}>{gate.label}</button>}
          <button type="button" ref={moreBtn} className="icon-btn" aria-label="More actions" aria-haspopup="menu" aria-expanded={more} onClick={() => setMore(!more)}><Icon name="more" /></button>
          <PortalMenu anchor={moreBtn} open={more} onClose={() => { setMore(false); moreBtn.current?.focus(); }} align="right" label="More actions">
            <button role="menuitem" className="menu-item" disabled={p.own} onClick={() => { setMore(false); props.onReport({ id: p.creatorId, name: p.name }); }}>Report creator</button>
          </PortalMenu>
        </div>
      </header>
      {gate.hint && <p className="cr-muted">{gate.hint}</p>}
      {note && <p className="cr-err" role="alert">{note}</p>}
      {p.cachedAt && <p className="cr-muted" role="status">{cachedStamp(p.cachedAt)}</p>}
      <dl className="cr-rep">{reputationView(p.reputation).map((r) => <div key={r.label}><dt>{r.label}</dt><dd>{r.value}</dd></div>)}</dl>
      <div className="cr-bar">
        <Select ariaLabel="League" width={200} value={league} onChange={setLeague} options={[...leagues.map((l) => ({ value: l.id, label: l.label })), { value: 'all', label: 'All-time votes' }]} />
        <div className="cr-help"><button type="button" className="btn" aria-expanded={helpOpen} onClick={() => setHelpOpen(!helpOpen)}>How reputation works</button></div>
      </div>
      {helpOpen && <p className="cr-panel" role="note" tabIndex={-1} onKeyDown={(e) => { if (e.key === 'Escape') setHelpOpen(false); }}>{REPUTATION_HELP}</p>}
      <div className="cr-bar">
        <Segmented ariaLabel="Type" value={type} options={TYPES} onChange={setType} />
        <Segmented ariaLabel="Sort" value={sort} options={primarySorts.map((s) => ({ value: s, label: sortLabels[s] }))} onChange={setSort} />
        <input ref={search} className="input cr-search" aria-label="Search this creator" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {items.status === 'loading' && <div className="cr-skel" aria-busy="true" />}
      {items.status === 'error' && <div className="cr-state"><p>{errorCopy(items.code)}</p><button className="btn" onClick={reloadItems}>Retry</button></div>}
      {items.status === 'ready' && rows.length === 0 && <div className="cr-state">{items.value.length === 0 ? EMPTY_CREATOR : 'Nothing matches.'}</div>}
      {items.status === 'ready' && rows.length > 0 && <div className="cr-feed">{rows.map((it) => <FeedCard key={it.publicId} item={it} view="list" viewer={viewer} services={services} online={port.online()}
        onOpen={() => props.onOpen(it)} onCreator={() => undefined} onSignIn={props.onSignIn} />)}</div>}
      {p.own && <footer className="cr-own">
        <button type="button" className="btn" onClick={() => setEdit(true)}>Edit profile</button>
        <button type="button" className="btn" onClick={props.onMyPosts}>My posts</button>
        <button type="button" className="btn" onClick={() => setVerify(true)}>Apply for creator verification</button>
      </footer>}
      {edit && <EditForm profile={p} port={port} onCancel={() => setEdit(false)} onDone={(n) => { setProfile(n); setEdit(false); }} />}
      {verify && <VerifyDialog port={port} defaultName={p.name} defaultLink={p.links[0] ?? ''} onClose={() => { setVerify(false); reload(); }} />}
    </div>
  </VotesProvider>;
}
