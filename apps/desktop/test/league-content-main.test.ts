// League content switched off, in the main process (src/shared/leagueContent.ts):
// with ATLAS_MECHANICS switched off, wireAtlas registers no optimizer or AI-plan channel and sends no taxonomy to the renderer;
// with LEVELING_GUIDE switched off, freezing a library build for the assistant generates no guide, and neither that nor the
// knowledge base reads leveling route or skill data. Every file the code under test opens is recorded by an fs spy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, readFile as realReadFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MASTERY_LIMITS, openDocumentCore, type MasteryContext } from '../src/main/mastery/context.js';
import { ATLAS_AI_CHANNEL, ATLAS_ART_CHANNEL, ATLAS_OPTIMIZER_CHANNEL, ATLAS_PORT_CHANNEL, wireAtlas } from '../src/main/mastery/atlas.js';
import { ATLAS_CHANNEL } from '../src/main/atlas/ipc.js';
import { wireLibrarySources } from '../src/main/mastery/libraryBuilds.js';
import { appSource } from '../src/main/kb/sources/app.js';
import { ATLAS_MECHANICS, LEVELING_GUIDE } from '../src/shared/leagueContent.js';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const appDir = join(repo, 'apps', 'desktop');

// fs spy: every path passed to the promise API (the code under test imports it as named bindings, so the builtin's
// ESM exports are re-synced after patching).
const opened: string[] = [];
const api = fsp as unknown as Record<string, (...a: unknown[]) => unknown>;
for (const name of ['readFile', 'readdir', 'stat', 'open']) {
  const real = api[name]!;
  api[name] = (...a: unknown[]) => { opened.push(String(a[0])); return real(...a); };
}
syncBuiltinESMExports();
const LEVELING_DATA = /[\\/]leveling[\\/][^\\/]+[\\/](routes|leveling-skills\.json)|[\\/]routes[\\/]act-\d+\.txt/;
const TAXONOMY_FILES = /taxonomy-(draft|approval)\.json/;

/** Taxonomy targets anywhere in an IPC response (objects, arrays and Maps). */
function targetsIn(value: unknown, seen = new Set<unknown>()): number {
  if (!value || typeof value !== 'object' || seen.has(value)) return 0;
  seen.add(value);
  const children = value instanceof Map ? [...value.values()] : Array.isArray(value) ? value : Object.values(value);
  const own = (value as { taxonomy?: { targets?: unknown[] } }).taxonomy?.targets?.length ?? 0;
  return own + children.reduce<number>((n, c) => n + targetsIn(c, seen), 0);
}

type Handler =(event: unknown, input: unknown) => Promise<unknown>;
async function context(dir: string) {
  const handlers = new Map<string, Handler>();
  const { documents } = await openDocumentCore(dir, MASTERY_LIMITS);
  const ctx = {
    ipc: { handle: (ch: string, fn: Handler) => void handlers.set(ch, fn), removeHandler: (ch: string) => void handlers.delete(ch) },
    userDataDir: dir, resourcesDir: join(appDir, 'resources'), atlasResourcesDir: join(repo, 'resources', 'atlas'), isPackaged: false, appVersion: 'test',
    limits: MASTERY_LIMITS, documents, isMainSender: () => true, push: () => undefined, onQuit: () => undefined, chooseSaveFile: async () => null,
    ai: { state: { status: 'off' }, onChange: () => () => undefined },
  } as unknown as MasteryContext;
  return { ctx, handlers, documents };
}

test('switches off', () => {
  assert.equal(ATLAS_MECHANICS, false);
  assert.equal(LEVELING_GUIDE, false);
});

test('Atlas: no optimizer or AI-plan channel, and the taxonomy never reaches the renderer', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pom-park-atlas-'));
  const { ctx, handlers, documents } = await context(dir);
  try {
    opened.length = 0;
    const wired = await wireAtlas(ctx);
    const channels = [...handlers.keys()].sort();
    console.log('IPC channels wireAtlas registered:', channels.join(', '));
    assert.ok(channels.includes(ATLAS_CHANNEL) && channels.includes(ATLAS_PORT_CHANNEL) && channels.includes(ATLAS_ART_CHANNEL), 'plans, tree and art stay');
    assert.ok(!channels.includes(ATLAS_OPTIMIZER_CHANNEL), 'no optimizer channel');
    assert.ok(!channels.includes(ATLAS_AI_CHANNEL), 'no AI-plan channel');
    const atlas = handlers.get(ATLAS_CHANNEL)!;
    const catalogs = (await atlas(null, { schemaVersion: 1, method: 'catalogs' })) as { ok: boolean; value: { ref: unknown }[] };
    assert.ok(catalogs.ok && catalogs.value.length > 0, 'a catalog is available');
    const dataset = catalogs.value[0]!.ref;
    const catalog = (await atlas(null, { schemaVersion: 1, method: 'catalog', dataset })) as { ok: boolean; value: { taxonomy: { targets: unknown[] }; graph: { nodes: unknown[] } } };
    assert.ok(catalog.ok, JSON.stringify(catalog));
    console.log(`catalog sent: ${catalog.value.graph.nodes.length} tree nodes, ${catalog.value.taxonomy.targets.length} taxonomy targets`);
    assert.ok(catalog.ok && catalog.value.graph.nodes.length > 100, 'the tree is sent');
    assert.equal(catalog.value.taxonomy.targets.length, 0, 'no taxonomy targets are sent');
    const art = (await handlers.get(ATLAS_ART_CHANNEL)!(null, { dataset })) as { ok: boolean; value: { names: object; targets: object; icons: object } };
    assert.ok(art.ok && Object.keys(art.value.icons).length > 0, 'node art index is sent');
    assert.deepEqual([art.value.names, art.value.targets], [{}, {}], 'no mechanic names or targets');
    // Every Atlas and editor-port handler that returns plan data: no response carries a taxonomy target.
    type Res = { ok: boolean; value: unknown; error?: unknown };
    const counts: string[] = [];
    const check = async (label: string, res: Promise<unknown>): Promise<Res> => {
      const r = (await res) as Res;
      assert.ok(r.ok, `${label}: ${JSON.stringify(r.error)}`);
      const n = targetsIn(r.value);
      counts.push(`${label}=${n}`);
      assert.equal(n, 0, `${label} sends taxonomy targets`);
      return r;
    };
    const port = (method: string, ...args: unknown[]) => handlers.get(ATLAS_PORT_CHANNEL)!(null, { method, args });
    type Rec = { source: { objectId: string; revisionId: string }; view: { document: { payload: { stamp: unknown } } } };
    const info = (await check('port.data', port('data'))).value as { data: { dataset: unknown; stamp: unknown; budget: number }[] };
    const d = info.data[0]!;
    const firstId = crypto.randomUUID();
    await check('atlas.create', atlas(null, { schemaVersion: 1, method: 'create', objectId: firstId, dataset: d.dataset, stamp: d.stamp, budget: d.budget, title: 'P', idempotencyKey: crypto.randomUUID() }));
    await check('atlas.list', atlas(null, { schemaVersion: 1, method: 'list' }));
    await check('atlas.read', atlas(null, { schemaVersion: 1, method: 'read', objectId: firstId }));
    await check('port.list', port('list'));
    const rec = (await check('port.read', port('read', firstId))).value as Rec;
    const plan = rec.view.document.payload;
    const created = (await check('port.create', port('create', plan, 'Created plan'))).value as Rec;
    const saved = (await check('port.save', port('save', { objectId: created.source.objectId, expectedRevisionId: created.source.revisionId, payload: { ...plan, title: 'Q' }, stamp: plan.stamp, idempotencyKey: crypto.randomUUID() }, 'Renamed'))).value as Rec;
    const undone = (await check('port.undo', port('undo', saved.source.objectId, saved.source))).value as Rec;
    const redone = (await check('port.redo', port('redo', undone.source.objectId, undone.source))).value as Rec;
    await check('port.restore', port('restore', redone.source.objectId, redone.source, created.source));
    await check('port.savedCopy', port('savedCopy', plan, 'rev-1', 'Saved'));
    await check('port.folders', port('folders'));
    console.log('taxonomy targets per response:', counts.join(', '));
    const taxonomyReads = opened.filter((p) => TAXONOMY_FILES.test(p));
    console.log(`files opened by wireAtlas and these calls: ${opened.length}; taxonomy review files: ${taxonomyReads.length}`);
    assert.deepEqual(taxonomyReads, []);
    wired.dispose();
  } finally {
    await documents.close(true);
    await rm(dir, { recursive: true, force: true });
  }
});

test('assistant build freeze (sources.freeze): no leveling guide generated, no leveling data read', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pom-park-freeze-'));
  const { ctx, documents } = await context(dir);
  try {
    const xml = await realReadFile(join(appDir, 'test', 'fixtures', 'pconc-pathfinder.xml'), 'utf8');
    const library = { list: async () => [{ id: 'b.xml', name: 'B', folder: '', mtimeMs: 1 }], readXml: async () => xml };
    const stamp = { leagueId: { status: 'unknown', reason: 't' }, realm: { status: 'unknown', reason: 't' }, mode: { status: 'unknown', reason: 't' },
      patchVersion: { status: 'unknown', reason: 't' }, datasetVersion: { status: 'unknown', reason: 't' }, createdAt: new Date().toISOString() };
    const sources = wireLibrarySources(ctx, library, () => stamp as never);
    opened.length = 0;
    const objectId = await sources.freeze('b.xml', 'B');
    const row = documents.list().find((r) => r.objectId === objectId)!;
    const doc = (await documents.read(row.objectId)) as { payload: { guide: unknown[]; treeNodes: unknown[] } };
    const leveling = opened.filter((p) => /[\\/]leveling[\\/]/.test(p));
    console.log(`frozen build: ${doc.payload.treeNodes.length} tree nodes, guide rows ${doc.payload.guide.length}; leveling files read: ${leveling.length}`);
    assert.equal(doc.payload.guide.length, 0, 'no guide in the frozen build');
    assert.ok(doc.payload.treeNodes.length > 0, 'the build itself is frozen');
    assert.deepEqual(leveling, [], 'no leveling data read');
  } finally {
    await documents.close(true);
    await rm(dir, { recursive: true, force: true });
  }
});

test('knowledge base: quest rewards and zones stay, leveling routes and skills are not read', async () => {
  opened.length = 0;
  const pulled = await appSource.pull({ app: { levelingDir: join(appDir, 'resources', 'leveling'), lootfilterDir: join(appDir, 'resources', 'lootfilter'), engineDataDir: '' }, livePatch: '3.29', log: () => undefined } as never);
  const tables = Object.keys(pulled.tables ?? {}).sort();
  console.log('KB app tables:', tables.join(', '), `| quest rewards: ${pulled.entities.quest_reward?.length}`);
  assert.ok(tables.includes('gem-offers') && tables.includes('zones') && tables.includes('quest-extras'), 'quest and zone facts stay');
  assert.ok((pulled.entities.quest_reward?.length ?? 0) > 100, 'quest reward facts stay');
  assert.ok(!tables.includes('routes') && !tables.includes('leveling-skills'), 'no route or leveling-skill tables');
  assert.deepEqual(opened.filter((p) => LEVELING_DATA.test(p)), [], 'route and leveling-skill files are not read');
});
