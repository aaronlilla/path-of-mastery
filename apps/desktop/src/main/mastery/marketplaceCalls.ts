// The Marketplace IPC calls that go to the site (reads, publication, creator, moderation).
// Each body is checked here with exact field lists before it is sent; the site checks it again.
import { randomUUID } from 'node:crypto';
import { isId, isSafeHttpsUrl, leagueStampSchema, publicDocumentSchema, publicItemPayloadSchema, publishRequestSchema, reportRequestSchema, timelineBundleSchema,
  type AtlasPlan, type ObjectKind, type ObjectId, type RevisionId, type TimelineBundle, type ValidationLimits } from '@pom/mastery-contracts';
import type { DocumentStore } from '../documents/store.js';
import { canonicalJson } from '../../shared/timelines/adapters/common.js';
import { decodeBuildCode } from '../library/buildCode.js';
import { privateBuildParts } from '@pom/mastery-contracts/build-xml';
import type { MarketplaceSync } from '../marketplace/sync.js';
import type { MarketplaceTransport } from '../marketplace/api.js';
import type { PublicCache } from '../marketplace/cache.js';
import type { MarketplaceOutbox } from '../marketplace/outbox.js';
import type { PrivateMessageCache, PrivateThread } from '../marketplace/privateCache.js';
import type { MarketplaceReads } from '../marketplace/reads.js';
import { MarketplaceLocalError, validate, type MarketplaceStore } from '../marketplace/store.js';
import type { ExtraCalls } from '../marketplace/ipc.js';
import type { RunLauncher } from './context.js';

export type ExtraDeps = {
  api: MarketplaceTransport; reads: MarketplaceReads; cache: PublicCache; store: MarketplaceStore; outbox: MarketplaceOutbox;
  privateCache: PrivateMessageCache; launcher: RunLauncher | null; limits: ValidationLimits;
  /** Local documents and the cloud sync: what publishing needs to turn an owned document into a publishable source. */
  documents?: DocumentStore; sync?: MarketplaceSync;
  /** Timeline -> TimelineBundle (the public and cloud form of a timeline). */
  bundleFor?: (objectId: ObjectId, revisionId?: RevisionId) => Promise<TimelineBundle>;
  /** The signed-in account's display name (never the email). A first publish makes the creator profile from it. */
  accountName?: () => string | null;
  /** Freezes the Builds library into Documents-store builds (with their build code), so the Build picker lists them. */
  refreshLibrary?: () => Promise<void>;
  /** An Atlas plan's mechanics from its tree data's taxonomy (listing.ts planMechanics). */
  mechanicsOf?: (plan: AtlasPlan) => string[];
  /** Read-only saved copies of other people's posts (Atlas Compare with my plan): never offered for publishing. */
  notPublishable?: (objectId: ObjectId) => boolean;
};
const PUBLISH_KINDS = ['build', 'atlas', 'timeline'] as const;
/** Every buildCode in a value (a Build, Build sources inside a Timeline, history snapshots). */
function buildCodes(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) { for (const v of value) buildCodes(v, out); return out; }
  if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { if (k === 'buildCode' && typeof v === 'string') out.push(v); else buildCodes(v, out); }
  return out;
}
/** True when a build code that would go public is unreadable or carries account data, or notes the creator did not include. */
export function publicCodeProblem(content: unknown, includeNotes: boolean): boolean {
  return buildCodes(content).some(code => {
    let xml: string;
    try { xml = decodeBuildCode(code); } catch { return true; }
    const parts = privateBuildParts(xml);
    return parts.includes('unreadable') || parts.includes('account') || (!includeNotes && parts.includes('notes'));
  });
}
type Rec = Record<string, unknown>;
const bad = (message = 'Invalid Marketplace request.') => new MarketplaceLocalError('INVALID', message);
function exact(input: unknown, allowed: string[], required: string[] = allowed): Rec {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad();
  const record = input as Rec;
  if (Object.keys(record).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(record, key))) throw bad();
  return record;
}
function str(value: unknown, max: number, min = 0): string {
  if (typeof value !== 'string' || value.length > max || value.trim().length < min) throw bad();
  return value;
}
function int(value: unknown, min = 0): number { if (!Number.isSafeInteger(value) || (value as number) < min) throw bad(); return value as number; }
function publicUuid(value: unknown): string { if (typeof value !== 'string' || !isId('public', value)) throw bad(); return value; }
function uuid(value: unknown): string { if (typeof value !== 'string' || !isId('object', value)) throw bad(); return value; }
function httpsUrl(value: unknown): string { const url = str(value, 2000, 1); if (!isSafeHttpsUrl(url)) throw bad('Links must be https.'); return url; }
function oneOf<T extends string>(value: unknown, list: readonly T[]): T { if (typeof value !== 'string' || !list.includes(value as T)) throw bad(); return value as T; }
const slugify = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'creator';

type Verification = { applicationId: string };
type DraftIn = { publicName: string; profileLink: string; explanation: string; alternative: boolean };
function draftOf(input: unknown): DraftIn {
  const d = exact(input, ['publicName', 'profileLink', 'explanation', 'alternative']);
  if (typeof d.alternative !== 'boolean') throw bad();
  return { publicName: str(d.publicName, 80), profileLink: str(d.profileLink, 2000), explanation: str(d.explanation, 2000), alternative: d.alternative };
}

export function createExtraCalls(d: ExtraDeps): ExtraCalls {
  // A bundle gets a fresh id every time it is built; the preview, the cloud copy and the publish request must all carry the same one.
  // Once a revision's bundle is in the cloud copy it is kept on disk (per account), so a restart reuses that exact bundle instead of
  // building one with a new id that the site would refuse as a different source.
  const bundles = new Map<string, Promise<TimelineBundle>>();
  const SYNCED = 'synced-bundles';
  const syncedKey = (account: string, objectId: ObjectId, revisionId: RevisionId) => `${account}:${objectId}:${revisionId}`;
  const keepSynced = async (account: string, objectId: ObjectId, revisionId: RevisionId, bundle: TimelineBundle) => {
    bundles.set(`${objectId}:${revisionId}`, Promise.resolve(bundle));
    await d.store.serial(() => d.store.transaction(() => d.store.put(SYNCED, syncedKey(account, objectId, revisionId), bundle)));
  };
  const bundleOf = (objectId: ObjectId, revisionId: RevisionId) => {
    const key = `${objectId}:${revisionId}`;
    let found = bundles.get(key);
    if (!found) {
      const account = d.outbox.currentAccount();
      const kept = account ? d.store.get<TimelineBundle>(SYNCED, syncedKey(account, objectId, revisionId)) : null;
      if (kept) found = Promise.resolve(validate(timelineBundleSchema, kept, d.limits));
      else { if (!d.bundleFor) throw bad('Timelines cannot be published right now.'); found = d.bundleFor(objectId, revisionId); }
      bundles.set(key, found); found.catch(() => bundles.delete(key));
    }
    return found;
  };
  /** The publishable form of one owned document at its latest revision, or null when it cannot be published (local-only Build, invalid). */
  const publishable = async (objectId: ObjectId, kind: ObjectKind) => {
    if (!d.documents) return null;
    const doc = await d.documents.read(objectId);
    const payload = kind === 'timeline' ? await bundleOf(objectId, doc.revision.revisionId) : doc.payload;
    const document = validate(publicDocumentSchema, { kind, payload }, d.limits);
    return { doc, document, payload: payload as { title?: string; credits?: unknown[] } };
  };
  /**
   * The site only publishes a revision that is in the person's cloud copy, and it checks the request's source hashes against that copy (its own
   * hash of the stored payload, not the local file hash; for a timeline the stored payload is the publishable bundle). Push the revision when the
   * cloud head is older, then return the hash the site holds for it.
   */
  const ensureSynced = async (account: string, objectId: ObjectId, revisionId: RevisionId): Promise<{ hash: string; payload: unknown }> => {
    if (!d.documents || !d.sync) throw bad('Publishing is unavailable right now.');
    const latest = await d.documents.read(objectId);
    if (latest.revision.revisionId !== revisionId) throw new MarketplaceLocalError('CONFLICT', 'Source changed. Review it before you publish.');
    type Remote = { items: { revision?: { revisionId?: string; payloadHash?: string }; payload?: unknown }[] };
    const read = async () => {
      const remote = await d.api.request<Remote>('sync', { action: 'read', objectId }, account);
      if (!remote.ok) throw new MarketplaceLocalError('CONFLICT', 'Could not check your cloud copy. Try again.');
      const item = remote.value.items?.[0];
      return item?.revision ? { ...item.revision, payload: item.payload } : null;
    };
    let head = await read();
    if (head?.revisionId !== revisionId) {
      const prepared = await publishable(objectId, latest.kind);
      if (!prepared) throw bad('This item cannot be published.');
      const pushed = await d.sync.pushDocument({ ...latest, payload: prepared.document.payload } as never, (head?.revisionId as RevisionId | undefined) ?? null);
      if ('local' in pushed) throw new MarketplaceLocalError('CONFLICT', 'Your cloud copy changed. Open Sync to keep both before you publish.');
      head = await read();
    }
    if (head?.revisionId !== revisionId || !isId('hash', head.payloadHash)) throw new MarketplaceLocalError('CONFLICT', 'Could not check your cloud copy. Try again.');
    // The cloud copy of a timeline is its bundle: remember it, so this revision is published as exactly that bundle from now on.
    if (latest.kind === 'timeline' && head.payload !== undefined) await keepSynced(account, objectId, revisionId, validate(timelineBundleSchema, head.payload, d.limits));
    return { hash: head.payloadHash, payload: head.payload };
  };
  /** Class/ascendancy (Builds) and mechanics (Atlas plans) come from the source itself, never from what the creator types. */
  const derived = (document: { kind: string; payload: unknown }) => {
    if (document.kind === 'build') { const b = document.payload as { className?: string; ascendancy?: string }; return { className: b.className ?? '', ascendancy: b.ascendancy ?? '', mechanics: [] as string[] }; }
    if (document.kind === 'atlas' && d.mechanicsOf) { try { return { className: '', ascendancy: '', mechanics: d.mechanicsOf(document.payload as AtlasPlan) }; } catch { /* no taxonomy: none derived */ } }
    return { className: '', ascendancy: '', mechanics: [] as string[] };
  };
  const need = (): string => {
    const account = d.outbox.currentAccount();
    if (!account) throw new MarketplaceLocalError('ACCOUNT_CHANGED', 'Sign in to continue.');
    return account;
  };
  const authed = <T>(op: Parameters<MarketplaceTransport['request']>[0], body: unknown) => d.api.request<T>(op, body, need());
  const review = <T>(body: Rec) => authed<T>('review', body);
  const stored = <T>(bucket: string) => d.store.get<T>(bucket, need());
  const keep = (bucket: string, value: unknown) => d.store.serial(() => d.store.transaction(() => d.store.put(bucket, need(), value)));
  const applicationStatus = async (applicationId: string) => review<{ applicationId: string; publicNonce: string; caseVersion: number; status: string }>({ operation: 'verification-status', applicationId });
  const refreshThread = async (thread: PrivateThread) => {
    try { await d.privateCache.refresh(thread.role === 'creator' ? 'received' : 'sent', thread.threadId); } catch { /* the write already succeeded; the next inbox refresh catches up */ }
  };
  const thread = (account: string, threadId: string): PrivateThread & Rec => {
    const found = d.store.get<PrivateThread & Rec>(`inbox:${account}`, uuid(threadId));
    if (!found) throw bad('Open the inbox first so this thread is loaded.');
    return found;
  };

  return async call => {
    switch (call.method) {
      case 'feed': return d.reads.feed(call.request as never);
      case 'count': return d.reads.count(call.request as never);
      case 'item': {
        const read = await d.reads.item(call.request as never);
        if (read.result.ok || !read.offline) return read;
        // Offline and never opened here: a saved copy of this exact post still opens from its pinned cache.
        const asked = call.request as { publicId?: string; revision?: number };
        const refs = d.cache.list().filter(ref => ref.publicId === asked.publicId && ref.cacheStatus === 'ready' && (asked.revision === undefined || ref.selectedRevision.displayRevision === asked.revision))
          .sort((a, b) => (b.selectedRevision.displayRevision as number) - (a.selectedRevision.displayRevision as number));
        for (const ref of refs) {
          try { const { saved } = await d.cache.open(ref.objectId); return { result: { ok: true as const, value: saved.cachedPayload }, cachedAt: null, offline: true }; } catch { /* try the next pin */ }
        }
        return read;
      }

      case 'runStart': {
        const payload = validate(publicItemPayloadSchema, call.payload, d.limits);
        if (payload.document.kind !== 'timeline') return { status: 'blocked', reason: 'Only timelines can start a Run.' };
        if (!d.launcher) return { status: 'blocked', reason: 'Runs are not available right now.' };
        const choice = call.choice === 'replace' || call.choice === 'keep' ? call.choice : null;
        // Never trust the renderer's copy: the pinned bundle is read again here (server, or the cache when offline) and must match.
        const read = await d.reads.item({ publicId: payload.publicId, revision: payload.publishedRevision.displayRevision } as never);
        if (!read.result.ok) return { status: 'blocked', reason: 'Could not read this timeline. Try again.' };
        const trusted = read.result.value;
        if (trusted.document.kind !== 'timeline') return { status: 'blocked', reason: 'Only timelines can start a Run.' };
        const ref = await d.cache.save(trusted);
        const { saved } = await d.cache.open(ref.objectId);
        const started = await d.launcher.start({ bundle: trusted.document.payload, timelineRevision: saved.source, publishedOrigin: trusted.publishedRevision }, choice);
        if (started.status === 'started') return { status: 'started' };
        return started.status === 'blocked' ? { status: 'blocked', reason: started.reason }
          : { status: 'blocked', reason: 'A Run is already active.', competing: true };
      }

      case 'publish': {
        const body = exact(call.body, ['request', 'preview', 'expectedPostRowVersion', 'draftVersion', 'successorOf']);
        const request = validate(publishRequestSchema, body.request, d.limits), preview = validate(publicItemPayloadSchema, body.preview, d.limits);
        const successorOf = body.successorOf === null ? null : uuid(body.successorOf);
        // No build code that goes public (the document's or any history snapshot's) may carry private notes or import account data.
        if (publicCodeProblem({ document: request.payload, history: preview.history ?? [] }, request.includeNotes)) {
          throw new MarketplaceLocalError('CONFLICT', 'This build code still carries private notes or account details. Refresh the source and try again.');
        }
        const cloud = await ensureSynced(need(), request.source.objectId, request.source.revisionId);
        let synced = { ...request, source: { ...request.source, payloadHash: cloud.hash as never, fallbackSnapshotHash: cloud.hash as never } }, shown = preview;
        if (request.payload.kind === 'timeline' && cloud.payload !== undefined) {
          // The site publishes only the bundle in the cloud copy. The same timeline revision built again (a restart) differs only in its
          // bundle id; publish the cloud bundle then. A different timeline is a changed source.
          const stored = validate(timelineBundleSchema, cloud.payload, d.limits);
          if (canonicalJson(stored) !== canonicalJson(request.payload.payload)) {
            if (canonicalJson(stored.timeline) !== canonicalJson(request.payload.payload.timeline)) throw new MarketplaceLocalError('CONFLICT', 'Source changed. Review it before you publish.');
            const document = { kind: 'timeline' as const, payload: stored };
            synced = { ...synced, payload: document }; shown = { ...preview, document };
          }
        }
        const send = () => authed<unknown>('publish', { request: synced, preview: shown, expectedPostRowVersion: int(body.expectedPostRowVersion), draftVersion: int(body.draftVersion), successorOf });
        const first = await send();
        // A first publish has no creator profile yet: make one from the account name (the person can rename it in My creator profile), then send once more.
        if (!first.ok && first.code === 'VALIDATION_FAILED' && !stored('creator-ids') && d.accountName) {
          const name = (d.accountName() ?? '').trim().slice(0, 80) || 'Creator', account = need(), slug = `${slugify(name)}-${account.slice(0, 6)}`;
          const made = await authed<{ creatorId: string }>('profile', { action: 'write', slug, displayName: name, bio: '', links: [], avatar: null, idempotencyKey: randomUUID() });
          if (made.ok && typeof made.value?.creatorId === 'string') { await keep('creator-ids', { creatorId: made.value.creatorId, slug }); return send(); }
        }
        return first;
      }
      case 'publishSources': {
        const kinds = call.kind === undefined ? [...PUBLISH_KINDS] : [oneOf(call.kind, PUBLISH_KINDS)];
        // Library builds become publishable once frozen (with their build code); give that a bounded moment before listing.
        if (kinds.includes('build') && d.refreshLibrary) await Promise.race([d.refreshLibrary().catch(() => undefined), new Promise(r => setTimeout(r, 60_000))]);
        const out = [];
        if (d.documents) for (const row of d.documents.list(false)) {
          if (!kinds.includes(row.kind as never) || d.notPublishable?.(row.objectId)) continue;
          try {
            const prepared = await publishable(row.objectId, row.kind);
            if (!prepared) continue;
            const ref = d.documents.revisionRef(row.objectId, prepared.doc.revision.revisionId);
            out.push({ kind: row.kind, objectId: row.objectId, title: prepared.payload.title ?? 'Untitled', ref, localRevision: ref.revisionId.slice(0, 8),
              document: prepared.document, history: [], credits: row.kind === 'timeline' ? prepared.payload.credits ?? [] : [],
              defaults: { economy: 'trade', hardcore: false, ruthless: false, budget: 'not_stated', leagueStarter: false, tags: [], mainSkill: '', ...derived(prepared.document) }, existing: null });
          } catch { /* a document that is not publishable (local-only Build, invalid) is left out of the picker */ }
        }
        return out;
      }
      case 'publicationStatus': return authed('publication-status', { idempotencyKey: str(call.idempotencyKey, 128, 1) });
      case 'requestReview': {
        if (!isId('hash', call.reviewedHash)) throw bad();
        return review({ operation: 'request-review', submissionId: uuid(call.submissionId), reviewedHash: call.reviewedHash });
      }

      case 'profile': return d.api.request('profile', call.publicId !== undefined ? { action: 'read', publicId: publicUuid(call.publicId) } : { action: 'read', creatorId: uuid(call.creatorId) }, null);
      case 'ownCreator': return stored<{ creatorId: string; slug: string }>('creator-ids');
      case 'saveProfile': {
        const account = need(), name = str(call.displayName, 80, 1).trim(), bio = str(call.bio, 1000);
        if (!Array.isArray(call.links) || call.links.length > 5) throw bad();
        const links = call.links.map(httpsUrl);
        const slug = stored<{ slug: string }>('creator-ids')?.slug ?? `${slugify(name)}-${account.slice(0, 6)}`;
        const result = await authed<{ creatorId: string }>('profile', { action: 'write', slug, displayName: name, bio, links, avatar: null, idempotencyKey: randomUUID() });
        if (result.ok && typeof result.value?.creatorId === 'string') await keep('creator-ids', { creatorId: result.value.creatorId, slug });
        return result;
      }
      case 'follow': return authed('follow', { creatorId: uuid(call.creatorId), following: call.following === true, idempotencyKey: randomUUID() });
      case 'follows': return authed('follows', {});
      case 'creatorPreference':
        return call.showNewPostDot === undefined ? authed('creator-preference', { action: 'read' })
          : authed('creator-preference', { action: 'write', showNewPostDot: call.showNewPostDot === true, idempotencyKey: randomUUID() });

      case 'verification': {
        const known = stored<Verification>('verification');
        return known ? applicationStatus(known.applicationId) : { ok: true, value: null };
      }
      case 'saveVerificationDraft': await keep('verification-draft', draftOf(call.draft)); return null;
      case 'verificationDraft': return stored<DraftIn>('verification-draft');
      case 'submitVerification': {
        const draft = draftOf(call.draft), stamp = validate(leagueStampSchema, call.stamp, d.limits);
        const evidenceUrl = httpsUrl(draft.profileLink);
        if (!draft.publicName.trim() || (draft.alternative && !draft.explanation.trim())) throw bad();
        const known = stored<Verification>('verification');
        let applicationId: string | null = null, expectedCaseVersion: number | null = null;
        if (known) {
          const status = await applicationStatus(known.applicationId);
          if (!status.ok) return status;
          applicationId = status.value.applicationId; expectedCaseVersion = status.value.caseVersion;
        }
        const result = await review<{ applicationId: string; publicNonce: string; caseVersion: number }>({ operation: 'apply-verification', publicName: draft.publicName.trim(), evidenceUrl, stamp,
          idempotencyKey: randomUUID(), reviewMode: draft.alternative ? 'identity_review' : 'public_proof', explanation: draft.explanation, applicationId, expectedCaseVersion });
        if (result.ok && typeof result.value?.applicationId === 'string') await keep('verification', { applicationId: result.value.applicationId });
        return result;
      }
      case 'checkProof': {
        const known = stored<Verification>('verification');
        if (!known) throw bad('Submit verification first.');
        const status = await applicationStatus(known.applicationId);
        if (!status.ok) return status;
        return review({ operation: 'check-proof', applicationId: status.value.applicationId, expectedCaseVersion: status.value.caseVersion });
      }

      case 'posts': return authed('posts', {});
      case 'analytics': return authed('analytics', { postId: uuid(call.postId), revisionId: call.revisionId === null ? null : uuid(call.revisionId), bundleId: null });
      case 'feedbackState': {
        const account = need(), current = thread(account, call.threadId);
        const body = { threadId: current.threadId, expectedRowVersion: int(current.rowVersion, 1),
          read: call.read ?? !!current.readAt, resolved: call.resolved ?? !!current.resolvedAt,
          fixedRevision: call.fixedRevision === undefined ? (typeof current.fixedRevision === 'number' ? current.fixedRevision : null) : call.fixedRevision, idempotencyKey: randomUUID() };
        if (typeof body.read !== 'boolean' || typeof body.resolved !== 'boolean' || (body.fixedRevision !== null && !Number.isSafeInteger(body.fixedRevision))) throw bad();
        const result = await authed('feedback-state', body);
        if (result.ok) await refreshThread(current);
        return result;
      }
      case 'feedbackMessage': {
        const account = need(), current = thread(account, call.threadId);
        const result = await authed('feedback-message', { threadId: current.threadId, text: str(call.text, 2000, 1), idempotencyKey: str(call.idempotencyKey, 128, 1) });
        if (result.ok) await refreshThread(current);
        return result;
      }

      case 'report': {
        const body = exact({ request: call.request, revisionId: call.revisionId, creatorId: call.creatorId, evidenceUrl: call.evidenceUrl }, ['request', 'revisionId', 'creatorId', 'evidenceUrl']);
        const creatorId = body.creatorId === null ? null : uuid(body.creatorId), revisionId = body.revisionId === null ? null : uuid(body.revisionId);
        const evidenceUrl = body.evidenceUrl === null ? null : httpsUrl(body.evidenceUrl);
        let request: unknown;
        if (creatorId) {
          if (revisionId) throw bad();
          const r = exact(body.request, ['reason', 'text', 'idempotencyKey']);
          request = { reason: str(r.reason, 128, 1), text: str(r.text, 2000), idempotencyKey: str(r.idempotencyKey, 128, 1) };
        } else {
          if (!revisionId) throw bad();
          request = validate(reportRequestSchema, body.request, d.limits);
        }
        return authed('report', { request, revisionId, creatorId, evidenceUrl });
      }
      case 'modQueue': return review({ operation: 'queue', kind: oneOf(call.kind, ['report', 'publication', 'verification'] as const), status: oneOf(call.status, ['open', 'decided'] as const) });
      case 'modCase': return review({ operation: 'case', caseId: uuid(call.caseId) });
      case 'modClaim': return review({ operation: 'claim', caseId: uuid(call.caseId), expectedCaseVersion: int(call.expectedCaseVersion, 1) });
      case 'modDecide':
        return review({ operation: 'decide', caseId: uuid(call.caseId), expectedCaseVersion: int(call.expectedCaseVersion, 1),
          action: oneOf(call.action, ['keep_content', 'remove_listing', 'restore_listing', 'approve_publication', 'request_changes', 'verify_identity', 'decline_verification'] as const),
          reason: str(call.reason, 2000, 1), expectedTargetVersion: call.expectedTargetVersion === null ? null : int(call.expectedTargetVersion) });
    }
  };
}
