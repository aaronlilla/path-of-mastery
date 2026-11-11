// Wiring for Atlas: registry/service, editor port backing, optimizer + AI advisor. Logic stays in
// those modules; this file constructs them and exposes them over the trusted-sender IPC channels below.
//
//   'mastery:atlas'            registry service (registerAtlasIpc)
//   'mastery:atlas-port'       { method, args: [...] } -> AtlasEditorPort methods + 'folders' + 'data'
//   'mastery:atlas-optimizer'  { method: prepare|find|continue|cancel|freeze, input }
//   'mastery:atlas-ai'         { method: access|verify|suggest|explain, objectId?, summary? }
//   push 'mastery:push:atlas-optimizer' (WorkerMessage), 'mastery:push:atlas-ai' (AiStatus)
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parseId, type AtlasPlan, type LeagueStamp, type ObjectId, type RevisionRef } from '@pom/mastery-contracts';
import type { MasteryContext } from './context.js';
import { AtlasRegistry } from '../atlas/registry.js';
import { ValidationCache, validatorIdentity } from '../validationCache.js';
import { atlasValidatorFiles, bundledRecords } from '../validatedResources.js';
import { AtlasService } from '../atlas/service.js';
import { registerAtlasIpc } from '../atlas/ipc.js';
import { AtlasOptimizerService } from '../atlas/optimizerService.js';
import { AtlasAiAdvisor } from '../atlas/aiAdvisor.js';
import { exportMasteryFile, importMastery, verifiedLinkPlan, type DatasetLookup } from '../atlas/formats.js';
import { AiDenied } from '../aiGate/gate.js';
import { atlasServicePort, type AtlasLifecycleHost } from '../../renderer/atlas/editor/servicePort.js';
import type { AtlasEditorPort, AvailableData } from '../../renderer/atlas/editor/session.js';
import type { PrepareRequest } from '../../shared/atlas/suggestions/choices.js';
import type { SolverInput } from '../../shared/atlas/solver/protocol.js';
import type { AiSummary } from '../../shared/atlas/suggestions/ai.js';
import { unknown } from '../../shared/atlas/graph.js';
import { targetDisplayNames } from '../../shared/atlas/suggestions/mechanics.js';
import { ATLAS_MECHANICS } from '../../shared/leagueContent.js';

export const ATLAS_PORT_CHANNEL = 'mastery:atlas-port';
export const ATLAS_OPTIMIZER_CHANNEL = 'mastery:atlas-optimizer';
export const ATLAS_AI_CHANNEL = 'mastery:atlas-ai';
export const ATLAS_ART_CHANNEL = 'mastery:atlas-art';

export type AtlasWiring = {
  registry: AtlasRegistry;
  service: AtlasService;
  /** Null while the mechanic optimizer is parked (shared/leagueContent.ts). */
  optimizer: AtlasOptimizerService | null;
  port: AtlasEditorPort;
  /** True for a read-only saved copy of a Marketplace post (Compare with my plan): never offered for publishing. */
  isSavedCopy(objectId: string): boolean;
  dispose(): void;
};
/** What the renderer reads with port method 'data'. */
export type AtlasDataInfo = { data: AvailableData[]; activeStamp: LeagueStamp; warning: string | null };

/** `published` marks a read-only copy of a Marketplace post (`{publicId}:{revision}`), kept for Compare with my plan. */
type Meta = { folderId: string | null; ownership: 'owned' | 'saved'; lastOpenedAt: string; published?: string };
type LibraryFile = { schemaVersion: 1; folders: { id: string; title: string }[]; objects: Record<string, Meta> };

/** Folders and per-plan library facts (folder, last opened). Small JSON beside the Atlas registry. */
class Library {
  private state: LibraryFile = { schemaVersion: 1, folders: [], objects: Object.create(null) as Record<string, Meta> };
  constructor(private readonly file: string) {}
  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as LibraryFile;
      if (raw?.schemaVersion === 1 && Array.isArray(raw.folders) && raw.objects && typeof raw.objects === 'object') {
        this.state = { schemaVersion: 1, folders: raw.folders.filter(f => typeof f?.id === 'string' && typeof f.title === 'string'), objects: Object.assign(Object.create(null), raw.objects) };
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('Atlas library file unreadable, starting empty:', e instanceof Error ? e.message : String(e));
    }
  }
  private async persist(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(this.state));
    await rename(tmp, this.file);
  }
  get folders() { return this.state.folders.map(f => ({ ...f })); }
  meta(id: string): Meta { return { ...(this.state.objects[id] ?? { folderId: null, ownership: 'owned', lastOpenedAt: new Date(0).toISOString() }) }; }
  async touch(id: string): Promise<void> {
    this.state.objects[id] = { ...this.meta(id), lastOpenedAt: new Date().toISOString() };
    await this.persist();
  }
  async move(id: string, folderId: string | null): Promise<void> {
    if (folderId !== null && !this.state.folders.some(f => f.id === folderId)) throw new Error('Folder is unavailable.');
    this.state.objects[id] = { ...this.meta(id), folderId };
    await this.persist();
  }
  /** Marks a plan as the read-only saved copy of one published revision. */
  async keepSaved(id: string, published: string): Promise<void> {
    this.state.objects[id] = { ...this.meta(id), ownership: 'saved', published };
    await this.persist();
  }
  savedFor(published: string): string | null { return Object.entries(this.state.objects).find(([, m]) => m.published === published)?.[0] ?? null; }
  async createFolder(name: string): Promise<void> {
    const title = name.trim().slice(0, 80);
    if (!title) throw new Error('Folder name is required.');
    this.state.folders.push({ id: randomUUID(), title });
    await this.persist();
  }
}

const PUBLIC_ERRORS = new Set(['AtlasDomainError', 'DocumentStoreError', 'MasteryFormatError', 'ExactSolverError', 'AiDenied']);
function failure(error: unknown): { ok: false; error: { code: string; message: string } } {
  const e = error as { name?: string; code?: unknown; message?: unknown } | null;
  const code = typeof e?.code === 'string' ? e.code : 'UNAVAILABLE';
  if (e && typeof e.name === 'string' && PUBLIC_ERRORS.has(e.name) && typeof e.message === 'string') return { ok: false, error: { code, message: e.message } };
  console.warn('Atlas wiring error:', error instanceof Error ? error.message : String(error));
  return { ok: false, error: { code, message: 'This is unavailable right now.' } };
}
const text = (value: unknown, what: string): string => {
  if (typeof value !== 'string' || !value) throw new TypeError(`${what} is invalid.`);
  return value;
};
const objectId = (value: unknown): ObjectId => parseId('object', text(value, 'Plan id'));
const safeName = (name: string) => name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 80) || 'atlas-plan';

export async function wireAtlas(ctx: MasteryContext): Promise<AtlasWiring> {
  const resources = ctx.atlasResourcesDir ?? join(ctx.resourcesDir, 'atlas');
  // Bundled packs the release build validated (records shipped in dist/validated, inside the app package) are only re-hashed; any
  // other bytes are validated in full. No record is read from or written to userData (main/validationCache.ts says why).
  const cache = await validatorIdentity(ctx.appVersion ?? '', await atlasValidatorFiles())
    .then(identity => ValidationCache.open(bundledRecords('atlas'), identity))
    .catch((e: unknown) => { console.warn('Atlas validation cache unavailable:', e instanceof Error ? e.message : String(e)); return null; });
  const registry = new AtlasRegistry(ctx.userDataDir, resources, { limits: ctx.limits, maxSourceBytes: 200_000_000 }, { cache });
  try { await registry.init(); }
  catch (e) {
    // No qualified or readable catalog: the UI shows its empty/unverified state; saved plans keep their snapshots.
    console.warn('Atlas catalog unavailable:', e instanceof Error ? e.message : String(e));
    registry.warning = 'Live compatibility unverified. Choose archived tree data to plan.';
  }
  const service = new AtlasService(ctx.documents, registry, ctx.limits);
  const library = new Library(join(ctx.userDataDir, 'mastery', 'atlas-library.json'));
  await library.load();

  const lookup: DatasetLookup = ref => {
    try { const v = registry.get(ref); return { graph: v.graph, compatibilityVerified: v.qualification === 'qualified' && v.isCurrent }; }
    catch { return null; }
  };
  const writeExport = async (name: string, extension: string, body: string) => {
    const path = await ctx.chooseSaveFile(`${safeName(name)}${extension}`);
    if (path) await writeFile(path, body, 'utf8'); // null = the user cancelled the dialog
  };
  const host: AtlasLifecycleHost = {
    metadata: async id => library.meta(id),
    enroll: async record => { await library.touch(record.source.objectId); },
    move: (id, folderId) => library.move(id, folderId),
    createFolder: name => library.createFolder(name),
    exportRecovery: async plan => {
      const out = exportMasteryFile({ document: { kind: 'atlas', payload: plan } }, ctx.limits, { includeNotes: true });
      await writeExport(plan.title, out.extension, out.text);
    },
    parse: async input => importMastery(input, ctx.limits, lookup),
    importNew: async result => {
      // Re-parse the original text in main; a renderer-supplied snapshot is never trusted as is.
      const again = importMastery(result.sourceInput, ctx.limits, lookup);
      if (again.kind === 'snapshot' && again.snapshot.document.kind === 'atlas') return port.create(again.snapshot.document.payload as AtlasPlan, 'Imported plan');
      if (again.kind === 'snapshot') throw new Error('This file is not an Atlas plan.');
      // A tree link or code (pasted as a link or a bare code): node IDs only, checked against the plan built on the chosen tree data.
      const plan = result.snapshot?.document.kind === 'atlas' ? result.snapshot.document.payload : null;
      return port.create(verifiedLinkPlan(result.sourceInput, plan, ctx.limits, lookup), 'Imported plan');
    },
    exportFile: async (input, options) => {
      // Pinned datasets are not attached: the registry exposes catalog views, not the signed AtlasDataset body.
      const out = exportMasteryFile(input, ctx.limits, options);
      await writeExport(input.document.kind === 'atlas' ? input.document.payload.title : 'timeline', out.extension, out.text);
    },
    share: async () => { throw new Error('Hosted sharing is unavailable right now.'); },
  };
  const port: AtlasEditorPort = atlasServicePort(service, ctx.documents, host);

  const availableData = (): AtlasDataInfo => {
    const data: AvailableData[] = registry.available().map(row => {
      let budget = 0;
      try { const costs = registry.costs(row.ref); if (costs.status === 'known' && costs.value.maximumPoints.status === 'known') budget = costs.value.maximumPoints.value; } catch { /* unverified costs: budget 0 */ }
      const qualified = row.qualification === 'qualified';
      return { dataset: row.ref, stamp: row.ref.stamp, budget, qualified, active: qualified && row.isCurrent };
    });
    const pick = data.find(d => d.active) ?? data[0];
    const none: LeagueStamp = { leagueId: unknown('No Atlas catalog loaded.'), realm: unknown('No Atlas catalog loaded.'), mode: unknown('No Atlas catalog loaded.'),
      patchVersion: unknown('No Atlas catalog loaded.'), datasetVersion: unknown('No Atlas catalog loaded.'), createdAt: new Date().toISOString() };
    return { data, activeStamp: pick?.stamp ?? none, warning: registry.warning };
  };

  // Editor port: every AtlasEditorPort method by name, plus 'folders' and 'data'.
  const portCalls: Record<string, (a: unknown[]) => unknown> = {
    list: () => port.list(),
    read: async a => { const id = objectId(a[0]); const rec = await port.read(id, a[1] as never); if (a[1] === undefined) await library.touch(id).catch(() => {}); return rec; },
    save: a => port.save(a[0] as never, text(a[1], 'Label')),
    create: a => port.create(a[0] as AtlasPlan, text(a[1], 'Label')),
    undo: a => port.undo(objectId(a[0]), a[1] as RevisionRef),
    redo: a => port.redo(objectId(a[0]), a[1] as RevisionRef),
    restore: a => port.restore(objectId(a[0]), a[1] as RevisionRef, a[2] as RevisionRef),
    preview: a => port.preview(objectId(a[0]), a[1] as never),
    trash: a => port.trash(objectId(a[0])),
    restoreTrash: a => port.restoreTrash(objectId(a[0])),
    move: a => port.move(objectId(a[0]), a[1] === null ? null : text(a[1], 'Folder')),
    createFolder: a => port.createFolder(text(a[0], 'Folder name')),
    exportRecovery: a => port.exportRecovery(a[0] as AtlasPlan),
    parse: a => port.parse(text(a[0], 'Import text'), new AbortController().signal),
    importNew: a => port.importNew(a[0] as never),
    exportFile: a => port.exportFile(a[0] as never, (a[1] ?? {}) as never),
    share: a => port.share(a[0] as never, (a[1] ?? {}) as never, new AbortController().signal),
    stageRecovery: a => port.stageRecovery!(a[0] as never, text(a[1], 'Label')),
    // Marketplace "Compare with my plan": the published plan as a read-only saved plan (one per published revision), never an owned one.
    savedCopy: async a => {
      const key = text(a[1], 'Published revision'), known = library.savedFor(key);
      if (known && ctx.documents.list().some(row => row.objectId === known)) return { objectId: known };
      const plan = { ...(a[0] as AtlasPlan), title: text(a[2], 'Title').slice(0, 120) };
      const record = await port.create(plan, 'Saved from the Marketplace');
      await library.keepSaved(record.source.objectId, key);
      return { objectId: record.source.objectId };
    },
    folders: () => library.folders,
    data: () => availableData(),
  };
  ctx.ipc.handle(ATLAS_PORT_CHANNEL, async (event, input) => {
    try {
      if (!ctx.isMainSender(event)) throw new TypeError('not trusted');
      const call = input as { method?: unknown; args?: unknown } | null;
      if (!call || typeof call.method !== 'string' || !Object.hasOwn(portCalls, call.method) || (call.args !== undefined && !Array.isArray(call.args))) throw new TypeError('Atlas request is unsupported.');
      return { ok: true, value: (await portCalls[call.method]!((call.args as unknown[] | undefined) ?? [])) ?? null };
    } catch (e) { return failure(e); }
  });

  // The mechanic optimizer and AI planning read the hand-curated taxonomy: parked (shared/leagueContent.ts), so neither the
  // solver worker nor their channels exist. Plans, the tree, art and Quick plan's fill do not need them.
  let optimizer: AtlasOptimizerService | null = null, stopMessages = (): void => {}, stopAccess = (): void => {};
  if (ATLAS_MECHANICS) {
    // Optimizer: the solver worker compiles to dist/main/atlas/solver.worker.js (tsc), next to this file's dist/main/mastery/.
    const solver = new AtlasOptimizerService({
      data: ref => { const v = registry.get(ref); return { graph: v.graph, taxonomyHash: v.taxonomy.contentHash, qualified: v.qualification === 'qualified' }; },
      limits: { maxNodes: 20_000, maxEdges: 100_000, maxInputIds: 20_000, maxDpBytes: 256 * 1024 * 1024 },
      workerUrl: new URL('../atlas/solver.worker.js', import.meta.url),
    });
    stopMessages = solver.onMessage(message => ctx.push('mastery:push:atlas-optimizer', message));
    ctx.ipc.handle(ATLAS_OPTIMIZER_CHANNEL, async (event, input) => {
      try {
        if (!ctx.isMainSender(event)) throw new TypeError('not trusted');
        const call = input as { method?: unknown; input?: unknown } | null;
        if (!call || typeof call.method !== 'string') throw new TypeError('Optimizer request is unsupported.');
        const body = call.input as never;
        switch (call.method) {
          case 'prepare': return { ok: true, value: solver.prepare(body as PrepareRequest) };
          case 'find': solver.find(body as SolverInput); return { ok: true, value: null };
          case 'continue': solver.continueSolving(); return { ok: true, value: null };
          case 'cancel': solver.cancel(); return { ok: true, value: null };
          case 'freeze': return { ok: true, value: solver.freeze(body as SolverInput) };
          default: throw new TypeError('Optimizer request is unsupported.');
        }
      } catch (e) { return failure(e); }
    });

    // AI: the selected revision is looked up here from the plan id; the renderer never supplies a revision.
    const advisorFor = (id: ObjectId) => new AtlasAiAdvisor(ctx.ai, () => {
      const row = ctx.documents.list().find(r => r.objectId === id);
      if (!row) throw new AiDenied('REVISION_CONFLICT');
      return ctx.documents.revisionRef(row.objectId, row.revisionId);
    });
    stopAccess = ctx.ai.onChange(() => ctx.push('mastery:push:atlas-ai', ctx.ai.state));
    ctx.ipc.handle(ATLAS_AI_CHANNEL, async (event, input) => {
      try {
        if (!ctx.isMainSender(event)) throw new TypeError('not trusted');
        const call = input as { method?: unknown; objectId?: unknown; summary?: unknown } | null;
        if (!call || typeof call.method !== 'string') throw new TypeError('AI request is unsupported.');
        if (call.method === 'access') return { ok: true, value: ctx.ai.state };
        const advisor = advisorFor(objectId(call.objectId));
        switch (call.method) {
          case 'verify': await advisor.verify(); return { ok: true, value: null };
          case 'suggest': return { ok: true, value: await advisor.suggest(call.summary as AiSummary) };
          case 'explain': return { ok: true, value: await advisor.explain(call.summary as AiSummary) };
          default: throw new TypeError('AI request is unsupported.');
        }
      } catch (e) { return failure(e); }
    });
    optimizer = solver;
  }

  // Node art: one bundled sprite sheet per call, checked against the pinned hash in the dataset's asset list. Nothing is fetched.
  const sourcesDir = join(resources, 'sources');
  const sheets = new Map<string, string | null>();
  const findSheet = async (basename: string): Promise<string | null> => {
    if (sheets.has(basename)) return sheets.get(basename)!;
    let found: string | null = null;
    try {
      for (const dir of await readdir(sourcesDir)) {
        const path = join(sourcesDir, dir, 'official', 'assets', basename);
        try { await readFile(path).then(() => { found = path; }); break; } catch { /* try the next source folder */ }
      }
    } catch { /* no bundled sources */ }
    sheets.set(basename, found);
    return found;
  };
  const leagueSheet = async (filename: string): Promise<string | null> => {
    try {
      for (const dir of await readdir(sourcesDir)) {
        const official = join(sourcesDir, dir, 'official');
        const manifest = JSON.parse(await readFile(join(official, 'assets-league.json'), 'utf8')) as Record<string, { file: string; hash: string }>;
        const entry = Object.hasOwn(manifest, filename) ? manifest[filename] : undefined; if (!entry) continue;
        const bytes = await readFile(join(official, entry.file));
        return createHash('sha256').update(bytes).digest('hex') === entry.hash ? bytes.toString('base64') : null;
      }
    } catch { /* no league sheets bundled */ }
    return null;
  };
  ctx.ipc.handle(ATLAS_ART_CHANNEL, async (event, input) => {
    try {
      if (!ctx.isMainSender(event)) throw new TypeError('not trusted');
      const call = input as { dataset?: unknown; assetId?: unknown; filename?: unknown } | null;
      if (call && call.assetId === undefined) {
        // Index: icon name per node plus every sprite family at every zoom level (the canvas draws the official art from the
        // sheet that fits its zoom); names and icons come straight from the pinned dataset.
        const meta = registry.get(call.dataset as never);
        const icons: Record<string, string> = {};
        for (const [id, row] of Object.entries(meta.nodeMetadata ?? {})) if (row && typeof (row as { icon?: unknown }).icon === 'string') icons[id] = (row as { icon: string }).icon;
        const sprites = (meta.sourceLayout?.sprites ?? {}) as Record<string, Record<string, unknown>>;
        // Mechanic display names: the official mastery label of the targets' clusters, else their shared notable name; otherwise Unknown.
        // Parked mechanic optimizer (shared/leagueContent.ts): no mechanic names or targets from the taxonomy reach the renderer.
        const names = ATLAS_MECHANICS ? targetDisplayNames(meta.taxonomy, id => meta.graph.nodes.get(id)?.name, meta.geometry ?? {}, meta.nodeMetadata ?? {}) : {};
        // Quick plan tiles: each mechanic's notable IDs, straight from the pinned taxonomy.
        const targets: Record<string, string[]> = {};
        if (ATLAS_MECHANICS) for (const t of meta.taxonomy.targets) targets[t.targetId] = [...t.nodeIds];
        return { ok: true, value: { icons, sprites, names, targets } };
      }
      const assetId = text(call?.assetId, 'Asset');
      if (!/^assets\/[A-Za-z0-9_.-]+\.(png|jpg)$/.test(assetId)) throw new TypeError('Asset is invalid.');
      // Sheets only a league variant names (an older sheet set, other coordinates): hash-pinned in assets-league.json.
      const extra = typeof call?.filename === 'string' ? await leagueSheet(call.filename) : null;
      if (extra) return { ok: true, value: { mediaType: assetId.endsWith('.png') ? 'image/png' : 'image/jpeg', base64: extra } };
      const view = registry.get(call!.dataset as never);
      const pinned = view.assets.find(a => a.assetId === assetId);
      if (!pinned) return { ok: true, value: null };
      const path = await findSheet(assetId.slice('assets/'.length));
      if (!path) return { ok: true, value: null };
      const bytes = await readFile(path);
      if (createHash('sha256').update(bytes).digest('hex') !== pinned.contentHash) return { ok: true, value: null };
      return { ok: true, value: { mediaType: pinned.mediaType, base64: bytes.toString('base64') } };
    } catch (e) { return failure(e); }
  });

  const removeAtlas = registerAtlasIpc(ctx.ipc, service, { isTrustedSender: ctx.isMainSender });
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    removeAtlas();
    for (const channel of [ATLAS_PORT_CHANNEL, ATLAS_OPTIMIZER_CHANNEL, ATLAS_AI_CHANNEL, ATLAS_ART_CHANNEL]) ctx.ipc.removeHandler(channel);
    stopMessages(); stopAccess(); optimizer?.dispose();
  };
  ctx.onQuit(async () => dispose());
  return { registry, service, optimizer, port, dispose, isSavedCopy: id => library.meta(id).ownership === 'saved' };
}
