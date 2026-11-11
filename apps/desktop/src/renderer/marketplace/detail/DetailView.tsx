import { useEffect, useRef, useState } from 'react';
import type { PublicItemPayload } from '@pom/mastery-contracts';
import { Icon } from '../../ui.js';
import { knownLabel, stampLines } from '../../documents/model.js';
import { CreatorLine, ListingFacts, SharePopover } from '../feed/FeedCard.js';
import { VotePair, useVotes } from '../VoteControls.js';
import { useSaveToggle } from '../useSaveToggle.js';
import { isOldLeague, kindLabel, leagueName, versionList } from '../presenter.js';
import type { MarketplaceProps } from '../services.js';
import { BuildDetail } from './BuildDetail.js';
import { AtlasDetail } from './AtlasDetail.js';
import { TimelineDetail } from './TimelineDetail.js';
import { LatestRevision } from './shared.js';

export type DetailActions = { editCopy: () => void; run: () => void; send: () => void; busy: string | null; note: string };
export function DetailView({ props, initial, onBack }: { props: MarketplaceProps; initial: PublicItemPayload; onBack: () => void }) {
  const { services, viewer, online } = props;
  const votes = useVotes(), votesRef = useRef(votes); votesRef.current = votes;
  const [item, setItem] = useState(initial), [state, setState] = useState<{ status: 'ready' | 'loading' | 'error' | 'gone'; offline: boolean; cachedAt: string | null }>({ status: 'ready', offline: false, cachedAt: null });
  const saver = useSaveToggle(item, services, viewer.saved[initial.publicId], props.onSaved), saved = saver.saved, [busy, setBusy] = useState<string | null>(null), [note, setNote] = useState(''), [sharing, setSharing] = useState(false);
  const share = useRef<HTMLButtonElement>(null), heading = useRef<HTMLHeadingElement>(null);
  const latest = initial.publishedRevision.displayRevision as number, shownRevision = item.publishedRevision.displayRevision as number;
  useEffect(() => { heading.current?.focus(); }, []);
  // Refresh the newest version in the background; cached detail stays readable offline.
  useEffect(() => {
    let live = true;
    services.item({ publicId: initial.publicId }).then(r => {
      if (!live) return;
      // A detail read's votes carry the post's vote revision: the highest revision wins in the vote store.
      if (r.result.ok) { votesRef.current.observe([r.result.value]); setItem(r.result.value); setState({ status: 'ready', offline: r.offline, cachedAt: r.cachedAt }); }
      else if (r.result.code === 'UNAVAILABLE' && !r.offline) setState({ status: 'gone', offline: false, cachedAt: null });
      else setState(s => ({ ...s, offline: r.offline }));
    }, () => undefined);
    return () => { live = false; };
  }, [initial.publicId]);
  const selectRevision = async (revision: number) => {
    if (revision === shownRevision) return;
    setState(s => ({ ...s, status: 'loading' }));
    try {
      const r = await services.item({ publicId: initial.publicId, revision });
      if (r.result.ok) { setItem(r.result.value); setState({ status: 'ready', offline: r.offline, cachedAt: r.cachedAt }); } else setState(s => ({ ...s, status: 'error' }));
    } catch { setState(s => ({ ...s, status: 'error' })); }
  };
  const act = async (name: string, fn: () => Promise<void>) => { setBusy(name); setNote(''); try { await fn(); } catch { setNote('That did not work. Try again.'); } finally { setBusy(null); } };
  const actions: DetailActions = {
    busy, note,
    editCopy: () => void act('copy', async () => { props.onOpenCopy(await services.editCopy(item)); }),
    run: () => void act('run', async () => { const r = await services.run(item, 'detail'); if (r.status === 'blocked') setNote(r.reason); }),
    send: () => props.onSendToTimeline(item),
  };
  const old = isOldLeague(item.stamp, viewer.activeLeague), name = leagueName(item.stamp);
  if (state.status === 'gone') return <section className="mp-detail"><button type="button" className="btn" onClick={onBack}><Icon name="chevron-right" style={{ transform: 'rotate(180deg)' }} /> Back</button><p className="mp-empty">This item is unavailable.</p></section>;
  const body = item.document.kind === 'build' ? <BuildDetail item={item} document={item.document} props={props} actions={actions} onSelectRevision={selectRevision} />
    : item.document.kind === 'atlas' ? <AtlasDetail item={item} document={item.document} props={props} actions={actions} onSelectRevision={selectRevision} />
    : <TimelineDetail item={item} document={item.document} props={props} actions={actions} onSelectRevision={selectRevision} />;
  return <section className="mp-detail" aria-label={item.title}>
    <header className="mp-detail-head">
      <nav className="mp-crumbs" aria-label="Breadcrumb"><button type="button" className="mp-link" onClick={onBack}>Marketplace</button> / <span>{item.title}</span></nav>
      <span className="mp-league">{name} / Version {shownRevision}{item.document.kind === 'atlas' ? ` / ${item.document.payload.dataset.datasetId}` : ''}</span>
    </header>
    <div className="mp-detail-title"><VotePair item={item} /><div><h1 tabIndex={-1} ref={heading} title={item.title}>{item.title}</h1><CreatorLine item={item} onCreator={props.onCreator} />
      <small className="mp-kind">{kindLabel(item)}</small><ListingFacts item={item} openVideo={services.openExternal} /></div>
      <div className="mp-row-actions">
        <button type="button" className="btn" aria-pressed={saved} disabled={saver.busy} onClick={() => void saver.toggle()}>{saved ? 'Saved' : 'Save'}</button>
        <button type="button" ref={share} className="btn" aria-haspopup="dialog" aria-expanded={sharing} onClick={() => setSharing(!sharing)}><Icon name="share" /> Share</button>
        <button type="button" className="btn" onClick={() => props.onReport(item)}>Report</button></div>
      <SharePopover item={item} services={services} anchor={share} open={sharing} onClose={() => { setSharing(false); share.current?.focus(); }} /></div>
    {state.offline && <p className="mp-banner" role="status">Offline. Showing saved details{state.cachedAt ? ` from ${new Date(state.cachedAt).toLocaleString()}` : ''}.</p>}
    {!online && !state.offline && <p className="mp-banner" role="status">Offline. Local copies and Runs still work.</p>}
    {old && <p className="mp-banner">Saved for {name}. {props.onCopyToLeague && <button type="button" className="btn" onClick={() => props.onCopyToLeague?.(item)}>Copy to {viewer.activeLeague}</button>}</p>}
    {shownRevision !== latest && state.status !== 'loading' && <p className="mp-banner" role="status">You are viewing version {shownRevision}. The newest is version {latest}. <button type="button" className="btn" onClick={() => void selectRevision(latest)}>Show newest</button></p>}
    {state.status === 'error' && <p className="mp-banner" role="alert">Could not load that version. <button type="button" className="btn" onClick={() => void selectRevision(shownRevision)}>Retry</button></p>}
    {state.status === 'loading' && <p className="mp-note" role="status">Updating...</p>}
    <LatestRevision.Provider value={latest}>{body}</LatestRevision.Provider>
    <footer className="mp-detail-foot">
      {item.document.kind === 'timeline' && <button type="button" className="btn primary" disabled={busy === 'run'} onClick={actions.run}>Run this timeline</button>}
      <button type="button" className="btn" disabled={busy === 'copy'} onClick={actions.editCopy}>Edit a copy</button>
      {item.document.kind === 'atlas' && props.onCompare && <button type="button" className="btn" onClick={() => props.onCompare?.(item)}>Compare with my plan</button>}
      <button type="button" className="btn" onClick={actions.send}>Send to timeline</button>
      <span className="mp-credits" title={stampLines(item.stamp).join('\n')}>{item.credits.length ? item.credits.map(c => c.status === 'original_removed' ? 'Original removed' : `Copied from ${c.title} by ${c.creatorName}`).join(' / ') : `Source data ${knownLabel(item.stamp.datasetVersion)}`}</span>
      {(note || saver.note) && <p className="mp-note" role="status">{note || saver.note}</p>}
    </footer>
  </section>;
}
export { versionList };
