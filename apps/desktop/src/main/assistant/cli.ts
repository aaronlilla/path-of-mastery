import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, extname, join, resolve } from 'node:path';
import { planLabel } from '../../shared/assistant/account.js';
import { PROVIDER_CLI, type ProviderId, type ProviderStatus, type TurnError, type TurnErrorCode } from '../../shared/assistant/types.js';
import type { FailureCode } from '@pom/mastery-contracts';
import { AI_MESSAGES, AiDenied } from '../aiGate/gate.js';

/**
 * Talking to the player's own `claude` and `codex` programs. This file only starts them and reads what they print.
 * It never opens their credential files: "is the player signed in" is whatever the program itself says.
 */

export const MIN_VERSION: Record<ProviderId, string> = { claude: '2.0.0', codex: '0.100.0', opencode: '0.1.0', copilot: '0.0.1', cursor: '0.0.1', ollama: '0.5.0' };
// Sign-in commands: docs.github.com copilot-cli (`copilot login`), cursor.com/docs/cli (`login`), docs.opencode.ai/docs/cli (`auth login`).
export const LOGIN_COMMAND: Record<ProviderId, string> = { claude: 'claude auth login', codex: 'codex login', opencode: 'opencode auth login', copilot: 'copilot login', cursor: 'agent login', ollama: 'ollama serve' };
export const LOGIN_ARGS: Record<ProviderId, string[]> = { claude: ['auth', 'login'], codex: ['login'], opencode: ['auth', 'login'], copilot: ['login'], cursor: ['login'], ollama: [] };
/** The programs' own sign-out (`claude auth logout`, `codex logout`). Empty: no sign-out command found in the vendor docs. */
export const LOGOUT_ARGS: Record<ProviderId, string[]> = { claude: ['auth', 'logout'], codex: ['logout'], opencode: ['auth', 'logout'], copilot: [], cursor: [], ollama: [] };

export interface ResolvedCli {
  command: string;
  /** Arguments that come before the ones the app builds (a script path when the command is node). */
  prefix: string[];
  /** Variables the command needs (ELECTRON_RUN_AS_NODE when the app's own runtime runs a script). */
  env: Record<string, string>;
}

const OVERRIDE_ENV: Record<ProviderId, string> = { claude: 'POM_CLAUDE_CLI', codex: 'POM_CODEX_CLI', opencode: 'POM_OPENCODE_CLI', copilot: 'POM_COPILOT_CLI', cursor: 'POM_CURSOR_CLI', ollama: 'POM_OLLAMA_CLI' };

function scriptRunner(script: string): ResolvedCli {
  return { command: process.execPath, prefix: [script], env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {} };
}

/** A program on PATH, or null. On Windows an npm `.cmd` shim is unwrapped to the script it runs, so no shell is involved. */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): ResolvedCli | null {
  const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean);
  const exts = platform === 'win32' ? ['.exe', '.cmd'] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = join(dir, name + ext);
      try {
        if (!existsSync(file) || !statSync(file).isFile()) continue;
      } catch {
        continue;
      }
      if (ext === '.cmd') {
        const shim = readFileSync(file, 'utf8');
        const m = /"%dp0%\\([^"]+?\.(?:js|mjs|cjs))"/i.exec(shim);
        if (!m) continue;
        const script = resolve(dirname(file), m[1]!.replace(/\\/g, '/'));
        if (existsSync(script)) return scriptRunner(script);
        continue;
      }
      return { command: file, prefix: [], env: {} };
    }
  }
  return null;
}

/** Finds the CLI for a provider. `POM_CLAUDE_CLI` / `POM_CODEX_CLI` point at another program or a .js/.mjs script (tests). */
export function resolveCli(id: ProviderId, env: NodeJS.ProcessEnv = process.env): ResolvedCli | null {
  const override = env[OVERRIDE_ENV[id]];
  if (override !== undefined) {
    if (!override) return null;
    if (!existsSync(override)) return null;
    return /\.(c|m)?js$/i.test(extname(override)) ? scriptRunner(override) : { command: override, prefix: [], env: {} };
  }
  // Ollama is a local server the app talks to over HTTP (ollama.ts); there is no program to start.
  if (id === 'ollama') return { command: 'ollama', prefix: [], env: {} };
  if (id === 'cursor') {
    // `agent` is Cursor's name in its docs; Grok's installer ships an `agent` too, so only one that lives under a Cursor folder counts.
    const a = findOnPath('agent', env);
    if (a && /cursor/i.test([a.command, ...a.prefix].join(' '))) return a;
    return findOnPath('cursor-agent', env);
  }
  return findOnPath(PROVIDER_CLI[id], env);
}

export interface Captured {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
}

/** Runs a short command and collects its output. Arguments are an array: nothing goes through a shell. */
export function capture(cli: ResolvedCli, args: string[], opts: { timeoutMs: number; env?: NodeJS.ProcessEnv; cwd?: string }): Promise<Captured> {
  return new Promise((resolveP) => {
    let out = '';
    let err = '';
    let done = false;
    let timedOut = false;
    const finish = (c: Captured) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolveP(c);
    };
    let child;
    try {
      child = spawn(cli.command, [...cli.prefix, ...args], { env: { ...(opts.env ?? process.env), ...cli.env }, cwd: opts.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return finish({ code: null, stdout: '', stderr: '', timedOut: false, spawnError: (e as Error).message });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, opts.timeoutMs);
    child.stdout.on('data', (d: Buffer) => (out = (out + d.toString('utf8')).slice(-20000)));
    child.stderr.on('data', (d: Buffer) => (err = (err + d.toString('utf8')).slice(-20000)));
    child.on('error', (e) => finish({ code: null, stdout: out, stderr: err, timedOut, spawnError: e.message }));
    child.on('close', (code) => finish({ code, stdout: out, stderr: err, timedOut }));
  });
}

export function parseVersion(text: string): string | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

export function versionLess(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0);
  }
  return false;
}

/** Is the CLI installed, new enough, and signed in with the player's subscription? */
export async function detectProvider(id: ProviderId, env: NodeJS.ProcessEnv = process.env): Promise<ProviderStatus> {
  if (id !== 'claude' && id !== 'codex') throw new Error(`detectProvider: ${id} is checked by detectAny (acp.ts)`);
  const base = { id, minVersion: MIN_VERSION[id], loginCommand: LOGIN_COMMAND[id] };
  const cli = resolveCli(id, env);
  if (!cli) return { ...base, state: 'missing' };
  const v = await capture(cli, ['--version'], { timeoutMs: 20000, env });
  if (v.spawnError || v.timedOut) return { ...base, state: 'unknown', detail: v.timedOut ? 'The program did not answer in 20 seconds.' : 'The program could not be started.' };
  const version = parseVersion(v.stdout + v.stderr);
  if (!version) return { ...base, state: 'unknown', detail: 'The program did not report a version.' };
  if (versionLess(version, MIN_VERSION[id])) return { ...base, state: 'old', version };

  if (id === 'claude') {
    const s = await capture(cli, ['auth', 'status'], { timeoutMs: 20000, env });
    if (s.spawnError || s.timedOut) return { ...base, state: 'unknown', version, detail: 'Could not check the sign-in.' };
    let parsed: { loggedIn?: boolean; authMethod?: string; email?: string; subscriptionType?: string } | null = null;
    try {
      parsed = JSON.parse(s.stdout) as { loggedIn?: boolean; authMethod?: string; email?: string; subscriptionType?: string };
    } catch {
      parsed = null;
    }
    if (parsed) {
      if (!parsed.loggedIn) return { ...base, state: 'loggedOut', version };
      if (/api|console/i.test(parsed.authMethod ?? '')) return { ...base, state: 'apiKey', version };
      const plan = planLabel(parsed.subscriptionType);
      return { ...base, state: 'ready', version, ...(typeof parsed.email === 'string' && /^[^\s@]+@[^\s@]+$/.test(parsed.email) ? { account: parsed.email } : {}), ...(plan ? { plan } : {}) };
    }
    if (/not logged in|logged out/i.test(s.stdout + s.stderr) || s.code !== 0) return { ...base, state: 'loggedOut', version };
    return { ...base, state: 'unknown', version, detail: 'The sign-in check gave an answer the app does not understand.' };
  }

  const s = await capture(cli, ['login', 'status'], { timeoutMs: 20000, env });
  if (s.spawnError || s.timedOut) return { ...base, state: 'unknown', version, detail: 'Could not check the sign-in.' };
  const text = s.stdout + s.stderr;
  if (s.code !== 0 || /not logged in/i.test(text)) return { ...base, state: 'loggedOut', version };
  if (/api key/i.test(text)) return { ...base, state: 'apiKey', version };
  return { ...base, state: 'ready', version };
}

// ---- argument lists -----------------------------------------------------------------------------------------

export const MCP_SERVER_KEY = 'pom';
export const TOKEN_ENV = 'POM_MCP_TOKEN';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TurnSpec {
  mcpUrl: string;
  /** Tool names the model may call (without the server prefix). */
  toolNames: string[];
  system: string;
  sessionId?: string;
  /** Player's picks; unset adds no flag. */
  model?: string;
  effort?: string;
}

/** Ask Claude Code for its thinking text. Off for the rest of the session once the installed CLI rejected the flag. */
/** Web research (Claude WebSearch/WebFetch, Codex live search). A CLI that rejects it runs without it for the rest of the session (runner.ts). */
let webResearch = true;
export const setWebResearch = (on: boolean): void => { webResearch = on; };
export const webResearchOn = (): boolean => webResearch;
let thinkingDisplay = true;
export const thinkingDisplayOn = (): boolean => thinkingDisplay;
export function setThinkingDisplay(on: boolean): void {
  thinkingDisplay = on;
}

const SYSTEM_DIR_PREFIX = 'pom-sys-';

/**
 * The system prompt goes by file: on Windows a command line over 32,767 characters cannot start, and the prompt had
 * grown to that. `--system-prompt-file` came in Claude Code 1.0.55 (CHANGELOG.md), older than MIN_VERSION, so there is
 * no inline fallback. Sync because the callers are; the folder is new under the player's own temp folder and
 * `dropSystemFile` removes it when the program ends.
 */
function writeSystemFile(system: string): string {
  const dir = mkdtempSync(join(tmpdir(), SYSTEM_DIR_PREFIX));
  const file = join(dir, 'system.txt');
  writeFileSync(file, system, { mode: 0o600 });
  return file;
}

/** Deletes the system prompt file named in a claude argument list (no-op for anything else). */
export function dropSystemFile(args: string[]): void {
  const i = args.indexOf('--system-prompt-file');
  const file = i >= 0 ? args[i + 1] : undefined;
  if (!file || !basename(dirname(file)).startsWith(SYSTEM_DIR_PREFIX)) return;
  rmSync(dirname(file), { recursive: true, force: true });
}

/** Deletes `pom-sys-*` folders in `dir` older than `maxAgeMs`: the ones a quit left behind before the program's close event ran. */
export function sweepSystemDirs(dir = tmpdir(), maxAgeMs = 24 * 3600_000): void {
  try {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (!d.isDirectory() || !d.name.startsWith(SYSTEM_DIR_PREFIX)) continue;
      const p = join(dir, d.name);
      try { if (Date.now() - statSync(p).mtimeMs > maxAgeMs) rmSync(p, { recursive: true, force: true }); } catch { /* in use or gone */ }
    }
  } catch { /* temp folder unreadable */ }
}

/**
 * Claude Code in print mode. The question goes in on stdin. The app's tools are the only ones: the built-in tools
 * are switched off, other MCP servers are ignored, and only this server's tools are allowed. The secret is not on
 * the command line: the config names an environment variable the CLI expands.
 * `warm`: the program stays running and takes one JSON user message per line on stdin (`--input-format stream-json`,
 * https://code.claude.com/docs/en/cli-reference), so it boots and connects to the tools before the question and keeps
 * the conversation between questions.
 */
const WEB_TOOLS = ['WebSearch', 'WebFetch'];

export function claudeArgs(spec: TurnSpec, warm = false): string[] {
  const config = { mcpServers: { [MCP_SERVER_KEY]: { type: 'http', url: spec.mcpUrl, headers: { Authorization: `Bearer \${${TOKEN_ENV}}`, 'X-Pom-Client': 'panel' } } } };
  const args = [
    '-p',
    ...(warm ? ['--input-format', 'stream-json'] : []),
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--tools', webResearch ? WEB_TOOLS.join(',') : '',
    '--strict-mcp-config',
    '--mcp-config', JSON.stringify(config),
    '--allowedTools', [...(webResearch ? WEB_TOOLS : []), ...spec.toolNames.map((t) => `mcp__${MCP_SERVER_KEY}__${t}`)].join(','),
    '--setting-sources', 'project',
    '--disable-slash-commands',
    // --thinking-display is a hidden flag (claude --help leaves it out; the showThinkingSummaries setting does not reach print
    // mode). Without it current models send thinking blocks with empty text. A CLI that rejects it switches it off (runner.ts).
    ...(thinkingDisplay ? ['--thinking-display', 'summarized'] : []),
    '--system-prompt-file', writeSystemFile(spec.system),
  ];
  if (spec.model) args.push('--model', spec.model);
  if (spec.effort) args.push('--effort', spec.effort);
  if (spec.sessionId && UUID.test(spec.sessionId)) args.push('--resume', spec.sessionId);
  return args;
}

/** One player message for a warm Claude Code program (the Agent SDK's user message shape). */
export const claudeUserLine = (text: string): string => JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n';

/**
 * Codex in non-interactive mode. Read-only sandbox, no shell tool, the player's own config and rules ignored, the
 * app's server attached with the secret read from an environment variable.
 */
export function codexArgs(spec: TurnSpec, cwd: string): string[] {
  return [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--ephemeral',
    '-s', 'read-only',
    '--ignore-user-config',
    '--ignore-rules',
    '--disable', 'shell_tool',
    '-C', cwd,
    '-c', 'approval_policy="never"',
    ...(webResearch ? ['-c', 'web_search="live"'] : []),
    ...(spec.model ? ['-m', spec.model] : []),
    ...(spec.effort ? ['-c', `model_reasoning_effort=${JSON.stringify(spec.effort)}`] : []),
    // with the player's config ignored, Codex sends no `reasoning` items unless a summary is asked for
    '-c', 'model_reasoning_summary="auto"',
    '-c', `mcp_servers.${MCP_SERVER_KEY}.url=${JSON.stringify(spec.mcpUrl)}`,
    '-c', `mcp_servers.${MCP_SERVER_KEY}.bearer_token_env_var=${JSON.stringify(TOKEN_ENV)}`,
    '-c', `mcp_servers.${MCP_SERVER_KEY}.http_headers={ "X-Pom-Client" = "panel" }`,
    '-c', `mcp_servers.${MCP_SERVER_KEY}.default_tools_approval_mode="approve"`,
    '-c', `mcp_servers.${MCP_SERVER_KEY}.tool_timeout_sec=120`,
    '-',
  ];
}

/** Variables the child gets: the player's own environment, minus anything that would switch it to an API key. */
export function childEnv(base: NodeJS.ProcessEnv, secret: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'CURSOR_API_KEY', 'CURSOR_AUTH_TOKEN']) delete env[k];
  env[TOKEN_ENV] = secret;
  env.CLAUDE_CODE_DISABLE_CLAUDE_MDS = '1';
  return env;
}

// ---- stream parsing -----------------------------------------------------------------------------------------

export type CliEvent =
  | { type: 'init'; mcp: Array<{ name: string; status: string }> }
  | { type: 'text'; delta: string }
  /** The model's reasoning as it arrives (Claude thinking, Codex reasoning summaries). */
  | { type: 'thinking'; delta: string }
  /** `detail`: the tool's search words, when it has any ("chaos resistance"). */
  | { type: 'tool'; id: string; name?: string; status: 'running' | 'done' | 'failed'; detail?: string }
  | { type: 'retry'; error: string }
  | { type: 'result'; ok: boolean; text: string; sessionId?: string; error?: string; diagnostics?: string[] };

/** The short words a tool call searches for, shown next to its step ("Searching tree for “fire res”"). */
export function toolDetail(input: unknown): string | undefined {
  const o = (typeof input === 'string' ? (() => { try { return JSON.parse(input) as unknown; } catch { return null; } })() : input) as Record<string, unknown> | null;
  const q = o && typeof o === 'object' ? o.query ?? o.search ?? o.name ?? o.url : undefined;
  return typeof q === 'string' && q.trim() ? q.trim().slice(0, 40) : undefined;
}

/** Reads Claude Code's `stream-json` lines. */
export class ClaudeStream {
  private sawText = false;
  private sawThinking = false;
  private thinkingAny = false;
  /** A new thinking block started after earlier thinking: its first piece starts a new paragraph. */
  private gap = false;
  private sessionId: string | undefined;
  private lastText = '';

  feed(line: string): CliEvent[] {
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return [];
    }
    if (typeof j.session_id === 'string') this.sessionId = j.session_id;
    const out: CliEvent[] = [];
    switch (j.type) {
      case 'system': {
        if (j.subtype === 'init') {
          const list = Array.isArray(j.mcp_servers) ? (j.mcp_servers as Array<{ name?: string; status?: string }>) : [];
          out.push({ type: 'init', mcp: list.map((s) => ({ name: String(s.name ?? ''), status: String(s.status ?? '') })) });
        } else if (j.subtype === 'api_retry') {
          out.push({ type: 'retry', error: String((j as { error?: unknown }).error ?? 'unknown') });
        }
        break;
      }
      case 'stream_event': {
        const ev = j.event as { type?: string; delta?: { type?: string; text?: string; thinking?: string }; content_block?: { type?: string; id?: string; name?: string } } | undefined;
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && typeof ev.delta.text === 'string') {
          this.sawText = true;
          out.push({ type: 'text', delta: ev.delta.text });
        } else if (ev?.type === 'content_block_delta' && ev.delta?.type === 'thinking_delta' && ev.delta.thinking) {
          this.sawThinking = true;
          out.push({ type: 'thinking', delta: (this.gap ? '\n\n' : '') + ev.delta.thinking });
          this.thinkingAny = true;
          this.gap = false;
        } else if (ev?.type === 'content_block_start' && ev.content_block?.type === 'thinking') {
          this.gap = this.thinkingAny;
        } else if (ev?.type === 'content_block_start' && ev.content_block?.type === 'tool_use' && ev.content_block.id) {
          // the step shows the moment the call starts, before its arguments finish streaming
          out.push({ type: 'tool', id: ev.content_block.id, name: String(ev.content_block.name ?? ''), status: 'running' });
        }
        break;
      }
      case 'assistant': {
        const content = (j.message as { content?: Array<Record<string, unknown>> } | undefined)?.content ?? [];
        for (const b of content) {
          if (b.type === 'tool_use') {
            const detail = toolDetail(b.input);
            out.push({ type: 'tool', id: String(b.id), name: String(b.name), status: 'running', ...(detail ? { detail } : {}) });
          } else if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking && !this.sawThinking) {
            out.push({ type: 'thinking', delta: (this.thinkingAny ? '\n\n' : '') + b.thinking });
            this.thinkingAny = true;
          } else if (b.type === 'text' && typeof b.text === 'string') {
            this.lastText = b.text;
            if (!this.sawText) out.push({ type: 'text', delta: b.text });
          }
        }
        break;
      }
      case 'user': {
        const content = (j.message as { content?: unknown } | undefined)?.content;
        if (Array.isArray(content)) {
          for (const b of content as Array<Record<string, unknown>>) {
            if (b.type === 'tool_result') out.push({ type: 'tool', id: String(b.tool_use_id), status: b.is_error ? 'failed' : 'done' });
          }
        }
        break;
      }
      case 'result': {
        const isError = j.is_error === true || (typeof j.subtype === 'string' && j.subtype.startsWith('error'));
        const text = typeof j.result === 'string' ? j.result : '';
        out.push({ type: 'result', ok: !isError, text: text || this.lastText, ...(this.sessionId ? { sessionId: this.sessionId } : {}), ...(isError ? { error: text || String(j.subtype ?? 'failed') } : {}) });
        break;
      }
    }
    return out;
  }
}

/** Reads `codex exec --json` lines. Codex sends each assistant message and reasoning summary whole, not token by token. */
export class CodexStream {
  private sessionId: string | undefined;
  private texts: string[] = [];
  /** Messages written after the last tool call: the answer (the ones before it narrate the model's steps). */
  private answer: string[] = [];
  private thinkingAny = false;
  /** Item errors and error events: kept for the log, they do not fail a turn that completes. */
  private diagnostics: string[] = [];

  feed(line: string): CliEvent[] {
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return [];
    }
    const out: CliEvent[] = [];
    const item = (j.item ?? {}) as Record<string, unknown>;
    switch (j.type) {
      case 'thread.started':
        if (typeof j.thread_id === 'string') this.sessionId = j.thread_id;
        out.push({ type: 'init', mcp: [] });
        break;
      case 'item.started':
        if (item.type === 'web_search') out.push({ type: 'tool', id: String(item.id), name: 'web_search', status: 'running', ...(toolDetail(item) ? { detail: toolDetail(item) } : {}) });
        else if (item.type === 'mcp_tool_call') {
          const detail = toolDetail(item.arguments);
          this.answer = [];
          out.push({ type: 'tool', id: String(item.id), name: String(item.tool ?? ''), status: 'running', ...(detail ? { detail } : {}) });
        }
        break;
      case 'item.completed':
        if (item.type === 'web_search') out.push({ type: 'tool', id: String(item.id), name: 'web_search', status: 'done' });
        else if (item.type === 'mcp_tool_call') out.push({ type: 'tool', id: String(item.id), name: String(item.tool ?? ''), status: item.status === 'failed' || item.error ? 'failed' : 'done' });
        else if (item.type === 'agent_message' && typeof item.text === 'string') {
          const t = this.texts.length ? '\n\n' + item.text : item.text;
          this.texts.push(item.text);
          this.answer.push(item.text);
          out.push({ type: 'text', delta: t });
        } else if (item.type === 'reasoning' && typeof item.text === 'string' && item.text.trim()) {
          out.push({ type: 'thinking', delta: (this.thinkingAny ? '\n\n' : '') + item.text.trim() });
          this.thinkingAny = true;
        } else if (item.type === 'error' && typeof item.message === 'string') this.diagnostics.push(item.message);
        break;
      case 'turn.failed':
        out.push({ type: 'result', ok: false, text: '', error: String((j.error as { message?: unknown } | undefined)?.message ?? 'The turn failed.') });
        break;
      case 'error':
        // Codex also sends this for reconnect notices; only turn.failed is terminal.
        this.diagnostics.push(String(j.message ?? 'error'));
        break;
      case 'turn.completed':
        out.push({ type: 'result', ok: true, text: (this.answer.length ? this.answer : this.texts).join('\n\n'), ...(this.sessionId ? { sessionId: this.sessionId } : {}), ...(this.diagnostics.length ? { diagnostics: this.diagnostics } : {}) });
        break;
    }
    return out;
  }
}

// ---- failure classification ---------------------------------------------------------------------------------

const PATTERNS: Array<[TurnErrorCode, RegExp]> = [
  ['limit', /usage limit|rate.?limit|limit (?:reached|will reset)|too many requests|\b429\b|quota|five_hour|seven_day|out of (?:messages|credits)/i],
  ['overloaded', /overloaded|\b529\b|\b503\b|capacity|try again (?:later|in a)/i],
  ['loggedOut', /not logged in|please run.{0,20}login|authentication_failed|authentication.{0,10}(?:failed|required|error)|invalid (?:api key|credentials)|\b401\b|unauthori[sz]ed|log in again|sign in again|token.{0,12}expired|session expired/i],
  ['ineligible', /not eligible|isn.t available for your|no access|account.{0,20}(?:suspended|disabled|not (?:authorized|allowed))|subscription (?:required|has ended)/i],
  ['offline', /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|getaddrinfo|fetch failed|network (?:error|is unreachable)|offline|unable to connect|could not resolve|no internet|routing discovery failed|error sending request|stream disconnected|failed to connect|proxy/i],
];

/** Sorts a CLI's error text into one of the states the panel has words for. */
export function classify(text: string): TurnErrorCode {
  for (const [code, re] of PATTERNS) if (re.test(text)) return code;
  return 'failed';
}

/** Seconds until a limit resets, when the text says ("resets in 12 minutes", "try again in 90 seconds"). */
export function retrySeconds(text: string): number | undefined {
  const m = /(?:in|after)\s+(\d+)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b/i.exec(text);
  if (!m) return undefined;
  const n = parseInt(m[1]!, 10);
  const u = m[2]!.toLowerCase();
  return u.startsWith('h') ? n * 3600 : u.startsWith('m') ? n * 60 : n;
}

export const ERROR_COPY: Record<Exclude<TurnErrorCode, FailureCode>, string> = {
  missing: 'The program for this assistant is not installed on this PC.',
  old: 'The installed program is too old to work with Path of Mastery.',
  loggedOut: 'You are not signed in. Sign in again to keep going.',
  apiKey: 'This program is signed in with an API key, not your subscription. Path of Mastery only uses a subscription.',
  limit: 'Your subscription’s usage limit is reached. It resets on its own; try again later.',
  overloaded: 'The service is busy right now. Try again in a moment.',
  offline: 'No connection to the service. Check your internet and try again.',
  crashed: 'The assistant program stopped unexpectedly.',
  stalled: 'The assistant stopped responding and was ended.',
  timeout: 'The assistant took too long and was ended.',
  mcpFailed: 'The assistant could not reach Path of Mastery’s build tools.',
  ineligible: 'Your account cannot use this assistant. Check your plan with the provider.',
  noBuild: 'Open a build first. The assistant works on the build you have open.',
  failed: 'The assistant could not answer.',
};

const SECRET_LIKE = /(Bearer\s+[A-Za-z0-9._~+/=-]{8,}|sk-[A-Za-z0-9_-]{12,}|[0-9a-f]{40,})/gi;

/** Removes anything that looks like a token or secret from text before it is shown or kept. */
export function redact(text: string, secrets: string[] = []): string {
  let out = text.replace(SECRET_LIKE, '[hidden]');
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join('[hidden]');
  return out;
}

export function makeError(code: TurnErrorCode, detail?: string, secrets: string[] = []): TurnError {
  const retry = detail ? retrySeconds(detail) : undefined;
  const message = code in ERROR_COPY ? ERROR_COPY[code as keyof typeof ERROR_COPY] : AI_MESSAGES[code as FailureCode] ?? ERROR_COPY.failed;
  return { code, message, ...(detail ? { detail: redact(detail, secrets).slice(0, 600) } : {}), ...(retry && code === 'limit' ? { retryInSeconds: retry } : {}) };
}

const NETWORK_ERROR = /fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|socket hang up/i;
/**
 * A step of a turn threw. The gate's own denial passes as it is; a network or timeout failure keeps the "can't reach" text;
 * any other error is logged whole and shown as what it was (it used to read as "Can't reach Path of Mastery").
 */
export function turnFailure(e: unknown, where: string): TurnError {
  if (e instanceof AiDenied) return { code: e.code, message: e.message, ...(e.retryAt ? { retryAt: e.retryAt } : {}) };
  console.error(`[assistant] ${where} failed:`, e);
  const err = e instanceof Error ? e : new Error(String(e));
  if (err.name === 'AbortError' || err.name === 'TimeoutError' || NETWORK_ERROR.test(`${err.message} ${(err.cause as Error | undefined)?.message ?? ''}`)) {
    const d = new AiDenied('ENTITLEMENT_UNAVAILABLE');
    return { code: d.code, message: d.message };
  }
  return { code: 'failed', message: `Something went wrong: ${(err.message.split('\n')[0] ?? '').trim().slice(0, 120) || 'unexpected error'}` };
}
