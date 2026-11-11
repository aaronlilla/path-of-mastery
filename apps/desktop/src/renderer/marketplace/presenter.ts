import { FEED_FILTER_LIMITS, isFeedSearch, isFeedSelection, isFeedTag, type AssetRef, type BudgetBand, type LeagueStamp, type PostId, type PublicItemPayload, type PublicRichText } from '@pom/mastery-contracts';
import type { ItemCardModel } from '../documents/model.js';
import { DEFAULT_SORT, DEFAULT_WINDOW, type FeedSort, type TopWindow } from './ranking.js';

export type FeedType = 'all' | 'build' | 'atlas' | 'timeline';
export const feedTypes: { value: FeedType; label: string }[] = [{ value: 'all', label: 'All' }, { value: 'build', label: 'Builds' }, { value: 'atlas', label: 'Atlas' }, { value: 'timeline', label: 'Timelines' }];
export type Direction = -1 | 0 | 1;
/** Filters. Budget, Tags and Has video read the post's listing metadata; Class (Builds) and Mechanics (Atlas) are derived at publish time. */
export type Filters = { economy: 'trade' | 'ssf' | null; hardcore: boolean; ruthless: boolean; skills: string[]; lanes: string[]; verifiedOnly: boolean;
  budget: BudgetBand | null; tags: string[]; hasVideo: boolean; classes: string[]; mechanics: string[] };
export const emptyFilters = (): Filters => ({ economy: null, hardcore: false, ruthless: false, skills: [], lanes: [], verifiedOnly: false, budget: null, tags: [], hasVideo: false, classes: [], mechanics: [] });
export const BUDGET_LABELS: Record<BudgetBand, string> = { not_stated: 'Not stated', cheap: 'Cheap', medium: 'Medium', expensive: 'Expensive' };
/** `mechanic:searing-exarch` -> `Searing Exarch`. */
export const mechanicName = (id: string) => id.replace(/^mechanic:/, '').split('-').map(w => w ? w[0]!.toUpperCase() + w.slice(1) : w).join(' ');
/** The Atlas mechanics with a verified taxonomy (resources/atlas packs), so the Mechanics list is complete even before posts use them. */
export const MECHANICS = ['abyss', 'atlas-memories', 'bestiary', 'betrayal', 'beyond', 'blight', 'breach', 'conquerors', 'delirium', 'delve', 'divination-cards', 'eater-of-worlds', 'essence',
  'expedition', 'harvest', 'heist', 'incursion', 'labyrinth', 'legion', 'maps', 'mercenaries', 'ritual', 'rogue-exiles', 'scarabs', 'searing-exarch', 'settlers-of-kalguur', 'shaper-and-elder',
  'shrines', 'strongboxes', 'synthesis', 'torment', 'ultimatum', 'vaal-side-areas'].map(m => `mechanic:${m}`);
/** Path of Exile 1 classes and ascendancies (the Class filter matches either). */
export const CLASSES = ['Duelist', 'Marauder', 'Ranger', 'Scion', 'Shadow', 'Templar', 'Witch', 'Ascendant', 'Assassin', 'Berserker', 'Champion', 'Chieftain', 'Deadeye', 'Elementalist', 'Gladiator',
  'Guardian', 'Hierophant', 'Inquisitor', 'Juggernaut', 'Necromancer', 'Occultist', 'Pathfinder', 'Raider', 'Saboteur', 'Slayer', 'Trickster', 'Warden'];
export type FeedScope = 'current' | 'archive' | 'following';
export type TabState = { search: string; filters: Filters };
export type FeedState = { scope: FeedScope; archiveLeague: string | null; type: FeedType; sort: FeedSort; window: TopWindow; view: 'grid' | 'list'; tabs: Record<FeedType, TabState> };
export const initialFeedState = (scope: FeedScope = 'current', type: FeedType = 'all'): FeedState => ({ scope, archiveLeague: null, type, sort: DEFAULT_SORT, window: DEFAULT_WINDOW, view: 'grid',
  tabs: { all: { search: '', filters: emptyFilters() }, build: { search: '', filters: emptyFilters() }, atlas: { search: '', filters: emptyFilters() }, timeline: { search: '', filters: emptyFilters() } } });
/** Type tabs keep their own search and filters; switching never clears another tab. */
export const setType = (s: FeedState, type: FeedType): FeedState => ({ ...s, type });
export const setSearch = (s: FeedState, search: string): FeedState => ({ ...s, tabs: { ...s.tabs, [s.type]: { ...s.tabs[s.type], search } } });
export const setFilters = (s: FeedState, filters: Filters): FeedState => ({ ...s, tabs: { ...s.tabs, [s.type]: { ...s.tabs[s.type], filters } } });
export const setSort = (s: FeedState, sort: FeedSort, window: TopWindow = s.window): FeedState => ({ ...s, sort, window });
export const current = (s: FeedState): TabState => s.tabs[s.type];
export type FilterField = 'mode' | 'skills' | 'classes' | 'mechanics' | 'lanes' | 'budget' | 'tags' | 'video' | 'verified';
/** All shows the common filters only (mode, budget, tags, video, verified); Skill and Class are Builds, Mechanics is Atlas, Included lanes is Timelines. */
export function filterFieldsFor(type: FeedType): FilterField[] {
  const common: FilterField[] = ['budget', 'tags', 'video', 'verified'];
  return type === 'build' ? ['mode', 'skills', 'classes', ...common] : type === 'atlas' ? ['mode', 'mechanics', ...common] : type === 'timeline' ? ['mode', 'lanes', ...common] : ['mode', ...common];
}
export type Chip = { id: string; label: string; clear: (f: Filters) => Filters };
/** `skillNames` maps the skill ids the Skill filter holds to their shown names (chips show the name). */
export function filterChips(filters: Filters, type: FeedType, skillNames: ReadonlyMap<string, string> = new Map()): Chip[] {
  const fields = filterFieldsFor(type), chips: Chip[] = [];
  if (fields.includes('mode')) {
    if (filters.economy) chips.push({ id: 'economy', label: filters.economy === 'trade' ? 'Trade' : 'SSF', clear: f => ({ ...f, economy: null }) });
    if (filters.hardcore) chips.push({ id: 'hardcore', label: 'Hardcore', clear: f => ({ ...f, hardcore: false }) });
    if (filters.ruthless) chips.push({ id: 'ruthless', label: 'Ruthless', clear: f => ({ ...f, ruthless: false }) });
  }
  if (fields.includes('skills')) for (const s of filters.skills) chips.push({ id: `skill:${s}`, label: `Skill: ${skillNames.get(s) ?? s}`, clear: f => ({ ...f, skills: f.skills.filter(x => x !== s) }) });
  if (fields.includes('lanes')) for (const l of filters.lanes) chips.push({ id: `lane:${l}`, label: `Lane: ${l}`, clear: f => ({ ...f, lanes: f.lanes.filter(x => x !== l) }) });
  if (fields.includes('classes')) for (const c of filters.classes) chips.push({ id: `class:${c}`, label: `Class: ${c}`, clear: f => ({ ...f, classes: f.classes.filter(x => x !== c) }) });
  if (fields.includes('mechanics')) for (const m of filters.mechanics) chips.push({ id: `mechanic:${m}`, label: `Mechanic: ${mechanicName(m)}`, clear: f => ({ ...f, mechanics: f.mechanics.filter(x => x !== m) }) });
  if (fields.includes('budget') && filters.budget) chips.push({ id: 'budget', label: `Budget: ${BUDGET_LABELS[filters.budget]}`, clear: f => ({ ...f, budget: null }) });
  if (fields.includes('tags')) for (const t of filters.tags) chips.push({ id: `tag:${t}`, label: `Tag: ${t}`, clear: f => ({ ...f, tags: f.tags.filter(x => x !== t) }) });
  if (fields.includes('video') && filters.hasVideo) chips.push({ id: 'video', label: 'Has video', clear: f => ({ ...f, hasVideo: false }) });
  if (fields.includes('verified') && filters.verifiedOnly) chips.push({ id: 'verified', label: 'Verified only', clear: f => ({ ...f, verifiedOnly: false }) });
  return chips;
}
export const filterCount = (filters: Filters, type: FeedType) => filterChips(filters, type).length;
/** The drawer's limit for every list filter: the one the site validates with (FEED_FILTER_LIMITS), so a request can never be refused. */
export const SELECTION_LIMIT = FEED_FILTER_LIMITS.selections;
export const LIMIT_NOTE = `Up to ${SELECTION_LIMIT}`;
/** Whether one more value can be chosen in a list filter (a chosen value can always be unchosen). */
export const canSelect = (list: readonly string[], value: string) => list.includes(value) || list.length < SELECTION_LIMIT;
/** The values of a list filter the site accepts, at most the limit (older saved state may hold more). */
const sent = (list: readonly string[], ok: (v: unknown) => boolean = isFeedSelection) => list.filter(ok).slice(0, SELECTION_LIMIT);
/** The Skill filter's catalog: skill id -> shown name, from build posts. The site matches skill ids, so the filter holds ids. */
export function skillCatalog(items: readonly PublicItemPayload[], into: Map<string, string> = new Map()): Map<string, string> {
  for (const i of items) if (i.document.kind === 'build') for (const s of i.document.payload.skills) if (isFeedSelection(s.skillId) && !into.has(s.skillId)) into.set(s.skillId, s.name);
  return into;
}
export function leagueName(stamp: LeagueStamp): string { return stamp.leagueId.status === 'known' ? stamp.leagueId.value : 'Unknown league'; }

export type FeedQueryOut = { query: { scope: LeagueStamp; type: FeedType; sort: FeedSort; window: TopWindow; search: string; cursor: string | null }; following?: boolean; verifiedOnly?: boolean; skills?: string[]; lanes?: string[];
  budgets?: BudgetBand[]; tags?: string[]; hasVideo?: boolean; classes?: string[]; mechanics?: string[] };
/** `league` is the active league stamp, or the chosen archive league's stamp. */
export function buildQuery(state: FeedState, league: LeagueStamp, cursor: string | null): FeedQueryOut {
  const tab = current(state), f = tab.filters, fields = filterFieldsFor(state.type);
  const scope: LeagueStamp = { ...league, mode: f.economy || f.hardcore || f.ruthless ? { status: 'known', value: { economy: f.economy ?? 'trade', hardcore: f.hardcore, ruthless: f.ruthless }, evidenceId: 'feed-filter' } : league.mode };
  const search = tab.search.trim();
  const out: FeedQueryOut = { query: { scope, type: state.type, sort: state.sort, window: state.window, search: isFeedSearch(search) ? search : [...search].slice(0, FEED_FILTER_LIMITS.searchLength).join(''), cursor } };
  if (state.scope === 'following') out.following = true;
  if (fields.includes('verified') && f.verifiedOnly) out.verifiedOnly = true;
  if (fields.includes('skills') && sent(f.skills).length) out.skills = sent(f.skills);
  if (fields.includes('lanes') && sent(f.lanes).length) out.lanes = sent(f.lanes);
  if (fields.includes('budget') && f.budget) out.budgets = [f.budget];
  if (fields.includes('tags') && sent(f.tags, isFeedTag).length) out.tags = sent(f.tags, isFeedTag);
  if (fields.includes('video') && f.hasVideo) out.hasVideo = true;
  if (fields.includes('classes') && sent(f.classes).length) out.classes = sent(f.classes);
  if (fields.includes('mechanics') && sent(f.mechanics).length) out.mechanics = sent(f.mechanics);
  return out;
}
export function emptyMessage(state: FeedState, league: string, filtered: boolean): { text: string; actions: ('clear' | 'publish' | 'archive' | 'browse')[] } {
  if (filtered || current(state).search.trim()) return { text: 'No items match these filters.', actions: ['clear'] };
  if (state.scope === 'following') return { text: 'Follow a creator to see their posts here.', actions: ['browse'] };
  if (state.scope === 'archive') return { text: `No posts in ${league}'s archive.`, actions: [] };
  return { text: `No posts for ${league} yet.`, actions: ['publish', 'archive'] };
}
export const offlineText = (cachedAt: string | null) => `Offline. Showing saved results${cachedAt ? ` from ${new Date(cachedAt).toLocaleString()}` : ''}.`;

/** Held results: new posts always need an explicit Refresh; reordering waits while the pointer or focus is on a row. */
export type Reconcile = { apply: boolean; pending: null | { kind: 'new' | 'ranks'; newCount: number } };
export function reconcile(shown: readonly PublicItemPayload[], incoming: readonly PublicItemPayload[], holding: boolean): Reconcile {
  const had = new Set(shown.map(i => i.publicId)), fresh = incoming.filter(i => !had.has(i.publicId)).length;
  if (fresh > 0) return { apply: false, pending: { kind: 'new', newCount: fresh } };
  const same = shown.length === incoming.length && shown.every((s, i) => s.publicId === incoming[i]!.publicId && s.votes.net === incoming[i]!.votes.net);
  if (same) return { apply: false, pending: null };
  return holding ? { apply: false, pending: { kind: 'ranks', newCount: 0 } } : { apply: true, pending: null };
}
export const refreshLabel = (p: NonNullable<Reconcile['pending']>) => p.kind === 'new' ? `${p.newCount} new ${p.newCount === 1 ? 'post' : 'posts'}. Refresh` : 'Ranks changed. Refresh';

/** Cursor history for paged Load more: Back restores the loaded pages, never re-pages from the start. */
export type PagedFeed = { items: PublicItemPayload[]; cursors: (string | null)[]; next: string | null };
export const emptyPaged = (): PagedFeed => ({ items: [], cursors: [], next: null });
export function appendPage(feed: PagedFeed, cursor: string | null, items: PublicItemPayload[], next: string | null): PagedFeed {
  if (feed.cursors.includes(cursor)) return feed;
  const seen = new Set(feed.items.map(i => i.publicId));
  return { items: [...feed.items, ...items.filter(i => !seen.has(i.publicId))], cursors: [...feed.cursors, cursor], next };
}

// ---- votes ----
export const voteTransition = (selected: Direction, clicked: 1 | -1): Direction => selected === clicked ? 0 : clicked;
export const VOTE_FAILED = 'Your vote was not saved. Retry.';
export const VOTE_RATE = 'Voting is paused for a moment. Your choice is kept. Retry.';
export function voteBlock(viewer: { signedIn: boolean; ownPostIds: readonly string[] }, postId: string, offline: boolean): { disabled: boolean; reason: string | null; signIn: boolean } {
  if (viewer.ownPostIds.includes(postId)) return { disabled: true, reason: 'You cannot vote on your own post.', signIn: false };
  if (offline) return { disabled: true, reason: 'Voting is unavailable offline.', signIn: false };
  if (!viewer.signedIn) return { disabled: false, reason: null, signIn: true };
  return { disabled: false, reason: null, signIn: false };
}
export function voteAria(label: 'Upvote' | 'Downvote', selected: Direction): string {
  const mine = label === 'Upvote' ? 1 : -1;
  return selected === mine ? `${label}, selected` : label;
}
/** `revision`/`myVote`: the post's vote revision the database read `net` at, and the voter's own vote counted in it (same read). */
export type VoteOutcome = { kind: 'counted'; direction: Direction; net: number; revision?: number; myVote?: Direction } | { kind: 'pending'; direction: Direction; countAt: string | null; net?: number; revision?: number; myVote?: Direction } | { kind: 'rate_limited' } | { kind: 'failed' };
type EntryLike = { state: string; result: { ok: boolean; value?: unknown } | null };
const asDirection = (v: unknown): Direction | undefined => v === -1 || v === 0 || v === 1 ? v : undefined;
/** Maps an outbox entry for a vote to what the UI shows. */
export function voteOutcome(entry: EntryLike): VoteOutcome {
  const value = entry.result && entry.result.ok ? entry.result.value as { direction?: Direction; net?: number; countAt?: string | null; count_at?: string | null; revision?: number; myVote?: unknown; countedDirection?: unknown } | undefined : undefined;
  if (entry.state === 'done' && value && (value.direction === -1 || value.direction === 0 || value.direction === 1)) {
    const countAt = value.countAt ?? value.count_at ?? null, mine = asDirection(value.myVote ?? value.countedDirection);
    const read = { ...(Number.isSafeInteger(value.revision) && (value.revision as number) >= 0 ? { revision: value.revision as number } : {}), ...(mine !== undefined ? { myVote: mine } : {}) };
    const net = typeof value.net === 'number' ? value.net : undefined;
    return countAt && Date.parse(countAt) > Date.now() ? { kind: 'pending', direction: value.direction, countAt, ...(net !== undefined ? { net } : {}), ...read }
      : { kind: 'counted', direction: value.direction, net: net ?? 0, ...read };
  }
  if (entry.state === 'retry') return { kind: 'rate_limited' };
  return { kind: 'failed' };
}

/**
 * One vote record per post, shared by every card and detail page in the Marketplace (VotesProvider). No component keeps its own count.
 * - Every count the database hands out (feed pages, detail reads, the answer to a vote) comes with the post's vote revision and the
 *   viewer's own counted vote (`myVote`), all from one read. The record keeps the read with the highest revision; a lower one is ignored,
 *   whatever order the answers arrive in. No clock takes part.
 * - Shown count: the read's net, except while the viewer's vote is being sent: net - myVote + the choice being sent. A count that already
 *   includes the viewer's vote is therefore never counted twice, and a deferred, rate-limited or failed vote never changes the count.
 * - One request per post is in flight; presses while sending only move the choice and the last one wins. A failure rolls back only that
 *   post's choice and Retry sends it again; a rate limit keeps the choice for Retry.
 */
export type VoteState = 'idle' | 'sending' | 'pending_count' | 'error';
export type VoteRecord = { net: number | null; revision: number; myVote: Direction | null; intended: Direction | null; state: VoteState;
  message?: string; retryable?: boolean; countAt?: string | null; retryWith?: Direction };
export type VoteShown = { net: number; selected: Direction; counted: Direction; state: VoteState; message?: string; retryable?: boolean; countAt?: string | null };
const UNKNOWN = -1;
export class VoteStore {
  private records = new Map<string, VoteRecord>(); private busy = new Set<string>();
  constructor(private readonly send: (postId: PostId, direction: Direction) => Promise<VoteOutcome>, private readonly changed: () => void = () => {}) {}
  private record(postId: string): VoteRecord { return this.records.get(postId) ?? { net: null, revision: UNKNOWN, myVote: null, intended: null, state: 'idle' }; }
  private put(postId: string, next: VoteRecord) { this.records.set(postId, next); this.changed(); }
  /** The read with a higher (or equal) revision replaces the one held. A read of unknown revision only fills an unknown post. */
  private read(r: VoteRecord, net: number, revision: number | null, myVote: Direction | null): VoteRecord {
    if (revision === null ? r.net !== null : revision < r.revision) return r;
    const next = { ...r, net, revision: revision ?? UNKNOWN, myVote: myVote ?? r.myVote };
    // Not sending and nothing kept for Retry: the selected arrow follows the server (a vote cast elsewhere shows here too).
    if (myVote !== null && r.state === 'idle') next.intended = myVote;
    return next;
  }
  /** A count for a post: its vote revision and the viewer's own vote (null: unknown, e.g. a stored copy or a signed-out read). */
  observe(postId: string, net: number, revision: number | null, myVote: Direction | null = null): void {
    const r = this.record(postId), next = this.read(r, net, revision, myVote);
    if (next !== r) this.put(postId, next);
  }
  observeItems(items: readonly { publishedRevision: { postId: string }; votes: { net: number; revision?: number; myVote?: Direction } }[]): void {
    for (const item of items) this.observe(item.publishedRevision.postId, item.votes.net, item.votes.revision ?? null, item.votes.myVote ?? null);
  }
  /** What every card and detail page shows. `counted` is the viewer's vote from their activity, used while no read says otherwise. */
  shown(postId: string, counted: Direction, fallbackNet: number): VoteShown {
    const r = this.record(postId), mine = r.myVote ?? counted, intended = r.intended ?? mine, net = r.net ?? fallbackNet;
    return { net: r.state === 'sending' ? net - mine + intended : net, selected: intended, counted: mine, state: r.state,
      ...(r.message ? { message: r.message } : {}), ...(r.retryable ? { retryable: true } : {}), ...(r.countAt !== undefined ? { countAt: r.countAt } : {}) };
  }
  /** Forgets the viewer's own votes (the account changed); counts stay until a read of the new viewer replaces them. */
  reset(): void { for (const [id, r] of this.records) this.records.set(id, { net: r.net, revision: r.revision, myVote: null, intended: null, state: 'idle' }); this.busy.clear(); this.changed(); }
  click(postId: PostId, clicked: 1 | -1, counted: Direction = 0): Promise<void> {
    const r = this.record(postId), mine = r.myVote ?? counted, intended = r.intended ?? mine;
    this.put(postId, { net: r.net, revision: r.revision, myVote: mine, intended: voteTransition(intended, clicked), state: 'sending' });
    return this.pump(postId);
  }
  /** Sends the kept choice again. */
  retry(postId: PostId): Promise<void> {
    const r = this.record(postId);
    this.put(postId, { net: r.net, revision: r.revision, myVote: r.myVote, intended: r.retryWith ?? r.intended, state: 'sending' });
    return this.pump(postId);
  }
  /** Applies a counted or deferred answer to a vote for `target` (the send path's own handling). True when nothing else is left to send. */
  private answer(postId: string, target: Direction, outcome: Extract<VoteOutcome, { kind: 'counted' | 'pending' }>): boolean {
    const r = this.record(postId);
    // The answer is one more read (net, revision and the voter's counted vote from one statement). It is kept only if its revision
    // is not lower than the read held; a higher read was taken after this vote was applied, so it already includes it.
    const mine = outcome.myVote ?? (outcome.kind === 'counted' ? outcome.direction : null);
    const kept = outcome.net !== undefined && outcome.revision !== undefined ? this.read({ ...r, state: 'sending' }, outcome.net, outcome.revision, mine)
      : r.net === null && outcome.net !== undefined ? { ...r, net: outcome.net, myVote: mine ?? r.myVote } : r;
    const done = outcome.kind === 'counted' ? r.intended === outcome.direction : r.intended === target;
    this.put(postId, { net: kept.net, revision: kept.revision, myVote: kept.myVote, intended: r.intended,
      state: done ? (outcome.kind === 'pending' ? 'pending_count' : 'idle') : 'sending', ...(outcome.kind === 'pending' ? { countAt: outcome.countAt } : {}) });
    return done;
  }
  /**
   * A vote the site paused for a human check was sent once more after the check passed (Continue; main/mastery/admission.ts
   * resume). Its answer goes through the same handling as an answer to the store's own send, so the count, revision and myVote rules
   * hold for it too; nothing new is sent. A failed answer leaves the card's error and Retry as they are.
   */
  settle(postId: string, outcome: VoteOutcome): void {
    if (this.busy.has(postId) || (outcome.kind !== 'counted' && outcome.kind !== 'pending')) return;
    const r = this.record(postId);
    this.records.set(postId, { net: r.net, revision: r.revision, myVote: r.myVote, intended: outcome.direction, state: 'sending' });
    this.answer(postId, outcome.direction, outcome);
  }
  private async pump(postId: PostId): Promise<void> {
    if (this.busy.has(postId)) return;
    this.busy.add(postId);
    try {
      for (;;) {
        const target = this.record(postId).intended ?? 0;
        const outcome = await this.send(postId, target).catch((): VoteOutcome => ({ kind: 'failed' }));
        const r = this.record(postId);
        if (outcome.kind === 'counted' || outcome.kind === 'pending') {
          if (this.answer(postId, target, outcome)) return;
        } else if (outcome.kind === 'rate_limited') {
          this.put(postId, { net: r.net, revision: r.revision, myVote: r.myVote, intended: r.intended, state: 'error', message: VOTE_RATE, retryable: true });
          return;
        } else {
          this.put(postId, { net: r.net, revision: r.revision, myVote: r.myVote, intended: r.myVote, state: 'error', message: VOTE_FAILED, retryable: true, retryWith: r.intended ?? 0 });
          return;
        }
      }
    } finally { this.busy.delete(postId); }
  }
}

/** The creator claims and derived facts of a post shown on its card and detail: class, budget, League starter, tags. */
export function listingLine(p: PublicItemPayload): string[] {
  const l = p.listing, out: string[] = [];
  const b = p.document.kind === 'build' ? p.document.payload : null, cls = l?.className ?? b?.className ?? null, asc = l?.ascendancy ?? b?.ascendancy ?? null;
  if (asc || cls) out.push(asc ? `${asc}${cls ? ` (${cls})` : ''}` : cls!);
  if (l && p.document.kind === 'atlas' && l.mechanics.length) out.push(l.mechanics.map(mechanicName).join(', '));
  if (l && l.budget !== 'not_stated') out.push(`${BUDGET_LABELS[l.budget]} budget`);
  if (l?.leagueStarter) out.push('League starter');
  return out;
}

// ---- save ----
/**
 * The Save state of one card or detail page. The viewer's shared Saved index is the truth for every place that shows the item;
 * a local answer only bridges the moment until that index catches up, and is dropped as soon as the shared reference changes
 * (so a card and its detail page, both mounted, always agree).
 */
export type SaveLocal = { saved: boolean; objectId: string | null; generation: number };
/** `generation` counts changes of the shared reference (SaveGenerations); a local answer holds only within the generation it was made in. */
export function saveView(shared: { objectId: string } | undefined, generation: number, local: SaveLocal | null): { saved: boolean; objectId: string | null } {
  const now = shared?.objectId ?? null;
  if (local && local.generation === generation) return { saved: local.saved, objectId: local.objectId ?? now };
  return { saved: now !== null, objectId: now };
}
/** Counts every change of the shared reference, including a change back to an earlier value (saved, removed, saved again). */
export class SaveGenerations {
  private last: string | null | undefined = undefined; private n = 0;
  of(shared: { objectId: string } | undefined): number { const now = shared?.objectId ?? null; if (now !== this.last) { this.last = now; this.n++; } return this.n; }
}

// ---- cards and text ----
export type ViewerState = { signedIn: boolean; ownPostIds: readonly string[]; votes: Record<string, Direction>; saved: Record<string, { objectId: string } | undefined>; activeLeague: string | null; activeBuild?: string };
export function richText(text: PublicRichText): string { return text.map(b => b.content.map(c => c.text).join('')).join('\n'); }
export const kindLabel = (p: PublicItemPayload) => ({ build: 'Build', atlas: 'Atlas plan', timeline: 'Timeline' })[p.document.kind];
export function cardFromPayload(p: PublicItemPayload, saved: boolean, assetUrl?: (a: AssetRef) => string | undefined): ItemCardModel {
  const d = p.document;
  const base = { title: p.title, stamp: p.stamp, updatedAt: p.publishedAt, save: saved ? 'saved' as const : 'not_saved' as const, ownership: 'public' as const, source: p.publishedRevision, creator: p.creator.displayName, votes: p.votes.net, finishes: p.finishes };
  if (d.kind === 'build') {
    const main = d.payload.skills[0];
    return { ...base, art: { name: main?.name ?? p.title, src: main?.asset ? assetUrl?.(main.asset) : undefined },
      summary: { kind: 'build', rows: [main ? `Main skill: ${main.name}` : 'No skills listed', `${d.payload.skills.length} skills / ${d.payload.gear.length} items`] } };
  }
  if (d.kind === 'atlas') {
    const pos = d.payload.sequencePositions, steps = Object.keys(d.payload.stepsById).length;
    const first = pos[0], id = first ? (first.kind === 'step' ? first.stepId : first.defaultStepId) : undefined, step = id ? d.payload.stepsById[id] : undefined;
    return { ...base, art: { name: 'Atlas' }, summary: { kind: 'atlas', stepId: (id ?? 'none') as never, stepName: step?.title ?? 'No steps', points: step ? { status: 'known', value: step.pointTarget, evidenceId: 'published' } : { status: 'unknown', reason: 'No steps.' }, steps, mechanics: [] } };
  }
  const lanes = [...d.payload.timeline.lanes].sort((a, b) => a.order - b.order).map(l => l.title);
  return { ...base, art: { name: 'Timeline' }, summary: { kind: 'timeline', lanes, lastRun: null } };
}
export function matchesFilters(p: PublicItemPayload, f: Filters, type: FeedType): boolean {
  const fields = filterFieldsFor(type);
  if (type !== 'all' && p.document.kind !== type) return false;
  if (fields.includes('verified') && f.verifiedOnly && !p.creator.identityVerified) return false;
  if (fields.includes('mode')) {
    const m = p.stamp.mode.status === 'known' ? p.stamp.mode.value : null;
    if (f.economy && m?.economy !== f.economy) return false;
    if (f.hardcore && !m?.hardcore) return false;
    if (f.ruthless && !m?.ruthless) return false;
  }
  if (fields.includes('skills') && f.skills.length) { if (p.document.kind !== 'build' || !p.document.payload.skills.some(s => f.skills.includes(s.skillId))) return false; }
  if (fields.includes('lanes') && f.lanes.length) { if (p.document.kind !== 'timeline' || !p.document.payload.timeline.lanes.some(l => f.lanes.includes(l.type))) return false; }
  const l = p.listing;
  if (fields.includes('budget') && f.budget && (l?.budget ?? 'not_stated') !== f.budget) return false;
  if (fields.includes('tags') && f.tags.length) { const want = f.tags.map(t => t.toLocaleLowerCase()); if (!(l?.tags ?? []).some(t => want.includes(t.toLocaleLowerCase()))) return false; }
  if (fields.includes('video') && f.hasVideo && !l?.video) return false;
  if (fields.includes('classes') && f.classes.length) {
    const b = p.document.kind === 'build' ? p.document.payload : null, own = [l?.className ?? b?.className, l?.ascendancy ?? b?.ascendancy].filter((x): x is string => !!x).map(x => x.toLocaleLowerCase());
    if (!b || !f.classes.some(c => own.includes(c.toLocaleLowerCase()))) return false;
  }
  if (fields.includes('mechanics') && f.mechanics.length && (p.document.kind !== 'atlas' || !(l?.mechanics ?? []).some(m => f.mechanics.includes(m)))) return false;
  return true;
}
export function matchesSearch(p: PublicItemPayload, search: string): boolean {
  const q = search.trim().toLocaleLowerCase(); if (!q) return true;
  const skills = p.document.kind === 'build' ? p.document.payload.skills.map(s => s.name) : [];
  return [p.title, p.creator.displayName, richText(p.description), ...skills].some(t => t.toLocaleLowerCase().includes(q));
}

// ---- detail ----
export type DetailTab = { id: string; label: string };
export const buildTabs: DetailTab[] = ['Overview', 'Tree', 'Skills', 'Gear', 'Leveling', 'Versions'].map(l => ({ id: l.toLowerCase(), label: l }));
export const missingSection = (section: string) => `Creator did not include ${section}.`;
export function isOldLeague(stamp: LeagueStamp, activeLeague: string | null): boolean { return activeLeague !== null && stamp.leagueId.status === 'known' && stamp.leagueId.value !== activeLeague; }
/** Versions 1..N; the newest is the published one. Selecting a version re-resolves that immutable revision. */
export function versionList(p: PublicItemPayload, latestKnown?: number): { revision: number; label: string; latest: boolean }[] {
  const n = Math.max(p.publishedRevision.displayRevision as number, latestKnown ?? 0); // viewing an older version must not hide the newer ones
  return Array.from({ length: n }, (_, i) => n - i).map(r => ({ revision: r, label: `Version ${r}`, latest: r === n }));
}
export function runDisabledReason(p: PublicItemPayload): string | null {
  if (p.document.kind !== 'timeline') return 'Only timelines can run.';
  const t = p.document.payload;
  return t.timeline.clips.some(c => c.options.some(o => o.actions.length > 0)) || t.dependencies.length ? null : 'This timeline has no instructions to run.';
}
export const sortedLanes = (p: PublicItemPayload) => p.document.kind === 'timeline' ? [...p.document.payload.timeline.lanes].sort((a, b) => a.order - b.order) : [];
