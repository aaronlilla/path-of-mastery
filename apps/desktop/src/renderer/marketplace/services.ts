import type { AssetRef, DatasetRef, LeagueStamp, PostId, PublicItemPayload, ResolvePublicItemRequest } from '@pom/mastery-contracts';
import type { CachedRead } from '../../main/marketplace/reads.js';
import type { SavedReference } from '../../main/marketplace/cache.js';
import type { OutboxEntry } from '../../main/marketplace/outbox.js';
import type { Direction, FeedQueryOut, ViewerState } from './presenter.js';
import type { CanvasModel } from '../atlas/canvas/index.js';
import type { AtlasGraph } from '../../shared/atlas/graph.js';
import type { CatalogEntry } from '@pom/mastery-contracts';
import type { ReactNode } from 'react';

export type FeedPage = { items: PublicItemPayload[]; nextCursor: string | null };
export type FollowRow = { creatorId: string; name: string; verified: boolean; following: boolean };
export type RunStart = { status: 'started' } | { status: 'blocked'; reason: string };
/** `objectId` is the Saved reference of the pinned revision; `payload` is that revision (the host makes the owned copy from it). */
export type CopyTarget = { kind: 'build' | 'atlas' | 'timeline'; objectId: string; payload?: PublicItemPayload };
export type AtlasDetailData = { model: CanvasModel | null; graph: AtlasGraph | null; catalogs: { maps: CatalogEntry[]; scarabs: CatalogEntry[] } };

/**
 * Everything the Marketplace screens do goes through this port. Read methods mirror MarketplaceReads (feed, count, item);
 * vote, save and remove map one to one onto the marketplace client calls. The app shell supplies the real adapter.
 * No method here edits a source: only editCopy forks one, and only when the person presses Edit a copy.
 */
export type MarketplaceServices = {
  feed(query: FeedQueryOut & { limit?: number }): Promise<CachedRead<FeedPage>>;
  count(query: FeedQueryOut): Promise<CachedRead<{ total: number; timeBasis: string }>>;
  item(request: ResolvePublicItemRequest): Promise<CachedRead<PublicItemPayload>>;
  vote(postId: PostId, direction: Direction): Promise<OutboxEntry>;
  save(payload: PublicItemPayload): Promise<SavedReference>;
  /** Takes the personal reference off (the source post is unaffected); undoUnsave puts it back with its collections. */
  unsave?(objectId: string): Promise<void>;
  undoUnsave?(objectId: string): Promise<void>;
  /** Saves (or reuses) the reference and starts a ready, pinned Run. Never touches the active Build. */
  run(payload: PublicItemPayload, from: 'feed' | 'detail'): Promise<RunStart>;
  /** Forks the pinned source into an owned local object. The only call that creates editable content. */
  editCopy(payload: PublicItemPayload): Promise<CopyTarget>;
  share(payload: PublicItemPayload): Promise<{ url: string }>;
  copyText(text: string): Promise<boolean>;
  openExternal(url: string): void;
  assetUrl?(asset: AssetRef): string | undefined;
  atlasData?(dataset: DatasetRef): Promise<AtlasDetailData>;
  follows?: { list(): Promise<FollowRow[]>; set(creatorId: string, follow: boolean): Promise<void>; dot: boolean; setDot(on: boolean): Promise<void> };
};
export type MarketplaceProps = {
  services: MarketplaceServices;
  viewer: ViewerState;
  online: boolean;
  /** The active league stamp; archive leagues come from `leagues`. */
  league: LeagueStamp;
  leagues: { name: string; stamp: LeagueStamp }[];
  /** Run, Report, Publish and the other areas are owned elsewhere. */
  onSignIn(): void;
  onPublish(): void;
  onNavigate(to: 'saved' | 'mine'): void;
  onReport(payload: PublicItemPayload): void;
  onCreator(name: string, publicId?: string): void;
  onOpenCopy(target: CopyTarget): void;
  onSendToTimeline(payload: PublicItemPayload): void;
  onCompare?(payload: PublicItemPayload): void;
  onCopyToLeague?(payload: PublicItemPayload): void;
  onSaved?(reference: SavedReference): void;
  /** Optional read-only passive tree for Build detail; the existing tree renderer is injected by the shell. */
  buildTree?(snapshot: Extract<PublicItemPayload['document'], { kind: 'build' }>['payload']): ReactNode;
  /** Open an item directly (deep link) */
  initialPublicId?: string;
  pollMs?: number;
};
