// The assistant's first question on a never-saved build (renderer/assistant/useAssistant.ts): the panel saves the build, then
// asks on the build it saved. Against a fake main process: the question never goes to another build, a refusal keeps the draft.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = join(here, '../..');
const bundle = join(here, 'ai-first-question.bundle.mjs');
buildSync({
  stdin: { contents: "export { useAssistant } from './src/renderer/assistant/useAssistant';", resolveDir: desktop, loader: 'ts' },
  bundle: true, format: 'esm', platform: 'node', external: ['react', 'react-dom'], loader: { '.css': 'empty' }, outfile: bundle, logLevel: 'silent',
});
const require = createRequire(bundle);
const React = require('react') as typeof import('react');
const { createRoot } = require('react-dom/client') as typeof import('react-dom/client');
/* eslint-disable @typescript-eslint/no-explicit-any */
const { useAssistant } = (await import(pathToFileURL(bundle).href)) as { useAssistant: (b: unknown, o: unknown) => any };

const g = globalThis as Record<string, unknown>;
g.IS_REACT_ACT_ENVIRONMENT = true;
const doc = { addEventListener() {}, removeEventListener() {}, activeElement: null, defaultView: globalThis };
g.document = doc;
g.window = globalThis;
g.addEventListener = () => undefined;
g.removeEventListener = () => undefined;
g.HTMLIFrameElement = class {};
g.requestAnimationFrame = (f: () => void) => setTimeout(f, 0);
const container = () => ({ nodeType: 1, nodeName: 'DIV', tagName: 'DIV', namespaceURI: 'http://www.w3.org/1999/xhtml', addEventListener() {}, removeEventListener() {}, ownerDocument: doc });
const act = React.act as (f: () => unknown) => Promise<void>;
const settle = () => new Promise((r) => setTimeout(r, 20));

/** Main as the panel sees it: every send is recorded; `reply` decides what the turn does next. */
function fakeMain(reply: (turnId: string) => unknown) {
  const sent: Array<{ buildKey: string; text: string }> = [];
  let push: (p: unknown) => void = () => undefined;
  const ok = <T,>(value: T) => Promise.resolve({ ok: true, value });
  g.pom = {
    assistant: {
      getPrefs: () => ok({ open: true, provider: 'claude' }),
      setPrefs: () => ok(null),
      status: () => ok([{ id: 'claude', state: 'ready' }]),
      setContext: () => ok(null),
      getThread: () => ok({ messages: [], sessions: {}, results: {} }),
      setThread: () => ok(null),
      proposalStatuses: () => ok({}),
      onPush: (f: (p: unknown) => void) => { push = f; return () => undefined; },
      send: (req: { buildKey: string; text: string }) => {
        const turnId = `t${sent.push(req)}`;
        setTimeout(() => push({ kind: 'turn', event: reply(turnId) }), 5);
        return ok({ turnId });
      },
    },
  };
  return { sent };
}

const build = (id: string) => ({ id, name: 'New build', folder: '', xml: '', saved: '', info: {}, engine: { state: 'ready', summary: { buildId: 'e1', statCount: 1, headline: [] } } });

function mount() {
  const out: { a: any } = { a: null };
  function C({ b, saveFirst }: { b: unknown; saveFirst?: () => Promise<string | null> }) {
    out.a = useAssistant(b, { onEngineEdited: () => undefined, goTab: () => undefined, ...(saveFirst ? { saveFirst } : {}) });
    return null;
  }
  const root = createRoot(container() as never);
  return { out, render: (b: unknown, saveFirst?: () => Promise<string | null>) => act(async () => root.render(React.createElement(C, saveFirst ? { b, saveFirst } : { b }))) };
}

test('first question: the player opens another build while the new one saves, so the question is dropped, not asked there', async () => {
  const main = fakeMain((turnId) => ({ type: 'done', turnId, text: 'ok' }));
  const h = mount();
  let finishSave!: (id: string) => void;
  await h.render(build('unsaved:1'), () => new Promise((r) => (finishSave = r)));
  await act(settle);
  let sent!: Promise<boolean>;
  await act(async () => { sent = h.out.a.send('What is my total life?'); await settle(); });
  await h.render(build('other.xml')); // another saved build opens meanwhile
  await act(async () => { finishSave('New build.xml'); await settle(); });
  await act(settle);
  assert.equal(await sent, false);
  assert.equal(main.sent.length, 0);
  // and the panel is not stuck: the next question goes out on the open build
  await act(async () => { assert.equal(await h.out.a.send('And now?'), true); });
  assert.deepEqual(main.sent.map((s) => s.buildKey), ['other.xml']);
});

test('first question: refused after the save, so send says false and the draft stays', async () => {
  const main = fakeMain((turnId) => ({ type: 'error', turnId, error: { code: 'AI_ACCESS_REQUIRED', message: 'Pro' } }));
  const h = mount();
  await h.render(build('unsaved:1'), async () => 'New build.xml');
  await act(settle);
  let sent!: Promise<boolean>;
  await act(async () => { sent = h.out.a.send('What is my total life?'); await settle(); });
  await h.render(build('New build.xml')); // the saved build opens under its new key
  await act(settle);
  assert.deepEqual(main.sent.map((s) => s.buildKey), ['New build.xml']);
  assert.equal(await sent, false);
});

test('composer: send is accepted as soon as main takes it, not when the model first speaks (the box clears on Enter)', async () => {
  fakeMain(() => ({ type: 'tool', turnId: 't1', chip: { id: 'c1' } })); // first event is a tool call: not started/text/done
  const h = mount();
  await h.render(build('a.xml'));
  await act(settle);
  let accepted: boolean | null = null;
  await act(async () => { void h.out.a.send('What is my total life?').then((r: boolean) => { accepted = r; }); await new Promise((r) => setTimeout(r, 450)); });
  assert.equal(accepted, true);
});
