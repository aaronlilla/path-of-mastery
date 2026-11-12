import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, ListResourcesRequestSchema, ListResourceTemplatesRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { AiDenied, PANEL, type AiActor, type AiScope } from '../aiGate/gate.js';
import { TOOL_SCOPES, externalToolAllowed } from './toolPolicy.js';
import { APPROVED_CHANGE_TOOLS } from './approvedChanges.js';
import { createProposalTransaction } from '../aiGate/proposalTransaction.js';
import type { ConnectorClient, Proposal } from '../../shared/assistant/types.js';
import { AUDIT_NOTE, PANEL_ONLY_NOTES, ToolError, type ToolContext, type ToolDef } from './tools.js';
import { MCP_INSTRUCTIONS } from './prompts.js';

export const MCP_SERVER_NAME = 'path-of-mastery';
export const MCP_PATH = '/mcp';
/** Untrusted display hint sent by CLI clients; it grants no access. */
export const CLIENT_HEADER = 'x-pom-client';

const MAX_BODY = 1_000_000;
const BAD_PORTS = new Set([8765, 8766]);

export interface McpServerOptions {
  tools: ToolDef[];
  /** The context tools run with; `origin` is filled in per request. */
  context: Omit<ToolContext, 'origin'>;
  version: string;
  /** Called when a client sends `initialize`, for the connector screen's "Connected" status. */
  onClient?: (client: ConnectorClient) => void;
  /** Overrides the random per-launch secret (tests). */
  secret?: string;
  access?: McpAccess;
  /** Runs after a tool's proposals are published; what it returns is merged into the tool result (live apply for the panel). */
  afterCommit?: (identity: McpIdentity, published: Proposal[]) => Promise<Record<string, unknown> | null>;
}

export type McpIdentity = { actor: AiActor; origin: 'panel' | 'external'; scopes: readonly AiScope[]; client?: string };
export interface McpAccess {
  verifyStart(): Promise<void>;
  external(token: string): McpIdentity | null;
  run<T>(identity: McpIdentity, scope: AiScope, input: unknown, operation: () => Promise<T>): Promise<T>;
  context(identity: McpIdentity, tool: string, args: Record<string, unknown>, context: ToolContext): Promise<ToolContext>;
}

/**
 * The app's own MCP server: the assistant's tools for the player's CLI and for outside clients such as Claude
 * Desktop. It listens on 127.0.0.1 only, on a random free port (never 8765 or 8766). Panel calls use an app-controlled
 * launch credential; external calls require approved per-client credentials. Browser requests and foreign Host headers are rejected.
 */
export class AssistantMcpServer {
  readonly secret: string;
  private server: Server | null = null;
  port = 0;

  constructor(private readonly opts: McpServerOptions) {
    this.secret = opts.secret ?? randomBytes(32).toString('hex');
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}${MCP_PATH}`;
  }

  async start(): Promise<number> {
    if (!this.opts.access) throw new AiDenied('ENTITLEMENT_UNAVAILABLE');
    await this.opts.access.verifyStart();
    for (let attempt = 0; attempt < 5; attempt++) {
      const server = createServer((req, res) => void this.handle(req, res));
      const port = await new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
      });
      if (BAD_PORTS.has(port)) {
        await new Promise<void>((r) => server.close(() => r()));
        continue;
      }
      this.server = server;
      this.port = port;
      return port;
    }
    throw new Error('Could not find a free local port for the assistant tools.');
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (s) await new Promise<void>((r) => (s.closeAllConnections?.(), s.close(() => r())));
  }

  private authorised(req: IncomingMessage): McpIdentity | null {
    const header = req.headers.authorization ?? '';
    const m = /^Bearer (.+)$/.exec(header);
    if (!m) return null;
    const a = Buffer.from(m[1]!);
    const b = Buffer.from(this.secret);
    if (a.length === b.length && timingSafeEqual(a, b)) return { actor: PANEL, origin: 'panel', scopes: ['mcp:tools:list', 'mcp:resources:list', 'mcp:read', 'mcp:propose'] };
    return this.opts.access?.external(m[1]!) ?? null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let requestId: string | number | null = null;
    const reply = (status: number, body: string) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(body);
    };
    try {
      const host = req.headers.host ?? '';
      if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return reply(403, '{"error":"bad host"}');
      if (req.headers.origin) return reply(403, '{"error":"browser requests are not allowed"}');
      if (!req.url || req.url.split('?')[0] !== MCP_PATH) return reply(404, '{"error":"not found"}');
      const identity = this.authorised(req);
      if (!identity) return reply(401, JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'CONNECTION_REVOKED', data: { code: 'CONNECTION_REVOKED' } } }));
      if (req.method !== 'POST') return reply(405, '{"error":"POST only"}');
      const raw = await readBody(req);
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        return reply(400, '{"jsonrpc":"2.0","error":{"code":-32700,"message":"parse error"},"id":null}');
      }
      if (Array.isArray(body) || !body || typeof body !== 'object') return reply(400, '{"error":"invalid request"}');
      const message = body as { id?: unknown; method?: string };
      if (typeof message.id === 'string' || typeof message.id === 'number') requestId = message.id;
      const scope = message.method === 'resources/list' || message.method === 'resources/templates/list' ? 'mcp:resources:list' : 'mcp:tools:list';
      if (!identity.scopes.includes(scope)) throw new AiDenied('CONNECTION_REVOKED');
      // No server round trip here: each tool call is authorized by the tool's own scope below, and a metadata check in front
      // (connect, list) cost outside clients about 6 s per message, long enough for Claude Code to give up connecting.
      if (identity.origin === 'external') this.noteClient(body);
      const server = this.build(identity);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      if (e instanceof AiDenied && !res.headersSent) return reply(403, JSON.stringify({ jsonrpc: '2.0', id: requestId,
        error: { code: -32001, message: e.code, data: { code: e.code, ...(e.retryAt ? { retryAt: e.retryAt } : {}) } } }));
      if (!res.headersSent) reply(500, JSON.stringify({ error: e instanceof Error && e.message === 'body too large' ? 'body too large' : 'internal error' }));
    }
  }

  private noteClient(body: unknown): void {
    const list = Array.isArray(body) ? body : [body];
    for (const m of list) {
      const msg = m as { method?: string; params?: { clientInfo?: { name?: string; version?: string } } };
      if (msg?.method === 'initialize' && msg.params?.clientInfo) {
        this.opts.onClient?.({ name: String(msg.params.clientInfo.name ?? 'unknown').slice(0, 60), version: String(msg.params.clientInfo.version ?? '').slice(0, 30), lastSeen: Date.now() });
      }
    }
  }

  /** The loot filter tools get their context once the filter store exists (after the server starts). */
  setLoot(loot: NonNullable<ToolContext['loot']>): void {
    this.opts.context.loot = loot;
  }

  private build(identity: McpIdentity): McpServer {
    const server = new McpServer({ name: MCP_SERVER_NAME, version: this.opts.version }, { capabilities: { resources: {}, tools: {} }, instructions: MCP_INSTRUCTIONS });
    const ctx: ToolContext = { ...this.opts.context, origin: identity.origin, client: identity.client };
    const tools = [...this.opts.tools, ...APPROVED_CHANGE_TOOLS.filter(t => !this.opts.tools.some(existing => existing.name === t.name))];
    for (const tool of tools) {
      server.registerTool(tool.name, { description: tool.description, inputSchema: tool.shape }, async (args: Record<string, unknown>) => {
        let transaction: ReturnType<typeof createProposalTransaction> | undefined;
        try {
          const scope = TOOL_SCOPES[tool.name];
          if (!scope || !identity.scopes.includes(scope) || (identity.origin === 'external' && !externalToolAllowed(tool.name))) throw new AiDenied('CONNECTION_REVOKED');
          const result = await this.opts.access!.run(identity, scope, { tool: tool.name, args }, async () => {
            const scoped = await this.opts.access!.context(identity, tool.name, args ?? {}, ctx);
            transaction = createProposalTransaction(scoped);
            return tool.run(args ?? {}, transaction.context);
          });
          // AUDIT_NOTE and the panel's own card and printed-line sentences tell the model about things an outside client does not have.
          if (identity.origin === 'external' && result && typeof (result as { note?: unknown }).note === 'string') (result as { note: string }).note = [AUDIT_NOTE, ...PANEL_ONLY_NOTES].reduce((n, x) => n.split(x).join(''), (result as { note: string }).note).replace(/ {2,}/g, ' ').trim();
          // the app's closing "Also noticed" line is the panel's: an outside client says treeOutdated itself
          if (identity.origin === 'external' && result && typeof result === 'object') delete (result as { treeOutdatedNote?: unknown }).treeOutdatedNote;
          const published = transaction?.commit() ?? [];
          const live = published.length && this.opts.afterCommit ? await this.opts.afterCommit(identity, published) : null;
          if (live && result && typeof result === 'object' && !Array.isArray(result)) Object.assign(result, live);
          const ref = transaction?.context.results?.add(tool.name, result);
          const out = ref && result && typeof result === 'object' && !Array.isArray(result) ? { ref, ...(result as Record<string, unknown>) } : result;
          return { content: [{ type: 'text' as const, text: JSON.stringify(out) }] };
        } catch (e) {
          transaction?.discard();
          if (e instanceof AiDenied) return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ code: e.code, message: e.message, ...(e.retryAt ? { retryAt: e.retryAt } : {}) }) }] };
          const message = e instanceof ToolError ? e.message : e instanceof Error ? e.message.slice(0, 300) : 'The calculation engine could not do that.';
          return { isError: true, content: [{ type: 'text' as const, text: message }] };
        }
      });
    }
    // Listing names needs no server round trip (it made clients time out connecting); every tool call still goes through the gate.
    server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools.filter(t => TOOL_SCOPES[t.name] && identity.scopes.includes(TOOL_SCOPES[t.name]!) && (identity.origin !== 'external' || externalToolAllowed(t.name))).map(t => ({
        name: t.name, description: t.description, inputSchema: z.toJSONSchema(z.object(t.shape)) as { type: 'object' },
        // Claude Code runs a step's tool calls side by side only when they are marked read-only; otherwise showInApp waits behind a slow ranking.
        ...(TOOL_SCOPES[t.name] === 'mcp:read' ? { annotations: { readOnlyHint: true } } : {}),
      })),
    }));
    server.server.setRequestHandler(ListResourcesRequestSchema, () => this.opts.access!.run(identity, 'mcp:resources:list', { method: 'resources/list' }, async () => ({ resources: [] })));
    server.server.setRequestHandler(ListResourceTemplatesRequestSchema, () => this.opts.access!.run(identity, 'mcp:resources:list', { method: 'resources/templates/list' }, async () => ({ resourceTemplates: [] })));
    return server;
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
