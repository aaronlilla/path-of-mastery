import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pairedClientSchema, revisionRefSchema, type PairedClient, type RevisionRef, type ValidationLimits } from '@pom/mastery-contracts';
import { writePrivateFile } from '../assistant/secretFile.js';
import { AiDenied, type AiAccess, type AiActor, type AiScope, type PairSelection } from './gate.js';

export type LocalClient = PairSelection & { proof: string; token: string; expiresAt: string; lastUsedAt: number | null; paused: boolean };
export type ClientView = { clientId: string; publicIdentity: string; scopes: AiScope[]; targets: RevisionRef[]; expiresAt: string; status: 'pending' | 'paired'; lastUsedAt: number | null; paused: boolean };
export class ClientPairing {
  private pending = new Map<string, LocalClient>();
  private clients = new Map<string, LocalClient>();
  constructor(private readonly d: { directory: string; gate: AiAccess; limits: ValidationLimits; approvedIdentities: readonly string[] }) {}
  views(): ClientView[] {
    return [...this.pending.values(), ...this.clients.values()].map(c => ({ clientId: c.clientId, publicIdentity: c.publicIdentity,
      scopes: [...c.scopes], targets: structuredClone(c.targets), expiresAt: c.expiresAt, status: this.clients.has(c.clientId) ? 'paired' : 'pending', lastUsedAt: c.lastUsedAt, paused: c.paused }));
  }
  actor(token: string): { actor: AiActor; client: LocalClient } | null {
    for (const client of this.clients.values()) if (!client.paused && client.token.length === token.length && timingSafeEqual(Buffer.from(client.token), Buffer.from(token)) && Date.parse(client.expiresAt) > Date.now())
      return { actor: { clientId: client.clientId, proof: client.proof }, client };
    return null;
  }
  markUsed(clientId: string): void { const client = this.clients.get(clientId); if (client && !client.paused) client.lastUsedAt = Date.now(); }
  pause(clientId: string): void { const client = this.clients.get(clientId); if (client) client.paused = true; }
  async begin(publicIdentity: string, scopes: AiScope[], targets: RevisionRef[]): Promise<ClientView> {
    if (!this.d.approvedIdentities.includes(publicIdentity) || !scopes.length || scopes.some(s => !['mcp:tools:list','mcp:resources:list','mcp:read','mcp:propose','mcp:apply'].includes(s))
      || new Set(scopes).size !== scopes.length || !targets.length || targets.some(t => !revisionRefSchema.parse(t, this.d.limits).ok)) throw new AiDenied('VALIDATION_FAILED');
    const client: LocalClient = { clientId: randomUUID(), publicIdentity, scopes: [...scopes], targets: structuredClone(targets),
      idempotencyKey: randomUUID(), proof: randomBytes(32).toString('base64url'), token: randomBytes(32).toString('hex'), expiresAt: '', lastUsedAt: null, paused: false };
    const result = await this.d.gate.pair(clientSelection(client), client.proof, false);
    if (result.status !== 'pending' || !(Date.parse(result.expiresAt) > Date.now())) throw new AiDenied('CONNECTION_REVOKED');
    client.expiresAt = result.expiresAt; this.pending.set(client.clientId, client);
    return this.views().find(v => v.clientId === client.clientId)!;
  }
  async allow(clientId: string): Promise<ClientView> {
    const client = this.pending.get(clientId);
    if (!client || !(Date.parse(client.expiresAt) > Date.now())) throw new AiDenied('CONNECTION_REVOKED');
    const result = await this.d.gate.pair({ ...clientSelection(client), idempotencyKey: randomUUID() }, client.proof, true);
    const parsed = pairedClientSchema.parse(result, this.d.limits);
    if (!parsed.ok || parsed.value.status !== 'paired' || parsed.value.clientId !== clientId
      || parsed.value.scopes.some(s => !client.scopes.includes(s as AiScope)) || !(Date.parse(parsed.value.expiresAt) > Date.now())) throw new AiDenied('CONNECTION_REVOKED');
    client.expiresAt = parsed.value.expiresAt; client.scopes = parsed.value.scopes as AiScope[];
    await mkdir(this.d.directory, { recursive: true });
    await writePrivateFile(join(this.d.directory, `${clientId}.json`), JSON.stringify(client));
    this.pending.delete(clientId); this.clients.set(clientId, client);
    return this.views().find(v => v.clientId === clientId)!;
  }
  decline(clientId: string): void { this.pending.delete(clientId); }
  async reconnect(): Promise<void> {
    this.clients.clear();
    const files = await readdir(this.d.directory).catch(() => []);
    for (const file of files.filter(f => /^[a-f0-9-]{36}\.json$/i.test(f))) {
      try {
        const c = JSON.parse(await readFile(join(this.d.directory, file), 'utf8')) as LocalClient;
        if (file !== `${c.clientId}.json` || !/^[a-f0-9]{64}$/.test(c.token) || !/^[A-Za-z0-9_-]{43}$/.test(c.proof)
          || !this.d.approvedIdentities.includes(c.publicIdentity) || !(Date.parse(c.expiresAt) > Date.now())) continue;
        c.lastUsedAt = typeof c.lastUsedAt === 'number' && Number.isFinite(c.lastUsedAt) && c.lastUsedAt >= 0 && c.lastUsedAt <= Date.now() ? c.lastUsedAt : null;
        c.paused = true; this.clients.set(c.clientId, c);
        for (const target of c.targets) await this.d.gate.verify({ clientId: c.clientId, proof: c.proof }, target, c.scopes);
        c.paused = false;
        this.clients.set(c.clientId, c);
      } catch { /* A rejected stored grant stays disconnected. */ }
    }
  }
  clear(): void { this.clients.clear(); this.pending.clear(); }
  async revoke(clientId: string | null = null): Promise<void> {
    const ids = clientId ? [clientId] : this.views().map(v => v.clientId);
    if (clientId) { this.clients.delete(clientId); this.pending.delete(clientId); } else this.clear();
    const revoking = this.d.gate.revoke(clientId);
    await Promise.all([revoking, ...ids.filter(id => /^[a-f0-9-]{36}$/i.test(id)).map(id => rm(join(this.d.directory, `${id}.json`), { force: true }))]);
  }
}
function clientSelection(c: LocalClient): PairSelection {
  return { clientId: c.clientId, publicIdentity: c.publicIdentity, scopes: c.scopes, targets: c.targets, idempotencyKey: c.idempotencyKey };
}
