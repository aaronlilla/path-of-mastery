import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { leagueStampSchema, parseId, type Hash, type LeagueStamp, type ObjectId, type ScopeKey, type ValidationLimits } from '@pom/mastery-contracts';
import { hashBytes } from '../documents/blobs.js';
import { scopeFromStamp } from '../../shared/documents/compatibility.js';

export type LegacyKind = 'build' | 'filter' | 'wealth';
export type LegacyEntry = { kind: LegacyKind; legacyId: string; originalPath: string; stamp?: LeagueStamp };
export type LegacySidecar = {
  schemaVersion: 1;
  objectId: ObjectId;
  kind: LegacyKind;
  legacyId: string;
  originalPath: string;
  contentHash: Hash;
  stamp: LeagueStamp;
  storageScope: ScopeKey | null;
  attributedAt: string | null;
  compatibility: 'unverified';
};
export const legacyKey = (entry: LegacyEntry): string => JSON.stringify([entry.kind, entry.legacyId, entry.originalPath]);

export function unknownLegacyStamp(createdAt: string): LeagueStamp {
  const unknown = { status: 'unknown' as const, reason: 'Legacy file has no verified source stamp.' };
  return { leagueId: { ...unknown }, realm: { ...unknown }, mode: { ...unknown }, patchVersion: { ...unknown }, datasetVersion: { ...unknown }, createdAt };
}

export function validateLegacyEntry(entry: LegacyEntry): void {
  if (!['build', 'filter', 'wealth'].includes(entry.kind) || !entry.legacyId?.trim() || !isAbsolute(entry.originalPath)) throw new TypeError('Legacy index entry is invalid.');
}

/** Inventory adapters in main supply these paths. This reader never writes a legacy file. */
export async function inspectLegacy(entry: LegacyEntry, limits: ValidationLimits, createdAt: string): Promise<LegacySidecar> {
  validateLegacyEntry(entry);
  const info = await stat(entry.originalPath);
  if (!info.isFile() || info.size > limits.maxBytes) throw new TypeError('Legacy file exceeds the configured size limit.');
  const bytes = await readFile(entry.originalPath);
  if (bytes.length > limits.maxBytes) throw new TypeError('Legacy file exceeds the configured size limit.');
  const stamp = leagueStampSchema.parse(entry.stamp ?? unknownLegacyStamp(createdAt), limits);
  if (!stamp.ok) throw new TypeError('Legacy source stamp is invalid.');
  return {
    schemaVersion: 1, objectId: parseId('object', randomUUID()), kind: entry.kind, legacyId: entry.legacyId,
    originalPath: entry.originalPath, contentHash: hashBytes(bytes), stamp: structuredClone(stamp.value),
    storageScope: scopeFromStamp(stamp.value), attributedAt: null, compatibility: 'unverified',
  };
}
