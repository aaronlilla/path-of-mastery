import { randomUUID } from 'node:crypto';
import { parseId, type ApiResult, type EntitlementDecision, type FailureCode, type RevisionRef, type ValidationLimits } from '@pom/mastery-contracts';
import { AiGate, hashJson, type AiBackend } from './gate.js';
import type { McpAccess } from '../assistant/mcpServer.js';
import type { AssistantDeps } from '../assistant/service.js';

// Synthetic adapters for targeted tests. App composition never imports this module.
export const limits: ValidationLimits = { maxBytes: 1_000_000, maxDepth: 64, maxNodes: 50000, maxArrayLength: 5000, maxStringLength: 200000 };
export function target(): RevisionRef {
  const unknown = { status: 'unknown' as const, reason: 'Synthetic fixture; no game data.' };
  return { objectId: parseId('object', '22222222-2222-4222-8222-222222222222'),
    revisionId: parseId('revision', '33333333-3333-4333-8333-333333333333'), payloadHash: parseId('hash', 'a'.repeat(64)),
    fallbackSnapshotHash: parseId('hash', 'a'.repeat(64)), stamp: { leagueId: unknown, realm: unknown, mode: unknown,
      patchVersion: unknown, datasetVersion: unknown, createdAt: '2026-01-01T00:00:00.000Z' } };
}
export function fixture() {
  const state = { denied: null as FailureCode | null, calls: [] as Array<{ route: string; body: any }>, model: { answers: {} } as unknown };
  const grants = new Map<string, EntitlementDecision>();
  const used = new Set<string>();
  const backend: AiBackend = {
    async post<T>(route: Parameters<AiBackend['post']>[0], body: unknown, actor: Parameters<AiBackend['post']>[2]): Promise<ApiResult<T>> {
      const b = body as any; state.calls.push({ route, body: b });
      if (state.denied && route !== 'revoke') return { ok: false, code: state.denied, message: 'Synthetic denial.' };
      let value: unknown;
      const expiresAt = new Date(Date.now() + 60000).toISOString();
      // Sessions live an hour like the site's (sessionTtlSeconds 3600); grants live a minute.
      if (route === 'session') value = { sessionId: randomUUID(), clientId: actor.clientId, scopes: b.scopes, expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
      if (route === 'authorize') {
        value = { status: 'authorized', authorizationId: randomUUID(), requestHash: b.request.requestHash, scopes: [b.request.scope], expiresAt };
        grants.set((value as any).authorizationId, value as EntitlementDecision);
      }
      if (route === 'request' && b.action === 'status') return { ok: true, value: { status: 'complete' } as T };
      if (route === 'request') {
        const grant = grants.get(b.authorizationId);
        const { requestHash: _hash, ...request } = b.request;
        if (!grant || grant.status !== 'authorized' || grant.requestHash !== hashJson({ request, input: b.input }) || used.has(b.authorizationId))
          return { ok: false, code: 'CONNECTION_REVOKED', message: 'Synthetic replay denial.' };
        used.add(b.authorizationId);
        value = { status: 'complete', result: b.request.scope.startsWith('mcp:') ? grant : state.model };
      }
      if (route === 'pair') value = b.action === 'begin' ? { status: 'pending', expiresAt } : { clientId: b.clientId, scopes: b.scopes, status: 'paired', expiresAt };
      if (route === 'revoke') value = {};
      return { ok: true, value: value as T };
    },
  };
  const gate = new AiGate({ backend, limits, current: async ref => JSON.stringify(ref) === JSON.stringify(target()) });
  const access: McpAccess = { verifyStart: () => gate.verify({ clientId: null }, target()), external: () => null,
    run: (identity, scope, input, operation) => gate.run(identity.actor, scope, target(), input, operation),
    context: async (_identity, _tool, _args, context) => context };
  const deps: Partial<AssistantDeps> = { ai: gate, target: async () => target(), scopedContext: async (_target, _actor, _tool, _args, context) => context,
    pairing: { limits, approvedIdentities: ['claude-desktop', 'fixture-client'] } };
  return { state, backend, gate, access, deps };
}
