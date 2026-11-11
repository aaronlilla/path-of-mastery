// The open build's engine session hooks (renderer/engineBuild.ts, renderer/useEngineHandle.ts) against a fake engine:
// overlapping changes keep each other, a reply for a replaced build never lands on the new one, and reading the build
// text back from the engine keeps the notes and Timeless dialog choices made only in the window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { annotationsOf, getNotes, setNotes, setTimelessData, readTimelessData, withWindowAnnotations } from '../src/shared/buildXml.js';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = join(here, '../..');
const bundle = join(here, 'engine-session.bundle.mjs');
buildSync({
  stdin: { contents: "export * from './src/renderer/engineBuild';\nexport * from './src/renderer/useEngineHandle';", resolveDir: desktop, loader: 'ts' },
  bundle: true,
  format: 'esm',
  platform: 'node',
  external: ['react', 'react-dom'],
  outfile: bundle,
  logLevel: 'silent',
});
const require = createRequire(bundle);
const React = require('react') as typeof import('react');
const { createRoot } = require('react-dom/client') as typeof import('react-dom/client');
// The hooks are bundled (the renderer resolves imports like a bundler), so they are typed loosely here.
/* eslint-disable @typescript-eslint/no-explicit-any */
const hooks = (await import(pathToFileURL(bundle).href)) as { useEngineBuild: (b: unknown, onXml: (x: string) => void) => any; useEngineHandle: (o: unknown, set: unknown) => any };

// ---- a DOM just big enough for react-dom to run hooks that render nothing ----
const g = globalThis as Record<string, unknown>;
g.IS_REACT_ACT_ENVIRONMENT = true;
const doc = { addEventListener() {}, removeEventListener() {}, activeElement: null, defaultView: globalThis };
g.document = doc;
g.window = globalThis;
g.HTMLIFrameElement = class {};
g.requestAnimationFrame = (f: () => void) => setTimeout(f, 0);
const container = () => ({ nodeType: 1, nodeName: 'DIV', tagName: 'DIV', namespaceURI: 'http://www.w3.org/1999/xhtml', addEventListener() {}, removeEventListener() {}, ownerDocument: doc });

// ---- a fake engine: one build text per session, the Life stat counts the edits ----
interface Deferred {
  release: () => void;
  wait: Promise<void>;
}
function deferred(): Deferred {
  let release!: () => void;
  const wait = new Promise<void>((r) => (release = r));
  return { release, wait };
}
class FakeEngine {
  xml = new Map<string, string>();
  life = new Map<string, number>();
  /** Holds the next replies of a command until released. */
  hold = new Map<string, Deferred[]>();
  async send(command: string, params: Record<string, unknown>): Promise<{ ok: true; result: unknown }> {
    const id = params.buildId as string;
    const h = this.hold.get(command)?.shift();
    // getBuildXml reads before it waits, the way a reply already on its way carries the text of that moment.
    const xmlNow = this.xml.get(id);
    if (h) await h.wait;
    const ok = (result: unknown) => ({ ok: true as const, result });
    switch (command) {
      case 'getStats':
        return ok({ stats: [{ id: 'Life', value: this.life.get(id) ?? 0 }] });
      case 'treeState':
        return ok({ tree: { nodes: [] } });
      case 'history':
        return ok({ undo: 0, redo: 0 });
      case 'mainSkill':
        return ok({ name: 'Fireball', flags: [] });
      case 'getBuildXml':
        return ok({ buildXml: xmlNow });
      case 'edit': {
        const edit = params.edit as { kind: string; xml?: string };
        if (edit.kind === 'setXml') this.xml.set(id, edit.xml!);
        const before = this.life.get(id) ?? 0;
        this.life.set(id, before + 1);
        return ok({ statDiff: { buildId: id, changed: [{ statId: 'Life', label: 'Life', before, after: before + 1 }] } });
      }
      default:
        throw new Error('unexpected ' + command);
    }
  }
  holdNext(command: string): Deferred {
    const d = deferred();
    this.hold.set(command, [...(this.hold.get(command) ?? []), d]);
    return d;
  }
}

const listeners = new Set<(e: unknown) => void>();
function install(engine: FakeEngine) {
  listeners.clear();
  g.pom = {
    sendCommand: (c: string, p: Record<string, unknown>) => engine.send(c, p),
    onEngineEvent: (f: (e: unknown) => void) => {
      listeners.add(f);
      return () => listeners.delete(f);
    },
    engine: { summary: async (buildId: string) => ({ ok: true, value: { buildId, statCount: 1, headline: [] } }) },
  };
}

const BASE = '<PathOfBuilding>\n\t<Build level="1"/>\n\t<Notes>\n\t\t\n\t</Notes>\n</PathOfBuilding>';
const openBuild = (buildId: string, rev = 0, xml = BASE) => ({ id: 'lib1', name: 'B', folder: '', xml, saved: xml, info: {} as never, engine: { state: 'ready' as const, summary: { buildId, statCount: 1, headline: [] } }, rev, engineAnn: annotationsOf(xml) });
const settle = () => new Promise((r) => setTimeout(r, 20));
const act = React.act as (f: () => unknown) => Promise<void>;

function renderEngineBuild(build: ReturnType<typeof openBuild>) {
  const out: { eng: any; xmls: Array<[string, boolean | undefined]> } = { eng: null, xmls: [] };
  function C({ b }: { b: typeof build }) {
    out.eng = hooks.useEngineBuild(b, (x: string, replace?: boolean) => out.xmls.push([x, replace]));
    return null;
  }
  const root = createRoot(container() as never);
  return {
    out,
    render: (b: typeof build) => act(async () => root.render(React.createElement(C, { b }))),
    unmount: () => act(async () => root.unmount()),
  };
}

test('two overlapping build text changes both land (read, change and write are one queued step)', async () => {
  const engine = new FakeEngine();
  engine.xml.set('b1', BASE);
  install(engine);
  const h = renderEngineBuild(openBuild('b1'));
  await h.render(openBuild('b1'));
  await act(settle);
  // Both reads would otherwise see the same text: the first read waits until the second change has also started.
  const firstRead = engine.holdNext('getBuildXml');
  let a!: Promise<unknown>;
  let b!: Promise<unknown>;
  await act(async () => {
    a = h.out.eng!.editXml((x: string) => x.replace('level="1"', 'level="1" A="1"'));
    b = h.out.eng!.editXml((x: string) => x.replace('level="1"', 'level="1" B="1"'));
    await settle();
    firstRead.release();
    await Promise.all([a, b]);
    await settle();
  });
  const xml = engine.xml.get('b1')!;
  assert.ok(xml.includes('A="1"'), 'the first change is kept');
  assert.ok(xml.includes('B="1"'), 'the second change is kept');
  await h.unmount();
});

test('an edit reply for a build that was replaced meanwhile does not change the new build', async () => {
  const engine = new FakeEngine();
  engine.xml.set('b1', BASE);
  engine.xml.set('b2', BASE);
  engine.life.set('b1', 100);
  engine.life.set('b2', 500);
  install(engine);
  const h = renderEngineBuild(openBuild('b1'));
  await h.render(openBuild('b1'));
  await act(settle);
  assert.equal(h.out.eng!.stats.Life, 100);
  const reply = engine.holdNext('edit');
  let p!: Promise<unknown>;
  await act(async () => {
    p = h.out.eng!.edit({ kind: 'setXml', xml: BASE });
    p.catch(() => undefined);
    await settle();
  });
  // An import replaces the session before the reply arrives.
  await h.render(openBuild('b2', 1));
  await act(settle);
  assert.equal(h.out.eng!.stats.Life, 500);
  await act(async () => {
    reply.release();
    await settle();
  });
  assert.equal(h.out.eng!.stats.Life, 500, "build A's reply did not land on build B");
  assert.deepEqual(await p, { changed: [], ms: 0 }, "the stale edit reports that nothing changed");
  await h.unmount();
});

test('an edit made through the tabs keeps the notes and Timeless choices typed only in the window', async () => {
  const engine = new FakeEngine();
  engine.xml.set('b1', BASE);
  install(engine);
  const out: { open: ReturnType<typeof openBuild> | null; set: ((f: (c: ReturnType<typeof openBuild> | null) => ReturnType<typeof openBuild> | null) => void) | null; handle: any } = { open: null, set: null, handle: null };
  function C() {
    const [open, setOpen] = React.useState<ReturnType<typeof openBuild> | null>(openBuild('b1'));
    out.open = open;
    out.set = setOpen;
    out.handle = hooks.useEngineHandle(open as never, setOpen as never);
    return null;
  }
  const root = createRoot(container() as never);
  await act(async () => root.render(React.createElement(C)));
  await act(async () => out.set!((c) => c && { ...c, xml: setTimelessData(setNotes(c.xml, 'my unsaved notes'), { jewelType: '1' }) }));
  await act(async () => {
    await out.handle!.edit({ kind: 'setXml', xml: BASE.replace('level="1"', 'level="2"') });
  });
  assert.ok(out.open!.xml.includes('level="2"'), 'the edit itself arrived');
  assert.equal(getNotes(out.open!.xml), 'my unsaved notes');
  assert.deepEqual(readTimelessData(out.open!.xml), { jewelType: '1' });
  // A whole build replacing this one in the engine (Import to this build) brings its own notes.
  await act(async () => {
    await out.handle!.edit({ kind: 'setXml', xml: setNotes(BASE, 'imported notes') });
  });
  assert.equal(getNotes(out.open!.xml), 'imported notes');
  assert.equal(readTimelessData(out.open!.xml), null);
  await act(async () => root.unmount());
});

test('a recalculation of the same build text moves the tabs engine version on', async () => {
  const engine = new FakeEngine();
  engine.xml.set('b1', BASE);
  install(engine);
  const out: { handle: any } = { handle: null };
  function C() {
    const [open, setOpen] = React.useState<ReturnType<typeof openBuild> | null>(openBuild('b1'));
    out.handle = hooks.useEngineHandle(open as never, setOpen as never);
    return null;
  }
  const root = createRoot(container() as never);
  await act(async () => root.render(React.createElement(C)));
  const v0 = out.handle.version;
  await act(async () => listeners.forEach((f) => f({ type: 'calcRev', buildId: 'b2', calcRev: 1 })));
  assert.equal(out.handle.version, v0, 'another build');
  await act(async () => listeners.forEach((f) => f({ type: 'calcRev', buildId: 'b1', calcRev: 1 })));
  assert.equal(out.handle.version, v0 + 1);
  await act(async () => root.unmount());
});

test('undoing an import brings back the notes the engine had before it', () => {
  const imported = setNotes(BASE, 'B');
  const window = setNotes(BASE, 'B');
  // The engine went back from B's notes to A's: its text is taken as it is.
  assert.equal(getNotes(withWindowAnnotations(setNotes(BASE, 'A'), window, annotationsOf(imported))), 'A');
  // The engine's notes did not change: the window's typed notes stay.
  assert.equal(getNotes(withWindowAnnotations(imported, setNotes(BASE, 'typed'), annotationsOf(imported))), 'typed');
});

test('the window annotations helper keeps the engine text when nothing differs', () => {
  assert.equal(withWindowAnnotations(BASE, BASE), BASE);
  const engineXml = BASE.replace('level="1"', 'level="5"');
  const merged = withWindowAnnotations(engineXml, setNotes(BASE, 'hi'));
  assert.ok(merged.includes('level="5"'));
  assert.equal(getNotes(merged), 'hi');
});
