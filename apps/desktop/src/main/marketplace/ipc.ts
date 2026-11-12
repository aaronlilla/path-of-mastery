import { parseId } from '@pom/mastery-contracts';
import { MARKETPLACE_CHANNEL, type MarketplaceCall } from '../../renderer/marketplace/client.js';
import { PublicCache } from './cache.js';
import { MarketplaceSync } from './sync.js';
import { MarketplaceOutbox } from './outbox.js';
import { PrivateMessageCache } from './privateCache.js';
import { MarketplaceLocalError } from './store.js';
type Registrar = { handle(channel: string, handler: (event: unknown, input: unknown) => Promise<unknown>): void; removeHandler(channel: string): void };
const fields: Record<MarketplaceCall['method'], string[]> = {
  saved: [], save: ['payload'], open: ['objectId'], download: ['objectId'], remove: ['objectId'], undoRemove: ['objectId'], previewUpdate: ['objectId'], applyUpdate: ['objectId', 'expected', 'payload'],
  collections: [], createCollection: ['title', 'stamp'], member: ['collectionId', 'saveId', 'present'], enrollSave: ['objectId', 'expectedRowVersion'], enrollCollection: ['objectId', 'expectedRowVersion'],
  vote: ['postId', 'direction'], activity: [], cancel: ['requestId'], retry: ['requestId'], saveFeedback: ['draftId', 'draft'], feedbackDrafts: [], inbox: [], refreshInbox: ['view', 'threadId'],
  // Handled by `services.extra` (main/mastery/marketplaceCalls.ts), which validates each body itself.
  feed: ['request'], count: ['request'], item: ['request'], runStart: ['payload', 'choice'],
  publish: ['body'], publishSources: ['kind'], publicationStatus: ['idempotencyKey'], requestReview: ['submissionId', 'reviewedHash'],
  profile: ['creatorId', 'publicId'], ownCreator: [], saveProfile: ['displayName', 'bio', 'links'], follow: ['creatorId', 'following'], follows: [], creatorPreference: ['showNewPostDot'],
  verification: [], saveVerificationDraft: ['draft'], verificationDraft: [], submitVerification: ['draft', 'stamp'], checkProof: [],
  posts: [], analytics: ['postId', 'revisionId'], feedbackState: ['threadId', 'read', 'resolved', 'fixedRevision'], feedbackMessage: ['threadId', 'text', 'idempotencyKey'],
  report: ['request', 'revisionId', 'creatorId', 'evidenceUrl'], modQueue: ['kind', 'status'], modCase: ['caseId'], modClaim: ['caseId', 'expectedCaseVersion'],
  modDecide: ['caseId', 'expectedCaseVersion', 'action', 'reason', 'expectedTargetVersion'],
};
type ExtraMethod = 'feed' | 'count' | 'item' | 'runStart' | 'publish' | 'publishSources' | 'publicationStatus' | 'requestReview' | 'profile' | 'ownCreator' | 'saveProfile' | 'follow' | 'follows'
  | 'creatorPreference' | 'verification' | 'saveVerificationDraft' | 'verificationDraft' | 'submitVerification' | 'checkProof' | 'posts' | 'analytics' | 'feedbackState'
  | 'feedbackMessage' | 'report' | 'modQueue' | 'modCase' | 'modClaim' | 'modDecide';
/** Reads, publication, creator and moderation calls that go to the site. Throws MarketplaceLocalError for a malformed body. */
export type ExtraCalls = (call: Extract<MarketplaceCall, { method: ExtraMethod }>) => Promise<unknown>;
export function registerMarketplaceIpc(ipc: Registrar, services: { cache: PublicCache; sync: MarketplaceSync; outbox: MarketplaceOutbox; privateCache: PrivateMessageCache; extra?: ExtraCalls }, isTrustedSender: (event: unknown) => boolean): () => void {
  const { cache, sync, outbox, privateCache, extra } = services;
  const settle = () => void outbox.drain().catch(() => undefined);
  ipc.handle(MARKETPLACE_CHANNEL, async (event, input) => {
    try {
      if (!isTrustedSender(event) || !input || typeof input !== 'object' || Array.isArray(input)) throw new MarketplaceLocalError('INVALID', 'Marketplace access is unavailable.');
      const data = input as Record<string, unknown>;
      if (data.schemaVersion !== 1 || typeof data.method !== 'string' || !Object.hasOwn(fields, data.method)) throw new MarketplaceLocalError('INVALID', 'Unsupported Marketplace request.');
      if (Object.keys(data).some(key => !['schemaVersion', 'method', ...fields[data.method as MarketplaceCall['method']]].includes(key))
        || Buffer.byteLength(JSON.stringify(data)) > cache.store.limits.maxBytes) throw new MarketplaceLocalError('INVALID', 'Invalid Marketplace request.');
      const call = input as MarketplaceCall; let value: unknown;
      switch (call.method) {
        case 'saved': value = cache.list(); break;
        case 'save': value = await cache.save(call.payload); break;
        case 'open': value = await cache.open(parseId('object', call.objectId)); break;
        case 'download': value = await cache.download(parseId('object', call.objectId)); break;
        case 'remove': value = await cache.remove(parseId('object', call.objectId)); break;
        case 'undoRemove': {
          const ref = cache.store.get<import('./cache.js').SavedReference>('removed', parseId('object', call.objectId));
          if (!ref) throw new MarketplaceLocalError('INVALID', 'Removed reference was not found.'); await cache.undoRemove(ref); break;
        }
        case 'previewUpdate': value = await cache.previewUpdate(parseId('object', call.objectId)); break;
        case 'applyUpdate': await cache.applyUpdate(parseId('object', call.objectId), call.expected, call.payload); break;
        case 'collections': value = cache.collections(); break;
        case 'createCollection': value = await cache.createCollection(call.title, call.stamp); break;
        case 'member':
          if (typeof call.present !== 'boolean') throw new MarketplaceLocalError('INVALID', 'Invalid collection membership.');
          await cache.setMember(parseId('object', call.collectionId), parseId('object', call.saveId), call.present); break;
        case 'enrollSave': value = await sync.enrollSave(parseId('object', call.objectId), call.expectedRowVersion); settle(); break;
        case 'enrollCollection': await sync.enrollCollection(parseId('object', call.objectId), call.expectedRowVersion); settle(); break;
        case 'vote': {
          // The vote UI needs the outcome, so send now and answer with the entry as it stands afterwards.
          const queued = await outbox.vote(parseId('post', call.postId), call.direction);
          await outbox.drain(); if (outbox.entries().find(entry => entry.id === queued.id)?.state === 'queued') await outbox.drain();
          value = outbox.entries().find(entry => entry.id === queued.id) ?? queued; break;
        }
        case 'activity': value = outbox.entries(); break;
        case 'cancel': await outbox.cancel(call.requestId); break;
        case 'retry': await outbox.confirm(call.requestId); settle(); break;
        case 'saveFeedback': await privateCache.saveDraft(call.draftId, call.draft); break;
        case 'feedbackDrafts': value = privateCache.drafts(); break;
        case 'inbox': value = privateCache.threads(); break;
        case 'refreshInbox':
          if (!['received', 'sent', 'unread', 'resolved'].includes(call.view)) throw new MarketplaceLocalError('INVALID', 'Invalid inbox view.');
          await privateCache.refresh(call.view, call.threadId); break;
        default:
          if (!extra) throw new MarketplaceLocalError('INVALID', 'This Marketplace request is unavailable.');
          value = await extra(call); break;
      }
      return { ok: true, value: value ?? null };
    } catch (error) { return { ok: false, error: { code: error instanceof MarketplaceLocalError ? error.code : 'OPERATION_FAILED',
      message: error instanceof MarketplaceLocalError ? error.message : 'Marketplace operation failed. Local data is retained.' } }; }
  });
  return () => ipc.removeHandler(MARKETPLACE_CHANNEL);
}
