import { createHash } from 'node:crypto';
import { apiResultSchema, parseId, parseItemLink, type AtlasDataset, type DatasetRef, type Hash, type ItemLinkIntent, type ValidationLimits } from '@pom/mastery-contracts';
import { createGraph, inspectAllocation, type AtlasGraph } from '../../shared/atlas/graph.js';
import { atlasDatasetDigest, canonicalJson, hashJson } from '../kb/sources/atlas.js';
import { atlasPlans, decodePomFile, documentStamp, encodePomFile, MasteryFormatError, optionsForDestination, preparePomSnapshot,
  readPomSnapshot, type ExportOptions, type PomSnapshot, type SnapshotInput } from '../../shared/atlas/codecs/pom.js';
import { decodeAtlasCode, detectAtlasLink, type LinkDetection } from '../../shared/atlas/codecs/external.js';

export type ImportWarning =
  | { kind: 'unknown_stamp'; message: 'Source league unknown' | 'Source stamp unknown'; fields: string[] }
  | { kind: 'dataset_unavailable'; message: string; dataset: DatasetRef }
  | { kind: 'compatibility_unverified'; message: 'Live compatibility unverified'; dataset: DatasetRef }
  | { kind: 'repair'; message: string; stepId: string; missingIds: string[]; disconnectedIds: string[] };
export type ImportPreview = { kind: 'snapshot'; snapshot: PomSnapshot; warnings: ImportWarning[]; sourceInput: string };
/** External link allocation. `repair` is null when no tree graph was supplied (IDs are kept exactly); otherwise unknown and disconnected IDs for repair rows. */
export type ExternalAllocationPreview = Extract<LinkDetection, { kind: 'allocation' }> & {
  repair: { missingIds: string[]; disconnectedIds: string[] } | null;
};
export type ImportResult = ImportPreview | ExternalAllocationPreview | Exclude<LinkDetection, { kind: 'invalid' } | { kind: 'allocation' }>
  | { kind: 'hosted_link'; input: string; intent: ItemLinkIntent }
  | { kind: 'invalid'; input: string; code: MasteryFormatError['code']; message: string };
export type DatasetLookup = (ref: DatasetRef) => { graph: AtlasGraph; compatibilityVerified: boolean } | null;
export type HostedMasterySnapshot = {
  format: 'pathofmastery-share'; schemaVersion: 1; payloadHash: Hash; snapshot: PomSnapshot;
};

function verifiedDataset(dataset: AtlasDataset): AtlasGraph {
  const { contentHash: _costHash, ...costBody } = dataset.costModel;
  const { contentHash: _taxonomyHash, ...taxonomyBody } = dataset.taxonomy;
  if (atlasDatasetDigest(dataset) !== dataset.ref.contentHash ||
    hashJson({ rootId: dataset.graph.rootId, nodes: dataset.graph.nodes }) !== dataset.graph.graphHash ||
    hashJson(costBody) !== dataset.costModel.contentHash || hashJson(taxonomyBody) !== dataset.taxonomy.contentHash) {
    throw new MasteryFormatError('INVALID', 'Embedded tree data failed its content checks.');
  }
  return createGraph(dataset.graph, { status: 'known', value: dataset.costModel, evidenceId: dataset.costModel.contentHash });
}
function sameDataset(left: DatasetRef, right: DatasetRef): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
function previewPomSnapshot(snapshot: PomSnapshot, sourceInput: string, lookup?: DatasetLookup): ImportPreview {
  const warnings: ImportWarning[] = [];
  const stamp = documentStamp(snapshot.document);
  const fields = (['leagueId', 'realm', 'mode', 'patchVersion', 'datasetVersion'] as const).filter(field => stamp[field].status === 'unknown');
  if (fields.length) warnings.push({ kind: 'unknown_stamp', message: stamp.leagueId.status === 'unknown' ? 'Source league unknown' : 'Source stamp unknown', fields });
  const embedded = new Map(snapshot.datasets.map(dataset => [dataset.ref.contentHash, { dataset, graph: verifiedDataset(dataset) }]));
  const plans = [snapshot.document, ...(snapshot.history ?? []).map(entry => entry.snapshot)].flatMap(document => {
    if (document.kind === 'build') throw new MasteryFormatError('INVALID', 'History contains a Build snapshot.');
    return atlasPlans(document);
  });
  const used = new Set<Hash>();
  for (const plan of plans) {
    const tree = embedded.get(plan.dataset.contentHash);
    if (tree && !sameDataset(tree.dataset.ref, plan.dataset)) throw new MasteryFormatError('INVALID', 'Embedded tree data does not match its source stamp or variant.');
    const resolved = tree ? { graph: tree.graph, compatibilityVerified: false } : lookup?.(plan.dataset) ?? null;
    if (!used.has(plan.dataset.contentHash)) {
      used.add(plan.dataset.contentHash);
      if (!resolved) warnings.push({ kind: 'dataset_unavailable', dataset: structuredClone(plan.dataset), message: 'Tree data is unavailable. The plan snapshot is preserved.' });
      // Imported compatibility labels are source claims; a file cannot qualify a live catalog.
      if (!resolved?.compatibilityVerified) warnings.push({ kind: 'compatibility_unverified', dataset: structuredClone(plan.dataset), message: 'Live compatibility unverified' });
    }
    for (const step of Object.values(plan.stepsById)) {
      const repair = resolved ? inspectAllocation(resolved.graph, step.allocatedIds) : step.repair;
      if (repair.missingIds.length || repair.disconnectedIds.length) warnings.push({ kind: 'repair',
        stepId: step.stepId, missingIds: [...repair.missingIds], disconnectedIds: [...repair.disconnectedIds],
        message: `Missing ${repair.missingIds.length} node IDs` });
    }
  }
  return { kind: 'snapshot', snapshot: structuredClone(snapshot), warnings, sourceInput };
}
export function importMastery(input: string, limits: ValidationLimits, lookup?: DatasetLookup, externalGraph?: AtlasGraph | null): ImportResult {
  try {
    if (new TextEncoder().encode(input).length > limits.maxBytes) throw new MasteryFormatError('LIMIT_EXCEEDED', 'The input exceeds the configured size limit.');
    const text = input.trim();
    if (!text) throw new MasteryFormatError('INVALID', 'Could not read this code. Check that it is an atlas export.');
    if (text.startsWith('{')) {
      let value: unknown;
      try { value = JSON.parse(text); } catch { throw new MasteryFormatError('INVALID', 'Could not read this code. Check that it is an atlas export.'); }
      if ((value as { format?: unknown }).format === 'pathofmastery-share') return previewPomSnapshot(readHostedSnapshot(value, limits).snapshot, input, lookup);
      return previewPomSnapshot(decodePomFile(text, limits), input, lookup);
    }
    const item = parseItemLink(text, { maxLength: limits.maxStringLength });
    if (item.ok) return { kind: 'hosted_link', input, intent: item.value };
    const link = detectAtlasLink(input);
    if (link.kind === 'allocation') return { ...link, repair: externalGraph ? inspectAllocation(externalGraph, link.nodeIds) : null };
    if (link.kind !== 'invalid') return link;
    throw new MasteryFormatError('INVALID', 'Could not read this code. Check that it is an atlas export.');
  } catch (error) {
    const failure = error instanceof MasteryFormatError ? error : new MasteryFormatError('INVALID', 'The snapshot is incomplete or invalid.');
    return { kind: 'invalid', input, code: failure.code, message: failure.message };
  }
}
/**
 * A tree link or code imported as a new plan. The link names node IDs only, so the plan is built on the tree data the player
 * chose; main accepts it only when it has one step holding exactly the link's IDs on bundled tree data it knows.
 */
export function verifiedLinkPlan(sourceInput: string, plan: unknown, limits: ValidationLimits, lookup: DatasetLookup): import('@pom/mastery-contracts').AtlasPlan {
  const code = sourceInput.trim(), decoded = decodeAtlasCode(code);
  const text = !decoded ? sourceInput : decoded.format === 'official' ? `https://www.pathofexile.com/fullscreen-atlas-skill-tree/${code}` : `https://poeplanner.com/atlas-tree/${code}`;
  const again = importMastery(text, limits, lookup);
  if (again.kind !== 'allocation') throw new MasteryFormatError('INVALID', 'This file is not an Atlas plan.');
  const p = plan as import('@pom/mastery-contracts').AtlasPlan | null;
  const steps = p && p.stepsById ? Object.values(p.stepsById) : [];
  if (!p || steps.length !== 1 || !p.dataset || !lookup(p.dataset)) throw new MasteryFormatError('INVALID', 'Choose bundled tree data for this link.');
  const have = [...steps[0]!.allocatedIds].sort(), want = [...again.nodeIds].sort();
  if (have.length !== want.length || have.some((id, i) => id !== want[i])) throw new MasteryFormatError('INVALID', 'The imported tree does not match the link.');
  return p;
}
export function exportMasteryFile(input: SnapshotInput, limits: ValidationLimits, options: Omit<ExportOptions, 'destination'> = {}) {
  const text = encodePomFile(input, limits, optionsForDestination(options, 'file'));
  // Run import-side integrity and source checks before exposing the exported file.
  previewPomSnapshot(decodePomFile(text, limits), text);
  return { extension: input.document.kind === 'atlas' ? '.pom-atlas' : '.pom-timeline', mediaType: 'application/json', text };
}
function digest(snapshot: PomSnapshot): Hash {
  return parseId('hash', createHash('sha256').update(canonicalJson(snapshot)).digest('hex'));
}
export function prepareHostedSnapshot(input: SnapshotInput, limits: ValidationLimits, options: Omit<ExportOptions, 'destination'> = {}): HostedMasterySnapshot {
  const snapshot = preparePomSnapshot(input, limits, optionsForDestination(options, 'hosted'));
  if (!snapshot.source) throw new MasteryFormatError('INCOMPLETE', 'Save a revision before creating a share link.');
  const result: HostedMasterySnapshot = { format: 'pathofmastery-share', schemaVersion: 1, snapshot, payloadHash: digest(snapshot) };
  return readHostedSnapshot(result, limits);
}
export function readHostedSnapshot(input: unknown, limits: ValidationLimits): HostedMasterySnapshot {
  const bounded = apiResultSchema<unknown>({ parse: value => ({ ok: true, value }) }).parse({ ok: true, value: input }, limits);
  if (!bounded.ok) throw new MasteryFormatError(bounded.issues[0]?.code === 'LIMIT_EXCEEDED' ? 'LIMIT_EXCEEDED' : 'INVALID', 'The share snapshot exceeds the configured limits or contains invalid data.');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new MasteryFormatError('INVALID', 'The share snapshot is invalid.');
  const value = input as Record<string, unknown>;
  if (value.format !== 'pathofmastery-share' || Object.keys(value).some(key => !['format', 'schemaVersion', 'payloadHash', 'snapshot'].includes(key))) throw new MasteryFormatError('INVALID', 'The share snapshot is invalid.');
  if (value.schemaVersion !== 1) throw new MasteryFormatError('UNSUPPORTED_VERSION', 'This file version is not supported yet.');
  const snapshot = readPomSnapshot(value.snapshot, limits);
  if (!snapshot.source || snapshot.privateNotes !== undefined) throw new MasteryFormatError('INVALID', 'The share snapshot needs a saved revision and cannot contain private notes.');
  const payloadHash = digest(snapshot);
  if (payloadHash !== value.payloadHash) throw new MasteryFormatError('INVALID', 'The share snapshot failed its content check.');
  previewPomSnapshot(snapshot, '');
  return { format: 'pathofmastery-share', schemaVersion: 1, payloadHash, snapshot };
}
