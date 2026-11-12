import { useState } from 'react';
import type { PublicItemPayload } from '@pom/mastery-contracts';
import type { ViewerState } from '../presenter.js';
import type { MarketplaceServices } from '../services.js';
import { CreatorProfile } from './CreatorProfile.js';
import { Inbox } from './Inbox.js';
import { MyPosts } from './MyPosts.js';
import type { CreatorPort } from './port.js';
import type { OwnPost } from './presenter.js';
import '../marketplace.css';
import './creator.css';

export type CreatorView = { view: 'profile'; who: { name: string; publicId?: string } | { own: true } } | { view: 'mine' } | { view: 'inbox' };
export type CreatorAreaProps = {
  port: CreatorPort; services: MarketplaceServices; viewer: ViewerState; account: string | null; leagues: { id: string; label: string }[];
  initial: CreatorView;
  /** Called when the person leaves to something this package does not own. */
  onBack(): void; onOpen(item: PublicItemPayload): void; onReport(creator: { id: string; name: string }): void; onSignIn(): void;
  onEditPost(post: OwnPost): void; onViewPost(post: OwnPost): void; onNewPost(): void;
};
/** Profile, verification (dialog), My posts and analytics, inbox. Data only through the injected CreatorPort. */
export function CreatorArea(p: CreatorAreaProps) {
  const [stack, setStack] = useState<CreatorView[]>([p.initial]);
  const now = stack[stack.length - 1]!;
  const push = (v: CreatorView) => setStack((s) => [...s, v]);
  const pop = () => (stack.length > 1 ? setStack((s) => s.slice(0, -1)) : p.onBack());
  if (now.view === 'mine') return <MyPosts port={p.port} onBack={pop} onInbox={() => push({ view: 'inbox' })} onEdit={p.onEditPost} onView={p.onViewPost} onNewPost={p.onNewPost} />;
  if (now.view === 'inbox') return <Inbox port={p.port} account={p.account} onBack={pop} />;
  return <CreatorProfile port={p.port} services={p.services} viewer={p.viewer} who={now.who} leagues={p.leagues} onBack={pop} onOpen={p.onOpen}
    onReport={p.onReport} onMyPosts={() => push({ view: 'mine' })} onSignIn={p.onSignIn} />;
}
