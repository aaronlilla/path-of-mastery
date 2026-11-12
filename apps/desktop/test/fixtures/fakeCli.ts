/**
 * A stand-in for the player's `claude` and `codex` programs, for tests and for driving the real app without
 * spending a subscription. It answers `--version` and the sign-in checks, and in a turn it imitates one behaviour
 * picked by FAKE_MODE: a normal answer, a scripted run that really calls the app's MCP tools, or one failure
 * (logged out, limit reached, overloaded, offline, crash mid-stream, hang, tools unreachable).
 *
 * Environment: FAKE_MODE, FAKE_VERSION, FAKE_AUTH (in | out | apikey), FAKE_LOG (file that records argv, stdin and
 * a few environment facts), FAKE_STEPS (JSON list of {call, args} or {text}), FAKE_CODEX_VERSION, FAKE_REJECT_THINKING,
 * FAKE_EMAIL and FAKE_PLAN (what `auth status` reports), FAKE_STATE (file: `logout` writes "out" into it and every later
 * status check reads it, like a credentials file; FAKE_STATE_CODEX is the same for `codex`), FAKE_MODE_FILE (file whose
 * content replaces FAKE_MODE, so a run can change it between questions), FAKE_LOGIN_HANG (`auth login` / `login` stays running until killed).
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const args = process.argv.slice(2);
const kind: 'claude' | 'codex' = args[0] === 'exec' ? 'codex' : 'claude';
const env = process.env;
const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + '\n');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function log(o: unknown): void {
  if (env.FAKE_LOG) appendFileSync(env.FAKE_LOG, JSON.stringify(o) + '\n');
}

async function readStdin(): Promise<string> {
  let s = '';
  for await (const c of process.stdin) s += c;
  return s;
}

async function main(): Promise<void> {
  if (args.includes('--version') || args.includes('-v')) {
    console.log(kind === 'codex' ? `codex-cli ${env.FAKE_CODEX_VERSION ?? env.FAKE_VERSION ?? '0.157.1'}` : `${env.FAKE_VERSION ?? '2.1.286'} (Claude Code)`);
    return;
  }
  // The sign-in checks. FAKE_STATE (a file) wins over FAKE_AUTH once a logout wrote to it.
  if ((args[0] === 'auth' && args[1] === 'status') || (args[0] === 'login' && args[1] === 'status')) {
    const file = args[0] === 'login' ? (env.FAKE_STATE_CODEX ?? env.FAKE_STATE) : env.FAKE_STATE;
    const a = file && existsSync(file) ? readFileSync(file, 'utf8').trim() : (env.FAKE_AUTH ?? 'in');
    if (args[0] === 'auth') {
      console.log(JSON.stringify(a === 'out' ? { loggedIn: false } : { loggedIn: true, authMethod: a === 'apikey' ? 'api_key' : 'claude.ai', ...(env.FAKE_EMAIL ? { email: env.FAKE_EMAIL } : {}), ...(env.FAKE_PLAN ? { subscriptionType: env.FAKE_PLAN } : {}) }));
      process.exitCode = 0;
    } else if (a === 'out') {
      console.error('Not logged in');
      process.exitCode = 1;
    } else console.log(a === 'apikey' ? 'Logged in using an API key' : 'Logged in using ChatGPT');
    return;
  }
  if ((args[0] === 'auth' && args[1] === 'logout') || args[0] === 'logout') {
    log({ logout: args.join(' ') });
    if (env.FAKE_LOGOUT_FAIL) {
      process.exitCode = 1; // FAKE_LOGOUT_FAIL: the program could not sign out and says so; the sign-in state stays
      return;
    }
    const file = args[0] === 'logout' ? (env.FAKE_STATE_CODEX ?? env.FAKE_STATE) : env.FAKE_STATE;
    if (file) writeFileSync(file, 'out');
    return;
  }
  if ((args[0] === 'auth' && args[1] === 'login') || args[0] === 'login') {
    log({ login: true, pid: process.pid });
    // FAKE_LOGIN_GRANDCHILD: like codex.cmd -> codex.js -> the native program, a child of the sign-in program that outlives a plain kill
    if (env.FAKE_LOGIN_GRANDCHILD) log({ grandchild: spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore', windowsHide: true }).pid });
    if (env.FAKE_LOGIN_HANG) await sleep(600_000);
    return;
  }

  // FAKE_REJECT_THINKING: a claude that does not know --thinking-display stops with the option parser's error, before any output
  if (env.FAKE_REJECT_THINKING && args.includes('--thinking-display')) {
    log({ rejected: true, argv: args });
    process.stderr.write("error: unknown option '--thinking-display'\n");
    process.exitCode = 1;
    return;
  }

  // --input-format stream-json: one long-lived program, one JSON user message per line, one turn per message (warm turns).
  if (args.includes('--input-format')) {
    log({ start: true, pid: process.pid });
    let buf = '';
    for await (const c of process.stdin) {
      buf += String(c);
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const m = JSON.parse(line) as { type?: string; message?: { content?: unknown } };
        if (m.type === 'user') await turn(String(m.message?.content ?? ''));
      }
    }
    return;
  }
  await turn(await readStdin());
}

async function turn(stdin: string): Promise<void> {
  log({ argv: args, stdin, pid: process.pid, tokenLength: (env.POM_MCP_TOKEN ?? '').length, apiKeyPresent: !!env.ANTHROPIC_API_KEY, claudeMds: env.CLAUDE_CODE_DISABLE_CLAUDE_MDS ?? null, cwd: process.cwd() });
  const mode = (env.FAKE_MODE_FILE && existsSync(env.FAKE_MODE_FILE) ? readFileSync(env.FAKE_MODE_FILE, 'utf8').trim() : '') || (env.FAKE_MODE ?? 'ok');
  const session = '11111111-2222-3333-4444-555555555555';

  const init = (status = 'connected') => (kind === 'claude' ? out({ type: 'system', subtype: 'init', session_id: session, mcp_servers: [{ name: 'pom', status }], tools: [] }) : out({ type: 'thread.started', thread_id: session }));
  const delta = (text: string) =>
    kind === 'claude' ? out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }, session_id: session }) : undefined;
  const done = (text: string) => {
    if (kind === 'claude') {
      out({ type: 'assistant', message: { content: [{ type: 'text', text }] }, session_id: session });
      out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: session });
    } else {
      out({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text } });
      out({ type: 'turn.completed', usage: {} });
    }
  };
  const failResult = (text: string) => {
    if (kind === 'claude') out({ type: 'result', subtype: 'success', is_error: true, result: text, session_id: session });
    else {
      out({ type: 'error', message: text });
      out({ type: 'turn.failed', error: { message: text } });
    }
  };

  switch (mode) {
    case 'ok': {
      init();
      for (const t of ['Hello', ' from', ' the fake program.']) {
        delta(t);
        await sleep(15);
      }
      done('Hello from the fake program.');
      return;
    }
    case 'stream': {
      // a long answer token by token, as Claude Code sends it with --include-partial-messages
      init();
      const words = Array.from({ length: 40 }, (_, i) => `w${i} `);
      for (const t of words) {
        delta(t);
        await sleep(5);
      }
      done(words.join(''));
      return;
    }
    case 'loggedOut':
      init();
      failResult('Not logged in · Please run /login');
      return;
    case 'loggedOutText':
      // what the real program prints: its own words arrive as the answer text, then the failed result
      init();
      out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Not logged in · Please run /login' }] }, session_id: session });
      failResult('Not logged in · Please run /login');
      return;
    case 'limit':
      init();
      failResult('5-hour limit reached ∙ resets in 2 hours. Upgrade for more usage.');
      return;
    case 'overloaded':
      init();
      failResult('API Error: 529 Overloaded');
      return;
    case 'offline':
      init();
      failResult('API Error: Unable to connect to API (ENOTFOUND api.anthropic.com)');
      return;
    case 'mcpfail':
      init('failed');
      failResult('The tool server could not be reached.');
      return;
    case 'startupFail':
      // stops before printing anything, for a reason that is not the flag (no connection, a broken install)
      console.error('Error: getaddrinfo ENOTFOUND api.anthropic.com');
      process.exit(1);
      return;
    case 'crash':
      init();
      delta('Starting to answer, then');
      await sleep(40);
      console.error('thread panicked at fake.rs: boom Bearer abcdef0123456789abcdef');
      process.exit(3);
      return;
    case 'hang':
      init();
      delta('Thinking');
      await sleep(600_000);
      return;
    case 'slow': {
      init();
      for (let i = 0; i < 200; i++) {
        delta(`word${i} `);
        await sleep(100);
      }
      done('slow');
      return;
    }
    case 'tools': {
      init();
      const cfgIdx = args.indexOf('--mcp-config');
      let url = '';
      if (cfgIdx >= 0) url = (JSON.parse(args[cfgIdx + 1]!) as { mcpServers: { pom: { url: string } } }).mcpServers.pom.url;
      else {
        const u = args.find((a) => a.startsWith('mcp_servers.pom.url='));
        url = JSON.parse(u!.slice('mcp_servers.pom.url='.length)) as string;
      }
      const client = new Client({ name: kind === 'claude' ? 'claude-code' : 'codex-mcp-client', version: '0.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${env.POM_MCP_TOKEN ?? ''}`, 'X-Pom-Client': 'panel' } } }));
      const steps = JSON.parse(env.FAKE_STEPS_FILE ? readFileSync(env.FAKE_STEPS_FILE, 'utf8') : (env.FAKE_STEPS ?? '[]')) as Array<{ call?: string; args?: Record<string, unknown>; text?: string }>;
      let text = '';
      let n = 0;
      const refs: string[] = [];
      for (const s of steps) {
        if (s.call) {
          const id = `toolu_${++n}`;
          if (kind === 'claude') out({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: `mcp__pom__${s.call}`, input: s.args ?? {} }] }, session_id: session });
          else out({ type: 'item.started', item: { id, type: 'mcp_tool_call', server: 'pom', tool: s.call, status: 'in_progress' } });
          const r = (await client.callTool({ name: s.call, arguments: s.args ?? {} })) as { isError?: boolean; content: Array<{ text?: string }> };
          log({ tool: s.call, isError: !!r.isError, text: r.content[0]?.text });
          try {
            refs.push((JSON.parse(r.content[0]?.text ?? '{}') as { ref?: string }).ref ?? '');
          } catch {
            refs.push('');
          }
          if (kind === 'claude') out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: !!r.isError, content: r.content }] }, session_id: session });
          else out({ type: 'item.completed', item: { id, type: 'mcp_tool_call', server: 'pom', tool: s.call, status: r.isError ? 'failed' : 'completed' } });
        } else if (s.text) {
          // {{@2:path}} names the second tool call's ref, which the model would copy from the result.
          const t = s.text.replace(/\{\{@(\d+):/g, (_m, k: string) => `{{${refs[Number(k) - 1] ?? 'missing'}:`);
          for (const piece of t.match(/[\s\S]{1,20}/g) ?? []) {
            delta(piece);
            await sleep(5);
          }
          text += t;
        }
      }
      await client.close();
      done(text);
      return;
    }
    default:
      done('unknown mode');
  }
}

void main();
