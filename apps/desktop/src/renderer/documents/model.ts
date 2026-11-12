import type { EditTransaction, Known, LeagueStamp, ObjectId, PublishedRevisionRef, RevisionRef, SourceCredit, StepId, TransactionId } from '@pom/mastery-contracts';
import { tr } from '../i18n';

export type Art = { name: string; src?: string };
export type CardSummary =
  | { kind: 'build'; rows: string[] }
  | { kind: 'atlas'; stepId: StepId; stepName: string; points: Known<number>; steps: number; mechanics: Art[] }
  | { kind: 'timeline'; lanes: string[]; lastRun: string | null };
type CardBase = { title: string; stamp: LeagueStamp; art: Art; updatedAt: string; save: 'not_saved' | 'saved' | 'download_needed'; summary: CardSummary };
export type OwnedItem = CardBase & { ownership: 'owned'; objectId: ObjectId; source: RevisionRef; credit?: SourceCredit };
export type SharedItem = CardBase & { ownership: 'saved' | 'public' | 'starter'; source: PublishedRevisionRef; creator: string; votes: number; finishes: { finalTriggerObserved: number; playerConfirmed: number }; credit?: SourceCredit };
export type ItemCardModel = OwnedItem | SharedItem;
export type LocalSaveState = { status: 'saved' | 'saving' } | { status: 'failed'; safeReason: string };
export type SyncState = 'local' | 'signed_out' | 'offline' | 'syncing' | 'synced' | 'conflict';
export function knownLabel<T>(value: Known<T>, display: (value: T) => string = String): string {
  return value.status === 'known' ? display(value.value) : tr('documents_model_2.unknown');
}
export function stampLines(stamp: LeagueStamp): string[] {
  return [
    tr('documents_model_2.saved_for', { leagueId: knownLabel(stamp.leagueId) }),
    tr('documents_model_2.realm', { realm: knownLabel(stamp.realm) }),
    tr('h_rA_doc.mode', { mode: knownLabel(stamp.mode, (m) => [m.economy === 'trade' ? tr('h_rA_doc.trade') : 'SSF', m.hardcore ? 'Hardcore' : '', m.ruthless ? 'Ruthless' : ''].filter(Boolean).join(', ')) }),
    tr('documents_model_2.patch', { patchVersion: knownLabel(stamp.patchVersion) }),
    tr('documents_model_2.source_data', { datasetVersion: knownLabel(stamp.datasetVersion) }),
  ];
}
export function saveLabel(state: LocalSaveState): string {
  return state.status === 'saved' ? tr('documents_model.saved_on_this_pc') : state.status === 'saving' ? tr('documents_model_2.saving') : tr('documents_model.save_failed');
}
export function syncLabel(state: SyncState): string {
  return { local: tr('documents_model.local_only'), signed_out: tr('documents_model.sign_in_to_sync'), offline: tr('documents_model.sync_offline'), syncing: tr('documents_model_2.syncing'), synced: tr('documents_model.synced_to_account'), conflict: tr('documents_model.two_versions_changed') }[state];
}
export type HistoryRow = { revision: RevisionRef; label: string; createdAt: string; summary: string };
export type HistoryModel =
  | { kind: 'edit'; current: RevisionRef; activeBranch: string; transactions: EditTransaction[]; canUndo: boolean; canRedo: boolean }
  | { kind: 'account'; current: RevisionRef; versions: HistoryRow[] };
export type HistorySelection = { revision: RevisionRef; transactionId: TransactionId | null; label: string; createdAt: string; branch: string | null };
export function historyRows(model: HistoryModel): HistorySelection[] {
  return model.kind === 'edit'
    ? model.transactions.map((t) => ({ revision: t.after, transactionId: t.transactionId, label: t.label, createdAt: t.createdAt, branch: t.branchId }))
    : model.versions.map((v) => ({ revision: v.revision, transactionId: null, label: v.label, createdAt: v.createdAt, branch: null }));
}
export type ConflictChoice = 'keep_both' | 'this_pc' | 'account';
export const DEFAULT_CONFLICT_CHOICE: ConflictChoice = 'keep_both';
export type VersionPreview = { revision: RevisionRef; title: string; timestamp: string; summary: string };
export type Compatibility = { targetAvailable: boolean; matched: Known<number>; missing: string[]; changed: Known<number>; unresolved: string[] };
export function defaultCopyMode(c: Compatibility): 'source_data' | 'target_data' {
  return c.targetAvailable && c.missing.length === 0 && c.unresolved.length === 0 && c.changed.status === 'known' && c.changed.value === 0 && c.matched.status === 'known' ? 'target_data' : 'source_data';
}
export function copyModeAllowed(c: Compatibility, mode: 'source_data' | 'target_data'): boolean {
  return mode === 'source_data' || c.targetAvailable && c.missing.length === 0 && c.unresolved.length === 0 && c.changed.status === 'known' && c.matched.status === 'known';
}
export function validName(value: string): boolean { return value.trim().length > 0 && Array.from(value.trim()).length <= 120; }
export type LifecycleAction = 'rename' | 'duplicate' | 'move' | 'delete' | 'edit_history' | 'account_history' | 'send' | 'share' | 'publish' | 'copy_league';
export type ItemAdapter<T> = { present: (value: T) => ItemCardModel; open: (value: T) => void; action: (value: T, action: LifecycleAction) => void };
