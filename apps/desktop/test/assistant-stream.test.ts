// The panel's live view (Thinking, steps, answer) is built from what the two CLIs print. The fixtures are real output lines
// captured from the CLIs: stream-claude and stream-codex are one app turn each (claude 2.1.301
// with --thinking-display summarized; codex-cli 0.164.0 with model_reasoning_summary="auto", default effort, which sent no
// reasoning item that turn). stream-codex-reasoning is codex at high effort on a small prompt, where it did.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeStream, CodexStream, toolDetail, type CliEvent } from '../src/main/assistant/cli.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const feed = (parser: ClaudeStream | CodexStream, file: string): CliEvent[] =>
  fs.readFileSync(path.join(here, '../../test/fixtures', file), 'utf8').split('\n').filter(Boolean).flatMap((l) => parser.feed(l));
const joined = (events: CliEvent[], type: 'text' | 'thinking') => events.filter((e) => e.type === type).map((e) => (e as { delta: string }).delta).join('');
const resultOf = (events: CliEvent[]) => events.find((e): e is Extract<CliEvent, { type: 'result' }> => e.type === 'result');

function steps(events: CliEvent[]) {
  const tools = events.filter((e): e is Extract<CliEvent, { type: 'tool' }> => e.type === 'tool');
  assert.ok(tools.length > 0, 'tool steps reach the panel');
  for (const id of new Set(tools.map((t) => t.id))) {
    const mine = tools.filter((t) => t.id === id);
    assert.equal(mine[0]!.status, 'running', `${id} shows as running first`);
    assert.ok(mine[0]!.name, `${id} is named when it starts`);
    assert.notEqual(mine[mine.length - 1]!.status, 'running', `${id} ends done or failed`);
  }
  // only what was written after the last tool call is the answer; the panel moves earlier text into Thinking
  const lastTool = events.map((e) => e.type).lastIndexOf('tool');
  const result = resultOf(events);
  assert.ok(result?.ok && result.text.trim(), 'the turn ends with an answer');
  assert.equal(joined(events.slice(lastTool + 1), 'text').trim(), result.text.trim());
  return { tools, result, before: joined(events.slice(0, lastTool), 'text').trim() };
}

test('claude stream: thinking text, tool steps with their search words, and the answer', () => {
  const events = feed(new ClaudeStream(), 'stream-claude.jsonl');
  assert.ok(joined(events, 'thinking').trim().length > 40, 'summarized thinking reaches the panel');
  const { tools } = steps(events);
  assert.ok(tools.some((t) => t.detail === 'fire resistance'), 'the tree search shows what it searched for');
  assert.ok(tools.some((t) => t.status === 'done'));
});

test('codex stream: tool steps with their search words; the note before the tools is not part of the answer', () => {
  const events = feed(new CodexStream(), 'stream-codex.jsonl');
  const { tools, result, before } = steps(events);
  assert.ok(tools.some((t) => t.detail === 'fire resistance'));
  assert.ok(before.length > 10, 'codex wrote a note before its first tool call');
  assert.ok(!result!.text.includes(before), 'the answer is only the message after the last tool call');
});

test('codex stream: reasoning summaries reach the panel as thinking, not as answer text', () => {
  const events = feed(new CodexStream(), 'stream-codex-reasoning.jsonl');
  assert.ok(joined(events, 'thinking').includes('Troubleshooting tool issues'));
  assert.ok(!joined(events, 'text').includes('Troubleshooting'));
  assert.ok(resultOf(events)!.text.includes('I couldn’t read gear.txt'));
});

test('codex stream: an item error before completion is a diagnostic, a terminal failure fails the turn', () => {
  const seq = (...lines: object[]) => { const p = new CodexStream(); return lines.flatMap((l) => p.feed(JSON.stringify(l))); };
  const msg = { type: 'item.completed', item: { type: 'agent_message', text: 'Done.' } };
  const err = { type: 'item.completed', item: { type: 'error', message: 'Under-development features enabled' } };
  const ok = resultOf(seq(msg, err, { type: 'turn.completed' }))!;
  assert.equal(ok.ok, true);
  assert.equal(ok.text, 'Done.');
  assert.deepEqual(ok.diagnostics, ['Under-development features enabled']);
  const bad = resultOf(seq(msg, err, { type: 'turn.failed', error: { message: 'boom' } }))!;
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'boom');
  assert.equal(resultOf(seq(msg, err)), undefined, 'final text alone is not success');
});

test('a tool step names the words it searched for', () => {
  assert.equal(toolDetail({ query: ' fire resistance ' }), 'fire resistance');
  assert.equal(toolDetail('{"query":"life"}'), 'life');
  assert.equal(toolDetail({ nodeIds: [1, 2] }), undefined);
  assert.equal(toolDetail('not json'), undefined);
});
