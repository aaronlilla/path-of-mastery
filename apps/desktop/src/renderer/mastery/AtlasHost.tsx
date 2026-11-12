// Renderer host for the Atlas area: one AtlasEditorSession for the app lifetime, ports over the mastery bridge.
// Keep this component mounted (hidden) when another area is selected so the session, selection and drafts survive.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { parseId, type ValidationLimits } from '@pom/mastery-contracts';
import type { AssetRef } from '@pom/mastery-contracts';
import { AtlasArea } from '../atlas/AtlasArea.js';
import { ArtSets } from '../atlas/canvas/artSets.js';
import { type ArtResolver, type Sprite, type SpriteSource } from '../atlas/canvas/art.js';
import type { EditorArt } from '../atlas/editor/PracticalPanel.js';
import { AtlasEditorSession, type AtlasEditorPort, type AvailableData } from '../atlas/editor/session.js';
import { useAtlasOptimizer } from '../atlas/optimizer/OptimizerArea.js';
import { runQuickBuild, type QuickController } from '../atlas/quick/quickBuild.js';
import type { QuickMechanic } from '../atlas/quick/QuickPlan.js';
import { planView, type OptimizerPort } from '../atlas/optimizer/controller.js';
import { createGraph, unknown, type AtlasGraph } from '../../shared/atlas/graph.js';
import type { WorkerMessage } from '../../shared/atlas/solver/protocol.js';
import type { AiAvailability, AtlasAiPort } from '../../shared/atlas/suggestions/ai.js';
import type { LedgerState, LedgerStorage } from '../../shared/atlas/suggestions/ledger.js';
import type { AtlasDataInfo } from '../../main/mastery/atlas.js';
import { call, on } from './bridge.js';
import type { MasteryShell } from './shell.js';
import { marketplaceEnabled, timelinesEnabled } from '../areaGate.js';
import { ATLAS_MECHANICS } from '../../shared/leagueContent.js';
import { tr } from '../i18n';

// Same numbers as MASTERY_LIMITS in main/mastery/context.ts (the renderer cannot import that file). Keep in sync.
const LIMITS: ValidationLimits = Object.freeze({ maxBytes: 8_000_000, maxDepth: 64, maxNodes: 400_000, maxArrayLength: 50_000, maxStringLength: 2_000_000 });
const PORT = 'mastery:atlas-port', OPTIMIZER = 'mastery:atlas-optimizer', AI = 'mastery:atlas-ai', ATLAS = 'mastery:atlas';

const rpc = <T,>(method: string, ...args: unknown[]) => call<T>(PORT, { method, args });

function editorPort(): AtlasEditorPort {
  return {
    list: () => rpc('list'),
    read: (id, revision) => rpc('read', id, revision),
    save: (request, label) => rpc('save', request, label),
    create: (plan, label) => rpc('create', plan, label),
    undo: (id, source) => rpc('undo', id, source),
    redo: (id, source) => rpc('redo', id, source),
    restore: (id, source, revision) => rpc('restore', id, source, revision),
    preview: (id, transaction) => rpc('preview', id, transaction),
    trash: id => rpc('trash', id),
    restoreTrash: id => rpc('restoreTrash', id),
    move: (id, folderId) => rpc('move', id, folderId),
    createFolder: name => rpc('createFolder', name),
    exportRecovery: plan => rpc('exportRecovery', plan),
    parse: input => rpc('parse', input),
    importNew: result => rpc('importNew', result),
    exportFile: (input, options) => rpc('exportFile', input, options),
    share: (input, options) => rpc('share', input, options),
    stageRecovery: (request, label) => rpc('stageRecovery', request, label),
  };
}

function optimizerPort(): OptimizerPort {
  const send = async (method: string, input?: unknown): Promise<void> => { await call(OPTIMIZER, { method, input }); };
  return {
    prepare: request => call(OPTIMIZER, { method: 'prepare', input: request }),
    find: input => send('find', input),
    continueSolving: () => send('continue'),
    cancel: () => send('cancel'),
    freeze: input => call(OPTIMIZER, { method: 'freeze', input }),
    onMessage: listener => on('mastery:push:atlas-optimizer', payload => listener(payload as WorkerMessage)),
  };
}

function aiPort(selectedId: () => string | null): AtlasAiPort {
  let access: AiAvailability = { status: 'off' };
  const listeners = new Set<(a: AiAvailability) => void>();
  const set = (next: AiAvailability) => { access = next; listeners.forEach(l => l(next)); };
  on('mastery:push:atlas-ai', payload => set(payload as AiAvailability));
  call<AiAvailability>(AI, { method: 'access' }).then(set, () => { /* stays off */ });
  const target = () => {
    const objectId = selectedId();
    if (!objectId) throw { code: 'REVISION_CONFLICT' };
    return objectId;
  };
  return {
    access: () => access,
    onAccess: l => { listeners.add(l); return () => { listeners.delete(l); }; },
    verify: async () => { await call(AI, { method: 'verify', objectId: target() }); },
    suggest: summary => call(AI, { method: 'suggest', objectId: target(), summary }),
    explain: summary => call(AI, { method: 'explain', objectId: target(), summary }),
  };
}

// Switched-off mechanic optimizer (shared/leagueContent.ts): main registers no optimizer or AI-plan channel.
// No optimizer, suggestion or AI controller is made either: Quick plan reads the open plan straight from the session.
function planSource(session: AtlasEditorSession): QuickController {
  const off = (): never => { throw new Error('The mechanic optimizer is parked.'); };
  return { view: () => planView(session.state), subscribe: session.subscribe, snapshot: off, change: off, discard: () => undefined, find: off };
}

const ledger: LedgerStorage = {
  load: id => { try { return JSON.parse(localStorage.getItem(`atlas-ledger-${id}`) ?? 'null') as LedgerState | null; } catch { return null; } },
  save: (id, state) => { try { localStorage.setItem(`atlas-ledger-${id}`, JSON.stringify(state)); } catch { /* per-viewer convenience only */ } },
};

// Node art and mechanic names come from the bundled dataset (index) and its hash-checked sprite sheets, loaded through main.
// A node with no icon or sheet gets no art; a mechanic with no shared in-game name stays "Unknown".
const ART = 'mastery:atlas-art';
const SHEETS = ['assets/atlas-skills-4.jpg', 'assets/atlas-mastery-4.png'];
// The canvas draws the official art from every sprite family's sheets, one per zoom level (decoded once as bitmaps).
type Level = { zoom: number; image: ImageBitmap; coords: Record<string, { x: number; y: number; w: number; h: number }>; cache: Map<string, Sprite | null> };
const artStore = { sets: new ArtSets(), names: {} as Record<string, string>, targets: {} as Record<string, string[]>,
  // Sheets are keyed by their full CDN filename (version query included): two variants can share a file name with different bytes.
  urls: new Map<string, string>(), images: new Map<string, HTMLImageElement>(), crops: new Map<string, string>(), loaded: new Set<string>(),
  bitmaps: new Map<string, ImageBitmap>(), levels: new Map<string, Level[]>() };
const sheetFor = (asset: AssetRef): AssetRef => ({ ...asset, assetId: asset.assetId.replace(/-0\.(jpg|png)$/, '-4.$1') });
const assetOf = (filename: unknown): string | null => { try { return `assets/${new URL(String(filename)).pathname.split('/').at(-1)}`; } catch { return null; } };
// GGG's getCurrentImageZoomLevel: the smallest sheet zoom at or above the view scale, else the largest. Tables are the dataset's own.
const sprite: SpriteSource = (family, name, scale, datasetHash) => {
  const levels = artStore.levels.get(`${artStore.sets.resolve(datasetHash)}|${family}`); if (!levels?.length) return null;
  const level = levels.find(l => scale <= l.zoom) ?? levels.at(-1)!;
  let hit = level.cache.get(name);
  if (hit === undefined) { const c = level.coords[name]; hit = c ? { image: level.image, x: c.x, y: c.y, w: c.w, h: c.h, zoom: level.zoom } : null; level.cache.set(name, hit); }
  return hit;
};
const nodeArt: ArtResolver = Object.assign((asset: AssetRef, nodeId: string, datasetHash?: string) =>
  artStore.sets.nodeArt(datasetHash, sheetFor(asset), nodeId, f => artStore.urls.get(f) ?? null), { sprite });
const editorArt: EditorArt = (asset, id) => {
  if (!asset) return undefined;
  const sheet = sheetFor(asset), filename = artStore.sets.filename(undefined, sheet.assetId) ?? '';
  const key = `${filename}|${id}`, hit = artStore.crops.get(key);
  if (hit) return hit;
  const art = nodeArt(asset, id), image = artStore.images.get(filename);
  if (!art || !image || !image.complete || !image.naturalWidth) return undefined;
  const canvas = document.createElement('canvas');
  canvas.width = art.w; canvas.height = art.h;
  canvas.getContext('2d')?.drawImage(image, art.x, art.y, art.w, art.h, 0, 0, art.w, art.h);
  const url = canvas.toDataURL('image/png');
  artStore.crops.set(key, url);
  return url;
};
async function loadArt(datasets: AvailableData[]): Promise<void> {
  for (const d of datasets) {
    const key = JSON.stringify(d.dataset);
    if (artStore.loaded.has(key)) continue;
    artStore.loaded.add(key);
    try {
      const index = await call<{ icons: Record<string, string>; sprites: Record<string, Record<string, unknown>>; names: Record<string, string>; targets?: Record<string, string[]> }>(ART, { dataset: d.dataset });
      const hash = d.dataset.contentHash as string;
      artStore.sets.add(hash, { icons: index.icons, sprites: index.sprites });
      Object.assign(artStore.names, index.names);
      for (const [id, nodeIds] of Object.entries(index.targets ?? {})) if (!artStore.targets[id]) artStore.targets[id] = nodeIds;
      // The list art sheets first, then every sheet the canvas art names (masteryOverlay is a hover effect it does not draw).
      const wanted = new Set<string>(SHEETS.flatMap(a => artStore.sets.filename(hash, a) ?? []));
      for (const [family, zooms] of Object.entries(index.sprites)) if (family !== 'masteryOverlay')
        for (const raw of Object.values(zooms)) { const f = (raw as { filename?: unknown }).filename; if (typeof f === 'string') wanted.add(f); }
      for (const filename of wanted) {
        if (artStore.urls.has(filename)) continue;
        const assetId = assetOf(filename); if (!assetId) continue;
        const sheet = await call<{ mediaType: string; base64: string } | null>(ART, { dataset: d.dataset, assetId, filename });
        if (!sheet) continue;
        const text = atob(sheet.base64), bytes = new Uint8Array(text.length);
        for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
        const blob = new Blob([bytes], { type: sheet.mediaType }), url = URL.createObjectURL(blob);
        artStore.bitmaps.set(filename, await createImageBitmap(blob));
        if (SHEETS.includes(assetId)) {
          const image = new Image();
          await new Promise<void>(done => { image.onload = image.onerror = () => done(); image.src = url; });
          artStore.images.set(filename, image);
        }
        artStore.urls.set(filename, url);
      }
      for (const [family, zooms] of Object.entries(index.sprites)) artStore.levels.set(`${hash}|${family}`, Object.entries(zooms).flatMap(([zoom, raw]) => {
        const s = raw as { filename?: unknown; coords?: unknown }, image = artStore.bitmaps.get(String(s.filename));
        return image && s.coords && typeof s.coords === 'object' ? [{ zoom: Number(zoom), image, coords: s.coords as Level['coords'], cache: new Map() }] : [];
      }).sort((a, b) => a.zoom - b.zoom));
    } catch { artStore.loaded.delete(key); }
  }
}

type Singleton = { session: AtlasEditorSession; optimizer: OptimizerPort | null; ai: AtlasAiPort | null; quick: QuickController | null };
let singleton: Singleton | null = null;
function parts(): Singleton {
  if (!singleton) {
    const session = new AtlasEditorSession(editorPort(), LIMITS);
    singleton = ATLAS_MECHANICS ? { session, optimizer: optimizerPort(), ai: aiPort(() => session.state.record?.source.objectId ?? null), quick: null } : { session, optimizer: null, ai: null, quick: planSource(session) };
  }
  return singleton;
}

const none = (): AtlasDataInfo => ({ data: [], warning: tr('mastery_AtlasHost.live_compatibility_unverified_choose'),
  activeStamp: { leagueId: unknown(tr('mastery_AtlasHost.no_atlas_catalog_loaded')), realm: unknown(tr('mastery_AtlasHost.no_atlas_catalog_loaded')), mode: unknown(tr('mastery_AtlasHost.no_atlas_catalog_loaded')),
    patchVersion: unknown(tr('mastery_AtlasHost.no_atlas_catalog_loaded')), datasetVersion: unknown(tr('mastery_AtlasHost.no_atlas_catalog_loaded')), createdAt: new Date().toISOString() } });

async function graphForData(data: AvailableData): Promise<AtlasGraph> {
  const catalog = await call<{ graph: Parameters<typeof createGraph>[0]; costs: Parameters<typeof createGraph>[1] }>(ATLAS, { schemaVersion: 1, method: 'catalog', dataset: data.dataset });
  return createGraph(catalog.graph, catalog.costs);
}

export function AtlasHost({ shell }: { shell: MasteryShell }) {
  const { session, optimizer, ai, quick } = parts();
  const [info, setInfo] = useState<AtlasDataInfo | null>(null);
  const [folders, setFolders] = useState<{ id: string; title: string }[]>([]);
  const loadFolders = useCallback(() => call<{ id: string; title: string }[]>(PORT, { method: 'folders', args: [] }).then(setFolders, () => setFolders([])), []);
  const loadInfo = useCallback(() => {
    call<AtlasDataInfo>(PORT, { method: 'data', args: [] }).then(setInfo, () => setInfo(none()));
    void loadFolders();
  }, [loadFolders]);
  useEffect(loadInfo, [loadInfo, shell.online]);

  const intent = shell.intent;
  // Marketplace "Compare with my plan": AtlasArea opens Compare with this saved plan on the right.
  const [compare, setCompare] = useState<{ rightId: string; nonce: number } | null>(null);
  useEffect(() => {
    if (!intent || intent.kind !== 'compare-plan') return;
    setCompare(c => ({ rightId: intent.objectId, nonce: (c?.nonce ?? 0) + 1 }));
    shell.clearIntent();
  }, [intent]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!intent || intent.kind !== 'open-document') return;
    let live = true;
    void (async () => {
      try { await session.refresh(); await session.open(parseId('object', intent.objectId)); }
      catch { shell.toast(tr('mastery_AtlasHost.could_not_open_this_atlas')); }
      if (live) shell.clearIntent();
    })();
    return () => { live = false; };
  }, [intent]); // eslint-disable-line react-hooks/exhaustive-deps

  const [artReady, setArtReady] = useState(0);
  useEffect(() => { if (info) void loadArt(info.data).then(() => setArtReady(n => n + 1)); }, [info]);
  // New resolver identities when art arrives: the canvas and art rows redraw; the area itself (and any open dialog) stays mounted.
  const areaArt = useMemo<EditorArt>(() => (asset, id) => editorArt(asset, id), [artReady]); // eslint-disable-line react-hooks/exhaustive-deps
  const areaNodeArt = useMemo<ArtResolver>(() => Object.assign((asset: AssetRef, nodeId: string, datasetHash?: string) => nodeArt(asset, nodeId, datasetHash), { sprite }), [artReady]); // eslint-disable-line react-hooks/exhaustive-deps

  // ATLAS_MECHANICS is a module constant, so this hook is called on every render or on none.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const o = optimizer ? useAtlasOptimizer({ names: artStore.names, art: editorArt, nodeArt, session, port: optimizer, ai, ledger, aiAccess: shell.aiAccess && shell.signedIn, signedIn: shell.signedIn, online: shell.online,
    onUnlock: shell.requestAiAccess, onSignIn: shell.signIn }) : null;

  // Quick plan tiles: every mechanic with a game name, with its first notable's art from the default tree data.
  const [quickGraph, setQuickGraph] = useState<AtlasGraph | null>(null);
  useEffect(() => {
    const d = info && (info.data.find(x => x.active) ?? info.data[0]); if (!d) return;
    let live = true; graphForData(d).then(g => { if (live) setQuickGraph(g); }, () => undefined); return () => { live = false; };
  }, [info]);
  const quickMechanics = useMemo<QuickMechanic[]>(() => Object.entries(artStore.names).filter(([, name]) => name && name !== 'Unknown')
    .map(([targetId, name]) => ({ targetId, name, icons: (artStore.targets[targetId] ?? []).flatMap(nodeId => { const asset = quickGraph?.nodes.get(nodeId)?.asset; return asset ? [{ nodeId, asset }] : []; }) }))
    .sort((a, b) => a.name.localeCompare(b.name)), [artReady, quickGraph]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!info) return <p role="status">{tr('mastery_AtlasHost.updating')}</p>;
  const { data, activeStamp } = info;
  return <AtlasArea art={areaArt} nodeArt={areaNodeArt} session={session} data={data} activeStamp={activeStamp} online={shell.online} signedIn={shell.signedIn} folders={folders} onFoldersChanged={loadFolders}
    onSignIn={shell.signIn} copyText={shell.copyText} graphForData={graphForData}
    {...(marketplaceEnabled() ? {
      onBrowse: () => shell.go('marketplace', { kind: 'marketplace-view', view: 'feed' }),
      onPublish: (record: Parameters<NonNullable<Parameters<typeof AtlasArea>[0]['onPublish']>>[0]) => shell.go('marketplace', { kind: 'publish', source: { kind: 'atlas', objectId: record.source.objectId } }),
    } : {})}
    {...(timelinesEnabled() ? {
      onSend: (...[record, plan, transition]: Parameters<NonNullable<Parameters<typeof AtlasArea>[0]['onSend']>>) => shell.go('timelines', { kind: 'send-to-timeline', source: { kind: 'atlas', objectId: record.source.objectId },
        ...(transition ? { transition: { text: transition, title: plan.title, stamp: plan.stamp } } : {}) }),
    } : {})}
    onOpenBuilds={link => { void shell.copyText(link); shell.toast(tr('mastery_AtlasHost.link_copied_paste_it_into')); shell.go('build'); }}
    {...(o ? { onOptimizer: o.onOptimizer, onPlanWithAi: o.onPlanWithAi, suggestions: o.suggestions, optimizer: o.optimizer, treePreview: o.treePreview, sideFooter: o.sideFooter, panelOpen: o.panelOpen } : {})}
    compareRequest={compare} onCompareProblem={text => shell.toast(text)}
    quickMechanics={quickMechanics} quickBuild={request => runQuickBuild(session, o?.controller ?? quick!, request)} onCopied={text => shell.toast(text)} />;
}
