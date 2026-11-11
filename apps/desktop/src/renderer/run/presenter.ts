// Pure presentation logic for the Run window. No React, no IPC, no scheduling: it only reads what the Run service
// already decided (RunView) and shapes it for the strip, panels and dialogs.
import type { Action, ActionId, FeedbackRequest, LaneType, Trigger } from '@pom/mastery-contracts';
import type { RunCommand, RunView } from '../../shared/run/types.js';
import type { WindowPreferences } from '../../shared/run/window.js';

export const LANE_ORDER: LaneType[] = ['build', 'atlas', 'filter', 'notes', 'checklist'];
export const LANE_LABEL: Record<LaneType, string> = { build: 'Build', atlas: 'Atlas', filter: 'Loot Filter', notes: 'Notes', checklist: 'Checklist' };
const LANE_SHORT: Record<LaneType, string> = { build: 'Build', atlas: 'Atlas', filter: 'Filter', notes: 'Note', checklist: 'Checklist' };
export const MAIN_TEXT = 26, SUPPORT_TEXT = 20;
export const CLICK_HINT = 'Click instruction rows/labels for Next. Right-click for Back.';

export type RunMeta = { title?: string; ownership?: 'owned' | 'public' };
export type LaneRow = {
  type: LaneType; label: string; range: string | null; firstAction: string; support: string; critical: boolean;
  actionIds: ActionId[]; moreInLane: number; unverified: boolean;
};
export type Layout = 'horizontal' | 'vertical';
export type StripModel = {
  title: string; league: string; game: string; guide: string; atlas: string | null; mode: string; modeKey: RunView['state']['mode'];
  acknowledges: string; lanes: LaneRow[]; queued: string | null; pending: number; hint: string; reviewing: boolean;
  catchUp: { passed: string; missed: number } | null; stepOf: string; empty: string | null; changed: boolean;
};

export function laneType(view: RunView, action: Action): LaneType {
  const dependency = view.snapshot.dependencies.find(d => d.ref.revisionId === action.sourceRevision.revisionId);
  return dependency?.snapshot.kind ?? 'notes';
}
export function actionsOf(view: RunView, ids: readonly ActionId[]): Action[] {
  return ids.map(id => view.snapshot.actions.find(a => a.actionId === id)).filter((a): a is Action => !!a);
}
export function triggerLabel(t: Trigger): string {
  switch (t.kind) {
    case 'level': return `Level ${t.level}`;
    case 'areaLevel': return `AreaLevel ${t.level}`;
    case 'zone': return `Zone ${t.zoneId}`;
    case 'quest': return `Quest ${t.questId}`;
    case 'firstMap': return 'First map';
    case 'atlasAllocated': return `Atlas points ${t.points}`;
    case 'manual': return `Step ${t.ordinal + 1}`;
  }
}
const known = <T,>(k: { status: string; value?: T }): T | null => (k.status === 'known' ? (k as { value: T }).value : null);
const levelOf = (t: Trigger) => (t.kind === 'level' ? t.level : null);

/** "Levels 5-11": from the shown bundle's level to just before the next bundle with a later level. */
export function levelRange(view: RunView): string | null {
  const from = levelOf(view.displayed.trigger);
  if (from === null) return null;
  const next = view.snapshot.bundles.map(b => levelOf(b.trigger)).filter((l): l is number => l !== null && l > from).sort((a, b) => a - b)[0];
  const to = next === undefined ? from : Math.max(from, next - 1);
  return to === from ? `Level ${from}` : `Levels ${from}-${to}`;
}
export function stepOf(view: RunView): string {
  const bundles = view.snapshot.bundles;
  const i = bundles.findIndex(b => b.bundleId === view.displayed.bundleId);
  return i < 0 ? '' : `Chunk ${i + 1}/${bundles.length}`;
}
export function leagueOf(view: RunView): string {
  const league = known(view.snapshot.stamp.leagueId);
  return league ?? 'League unknown';
}
export function resolveLayout(pref: WindowPreferences['orientation'], width: number, height: number): Layout {
  if (pref === 'vertical') return 'vertical';
  if (pref === 'horizontal') return 'horizontal';
  return width < height ? 'vertical' : 'horizontal';
}
export const textSizes = (prefs: Pick<WindowPreferences, 'textSize'>) => ({ main: prefs.textSize, support: SUPPORT_TEXT });
export function clampOpacity(value: number): number { return Number.isFinite(value) ? Math.min(1, Math.max(0.6, value)) : 0.95; }
/** Reference height of the horizontal strip: 144 for one lane, 220 for two, plus 52 per extra lane up to 376. Same numbers as main/run/window.ts. */
export function horizontalHeight(view: RunView): number {
  const lanes = Math.max(1, new Set(view.snapshot.actions.map(a => a.laneId)).size);
  return lanes === 1 ? 144 : Math.min(376, 220 + (lanes - 2) * 52);
}
export const WIDTH_BY_SIZE = { compact: 640, standard: 960, large: 1200 } as const;

export function laneRows(view: RunView): LaneRow[] {
  const actions = actionsOf(view, view.displayed.actionIds);
  const rows: LaneRow[] = [];
  const range = levelRange(view);
  for (const type of LANE_ORDER) {
    const own = actions.filter(a => laneType(view, a) === type);
    const first = own[0];
    if (!first) continue;
    rows.push({ type, label: LANE_LABEL[type], range: type === 'build' ? range : null, firstAction: first.instruction.firstAction,
      support: first.instruction.whenReady || first.instruction.details, critical: own.some(a => a.critical), actionIds: own.map(a => a.actionId),
      moreInLane: own.length - 1, unverified: first.requirements.length > 0 && !first.instruction.details });
  }
  return rows;
}
function queuedSeparately(view: RunView): string | null {
  const lanes = laneRows(view);
  if (lanes.length === 1 && lanes[0]!.type === 'atlas') return null;
  const bundles = view.snapshot.bundles;
  const i = bundles.findIndex(b => b.bundleId === view.displayed.bundleId);
  const later = bundles.slice(i + 1).find(b => b.trigger.kind === 'atlasAllocated');
  if (!later || later.trigger.kind !== 'atlasAllocated') return null;
  const a = known(view.state.observedProgress.atlas.allocatedCount);
  return `Queued separately: Atlas step at allocated points ${later.trigger.points}${a === null ? '' : ` (now ${a})`}`;
}
export function stripModel(view: RunView, meta: RunMeta = {}): StripModel {
  const lanes = laneRows(view);
  const p = view.state.observedProgress;
  const g = known(p.characterLevel), a = known(p.atlas.allocatedCount);
  const multi = lanes.length > 1;
  const names = lanes.map(l => LANE_SHORT[l.type]).join(' + ');
  const trigger = triggerLabel(view.displayed.trigger);
  const allReviewed = view.displayed.actionIds.length > 0 && view.displayed.actionIds.every(id => view.state.reviewed.some(r => r.actionId === id));
  const mode = view.state.mode === 'auto' ? 'Following game' : view.state.mode === 'paused' ? 'Paused' : 'Manual position';
  return {
    title: meta.title ?? view.title ?? 'Timeline', league: leagueOf(view),
    game: `Game ${g === null ? 'Unknown' : `Level ${g}`}`, guide: `Guide ${view.state.guideCursor.level}`,
    atlas: multi || lanes.some(l => l.type === 'atlas') ? `Allocated Atlas ${a === null ? 'Unknown' : a}` : null,
    mode, modeKey: view.state.mode,
    acknowledges: lanes.length ? `Next acknowledges: ${multi ? `${names} at ${trigger}` : `${lanes[0]!.label}; ${stepOf(view)}; ${trigger}`}` : 'Next is not available here.',
    lanes, queued: multi ? queuedSeparately(view) : null,
    pending: view.pendingCriticalActionIds.length, hint: CLICK_HINT,
    reviewing: allReviewed && !view.state.endedAt, stepOf: stepOf(view),
    catchUp: view.catchUp ? { passed: `You passed ${view.catchUp.passedChunkIds.length} ${view.catchUp.passedChunkIds.length === 1 ? 'chunk' : 'chunks'}.`, missed: view.catchUp.missedActionIds.length } : null,
    empty: lanes.length ? null : 'No change due', changed: false,
  };
}

// ---- Chrome vs instruction-surface input ----
export type PointerSurface = 'instruction' | 'chrome';
/** Left or side-forward = Next, right or side-back = Back. Middle button does nothing. */
export function buttonOf(button: number): 'next' | 'back' | null {
  if (button === 0 || button === 4) return 'next';
  if (button === 2 || button === 3) return 'back';
  return null;
}
/** Anything inside an element marked data-run-chrome never produces an instruction gesture. */
export function surfaceOf(target: { closest?(selector: string): unknown } | null): PointerSurface {
  return target && typeof target.closest === 'function' && target.closest('[data-run-chrome]') ? 'chrome' : 'instruction';
}
let counter = 0;
export const newId = (prefix: string) => `${prefix}:${Date.now().toString(36)}-${(counter++).toString(36)}`;
export function pointerDown(button: number, x: number, y: number, surface: PointerSurface, gestureId = newId('g')): { gestureId: string; command: RunCommand } | null {
  const b = buttonOf(button);
  if (!b || surface === 'chrome') return null;
  return { gestureId, command: { commandId: newId('c'), kind: 'pointerDown', gestureId, x, y, button: b, surface } };
}
export function pointerUp(gestureId: string, x: number, y: number, dragged: boolean): RunCommand {
  return { commandId: newId('c'), kind: 'pointerUp', gestureId, x, y, dragged };
}
/** Keys for the focused instruction surface. Repeats and text inputs are ignored. */
export function keyCommand(view: RunView, e: { key: string; repeat: boolean; shiftKey?: boolean; ctrlKey?: boolean }, inText: boolean): RunCommand | 'position' | 'log' | 'settings' | 'escape' | 'close' | null {
  if (inText) return e.key === 'Escape' ? 'escape' : null;
  if (e.repeat) return null;
  const id = newId('c');
  if (e.ctrlKey && e.key.toLowerCase() === 'w') return 'close';
  switch (e.key) {
    case ' ': case 'Enter': return { commandId: id, kind: 'next', bundleId: view.displayed.bundleId, presentationVersion: view.presentationVersion };
    case 'Backspace': case 'ArrowLeft': return { commandId: id, kind: 'back' };
    case 'F10': return e.shiftKey ? { commandId: id, kind: 'back' } : null;
    case 'p': case 'P': return { commandId: id, kind: view.state.mode === 'paused' ? 'resumePresentation' : 'pause' };
    case 'l': case 'L': return 'position';
    case 'g': case 'G': return 'log';
    case ',': return 'settings';
    case 'Escape': return 'escape';
  }
  return null;
}

// ---- position ----
/** Last bundle at or before the level; the first bundle when the level is earlier than everything. */
export function jumpTarget(view: RunView, level: number) {
  const bundles = view.snapshot.bundles;
  let best = bundles[0];
  for (const b of bundles) { const l = levelOf(b.trigger); if (l !== null && l <= level) best = b; }
  return best ?? null;
}
export function skippedIfJump(view: RunView, level: number): number {
  const target = jumpTarget(view, level);
  if (!target) return 0;
  const earlier = new Set(view.snapshot.bundles.slice(0, view.snapshot.bundles.findIndex(b => b.bundleId === target.bundleId)).flatMap(b => b.actionIds));
  return [...earlier].filter(id => !view.state.reviewed.some(r => r.actionId === id)).length;
}
export function jumpToMyLevel(view: RunView): { ok: true; command: RunCommand } | { ok: false; reason: string } {
  const g = known(view.state.observedProgress.characterLevel);
  if (g === null) return { ok: false, reason: 'Game level is unknown. Pick a level or set auto-follow.' };
  const target = jumpTarget(view, g);
  return target ? { ok: true, command: { commandId: newId('c'), kind: 'jump', bundleId: target.bundleId } } : { ok: false, reason: 'No step to jump to.' };
}
export const validLevel = (n: number) => Number.isInteger(n) && n >= 1 && n <= 100;

// ---- completion ----
export type CompletionModel = {
  title: 'Run complete' | 'Run ended'; summary: string; label: string; canConfirm: boolean; recorded: string | null; counting: string;
  total: number; reviewed: number; skipped: number; outstanding: number;
};
export function completionModel(view: RunView): CompletionModel {
  const total = view.snapshot.actions.length;
  const f = view.finish;
  const reviewed = f?.reviewedCount ?? view.state.reviewed.length;
  const skipped = f?.skippedCount ?? view.state.skippedActionIds.length;
  const outstanding = f?.outstandingCount ?? view.state.outstandingActionIds.length;
  const method = f?.finishMethod ?? view.receiptMethod;
  const complete = total > 0 && reviewed >= total;
  return {
    title: complete ? 'Run complete' : 'Run ended',
    summary: `Reviewed ${reviewed} actions. Skipped ${skipped}. Outstanding ${outstanding}.`,
    label: complete ? 'Every instruction was reviewed.' : method === 'final_trigger_observed' || method === 'player_confirmed' ? 'Partial coverage. Finish is recorded separately.' : 'Partial run.',
    // Only an explicit click records a manual finish. Reviewed coverage, Level 100 and votes never do.
    canConfirm: !!view.state.endedAt && !method && total > 0,
    recorded: method === 'final_trigger_observed' ? 'Finish recorded from your game log.' : method === 'player_confirmed' ? 'Finish confirmed by you.' : null,
    counting: view.countRuns ? 'Counting enabled' : 'Counting off', total, reviewed, skipped, outstanding,
  };
}

// ---- feedback ----
export const FEEDBACK_REASONS = [
  { value: 'unclear', label: 'Instructions were unclear' }, { value: 'unavailable', label: 'Item or gem unavailable' },
  { value: 'timing', label: 'Timing was wrong' }, { value: 'other', label: 'Something else' },
] as const;
export type FeedbackReason = typeof FEEDBACK_REASONS[number]['value'];
export type FeedbackForm = { reason: FeedbackReason | null; details: string; allowReplies: boolean; actionId: ActionId | null };
export const FEEDBACK_MAX = 2000;
export const emptyFeedback = (actionId: ActionId | null): FeedbackForm => ({ reason: null, details: '', allowReplies: true, actionId });
export function feedbackProblem(f: FeedbackForm): string | null {
  if (!f.actionId) return 'Pick the step that did not work.';
  if (!f.reason) return 'Pick what happened.';
  if (f.reason === 'other' && !f.details.trim()) return 'Describe what happened.';
  if (f.details.length > FEEDBACK_MAX) return `Details can be up to ${FEEDBACK_MAX} characters.`;
  return null;
}
/** Exactly the pinned IDs plus the typed text. No character name, log path, Run ID or position. */
export function feedbackRequest(view: RunView, f: FeedbackForm, idempotencyKey: string): FeedbackRequest | null {
  const pin = view.snapshot.publishedOrigin, action = view.snapshot.actions.find(a => a.actionId === f.actionId);
  if (!pin || !action || feedbackProblem(f)) return null;
  return { publishedRevision: structuredClone(pin), clipId: action.clipId, actionId: action.actionId, reason: f.reason!, text: f.details.trim(), idempotencyKey };
}
/** Private draft kept on this device only until Send or Save. Never leaves via the Run bridge. */
export const FEEDBACK_DRAFT_KEY = 'pom.run.feedbackDraft.v1';
export function saveDraft(storage: Pick<Storage, 'setItem' | 'removeItem'> | null, f: FeedbackForm): void {
  try { if (!storage) return; if (!f.reason && !f.details) storage.removeItem(FEEDBACK_DRAFT_KEY); else storage.setItem(FEEDBACK_DRAFT_KEY, JSON.stringify(f)); } catch { /* draft is a convenience */ }
}
export function loadDraft(storage: Pick<Storage, 'getItem'> | null, actionId: ActionId | null): FeedbackForm {
  try {
    const raw = storage?.getItem(FEEDBACK_DRAFT_KEY);
    if (raw) {
      const d = JSON.parse(raw) as FeedbackForm;
      if (d && typeof d.details === 'string' && d.details.length <= FEEDBACK_MAX) return { ...emptyFeedback(actionId), ...d, actionId: d.actionId ?? actionId };
    }
  } catch { /* fall through */ }
  return emptyFeedback(actionId);
}
export function clearDraft(storage: Pick<Storage, 'removeItem'> | null): void { try { storage?.removeItem(FEEDBACK_DRAFT_KEY); } catch { /* ignore */ } }

// ---- log status labels ----
export function logStatus(state: { reading: boolean; filename: string | null; telemetry: { context: { state: string }; observed: { observedAt: string | null } } } | null): string {
  if (!state || !state.filename) return 'Not set';
  if (!state.reading) return 'Not set';
  return state.telemetry.observed.observedAt ? 'Reading' : 'Waiting for events';
}
