// The assistant's live gem swap (and its Undo) change the engine directly; App then copies the new build text into the open
// build. The Skills tab loads its groups when the engine handle's `version` moves, so it must move for that text too
// (renderer/useEngineHandle.ts). Regression: the Skills tab kept "Enhance" after "Swap Enhance for Hypothermia".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setNotes, setTimelessData } from '../src/shared/buildXml.js';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = join(here, '../..');
const bundle = join(here, 'engine-handle-external-edit.bundle.mjs');
buildSync({
  stdin: { contents: "export { useEngineHandle } from './src/renderer/useEngineHandle';", resolveDir: desktop, loader: 'ts' },
  bundle: true, format: 'esm', platform: 'node', external: ['react', 'react-dom'], loader: { '.css': 'empty' }, outfile: bundle, logLevel: 'silent',
});
const require = createRequire(bundle);
const React = require('react') as typeof import('react');
const { createRoot } = require('react-dom/client') as typeof import('react-dom/client');
/* eslint-disable @typescript-eslint/no-explicit-any */
const { useEngineHandle } = (await import(pathToFileURL(bundle).href)) as { useEngineHandle: (o: unknown, set: unknown) => any };

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

test('a gem swap the assistant made (and its Undo) reloads the Skills tab state', async () => {
  // The engine's own state: which support gem the group holds.
  let gem = 'Enhance';
  g.pom = {
    sendCommand: async (command: string) => (command === 'history' ? { ok: true, result: { undo: 0, redo: 0 } } : { ok: true, result: { buildXml: `<PathOfBuilding>${gem}</PathOfBuilding>` } }),
    engine: { summary: async () => ({ ok: true, value: { buildId: 'e1', statCount: 1, headline: [] } }) },
    onEngineEvent: () => () => undefined,
  };
  const open = (xml: string) => ({ id: 'b.xml', xml, engine: { state: 'ready', summary: { buildId: 'e1', statCount: 1, headline: [] } } });
  const out: { setOpen: (xml: string) => void; shown: string[] } = { setOpen: () => undefined, shown: [] };
  function C() {
    const [cur, set] = React.useState<any>(open('<PathOfBuilding>Enhance</PathOfBuilding>'));
    out.setOpen = (xml) => set(open(xml));
    const engine = useEngineHandle(cur, set);
    // What SkillsTab does: read the groups from the engine whenever buildId or version changes.
    React.useEffect(() => {
      if (engine) out.shown.push(gem);
    }, [engine?.buildId, engine?.version]);
    return null;
  }
  const root = createRoot(container() as never);
  await act(async () => root.render(React.createElement(C)));
  await act(settle);
  assert.equal(out.shown.at(-1), 'Enhance');

  // The assistant swaps the gem in the engine, then App copies the new text into the open build (engineEdited).
  gem = 'Hypothermia';
  await act(async () => { out.setOpen('<PathOfBuilding>Hypothermia</PathOfBuilding>'); await settle(); });
  assert.equal(out.shown.at(-1), 'Hypothermia', 'Skills tab must read the swapped gem');

  // Undo from the assistant's change chip goes the same way.
  gem = 'Enhance';
  await act(async () => { out.setOpen('<PathOfBuilding>Enhance</PathOfBuilding>'); await settle(); });
  assert.equal(out.shown.at(-1), 'Enhance', 'Skills tab must show the old gem again after Undo');
});

test('a notes edit or a Find Timeless Jewel choice does not reload the tabs', async () => {
  const sent: string[] = [];
  g.pom = {
    sendCommand: async (command: string) => { sent.push(command); return command === 'history' ? { ok: true, result: { undo: 0, redo: 0 } } : { ok: true, result: { buildXml: '<PathOfBuilding></PathOfBuilding>' } }; },
    engine: { summary: async () => ({ ok: true, value: { buildId: 'e1', statCount: 1, headline: [] } }) },
    onEngineEvent: () => () => undefined,
  };
  const base = '<PathOfBuilding>\n\t<Build level="1"/>\n\t<Notes>\n\t\t\n\t</Notes>\n</PathOfBuilding>';
  const open = (xml: string) => ({ id: 'b.xml', xml, engine: { state: 'ready', summary: { buildId: 'e1', statCount: 1, headline: [] } } });
  const out: { setOpen: (xml: string) => void; versions: number[] } = { setOpen: () => undefined, versions: [] };
  function C() {
    const [cur, set] = React.useState<any>(open(base));
    out.setOpen = (xml) => set(open(xml));
    const engine = useEngineHandle(cur, set);
    React.useEffect(() => {
      if (engine) out.versions.push(engine.version);
    }, [engine?.buildId, engine?.version]);
    return null;
  }
  const root = createRoot(container() as never);
  await act(async () => root.render(React.createElement(C)));
  await act(settle);
  const before = out.versions.length;
  const noted = setTimelessData(setNotes(base, 'ab'), { jewelType: '1' });
  await act(async () => { out.setOpen(setNotes(base, 'a')); await settle(); });
  await act(async () => { out.setOpen(setNotes(base, 'ab')); await settle(); });
  await act(async () => { out.setOpen(noted); await settle(); });
  assert.equal(out.versions.length, before, 'the tabs keep their state');
  assert.ok(!sent.includes('history'), 'no history read for a notes edit');
  // a real change to the build from outside the handle still reloads them
  await act(async () => { out.setOpen(noted.replace('level="1"', 'level="2"')); await settle(); });
  assert.equal(out.versions.length, before + 1);
});
