import { parseId, type AtlasPlan, type DatasetRef, type EditTransaction, type LeagueStamp, type ObjectId, type RevisionRef, type StepId, type TransactionId, type ValidationLimits, type WriteDocumentRequest } from '@pom/mastery-contracts';
import type { AtlasDocumentView } from '../../../main/atlas/service.js';
import type { ImportResult } from '../../../main/atlas/formats.js';
import type { ExportOptions, SnapshotInput } from '../../../shared/atlas/codecs/pom.js';
import type { CanvasModel, View } from '../canvas/model.js';
import { editLabel, editPlan, stepAfterRemoval, stepIds, type Edit, type LibraryTab, type PracticalTab, type Sort } from './presenter.js';
import { TextEditGroup } from '../../../shared/documents/history.js';

export type EditorHistory = { events: EditTransaction[]; cursor: TransactionId; tip: TransactionId };
export type EditorRecord = { view: AtlasDocumentView; source: RevisionRef; history: EditorHistory; canvas?: CanvasModel; ownership: 'owned' | 'saved'; folderId: string | null; lastOpenedAt: string; deletedAt: string | null; recovery?: AtlasPlan };
export type AvailableData = { dataset: DatasetRef; stamp: LeagueStamp; budget: number; qualified: boolean; active: boolean };
export interface AtlasEditorPort {
  list(): Promise<EditorRecord[]>;
  read(id: ObjectId, revision?: RevisionRef['revisionId']): Promise<EditorRecord>;
  save(request: WriteDocumentRequest<AtlasPlan>, label: string): Promise<EditorRecord>;
  create(plan: AtlasPlan, label: string): Promise<EditorRecord>;
  undo(id: ObjectId, source: RevisionRef): Promise<EditorRecord>;
  redo(id: ObjectId, source: RevisionRef): Promise<EditorRecord>;
  restore(id: ObjectId, source: RevisionRef, revision: RevisionRef): Promise<EditorRecord>;
  preview(id: ObjectId, transaction: TransactionId): Promise<EditorRecord>;
  trash(id: ObjectId): Promise<void>;
  restoreTrash(id: ObjectId): Promise<void>;
  move(id: ObjectId, folderId: string | null): Promise<void>;
  createFolder(name: string): Promise<void>;
  exportRecovery(plan: AtlasPlan): Promise<void>;
  parse(input: string, signal: AbortSignal): Promise<ImportResult>;
  importNew(result: Extract<ImportResult, { kind: 'snapshot' }>): Promise<EditorRecord>;
  exportFile(input: SnapshotInput, options: Omit<ExportOptions, 'destination'>): Promise<void>;
  share(input: SnapshotInput, options: Omit<ExportOptions, 'destination'>, signal: AbortSignal): Promise<string>;
  stageRecovery?(request: WriteDocumentRequest<AtlasPlan>, label: string): Promise<void>;
}
export type EditorState = {
  record: EditorRecord | null; plan: AtlasPlan | null; selected: StepId | null; preview: EditorRecord | null;
  save: 'saved' | 'saving' | 'failed'; error: string | null; loading: boolean; previewLoading: boolean;
  library: EditorRecord[]; libraryTab: LibraryTab; query: string; sort: Sort; view: 'grid' | 'list';
  tab: PracticalTab; panel: 'steps' | 'diff' | 'compare' | 'history' | null; viewports: Record<string, View>; scrolls: Record<string, number>; selectedByObject: Record<string, StepId>;
};
export class AtlasEditorSession {
  state: EditorState = { record: null, plan: null, selected: null, preview: null, save: 'saved', error: null, loading: false, previewLoading: false,
    library: [], libraryTab: 'My plans', query: '', sort: 'Last opened', view: 'grid', tab: 'Stats', panel: null, viewports: {}, scrolls: {}, selectedByObject: {} };
  private listeners = new Set<() => void>();
  private tail: Promise<void> = Promise.resolve();
  private text = new TextEditGroup<AtlasPlan>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private previewGeneration = 0;
  private operationGeneration = 0;
  private previewPending = false;
  constructor(readonly port: AtlasEditorPort, readonly limits: ValidationLimits, readonly uuid = () => crypto.randomUUID()) {}
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  snapshot = () => this.state;
  update(patch: Partial<EditorState>) { this.state = { ...this.state, ...patch }; this.listeners.forEach(fn => fn()); }
  stepId() { return parseId('step', `step:${this.uuid()}`); }
  async refresh() { try { this.update({ library: await this.port.list(), error: null }); } catch { this.update({ error: 'Could not load atlas plans. Retry.' }); } }
  async open(id: ObjectId) {
    await this.flush();
    if (this.state.save === 'failed') return;
    const generation = ++this.operationGeneration;
    this.returnCurrent(); this.update({ loading: true, error: null });
    try { const record = await this.port.read(id); if (generation === this.operationGeneration) this.adopt(record); }
    catch { if (generation === this.operationGeneration) this.update({ loading: false, error: 'Could not open atlas plan. Retry.' }); }
  }
  adopt(record: EditorRecord) {
    const retained = this.state.selectedByObject[record.source.objectId];
    const selected = this.state.record?.source.objectId === record.source.objectId && this.state.selected && record.view.document.payload.stepsById[this.state.selected] ? this.state.selected : retained && record.view.document.payload.stepsById[retained] ? retained : stepIds(record.view.document.payload)[0] ?? null;
    this.update({ record, plan: structuredClone(record.recovery ?? record.view.document.payload), selected, save: record.recovery ? 'failed' : 'saved', loading: false, preview: null, error: record.recovery ? 'Your latest changes are not saved.' : null, panel: null });
  }
  async create(plan: AtlasPlan, label = 'Created plan') {
    await this.flush(); if (this.state.save === 'failed') return;
    this.update({ loading: true });
    try { this.adopt(await this.port.create(plan, label)); await this.refresh(); }
    catch { this.update({ loading: false, error: 'Could not create atlas plan. Retry.' }); }
  }
  edit(edit: Edit, text = false) {
    const { plan, record, preview } = this.state;
    if (!plan || !record || preview || this.previewPending || record.ownership !== 'owned') { this.update({ error: preview || this.previewPending ? 'Preview only. Your current plan is unchanged.' : 'Read-only preview. Edit a copy to change this plan.' }); return; }
    if (!text) this.flushText();
    try {
      const next = editPlan(this.state.plan!, edit, this.limits, record.canvas?.graph);
      const selected = this.state.selected ? stepAfterRemoval(plan, next, this.state.selected) : stepIds(next)[0]!;
      this.update({ plan: next, selected, save: this.state.save === 'failed' ? 'failed' : 'saving', error: null });
      if (text) {
        const ready = this.text.push(plan, next, Date.now()); if (ready) this.enqueue(ready.after, editLabel(edit));
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => this.flushText(), 500);
      } else this.enqueue(next, editLabel(edit));
    } catch (error) { this.update({ error: error instanceof Error ? error.message : 'Could not edit atlas plan. Retry.' }); }
  }
  replacePlan(plan: AtlasPlan, label: string) {
    if (!this.state.record || this.state.preview || this.previewPending || this.state.record.ownership !== 'owned') return;
    this.flushText(); this.update({ plan: structuredClone(plan), save: this.state.save === 'failed' ? 'failed' : 'saving' }); this.enqueue(plan, label);
  }
  private enqueue(plan: AtlasPlan, label: string) {
    const key = this.uuid();
    this.tail = this.tail.then(async () => {
      if (!this.state.record) return;
      if (this.state.save === 'failed') { await this.stageRecovery(); return; }
      const source = this.state.record.source;
      try {
        const record = await this.port.save({ objectId: source.objectId, expectedRevisionId: source.revisionId, payload: plan, stamp: plan.stamp, idempotencyKey: key }, label);
        const latest = JSON.stringify(this.state.plan) === JSON.stringify(plan);
        this.update({ record, plan: latest ? structuredClone(record.view.document.payload) : this.state.plan, save: latest ? 'saved' : 'saving' });
      } catch { this.update({ save: 'failed', error: 'Could not save atlas plan. Your latest changes are not saved.' }); await this.stageRecovery(); }
    });
  }
  private async stageRecovery() {
    const { record, plan } = this.state; if (!record || !plan || !this.port.stageRecovery) return;
    try { await this.port.stageRecovery({ objectId: record.source.objectId, expectedRevisionId: record.source.revisionId, payload: plan, stamp: plan.stamp, idempotencyKey: this.uuid() }, 'Recovered changes'); }
    catch { this.update({ error: 'Could not save recovery draft. Export recovery file to keep your latest changes.' }); }
  }
  flushText() {
    if (this.timer) clearTimeout(this.timer); this.timer = null;
    const ready = this.text.flush(Date.now(), true); if (ready) this.enqueue(ready.after, 'Changed text');
  }
  async flush() { this.flushText(); await this.tail; }
  async retry() {
    await this.flush(); const { plan, record } = this.state; if (!plan || !record) return;
    // A changed pending snapshot needs a fresh idempotency key. Retry reads current first after an uncertain receipt.
    try {
      const current = await this.port.read(record.source.objectId);
      if (JSON.stringify(current.view.document.payload) === JSON.stringify(plan)) { this.update({ record: current, save: 'saved', error: null }); return; }
      if (current.source.revisionId !== record.source.revisionId) { this.update({ error: 'Two versions changed.' }); return; }
      const result = await this.port.save({ objectId: record.source.objectId, expectedRevisionId: record.source.revisionId, payload: plan, stamp: plan.stamp, idempotencyKey: this.uuid() }, 'Recovered changes');
      this.update({ record: result, save: 'saved', error: null });
    } catch { this.update({ save: 'failed', error: 'Could not save atlas plan. Your latest changes are not saved.' }); }
  }
  async historyAction(kind: 'undo' | 'redo', revision?: RevisionRef) {
    await this.flush(); const { record, preview } = this.state;
    if (!record || preview || this.previewPending || this.state.save !== 'saved') return;
    try { const result = revision ? await this.port.restore(record.source.objectId, record.source, revision) : await this.port[kind](record.source.objectId, record.source);
      const panel = this.state.panel; this.adopt(result); this.update({ panel }); }
    catch { this.update({ error: 'Could not change edit history. Retry.' }); }
  }
  async preview(transaction: TransactionId) {
    await this.flush(); if (!this.state.record || this.state.save !== 'saved') return;
    const generation = ++this.previewGeneration, objectId = this.state.record.source.objectId;
    this.previewPending = true;
    this.update({ previewLoading: true });
    try { const preview = await this.port.preview(objectId, transaction); if (generation === this.previewGeneration) this.update({ preview }); }
    catch { if (generation === this.previewGeneration) this.update({ error: 'Could not load revision. Retry.' }); }
    finally { if (generation === this.previewGeneration) { this.previewPending = false; this.update({ previewLoading: false }); } }
  }
  returnCurrent() { this.previewGeneration++; this.previewPending = false; if (this.state.preview || this.state.previewLoading) this.update({ preview: null, previewLoading: false }); }
  async restorePreview() {
    const revision = this.state.preview?.source; if (!revision) return;
    this.returnCurrent(); await this.historyAction('undo', revision);
  }
  select(stepId: StepId) { if (this.state.plan?.stepsById[stepId] && this.state.record) this.update({ selected: stepId, selectedByObject: { ...this.state.selectedByObject, [this.state.record.source.objectId]: stepId } }); }
  async back() { await this.flush(); if (this.state.save === 'failed') return false; this.returnCurrent(); this.update({ record: null, plan: null, selected: null, panel: null }); await this.refresh(); return true; }
  async recoveryExport() { if (this.state.plan) await this.port.exportRecovery(structuredClone(this.state.plan)); }
  get canUndo() { const h = this.state.record?.history, event = h?.events.find(e => e.transactionId === h.cursor); return !!event && event.parentTransactionId !== null && !this.state.preview; }
  get canRedo() { const h = this.state.record?.history; return !!h && h.cursor !== h.tip && !this.state.preview; }
  dispose() { this.flushText(); this.returnCurrent(); this.listeners.clear(); }
}
