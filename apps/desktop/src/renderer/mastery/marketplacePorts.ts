// The Marketplace ports (services, publish, creator, moderation) backed by the real main process over the marketplace client.
// Nothing here invents data: a call the site cannot answer yet returns UNAVAILABLE, which the screens already show.
import { formatItemLink, type ApiResult, type LeagueStamp, type PublicItemPayload } from '@pom/mastery-contracts';
import { createMarketplaceClient, type LocalResult, type Raw } from '../marketplace/client.js';
import type { MarketplaceServices, FollowRow } from '../marketplace/services.js';
import type { PublishPort } from '../marketplace/publish/port.js';
import type { CreatorPort, ProfileData, VerificationState } from '../marketplace/creator/port.js';
import { toInboxThread, type InboxThread, type OwnPost, type Result, type VerifyStatus, type Analytics, type Count } from '../marketplace/creator/presenter.js';
import type { ModerationPort } from '../marketplace/moderation/port.js';
import type { CaseDetail, CaseKind, ModResult, QueueRow } from '../marketplace/moderation/presenter.js';
import type { FeedQuery } from '../../main/marketplace/reads.js';
import { invoke } from './bridge.js';
import { humanCheck } from './humanCheck.js';
import { runChoice } from './RunChoiceDialog.js';
import type { MasteryShell } from './shell.js';
import { tr } from '../i18n';

export const client = createMarketplaceClient((channel, input) => invoke(channel, input));

// Same numbers as MASTERY_LIMITS in main/mastery/context.ts (the renderer cannot import that file). Keep in sync.
const LIMITS = Object.freeze({ maxBytes: 8_000_000, maxDepth: 64, maxNodes: 400_000, maxArrayLength: 50_000, maxStringLength: 2_000_000 });

export type PortEnv = { shell(): MasteryShell; stamp(): LeagueStamp; leagueName(): string | null; afterChange(): void; openItem(publicId: string, revision: number): void };
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Unwraps a local result; a local failure (offline, wrong account, bad request) becomes a thrown error. */
async function local<T>(p: Promise<LocalResult<T>>): Promise<T> {
  const r = await p;
  if (r.ok) return r.value;
  throw Object.assign(new Error(r.error.message), { code: r.error.code });
}
/** Opens the sign-in dialog and waits (up to two minutes) for the person to come back signed in. */
export async function signInFlow(env: PortEnv): Promise<boolean> {
  if (env.shell().signedIn) return true;
  env.shell().signIn();
  for (let i = 0; i < 240; i++) { await sleep(500); if (env.shell().signedIn) return true; }
  return false;
}
const httpsOnly = (url: string) => /^https:\/\//i.test(url);

type FailCode = Extract<Result<unknown>, { ok: false }>['code'];
function failCode(r: { code: string }): FailCode {
  switch (r.code) {
    case 'SIGN_IN_REQUIRED': case 'CONNECTION_REVOKED': return 'DENIED';
    case 'RATE_LIMITED': return 'RATE_LIMITED';
    case 'REVISION_CONFLICT': return 'STALE';
    case 'VALIDATION_FAILED': case 'LIMIT_EXCEEDED': case 'INVALID_LINK': return 'INVALID';
    default: return 'UNAVAILABLE';
  }
}
/** Runs a call and shapes the answer as a creator Result: local failures and thrown errors become UNAVAILABLE / DENIED / OFFLINE. */
async function result<T, U>(env: PortEnv, run: () => Promise<ApiResult<T>>, map: (value: T) => U | Promise<U>): Promise<Result<U>> {
  if (!env.shell().online) return { ok: false, code: 'OFFLINE' };
  try {
    const r = await run();
    if (!r.ok) return { ok: false, code: failCode(r), message: r.message };
    return { ok: true, value: await map(r.value) };
  } catch (e) {
    const code = (e as { code?: string }).code;
    return { ok: false, code: code === 'ACCOUNT_CHANGED' ? 'DENIED' : 'UNAVAILABLE', message: e instanceof Error ? e.message : undefined };
  }
}
const unavailable = (message: string): Result<never> => ({ ok: false, code: 'UNAVAILABLE', message });

// ---- feed and details ----------------------------------------------------------------------------
export function createServices(env: PortEnv, follows: { dot: boolean }): MarketplaceServices {
  const savePayload = (payload: PublicItemPayload) => local(client.call('save', { payload })).then(ref => { env.afterChange(); return ref; });
  return {
    feed: q => local(client.call('feed', { request: q as unknown as FeedQuery })),
    count: q => local(client.call('count', { request: q as unknown as FeedQuery })),
    item: request => local(client.call('item', { request })),
    vote: (postId, direction) => local(client.call('vote', { postId, direction })).then(entry => { env.afterChange(); return entry; }),
    save: savePayload,
    unsave: objectId => local(client.call('remove', { objectId: objectId as never })).then(() => { env.afterChange(); }),
    undoUnsave: objectId => local(client.call('undoRemove', { objectId: objectId as never })).then(() => { env.afterChange(); }),
    run: async (payload) => {
      const first = await local(client.call('runStart', { payload }));
      if (first.status !== 'blocked' || !first.competing) return first;
      // A Run is already open: the app's dialog asks Replace or Resume. Closing it changes nothing.
      const choice = await runChoice.ask();
      if (choice === 'keep') { env.openItem(payload.publicId, payload.publishedRevision.displayRevision as number); return { status: 'blocked', reason: tr('mastery_marketplacePorts.your_current_run_stays_open') }; } // Keep: nothing changes, the new post's page opens
      return choice === null ? first : local(client.call('runStart', { payload, choice }));
    },
    // The pinned revision is kept in Saved items too (works offline); the host makes the owned copy from the payload.
    editCopy: async payload => ({ kind: payload.document.kind, objectId: (await savePayload(payload)).objectId, payload }),
    share: async payload => ({ url: formatItemLink({ kind: 'item', publicId: payload.publicId, revision: payload.publishedRevision.displayRevision as number, view: 'detail' }, 'web') }),
    copyText: text => env.shell().copyText(text),
    openExternal: url => { if (httpsOnly(url)) env.shell().openExternal(url); },
    // atlasData is left out: the Atlas detail shows its "unavailable" state until a published-dataset catalog read exists.
    follows: {
      get dot() { return follows.dot; },
      async list(): Promise<FollowRow[]> {
        const r = await local(client.call('follows', {}));
        if (!r.ok) throw new Error(r.message);
        return Promise.all(r.value.creators.map(async ({ creatorId }): Promise<FollowRow> => {
          const profile = await local(client.call('profile', { creatorId })).catch(() => null);
          const v = profile && profile.ok ? profile.value : null;
          return { creatorId, name: typeof v?.displayName === 'string' ? v.displayName : tr('mastery_marketplacePorts.creator'), verified: v?.identityVerified === true, following: true };
        }));
      },
      async set(creatorId, follow) {
        const r = await local(client.call('follow', { creatorId, following: follow }));
        if (!r.ok) throw new Error(r.message);
      },
      async setDot(on) {
        const r = await local(client.call('creatorPreference', { showNewPostDot: on }));
        if (!r.ok) throw new Error(r.message);
        follows.dot = on;
      },
    },
  };
}

// ---- publish ----------------------------------------------------------------------------------------------------
export function createPublishPort(env: PortEnv): PublishPort {
  const draftKey = (id: string) => `pom-publish-draft-${id}`;
  return {
    online: () => env.shell().online,
    signedIn: () => env.shell().signedIn,
    limits: LIMITS,
    creator: { displayName: tr('mastery_marketplacePorts.you'), identityVerified: false }, // the server fills the real creator on publish
    get activeLeague() { return env.leagueName(); },
    // Owned Documents-store objects (Timeline, Atlas plan, Build snapshot). The main process builds the public form and, at Publish,
    // pushes the exact revision to the account's cloud copy first (the site only publishes a synced revision).
    sources: async kind => local(client.call('publishSources', { kind })),
    currentRef: async objectId => {
      const found = (await local(client.call('publishSources', {}))).find(s => s.objectId === objectId);
      if (!found) throw new Error(tr('mastery_marketplacePorts.this_item_is_no_longer_available'));
      return found.ref;
    },
    loadDraft(objectId) { try { const raw = localStorage.getItem(draftKey(objectId)); return raw ? JSON.parse(raw) : null; } catch { return null; } },
    saveDraft(objectId, draft) { try { localStorage.setItem(draftKey(objectId), JSON.stringify(draft)); } catch { /* per-viewer convenience only */ } },
    publish: body => local(client.call('publish', { body })),
    status: idempotencyKey => local(client.call('publicationStatus', { idempotencyKey })),
    requestReview: input => local(client.call('requestReview', input)),
    // Sign-in uses the existing dialog. The human check runs the challenge in main and resolves true once the server cleared this request.
    continueBlocked: kind => kind === 'sign_in' ? signInFlow(env) : humanCheck.run(),
  };
}

// ---- creator -------------------------------------------------------------------------------------
const knownString = (k: unknown): string | null => (k && typeof k === 'object' && (k as Raw).status === 'known' && typeof (k as Raw).value === 'string' ? (k as Raw).value as string : null);
const verifyStatus = (s: string): VerifyStatus => s === 'verified' ? 'verified' : s === 'needs_info' || s === 'declined' ? 'needs_info' : 'pending';
const count = (x: unknown): Count => {
  if (typeof x === 'number') return { value: x };
  const r = (x ?? {}) as Raw;
  if (r.status === 'suppressed') return { value: null, suppressed: true };
  const v = r.value ?? r.net;
  return { value: typeof v === 'number' ? v : null };
};
const REASON: Record<string, string> = { instructions_unclear: tr('h_c_Mp.r_unclear'), item_unavailable: tr('h_c_Mp.r_unavailable'), timing_wrong: tr('h_c_Mp.r_timing'), other: tr('h_c_Mp.r_other') };

function toAnalytics(raw: Raw, revision: number | null): Analytics {
  const votes = (raw.votes ?? {}) as Raw, finishes = (raw.finishes ?? {}) as Raw, fb = (raw.feedback ?? {}) as Raw;
  const optIn = (raw.optInObservations ?? {}) as Raw;
  const suppressedFb = fb.status === 'suppressed';
  return {
    votes: count(votes.net), saves: count(raw.syncedSaves), runs: optIn.status === 'known' ? count(optIn.started) : count(optIn),
    finishedFinalTrigger: count(finishes.finalTriggerObserved), finishedPlayerConfirmed: count(finishes.playerConfirmed),
    feedback: {
      senders: suppressedFb ? { value: null, suppressed: true } : count(fb.runners), relevantRuns: { value: null },
      categories: Array.isArray(fb.categories) ? (fb.categories as Raw[]).map(c => ({ name: String(c.reason ?? c.name ?? tr('mastery_marketplacePorts.other')), count: count(c.count ?? c.total) })) : [],
    },
    revisions: revision ? Array.from({ length: revision }, (_, i) => i + 1) : [], chunks: [],
  };
}

export function createCreatorPort(env: PortEnv): CreatorPort {
  const drafts = new Map<string, string>();
  const ownId = async () => (await local(client.call('ownCreator', {})))?.creatorId ?? null;
  const readProfile = async (ref: string | { publicId: string }, own: boolean, league: string): Promise<ProfileData> => {
    const r = await local(client.call('profile', typeof ref === 'string' ? { creatorId: ref } : { publicId: ref.publicId }));
    if (!r.ok) throw Object.assign(new Error(r.message), { code: r.code });
    const v = r.value, creatorId = typeof ref === 'string' ? ref : String(v.creatorId ?? '');
    if (typeof ref !== 'string') own = creatorId !== '' && creatorId === await ownId().catch(() => null); // signed out: nobody's own profile
    const byLeague = (Array.isArray(v.byLeague) ? v.byLeague : []) as Raw[];
    const leagues = byLeague.map(l => knownString((l.stamp as Raw | undefined)?.leagueId)).filter((x): x is string => !!x).map(id => ({ id, label: id }));
    const pick = byLeague.find(l => knownString((l.stamp as Raw | undefined)?.leagueId) === league);
    const fin = (v.finishes ?? {}) as Raw;
    const following = own ? false : await local(client.call('follows', {})).then(f => f.ok && f.value.creators.some(c => c.creatorId === creatorId), () => false);
    return { creatorId, name: String(v.displayName ?? ''), bio: String(v.bio ?? ''), links: Array.isArray(v.links) ? v.links.map(String) : [], verified: v.identityVerified === true, own, following,
      reputation: { netVotes: Number(pick ? pick.netVotes : v.netVotes ?? 0), listings: Number(pick ? pick.listings : v.listings ?? 0),
        finishedRuns: pick ? null : Number(fin.finalTriggerObserved ?? 0) + Number(fin.playerConfirmed ?? 0) }, leagues, cachedAt: null };
  };
  const blank: ProfileData = { creatorId: '', name: '', bio: '', links: [], verified: false, own: true, following: false,
    reputation: { netVotes: null, listings: null, finishedRuns: null }, leagues: [], cachedAt: null };
  const ownPosts = async (): Promise<{ posts: OwnPost[]; current: Map<string, number>; titles: Map<string, string> }> => {
    const r = await local(client.call('posts', {}));
    if (!r.ok) throw Object.assign(new Error(r.message), { code: r.code });
    const notices = new Map<string, string>();
    for (const n of [...r.value.notices].reverse()) if (typeof n.postId === 'string' && typeof n.reason === 'string') notices.set(n.postId, n.reason);
    const current = new Map<string, number>(), titles = new Map<string, string>();
    const posts = await Promise.all(r.value.items.slice(0, 100).map(async (row): Promise<OwnPost> => {
      const postId = String(row.postId), ref = row.currentRevision as { revisionId?: string; displayRevision?: number } | null;
      const published = row.status === 'published';
      const item = published ? await local(client.call('item', { request: { publicId: row.publicId as never } })).catch(() => null) : null;
      const payload = item && item.result.ok ? item.result.value : null;
      const title = payload?.title ?? tr('mastery_marketplacePorts.untitled_post');
      titles.set(postId, title); if (ref?.displayRevision) current.set(postId, ref.displayRevision);
      const analytics = published && ref?.revisionId ? await local(client.call('analytics', { postId, revisionId: ref.revisionId })).catch(() => null) : null;
      return { postId, title, kind: payload?.document.kind ?? 'build', revision: ref?.displayRevision ?? null, league: knownString((row.stamp as Raw | undefined)?.leagueId) ?? tr('mastery_marketplacePorts.unknown_league'),
        status: row.status === 'published' ? 'published' : row.status === 'removed' ? 'removed' : row.status === 'draft' ? 'draft' : 'needs_review',
        ...(notices.has(postId) ? { moderationReason: notices.get(postId)! } : {}),
        ...(analytics && analytics.ok ? { analytics: toAnalytics(analytics.value, ref?.displayRevision ?? null), analyticsAt: null } : {}) };
    }));
    return { posts, current, titles };
  };
  const setState = (threadId: string, patch: { read?: boolean; resolved?: boolean; fixedRevision?: number | null }) =>
    result(env, () => local(client.call('feedbackState', { threadId, ...patch })), () => null);

  return {
    online: () => env.shell().online,
    signedIn: () => env.shell().signedIn,
    signIn: () => signInFlow(env),
    async profile(who, league) {
      if (!env.shell().online) return { ok: false, code: 'OFFLINE' };
      if (!('own' in who)) {
        const publicId = who.publicId;
        return publicId ? result(env, async () => ({ ok: true as const, value: null }), async () => readProfile({ publicId }, false, league)) : unavailable(tr('mastery_marketplacePorts.this_creator_cannot_be_opened_by'));
      }
      return result(env, async () => ({ ok: true as const, value: await ownId() }), async id => id ? readProfile(id, true, league) : blank);
    },
    saveProfile: draft => result(env, () => local(client.call('saveProfile', { displayName: draft.name, bio: draft.bio, links: draft.links })), ({ creatorId }) => readProfile(creatorId, true, '')),
    follow: (creatorId, on) => result(env, () => local(client.call('follow', { creatorId, following: on })), () => null),
    items: (creatorId, q) => creatorId ? result(env, async () => {
      const page = await local(client.call('feed', { request: { query: { scope: env.stamp(), type: q.type, sort: q.sort, window: 'league', search: '', cursor: null }, creatorId } as FeedQuery }));
      return page.result.ok ? { ok: true as const, value: page.result.value.items } : page.result;
    }, items => items) : Promise.resolve({ ok: true, value: [] }),
    verification: () => result(env, () => local(client.call('verification', {})), async (v): Promise<VerificationState> => {
      const draft = await local(client.call('verificationDraft', {})).catch(() => null);
      return { status: v ? verifyStatus(v.status) : 'not_submitted', publicName: draft?.publicName ?? '', profileLink: draft?.profileLink ?? '', explanation: draft?.explanation ?? '',
        challenge: v?.publicNonce ?? null, note: v?.status === 'declined' ? tr('mastery_marketplacePorts.your_last_application_was_declined_you') : null };
    }),
    saveVerificationDraft: draft => result(env, async () => { await local(client.call('saveVerificationDraft', { draft })); return { ok: true as const, value: null }; }, () => null),
    checkProof: () => result(env, () => local(client.call('checkProof', {})), v => ({ found: (v.proof as Raw).status === 'found' })),
    submitVerification: draft => result(env, () => local(client.call('submitVerification', { draft, stamp: env.stamp() })), () => ({ status: 'pending' as const })),
    posts: () => result(env, async () => ({ ok: true as const, value: await ownPosts() }), ({ posts }) => ({ posts, cachedAt: null })),
    // The site opens a review case from a submission id and its reviewed hash; the posts list does not carry them.
    requestReview: async () => unavailable(tr('mastery_marketplacePorts.ask_for_a_review_from_the')),
    async inbox() {
      if (!env.shell().online || !env.shell().signedIn) {
        try { return { ok: true, value: { threads: await inboxFromCache(), cachedAt: null } }; } catch { return { ok: false, code: env.shell().online ? 'DENIED' : 'OFFLINE' }; }
      }
      return result(env, async () => {
        await local(client.call('refreshInbox', { view: 'received' })).catch(() => null);
        const mine = (await local(client.call('inbox', {}))).filter(t => t.role === 'creator');
        await Promise.allSettled(mine.slice(0, 20).map(t => local(client.call('refreshInbox', { view: 'received', threadId: t.threadId })))); // messages arrive per thread
        return { ok: true as const, value: null };
      }, async () => ({ threads: await inboxFromCache(), cachedAt: null }));
    },
    markRead: threadId => setState(threadId, { read: true }),
    reply: (threadId, text, key) => result(env, () => local(client.call('feedbackMessage', { threadId, text, idempotencyKey: key })), () => ({ messageId: key, sentAt: new Date().toISOString() })),
    setFixed: (threadId, revision) => setState(threadId, { fixedRevision: revision }),
    resolve: (threadId, on) => setState(threadId, { resolved: on, read: true }),
    saveReplyDraft: (id, text) => { drafts.set(id, text); },
    replyDraft: id => drafts.get(id) ?? '',
    copyText: text => env.shell().copyText(text),
    openExternal: url => { if (httpsOnly(url)) env.shell().openExternal(url); },
  };

  async function inboxFromCache(): Promise<InboxThread[]> {
    const threads = (await local(client.call('inbox', {}))).filter(t => t.role === 'creator');
    const info = await ownPosts().catch(() => null);
    return threads.map(t => {
      const postId = String((t.publishedRevision as { postId?: unknown }).postId ?? ''), instr = t.instruction;
      const text = typeof instr === 'string' ? instr : instr && typeof instr === 'object' ? ((instr as Raw).text ?? (instr as Raw).title) : null;
      const rev = info?.current.get(postId) ?? 0;
      return toInboxThread({ ...t, read: !!t.readAt, resolved: !!t.resolvedAt, fixedIn: t.fixedRevision, instruction: typeof text === 'string' ? text : null,
        postTitle: info?.titles.get(postId) ?? tr('mastery_marketplacePorts.post'), reason: REASON[String(t.reason)] ?? String(t.reason ?? tr('mastery_marketplacePorts.feedback')),
        ownPublished: rev ? Array.from({ length: rev }, (_, i) => i + 1) : [] });
    });
  }
}

// ---- reports and moderation --------------------------------------------------------------------------------
function modResult<T, U>(r: ApiResult<T>, map: (v: T) => U): ModResult<U> {
  if (r.ok) return { ok: true, value: map(r.value) };
  // The site answers CONNECTION_REVOKED for a missing moderator role and REVISION_CONFLICT for a stale case.
  const code = r.code === 'CONNECTION_REVOKED' ? 'MODERATOR_REQUIRED' : r.code === 'REVISION_CONFLICT' ? 'STALE_CASE' : r.code;
  return { ok: false, code, message: r.message };
}
async function mod<T, U>(env: PortEnv, run: () => Promise<ApiResult<T>>, map: (v: T) => U): Promise<ModResult<U>> {
  if (!env.shell().online) return { ok: false, code: 'OFFLINE' };
  try { return modResult(await run(), map); } catch (e) { return { ok: false, code: 'UNAVAILABLE', message: e instanceof Error ? e.message : undefined }; }
}
const asArray = (v: unknown): Raw[] => Array.isArray(v) ? v as Raw[] : v && typeof v === 'object' && Array.isArray((v as Raw).items) ? (v as Raw).items as Raw[] : [];

export function createModerationPort(env: PortEnv): ModerationPort {
  return {
    online: () => env.shell().online,
    signedIn: () => env.shell().signedIn,
    signIn: () => signInFlow(env),
    report: input => mod(env, () => local(client.call('report', input)), v => v),
    queue: (kind: CaseKind, status) => mod(env, () => local(client.call('modQueue', { kind, status })), (v): QueueRow[] => asArray(v).map(row => {
      const snap = (row.target_snapshot ?? {}) as Raw;
      return { id: String(row.id), kind: (row.kind ?? kind) as CaseKind, status: (row.status ?? status) as 'open' | 'decided', case_version: Number(row.case_version ?? 1),
        claimed_by: typeof row.claimed_by === 'string' ? row.claimed_by : null, opened_at: String(row.opened_at ?? ''),
        target: String(snap.title ?? snap.publicName ?? row.target ?? ''), ...(typeof row.reason === 'string' ? { category: row.reason } : {}),
        lastAction: typeof row.last_action === 'string' ? row.last_action : null };
    })),
    readCase: caseId => mod(env, () => local(client.call('modCase', { caseId })), v => v as CaseDetail),
    claim: (caseId, expectedCaseVersion) => mod(env, () => local(client.call('modClaim', { caseId, expectedCaseVersion })), v => {
      const r = (v ?? {}) as Raw;
      return { caseVersion: Number(r.caseVersion ?? r.case_version ?? expectedCaseVersion + 1), concurrentReviewer: r.concurrentReviewer === true };
    }),
    decide: input => mod(env, () => local(client.call('modDecide', input)), v => v),
    viewLive: () => env.shell().toast(tr('mastery_marketplacePorts.opening_the_live_listing_from_a')),
    gotoFeedback: () => env.shell().toast(tr('mastery_marketplacePorts.the_feedback_route_is_not_available')),
  };
}
