import type { Hash, LeagueStamp, ObjectId, Revision, RevisionId, RevisionRef, RowVersion, TransactionId } from './stamp.js';

export type ObjectKind = 'build' | 'atlas' | 'filter' | 'timeline' | 'notes' | 'checklist';
export type ScopeKey = {
  leagueId: string;
  realm: string;
  mode: { economy: 'trade' | 'ssf'; hardcore: boolean; ruthless: boolean };
};
export type WorkspaceManifest = {
  schemaVersion: 1;
  stamp: LeagueStamp;
  activeScope: ScopeKey;
  catalogRevision: Hash;
  membership: Record<ObjectKind, ObjectId[]>;
  retainedScopes: ScopeKey[];
  transactionCheckpoint: TransactionId;
};
export type DocumentEnvelope<T, K extends ObjectKind = ObjectKind> = {
  schemaVersion: 1;
  objectId: ObjectId;
  kind: K;
  revision: Revision;
  payload: T;
};
export type EditCommand =
  | { kind: 'setTitle'; title: string }
  | { kind: 'replaceSnapshot'; snapshot: RevisionRef }
  | { kind: 'restoreRevision'; source: RevisionRef }
  | { kind: 'applyProposal'; proposalHash: Hash };
export type EditTransaction = {
  schemaVersion: 1;
  transactionId: TransactionId;
  parentTransactionId: TransactionId | null;
  branchId: string;
  before: RevisionRef;
  after: RevisionRef;
  commands: EditCommand[];
  stamp: LeagueStamp;
  createdAt: string;
  label: string;
};
export type RevisionCheckpoint = {
  schemaVersion: 1;
  transactionId: TransactionId;
  revision: RevisionRef;
  stamp: LeagueStamp;
};
export type WriteDocumentRequest<T> = {
  objectId: ObjectId;
  expectedRevisionId: RevisionId | null;
  payload: T;
  stamp: LeagueStamp;
  idempotencyKey: string;
};
export type WriteDocumentResponse = { revision: RevisionRef; rowVersion: RowVersion };
export type CopyProvenance = { source: RevisionRef; dataMode: 'source_data' | 'target_data' };
