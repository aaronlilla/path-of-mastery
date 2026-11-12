import { createHash } from 'node:crypto';
import { parseId, revisionKey, type Hash, type Known, type LeagueStamp, type PublishRequest, type TimelineBundle } from '@pom/mastery-contracts';
import { atlasDatasetDigest } from '../../apps/desktop/src/main/kb/sources/atlas.js';
import { allocationCost, createGraph, inspectAllocation } from '../../apps/desktop/src/shared/atlas/graph.js';
import { adaptAtlas, adaptBuild, adaptFilter, adaptText, canonicalJson, contentHash, verifySource } from '../../apps/desktop/src/shared/timelines/adapters/index.js';
import { compileSchedule, SCHEDULER_VERSION } from '../../apps/desktop/src/shared/timelines/scheduler/index.js';
import { exportTimelineFile, importTimelineFile } from '../../apps/desktop/src/shared/timelines/formats.js';
import { dto, parseLiveContext, parsePack, requireValue, StarterPackError, time } from './schema.js';
import { timelineBundleSchema } from '@pom/mastery-contracts';
import type { BlobReader, LiveContext, PackPolicy, QualificationReport, SourceEvidence, StarterContent, StarterEntry, StarterPack } from './types.js';

export const LEAGUES_URL = 'https://www.pathofexile.com/api/trade/data/leagues';
export const PATCHES_URL = 'https://www.pathofexile.com/forum/view-forum/patch-notes';
export const hashBytes = (bytes: Uint8Array | string): Hash => parseId('hash', createHash('sha256').update(bytes).digest('hex'));
const equal = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);
const scopeValues = (stamp: LeagueStamp) => [stamp.leagueId, stamp.realm, stamp.mode, stamp.patchVersion].map(value => value.status === 'known' ? value.value : null);
const sameScope = (a: LeagueStamp, b: LeagueStamp) => equal(scopeValues(a), scopeValues(b));
const failHash = (condition: unknown, message: string) => requireValue(condition, message, 'HASH_MISMATCH');

export async function starterContentHash(entry: StarterEntry | StarterContent, sources: readonly SourceEvidence[]): Promise<Hash> {
  const { review: _review, ...content } = entry as StarterEntry;
  return contentHash({ content, sources: sources.filter(source => entry.evidenceIds.includes(source.evidenceId)) });
}

export async function assembleBundle(input: TimelineBundle, policy: PackPolicy): Promise<TimelineBundle> {
  const bundle = structuredClone(input);
  const dependencies = new Map(bundle.dependencies.map(value => [revisionKey(value.ref), value]));
  for (const clip of bundle.timeline.clips) for (const option of clip.options) {
    const context = { laneId: clip.laneId, clipId: clip.clipId, optionId: option.optionId, limits: policy.limits };
    const kind = option.source.fallbackSnapshot.kind;
    option.actions = kind === 'build' ? await adaptBuild(option.source, context)
      : kind === 'filter' ? await adaptFilter(option.source, context)
      : kind === 'atlas' ? await adaptAtlas(option.source, context, bundle.timeline.firstMapAnchor?.anchorId ?? '')
      : await adaptText(option.source, context, option.actions.length ? option.actions.map(action => action.trigger) : undefined);
    const key = revisionKey(option.source.ref);
    const old = dependencies.get(key);
    requireValue(!old || equal(old.ref, option.source.ref) && equal(old.snapshot, option.source.fallbackSnapshot), 'A source revision has conflicting snapshots.');
    dependencies.set(key, old ?? { ref: option.source.ref, snapshot: option.source.fallbackSnapshot, dependsOn: [] });
  }
  bundle.dependencies = [...dependencies.values()];
  bundle.schedulerVersion = SCHEDULER_VERSION;
  bundle.choices = bundle.timeline.clips.flatMap(clip => clip.selectedOptionId === null ? [] : [{ clipId: clip.clipId, optionId: clip.selectedOptionId }]);
  return dto(timelineBundleSchema, bundle, policy.limits);
}

export async function validatePack(input: unknown, policy: PackPolicy, readBlob: BlobReader): Promise<{ pack: StarterPack; blobs: Map<Hash, Uint8Array> }> {
  for (const value of [policy.maxBlobBytes, policy.maxTotalBlobBytes, policy.maxEvidenceAgeMs]) requireValue(Number.isSafeInteger(value) && value > 0, 'Starter pack policy values must be positive safe integers.');
  const pack = parsePack(input, policy.limits), blobs = new Map<Hash, Uint8Array>();
  let total = 0;
  for (const hash of pack.blobs) {
    let bytes: Uint8Array;
    try { bytes = await readBlob(hash); } catch { throw new StarterPackError('INCOMPLETE', `The pinned blob ${hash} is unavailable.`); }
    requireValue(bytes instanceof Uint8Array, 'A blob reader must return bytes.');
    total += bytes.byteLength;
    requireValue(bytes.byteLength <= policy.maxBlobBytes && total <= policy.maxTotalBlobBytes, 'Pinned blobs exceed the configured size limits.', 'LIMIT_EXCEEDED');
    failHash(hashBytes(bytes) === hash, `The pinned blob ${hash} has changed.`);
    blobs.set(hash, Uint8Array.from(bytes));
  }
  const needed = (hash: Hash) => requireValue(blobs.has(hash), `The pinned blob ${hash} is not included.`, 'INCOMPLETE');
  for (const source of pack.sources) needed(source.contentHash);
  const requiredAssets = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if ('assetId' in value && 'mediaType' in value && 'contentHash' in value) needed(parseId('hash', String(value.contentHash)));
    if ('sourceHash' in value && 'sourceId' in value && 'field' in value) needed(parseId('hash', String(value.sourceHash)));
    for (const child of Object.values(value)) requiredAssets(child);
  };
  for (const entry of pack.entries) {
    const bundleHash = await contentHash(entry.bundle);
    failHash(entry.timelineRef.payloadHash === bundleHash && entry.timelineRef.fallbackSnapshotHash === bundleHash, 'The Timeline revision does not match its frozen bundle.');
    requireValue(equal(entry.timelineRef.stamp, entry.bundle.timeline.stamp), 'The Timeline stamp does not match its revision.');
    const builds = new Map(entry.localBuilds.map(build => [revisionKey(build.source), build]));
    for (const dependency of entry.bundle.dependencies) {
      await verifySource({ ref: dependency.ref, fallbackSnapshot: dependency.snapshot }, policy.limits);
      needed(dependency.ref.payloadHash);
      if (dependency.snapshot.kind === 'build') {
        const build = builds.get(revisionKey(dependency.ref));
        requireValue(build && equal(build.source, dependency.ref), 'The frozen Build XML, guide and settings are missing.', 'INCOMPLETE');
        failHash(await contentHash(build.snapshot) === dependency.ref.payloadHash, 'The Build revision does not match its local snapshot.');
        requireValue(equal(build.snapshot.stamp, dependency.ref.stamp) && equal(build.snapshot.settings.stamp, dependency.ref.stamp) &&
          equal(build.snapshot.publicSnapshot, dependency.snapshot.payload) && equal(build.snapshot.guide, dependency.snapshot.payload.guide) &&
          equal(build.snapshot.settings.configuration, dependency.snapshot.payload.configuration), 'The Build guide, settings or public snapshot do not match.');
        for (const ref of build.snapshot.dataReferences) { needed(ref.payloadHash); needed(ref.fallbackSnapshotHash); }
        builds.delete(revisionKey(dependency.ref));
      } else failHash(hashBytes(canonicalJson(dependency.snapshot.payload)) === dependency.ref.payloadHash, 'A source revision does not match its payload.');
    }
    requireValue(builds.size === 0, 'A local Build snapshot has no pinned dependency.');
    for (const dataset of entry.datasets) {
      failHash(atlasDatasetDigest(dataset) === dataset.ref.contentHash, 'An Atlas dataset digest does not match.');
      needed(dataset.verificationReportHash);
      for (const hash of Object.values(dataset.exportFileHashes)) needed(hash);
    }
    requiredAssets(entry.bundle); requiredAssets(entry.datasets);
    if (entry.review) failHash(entry.review.contentHash === await starterContentHash(entry, pack.sources), 'The content review belongs to another starter revision.');
    for (const evidenceId of [...entry.evidenceIds, ...(entry.review?.evidenceIds ?? [])]) requireValue(pack.sources.some(source => source.evidenceId === evidenceId), 'A starter evidence reference is missing.', 'INCOMPLETE');
  }
  return { pack, blobs };
}

export async function qualifyPack(input: unknown, liveInput: unknown, requestedScope: LeagueStamp, policy: PackPolicy, readBlob: BlobReader,
  checkedAt: string): Promise<{ pack: StarterPack; report: QualificationReport }> {
  time(checkedAt);
  const { pack, blobs } = await validatePack(input, policy, readBlob), live = parseLiveContext(liveInput, policy.limits);
  const global: string[] = [];
  const sources = new Map(pack.sources.map(source => [source.evidenceId, source]));
  const checkedEvidence = (id: string): boolean => sources.get(id)?.verification.status === 'known';
  const fresh = (at: string) => Date.parse(at) <= Date.parse(checkedAt) && Date.parse(checkedAt) - Date.parse(at) <= policy.maxEvidenceAgeMs;
  const leagueEvidence = sources.get(live.leagues.evidenceId);
  if (!leagueEvidence || leagueEvidence.url !== LEAGUES_URL || !checkedEvidence(leagueEvidence.evidenceId) || !fresh(leagueEvidence.fetchedAt)) global.push('The live league catalog has no fresh official evidence.');
  else {
    const raw = JSON.parse(new TextDecoder().decode(blobs.get(leagueEvidence.contentHash)!)) as { result?: { id: string; realm: string }[] };
    requireValue(Array.isArray(raw.result) && equal(raw.result.map(row => ({ leagueId: row.id, realm: row.realm })), live.leagues.entries), 'The live league catalog does not match its fetched source.');
  }
  if (live.patchVersion.status === 'unknown') global.push(live.patchVersion.reason);
  else {
    const evidence = sources.get(live.patchVersion.evidenceId);
    if (!evidence || evidence.url !== PATCHES_URL || !checkedEvidence(evidence.evidenceId) || !fresh(evidence.fetchedAt)) global.push('The live patch has no fresh official evidence.');
    else {
      const html = new TextDecoder().decode(blobs.get(evidence.contentHash)!);
      requireValue(latestPatch(html) === live.patchVersion.value, 'The live patch does not match the official patch list.');
    }
  }
  if (!fresh(live.checkedAt)) global.push('The live context needs a new source check.');
  const scope = scopeValues(requestedScope);
  if (scope.some(value => value === null)) global.push('Choose a known league, realm, mode and patch.');
  if (!live.leagues.entries.some(row => row.leagueId === scope[0] && row.realm === scope[1])) global.push('The selected league and realm are absent from the live catalog.');
  if (live.patchVersion.status === 'known' && scope[3] !== live.patchVersion.value) global.push('The selected patch is not the checked live patch.');
  const entries: QualificationReport['entries'] = [];
  for (const entry of pack.entries) {
    const blockers = [...global], add = (message: string) => { if (!blockers.includes(message)) blockers.push(message); };
    const stamp = entry.bundle.timeline.stamp;
    const checkStamp = (candidate: LeagueStamp) => {
      if (!sameScope(candidate, stamp) || scopeValues(candidate).some(value => value === null)) add('All source, settings and action stamps need the same known league, realm, mode and patch.');
      for (const field of [candidate.leagueId, candidate.realm, candidate.mode, candidate.patchVersion]) if (field.status === 'known' && !checkedEvidence(field.evidenceId)) add('A source stamp has no checked evidence.');
    };
    checkStamp(stamp);
    if (!sameScope(stamp, requestedScope)) add('The original starter stamp differs from the selected scope.');
    if (!entry.review || entry.review.decision !== 'checked') add(entry.review?.reason ?? 'The content owner has not checked this starter.');
    else {
      if (!sameScope(entry.review.scope, stamp)) add('The content review covers another scope.');
      if (Date.parse(entry.review.checkedAt) > Date.parse(checkedAt) || entry.evidenceIds.some(id => !entry.review!.evidenceIds.includes(id))) add('The content review is incomplete or dated in the future.');
    }
    if (!entry.evidenceIds.length || [...entry.evidenceIds, ...(entry.review?.evidenceIds ?? [])].some(id => !checkedEvidence(id))) add('Starter guidance needs checked source evidence.');
    for (const kind of ['build'] as const) if (!entry.bundle.timeline.lanes.some(lane => lane.type === kind && !lane.muted && lane.clipIds.length)) add(`The starter needs an enabled ${kind} lane.`);
    if (entry.bundle.schedulerVersion !== SCHEDULER_VERSION) add('The pinned scheduler version is unavailable.');
    for (const dependency of entry.bundle.dependencies) {
      checkStamp(dependency.ref.stamp); checkStamp(dependency.snapshot.payload.stamp);
      if (dependency.snapshot.kind === 'atlas') {
        const plan = dependency.snapshot.payload, dataset = entry.datasets.find(value => equal(value.ref, plan.dataset));
        if (!dataset) { add('The pinned Atlas dataset is missing.'); continue; }
        checkStamp(dataset.ref.stamp);
        const report = JSON.parse(new TextDecoder().decode(blobs.get(dataset.verificationReportHash)!)) as { issues?: unknown[]; liveCompatibility?: Known<'verified'> };
        if (dataset.compatibility.status !== 'known' || !Array.isArray(report.issues) || report.issues.length ||
          report.liveCompatibility?.status !== 'known' || report.liveCompatibility.value !== 'verified') add('The Atlas dataset has not passed live qualification.');
        if (dataset.gamePatch.status !== 'known' || !equal(dataset.gamePatch.value, scopeValues(stamp)[3])) add('The Atlas dataset patch is not the starter patch.');
        try {
          const graph = createGraph(dataset.graph, { status: 'known', value: dataset.costModel, evidenceId: dataset.costModel.contentHash });
          for (const step of Object.values(plan.stepsById)) {
            const inspected = inspectAllocation(graph, step.allocatedIds), cost = allocationCost(graph, step.allocatedIds);
            if (inspected.missingIds.length || inspected.disconnectedIds.length || step.repair.missingIds.length || step.repair.disconnectedIds.length ||
              cost.status === 'unknown' || cost.value > step.pointBudget) add('An Atlas step needs repair or exceeds its sourced budget.');
            if (dataset.costModel.maximumPoints.status === 'unknown' || step.pointBudget > dataset.costModel.maximumPoints.value || dataset.costModel.grantedPoints.status === 'unknown') add('Atlas point limits or grants are unverified.');
            if (Object.keys(step.effectSelections).length) add('Atlas effect selections need a qualified effect-choice validator.');
            for (const [rows, catalog] of [[step.maps, dataset.catalogs.maps], [step.favouriteMaps, dataset.catalogs.maps], [step.scarabs, dataset.catalogs.scarabs]] as const)
              if (rows.some(row => !catalog.some(item => item.catalogId === row.catalogId) || !row.provenance.length)) add('An Atlas practical row lacks a sourced catalog entry.');
          }
        } catch (error) { add(error instanceof Error ? error.message : 'The sourced Atlas graph or costs are invalid.'); }
      }
    }
    for (const build of entry.localBuilds) {
      checkStamp(build.snapshot.stamp); checkStamp(build.snapshot.settings.stamp);
      if (!build.snapshot.buildXml.trim() || !build.snapshot.guide.length || !build.snapshot.dataReferences.length) add('A Build needs its XML, generated guide and pinned game data.');
      for (const ref of build.snapshot.dataReferences) checkStamp(ref.stamp);
    }
    for (const clip of entry.bundle.timeline.clips) for (const option of clip.options) {
      for (const action of option.actions) checkStamp(action.stamp);
      if (clip.instructionOverrides.length || clip.excludedActionIds.length || clip.timingMode !== 'keep_instruction_timing') add('Starter clips must preserve checked source instructions and timing.');
      const kind = option.source.fallbackSnapshot.kind;
      if (kind === 'filter') {
        const filter = option.source.fallbackSnapshot.payload;
        if (!filter.stages.length || filter.stages.some(stage => !stage.rules.length) || filter.capabilities.automaticSelection) add('A Filter needs sourced rules and supported file handoff.');
      }
    }
    try {
      const rebuilt = await assembleBundle(entry.bundle, policy);
      if (!equal(rebuilt, entry.bundle)) add('The frozen actions differ from the source adapters.');
      const schedule = await compileSchedule({ timeline: entry.bundle.timeline, options: { limits: policy.limits } });
      if (!schedule.actions.length || ['build'].some(kind => !schedule.actions.some(action => entry.bundle.timeline.lanes.find(lane => lane.laneId === action.laneId)?.type === kind))) add('The starter has no runnable instructions in a required lane.');
    } catch (error) { add(error instanceof Error ? error.message : 'The frozen Timeline cannot be scheduled.'); }
    entries.push({ starterId: entry.starterId, status: blockers.length === 0 ? 'qualified' : !sameScope(stamp, requestedScope) ? 'archive' : 'unverified', blockers });
  }
  if (!pack.entries.length) global.push('No sourced Build starter has passed content review.');
  return { pack, report: { schemaVersion: 1, packHash: await contentHash(pack), checkedAt, qualified: entries.some(entry => entry.status === 'qualified'), blockers: global, entries } };
}

export function latestPatch(html: string): string | null {
  return html.match(/>\s*(\d+\.\d+\.\d+[a-z]?) Patch Notes\s*<\/a>/)?.[1] ?? null;
}
export async function chooserState(pack: StarterPack, report: QualificationReport) {
  failHash(await contentHash(pack) === report.packHash, 'The qualification report belongs to another pack revision.');
  const current = pack.entries.filter(entry => report.entries.some(row => row.starterId === entry.starterId && row.status === 'qualified'));
  return { current: structuredClone(current), archive: structuredClone(pack.entries.filter(entry => !current.includes(entry))),
    emptyMessage: current.length ? null : 'No starter timelines are available for this league yet.',
    actions: current.length ? [] : ['Import a build', 'Import a timeline', 'Browse archive'] };
}
export function exportStarterTimeline(entry: StarterEntry, policy: PackPolicy): string {
  return exportTimelineFile({ source: entry.timelineRef, bundle: entry.bundle, datasets: entry.datasets }, policy.limits);
}
export function importStarterTimeline(file: string, policy: PackPolicy) {
  return importTimelineFile(file, policy.limits);
}
export async function seedUploadFixture(input: unknown, live: LiveContext, scope: LeagueStamp, policy: PackPolicy, readBlob: BlobReader,
  checkedAt: string, starterId: string): Promise<{ label: 'Starter'; creatorName: string; budget: StarterEntry['budget']; playstyles: StarterEntry['playstyles']; request: PublishRequest }> {
  const { pack, report } = await qualifyPack(input, live, scope, policy, readBlob, checkedAt);
  requireValue(report.entries.some(row => row.starterId === starterId && row.status === 'qualified'), 'Only a checked current starter can become a seed upload fixture.');
  const entry = pack.entries.find(value => value.starterId === starterId)!;
  return { label: 'Starter', creatorName: entry.creatorName, budget: entry.budget, playstyles: [...entry.playstyles], request: {
    source: entry.timelineRef, visibility: 'public', payload: { kind: 'timeline', payload: entry.bundle }, description: [], includeNotes: false,
    includeHistory: false, idempotencyKey: `starter:${report.packHash}:${starterId}` } };
}
