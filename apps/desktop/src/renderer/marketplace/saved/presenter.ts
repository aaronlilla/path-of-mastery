import { formatItemLink, type Collection, type LeagueStamp, type ObjectId, type PublicItemPayload, type PublishedRevisionRef } from '@pom/mastery-contracts';
import type { SavedReference } from '../../../main/marketplace/cache.js';
import type { MarketplaceCalls } from '../client.js';

/** The marketplace renderer client; every Saved screen reads and writes through it and nothing else. */
export type SavedClient = { call<K extends keyof MarketplaceCalls>(method: K, args: MarketplaceCalls[K]['args']): Promise<{ ok: true; value: MarketplaceCalls[K]['result'] } | { ok: false; error: { code: string; message: string } }> };

export const COPY = {
  empty: 'No saved items yet.',
  downloadNeeded: 'Download needed',
  downloading: 'Saving copy...',
  removed: 'Original removed',
  savedOnPc: 'Saved on this PC.',
  newRevision: 'New revision',
  stays: 'Your timelines and Runs keep the version they have now. Each one changes only when you update it there.',
  yoursNone: 'None. This saved item is a pinned copy.',
} as const;
const leagueOfStamp = (s: LeagueStamp) => s.leagueId.status === 'known' ? s.leagueId.value : 'Unknown league';
export const leagueLabel = leagueOfStamp;
export const kindName = (p: PublicItemPayload) => ({ build: 'Build', atlas: 'Atlas plan', timeline: 'Timeline' })[p.document.kind];
const same = (a: PublishedRevisionRef, b: PublishedRevisionRef) => a.postId === b.postId && a.revisionId === b.revisionId;

export type SavedRow = {
  objectId: ObjectId; ref: SavedReference; payload: PublicItemPayload | null;
  title: string; kind: string; creator: string; league: string; version: number;
  status: 'ready' | 'download_needed'; originalRemoved: boolean; newVersion: number | null; collectionIds: ObjectId[];
};
export function toRow(ref: SavedReference, payload: PublicItemPayload | null, originalRemoved: boolean, collections: Collection[]): SavedRow {
  return { objectId: ref.objectId, ref, payload, title: payload?.title ?? 'Saved item', kind: payload ? kindName(payload) : '', creator: payload?.creator.displayName ?? '',
    league: leagueOfStamp(ref.stamp), version: ref.selectedRevision.displayRevision as number, status: ref.cacheStatus === 'ready' && payload ? 'ready' : 'download_needed',
    originalRemoved: originalRemoved || ref.originalRemoved, newVersion: ref.updatedRevision ? ref.updatedRevision.displayRevision as number : null,
    collectionIds: collections.filter(c => c.members.some(m => same(m.publishedRevision, ref.selectedRevision))).map(c => c.objectId) };
}
export type Loaded = { rows: SavedRow[]; collections: Collection[] };
export async function loadSaved(client: SavedClient): Promise<Loaded> {
  const [refs, cols] = await Promise.all([client.call('saved', {}), client.call('collections', {})]);
  if (!refs.ok) throw new Error(refs.error.message);
  const collections = cols.ok ? cols.value : [];
  const rows = await Promise.all(refs.value.map(async ref => {
    if (ref.cacheStatus !== 'ready') return toRow(ref, null, false, collections);
    const opened = await client.call('open', { objectId: ref.objectId });
    return opened.ok ? toRow(ref, opened.value.saved.cachedPayload, opened.value.originalRemoved, collections) : toRow({ ...ref, cacheStatus: 'download_needed' }, null, false, collections);
  }));
  return { rows, collections };
}

export type RowFilter = { search: string; collection: ObjectId | 'all'; scope: 'current' | 'all'; activeLeague: string | null };
export function filterRows(rows: readonly SavedRow[], f: RowFilter): SavedRow[] {
  const q = f.search.trim().toLocaleLowerCase();
  return rows.filter(r => (f.scope === 'all' || f.activeLeague === null || r.league === f.activeLeague) && (f.collection === 'all' || r.collectionIds.includes(f.collection))
    && (!q || `${r.title} ${r.creator} ${r.league} ${r.kind}`.toLocaleLowerCase().includes(q)));
}
export const rowLine = (r: SavedRow) => [r.kind, r.league, `Saved version ${r.version}`].filter(Boolean).join(' / ');

// ---- share ------------------------------------------------------------------------------------
export const pinnedLink = (p: PublicItemPayload, view: 'detail' | 'run' = 'detail') =>
  formatItemLink({ kind: 'item', publicId: p.publicId, revision: p.publishedRevision.displayRevision as number, view }, 'web');
/** Title and creator, the normal link, and the explicit run link, both on the same revision. */
export const videoDescription = (p: PublicItemPayload) => `${p.title} by ${p.creator.displayName}\n${pinnedLink(p)}\nRun it: ${pinnedLink(p, 'run')}`;

// ---- update preview ---------------------------------------------------------------------------
export type FieldChange = { label: string; before: string; after: string };
export type UpdateReview = { creator: FieldChange[]; yours: FieldChange[]; conflicts: FieldChange[] };
const plain = (p: PublicItemPayload['description']) => p.map(b => b.content.map(c => c.text).join('')).join('\n');
const list = (xs: string[]) => xs.length ? xs.join(', ') : 'none';
const modeText = (s: LeagueStamp) => s.mode.status === 'known' ? `${s.mode.value.economy === 'ssf' ? 'SSF' : 'Trade'}${s.mode.value.hardcore ? ', Hardcore' : ''}${s.mode.value.ruthless ? ', Ruthless' : ''}` : 'unknown';
export function notesIn(v: unknown): string[] {
  if (Array.isArray(v)) return v.flatMap(notesIn);
  if (v && typeof v === 'object') return Object.entries(v).flatMap(([k, x]) => (k === 'notes' && typeof x === 'string' && x ? [x] : notesIn(x)));
  return [];
}
function facts(p: PublicItemPayload): [string, string][] {
  const d = p.document;
  const out: [string, string][] = [['Title', p.title], ['Description', plain(p.description)], ['League', leagueOfStamp(p.stamp)], ['Mode', modeText(p.stamp)], ['Visibility', p.visibility],
    ['Source credits', list(p.credits.map(c => c.status === 'original_removed' ? 'Original removed' : `${c.title} by ${c.creatorName}`))]];
  if (d.kind === 'build') out.push(['Skills', list(d.payload.skills.map(s => s.name))], ['Items', list(d.payload.gear.map(g => g.name))], ['Passive points', String(d.payload.treeNodes.length)], ['Guide steps', String(d.payload.guide.length)]);
  else if (d.kind === 'atlas') out.push(['Strategy', d.payload.strategy], ['Steps', list(Object.values(d.payload.stepsById).map(s => s.title))], ['Sequence positions', String(d.payload.sequencePositions.length)]);
  else { const starts = d.payload.timeline.clips.map(c => c.range.start); out.push(['Lanes', list([...d.payload.timeline.lanes].sort((a, b) => a.order - b.order).map(l => l.title))], ['Clips', String(d.payload.timeline.clips.length)], ['Required choices', String(d.payload.choices.length)],
    ['Starts at', String(starts.length ? Math.min(...starts) : 'none')]); }
  const notes = notesIn(d);
  if (notes.length) out.push(['Notes', notes.map(n => n.slice(0, 80)).join(' | ')]);
  return out;
}
/** Names exactly what differs between the saved version and the new one. A pinned saved copy has no edits of its own, so Your changes and Conflicts stay empty. */
export function reviewUpdate(saved: PublicItemPayload, next: PublicItemPayload): UpdateReview {
  const a = new Map(facts(saved)), changes: FieldChange[] = [];
  for (const [label, after] of facts(next)) { const before = a.get(label) ?? 'none'; if (before !== after) changes.push({ label, before, after }); }
  for (const [label, before] of a) if (!facts(next).some(([l]) => l === label)) changes.push({ label, before, after: 'none' });
  return { creator: changes, yours: [], conflicts: [] };
}

export type UpdatePreview = { payload: PublicItemPayload; review: UpdateReview };
export async function previewUpdate(client: SavedClient, row: SavedRow): Promise<UpdatePreview | { error: string } | null> {
  if (!row.payload) return { error: COPY.downloadNeeded };
  const r = await client.call('previewUpdate', { objectId: row.objectId });
  if (!r.ok) return { error: r.error.message };
  if (!r.value) return null;
  return { payload: r.value, review: reviewUpdate(row.payload, r.value) };
}
/** Accepting changes the saved item only. Clips and Runs are never touched here. */
export async function applyUpdate(client: SavedClient, row: SavedRow, payload: PublicItemPayload): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await client.call('applyUpdate', { objectId: row.objectId, expected: row.ref.selectedRevision, payload });
  return r.ok ? { ok: true } : { ok: false, error: r.error.message };
}

/** Who else points at this saved item. Supplied by the Timeline and Run areas through the app shell. */
export type SavedUsage = { clips: { timelineTitle: string; clipLabel: string; version: number; open?: () => void }[]; runs: { title: string; version: number; open?: () => void }[] };
export const noUsage: SavedUsage = { clips: [], runs: [] };

// ---- sync -------------------------------------------------------------------------------------
export async function syncSaved(client: SavedClient, rows: readonly SavedRow[], collections: readonly Collection[]): Promise<{ saved: number; collections: number; failed: number }> {
  let saved = 0, cols = 0, failed = 0;
  for (const r of rows) { const x = await client.call('enrollSave', { objectId: r.objectId }); if (x.ok) saved++; else failed++; }
  for (const c of collections) { const x = await client.call('enrollCollection', { objectId: c.objectId }); if (x.ok) cols++; else failed++; }
  return { saved, collections: cols, failed };
}
export const syncText = (r: { saved: number; collections: number; failed: number }) => r.failed ? `Synced ${r.saved} items. ${r.failed} did not sync. Try again.` : `Synced ${r.saved} items and ${r.collections} collections.`;
