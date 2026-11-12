export const SCHEMA_VERSION = 1 as const;
declare const identity: unique symbol;
export type Id<K extends string> = string & { readonly [identity]: K };
export type ObjectId = Id<'object'>;
export type RevisionId = Id<'revision'>;
export type PostId = Id<'post'>;
export type PublicId = Id<'public'>;
export type RunId = Id<'run'>;
export type ActionId = Id<'action'>;
export type BundleId = Id<'bundle'>;
export type StepId = Id<'step'>;
export type LaneId = Id<'lane'>;
export type ClipId = Id<'clip'>;
export type OptionId = Id<'option'>;
export type TransactionId = Id<'transaction'>;
export type Hash = Id<'hash'>;
export type RowVersion = number & { readonly [identity]: 'rowVersion' };
export type DisplayRevision = number & { readonly [identity]: 'displayRevision' };
export type IdentityKind = 'object' | 'revision' | 'post' | 'public' | 'run' | 'action'
  | 'bundle' | 'step' | 'lane' | 'clip' | 'option' | 'transaction' | 'hash';

export function isId<K extends IdentityKind>(kind: K, value: unknown): value is Id<K> {
  if (typeof value !== 'string' || value.trim() !== value) return false;
  if (kind === 'hash') return /^[a-f0-9]{64}$/.test(value);
  if (['object', 'revision', 'post', 'public', 'run', 'transaction'].includes(kind)) {
    return /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
  }
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

export function parseId<K extends IdentityKind>(kind: K, value: string): Id<K> {
  if (!isId(kind, value)) throw new TypeError(`Invalid ${kind} ID.`);
  return value;
}

export type Known<T> = { status: 'known'; value: T; evidenceId: string }
  | { status: 'unknown'; reason: string };
export type LeagueMode = { economy: 'trade' | 'ssf'; hardcore: boolean; ruthless: boolean };
export type LeagueStamp = {
  leagueId: Known<string>;
  realm: Known<string>;
  mode: Known<LeagueMode>;
  patchVersion: Known<string>;
  datasetVersion: Known<string>;
  createdAt: string;
};
export type RevisionRef = {
  objectId: ObjectId;
  revisionId: RevisionId;
  payloadHash: Hash;
  stamp: LeagueStamp;
  fallbackSnapshotHash: Hash;
};
export type Revision = {
  revisionId: RevisionId;
  parentRevisionId: RevisionId | null;
  schemaVersion: typeof SCHEMA_VERSION;
  payloadHash: Hash;
  stamp: LeagueStamp;
};
export type PublishedRevisionRef = {
  postId: PostId;
  revisionId: RevisionId;
  displayRevision: DisplayRevision;
};
export type SourceCredit = {
  source: RevisionRef;
  origin: PublishedRevisionRef | null;
  creatorName: string;
  title: string;
  status: 'available' | 'original_removed';
};
