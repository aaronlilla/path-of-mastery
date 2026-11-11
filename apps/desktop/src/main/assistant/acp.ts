import type { ProviderId, ProviderStatus, ToolChip, TurnEvent } from '../../shared/assistant/types.js';
import { MCP_SERVER_KEY, LOGIN_COMMAND, MIN_VERSION, capture, childEnv, classify, detectProvider, makeError, parseVersion, redact, resolveCli, toolDetail, versionLess, type ResolvedCli } from './cli.js';
import { CliProc, chipLabel, type Run, type RunOptions } from './runner.js';
import { detectOllama } from './ollama.js';

/**
 * OpenCode, GitHub Copilot and Cursor through the Agent Client Protocol (agentclientprotocol.com): JSON-RPC 2.0, one
 * message per line, over the program's own stdin/stdout. The app attaches its tool server over HTTP in `session/new`
 * and answers every permission request itself: only the app's own tools are allowed, everything else is refused.
 */

export interface AcpSpec {
  /** Start commands from the vendors' docs: `opencode acp`, `copilot --acp --stdio`, `agent acp` (cursor.com/docs/cli/acp). */
  args: string[];
  env?: Record<string, string>;
}

export const ACP_SPEC: Partial<Record<ProviderId, AcpSpec>> = {
  // The inline config switches off every tool but ours. docs.opencode.ai/docs/mcp-servers: tools are named `<server>_<tool>`.
  opencode: { args: ['acp'], env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ tools: { '*': false, [`${MCP_SERVER_KEY}_*`]: true }, permission: { '*': 'deny', [`${MCP_SERVER_KEY}_*`]: 'allow' } }) } },
  copilot: { args: ['--acp', '--stdio', '--no-ask-user'] },
  cursor: { args: ['acp'] },
};

// ---- permission policy --------------------------------------------------------------------------------------

interface ToolCallInfo { title?: unknown; name?: unknown; kind?: unknown; _meta?: Record<string, unknown>; rawInput?: unknown }
const REFUSED_KINDS = new Set(['execute', 'edit', 'delete', 'move']);

/** Is this tool call one of the app's own tools? A name the program prints is `pom_x`, `mcp__pom__x`, `pom-x`, `pom:x` or just `x`. */
export function isOurTool(call: ToolCallInfo, toolNames: string[]): boolean {
  if (typeof call.kind === 'string' && REFUSED_KINDS.has(call.kind)) return false;
  const meta = call._meta ?? {};
  const names = [call.title, call.name, meta.toolName, meta.tool_name].filter((x): x is string => typeof x === 'string').map((x) => x.trim());
  const server = [meta.serverName, meta.server_name, meta.mcpServer].some((x) => x === MCP_SERVER_KEY);
  return names.some((n) => toolNames.some((t) => n === t || (new RegExp(`(^|[^a-z0-9])${MCP_SERVER_KEY}([^a-z0-9]|$)`, 'i').test(n) || server) && n.endsWith(t)));
}

interface PermOption { optionId?: unknown; kind?: unknown }

/** The reply to `session/request_permission`: pick the allow option for our tools, the reject option for the rest. */
export function permissionReply(params: { toolCall?: ToolCallInfo; options?: PermOption[] }, toolNames: string[]): { outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } } {
  const ours = isOurTool(params.toolCall ?? {}, toolNames);
  const options = params.options ?? [];
  const want = ours ? ['allow_once', 'allow_always', 'allow-once', 'allow-always'] : ['reject_once', 'reject_always', 'reject-once', 'reject-always'];
  for (const w of want) {
    const o = options.find((x) => x.kind === w || x.optionId === w);
    if (o && typeof o.optionId === 'string') return { outcome: { outcome: 'selected', optionId: o.optionId } };
  }
  return { outcome: { outcome: 'cancelled' } };
}

class RpcError extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}

/** Answers what the program asks of the app. Refusing is an answer: a blocked request would hang the session (Cursor waits on `cursor/*`). */
export function answerAgent(method: string, params: unknown, toolNames: string[]): unknown {
  const m = method.replace(/^_+/, '');
  if (m === 'session/request_permission') return permissionReply((params ?? {}) as { toolCall?: ToolCallInfo; options?: PermOption[] }, toolNames);
  if (m === 'cursor/create_plan') return { accepted: false };
  if (m === 'cursor/ask_question') throw new RpcError(-32000, 'The app cannot ask the player questions in the middle of an answer.');
  throw new RpcError(-32601, 'Method not found');
}

// ---- connection ---------------------------------------------------------------------------------------------

type Update = { sessionUpdate?: string; content?: { type?: string; text?: string }; toolCallId?: string; title?: string; status?: string; rawInput?: unknown };

/** One program, spoken to in JSON-RPC lines. */
export class AcpConn {
  readonly proc: CliProc;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  closed = false;
  sessionId = '';

  constructor(provider: ProviderId, cli: ResolvedCli, cwd: string, env: NodeJS.ProcessEnv, private readonly toolNames: string[], private readonly onUpdate: (u: Update) => void, private readonly onLine: () => void = () => undefined) {
    const spec = ACP_SPEC[provider]!;
    this.proc = new CliProc(cli, spec.args, cwd, { ...env, ...(spec.env ?? {}) });
    this.proc.listen({
      line: (l) => this.line(l),
      error: (e) => this.end(e),
      close: (code) => this.end(new Error(`The program exited with code ${code ?? 'unknown'}.`)),
    });
  }

  private end(e: Error): void {
    this.closed = true;
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
  }

  private send(msg: object): void {
    this.proc.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  }

  call<T = any>(method: string, params: object): Promise<T> {
    if (this.closed) return Promise.reject(new Error('The program is not running.'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ id, method, params });
    });
  }

  private line(l: string): void {
    this.onLine();
    let j: { id?: number | string; method?: string; params?: any; result?: unknown; error?: { code?: number; message?: string } };
    try { j = JSON.parse(l); } catch { return; }
    if (j.method && j.id !== undefined) {
      try {
        this.send({ id: j.id, result: answerAgent(j.method, j.params, this.toolNames) });
      } catch (e) {
        this.send({ id: j.id, error: { code: e instanceof RpcError ? e.code : -32603, message: (e as Error).message } });
      }
    } else if (j.method) {
      if (j.method.replace(/^_+/, '') === 'session/update' && j.params?.update) this.onUpdate(j.params.update as Update);
    } else if (typeof j.id === 'number') {
      const p = this.pending.get(j.id);
      if (!p) return;
      this.pending.delete(j.id);
      if (j.error) p.reject(new Error(String(j.error.message ?? 'The program refused the request.')));
      else p.resolve(j.result);
    }
  }

  /** initialize -> session/new. `mcp` null opens a session with no tool server (sign-in probe). */
  async open(cwd: string, mcp: { url: string; secret: string } | null): Promise<void> {
    const init = await this.call('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'path-of-mastery', version: '1' } });
    if (mcp && init?.agentCapabilities?.mcpCapabilities?.http !== true) throw new McpUnsupported();
    const s = await this.call('session/new', {
      cwd,
      mcpServers: mcp ? [{ type: 'http', name: MCP_SERVER_KEY, url: mcp.url, headers: [{ name: 'Authorization', value: `Bearer ${mcp.secret}` }, { name: 'X-Pom-Client', value: 'panel' }] }] : [],
    });
    this.sessionId = String(s?.sessionId ?? '');
    if (!this.sessionId) throw new Error('The program did not open a session.');
  }

  prompt(text: string): Promise<{ stopReason?: string }> {
    return this.call('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text }] });
  }

  cancel(): void {
    if (!this.closed) this.send({ method: 'session/cancel', params: { sessionId: this.sessionId } });
  }

  kill(): void {
    this.proc.kill();
  }
}

class McpUnsupported extends Error {
  constructor() { super('This program cannot attach the build tools over HTTP. Update it and try again.'); }
}

// ---- a turn ------------------------------------------------------------------------------------------------

export function runAcpTurn(o: RunOptions): Run {
  const secrets = [o.secret];
  const chips = new Map<string, ToolChip>();
  let text = '';
  let answer = '';
  let afterTool = false;
  let finished = false;
  let stopping = false;
  let killedFor: 'stalled' | 'timeout' | null = null;
  let conn: AcpConn;
  let resolveDone: () => void = () => undefined;
  const done = new Promise<void>((r) => (resolveDone = r));
  const stallMs = o.stallMs ?? 120_000;
  const stallFire = () => { killedFor = 'stalled'; conn?.kill(); };
  let stall = setTimeout(stallFire, stallMs);
  const total = setTimeout(() => { killedFor = 'timeout'; conn?.kill(); }, o.totalMs ?? 8 * 60_000);

  const finish = (e: TurnEvent) => {
    if (finished) return;
    finished = true;
    clearTimeout(stall);
    clearTimeout(total);
    o.emit(e);
    conn?.kill();
    resolveDone();
  };
  const fail = (err: unknown) => {
    const why = redact(`${(err as Error)?.message ?? err} ${conn?.proc.stderr ?? ''}`, secrets).trim();
    if (stopping) return finish({ type: 'stopped', turnId: o.turnId });
    if (killedFor === 'stalled') return finish({ type: 'error', turnId: o.turnId, error: makeError('stalled', undefined, secrets) });
    if (killedFor === 'timeout') return finish({ type: 'error', turnId: o.turnId, error: makeError('timeout', undefined, secrets) });
    const code = err instanceof McpUnsupported ? 'mcpFailed' : classify(why);
    finish({ type: 'error', turnId: o.turnId, error: makeError(code === 'failed' ? 'crashed' : code, why, secrets) });
  };

  const tool = (id: string, name: string | undefined, status: ToolChip['status'], input?: unknown) => {
    const prev = chips.get(id);
    const detail = (input !== undefined ? toolDetail(input) : undefined) ?? prev?.detail;
    const chip: ToolChip = { id, label: prev?.label ?? chipLabel(name), status, ...(detail ? { detail } : {}) };
    chips.set(id, chip);
    o.emit({ type: 'tool', turnId: o.turnId, chip });
  };

  const onUpdate = (u: Update) => {
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
        if (u.content?.type === 'text' && u.content.text) {
          // a message after a tool call is a new paragraph; what was said before the call is narration, not the answer
          const lead = afterTool && text ? '\n\n' : '';
          if (afterTool) answer = '';
          afterTool = false;
          text += lead + u.content.text;
          answer += u.content.text;
          o.emit({ type: 'text', turnId: o.turnId, delta: lead + u.content.text });
        }
        break;
      case 'agent_thought_chunk':
        if (u.content?.type === 'text' && u.content.text) o.emit({ type: 'thinking', turnId: o.turnId, delta: u.content.text });
        break;
      case 'tool_call':
        if (u.toolCallId) { afterTool = true; tool(u.toolCallId, u.title, 'running', u.rawInput); }
        break;
      case 'tool_call_update':
        if (u.toolCallId && (u.status === 'completed' || u.status === 'failed')) tool(u.toolCallId, u.title, u.status === 'failed' ? 'failed' : 'done');
        break;
    }
  };

  const cli = o.cli;
  try {
    conn = new AcpConn(o.provider, cli, o.cwd, childEnv(o.baseEnv ?? process.env, o.secret), o.spec.toolNames, onUpdate, () => {
      clearTimeout(stall);
      if (!finished) stall = setTimeout(stallFire, stallMs);
    });
  } catch (e) {
    clearTimeout(stall);
    clearTimeout(total);
    finished = true;
    o.emit({ type: 'error', turnId: o.turnId, error: makeError('missing', (e as Error).message, secrets) });
    return { stop: () => undefined, done: Promise.resolve() };
  }
  void (async () => {
    try {
      await conn.open(o.cwd, { url: o.spec.mcpUrl, secret: o.secret });
      const r = await conn.prompt(o.prompt);
      const reason = r?.stopReason ?? 'end_turn';
      if (reason === 'cancelled') return finish({ type: 'stopped', turnId: o.turnId });
      if (reason === 'refusal') return finish({ type: 'error', turnId: o.turnId, error: makeError('failed', 'The model refused to answer.', secrets) });
      finish({ type: 'done', turnId: o.turnId, text: answer || text });
    } catch (e) {
      fail(e);
    }
  })();

  return {
    stop: () => {
      if (finished) return;
      stopping = true;
      conn.cancel();
      conn.kill();
    },
    done,
  };
}

// ---- detection ---------------------------------------------------------------------------------------------

export interface ToolProbe { mcpUrl: string; secret: string; toolNames: string[]; cwd: string }

const probeCache = new Map<string, { at: number; value: { ok: boolean; error?: string; listed?: boolean } }>();
const PROBE_TTL = 5 * 60_000;

/** Opens a real session (no tool server): the program's own answer to "is this player signed in". */
async function sessionProbe(id: ProviderId, cli: ResolvedCli, env: NodeJS.ProcessEnv, cwd: string): Promise<{ ok: boolean; error?: string }> {
  const key = `${id}\n${cli.command}\n${cli.prefix.join(' ')}`;
  const hit = probeCache.get(key);
  if (hit && Date.now() - hit.at < PROBE_TTL) return hit.value;
  const conn = new AcpConn(id, cli, cwd, childEnv(env, ''), [], () => undefined);
  const timer = setTimeout(() => conn.kill(), 60_000);
  try {
    await conn.open(cwd, null);
    probeCache.set(key, { at: Date.now(), value: { ok: true } });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `${(e as Error).message} ${conn.proc.stderr}` };
  } finally {
    clearTimeout(timer);
    conn.kill();
  }
}

/** Does this program's session list our tools? ACP has no tool listing, so the model is asked once (cached for this tool server). */
async function listsOurTools(id: ProviderId, cli: ResolvedCli, env: NodeJS.ProcessEnv, p: ToolProbe): Promise<{ ok: boolean; listed: boolean; error?: string }> {
  const key = `tools\n${id}\n${cli.command}\n${p.mcpUrl}`;
  const hit = probeCache.get(key);
  if (hit && Date.now() - hit.at < PROBE_TTL) return { ok: hit.value.ok, listed: !!hit.value.listed };
  let said = '';
  const conn = new AcpConn(id, cli, p.cwd, childEnv(env, p.secret), p.toolNames, (u) => { if (u.sessionUpdate === 'agent_message_chunk' && u.content?.text) said += u.content.text; });
  const timer = setTimeout(() => conn.kill(), 90_000);
  try {
    await conn.open(p.cwd, { url: p.mcpUrl, secret: p.secret });
    await conn.prompt(`Without calling any tool, list the names of the tools you have from the MCP server named "${MCP_SERVER_KEY}". Reply with only the names, comma separated, or NONE.`);
    const listed = p.toolNames.some((t) => said.includes(t));
    probeCache.set(key, { at: Date.now(), value: { ok: true, listed } });
    return { ok: true, listed };
  } catch (e) {
    return { ok: false, listed: false, error: `${(e as Error).message} ${conn.proc.stderr}` };
  } finally {
    clearTimeout(timer);
    conn.kill();
  }
}

/** Installed, new enough, signed in: for every provider (Claude and Codex by their own checks, the rest here). */
export async function detectAny(id: ProviderId, env: NodeJS.ProcessEnv = process.env, probe?: ToolProbe): Promise<ProviderStatus> {
  if (id === 'claude' || id === 'codex') return detectProvider(id, env);
  if (id === 'ollama') return detectOllama(env);
  const base = { id, minVersion: MIN_VERSION[id], loginCommand: LOGIN_COMMAND[id] };
  const cli = resolveCli(id, env);
  if (!cli) return { ...base, state: 'missing' };
  let v = await capture(cli, ['--version'], { timeoutMs: 20000, env });
  // Copilot documents a `version` command, not a flag
  if (!parseVersion(v.stdout + v.stderr) && id === 'copilot') v = await capture(cli, ['version'], { timeoutMs: 20000, env });
  if (v.spawnError || v.timedOut) return { ...base, state: 'unknown', detail: v.timedOut ? 'The program did not answer in 20 seconds.' : 'The program could not be started.' };
  const version = parseVersion(v.stdout + v.stderr);
  if (!version) return { ...base, state: 'unknown', detail: 'The program did not report a version.' };
  if (versionLess(version, MIN_VERSION[id])) return { ...base, state: 'old', version };

  const cwd = probe?.cwd ?? process.cwd();
  if (id === 'opencode') {
    const s = await capture(cli, ['auth', 'list'], { timeoutMs: 20000, env });
    if (s.spawnError || s.timedOut) return { ...base, state: 'unknown', version, detail: 'Could not check the sign-in.' };
    if (s.code !== 0) return { ...base, state: 'unknown', version, detail: 'The sign-in check failed.' };
    return /\b0\s+credentials?\b/i.test(s.stdout + s.stderr) ? { ...base, state: 'loggedOut', version } : { ...base, state: 'ready', version };
  }
  if (id === 'cursor') {
    const s = await capture(cli, ['status'], { timeoutMs: 20000, env: childEnv(env, '') });
    if (s.spawnError || s.timedOut) return { ...base, state: 'unknown', version, detail: 'Could not check the sign-in.' };
    if (s.code !== 0 || /not (?:logged|signed) in|login required/i.test(s.stdout + s.stderr)) return { ...base, state: 'loggedOut', version };
    if (!probe) return { ...base, state: 'hidden', version, detail: 'Cursor is shown once a build is open and its session lists the Path of Mastery tools.' };
    const t = await listsOurTools(id, cli, childEnv(env, ''), probe);
    if (!t.ok) return { ...base, state: 'unknown', version, detail: redact(t.error ?? 'Could not check the tools.').slice(0, 300) };
    return t.listed ? { ...base, state: 'ready', version } : { ...base, state: 'hidden', version, detail: 'Cursor’s session does not list the Path of Mastery tools, so it cannot be used here.' };
  }
  // copilot: no status command in its docs, so a real session says whether the player is signed in
  const s = await sessionProbe(id, cli, childEnv(env, ''), cwd);
  if (s.ok) return { ...base, state: 'ready', version };
  return classify(s.error ?? '') === 'loggedOut' ? { ...base, state: 'loggedOut', version } : { ...base, state: 'unknown', version, detail: redact(s.error ?? '').slice(0, 300) };
}
