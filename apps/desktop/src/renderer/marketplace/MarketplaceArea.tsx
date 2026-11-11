import { useEffect, useRef, useState } from 'react';
import type { PublicItemPayload } from '@pom/mastery-contracts';
import type { FeedScope } from './presenter.js';
import type { MarketplaceProps } from './services.js';
import { VotesProvider } from './VoteControls.js';
import { FeedView } from './feed/FeedView.js';
import { DetailView } from './detail/DetailView.js';
import '../atlas/editor/editor.css';
import './marketplace.css';

/**
 * Marketplace feed, archive, Following and the three item details.
 * Each visited feed stays mounted so Back returns to the same rows, cursor, sort, filters and scroll.
 */
export function MarketplaceArea(props: MarketplaceProps) {
  const [scope, setScope] = useState<FeedScope>('current'), [visited, setVisited] = useState<FeedScope[]>(['current']);
  const [detail, setDetail] = useState<PublicItemPayload | null>(null), [focusKey, setFocusKey] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null), scrolls = useRef<Record<string, number>>({});
  const open = (item: PublicItemPayload) => { scrolls.current[scope] = root.current?.scrollTop ?? 0; setFocusKey(item.publicId); setDetail(item); };
  const back = () => { setDetail(null); };
  const go = (next: FeedScope) => { scrolls.current[scope] = root.current?.scrollTop ?? 0; setScope(next); setVisited(v => v.includes(next) ? v : [...v, next]); };
  useEffect(() => { if (!detail && root.current) root.current.scrollTop = scrolls.current[scope] ?? 0; else if (root.current) root.current.scrollTop = 0; }, [detail, scope]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (detail && e.altKey && e.key === 'ArrowLeft' && !(e.target as HTMLElement).matches('input,textarea')) { e.preventDefault(); back(); } };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [detail]);
  useEffect(() => {
    // Area shortcut (Ctrl+F): while the Marketplace is the visible area, Ctrl+F from anywhere outside it (the top-bar button
    // just clicked, empty space) goes to the visible feed's search, or the open detail's search. Inside the area the feed's own onKeyDown
    // handles it; text fields and dialogs keep their own Ctrl+F.
    const onKey = (event: KeyboardEvent) => {
      const area = root.current, target = event.target as HTMLElement | null;
      if (!area || !(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== 'f') return;
      if (!area.getClientRects().length || area.contains(target) || document.querySelector('[role="dialog"]')) return;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target?.isContentEditable) return;
      const search = area.querySelector<HTMLInputElement>('.mp-detail input.mp-input') ?? area.querySelector<HTMLInputElement>('.mp-feed:not([hidden]) .mp-search input');
      if (!search) return;
      event.preventDefault(); search.focus(); search.select();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (!props.initialPublicId) return;
    let live = true;
    props.services.item({ publicId: props.initialPublicId as never }).then(r => { if (live && r.result.ok) setDetail(r.result.value); }, () => undefined);
    return () => { live = false; };
  }, [props.initialPublicId]);
  return <VotesProvider services={props.services} viewer={props.viewer} online={props.online} onSignIn={props.onSignIn}>
    <div className="mp-area" ref={root} data-detail={!!detail || undefined}>
      {visited.map(s => <FeedView key={s} props={props} scope={s} active={!detail && s === scope} focusKey={focusKey} onOpen={open} onScope={go} />)}
      {detail && <DetailView key={detail.publicId} props={props} initial={detail} onBack={back} />}
    </div>
  </VotesProvider>;
}
