import { createHash, randomUUID } from 'node:crypto';
import {
  apiResultSchema, entitlementDecisionSchema, revisionRefSchema,
  type AiAuthorizationRequest, type ApiResult, type EntitlementDecision, type FailureCode,
  type Hash, type PairedClient, type RevisionRef, type ValidationLimits,
} from '@pom/mastery-contracts';

export type AiScope = 'ai:plan' | 'ai:explain' | 'ai:suggest' | 'mcp:tools:list'
  | 'mcp:resources:list' | 'mcp:read' | 'mcp:propose' | 'mcp:apply';
export type AiActor = { clientId: string | null; proof?: string };
export const PANEL: AiActor = Object.freeze({ clientId: null });
export type AiStatus = { status: 'off' | 'checking' | 'ready' | 'denied'; code?: FailureCode; retryAt?: string };
export const AI_MESSAGES: Partial<Record<FailureCode, string>> = {
  SIGN_IN_REQUIRED: 'Sign in to use the assistant.', AI_ACCESS_REQUIRED: 'AI features are not available for this account right now.',
  ENTITLEMENT_UNAVAILABLE: 'Connect to verify your account', HUMAN_CHECK_REQUIRED: 'Complete a quick check to continue.',
  CONNECTION_REVOKED: 'This connection ended. Pair the client again.', AI_SERVICE_UNAVAILABLE: 'AI service unavailable',
  RATE_LIMITED: 'Keep your draft and try again at the available time.', REVISION_CONFLICT: 'The source changed. Review it and try again.',
};
export class AiDenied extends Error {
  constructor(readonly code: FailureCode, readonly retryAt?: string) {
    super(AI_MESSAGES[code] ?? 'Could not authorize this request.');
    this.name = 'AiDenied'; // main/mastery/atlas.ts passes only named domain errors' messages through to the app
  }
}
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(',')}}`;
}
export function hashJson(value: unknown): Hash {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex') as Hash;
}
export type AiBackend = {
  post<T>(route: 'session' | 'authorize' | 'request' | 'pair' | 'revoke', body: unknown, actor: AiActor, signal?: AbortSignal): Promise<ApiResult<T>>;
};
export type PairSelection = { clientId: string; publicIdentity: string; scopes: AiScope[]; targets: RevisionRef[]; idempotencyKey: string };
export interface AiAccess {
  readonly state: AiStatus;
  verify(actor: AiActor, target: RevisionRef, scopes?: AiScope[]): Promise<void>;
  run<T>(actor: AiActor, scope: AiScope, target: RevisionRef, input: unknown, operation: () => Promise<T>): Promise<T>;
  model(actor: AiActor, scope: 'ai:plan' | 'ai:explain' | 'ai:suggest', target: RevisionRef, input: unknown): Promise<unknown>;
  pair(selection: PairSelection, proof: string, allow: boolean): Promise<PairedClient | { status: 'pending'; expiresAt: string }>;
  revoke(clientId?: string | null): Promise<void>;
  invalidate(code?: FailureCode): void;
  /** A new question starts: the next request opens one fresh server session that every step of the question reuses. */
  renew?(actor: AiActor): void;
  /** The live check while an answer runs: a server round trip that opens no new session when one is live. */
  check?(actor: AiActor, target: RevisionRef): Promise<void>;
  onChange(listener: () => void): () => void;
}

/** Scopes the app's own panel session carries, so one session covers every step of a question. */
export const PANEL_SCOPES: readonly AiScope[] = Object.freeze(['ai:plan', 'ai:explain', 'ai:suggest', 'mcp:tools:list',
  'mcp:resources:list', 'mcp:read', 'mcp:propose', 'mcp:apply']);
/** A cached session is not used in its last 60 seconds, so a step never starts on a session that ends mid-request. */
const SESSION_MARGIN_MS = 60_000;
type CachedSession = { sessionId: string; scopes: readonly string[]; expiresAt: number; generation: number; actorGeneration: number;
  /** The newest step authorization in this session: the live check during an answer asks the server about it. */
  grant?: { requestId: string; expiresAt: number } };

export class AiGate implements AiAccess {
  state: AiStatus = { status: 'off' };
  private generation = 0;
  private controllers = new Map<AbortController, AiActor>();
  private actorGenerations = new Map<string | null, number>();
  private receipts = new Set<string>();
  private listeners = new Set<() => void>();
  /** One server session per actor and build revision, reused by every step until it expires, the account or Pro changes, or a new question starts. */
  private sessions = new Map<string, CachedSession>();
  private opening = new Map<string, Promise<CachedSession>>();
  constructor(private readonly d: {
    backend: AiBackend; limits: ValidationLimits;
    current(target: RevisionRef): Promise<boolean>;
    now?: () => number;
  }) {}
  onChange(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private status(value: AiStatus): void { this.state = value; for (const l of this.listeners) l(); }
  invalidate(code: FailureCode = 'CONNECTION_REVOKED'): void {
    this.generation++; this.dropSessions(); for (const c of this.controllers.keys()) c.abort();
    this.status({ status: 'denied', code });
  }
  /** A different account signed in: in-flight AI work ends and nothing verified for the previous account carries over (Off until verified). */
  reset(): void {
    this.generation++; this.dropSessions(); for (const c of this.controllers.keys()) c.abort();
    this.status({ status: 'off' });
  }
  renew(actor: AiActor): void { this.dropSessions(actor.clientId); }
  private dropSessions(clientId?: string | null): void {
    for (const map of [this.sessions, this.opening] as Map<string, unknown>[]) {
      for (const key of [...map.keys()]) if (clientId === undefined || key.startsWith(`${clientId ?? ''}|`)) map.delete(key);
    }
  }
  private invalidateActor(actor: AiActor): void {
    this.actorGenerations.set(actor.clientId, (this.actorGenerations.get(actor.clientId) ?? 0) + 1);
    this.dropSessions(actor.clientId);
    for (const [controller, owner] of this.controllers) if (owner.clientId === actor.clientId) controller.abort();
  }
  private globalFailure(code: FailureCode): boolean {
    return ['SIGN_IN_REQUIRED', 'AI_ACCESS_REQUIRED', 'ENTITLEMENT_UNAVAILABLE', 'HUMAN_CHECK_REQUIRED'].includes(code);
  }
  private async checked<T>(work: (signal: AbortSignal) => Promise<T>, actor: AiActor = PANEL): Promise<T> {
    const generation = this.generation; const actorGeneration = this.actorGenerations.get(actor.clientId) ?? 0;
    const controller = new AbortController(); this.controllers.set(controller, actor);
    try {
      const value = await work(controller.signal);
      if (generation !== this.generation || actorGeneration !== (this.actorGenerations.get(actor.clientId) ?? 0) || controller.signal.aborted) throw new AiDenied('CONNECTION_REVOKED');
      return value;
    } catch (e) {
      const revoked = generation !== this.generation
        || actorGeneration !== (this.actorGenerations.get(actor.clientId) ?? 0) || controller.signal.aborted;
      if (!revoked && !(e instanceof AiDenied)) console.error('[aiGate] check failed:', e);
      const denied = revoked ? new AiDenied('CONNECTION_REVOKED')
        : e instanceof AiDenied ? e : new AiDenied('ENTITLEMENT_UNAVAILABLE');
      if (this.globalFailure(denied.code)) {
        this.invalidate(denied.code);
        this.status({ status: 'denied', code: denied.code, ...(denied.retryAt ? { retryAt: denied.retryAt } : {}) });
      } else this.invalidateActor(actor);
      throw denied;
    } finally { this.controllers.delete(controller); }
  }
  private async post<T>(route: Parameters<AiBackend['post']>[0], body: unknown, actor: AiActor, signal?: AbortSignal): Promise<T> {
    const bounded = apiResultSchema({ parse: value => ({ ok: true as const, value }) });
    if (!bounded.parse({ ok: true, value: body }, this.d.limits).ok) throw new AiDenied('VALIDATION_FAILED');
    const parsed = bounded.parse(await this.d.backend.post<T>(route, body, actor, signal), this.d.limits);
    if (!parsed.ok) throw new AiDenied('ENTITLEMENT_UNAVAILABLE');
    if (!parsed.value.ok) throw new AiDenied(parsed.value.code, parsed.value.retryAt);
    return parsed.value.value as T;
  }
  private now(): number { return (this.d.now ?? Date.now)(); }
  private sessionKey(actor: AiActor, target: RevisionRef): string { return `${actor.clientId ?? ''}|${canonicalJson(target)}`; }
  /** Opens a server session (always a server round trip: subscription, client and human check are checked there) and caches it. */
  private async session(actor: AiActor, target: RevisionRef, requested: readonly AiScope[], signal: AbortSignal): Promise<CachedSession> {
    if (!revisionRefSchema.parse(target, this.d.limits).ok || !await this.d.current(target)) throw new AiDenied('REVISION_CONFLICT');
    const generation = this.generation; const actorGeneration = this.actorGenerations.get(actor.clientId) ?? 0;
    const scopes = actor.clientId === null ? [...new Set([...PANEL_SCOPES, ...requested])] : [...requested];
    const s = await this.post<{ sessionId: string; clientId: string | null; scopes: string[]; expiresAt: string }>('session',
      { clientId: actor.clientId, targets: [target], scopes, idempotencyKey: randomUUID() }, actor, signal);
    if (!s || !/^[0-9a-f-]{36}$/i.test(s.sessionId) || s.clientId !== actor.clientId
      || !Array.isArray(s.scopes) || scopes.some(scope => !s.scopes.includes(scope))
      || !(Date.parse(s.expiresAt) > this.now())) throw new AiDenied('CONNECTION_REVOKED');
    const cached: CachedSession = { sessionId: s.sessionId, scopes: [...s.scopes], expiresAt: Date.parse(s.expiresAt), generation, actorGeneration };
    // Never cache a session that an account change, sign-out or revoke overtook while it was opening.
    if (generation === this.generation && actorGeneration === (this.actorGenerations.get(actor.clientId) ?? 0)) this.sessions.set(this.sessionKey(actor, target), cached);
    return cached;
  }
  private usable(s: CachedSession | undefined, actor: AiActor, scope: AiScope): boolean {
    return !!s && s.generation === this.generation && s.actorGeneration === (this.actorGenerations.get(actor.clientId) ?? 0)
      && s.scopes.includes(scope) && s.expiresAt - SESSION_MARGIN_MS > this.now();
  }
  /** The live session for this actor and revision that covers the scope, opening one (shared by steps that ask at once) only when there is none. */
  private async sessionFor(actor: AiActor, target: RevisionRef, scope: AiScope, signal: AbortSignal): Promise<string> {
    const key = this.sessionKey(actor, target);
    const cached = this.sessions.get(key);
    if (this.usable(cached, actor, scope)) {
      if (!await this.d.current(target)) throw new AiDenied('REVISION_CONFLICT');
      return cached!.sessionId;
    }
    const pending = this.opening.get(key);
    if (pending) {
      const s = await pending.catch(() => undefined);
      if (s && this.usable(s, actor, scope)) return s.sessionId;
    }
    const scopes = [...new Set([...(cached && cached.generation === this.generation ? cached.scopes as AiScope[] : []), scope])];
    const opening = this.session(actor, target, scopes, signal);
    this.opening.set(key, opening);
    try { return (await opening).sessionId; }
    finally { if (this.opening.get(key) === opening) this.opening.delete(key); }
  }
  /**
   * The live check while an answer runs (polled every second). With a live cached session it asks the server about the
   * session's newest step authorization (the status route re-checks account, Pro, client, session and human check, and
   * counts against no rate limit); without one it is a full verify. Any denial fails closed exactly like verify.
   */
  async check(actor: AiActor, target: RevisionRef): Promise<void> {
    const scope = actor.clientId === null ? 'mcp:read' : this.sessions.get(this.sessionKey(actor, target))?.scopes[0] as AiScope | undefined;
    if (!scope) return this.verify(actor, target);
    await this.checked(signal => this.live(actor, target, scope, signal), actor);
  }
  /**
   * A server round trip that never opens a session while one is live: the status of the session's newest grant when it is
   * still valid; otherwise one authorized step on the session (which gives a new grant), and only when the session itself is
   * gone, one new session shared by every caller waiting on it. So a poll every second opens at most one session per expiry.
   */
  private async live(actor: AiActor, target: RevisionRef, scope: AiScope, signal: AbortSignal): Promise<void> {
    const s = this.sessions.get(this.sessionKey(actor, target));
    const grant = s?.grant;
    if (s && grant && this.usable(s, actor, scope) && grant.expiresAt - 5_000 > this.now()) {
      if (!revisionRefSchema.parse(target, this.d.limits).ok || !await this.d.current(target)) throw new AiDenied('REVISION_CONFLICT');
      // The poll runs every second for the whole answer (minutes on a big change), so one dropped connection (ECONNRESET) must
      // not end it. A read-only status is asked again twice; a third failure in a row still fails closed.
      let live: { status: string };
      for (let tries = 1; ; tries++) {
        try { live = await this.post<{ status: string }>('request', { action: 'status', sessionId: s.sessionId, clientId: actor.clientId, requestId: grant.requestId }, actor, signal); break; }
        catch (e) {
          if (tries >= 3 || signal.aborted || !(e instanceof AiDenied) || e.code !== 'ENTITLEMENT_UNAVAILABLE') throw e;
          await new Promise(r => setTimeout(r, 300));
        }
      }
      if (!live || typeof live.status !== 'string' || live.status === 'cancelled') throw new AiDenied('CONNECTION_REVOKED');
      return;
    }
    await this.request(actor, scope, target, { phase: 'check' }, signal);
  }
  async verify(actor: AiActor, target: RevisionRef, scopes: AiScope[] = ['mcp:tools:list']): Promise<void> {
    const previous = this.state;
    if (actor.clientId === null) this.status({ status: 'checking' });
    // The panel's start checks (tool server start, MCP start) reuse the question's session with a server round trip; a paired
    // client's verify still opens its own session with exactly the scopes it was paired with.
    try { await this.checked(async signal => { if (actor.clientId === null) await this.live(actor, target, scopes[0] ?? 'mcp:tools:list', signal); else await this.session(actor, target, scopes, signal); }, actor); }
    catch (error) {
      if (actor.clientId === null && this.state.status === 'checking' && error instanceof AiDenied && !this.globalFailure(error.code)) this.status(previous);
      throw error;
    }
    if (actor.clientId === null) this.status({ status: 'ready' });
  }
  private async request(actor: AiActor, scope: AiScope, target: RevisionRef, input: unknown, signal: AbortSignal): Promise<unknown> {
    const sessionId = await this.sessionFor(actor, target, scope, signal);
    if (signal.aborted) throw new AiDenied('CONNECTION_REVOKED');
    const base = { requestId: randomUUID(), target, scope, clientId: actor.clientId };
    const request: AiAuthorizationRequest = { ...base, requestHash: hashJson({ request: base, input }) };
    const value = await this.post<EntitlementDecision>('authorize', { sessionId, request }, actor, signal);
    const decision = entitlementDecisionSchema.parse(value, this.d.limits);
    if (!decision.ok) throw new AiDenied('ENTITLEMENT_UNAVAILABLE');
    if (decision.value.status === 'denied') throw new AiDenied(decision.value.code);
    const authorization = decision.value;
    if (authorization.requestHash !== request.requestHash || !authorization.scopes.includes(scope)
      || !(Date.parse(authorization.expiresAt) > (this.d.now ?? Date.now)())) throw new AiDenied('CONNECTION_REVOKED');
    const live = this.sessions.get(this.sessionKey(actor, target));
    if (live?.sessionId === sessionId) live.grant = { requestId: base.requestId, expiresAt: Date.parse(authorization.expiresAt) };
    const result = await this.post<{ status: string; result?: unknown }>('request',
      { sessionId, authorizationId: authorization.authorizationId, request, input }, actor, signal);
    if (result.status !== 'complete') throw new AiDenied('AI_SERVICE_UNAVAILABLE');
    if (scope.startsWith('mcp:')) {
      const receipt = entitlementDecisionSchema.parse(result.result, this.d.limits);
      if (!receipt.ok || receipt.value.status !== 'authorized' || receipt.value.authorizationId !== authorization.authorizationId
        || receipt.value.requestHash !== request.requestHash || !receipt.value.scopes.includes(scope)
        || !(Date.parse(receipt.value.expiresAt) > (this.d.now ?? Date.now)()) || this.receipts.has(authorization.authorizationId)) throw new AiDenied('CONNECTION_REVOKED');
      this.receipts.add(authorization.authorizationId);
    }
    return result.result;
  }
  async run<T>(actor: AiActor, scope: AiScope, target: RevisionRef, input: unknown, operation: () => Promise<T>): Promise<T> {
    const outcome = await this.checked(async signal => {
      await this.request(actor, scope, target, { phase: 'operation', input }, signal);
      if (signal.aborted || !await this.d.current(target)) throw new AiDenied('CONNECTION_REVOKED');
      let result: { ok: true; value: T } | { ok: false; error: unknown };
      try { result = { ok: true, value: await operation() }; }
      catch (error) {
        if (error instanceof AiDenied) throw error;
        result = { ok: false, error };
      }
      await this.request(actor, scope, target, { phase: 'release', input }, signal);
      if (!await this.d.current(target)) throw new AiDenied('REVISION_CONFLICT');
      return result;
    }, actor);
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }
  async model(actor: AiActor, scope: 'ai:plan' | 'ai:explain' | 'ai:suggest', target: RevisionRef, input: unknown): Promise<unknown> {
    return this.checked(async signal => {
      const result = await this.request(actor, scope, target, input, signal);
      if (!await this.d.current(target)) throw new AiDenied('REVISION_CONFLICT');
      return result;
    }, actor);
  }
  async pair(selection: PairSelection, proof: string, allow: boolean): Promise<PairedClient | { status: 'pending'; expiresAt: string }> {
    const actor = { clientId: selection.clientId, proof };
    return this.checked(signal => this.post('pair', { action: allow ? 'allow' : 'begin', ...selection }, actor, signal), actor);
  }
  async revoke(clientId: string | null = null): Promise<void> {
    const actor = clientId === null ? PANEL : { clientId };
    if (clientId === null) this.invalidate(); else this.invalidateActor(actor);
    await this.checked(signal => this.post('revoke', { clientId, sessionId: null, all: clientId === null }, PANEL, signal), actor);
  }
}
