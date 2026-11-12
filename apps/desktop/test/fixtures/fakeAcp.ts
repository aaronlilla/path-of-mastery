/* A stand-in for opencode / copilot / cursor: answers --version, `auth list`, `status`, and speaks ACP (JSON-RPC lines) on stdio. */
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
const log = (o: unknown) => { if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify(o) + '\n'); };
const TOOL = process.env.FAKE_TOOL ?? 'getTree';

if (argv.includes('--version') || argv[0] === 'version') { console.log('1.2.3'); process.exit(0); }
if (argv[0] === 'auth' && argv[1] === 'list') { console.log(process.env.FAKE_AUTH === 'out' ? '0 credentials' : '2 credentials'); process.exit(0); }
if (argv[0] === 'status') {
  if (process.env.FAKE_AUTH === 'out') { console.log('Not logged in'); process.exit(1); }
  console.log('Logged in as test@example.com'); process.exit(0);
}

const send = (o: object) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n');
let nextId = 100;
const waiting = new Map<number, (r: any) => void>();
const ask = (method: string, params: object) => new Promise<any>((resolve) => { const id = nextId++; waiting.set(id, resolve); send({ id, method, params }); });
const update = (u: object) => send({ method: 'session/update', params: { sessionId: 's1', update: u } });
let prompt = '';

const rl = createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  const j = JSON.parse(line);
  if (j.method === undefined && waiting.has(j.id)) { waiting.get(j.id)!(j); waiting.delete(j.id); return; }
  log({ in: j.method, params: j.params });
  if (j.method === 'initialize') return send({ id: j.id, result: { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: process.env.FAKE_NO_HTTP !== '1' } } } });
  if (j.method === 'session/new') return send({ id: j.id, result: { sessionId: 's1' } });
  if (j.method !== 'session/prompt') return;
  prompt = j.params.prompt[0].text;
  if (process.env.FAKE_SILENT === '1') return; // never answers: stall test
  // the tools probe asks for a list of tool names
  if (/names of the tools/.test(prompt)) {
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: process.env.FAKE_LISTS === '1' ? `pom_${TOOL}, other` : 'NONE' } });
    return send({ id: j.id, result: { stopReason: 'end_turn' } });
  }
  update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } });
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Let me look. ' } });
  update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: `pom_${TOOL}`, kind: 'other', status: 'in_progress', rawInput: { query: 'fire res' } });
  const opts = [{ optionId: 'a1', kind: 'allow_once', name: 'Allow' }, { optionId: 'r1', kind: 'reject_once', name: 'Reject' }];
  const ours = await ask('session/request_permission', { sessionId: 's1', toolCall: { toolCallId: 't1', title: `pom_${TOOL}`, kind: 'other' }, options: opts });
  const shell = await ask('session/request_permission', { sessionId: 's1', toolCall: { toolCallId: 't2', title: 'bash', kind: 'execute' }, options: opts });
  const plan = await ask('cursor/create_plan', { plan: 'x' });
  const question = await ask('cursor/ask_question', { question: 'x' });
  const fs = await ask('fs/read_text_file', { path: 'x' });
  log({ replies: { ours: ours.result, shell: shell.result, plan: plan.result, question: question.error, fs: fs.error } });
  update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' });
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Final answer.' } });
  send({ id: j.id, result: { stopReason: 'end_turn' } });
});
