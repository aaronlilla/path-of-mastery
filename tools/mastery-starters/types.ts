import type { AtlasDataset, Hash, Known, LeagueStamp, LocalBuildSource, RevisionRef, TimelineBundle, ValidationLimits } from '@pom/mastery-contracts';

export type SourceEvidence = {
  evidenceId: string;
  url: string;
  fetchedAt: string;
  contentHash: Hash;
  claim: string;
  verification: Known<'checked'>;
};
export type ContentReview = {
  reviewer: string;
  checkedAt: string;
  contentHash: Hash;
  scope: LeagueStamp;
  evidenceIds: string[];
  decision: 'checked' | 'unverified';
  reason: string;
};
export type StarterContent = {
  starterId: string;
  creatorName: string;
  budget: 'not_stated' | 'cheap' | 'medium' | 'expensive';
  playstyles: ('melee' | 'ranged' | 'minion' | 'caster')[];
  timelineRef: RevisionRef;
  bundle: TimelineBundle;
  localBuilds: { source: RevisionRef; snapshot: LocalBuildSource }[];
  datasets: AtlasDataset[];
  evidenceIds: string[];
};
export type StarterEntry = StarterContent & { review: ContentReview | null };
export type StarterPack = {
  schemaVersion: 1;
  packId: string;
  createdAt: string;
  sources: SourceEvidence[];
  blobs: Hash[];
  entries: StarterEntry[];
};
export type LiveContext = {
  schemaVersion: 1;
  checkedAt: string;
  leagues: { evidenceId: string; entries: { leagueId: string; realm: string }[] };
  patchVersion: Known<string>;
};
export type PackPolicy = { limits: ValidationLimits; maxBlobBytes: number; maxTotalBlobBytes: number; maxEvidenceAgeMs: number };
export type BlobReader = (hash: Hash) => Promise<Uint8Array>;
export type StarterQualification = { starterId: string; status: 'qualified' | 'unverified' | 'archive'; blockers: string[] };
export type QualificationReport = { schemaVersion: 1; packHash: Hash; checkedAt: string; qualified: boolean; blockers: string[]; entries: StarterQualification[] };
