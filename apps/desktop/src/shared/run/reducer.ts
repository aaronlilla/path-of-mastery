import type { Action, ActionId, Hash, RunSnapshot, ScheduledBundle, TimelineBundle } from '@pom/mastery-contracts';
import { emptyObserved } from '../journey/telemetry.js';
import { acknowledgeBundle, criticalOverflow, dueBundles, emptyLedger, observeSchedule, previewGroups,
  unreviewedActions, type Schedule, type TriggerObservation } from '../timelines/scheduler/index.js';
import { acceptsRelease } from './input.js';
import type { RunCommand, RunSession, RunView } from './types.js';

export function createSession(snapshot: RunSnapshot, schedule: Schedule, hash: Hash, at: string, sourceBundle: TimelineBundle): RunSession {
  const displayed = schedule.groups[0];
  if (!displayed || !schedule.actions.length) throw new Error('This timeline has no active instructions.');
  const session: RunSession = { snapshot: structuredClone(snapshot), schedule: structuredClone(schedule),
    state: { schemaVersion: 1, runId: snapshot.runId, stamp: snapshot.stamp, snapshotHash: hash,
      guideCursor: { bundleId: displayed.bundleId, level: displayed.trigger.kind === 'level' ? displayed.trigger.level : 1 },
      observedProgress: emptyObserved(), mode: 'manual', presentedBundleIds: [displayed.bundleId], reviewed: [],
      skippedActionIds: [], outstandingActionIds: snapshot.actions.map(action => action.actionId), commandCursor: 0,
      eventCursor: null, startedAt: at, endedAt: null },
    displayed: structuredClone(displayed), presentationVersion: 1, history: [structuredClone(displayed)], historyIndex: 0,
    ledger: emptyLedger(), commands: [], lastNextAt: null, gesture: null, detailsOpen: false, catchUp: null, finish: null, retainedHashes: [],
    sourceBundle: structuredClone(sourceBundle), autoReceiptConsumed: false, receiptMethod: null };
  return session;
}

export function runView(session: RunSession, countRuns = session.snapshot.settings.countRuns): RunView {
  const { snapshot, state, displayed, presentationVersion, detailsOpen, catchUp, finish, receiptMethod } = session;
  const first = new Map(snapshot.actions.map(a => [a.actionId, a.instruction.firstAction] as const));
  const chunks = snapshot.bundles.map(b => ({ bundleId: b.bundleId as string, label: first.get(b.actionIds[0]!) ?? '' }));
  return structuredClone({ snapshot, state, displayed, presentationVersion, detailsOpen, catchUp, finish, receiptMethod, countRuns,
    title: session.sourceBundle.timeline.title, chunks,
    pendingCriticalActionIds: pendingCritical(session) });
}
/** Critical actions the player has reached but not reviewed. An action counts once its own coordinate was reached: its chunk was shown,
 *  it was passed in a catch-up, or observed progress passed its trigger (character level or allocated Atlas points; each coordinate on its own).
 *  Steps nobody has reached yet are not pending ("Missed actions 0" at the start). */
function pendingCritical(session: RunSession): ActionId[] {
  const { schedule, state, displayed, catchUp } = session;
  // Reached = shown, confirmed by the scheduler's own ledger (any coordinate: level, First map, Atlas points), or skipped past by a jump.
  const confirmed = new Set<string>(session.ledger.confirmations.map(c => c.groupId));
  const shownIds = new Set<ActionId>(schedule.groups.filter(g => g.bundleId === displayed.bundleId || state.presentedBundleIds.includes(g.bundleId) || confirmed.has(g.bundleId)).flatMap(g => g.actionIds));
  for (const id of state.skippedActionIds) shownIds.add(id);
  for (const id of catchUp?.missedActionIds ?? []) shownIds.add(id);
  const level = state.observedProgress.characterLevel, points = state.observedProgress.atlas.allocatedCount;
  const reached = (action: Action): boolean => {
    if (shownIds.has(action.actionId)) return true;
    const t = action.trigger;
    if (t.kind === 'level') return level.status === 'known' && t.level <= level.value;
    if (t.kind === 'atlasAllocated') return points.status === 'known' && t.points <= points.value;
    return false;
  };
  return criticalOverflow(schedule, state.reviewed, displayed.actionIds).filter(reached).map(action => action.actionId);
}
function present(s: RunSession, bundle: ScheduledBundle, historyIndex?: number): void {
  if (s.displayed.bundleId === bundle.bundleId && historyIndex === undefined) return;
  s.displayed = structuredClone(bundle); s.presentationVersion++;
  s.state.guideCursor.bundleId = bundle.bundleId;
  if (bundle.trigger.kind === 'level') s.state.guideCursor.level = bundle.trigger.level;
  if (!s.state.presentedBundleIds.includes(bundle.bundleId)) s.state.presentedBundleIds.push(bundle.bundleId);
  if (historyIndex !== undefined) s.historyIndex = historyIndex;
  else { s.history.push(structuredClone(bundle)); s.historyIndex = s.history.length - 1; }
}
function coverage(s: RunSession): void {
  s.state.outstandingActionIds = unreviewedActions(s.schedule, s.state.reviewed)
    .filter(action => action.critical || !s.state.skippedActionIds.includes(action.actionId)).map(action => action.actionId);
  s.state.skippedActionIds = s.state.skippedActionIds.filter(id => !s.state.reviewed.some(action => action.actionId === id));
  if (s.finish) s.finish = { ...s.finish, reviewedCount: s.state.reviewed.length, skippedCount: s.state.skippedActionIds.length,
    outstandingCount: s.state.outstandingActionIds.length };
}
export function endSession(s: RunSession, at: string): void {
  s.state.endedAt = at; s.state.mode = 'paused'; s.gesture = null;
  s.finish = { schemaVersion: 1, runId: s.snapshot.runId, stamp: s.snapshot.stamp, reviewedCount: s.state.reviewed.length,
    skippedCount: s.state.skippedActionIds.length, outstandingCount: s.state.outstandingActionIds.length,
    finishMethod: s.finish?.finishMethod ?? s.receiptMethod, endedAt: at };
}
function review(s: RunSession, ids: readonly ActionId[]): void {
  for (const id of ids) {
    const action = s.schedule.actions.find(action => action.actionId === id);
    if (!action) throw new Error('The instruction is not in this Run.');
    if (!s.state.reviewed.some(record => record.actionId === id && record.contentHash === action.contentHash))
      s.state.reviewed.push({ actionId: id, contentHash: action.contentHash });
  }
  coverage(s);
}
async function next(s: RunSession, bundleId: string, version: number, at: number, repeat = false): Promise<void> {
  if (repeat || s.displayed.bundleId !== bundleId || s.presentationVersion !== version ||
    s.lastNextAt !== null && at - s.lastNextAt < 250) return;
  s.lastNextAt = at; s.state.mode = 'manual'; s.catchUp = null;
  const records = await acknowledgeBundle(s.displayed, s.schedule);
  review(s, records.map(record => record.actionId));
  const final = s.schedule.groups.at(-1)!;
  if (final.actionIds.every(id => s.displayed.actionIds.includes(id))) { endSession(s, new Date(at).toISOString()); return; }
  if (s.historyIndex < s.history.length - 1) { present(s, s.history[s.historyIndex + 1]!, s.historyIndex + 1); return; }
  const due = await dueBundles(s.schedule, s.ledger, s.state.reviewed);
  const previews = previewGroups(s.schedule, s.state.observedProgress.firstMap.status === 'known', s.state.reviewed);
  const skipped = new Set(s.state.skippedActionIds);
  const target = due.find(bundle => bundle.actionIds.some(id => !skipped.has(id))) ??
    previews.find(bundle => bundle.actionIds.some(id => !skipped.has(id)));
  if (target) present(s, target);
}
function back(s: RunSession): void {
  s.state.mode = 'manual'; s.catchUp = null;
  if (s.historyIndex > 0) present(s, s.history[s.historyIndex - 1]!, s.historyIndex - 1);
}

export async function reconcile(s: RunSession): Promise<void> {
  if (s.state.mode !== 'auto' || s.gesture || s.detailsOpen || s.state.endedAt) return;
  const due = (await dueBundles(s.schedule, s.ledger, s.state.reviewed)).filter(bundle => bundle.trigger.kind !== 'atlasAllocated' ||
    s.state.observedProgress.atlas.allocatedCount.status === 'known' && s.state.observedProgress.atlas.coverage !== 'gap');
  const target = due.at(-1);
  if (!target || target.bundleId === s.displayed.bundleId) { s.catchUp = null; return; }
  const displayedChunks = s.schedule.chunks.filter(chunk => chunk.actionIds.some(id => s.displayed.actionIds.includes(id))).map(chunk => chunk.chunkId);
  const passedChunkIds = [...new Set(due.filter(bundle => bundle.bundleId !== target.bundleId).flatMap(bundle => bundle.chunkIds))]
    .filter(id => !displayedChunks.includes(id));
  if (passedChunkIds.length) {
    s.catchUp = { target, passedChunkIds, missedActionIds: due.filter(bundle => bundle.bundleId !== target.bundleId).flatMap(bundle => bundle.actionIds)
      .filter(id => !s.state.reviewed.some(record => record.actionId === id)) };
  } else { s.catchUp = null; present(s, target); }
}

export async function applyCommand(previous: RunSession, command: RunCommand, at: number): Promise<RunSession> {
  const s = structuredClone(previous);
  switch (command.kind) {
    case 'pointerDown':
      if (command.surface === 'instruction' && !s.gesture && !s.detailsOpen && !s.state.endedAt) s.gesture = {
        gestureId: command.gestureId, x: command.x, y: command.y, button: command.button,
        bundleId: s.displayed.bundleId, presentationVersion: s.presentationVersion };
      break;
    case 'pointerUp': {
      const gesture = s.gesture;
      if (!gesture || gesture.gestureId !== command.gestureId) break;
      s.gesture = null;
      if (acceptsRelease(gesture, command)) {
        if (gesture.button === 'next') await next(s, gesture.bundleId, gesture.presentationVersion, at);
        else back(s);
      }
      await reconcile(s); break;
    }
    case 'cancelPointer': s.gesture = null; await reconcile(s); break;
    case 'next': if (!s.gesture) await next(s, command.bundleId, command.presentationVersion, at, command.repeat); break;
    case 'back': s.gesture = null; back(s); break;
    case 'manual': s.gesture = null; s.catchUp = null; s.state.mode = 'manual'; break;
    case 'jump': {
      const target = s.schedule.groups.find(group => group.bundleId === command.bundleId);
      if (!target) throw new Error('The position is not in this Run.');
      const earlier = s.schedule.groups.slice(0, s.schedule.groups.indexOf(target)).flatMap(group => group.actionIds);
      s.state.skippedActionIds = [...new Set([...s.state.skippedActionIds, ...earlier])]; coverage(s);
      s.gesture = null; s.state.mode = 'manual'; s.catchUp = null; present(s, target); break;
    }
    case 'follow': s.state.mode = 'auto'; s.state.endedAt = null; s.finish = null; await reconcile(s); break;
    case 'pause':
      if (s.state.mode !== 'paused') s.modeBeforePause = s.state.mode;
      s.state.mode = 'paused'; s.gesture = null; break;
    case 'resumePresentation':
      if (s.state.mode === 'paused' && !s.state.endedAt) {
        s.state.mode = s.modeBeforePause ?? 'manual'; await reconcile(s);
      }
      break;
    case 'openDetails': s.detailsOpen = true; s.gesture = null; break;
    case 'closeDetails': s.detailsOpen = false; await reconcile(s); break;
    case 'catchUp':
      if (s.catchUp) {
        if (command.choice === 'catch_up') { present(s, s.catchUp.target); s.state.mode = 'auto'; }
        else if (command.choice === 'keep') s.state.mode = 'manual';
        else { s.detailsOpen = true; }
        s.catchUp = null;
      }
      break;
    case 'review': review(s, command.actionIds); break;
    case 'skip':
      if (command.actionIds.some(id => !s.schedule.actions.some(action => action.actionId === id))) throw new Error('The instruction is not in this Run.');
      s.state.skippedActionIds = [...new Set([...s.state.skippedActionIds, ...command.actionIds])]; coverage(s); break;
    case 'finish': endSession(s, new Date(at).toISOString()); break;
    case 'confirmFinished': endSession(s, new Date(at).toISOString()); s.finish!.finishMethod = 'player_confirmed'; break;
  }
  s.state.commandCursor++;
  return s;
}

export async function applyObservations(s: RunSession, observations: readonly TriggerObservation[]): Promise<RunSession> {
  const next = structuredClone(s);
  next.ledger = observeSchedule(next.schedule, next.ledger, observations);
  for (const event of observations.filter(event => !s.ledger.seenEventIds.includes(event.eventId))) {
    if (!event.reliable || !event.continuous || !event.selectedContext) { next.state.mode = 'manual'; continue; }
    if (event.method === 'seed' || event.method === 'manual' && event.trigger.kind !== 'firstMap') continue;
    const p = next.state.observedProgress, known = <T>(value: T) => ({ status: 'known' as const, value, evidenceId: event.eventId });
    switch (event.trigger.kind) {
      case 'level': p.characterLevel = known(event.trigger.level); break;
      case 'zone': p.zoneId = known(event.trigger.zoneId); break;
      case 'areaLevel': p.areaLevel = known(event.trigger.level); break;
      case 'atlasAllocated': p.atlas.allocatedCount = known(event.trigger.points); break;
      case 'firstMap':
        if (event.method === 'manual' || event.sourceEvidenceId) p.firstMap = known({ anchorId: event.trigger.anchorId,
          observedAt: event.observedAt, method: event.method === 'log' ? 'zone_evidence' : 'manual_declaration' });
        break;
    }
    p.observedAt = event.observedAt;
  }
  await reconcile(next);
  return next;
}
