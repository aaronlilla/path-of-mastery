import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FEED_FILTER_LIMITS, type PublicItemPayload } from '@pom/mastery-contracts';
import { Icon, PortalMenu, Segmented, Select } from '../../ui.js';
import { appendPage, buildQuery, skillCatalog, current, emptyMessage, feedTypes, filterChips, filterCount, initialFeedState, leagueName, offlineText, emptyPaged, reconcile, refreshLabel, setFilters, setSearch, setSort, setType, emptyFilters,
  type FeedScope, type FeedState, type PagedFeed, type Reconcile } from '../presenter.js';
import { primarySorts, sortExplanation, sortLabels, windowLabels, windowOrder, type FeedSort, type TopWindow } from '../ranking.js';
import type { MarketplaceProps } from '../services.js';
import { FeedCard } from './FeedCard.js';
import { FiltersDrawer } from './FiltersDrawer.js';
import { useVotes } from '../VoteControls.js';

import { FollowManage } from './FollowManage.js';

type Load = { status: 'loading' | 'ready' | 'error'; offline: boolean; cachedAt: string | null; reason?: string };
export function FeedView({ props, scope, active, focusKey, onOpen, onScope }: { props: MarketplaceProps; scope: FeedScope; active: boolean; focusKey: string | null; onOpen: (item: PublicItemPayload) => void; onScope: (scope: FeedScope) => void }) {
  const { services, viewer, online } = props;
  const votes = useVotes(), votesRef = useRef(votes); votesRef.current = votes;
  const [state, setStateRaw] = useState<FeedState>(() => ({ ...initialFeedState(scope), archiveLeague: scope === 'archive' ? props.leagues[1]?.name ?? null : null }));
  const [paged, setPaged] = useState<PagedFeed>(emptyPaged);
  const [load, setLoad] = useState<Load>({ status: 'loading', offline: false, cachedAt: null });
  const [applied, setApplied] = useState(''), [drawer, setDrawer] = useState(false), [sortHelp, setSortHelp] = useState(false), [manage, setManage] = useState(false);
  const [pending, setPending] = useState<Reconcile['pending']>(null), [more, setMore] = useState(false), [tick, setTick] = useState(0);
  const holding = useRef(false), searchBox = useRef<HTMLInputElement>(null), helpButton = useRef<HTMLButtonElement>(null), list = useRef<HTMLDivElement>(null);
  const pagedRef = useRef(paged); pagedRef.current = paged;
  const seenSkills = useRef(new Map<string, string>()); // skill id -> name for the Skill filter and its chips
  const setState = useCallback((next: FeedState) => setStateRaw(next), []);
  const league = useMemo(() => state.archiveLeague ? props.leagues.find(l => l.name === state.archiveLeague)?.stamp ?? props.league : props.league, [state.archiveLeague, props.leagues, props.league]);
  const name = leagueName(league), tab = current(state);
  const chips = filterChips(tab.filters, state.type, seenSkills.current), filtered = filterCount(tab.filters, state.type) > 0;
  // Search is debounced 250 ms; Enter applies at once.
  useEffect(() => { const t = setTimeout(() => setApplied(tab.search), 250); return () => clearTimeout(t); }, [tab.search]);
  useEffect(() => { setApplied(tab.search); }, [state.type]);
  const queryState = useMemo(() => setSearch(state, applied), [state.scope, state.type, state.sort, state.window, state.tabs, applied]);
  const queryKey = JSON.stringify(buildQuery(queryState, league, null));
  useEffect(() => {
    if (scope === 'following' && !viewer.signedIn) { setLoad({ status: 'ready', offline: false, cachedAt: null }); setPaged(emptyPaged()); return; }
    let live = true; setLoad(l => ({ ...l, status: 'loading' })); setPending(null);
    services.feed(buildQuery(queryState, league, null)).then(r => {
      if (!live) return;
      if (r.result.ok) { votesRef.current.observe(r.result.value.items); setPaged(appendPage(emptyPaged(), null, r.result.value.items, r.result.value.nextCursor)); setLoad({ status: 'ready', offline: r.offline, cachedAt: r.cachedAt }); }
      else setLoad(l => ({ status: 'error', offline: r.offline, cachedAt: null, reason: r.result.ok ? '' : r.result.message, ...(pagedRef.current.items.length ? { cachedAt: l.cachedAt } : {}) }));
    }, () => { if (live) setLoad(l => ({ ...l, status: 'error', reason: 'The feed is unavailable right now.' })); });
    return () => { live = false; };
  }, [queryKey, tick, viewer.signedIn]);
  // New results never reorder rows under the pointer. New posts always wait for Refresh.
  useEffect(() => {
    if (!online || !active) return;
    const timer = setInterval(() => {
      services.feed(buildQuery(queryState, league, null)).then(r => {
        if (!r.result.ok || r.offline) return;
        votesRef.current.observe(r.result.value.items); // higher-revision counts show at once, even while the order waits for Refresh
        const incoming = r.result.value.items, shown = pagedRef.current.items.slice(0, incoming.length);
        const decision = reconcile(shown.length === incoming.length ? shown : pagedRef.current.items, incoming, holding.current);
        if (decision.apply) setPaged(appendPage(emptyPaged(), null, incoming, r.result.value.nextCursor));
        setPending(decision.pending);
      }, () => undefined);
    }, props.pollMs ?? 30000);
    return () => clearInterval(timer);
  }, [queryKey, online, active, props.pollMs]);
  useEffect(() => { if (active && focusKey) list.current?.querySelector<HTMLElement>(`[data-public-id="${focusKey}"] .mastery-card-open`)?.focus(); }, [active, focusKey]);
  const loadMore = async () => {
    if (!paged.next || more) return;
    setMore(true);
    try { const cursor = paged.next, r = await services.feed(buildQuery(queryState, league, cursor));
      if (r.result.ok) votesRef.current.observe(r.result.value.items);
      if (r.result.ok) setPaged(p => appendPage(p, cursor, r.result.ok ? r.result.value.items : [], r.result.ok ? r.result.value.nextCursor : null)); else setLoad(l => ({ ...l, status: 'error', reason: r.result.ok ? '' : r.result.message })); }
    catch { setLoad(l => ({ ...l, status: 'error', reason: 'The feed is unavailable right now.' })); } finally { setMore(false); }
  };
  // Skill ids seen in any page stay in the catalog (id -> name), so choosing one skill never hides the others.
  const skills = useMemo(() => new Map(skillCatalog(paged.items, seenSkills.current)), [paged.items]);
  // Tags seen in any page this feed loaded stay in the list, so choosing one tag never hides the others.
  const seenTags = useRef(new Map<string, string>());
  const tags = useMemo(() => {
    for (const t of paged.items.flatMap(i => i.listing?.tags ?? [])) if (!seenTags.current.has(t.toLocaleLowerCase())) seenTags.current.set(t.toLocaleLowerCase(), t);
    return [...seenTags.current.values()];
  }, [paged.items]);
  const empty = !paged.items.length && load.status === 'ready';
  const explanation = sortExplanation(state.sort, state.window, name);
  const msg = emptyMessage(state, name, filtered || !!state.archiveLeague && false);
  const title = scope === 'following' ? `Following / ${name}` : scope === 'archive' ? 'Marketplace archive' : 'Marketplace';
  const archivePick = scope === 'archive';
  const sortOptions = (['hot', 'top', 'new', 'old', 'rising'] as FeedSort[]).map(v => ({ value: v, label: sortLabels[v] }));
  return <section className="mp-feed" hidden={!active} aria-label={title} onKeyDown={e => {
    const target = e.target as HTMLElement;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); searchBox.current?.focus(); return; }
    if (target.matches('input,textarea,select')) return;
    const cards = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('.mastery-card-open')], i = cards.indexOf(target as HTMLButtonElement);
    if (i >= 0 && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) { e.preventDefault(); cards[Math.max(0, Math.min(cards.length - 1, i + (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1)))]?.focus(); }
  }}>
    <div className="mp-feed-main">
      <header className="mp-head"><div><h1>{title}</h1><span className="mp-league">{name}</span></div>
        <div className="mp-head-actions">
          {scope === 'current' && <><button type="button" className="btn" onClick={() => onScope('archive')}>Archive</button><button type="button" className="btn" onClick={() => props.onNavigate('saved')}>Saved</button><button type="button" className="btn" onClick={() => onScope('following')}>Following</button></>}
          {scope !== 'current' && <button type="button" className="btn" onClick={() => onScope('current')}>Current league</button>}
          {scope === 'following' && <><button type="button" className="btn" aria-pressed={!manage} onClick={() => setManage(false)}>All posts</button><button type="button" className="btn" aria-pressed={manage} onClick={() => setManage(true)}>Manage follows</button></>}
          {scope === 'current' && <button type="button" className="btn" onClick={() => props.onNavigate('mine')}>My posts</button>}
          {scope === 'current' && <button type="button" className="btn primary" onClick={props.onPublish}>Publish</button>}
        </div></header>
      {archivePick && <><p className="mp-note">Saved for {name}. Game data versions are shown on each item.</p>
        <Select ariaLabel="Archive league" width={260} value={state.archiveLeague ?? ''} options={props.leagues.slice(1).map(l => ({ value: l.name, label: l.name }))} onChange={v => setState({ ...state, archiveLeague: v })} /></>}
      {manage && scope === 'following' && services.follows ? <FollowManage follows={services.follows} onClose={() => setManage(false)} onBrowse={() => onScope('current')} /> : <>
        <Segmented ariaLabel="Type" value={state.type} onChange={v => setState(setType(state, v))} options={feedTypes} />
        <div className="mp-toolbar">
          <label className="mp-search"><Icon name="search" /><input ref={searchBox} className="mp-input" maxLength={FEED_FILTER_LIMITS.searchLength} aria-label="Search titles, skills, creators or descriptions..." placeholder="Search titles, skills, creators or descriptions..." value={tab.search}
            onChange={e => setState(setSearch(state, e.target.value))} onKeyDown={e => { if (e.key === 'Enter') setApplied(tab.search); if (e.key === 'Escape' && tab.search) { e.stopPropagation(); setState(setSearch(state, '')); setApplied(''); } }} />
            {tab.search && <button type="button" className="icon-btn" aria-label="Clear search" onClick={() => { setState(setSearch(state, '')); setApplied(''); searchBox.current?.focus(); }}><Icon name="x" /></button>}</label>
          <button type="button" className="btn" aria-expanded={drawer} onClick={() => setDrawer(!drawer)}><Icon name="sliders" /> Filters{filterCount(tab.filters, state.type) ? ` ${filterCount(tab.filters, state.type)}` : ''}</button>
        </div>
        <div className="mp-toolbar">
          <Segmented ariaLabel="Sort" value={primarySorts.includes(state.sort) ? state.sort : ('' as FeedSort)} onChange={v => setState(setSort(state, v))} options={primarySorts.map(v => ({ value: v, label: sortLabels[v] }))} />
          <Select ariaLabel="Sort menu" width={130} value={state.sort} options={sortOptions} onChange={v => setState(setSort(state, v))} />
          {state.sort === 'top' && <Select ariaLabel="Top timeframe" width={170} value={state.window} options={windowOrder.map(w => ({ value: w, label: windowLabels[w] }))} onChange={(w: TopWindow) => setState(setSort(state, 'top', w))} />}
          <Segmented ariaLabel="View" value={state.view} onChange={v => setState({ ...state, view: v })} options={[{ value: 'grid', label: 'Grid' }, { value: 'list', label: 'List' }]} />
          <button type="button" ref={helpButton} className="btn" aria-haspopup="dialog" aria-expanded={sortHelp} onClick={() => setSortHelp(!sortHelp)}><Icon name="info" /> How sorting works</button>
          <PortalMenu anchor={helpButton} open={sortHelp} onClose={() => { setSortHelp(false); helpButton.current?.focus(); }} role="dialog" label="How sorting works" minWidth={320}>
            <div className="mp-sorting"><strong>{explanation.title}</strong><p>{explanation.summary}</p>{explanation.formula && <code>{explanation.formula}</code>}<p className="mp-note">Time basis: {explanation.timeBasis}</p>
              <p className="mp-note">Votes and time are the only things that move a post. Identity and finished counts do not.</p></div></PortalMenu>
        </div>
        {(chips.length > 0 || state.archiveLeague && !archivePick) && <div className="mp-chips" aria-label="Active filters">{chips.map(c => <button type="button" key={c.id} className="mp-chip" aria-label={`Remove filter ${c.label}`} onClick={() => setState(setFilters(state, c.clear(tab.filters)))}>{c.label} <Icon name="x" size={12} /></button>)}
          {state.archiveLeague && !archivePick && <button type="button" className="mp-chip" aria-label={`Remove league ${state.archiveLeague}`} onClick={() => setState({ ...state, archiveLeague: null })}>League: {state.archiveLeague} <Icon name="x" size={12} /></button>}</div>}
        {load.offline && <p className="mp-banner" role="status">{offlineText(load.cachedAt)}</p>}
        {pending && <p className="mp-banner"><button type="button" className="btn" onClick={() => { setPending(null); setTick(t => t + 1); }}><Icon name="refresh" /> {refreshLabel(pending)}</button></p>}
        {load.status === 'error' && <p className="mp-banner" role="alert">Could not load the feed. {load.reason} <button type="button" className="btn" onClick={() => setTick(t => t + 1)}>Retry</button></p>}
        {load.status === 'loading' && !paged.items.length && <div className="mp-skeletons" aria-busy="true" aria-label="Loading">{[0, 1, 2, 3].map(i => <div key={i} className="mp-skeleton" />)}</div>}
        {load.status === 'loading' && paged.items.length > 0 && <p className="mp-note" role="status">Updating...</p>}
        {scope === 'following' && !viewer.signedIn && <p className="mp-empty">Sign in to see posts from creators you follow. <button type="button" className="btn primary" onClick={props.onSignIn}>Sign in</button></p>}
        {empty && !(scope === 'following' && !viewer.signedIn) && <div className="mp-empty"><p>{msg.text}</p><div className="mp-row-actions">
          {msg.actions.includes('clear') && <button type="button" className="btn" onClick={() => { setState({ ...setFilters(state, emptyFilters()), archiveLeague: null, tabs: { ...state.tabs, [state.type]: { search: '', filters: emptyFilters() } } }); setApplied(''); }}>Clear filters</button>}
          {msg.actions.includes('publish') && <button type="button" className="btn primary" onClick={props.onPublish}>Publish</button>}
          {msg.actions.includes('archive') && <button type="button" className="btn" onClick={() => onScope('archive')}>Browse archive</button>}
          {msg.actions.includes('browse') && <button type="button" className="btn" onClick={() => onScope('current')}>Browse Marketplace</button>}
        </div></div>}
        <div ref={list} className="mp-list" data-view={state.view} onPointerEnter={() => { holding.current = true; }} onPointerLeave={() => { holding.current = false; }}
          onFocus={() => { holding.current = true; }} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) holding.current = false; }}>
          {paged.items.map(item => <FeedCard key={item.publicId} item={item} view={state.view} viewer={viewer} services={services} online={online}
            onOpen={() => onOpen(item)} onCreator={props.onCreator} onSaved={props.onSaved} onSignIn={props.onSignIn} />)}
        </div>
        {paged.next && <div className="mp-more"><button type="button" className="btn" disabled={more} onClick={() => void loadMore()}>{more ? 'Loading...' : 'Load more'}</button></div>}
      </>}
    </div>
    {drawer && <FiltersDrawer props={props} state={state} setState={setState} stamp={league} skills={skills} tags={tags} onClose={() => setDrawer(false)} leagueValue={state.archiveLeague ?? ''} onLeague={n => setState({ ...state, archiveLeague: n })} />}
  </section>;
}
