// Builds the Marketplace services (store, API, cache, outbox, sync, private inbox, reads) and registers their IPC.
import { isId, parseId, type ApiResult, type CompletionReceipt } from '@pom/mastery-contracts';
import type { RunPublicServices } from '../../shared/run/services.js';
import { MarketplaceApi, type MarketplaceTransport, type Operation } from '../marketplace/api.js';
import { PublicCache } from '../marketplace/cache.js';
import { registerMarketplaceIpc } from '../marketplace/ipc.js';
import { MarketplaceOutbox } from '../marketplace/outbox.js';
import { PrivateMessageCache } from '../marketplace/privateCache.js';
import { MarketplaceReads } from '../marketplace/reads.js';
import { MarketplaceStore } from '../marketplace/store.js';
import { MarketplaceSync } from '../marketplace/sync.js';
import type { MasteryContext, RunLauncher } from './context.js';
import { createExtraCalls } from './marketplaceCalls.js';
import { createAdmission } from './admission.js';
import { contentHash } from '../../shared/timelines/adapters/common.js';
import type { TimelineService } from '../timelines/service.js';
import type { LibrarySources } from './libraryBuilds.js';
import type { AtlasWiring } from './atlas.js';
import { planMechanics } from './listing.js';
import type { AtlasPlan } from '@pom/mastery-contracts';

export type MarketplaceWiring = {
  outbox: MarketplaceOutbox;
  /** Hand a finished Run's receipt to the outbox. `evidence` is the receipt's minimal final-trigger evidence (review fix 3). */
  deliverReceipt(receipt: CompletionReceipt, accountId: string, evidence?: unknown): Promise<void>;
  /** What the Run window's vote / feedback buttons call (plugged into the Run wiring by index.ts). */
  runServices: RunPublicServices;
  /** A saved public item (Saved items id) as a frozen Timeline source, from its pinned cached copy. */
  savedSource(objectId: import('@pom/mastery-contracts').ObjectId): Promise<import('@pom/mastery-contracts').FrozenSource>;
  dispose(): void;
};

const DRAIN_EVERY_MS = 30_000;

export async function wireMarketplace(ctx: MasteryContext, deps: { launcher: RunLauncher | null; timelines?: TimelineService | null;
  /** The Builds library frozen as Documents-store builds (the Publish picker lists them). */
  library?: LibrarySources | null;
  /** The Atlas registry: a plan's mechanics are the taxonomy targets its allocated nodes belong to. */
  atlas?: AtlasWiring | null }): Promise<MarketplaceWiring> {
  const store = new MarketplaceStore(ctx.userDataDir, ctx.limits);
  await store.init();
  ctx.onQuit(() => store.close());

  // The account service renews the access token asynchronously; the API wants it synchronously. Renew just before each signed-in call.
  let token = '';
  const accountId = () => ctx.accounts.service.user?.id ?? null;
  // Admission: installation id + signed app claim on every call, the approved clearance on the one request it was granted for.
  const admission = ctx.appChannel ? createAdmission({
    origin: ctx.siteOrigin, allowLoopback: !ctx.isPackaged, limits: ctx.limits, installation: ctx.appChannel.installation, sign: ctx.appChannel.sign,
    accountId, accessToken: () => ctx.accounts.service.accessToken().catch(() => null),
    askUser: () => { ctx.revealAndPush('mastery:push:human-check', { kind: 'ai' }, false); },
    onExpired: () => { const w = ctx.mainWindow(); if (!w || w.isDestroyed()) return false; ctx.push('mastery:push:human-check-expired', {}); return true; },
    // Test/dev only: a short wait for the expiry flow (a packaged app always waits the default 3 minutes).
    ...(!ctx.isPackaged && Number(process.env.POM_HUMAN_CHECK_WAIT_MS) > 0 ? { aiTimeoutMs: Number(process.env.POM_HUMAN_CHECK_WAIT_MS) } : {}),
    // A refused Marketplace request shows the banner in the main window (no reveal, no modal).
    onBlocked: pending => { ctx.push('mastery:push:network-paused', { pending }); },
    // After the pass and Continue, the paused vote/save is sent once more with the approved clearance.
    resume: async (operation, body) => {
      const entry = outboxRef?.entries().find(e => e.operation === operation && e.state === 'review' && JSON.stringify(e.body) === JSON.stringify(body));
      if (!entry || !outboxRef) return null;
      await outboxRef.confirm(entry.id); await outboxRef.drain();
      return outboxRef.entries().find(e => e.id === entry.id) ?? null;
    },
  }) : null;
  let outboxRef: MarketplaceOutbox | null = null;
  if (ctx.humanCheckSlot) ctx.humanCheckSlot.admission = admission;
  const raw = new MarketplaceApi(ctx.siteOrigin, () => {
    const id = accountId();
    return id && token ? { accountId: id, accessToken: token } : null;
  }, ctx.limits, fetch, admission ? (operation, body, account) => admission.headers(operation, body, account) : undefined);
  const api: MarketplaceTransport = {
    async request<T>(operation: Operation, body: unknown, account: string | null): Promise<ApiResult<T>> {
      if (account !== null) token = await ctx.accounts.service.accessToken();
      const result = await raw.request<T>(operation, body, account);
      admission?.note(operation, body, account, result);
      return result;
    },
  };

  const cache = new PublicCache(store, api);
  const outbox = new MarketplaceOutbox(store, api);
  outboxRef = outbox;
  const sync = new MarketplaceSync(store, api, outbox, cache, ctx.documents);
  const privateCache = new PrivateMessageCache(store, api, outbox);
  const reads = new MarketplaceReads(store, api, () => outbox.currentAccount());

  const drain = () => { void outbox.drain().catch(() => undefined); };
  const activate = async () => {
    const id = accountId();
    const next = id && isId('object', id) ? id : null;
    if (next === outbox.currentAccount()) return;
    privateCache.accountChanged(); admission?.accountChanged();
    await outbox.activate(next);
    if (next) {
      await outbox.refreshPreference().catch(() => undefined); // Run counting consent; without it receipts are not queued
      drain();
    }
  };
  void activate().catch(() => undefined);
  const stopListening = ctx.accounts.service.onChange(() => { void activate().catch(() => undefined); });
  const timer = setInterval(drain, DRAIN_EVERY_MS);
  timer.unref();

  const extra = createExtraCalls({ api, reads, cache, store, outbox, privateCache, launcher: deps.launcher, limits: ctx.limits,
    documents: ctx.documents, sync, accountName: () => ctx.accounts.service.user?.name ?? null, ...(deps.timelines ? { bundleFor: (objectId, revisionId) => deps.timelines!.bundle(objectId, revisionId) } : {}),
    ...(deps.library ? { refreshLibrary: () => deps.library!.refresh() } : {}),
    ...(deps.atlas ? { notPublishable: (id: string) => deps.atlas!.isSavedCopy(id) } : {}),
    ...(deps.atlas ? { mechanicsOf: (plan: AtlasPlan) => planMechanics(plan, ref => { try { return deps.atlas!.registry.get(ref).taxonomy; } catch { return null; } }) } : {}) });
  const unregister = registerMarketplaceIpc(ctx.ipc, { cache, sync, outbox, privateCache, extra }, ctx.isMainSender);

  const entryOf = (id: string) => outbox.entries().find(entry => entry.id === id);
  const runServices: RunPublicServices = {
    signedIn: () => accountId() !== null,
    async vote(postId, direction) {
      if (!accountId()) return 'signin';
      const queued = await outbox.vote(parseId('post', postId), direction);
      await outbox.drain();
      const entry = entryOf(queued.id), result = entry?.result as ApiResult<{ net: number }> | null | undefined;
      if (entry?.state === 'done' && result?.ok) return { net: result.value.net };
      throw new Error('The vote was not saved.');
    },
    async saveFeedback(request, allowReplies) { await privateCache.saveDraft(request.idempotencyKey, { request, allowReplies, bundleId: null }); },
    async sendFeedback(request, allowReplies) {
      if (!accountId()) return 'signin';
      const draft = await outbox.draft('feedback', { request, allowReplies, bundleId: null }, request.idempotencyKey);
      await outbox.confirm(draft.id); await outbox.drain();
      const entry = entryOf(draft.id), result = entry?.result as ApiResult<unknown> | null | undefined;
      if (entry?.state === 'done' && result?.ok) return 'sent';
      if (result && !result.ok && ['UNAVAILABLE', 'SOURCE_NOT_OWNED', 'NOT_FOUND'].includes(result.code)) return 'creator_unavailable';
      return 'rejected';
    },
  };
  // The human check for the one request the site last asked a check for. Main window only.
  const NETWORK_CHANNEL = 'mastery:network';
  // Escape for the open check, caught in main: a key pressed while focus is inside the provider's cross-origin frame (the Turnstile
  // checkbox) never reaches the renderer, but before-input-event sees every key of the window, frames included (judge #61).
  let checkOpen = false;
  const watched = new WeakSet<object>();
  const watchEscape = () => {
    const w = ctx.mainWindow(); if (!w || w.isDestroyed() || watched.has(w.webContents)) return;
    watched.add(w.webContents);
    w.webContents.on('before-input-event', (event, key) => {
      if (!checkOpen || key.type !== 'keyDown' || key.key !== 'Escape') return;
      event.preventDefault(); // one path only: the renderer closes the dialog as its X does
      ctx.push('mastery:push:human-check-escape', {});
    });
  };
  // Keys that reach the provider's frame without passing before-input-event (DevTools-protocol / automation keys, judge #61 repeat):
  // while the check is open, a passive keydown listener in each child frame records Escape and main reads it back. An OS key never gets
  // there (the handler above prevents it), so the dialog still closes through one path per key.
  const FRAME_ESC = `(() => { if (!window.__pomEscWatch) { window.__pomEscWatch = true; window.__pomEsc = false; addEventListener('keydown', e => { if (e.key === 'Escape') window.__pomEsc = true; }, true); } const v = window.__pomEsc === true; window.__pomEsc = false; return v; })()`;
  let escPoll: ReturnType<typeof setInterval> | null = null;
  const pollFrames = async () => {
    const w = ctx.mainWindow(); if (!checkOpen || !w || w.isDestroyed()) return;
    const frames = w.webContents.mainFrame.framesInSubtree.filter(f => f !== w.webContents.mainFrame);
    for (const f of frames) {
      try { if (await f.executeJavaScript(FRAME_ESC) === true && checkOpen) { ctx.push('mastery:push:human-check-escape', {}); return; } } catch { /* frame gone or not ready */ }
    }
  };
  const setCheckOpen = (open: boolean) => {
    checkOpen = open;
    if (open) { watchEscape(); if (!escPoll) escPoll = setInterval(() => { void pollFrames(); }, 120); }
    else if (escPoll) { clearInterval(escPoll); escPoll = null; }
  };
  ctx.ipc.handle(NETWORK_CHANNEL, async (event, input) => {
    try {
      if (!ctx.isMainSender(event) || !admission) throw new Error('Unavailable.');
      const c = (input ?? {}) as { schemaVersion?: number; method?: string; accessible?: unknown; token?: unknown; open?: unknown };
      if (c.schemaVersion !== 1) throw new Error('Unsupported.');
      if (c.method === 'begin') return { ok: true, value: await admission.begin(c.accessible === true) };
      if (c.method === 'complete') return { ok: true, value: await admission.complete(String(c.token ?? '')) };
      if (c.method === 'resume') return { ok: true, value: await admission.resume() };
      if (c.method === 'hello') return { ok: true, value: admission.hello() };
      if (c.method === 'dialog') { setCheckOpen(c.open === true); return { ok: true, value: { status: 'none' } }; }
      if (c.method === 'cancel') { admission.cancel(); return { ok: true, value: { status: 'none' } }; }
      throw new Error('Unsupported.');
    } catch { return { ok: false, error: { code: 'OPERATION_FAILED', message: 'The check is unavailable. Try again later.' } }; }
  });
  return {
    outbox, runServices,
    async savedSource(objectId) {
      const { saved } = await cache.open(objectId);
      const document = saved.cachedPayload.document;
      if (!['build', 'atlas', 'filter', 'notes', 'checklist'].includes(document.kind)) throw new Error('This saved item cannot be a timeline source.');
      // The cache pins the document by the hash of its stored JSON text; a timeline source is verified by the canonical content hash
      // of the snapshot (adapters/common.ts), so the reference handed to the timeline carries that one.
      const snapshot = { kind: document.kind, payload: document.payload };
      return { ref: { ...saved.source, fallbackSnapshotHash: await contentHash(snapshot) }, fallbackSnapshot: snapshot as never };
    },
    async deliverReceipt(receipt, account, evidence) {
      const entry = await outbox.receipt(receipt, account, evidence);
      if (entry) { drain(); return; }
      // Not queued: acknowledge only when the server preference explicitly says runs are not counted; otherwise keep it pending and retry.
      const preference = outbox.preference();
      if (preference && preference.countRuns === false) return;
      throw new Error('Run receipt kept pending: the Marketplace could not queue it yet (account or run-count preference unknown).');
    },
    dispose() { clearInterval(timer); stopListening(); unregister(); ctx.ipc.removeHandler(NETWORK_CHANNEL); },
  };
}
