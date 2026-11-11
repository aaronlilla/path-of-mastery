// The Marketplace's request admission in the main process.
//  - every site call carries the installation id and, when signed in, the signed app-channel claim;
//  - a call the site answered with HUMAN_CHECK_REQUIRED is remembered as the one blocked request;
//  - the human check (challenge, provider token, verify, admit) is bound to that exact request, and only a request with
//    the same hash carries the approved clearance (once). Local Run, log and edit work never go through here.
import { createHash, randomUUID } from 'node:crypto';
import { createNetworkClient, type GateChallenge } from '../networkGate/client.js';
import { isId, type ApiResult, type NetworkClearance, type PendingIntent, type PublishedRevisionRef, type ValidationLimits } from '@pom/mastery-contracts';
import type { Operation } from '../marketplace/api.js';
import { aiBinding, createAiClearances, type AiBinding, type AiRoute } from '../aiGate/clearance.js';
import type { AiActor } from '../aiGate/gate.js';

/** Same hash the site computes: keys sorted by localeCompare, sha256 of the JSON. */
export function siteHash(value: unknown): string {
  const stable = (item: unknown): unknown => Array.isArray(item) ? item.map(stable)
    : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)])) : item;
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}
type Rec = Record<string, any>;
/** The publish and review routes hash the body; the community routes hash {operation, body}. */
export const requestHashFor = (operation: Operation, body: unknown): string =>
  siteHash(operation === 'publish' || operation === 'review' ? body : { operation, body });

/** The words the human-check dialog's "Pending:" line uses for a paused request. */
export function pendingLabel(operation: Operation | 'ai'): string {
  switch (operation) {
    case 'ai': return 'AI request';
    case 'vote': return 'Vote';
    case 'saves': case 'collections': return 'Save';
    case 'receipt': return 'Run count';
    case 'publish': case 'review': return 'Publish';
    case 'report': return 'Report';
    case 'feedback': case 'feedback-message': case 'feedback-state': case 'feedback-replies': return 'Feedback';
    case 'feed': case 'item': case 'count': case 'profile': return 'Load Marketplace';
    case 'follow': return 'Follow';
    default: return 'Marketplace request';
  }
}

/** What the human check is bound to. Null when the request has no exact revision to bind (those cannot be resumed after a check).
 *  A vote carries only its post id, so its revision comes from the last feed/item answer the app read (`revisionOf`). */
export function intentFor(operation: Operation, body: unknown, account: string, revisionOf?: (postId: string) => PublishedRevisionRef | null): PendingIntent | null {
  const b = (body ?? {}) as Rec;
  let target: unknown, key: unknown, op: PendingIntent['operation'], policy: PendingIntent['resumePolicy'];
  switch (operation) {
    case 'vote': target = typeof b.request?.postId === 'string' ? revisionOf?.(b.request.postId) ?? null : null; key = b.request?.idempotencyKey; op = 'vote'; policy = 'once'; break;
    case 'publish': target = b.request?.source; key = b.request?.idempotencyKey; op = 'publish'; policy = 'return_to_review'; break;
    case 'feedback': target = b.request?.publishedRevision; key = b.request?.idempotencyKey; op = 'feedback'; policy = 'return_to_review'; break;
    case 'receipt': target = b.receipt?.publishedRevision; key = b.receipt?.idempotencyKey; op = 'save'; policy = 'once'; break;
    case 'saves': target = b.publishedRevision; key = b.idempotencyKey; op = 'save'; policy = 'once'; break;
    default: return null;
  }
  if (!target || typeof key !== 'string' || !key) return null;
  const hash = requestHashFor(operation, body);
  if (!isId('hash', hash)) return null;
  return { schemaVersion: 1, requestId: randomUUID(), idempotencyKey: key, accountBinding: account, target: target as PendingIntent['target'], requestHash: hash, operation: op, resumePolicy: policy };
}

export type CheckStage =
  | { status: 'none' }
  | { status: 'ready'; accessibleAvailable: boolean; presentationUrl: string; accessibleUrl: string | null; pending: string }
  | { status: 'unavailable' }
  /** The paused request's wait ran out before the check passed (or nothing is pending any more): the dialog says so and offers Retry. */
  | { status: 'expired' }
  /** Continue sent the request but its check no longer counts (the clearance ran out, or the site refused it): the request is kept and
   *  the dialog asks for a fresh check ("Your check expired. Complete it again."); Continue then sends it once. */
  | { status: 'again' }
  /** Continue sent the request and the site answered with something other than a check refusal (service down, not Pro, ...). */
  | { status: 'sendFailed'; code: string }
  | { status: 'passed'; resumed?: { operation: Operation; body: unknown; entry: unknown } };

export type AdmissionDeps = {
  origin: string; allowLoopback: boolean; limits: ValidationLimits;
  installation: string;
  /** Signed app-channel claim for a route (aiGate/proof.ts). */
  sign(route: string, body: unknown, account: string): Record<string, string>;
  accountId(): string | null;
  accessToken(): Promise<string | null>;
  fetch?: typeof fetch;
  /** Asks the renderer to open the human check dialog (it then calls begin/complete, or cancel). */
  askUser?(): void;
  /** A Marketplace request was refused with HUMAN_CHECK_REQUIRED: show the banner naming it (no dialog by itself). */
  onBlocked?(pending: string): void;
  /** After a passed check and Continue: send the paused vote/save once more (resumePolicy 'once'). */
  resume?(operation: Operation, body: unknown): Promise<unknown>;
  now?: () => number;
  /** How long an AI request waits for an unanswered check (default 3 min). */
  aiTimeoutMs?: number;
  /** Timer seam (tests inject a clock; default setTimeout/clearTimeout). */
  timers?: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
  /** The open check's wait ran out before it passed: the dialog shows "This request expired. Try again." with Retry. Returns false when
   *  no window can show it (the main window is gone): the request is then cancelled as declined. */
  onExpired?(): boolean | void;
};
type Blocked = { operation: Operation; body: unknown; account: string; intent?: PendingIntent | null };
type Approved = { requestHash: string; clearanceId: string; intent: PendingIntent };

export function createAdmission(d: AdmissionDeps) {
  let blocked: Blocked | null = null;
  let open: { intent: PendingIntent; challenge: GateChallenge; sessionId: string | null; ai: AiBinding | null } | null = null;
  // AI human check: one dialog at a time; the AI backend waits on `ai.done`.
  const clearances = createAiClearances(d.now ? { now: d.now } : {});
  // shown: the dialog asked for a challenge (begin); expired: the wait ran out while the dialog was showing (kept until Retry or Cancel).
  let ai: { binding: AiBinding; account: string; intent: PendingIntent; passed: boolean; shown: boolean; expired: boolean; timer: unknown;
    arm(): void; done(ok: boolean): void } | null = null;
  const timers = d.timers ?? { set: (fn: () => void, ms: number) => { const t = setTimeout(fn, ms); t.unref?.(); return t; }, clear: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>) };
  // The published revision of each post the app read (feed/item answers), so a refused vote can be bound to its exact revision.
  const revisions = new Map<string, PublishedRevisionRef>();
  const remember = (ref: unknown) => {
    const r = ref as PublishedRevisionRef | undefined;
    if (!r || typeof r.postId !== 'string') return;
    revisions.delete(r.postId); revisions.set(r.postId, r);
    if (revisions.size > 1000) revisions.delete(revisions.keys().next().value!);
  };
  const revisionOf = (postId: string) => revisions.get(postId) ?? null;
  // Continue on an AI request: resume() waits here for what the retry turned into (sent, refused, or a fresh check needed).
  let cont: { resolve(stage: CheckStage): void } | null = null;
  const settle = (stage: CheckStage) => { const c = cont; cont = null; c?.resolve(stage); };
  let aiQueue: Promise<unknown> = Promise.resolve();
  let approved: Approved | null = null;
  const client = createNetworkClient({
    origin: d.origin, localTest: d.allowLoopback, limits: d.limits, sessionId: null, clientId: null, ...(d.fetch ? { fetch: d.fetch } : {}),
    headers: async body => {
      const account = d.accountId(), token = await d.accessToken();
      if (!account || !token) throw new Error('SIGN_IN_REQUIRED');
      return { authorization: `Bearer ${token}`, 'x-pom-installation': d.installation, ...d.sign('network', body, account) };
    },
  });
  const sameAccount = (account: string) => d.accountId() === account;
  const clientFor = (sessionId: string | null) => sessionId === null ? client : createNetworkClient({
    origin: d.origin, localTest: d.allowLoopback, limits: d.limits, sessionId, clientId: null, ...(d.fetch ? { fetch: d.fetch } : {}),
    headers: async body => {
      const account = d.accountId(), token = await d.accessToken();
      if (!account || !token) throw new Error('SIGN_IN_REQUIRED');
      return { authorization: `Bearer ${token}`, 'x-pom-installation': d.installation, ...d.sign('network', body, account) };
    },
  });

  return {
    /** Headers for one site call (the MarketplaceApi admission hook). */
    async headers(operation: Operation, body: unknown, account: string | null): Promise<Record<string, string>> {
      const headers: Record<string, string> = { 'x-pom-installation': d.installation };
      if (account !== null) Object.assign(headers, d.sign(`marketplace/${operation}`, body, account));
      if (approved && account !== null && sameAccount(approved.intent.accountBinding) && approved.requestHash === requestHashFor(operation, body)) {
        headers['x-pom-clearance'] = approved.clearanceId;
        headers['x-pom-network-intent'] = Buffer.from(JSON.stringify(approved.intent)).toString('base64url');
      }
      return headers;
    },
    /** Called with every site answer: remembers a blocked request, and spends the clearance once its request was sent. */
    note(operation: Operation, body: unknown, account: string | null, result: ApiResult<unknown>): void {
      if (approved && account !== null && approved.requestHash === requestHashFor(operation, body)) approved = null; // one use on the server too
      if (result.ok && (operation === 'feed' || operation === 'item')) {
        const v = result.value as { items?: { publishedRevision?: unknown }[]; publishedRevision?: unknown } | null;
        if (Array.isArray(v?.items)) for (const item of v.items) remember(item?.publishedRevision); else remember(v?.publishedRevision);
      }
      if (!result.ok && result.code === 'HUMAN_CHECK_REQUIRED' && account !== null) { blocked = { operation, body, account }; d.onBlocked?.(pendingLabel(operation)); }
    },
    hasBlocked(): boolean { return blocked !== null && sameAccount(blocked.account); },
    accountChanged(): void {
      blocked = null; open = null; approved = null; clearances.clear();
      if (ai) { const done = ai.done; timers.clear(ai.timer); ai = null; done(false); }
      settle({ status: 'sendFailed', code: 'ACCOUNT_CHANGED' });
    },
    /** A (re)loaded main window's check host says hello. A request still waiting for a check is never dropped because the window that
     *  showed it went away: it is asked again in this window. Returns the paused Marketplace request's label for the banner. */
    hello(): { paused: string | null } {
      if (ai) { ai.passed = false; ai.shown = false; ai.expired = false; open = null; ai.arm(); d.askUser?.(); }
      settle({ status: 'sendFailed', code: 'WINDOW_RELOADED' });
      return { paused: blocked && sameAccount(blocked.account) ? pendingLabel(blocked.operation) : null };
    },
    /** Starts the check for the blocked request. */
    async begin(accessible = false): Promise<CheckStage> {
      let intent: PendingIntent | null, sessionId: string | null = null;
      if (ai) {
        intent = sameAccount(ai.account) ? ai.intent : null; sessionId = ai.binding.sessionId;
        // Retry after an expiry starts a fresh challenge for the same pending request and a fresh wait.
        if (ai.expired) { ai.expired = false; ai.arm(); }
        ai.shown = true;
      }
      else { if (!blocked || !sameAccount(blocked.account)) return { status: 'unavailable' };
        // One intent per paused request: switching to the accessible check (a second challenge) must bind the same pending request.
        if (blocked.intent === undefined) blocked.intent = intentFor(blocked.operation, blocked.body, blocked.account, revisionOf);
        intent = blocked.intent; }
      if (!intent) return { status: 'unavailable' };
      const result = await clientFor(sessionId).challenge(intent, accessible);
      if (!result.ok) return { status: 'unavailable' };
      open = { intent, challenge: result.value.challenge, sessionId, ai: ai ? ai.binding : null };
      return { status: 'ready', accessibleAvailable: result.value.presentation.accessibleUrl !== null,
        presentationUrl: result.value.presentation.url, accessibleUrl: result.value.presentation.accessibleUrl,
        pending: pendingLabel(ai ? 'ai' : blocked!.operation) };
    },
    /** The provider's answer token for the open challenge. Only a server-verified clearance counts as passed. */
    async complete(token: string): Promise<CheckStage> {
      if (ai?.expired) return { status: 'expired' };
      if (!open || (!blocked && !ai) || !sameAccount(open.intent.accountBinding) || typeof token !== 'string' || !token || token.length > 4096) return { status: 'unavailable' };
      const { intent, challenge } = open;
      const c = clientFor(open.sessionId);
      const verified = await c.verify(intent, challenge, token);
      if (!verified.ok) return { status: 'unavailable' };
      const admitted: NetworkClearance = await c.admit(intent, verified.value);
      if (admitted.status !== 'clear' || admitted.requestHash !== intent.requestHash) return { status: 'unavailable' };
      const forAi = open.ai;
      clearances.passed();
      if (forAi && ai) {
        // The waiting AI request is retried only when the person presses Continue.
        clearances.store(ai.account, forAi, admitted.clearanceId, intent, admitted.expiresAt);
        // Passed: the request now waits for Continue (or Keep working locally) with no deadline; the wait timer is cancelled.
        timers.clear(ai.timer); ai.timer = null;
        ai.passed = true; open = null;
        return { status: 'passed' };
      }
      approved = { requestHash: intent.requestHash, clearanceId: admitted.clearanceId, intent };
      open = null;
      return { status: 'passed' };
    },
    /** Continue after a passed check: the paused request is retried exactly once (an AI request, or a vote/save; publish, report
     *  and feedback return to their own review and are sent only by their final action). */
    async resume(): Promise<CheckStage> {
      if (ai) {
        if (ai.expired) return { status: 'expired' };
        if (!ai.passed) return { status: 'unavailable' };
        // Wait for what the retry turns into: sent (passed), refused for the check (again: same request, fresh check), or another answer.
        const outcome = new Promise<CheckStage>(resolve => { cont = { resolve }; });
        const done = ai.done; ai = null; open = null; done(true);
        return outcome;
      }
      const paused = blocked;
      // Nothing pending any more (it was answered, replaced or the account changed): say so, never close silently.
      if (!approved || !paused || !sameAccount(paused.account) || approved.requestHash !== requestHashFor(paused.operation, paused.body)) return { status: 'expired' };
      blocked = null;
      if (approved.intent.resumePolicy === 'once' && d.resume) {
        const entry = await d.resume(paused.operation, paused.body) as { state?: string; result?: { ok?: boolean; code?: string } | null } | null;
        // The check no longer counted when the request went out (the clearance ran out): the note() of that answer paused it again,
        // so the dialog asks for a fresh check and Continue sends it once more.
        if (entry?.result && entry.result.ok === false && entry.result.code === 'HUMAN_CHECK_REQUIRED' && blocked) return { status: 'again' };
        if (!entry || entry.state !== 'done') return { status: 'sendFailed', code: entry?.result && entry.result.ok === false ? String(entry.result.code) : 'NOT_SENT' };
        return { status: 'passed', resumed: { operation: paused.operation, body: paused.body, entry } };
      }
      return { status: 'passed' };
    },
    /** The person chose "Keep working locally" (or closed the dialog): the waiting AI request stays denied. */
    cancel(): void {
      if (ai) { const done = ai.done; timers.clear(ai.timer); ai = null; open = null; clearances.declined(); done(false); }
      settle({ status: 'sendFailed', code: 'CANCELLED' });
    },
    /** What the retry of an AI request returned (aiGate/client.ts). A check refusal drops the dead clearance; when the client is not
     *  asking again, the waiting Continue is told plainly. Any other answer ends the wait with that answer. */
    aiOutcome(route: AiRoute, body: unknown, actor: AiActor, result: ApiResult<unknown>, askingAgain: boolean): void {
      const account = d.accountId(), b = account ? aiBinding(route, body, d.installation, actor) : null;
      const checkRefused = !result.ok && result.code === 'HUMAN_CHECK_REQUIRED';
      if (checkRefused && account && b) clearances.drop(account, b);
      if (checkRefused && askingAgain) return; // the next aiRequire() round resolves the waiting Continue with 'again'
      settle(result.ok ? { status: 'passed' } : { status: 'sendFailed', code: result.code });
    },
    /** Cleared headers for an AI request, when a still-valid clearance exists (reused until it expires). */
    aiCached(route: AiRoute, body: unknown, actor: AiActor): Record<string, string> | null {
      const account = d.accountId(), b = account ? aiBinding(route, body, d.installation, actor) : null;
      return account && b ? clearances.cached(account, b) : null;
    },
    /** The site asked for a human check on this AI request: show the dialog, wait for the answer, return the clearance headers (or null). */
    aiRequire(route: AiRoute, body: unknown, actor: AiActor): Promise<Record<string, string> | null> {
      const account = d.accountId(), b = account ? aiBinding(route, body, d.installation, actor) : null;
      if (!account || !b || !d.askUser) return Promise.resolve(null);
      const run = async (): Promise<Record<string, string> | null> => {
        const hit = clearances.cached(account, b); if (hit) return hit;
        if (!sameAccount(account) || (clearances.coolingDown() && !cont)) { settle({ status: 'sendFailed', code: 'HUMAN_CHECK_REQUIRED' }); return null; }
        for (;;) {
        const ok = await new Promise<boolean>(resolve => {
          const entry: NonNullable<typeof ai> = { binding: b, account, intent: clearances.newIntent(account, b), passed: false, shown: false, expired: false, timer: null,
            arm: () => { timers.clear(entry.timer); entry.timer = timers.set(expire, d.aiTimeoutMs ?? 180_000); },
            done: v => { timers.clear(entry.timer); entry.timer = null; resolve(v); } };
          // The wait ran out before a pass. With the dialog showing, the request is kept and the dialog says it expired (Retry starts
          // over, Keep working locally ends it); with no dialog ever shown, the request is denied as before.
          const expire = () => {
            if (ai !== entry || entry.passed) return;
            entry.timer = null; open = null;
            if (entry.shown && d.onExpired?.() !== false) { entry.expired = true; return; }
            ai = null; resolve(false);
          };
          ai = entry; entry.arm();
          // A Continue is waiting on this request (its check no longer counted): the dialog is already open, so it asks for a fresh
          // check there instead of opening a second dialog.
          if (cont) { entry.shown = true; settle({ status: 'again' }); } else d.askUser!();
        });
        if (!ok) { settle({ status: 'sendFailed', code: 'CANCELLED' }); return null; }
        const headers = clearances.cached(account, b);
        if (headers) return headers;
        // The clearance ran out between the pass and Continue: keep the request and ask again in the open dialog (next loop round).
        }
      };
      const next = aiQueue.then(run, run); aiQueue = next.catch(() => undefined); return next;
    },
  };
}
export type Admission = ReturnType<typeof createAdmission>;
