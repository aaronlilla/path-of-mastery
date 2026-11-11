/**
 * Stdio bridge for MCP clients that can only launch a command, such as Claude Desktop. It carries each JSON-RPC
 * line it reads on stdin to the app's local MCP server and writes the reply to stdout. The server's
 * port is read from `<data dir>/assistant/mcp.json` for each message. The token is read from the paired
 * client's private config, so revoking that client also disconnects an already-running bridge.
 *
 * Plain Node, no dependencies, so it runs under `ELECTRON_RUN_AS_NODE=1` from the app's own executable.
 */
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const dataIdx = process.argv.indexOf('--data');
const dataDir = dataIdx >= 0 ? process.argv[dataIdx + 1] : undefined;
const clientIdx = process.argv.indexOf('--client');
const clientId = clientIdx >= 0 ? process.argv[clientIdx + 1] : undefined;

interface Discovery {
  port: number;
  secret: string;
}

function discovery(): Discovery | 'closed' | 'revoked' {
  if (!dataDir) return clientId ? 'revoked' : 'closed';
  let token: string | undefined;
  if (clientId !== undefined) {
    if (!/^[a-f0-9-]{36}$/i.test(clientId)) return 'revoked';
    try {
      const grant = JSON.parse(readFileSync(join(dataDir, 'assistant', 'clients', `${clientId}.json`), 'utf8')) as { clientId: string; token: string; expiresAt: string };
      if (grant.clientId !== clientId || typeof grant.token !== 'string' || !/^[a-f0-9]{64}$/.test(grant.token)
        || typeof grant.expiresAt !== 'string' || !(Date.parse(grant.expiresAt) > Date.now())) return 'revoked';
      token = grant.token;
    } catch { return 'revoked'; }
  }
  try {
    const d = JSON.parse(readFileSync(join(dataDir, 'assistant', 'mcp.json'), 'utf8')) as { port?: number };
    if (!Number.isSafeInteger(d.port) || !d.port || d.port < 1 || d.port > 65535 || !token) return 'revoked';
    return { port: d.port, secret: token };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'closed' : 'revoked';
  }
}

function write(message: unknown): void {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function fail(id: unknown, text: string): void {
  if (id === undefined || id === null) return;
  write({ jsonrpc: '2.0', id, error: { code: -32000, message: text } });
}

function post(d: Discovery, body: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: d.port,
        path: '/mcp',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${d.secret}`,
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

async function relay(line: string): Promise<void> {
  let msg: { id?: unknown };
  try {
    msg = JSON.parse(line) as { id?: unknown };
  } catch {
    return;
  }
  const d = discovery();
  if (d === 'closed') return fail(msg.id, 'Path of Mastery is not running. Open the app, then try again.');
  if (d === 'revoked') {
    if (msg.id === undefined || msg.id === null) return;
    return write({ jsonrpc: '2.0', id: msg.id, error: { code: -32001, message: 'CONNECTION_REVOKED', data: { code: 'CONNECTION_REVOKED' } } });
  }
  try {
    const r = await post(d, line);
    if (r.status === 202 || !r.text.trim()) return;
    if (r.status !== 200 && r.status !== 202) {
      const error = JSON.parse(r.text) as { error?: { data?: { code?: string; retryAt?: string } } };
      const code = error.error?.data?.code ?? 'CONNECTION_REVOKED';
      return write({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32001, message: code, data: { code, ...(error.error?.data?.retryAt ? { retryAt: error.error.data.retryAt } : {}) } } });
    }
    const parsed: unknown = JSON.parse(r.text);
    if (Array.isArray(parsed)) for (const p of parsed) write(p);
    else write(parsed);
  } catch {
    fail(msg.id, 'Path of Mastery is not running. Open the app, then try again.');
  }
}

const rl = createInterface({ input: process.stdin });
let queue = Promise.resolve();
rl.on('line', (line) => {
  if (line.trim()) queue = queue.then(() => relay(line)).catch(() => undefined);
});
rl.on('close', () => void queue.then(() => process.exit(0)));
