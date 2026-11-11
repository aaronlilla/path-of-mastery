import {
  apiResultSchema, atlasDatasetSchema, publicDocumentNode, publicDocumentSchema, revisionRefSchema,
  leagueStampSchema, type AtlasDataset, type AtlasPlan, type PublicDocument, type PublicHistoryEntry,
  type RevisionRef, type StepId, type TimelineBundle, type ValidationLimits,
} from '@pom/mastery-contracts';
import { validatePlan } from '../plan.js';

export type MasteryDocument = Extract<PublicDocument, { kind: 'atlas' | 'timeline' }>;
export type PrivateNote = { snapshot: string; text: string };
export type PomSnapshot = {
  format: 'pathofmastery'; schemaVersion: 1; document: MasteryDocument;
  source?: RevisionRef; datasets: AtlasDataset[];
  history?: PublicHistoryEntry[]; privateNotes?: PrivateNote[];
};
export type ExportOptions = {
  destination: 'file' | 'hosted'; includeNotes?: boolean; includeHistory?: boolean;
  includePrivateNotes?: boolean; allSteps?: boolean; stepId?: StepId; includeMapsScarabs?: boolean;
};
export type SnapshotInput = {
  document: MasteryDocument; source?: RevisionRef; datasets?: AtlasDataset[];
  history?: PublicHistoryEntry[]; privateNotes?: PrivateNote[];
};
export class MasteryFormatError extends Error {
  constructor(readonly code: 'INVALID' | 'UNSUPPORTED_VERSION' | 'LIMIT_EXCEEDED' | 'INCOMPLETE', message: string) {
    super(message); this.name = 'MasteryFormatError';
  }
}
const bounded = apiResultSchema<unknown>({ parse: value => ({ ok: true, value }) });
function bound(value: unknown, limits: ValidationLimits): void {
  const result = bounded.parse({ ok: true, value }, limits);
  if (!result.ok) throw new MasteryFormatError(result.issues[0]?.code === 'LIMIT_EXCEEDED' ? 'LIMIT_EXCEEDED' : 'INVALID', 'The file exceeds the configured limits or contains invalid data.');
}
function invalid(message = 'Could not read this code. Check that it is an atlas export.'): never {
  throw new MasteryFormatError('INVALID', message);
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid();
}
function definedFields(value: unknown): Record<string, unknown> {
  const input = record(value), descriptors = Object.getOwnPropertyDescriptors(input);
  if (Object.getOwnPropertySymbols(input).length || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) invalid();
  if (Object.values(descriptors).some(descriptor => !descriptor.enumerable || !('value' in descriptor))) invalid();
  return Object.fromEntries(Object.entries(descriptors).filter(([, descriptor]) => descriptor.value !== undefined).map(([key, descriptor]) => [key, descriptor.value]));
}
export function optionsForDestination(options: Omit<ExportOptions, 'destination'>, destination: ExportOptions['destination']): ExportOptions {
  const choices = definedFields(options);
  keys(choices, ['includeNotes', 'includeHistory', 'includePrivateNotes', 'allSteps', 'stepId', 'includeMapsScarabs']);
  return { ...choices, destination };
}
function pin(value: unknown, limits: ValidationLimits): RevisionRef {
  const result = revisionRefSchema.parse(value, limits);
  if (!result.ok) invalid('The source revision is invalid.');
  return result.value;
}
export function documentStamp(document: MasteryDocument) {
  return document.kind === 'atlas' ? document.payload.stamp : document.payload.timeline.stamp;
}
function validateDocument(value: unknown, limits: ValidationLimits): MasteryDocument {
  const result = publicDocumentSchema.parse(value, limits);
  if (!result.ok) {
    if (result.issues.some(issue => issue.code === 'UNSUPPORTED_VERSION')) throw new MasteryFormatError('UNSUPPORTED_VERSION', 'This file version is not supported yet.');
    invalid('The snapshot is incomplete or invalid.');
  }
  if (result.value.kind === 'build') invalid('This is a Build snapshot. Open it in Builds?');
  const document = result.value;
  if (document.kind === 'atlas') validatePlan(document.payload, limits);
  else {
    for (const dependency of document.payload.dependencies) {
      if (dependency.snapshot.kind === 'atlas') validatePlan(dependency.snapshot.payload, limits);
    }
  }
  return document;
}
function project(value: unknown, limits: ValidationLimits, includeNotes: boolean): MasteryDocument {
  bound(value, limits);
  try {
    // The exported node helpers apply the same nested allowlist as public publication.
    const projected = publicDocumentNode.read(value, '$', { limits, options: { unknownFields: 'strip', includeNotes, includeHistory: false } });
    return validateDocument(projected, limits);
  } catch (error) {
    if (error instanceof MasteryFormatError) throw error;
    if ((error as { issue?: { code?: string } }).issue?.code === 'UNSUPPORTED_VERSION') throw new MasteryFormatError('UNSUPPORTED_VERSION', 'This file version is not supported yet.');
    throw new MasteryFormatError('INVALID', 'The snapshot is incomplete or invalid.');
  }
}
function scopeAtlas(plan: AtlasPlan, options: ExportOptions): AtlasPlan {
  const result = structuredClone(plan);
  if (options.allSteps === false) {
    const step = options.stepId && result.stepsById[options.stepId];
    if (!step) throw new MasteryFormatError('INCOMPLETE', 'Choose a step included in this revision.');
    result.stepsById = { [step.stepId]: step };
    result.sequencePositions = [{ kind: 'step', positionId: step.stepId, stepId: step.stepId }];
  }
  if (options.includeMapsScarabs === false) {
    for (const step of Object.values(result.stepsById)) { step.maps = []; step.favouriteMaps = []; step.scarabs = []; }
  }
  return result;
}
function scopeDocument(document: MasteryDocument, options: ExportOptions): MasteryDocument {
  if (document.kind === 'atlas') return { kind: 'atlas', payload: scopeAtlas(document.payload, options) };
  if (options.allSteps === false || options.includeMapsScarabs === false) invalid('Atlas step scope is unavailable for a Timeline bundle.');
  return document;
}
function readHistory(value: unknown, kind: MasteryDocument['kind'], source: RevisionRef | undefined, limits: ValidationLimits): PublicHistoryEntry[] {
  if (!Array.isArray(value)) invalid();
  const seen = new Set<string>();
  let objectId = source?.objectId;
  return value.map(input => {
    const entry = record(input); keys(entry, ['revision', 'label', 'createdAt', 'snapshot']);
    const revision = pin(entry.revision, limits), snapshot = validateDocument(entry.snapshot, limits);
    const key = `${revision.objectId}/${revision.revisionId}`;
    objectId ??= revision.objectId;
    if (seen.has(key) || snapshot.kind !== kind || revision.objectId !== objectId) invalid('History must contain distinct revisions of this object.');
    seen.add(key);
    if (typeof entry.label !== 'string' || !entry.label.trim() || typeof entry.createdAt !== 'string') invalid();
    const timestamp = leagueStampSchema.parse({ ...revision.stamp, createdAt: entry.createdAt }, limits);
    if (!timestamp.ok || JSON.stringify(revision.stamp) !== JSON.stringify(documentStamp(snapshot))) invalid('History stamps do not match their snapshots.');
    return { revision, label: entry.label, createdAt: entry.createdAt, snapshot };
  });
}
function readPrivate(value: unknown, history: PublicHistoryEntry[]): PrivateNote[] {
  if (!Array.isArray(value)) invalid();
  const allowed = new Set(['current', ...history.map(entry => entry.revision.revisionId)]), seen = new Set<string>();
  return value.map(input => {
    const note = record(input); keys(note, ['snapshot', 'text']);
    if (typeof note.snapshot !== 'string' || !allowed.has(note.snapshot) || seen.has(note.snapshot) || typeof note.text !== 'string') invalid('Private notes must identify an included snapshot.');
    seen.add(note.snapshot);
    return { snapshot: note.snapshot, text: note.text };
  });
}
function readDatasets(value: unknown, limits: ValidationLimits): AtlasDataset[] {
  if (!Array.isArray(value)) invalid();
  const seen = new Set<string>();
  return value.map(input => {
    const result = atlasDatasetSchema.parse(input, limits);
    if (!result.ok) {
      if (result.issues.some(issue => issue.code === 'UNSUPPORTED_VERSION')) throw new MasteryFormatError('UNSUPPORTED_VERSION', 'This file version is not supported yet.');
      invalid('Embedded tree data is invalid.');
    }
    if (seen.has(result.value.ref.contentHash)) invalid('Embedded tree data is duplicated.');
    seen.add(result.value.ref.contentHash);
    return result.value;
  });
}

export function preparePomSnapshot(input: SnapshotInput, limits: ValidationLimits, options: ExportOptions): PomSnapshot {
  input = definedFields(input) as SnapshotInput;
  options = definedFields(options) as ExportOptions;
  bound(input, limits);
  bound(options, limits);
  keys(record(options), ['destination', 'includeNotes', 'includeHistory', 'includePrivateNotes', 'allSteps', 'stepId', 'includeMapsScarabs']);
  for (const key of ['includeNotes', 'includeHistory', 'includePrivateNotes', 'allSteps', 'includeMapsScarabs'] as const) {
    if (options[key] !== undefined && typeof options[key] !== 'boolean') invalid('Export choices must be explicit.');
  }
  if (options.destination !== 'file' && options.destination !== 'hosted') invalid();
  if (options.destination === 'hosted' && options.includePrivateNotes === true) invalid('Private notes cannot be included in a hosted share.');
  const includeNotes = options.includeNotes ?? options.destination === 'file';
  const document = scopeDocument(project(input.document, limits, includeNotes), options);
  const source = input.source === undefined ? undefined : pin(input.source, limits);
  const snapshot: PomSnapshot = { format: 'pathofmastery', schemaVersion: 1, document,
    datasets: readDatasets(input.datasets ?? [], limits), ...(source ? { source } : {}) };
  if (options.includeHistory === true) {
    const history = input.history ?? [];
    if (!Array.isArray(history)) invalid('History must contain revision snapshots.');
    snapshot.history = readHistory(history.map(inputEntry => {
      const entry = record(inputEntry);
      return { revision: entry.revision, label: entry.label, createdAt: entry.createdAt,
        snapshot: scopeDocument(project(entry.snapshot, limits, includeNotes), options) };
    }), document.kind, source, limits);
  }
  if (options.includePrivateNotes === true) snapshot.privateNotes = readPrivate(input.privateNotes ?? [], snapshot.history ?? []);
  return readPomSnapshot(snapshot, limits);
}

export function readPomSnapshot(input: unknown, limits: ValidationLimits): PomSnapshot {
  bound(input, limits);
  const value = record(input); keys(value, ['format', 'schemaVersion', 'document', 'source', 'datasets', 'history', 'privateNotes']);
  if (value.format !== 'pathofmastery') invalid();
  if (value.schemaVersion !== 1) throw new MasteryFormatError('UNSUPPORTED_VERSION', 'This file version is not supported yet.');
  const document = validateDocument(value.document, limits);
  const source = value.source === undefined ? undefined : pin(value.source, limits);
  if (source && JSON.stringify(source.stamp) !== JSON.stringify(documentStamp(document))) invalid('The source stamp does not match the snapshot.');
  const snapshot: PomSnapshot = { format: 'pathofmastery', schemaVersion: 1, document, datasets: readDatasets(value.datasets, limits), ...(source ? { source } : {}) };
  if (value.history !== undefined) snapshot.history = readHistory(value.history, document.kind, source, limits);
  if (value.privateNotes !== undefined) snapshot.privateNotes = readPrivate(value.privateNotes, snapshot.history ?? []);
  return snapshot;
}
export function decodePomFile(text: string, limits: ValidationLimits): PomSnapshot {
  if (new TextEncoder().encode(text).length > limits.maxBytes) throw new MasteryFormatError('LIMIT_EXCEEDED', 'The file exceeds the configured size limit.');
  let value: unknown;
  try { value = JSON.parse(text); } catch { invalid(); }
  return readPomSnapshot(value, limits);
}
export function encodePomFile(input: SnapshotInput, limits: ValidationLimits, options: ExportOptions): string {
  const result = JSON.stringify(preparePomSnapshot(input, limits, options)) + '\n';
  if (new TextEncoder().encode(result).length > limits.maxBytes) throw new MasteryFormatError('LIMIT_EXCEEDED', 'The file exceeds the configured size limit.');
  return result;
}
export function atlasPlans(document: MasteryDocument): AtlasPlan[] {
  return document.kind === 'atlas' ? [document.payload] : document.payload.dependencies.flatMap(dependency => dependency.snapshot.kind === 'atlas' ? [dependency.snapshot.payload] : []);
}
export function timelinePayload(snapshot: PomSnapshot): TimelineBundle {
  if (snapshot.document.kind !== 'timeline') invalid('This is an Atlas plan. Open it in Atlas?');
  return snapshot.document.payload;
}
