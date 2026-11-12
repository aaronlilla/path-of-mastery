// The first-launch chooser's data. Bundled for the app's main process by apps/desktop `build:starters` (esbuild);
// it runs the real qualifier over resources/mastery-starters and returns only detached, display-safe cards.
// The app runs `qualifyStarters` on a worker thread (this same bundle, see the end of this file) and keeps its snapshot in a
// validation cache keyed by the pack's bytes (apps/desktop/src/main/mastery/starters.ts); `startersFrom` serves a snapshot.
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { leagueStampSchema } from '@pom/mastery-contracts';
import { chooserState, qualifyPack } from './pack.js';
import { directoryBlobReader } from './io.js';
import { dto, parsePack, requireValue } from './schema.js';
import { leagueEndsAt, releaseCheckedAt, runtimeDecision, type RuntimeDecision } from './runtime.js';
import { parseLiveContext } from './schema.js';
import type { PackPolicy, StarterEntry, StarterPack } from './types.js';
import policyJson from './policy.json';

export type StarterCard = {
  starterId: string; title: string; creatorName: string; budget: string; playstyles: string[]; lanes: string[];
  league: string; patch: string; note: string;
};
export type StarterChooser = { current: StarterCard[]; archiveCount: number; emptyMessage: string | null; actions: string[] };

const known = (v: { status: string; value?: unknown } | undefined): string => v && v.status === 'known' ? String(v.value) : 'Unknown';
const LANES: Record<string, string> = { build: 'Build', atlas: 'Atlas', filter: 'Loot filter', notes: 'Notes', checklist: 'Checklist' };

export type RuntimeOptions = { now?: string; flag?: boolean | null; activeLeagueId?: string | null };

/**
 * Everything the chooser needs after qualification, as plain JSON: the release-qualified cards and the inputs of the runtime
 * rule. No build XML: `starterBuild` reads that from the pack itself when a starter is followed.
 */
export type StarterSnapshot = {
  schemaVersion: 1;
  packLeague: string; packRealm: string; endsAt: string | null;
  /** All entries in the pack (the archive count when no starter is current). */
  entryCount: number;
  release: { current: StarterCard[]; buildable: string[]; archiveCount: number; emptyMessage: string | null; actions: string[] };
  /**
   * SHA-256 of the exact bytes this qualification parsed for manifest.json, live-context.json and scope.json (blobs are content
   * addressed: the qualifier checks each against its own name). A caller records the snapshot only for files that hash the same.
   */
  inputs: Record<'manifest.json' | 'live-context.json' | 'scope.json', string>;
};

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
/** io.ts readJson (same limits and errors), also returning the SHA-256 of the exact bytes parsed. */
async function readHashedJson(file: string, maxBytes: number): Promise<{ value: unknown; sha: string }> {
  const info = await stat(file);
  requireValue(info.isFile() && info.size <= maxBytes, 'The input file exceeds its configured byte limit.', 'LIMIT_EXCEEDED');
  const bytes = await readFile(file);
  requireValue(bytes.byteLength <= maxBytes, 'The input file grew beyond its configured byte limit.', 'LIMIT_EXCEEDED');
  return { value: JSON.parse(bytes.toString('utf8')), sha: sha256(bytes) };
}

const card = (entry: StarterEntry): StarterCard => {
  const timeline = entry.bundle.timeline;
  return { starterId: entry.starterId, title: timeline.title, creatorName: entry.creatorName, budget: entry.budget, playstyles: [...entry.playstyles],
    lanes: [...new Set(timeline.lanes.map(l => LANES[l.type] ?? l.type))], league: known(timeline.stamp.leagueId as never), patch: known(timeline.stamp.patchVersion as never),
    note: entry.localBuilds.length ? 'Includes a full build from the creator\'s guide.' : '' };
};
const xmlText = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/**
 * A followed starter carries the pack's own league and game patch as the first line of its notes, so the stamp travels with
 * the build file, offline and through every save; apps/desktop/src/shared/buildXml.ts reads it back (STAMP_RE).
 */
const stamped = (xml: string, entry: StarterEntry): string => {
  const s = entry.bundle.timeline.stamp;
  if (s.leagueId.status !== 'known' || s.patchVersion.status !== 'known') return xml;
  const eol = xml.includes('\r\n') ? '\r\n' : '\n';
  const line = xmlText(`League start: ${s.leagueId.value}, patch ${s.patchVersion.value}`);
  const open = /<Notes>(\r?\n\t\t)?/.exec(xml);
  if (open) return xml.slice(0, open.index + open[0].length) + line + eol + xml.slice(open.index + open[0].length);
  const end = xml.lastIndexOf('</PathOfBuilding>');
  return end < 0 ? xml : `${xml.slice(0, end)}\t<Notes>${eol}\t\t${line}${eol}\t</Notes>${eol}${xml.slice(end)}`;
};
const buildOf = (entry: StarterEntry): { name: string; xml: string } => {
  requireValue(entry.localBuilds[0], 'This starter is not available.');
  return { name: entry.bundle.timeline.title.replace(/: league start$/i, ''), xml: stamped(entry.localBuilds[0]!.snapshot.buildXml, entry) };
};

/**
 * Qualifies the bundled pack as of its RELEASE check (releaseCheckedAt), so the 24 h evidence window is the release's rule and the
 * app never expires starters by age. `chooserFor` then applies the runtime rule (runtime.ts) per call: flag, league end, active league.
 */
async function qualifyAll(dir: string, checkedAtOverride?: string) {
  const policy = policyJson as PackPolicy;
  const root = resolve(dir);
  const manifestRead = await readHashedJson(resolve(root, 'manifest.json'), policy.limits.maxBytes);
  const liveRead = await readHashedJson(resolve(root, 'live-context.json'), policy.limits.maxBytes);
  const scopeRead = await readHashedJson(resolve(root, 'scope.json'), policy.limits.maxBytes);
  const input = manifestRead.value, live = liveRead.value;
  const scope = dto(leagueStampSchema, scopeRead.value, policy.limits);
  const blobs = directoryBlobReader(resolve(root, 'blobs'), policy);
  const liveContext = parseLiveContext(live, policy.limits);
  // The release instant comes from the pack's own timestamps. qualifyPack parses and validates the whole pack (about 2.5 s for
  // this one), so read the timestamps from the raw JSON here instead of parsing it twice; only when that raw read fails (a
  // malformed pack) is it parsed here, which throws the parser's own error.
  let releaseAt = checkedAtOverride;
  if (releaseAt === undefined) {
    try { releaseAt = releaseCheckedAt(input as StarterPack, liveContext); } catch { releaseAt = releaseCheckedAt(parsePack(input, policy.limits), liveContext); }
  }
  const { pack, report } = await qualifyPack(input, live, scope, policy, blobs, releaseAt);
  const releaseState = await chooserState(pack, report);
  const packLeague = scope.leagueId.status === 'known' ? scope.leagueId.value : '', packRealm = scope.realm.status === 'known' ? scope.realm.value : '';
  let endsAt: string | null = null;
  try {
    const source = pack.sources.find(s => s.evidenceId === liveContext.leagues.evidenceId);
    if (source) endsAt = leagueEndsAt(JSON.parse(new TextDecoder().decode(await blobs(source.contentHash))), packLeague, packRealm);
  } catch { /* no end date: current until a newer release replaces the pack */ }
  const snapshot: StarterSnapshot = { schemaVersion: 1, packLeague, packRealm, endsAt, entryCount: pack.entries.length,
    release: { current: releaseState.current.map(card), buildable: releaseState.current.filter(e => e.localBuilds[0]).map(e => e.starterId),
      archiveCount: releaseState.archive.length, emptyMessage: releaseState.emptyMessage, actions: [...releaseState.actions] },
    inputs: { 'manifest.json': manifestRead.sha, 'live-context.json': liveRead.sha, 'scope.json': scopeRead.sha } };
  return { snapshot, releaseState };
}

/** The full qualification, reduced to its JSON snapshot. */
export async function qualifyStarters(dir: string, checkedAtOverride?: string): Promise<StarterSnapshot> {
  return (await qualifyAll(dir, checkedAtOverride)).snapshot;
}

/** The chooser over a snapshot. `canBuild` answers for the cards the last `chooserFor` call showed (like `build` below). */
export function startersFrom(snapshot: StarterSnapshot) {
  const release = snapshot.release;
  let shown: string[] = [];
  const chooserFor = (options: RuntimeOptions = {}): StarterChooser & { reason: RuntimeDecision['reason'] } => {
    const decision = runtimeDecision({ packLeagueId: snapshot.packLeague, now: options.now ?? new Date().toISOString(), flag: options.flag, leagueEndsAt: snapshot.endsAt, activeLeagueId: options.activeLeagueId });
    const none = !decision.show || release.current.length === 0;
    shown = none ? [] : release.current.map(c => c.starterId);
    return none
      ? { current: [], archiveCount: snapshot.entryCount, emptyMessage: release.emptyMessage ?? 'No starter timelines are available for this league yet.',
        actions: ['Import a build', 'Import a timeline', 'Browse archive'], reason: decision.reason }
      : { current: structuredClone(release.current), archiveCount: release.archiveCount, emptyMessage: release.emptyMessage, actions: [...release.actions], reason: decision.reason };
  };
  const chooser: StarterChooser = chooserFor();
  const canBuild = (starterId: string): boolean => shown.includes(starterId) && release.buildable.includes(starterId);
  return { chooser, chooserFor, canBuild };
}

export async function loadStarters(dir: string, checkedAtOverride?: string) {
  const { snapshot, releaseState } = await qualifyAll(dir, checkedAtOverride);
  const view = startersFrom(snapshot);
  /** The build behind a current starter: its XML, to be saved into the Builds library by the caller. */
  const build = (starterId: string): { name: string; xml: string } => {
    requireValue(view.canBuild(starterId), 'This starter is not available.');
    return buildOf(releaseState.current.find(e => e.starterId === starterId)!);
  };
  return { chooser: view.chooser, chooserFor: view.chooserFor, build, snapshot };
}

/**
 * One qualified starter's build, read from the pack's manifest only when its bytes still hash to `manifestSha256` (the
 * manifest a qualification passed on). Throws on any other bytes, so a changed pack is never served from an old result.
 */
export async function starterBuild(dir: string, starterId: string, manifestSha256: string): Promise<{ name: string; xml: string }> {
  const policy = policyJson as PackPolicy;
  const file = resolve(dir, 'manifest.json');
  requireValue((await stat(file)).size <= policy.limits.maxBytes, 'The input file exceeds its configured byte limit.', 'LIMIT_EXCEEDED');
  const bytes = await readFile(file);
  requireValue(sha256(bytes) === manifestSha256, 'The starter pack changed since it was qualified.', 'HASH_MISMATCH'); // the bytes handed out below
  const entry = (JSON.parse(bytes.toString('utf8')) as { entries?: StarterEntry[] }).entries?.find(e => e?.starterId === starterId);
  requireValue(entry, 'This starter is not available.');
  return buildOf(entry!);
}

// Worker thread: `new Worker(<this bundle>, { workerData: { job: 'qualify-starters', dir } })` posts { ok, snapshot | message }.
if (!isMainThread && parentPort && (workerData as { job?: unknown } | null)?.job === 'qualify-starters') {
  const port = parentPort;
  qualifyStarters(String((workerData as { dir: unknown }).dir)).then(
    snapshot => port.postMessage({ ok: true, snapshot }),
    (e: unknown) => port.postMessage({ ok: false, message: e instanceof Error ? e.message : String(e) }));
}
