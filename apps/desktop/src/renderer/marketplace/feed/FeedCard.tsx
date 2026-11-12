import { useRef, useState } from 'react';
import type { PublicItemPayload } from '@pom/mastery-contracts';
import { Icon, PortalMenu } from '../../ui.js';
import { ItemCard } from '../../documents/ItemCard.js';
import { cardFromPayload, listingLine, richText, type ViewerState } from '../presenter.js';
import type { MarketplaceServices } from '../services.js';
import { VotePair } from '../VoteControls.js';
import { useSaveToggle } from '../useSaveToggle.js';

export function SharePopover({ item, services, anchor, open, onClose }: { item: PublicItemPayload; services: MarketplaceServices; anchor: React.RefObject<HTMLElement | null>; open: boolean; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null), [error, setError] = useState(''), [copied, setCopied] = useState(false);
  const started = useRef<string | null>(null);
  if (open && started.current !== item.publicId) {
    started.current = item.publicId;
    services.share(item).then(r => setUrl(r.url), () => setError('Could not make a link. Try again.'));
  }
  if (!open && started.current) { started.current = null; if (url) setUrl(null); if (error) setError(''); if (copied) setCopied(false); }
  return <PortalMenu anchor={anchor} open={open} onClose={onClose} label="Share link" role="dialog" minWidth={300}>
    <div className="mp-share">
      <strong>Share this version</strong>
      <p className="mp-note">This link opens version {item.publishedRevision.displayRevision as number}.</p>
      {url ? <><input className="mp-input" readOnly aria-label="Pinned link" value={url} onFocus={e => e.currentTarget.select()} />
        <button type="button" className="btn" onClick={async () => setCopied(await services.copyText(url))}><Icon name="copy" /> {copied ? 'Copied' : 'Copy link'}</button></>
        : error ? <p role="alert">{error}</p> : <p role="status">Making link...</p>}
    </div>
  </PortalMenu>;
}

export function CreatorLine({ item, onCreator }: { item: PublicItemPayload; onCreator: (name: string, publicId?: string) => void }) {
  return <span className="mp-creator"><button type="button" className="mp-link" onClick={() => onCreator(item.creator.displayName, item.publicId)}>By {item.creator.displayName}</button>
    {item.creator.identityVerified && <span className="mp-verified" tabIndex={0} title="Identity verified. This does not verify the plan." aria-label="Verified creator. Identity verified. This does not verify the plan."><Icon name="check-circle" size={14} /> Verified creator</span>}
    <span className="mp-ver">Version {item.publishedRevision.displayRevision as number}</span></span>;
}

/** Class / mechanics / budget / League starter, the creator tags and a Has video link (opens the validated https link; the feed keeps its place). */
export function ListingFacts({ item, openVideo }: { item: PublicItemPayload; openVideo: (url: string) => void }) {
  const facts = listingLine(item), tags = item.listing?.tags ?? [], video = item.listing?.video ?? null;
  if (!facts.length && !tags.length && !video) return null;
  return <p className="mp-facts" data-listing="">
    {facts.length > 0 && <span className="mp-facts-line">{facts.join(' / ')}</span>}
    {tags.map(t => <span key={t} className="mp-tag">{t}</span>)}
    {video && <button type="button" className="mp-link mp-video" aria-label={`Has video. Open the video for ${item.title}`} title={video} onClick={() => openVideo(video)}><Icon name="play" size={12} /> Has video</button>}
  </p>;
}

export function FeedCard({ item, view, viewer, services, online, onOpen, onCreator, onSaved, onSignIn }: {
  item: PublicItemPayload; view: 'grid' | 'list'; viewer: ViewerState; services: MarketplaceServices; online: boolean;
  onOpen: () => void; onCreator: (name: string, publicId?: string) => void; onSaved?: (r: import('../../../main/marketplace/cache.js').SavedReference) => void; onSignIn: () => void;
}) {
  void online; void onSignIn;
  const toggle = useSaveToggle(item, services, viewer.saved[item.publicId], onSaved);
  const { saved } = toggle, busy = toggle.busy;
  const [note, setNote] = useState(''), [followed, setFollowed] = useState(false), [sharing, setSharing] = useState(false);
  const share = useRef<HTMLButtonElement>(null);
  const isTimeline = item.document.kind === 'timeline';
  const follow = async () => {
    setNote('');
    try {
      const r = await services.run(item, 'feed');
      if (r.status === 'started') { setFollowed(true); toggle.markSaved(); } else setNote(r.reason);
    } catch { setNote('Could not start the Run. Open the details to check what is missing.'); }
  };
  const description = richText(item.description);
  return <div className="mp-row" data-view={view} data-public-id={item.publicId}>
    <VotePair item={item} />
    <div className="mp-row-body">
      <ItemCard item={cardFromPayload(item, saved, services.assetUrl)} view={view} onOpen={onOpen}
        primary={isTimeline ? { label: followed || viewer.saved[item.publicId] ? 'Resume' : 'Follow', run: () => void follow() } : undefined} />
      <div className="mp-row-extra">
        <CreatorLine item={item} onCreator={onCreator} />
        <ListingFacts item={item} openVideo={services.openExternal} />
        {description && <p className="mp-desc">{description}</p>}
        <div className="mp-row-actions">
          <button type="button" className="btn" disabled={busy} aria-pressed={saved} onClick={() => void toggle.toggle()}>{saved ? 'Saved' : 'Save'}</button>
          <button type="button" ref={share} className="btn" aria-haspopup="dialog" aria-expanded={sharing} onClick={() => setSharing(!sharing)}><Icon name="share" /> Share</button>
        </div>
        {(note || toggle.note) && <p className="mp-note" role="status">{note || toggle.note}</p>}
      </div>
      <SharePopover item={item} services={services} anchor={share} open={sharing} onClose={() => { setSharing(false); share.current?.focus(); }} />
    </div>
  </div>;
}
