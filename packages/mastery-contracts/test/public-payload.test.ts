import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicItemPayloadSchema, publicRichTextSchema, publicTextFromMarkdown, sanitizePublicPayload } from '../src/index.js';
import { limits, plan, publicPayload } from './fixtures/v1.js';

test('public projection recursively removes every undeclared field and excludes notes/history by default', () => {
  const input = publicPayload();
  const forbidden = { privateNotes: 'private-marker', logPath: 'path-marker', rawLog: 'log-marker', email: 'email-marker', shareToken: 'token-marker', credentials: { token: 'credential-marker' } };
  function taint(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(taint); return; }
    Object.values(value).forEach(taint);
    Object.assign(value, forbidden);
  }
  taint(input);
  const before = JSON.stringify(input);
  const result = sanitizePublicPayload(input, limits);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  const serialized = JSON.stringify(result.value);
  for (const marker of Object.values(forbidden).filter(item => typeof item === 'string')) assert.ok(!serialized.includes(marker));
  assert.ok(!serialized.includes('credential-marker'));
  assert.ok(!serialized.includes('Optional'));
  assert.equal(result.value.history, undefined);
  assert.equal(JSON.stringify(input), before);
  assert.equal(publicItemPayloadSchema.parse(result.value, limits).ok, true);
});

test('explicit notes/history inclusion redacts all historical snapshots and retains source credits', () => {
  const input = publicPayload();
  Object.assign(input.history![0]!.snapshot.payload, { privateNotes: 'history-secret', email: 'history-email' });
  if (input.document.kind !== 'timeline') throw new Error('Expected a timeline fixture.');
  Object.assign(input.document.payload.dependencies[0]!.snapshot.payload, { rawLog: 'dependency-secret' });
  const result = sanitizePublicPayload(input, limits, { includeNotes: true, includeHistory: true });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  const serialized = JSON.stringify(result.value);
  for (const marker of ['history-secret', 'history-email', 'dependency-secret']) assert.ok(!serialized.includes(marker));
  assert.ok(serialized.includes('Optional plan notes.'));
  assert.equal(result.value.credits[0]!.status, 'original_removed');
  assert.equal(result.value.history!.length, 1);
});

test('public projection is idempotent, detached and shared between desktop and web', () => {
  const result = sanitizePublicPayload(publicPayload(), limits, { includeNotes: true, includeHistory: true });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(sanitizePublicPayload(JSON.parse(JSON.stringify(result.value)), limits, { includeNotes: true, includeHistory: true }), result);
  result.value.title = 'Changed local projection';
  assert.notEqual(publicPayload().title, result.value.title);
});

test('public projection validates nested payloads instead of blessing malformed public data', () => {
  const input = publicPayload();
  if (input.document.kind !== 'timeline') throw new Error('Expected a timeline fixture.');
  input.document.payload.timeline.clips[0]!.options[0]!.actions[0]!.instruction.firstAction = 'x'.repeat(161);
  assert.equal(sanitizePublicPayload(input, limits).ok, false);
  assert.equal(sanitizePublicPayload({ ...publicPayload(), visibility: 'private' }, limits).ok, false);
  assert.equal(sanitizePublicPayload({ ...publicPayload(), votes: { up: 0, down: 1, net: 1 } }, limits).ok, false);
});

test('public projection bounds and cycle checks include fields that would be redacted', () => {
  const input = publicPayload() as unknown as Record<string, unknown>;
  input.privateData = input;
  const result = sanitizePublicPayload(input, limits);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.issues[0]!.code, 'CYCLIC_PAYLOAD');
  assert.equal(sanitizePublicPayload({ ...publicPayload(), privateNotes: 'x'.repeat(20001) }, limits).ok, false);
});

test('every public document kind uses the same explicit projection', () => {
  const input = publicPayload();
  input.document = { kind: 'atlas', payload: plan() };
  const result = sanitizePublicPayload(input, limits);
  assert.equal(result.ok, true);
  if (result.ok) assert.ok(!JSON.stringify(result.value).includes('Optional plan notes.'));
});

test('dynamic ID records redact reserved private fields without discarding legitimate game IDs', () => {
  const input = publicPayload();
  input.document = { kind: 'atlas', payload: plan() };
  input.document.payload.stepsById['fixture-step']!.effectSelections = { 'fixture-node': 'fixture-effect', private_notes: 'dynamic-private-marker', accessToken: 'dynamic-token-marker' };
  const result = sanitizePublicPayload(input, limits);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok || result.value.document.kind !== 'atlas') return;
  assert.deepEqual(result.value.document.payload.stepsById['fixture-step']!.effectSelections, { 'fixture-node': 'fixture-effect' });
  assert.ok(!JSON.stringify(result.value).includes('dynamic-private-marker'));
});

test('local XML, raw commands and account settings never enter the public build representation', () => {
  const input = publicPayload();
  if (input.document.kind !== 'timeline') throw new Error('Expected a timeline fixture.');
  Object.assign(input.document.payload.dependencies[0]!.snapshot.payload, { buildXml: '<Notes>xml-private-marker</Notes>', rawCommands: ['command-private-marker'], accountSettings: { email: 'account-private-marker' } });
  const result = sanitizePublicPayload(input, limits);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  for (const marker of ['xml-private-marker', 'command-private-marker', 'account-private-marker']) assert.ok(!JSON.stringify(result.value).includes(marker));
});

test('limited Markdown produces typed text and HTTPS links without HTML or executable tokens', () => {
  const result = publicTextFromMarkdown('# Heading\n- **Bold** and *emphasis* and `code`\n[Safe](https://example.com/guide) [Bad](javascript:alert)\n<script>alert(1)</script>', limits);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  const tokens = result.value.flatMap(block => block.content);
  assert.equal(tokens.filter(token => token.kind === 'link').length, 1);
  assert.ok(tokens.some(token => token.kind === 'text' && token.text === '<script>alert(1)</script>'));
  assert.equal(publicRichTextSchema.parse(result.value, limits).ok, true);
  assert.ok(!tokens.some(token => 'href' in token && token.href.startsWith('javascript:')));
});

test('rich text rejects raw HTML, scripts, insecure URLs and credential-bearing HTTPS', () => {
  for (const href of ['javascript:alert(1)', 'data:text/html,script', 'http://example.com', 'file:///C:/file', 'https://user:password@example.com', 'https://example.com\\path', ' https://example.com']) {
    assert.equal(publicRichTextSchema.parse([{ kind: 'paragraph', content: [{ kind: 'link', text: 'Link', href }] }], limits).ok, false, href);
  }
  assert.equal(publicRichTextSchema.parse([{ kind: 'html', html: '<img onerror=alert(1)>' }], limits).ok, false);
  assert.equal(publicRichTextSchema.parse([{ kind: 'paragraph', content: [{ kind: 'script', text: 'alert(1)' }] }], limits).ok, false);
});
