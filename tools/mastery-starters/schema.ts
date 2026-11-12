import { apiResultSchema, atlasDatasetSchema, isSafeHttpsUrl, leagueStampSchema, localBuildSourceSchema, parseId,
  revisionRefSchema, timelineBundleSchema, type Known, type Schema, type ValidationLimits } from '@pom/mastery-contracts';
import type { ContentReview, LiveContext, SourceEvidence, StarterEntry, StarterPack } from './types.js';

export class StarterPackError extends Error {
  constructor(readonly code: 'INVALID' | 'UNSUPPORTED_VERSION' | 'INCOMPLETE' | 'HASH_MISMATCH' | 'LIMIT_EXCEEDED', message: string) {
    super(message); this.name = 'StarterPackError';
  }
}
export function requireValue(condition: unknown, message: string, code: StarterPackError['code'] = 'INVALID'): asserts condition {
  if (!condition) throw new StarterPackError(code, message);
}
const bounded = apiResultSchema<unknown>({ parse: value => ({ ok: true, value }) });
export function bound(input: unknown, limits: ValidationLimits): void {
  const result = bounded.parse({ ok: true, value: input }, limits);
  if (!result.ok) throw new StarterPackError(result.issues[0]?.code === 'LIMIT_EXCEEDED' ? 'LIMIT_EXCEEDED' : 'INVALID', 'The starter pack exceeds its limits or contains invalid JSON data.');
}
export function dto<T>(schema: Schema<T>, input: unknown, limits: ValidationLimits): T {
  const parsed = schema.parse(input, limits);
  if (!parsed.ok) throw new StarterPackError(parsed.issues[0]?.code === 'UNSUPPORTED_VERSION' ? 'UNSUPPORTED_VERSION' : 'INVALID', parsed.issues.map(issue => `${issue.path}: ${issue.message}`).join('\n'));
  return structuredClone(parsed.value);
}
function record(input: unknown, keys: string[]): Record<string, unknown> {
  requireValue(input !== null && typeof input === 'object' && !Array.isArray(input), 'Expected a starter pack record.');
  requireValue(Object.keys(input).length === keys.length && Object.keys(input).every(key => keys.includes(key)), 'A starter pack record has missing or unsupported fields.');
  return input as Record<string, unknown>;
}
export function text(input: unknown): string {
  requireValue(typeof input === 'string' && input.trim().length, 'Expected nonempty text.'); return input;
}
export function time(input: unknown): string {
  const value = text(input);
  requireValue(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(value) && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value.replace(/Z$/, value.includes('.') ? 'Z' : '.000Z'), 'Expected a UTC timestamp.');
  return value;
}
function list<T>(input: unknown, read: (entry: unknown) => T): T[] {
  requireValue(Array.isArray(input), 'Expected an array.'); return input.map(read);
}
function choice<T extends string>(input: unknown, values: readonly T[]): T {
  requireValue(values.includes(input as T), 'Unsupported starter pack value.'); return input as T;
}
function known<T>(input: unknown, read: (value: unknown) => T): Known<T> {
  const row = record(input, (input as { status?: string } | null)?.status === 'known' ? ['status', 'value', 'evidenceId'] : ['status', 'reason']);
  return row.status === 'known' ? { status: 'known', value: read(row.value), evidenceId: text(row.evidenceId) }
    : { status: choice(row.status, ['unknown']), reason: text(row.reason) };
}
function evidence(input: unknown): SourceEvidence {
  const row = record(input, ['evidenceId', 'url', 'fetchedAt', 'contentHash', 'claim', 'verification']);
  const url = text(row.url); requireValue(isSafeHttpsUrl(url), 'Evidence requires a credential-free HTTPS source.');
  return { evidenceId: text(row.evidenceId), url, fetchedAt: time(row.fetchedAt), contentHash: parseId('hash', text(row.contentHash)),
    claim: text(row.claim), verification: known(row.verification, value => choice(value, ['checked'])) };
}
function review(input: unknown, limits: ValidationLimits): ContentReview | null {
  if (input === null) return null;
  const row = record(input, ['reviewer', 'checkedAt', 'contentHash', 'scope', 'evidenceIds', 'decision', 'reason']);
  return { reviewer: text(row.reviewer), checkedAt: time(row.checkedAt), contentHash: parseId('hash', text(row.contentHash)),
    scope: dto(leagueStampSchema, row.scope, limits), evidenceIds: list(row.evidenceIds, text),
    decision: choice(row.decision, ['checked', 'unverified']), reason: text(row.reason) };
}
function entry(input: unknown, limits: ValidationLimits): StarterEntry {
  const row = record(input, ['starterId', 'creatorName', 'budget', 'playstyles', 'timelineRef', 'bundle', 'localBuilds', 'datasets', 'evidenceIds', 'review']);
  return { starterId: text(row.starterId), creatorName: text(row.creatorName), budget: choice(row.budget, ['not_stated', 'cheap', 'medium', 'expensive']),
    playstyles: list(row.playstyles, value => choice(value, ['melee', 'ranged', 'minion', 'caster'])),
    timelineRef: dto(revisionRefSchema, row.timelineRef, limits), bundle: dto(timelineBundleSchema, row.bundle, limits),
    localBuilds: list(row.localBuilds, value => { const build = record(value, ['source', 'snapshot']);
      return { source: dto(revisionRefSchema, build.source, limits), snapshot: dto(localBuildSourceSchema, build.snapshot, limits) }; }),
    datasets: list(row.datasets, value => dto(atlasDatasetSchema, value, limits)), evidenceIds: list(row.evidenceIds, text), review: review(row.review, limits) };
}
export function parsePack(input: unknown, limits: ValidationLimits): StarterPack {
  bound(input, limits);
  const row = record(input, ['schemaVersion', 'packId', 'createdAt', 'sources', 'blobs', 'entries']);
  requireValue(row.schemaVersion === 1, 'This starter pack version is unsupported.', 'UNSUPPORTED_VERSION');
  const pack: StarterPack = { schemaVersion: 1, packId: text(row.packId), createdAt: time(row.createdAt), sources: list(row.sources, evidence),
    blobs: list(row.blobs, value => parseId('hash', text(value))), entries: list(row.entries, value => entry(value, limits)) };
  for (const ids of [pack.blobs, pack.sources.map(source => source.evidenceId), pack.entries.map(value => value.starterId),
    ...pack.entries.flatMap(value => [value.evidenceIds, value.playstyles, value.datasets.map(dataset => dataset.ref.contentHash), value.localBuilds.map(build => build.source.objectId + ':' + build.source.revisionId)])]) {
    requireValue(new Set(ids).size === ids.length, 'Starter pack identities must be unique.');
  }
  return pack;
}
export function parseLiveContext(input: unknown, limits: ValidationLimits): LiveContext {
  bound(input, limits);
  const row = record(input, ['schemaVersion', 'checkedAt', 'leagues', 'patchVersion']);
  requireValue(row.schemaVersion === 1, 'This live context version is unsupported.', 'UNSUPPORTED_VERSION');
  const leagues = record(row.leagues, ['evidenceId', 'entries']);
  return { schemaVersion: 1, checkedAt: time(row.checkedAt), leagues: { evidenceId: text(leagues.evidenceId),
    entries: list(leagues.entries, value => { const league = record(value, ['leagueId', 'realm']); return { leagueId: text(league.leagueId), realm: text(league.realm) }; }) },
    patchVersion: known(row.patchVersion, text) };
}
