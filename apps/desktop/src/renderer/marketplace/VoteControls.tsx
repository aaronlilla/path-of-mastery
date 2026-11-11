import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { PostId, PublicItemPayload } from '@pom/mastery-contracts';
import { Icon } from '../ui.js';
import { VoteStore, voteAria, voteBlock, voteOutcome, type Direction, type ViewerState, type VoteShown } from './presenter.js';
import type { MarketplaceServices } from './services.js';

/** The Marketplace's one vote store (presenter.ts VoteStore): every card and detail page reads it; feeds write server counts into it. */
export type VotesApi = {
  shown(postId: string, counted: Direction, fallbackNet: number): VoteShown;
  click(postId: PostId, d: 1 | -1, counted: Direction): void;
  retry(postId: PostId): void;
  /** Server counts from a feed page or a detail read; each item's votes carry the revision they were read at. */
  observe(items: readonly PublicItemPayload[]): void;
  viewer: ViewerState; online: boolean; signIn(): void;
};
const Votes = createContext<VotesApi | null>(null);
export function VotesProvider({ services, viewer, online, onSignIn, children }: { services: MarketplaceServices; viewer: ViewerState; online: boolean; onSignIn: () => void; children: ReactNode }) {
  const [version, tick] = useState(0);
  const latest = useRef(services); latest.current = services;
  const store = useMemo(() => new VoteStore(async (postId, direction) => voteOutcome(await latest.current.vote(postId, direction)), () => tick(n => n + 1)), []);
  const live = useRef({ viewer, onSignIn }); live.current = { viewer, onSignIn };
  const signedIn = useRef(viewer.signedIn);
  useEffect(() => { if (signedIn.current !== viewer.signedIn) { signedIn.current = viewer.signedIn; store.reset(); } }, [viewer.signedIn, store]);
  // Continue after a passed check resent a paused vote; its answer goes through the vote store (mastery/HumanCheckDialog.tsx RESUMED_EVENT).
  useEffect(() => {
    const onResumed = (e: Event) => {
      const d = (e as CustomEvent<{ operation?: string; body?: { request?: { postId?: unknown } }; entry?: unknown }>).detail;
      const postId = d?.body?.request?.postId;
      if (d?.operation === 'vote' && typeof postId === 'string' && d.entry && typeof d.entry === 'object') store.settle(postId, voteOutcome(d.entry as Parameters<typeof voteOutcome>[0]));
    };
    window.addEventListener('pom-network-resumed', onResumed);
    return () => window.removeEventListener('pom-network-resumed', onResumed);
  }, [store]);
  const api = useMemo<VotesApi>(() => ({
    shown: (postId, counted, fallbackNet) => store.shown(postId, counted, fallbackNet),
    click: (postId, d, counted) => { if (!live.current.viewer.signedIn) { live.current.onSignIn(); return; } void store.click(postId, d, counted); },
    retry: postId => { void store.retry(postId); },
    observe: items => store.observeItems(items),
    viewer, online, signIn: onSignIn,
  }), [store, viewer, online, onSignIn, version]);
  return <Votes.Provider value={api}>{children}</Votes.Provider>;
}
export const useVotes = () => { const v = useContext(Votes); if (!v) throw new Error('VotesProvider missing.'); return v; };

/** Upvote, net, Downvote. Arrow buttons are 32 px; the selected direction is announced. Everything shown comes from the vote store. */
export function VotePair({ item, compact }: { item: PublicItemPayload; compact?: boolean }) {
  const api = useVotes(), postId = item.publishedRevision.postId;
  const shown = api.shown(postId, api.viewer.votes[postId] ?? 0, item.votes.net);
  const block = voteBlock(api.viewer, postId, !api.online);
  const net = shown.net, selected = shown.selected;
  const [announce, setAnnounce] = useState('');
  useEffect(() => { setAnnounce(shown.state === 'pending_count' ? `Vote pending. It counts at ${shown.countAt ? new Date(shown.countAt).toLocaleString() : 'a later time'}.` : shown.message ?? ''); }, [shown.state, shown.message, shown.countAt]);
  const press = (d: 1 | -1) => api.click(postId, d, shown.counted);
  return <div className={'mp-vote' + (compact ? ' compact' : '')} role="group" aria-label={`Votes for ${item.title}`}>
    <button type="button" className="mp-vote-btn" data-selected={selected === 1} aria-pressed={selected === 1} aria-label={voteAria('Upvote', selected)} title={block.reason ?? 'Upvote'} disabled={block.disabled} onClick={() => press(1)}><Icon name="chevron-up" size={16} /></button>
    <strong className="mp-vote-net" aria-label={`${net} net votes`}>{net}</strong>
    <button type="button" className="mp-vote-btn" data-selected={selected === -1} aria-pressed={selected === -1} aria-label={voteAria('Downvote', selected)} title={block.reason ?? 'Downvote'} disabled={block.disabled} onClick={() => press(-1)}><Icon name="chevron-down" size={16} /></button>
    {shown.state === 'pending_count' && <small className="mp-vote-note">Pending{shown.countAt ? ` until ${new Date(shown.countAt).toLocaleString()}` : ''}</small>}
    {shown.state === 'error' && <small className="mp-vote-note" role="alert">{shown.message} {shown.retryable && <button type="button" className="btn" onClick={() => api.retry(postId)}>Retry</button>}</small>}
    <span className="mp-sr" role="status">{announce}</span>
  </div>;
}
