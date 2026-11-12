import type { ProviderStatus, ToolChip, TurnEvent } from '../../shared/assistant/types.js';
import { LOGIN_COMMAND, MIN_VERSION, classify, makeError, redact, toolDetail } from './cli.js';
import { chipLabel, type Run, type RunOptions } from './runner.js';

/**
 * A local model through Ollama (docs.ollama.com/api/chat). Ollama has no agent loop and no MCP client, so this file is
 * both: it lists the app's tools from the app's own MCP server, offers them to the model as `tools`, runs the calls the
 * model asks for, and sends the results back as `tool` messages until the model answers in plain text.
 */

export const ollamaUrl = (env: NodeJS.ProcessEnv): string => (env.POM_OLLAMA_URL ?? 'http://127.0.0.1:11434').replace(/\/$/, '');

/** The model the last status check chose (first one that reports the `tools` capability). */
let chosen: string | undefined;

async function getJson(url: string, init?: RequestInit, ms = 5000): Promise<any> {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

export async function detectOllama(env: NodeJS.ProcessEnv = process.env): Promise<ProviderStatus> {
  const base = { id: 'ollama' as const, minVersion: MIN_VERSION.ollama, loginCommand: LOGIN_COMMAND.ollama };
  const url = ollamaUrl(env);
  let version: string;
  try {
    version = String((await getJson(`${url}/api/version`)).version ?? '');
  } catch {
    return { ...base, state: 'missing', detail: 'Ollama is not running. Install it from ollama.com and start it.' };
  }
  try {
    const tags = (await getJson(`${url}/api/tags`)).models as Array<{ name?: string }> | undefined;
    for (const m of (tags ?? []).slice(0, 20)) {
      if (!m.name) continue;
      const show = await getJson(`${url}/api/show`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: m.name }) }).catch(() => null);
      if (Array.isArray(show?.capabilities) && show.capabilities.includes('tools')) {
        chosen = m.name;
        return { ...base, state: 'ready', version, account: m.name };
      }
    }
  } catch {
    return { ...base, state: 'unknown', version, detail: 'Could not list the models.' };
  }
  chosen = undefined;
  return { ...base, state: 'unknown', version, detail: 'No installed model supports tool calling. Pull one (for example with “ollama pull”) and try again.' };
}

// ---- MCP over HTTP -----------------------------------------------------------------------------------------

async function mcp(url: string, secret: string, method: string, params: object, id?: number): Promise<any> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${secret}`, 'x-pom-client': 'panel' },
    body: JSON.stringify({ jsonrpc: '2.0', ...(id !== undefined ? { id } : {}), method, params }),
    signal: AbortSignal.timeout(120_000),
  });
  if (id === undefined) return undefined;
  if (!r.ok) throw new Error(`The build tools answered ${r.status}.`);
  const j = (await r.json()) as { result?: any; error?: { message?: string } };
  if (j.error) throw new Error(j.error.message ?? 'The build tools refused the call.');
  return j.result;
}

// ---- a turn ------------------------------------------------------------------------------------------------

interface OllamaCall { function?: { name?: string; arguments?: unknown } }
const MAX_ROUNDS = 40;

export function runOllamaTurn(o: RunOptions): Run {
  const secrets = [o.secret];
  const ctl = new AbortController();
  const chips = new Map<string, ToolChip>();
  let finished = false;
  let stopping = false;
  let killedFor: 'stalled' | 'timeout' | null = null;
  let resolveDone: () => void = () => undefined;
  const done = new Promise<void>((r) => (resolveDone = r));
  const stallMs = o.stallMs ?? 120_000;
  const stallFire = () => { killedFor = 'stalled'; ctl.abort(); };
  let stall = setTimeout(stallFire, stallMs);
  const total = setTimeout(() => { killedFor = 'timeout'; ctl.abort(); }, o.totalMs ?? 8 * 60_000);
  const alive = () => { clearTimeout(stall); if (!finished) stall = setTimeout(stallFire, stallMs); };

  const finish = (e: TurnEvent) => {
    if (finished) return;
    finished = true;
    clearTimeout(stall);
    clearTimeout(total);
    o.emit(e);
    resolveDone();
  };
  const fail = (err: unknown) => {
    if (stopping) return finish({ type: 'stopped', turnId: o.turnId });
    if (killedFor) return finish({ type: 'error', turnId: o.turnId, error: makeError(killedFor, undefined, secrets) });
    const why = redact(String((err as Error)?.message ?? err), secrets);
    const code = classify(why);
    finish({ type: 'error', turnId: o.turnId, error: makeError(code === 'failed' ? 'crashed' : code, why, secrets) });
  };
  const chip = (id: string, name: string, status: ToolChip['status'], input?: unknown) => {
    const prev = chips.get(id);
    const detail = (input !== undefined ? toolDetail(input) : undefined) ?? prev?.detail;
    const c: ToolChip = { id, label: prev?.label ?? chipLabel(name), status, ...(detail ? { detail } : {}) };
    chips.set(id, c);
    o.emit({ type: 'tool', turnId: o.turnId, chip: c });
  };

  void (async () => {
    try {
      const env = o.baseEnv ?? process.env;
      const url = ollamaUrl(env);
      if (!chosen) await detectOllama(env);
      if (!chosen) throw new Error('No installed Ollama model supports tool calling.');
      const model = chosen;
      await mcp(o.spec.mcpUrl, o.secret, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'path-of-mastery', version: '1' } }, 1);
      const listed = await mcp(o.spec.mcpUrl, o.secret, 'tools/list', {}, 2);
      const allowed = new Set(o.spec.toolNames);
      const tools = (listed.tools as Array<{ name: string; description?: string; inputSchema?: object }>).filter((t) => allowed.has(t.name))
        .map((t) => ({ type: 'function', function: { name: t.name, description: t.description ?? '', parameters: t.inputSchema ?? { type: 'object', properties: {} } } }));
      const messages: object[] = [{ role: 'user', content: o.prompt }];
      let text = '';
      let nextId = 3;
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const res = await fetch(`${url}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // Ollama's default context is 4096 tokens, too small for the instructions alone
          body: JSON.stringify({ model, messages, tools, stream: true, options: { num_ctx: 32768 } }),
          signal: ctl.signal,
        });
        if (!res.ok || !res.body) throw new Error(`Ollama answered ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
        let content = '';
        const calls: OllamaCall[] = [];
        let buf = '';
        const decoder = new TextDecoder();
        const handle = (line: string) => {
          if (!line.trim()) return;
          const j = JSON.parse(line) as { error?: string; message?: { content?: string; thinking?: string; tool_calls?: OllamaCall[] } };
          if (j.error) throw new Error(j.error);
          const m = j.message;
          if (m?.thinking) o.emit({ type: 'thinking', turnId: o.turnId, delta: m.thinking });
          if (m?.content) {
            const lead = !content && text ? '\n\n' : '';
            content += m.content;
            o.emit({ type: 'text', turnId: o.turnId, delta: lead + m.content });
          }
          if (m?.tool_calls) calls.push(...m.tool_calls);
        };
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          alive();
          buf += decoder.decode(chunk, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
        }
        handle(buf);
        text += (content && text ? '\n\n' : '') + content;
        if (!calls.length) return finish({ type: 'done', turnId: o.turnId, text: content || text });
        messages.push({ role: 'assistant', content, tool_calls: calls });
        for (const c of calls) {
          const name = c.function?.name ?? '';
          const args = typeof c.function?.arguments === 'string' ? JSON.parse(c.function.arguments || '{}') : (c.function?.arguments ?? {});
          const id = `ollama-${nextId}`;
          chip(id, name, 'running', args);
          let out: string;
          let ok = true;
          if (!allowed.has(name)) { out = `There is no tool named ${name}.`; ok = false; }
          else {
            try {
              const r = await mcp(o.spec.mcpUrl, o.secret, 'tools/call', { name, arguments: args }, nextId);
              out = (r.content as Array<{ text?: string }> | undefined)?.map((x) => x.text ?? '').join('\n') ?? '';
              ok = !r.isError;
            } catch (e) { out = (e as Error).message; ok = false; }
          }
          nextId++;
          chip(id, name, ok ? 'done' : 'failed');
          messages.push({ role: 'tool', tool_name: name, content: out.slice(0, 30000) });
          alive();
        }
      }
      throw new Error('The model kept calling tools without answering.');
    } catch (e) {
      fail(e);
    }
  })();

  return {
    stop: () => {
      if (finished) return;
      stopping = true;
      ctl.abort();
    },
    done,
  };
}
