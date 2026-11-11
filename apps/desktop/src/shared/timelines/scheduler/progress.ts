import { parseId, type Action, type ActionId, type Requirement, type ScheduledBundle, type Trigger } from '@pom/mastery-contracts';
import { contentHash } from '../adapters/common.js';
import { triggerKey } from './compile.js';
import type { ConfirmationLedger, DueBundle, ReviewedAction, Schedule, TriggerObservation } from './types.js';

export const emptyLedger = (): ConfirmationLedger => ({ seenEventIds: [], observations: [], confirmations: [] });

function trustworthy(observation: TriggerObservation, logOnly = false): boolean {
  return observation.reliable && observation.continuous && observation.selectedContext && observation.method !== 'seed' &&
    (observation.method === 'log' || observation.method === 'manual' && observation.trigger.kind === 'firstMap') &&
    (!logOnly || observation.method === 'log') && observation.trigger.kind !== 'manual' &&
    (observation.trigger.kind !== 'firstMap' || observation.method === 'manual' || !!observation.sourceEvidenceId?.trim());
}

function matches(required: Trigger, actual: Trigger, exact = false): boolean {
  if (required.kind !== actual.kind) return false;
  switch (required.kind) {
    case 'level': return actual.kind === 'level' && (exact ? actual.level === required.level : actual.level >= required.level);
    case 'areaLevel': return actual.kind === 'areaLevel' && (!required.areaId || actual.areaId === required.areaId) &&
      (exact ? actual.level === required.level : actual.level >= required.level);
    case 'zone': return actual.kind === 'zone' && actual.zoneId === required.zoneId;
    case 'quest': return actual.kind === 'quest' && actual.questId === required.questId && actual.evidenceRequired === required.evidenceRequired;
    case 'firstMap': return actual.kind === 'firstMap' && actual.anchorId === required.anchorId;
    case 'atlasAllocated': return actual.kind === 'atlasAllocated' && actual.stepId === required.stepId &&
      (exact ? actual.points === required.points : actual.points >= required.points);
    case 'manual': return false;
  }
}

function requirementMet(requirement: Requirement, observations: readonly TriggerObservation[]): boolean {
  return observations.some(({ trigger }) => {
    switch (requirement.kind) {
      case 'level': return trigger.kind === 'level' && trigger.level >= requirement.minimum;
      case 'areaLevel': return trigger.kind === 'areaLevel' && trigger.level >= requirement.minimum;
      case 'atlasAllocated': return trigger.kind === 'atlasAllocated' && trigger.points >= requirement.minimum;
      case 'quest': return trigger.kind === 'quest' && trigger.questId === requirement.questId && trigger.evidenceRequired === requirement.evidenceRequired;
    }
  });
}

function currentEvidence(observations: readonly TriggerObservation[], logOnly = false): TriggerObservation[] {
  const last = observations.at(-1);
  if (!last || !trustworthy(last, logOnly)) return [];
  let start = observations.length - 1;
  while (start > 0 && observations[start - 1]!.contextEpoch === last.contextEpoch && trustworthy(observations[start - 1]!, logOnly)) start--;
  return observations.slice(start).filter(observation => observation.contextEpoch === last.contextEpoch && trustworthy(observation, logOnly));
}

export function observeSchedule(schedule: Schedule, previous: ConfirmationLedger, events: readonly TriggerObservation[]): ConfirmationLedger {
  const ledger = structuredClone(previous), seen = new Set(ledger.seenEventIds);
  for (const event of events) {
    if (seen.has(event.eventId)) continue;
    if (!event.eventId || !event.transitionId || !event.contextEpoch || !Number.isSafeInteger(event.sequence) || event.sequence < 0 ||
      ledger.observations.length > 0 && event.sequence <= ledger.observations.at(-1)!.sequence || !Number.isFinite(Date.parse(event.observedAt))) {
      throw new Error('Observations need unique ordered identities and a timestamp.');
    }
    seen.add(event.eventId);
    ledger.seenEventIds.push(event.eventId);
    ledger.observations.push(structuredClone(event));
    const evidence = currentEvidence(ledger.observations);
    if (!evidence.length) continue;
    for (const group of schedule.groups) {
      if (ledger.confirmations.some(confirmation => confirmation.groupId === group.bundleId)) continue;
      if (!evidence.some(observation => matches(group.trigger, observation.trigger))) continue;
      const actions = schedule.actions.filter(action => group.actionIds.includes(action.actionId));
      if (!actions.every(action => action.requirements.every(requirement => requirementMet(requirement, evidence)))) continue;
      if (actions.some(action => action.trigger.kind === 'atlasAllocated' || schedule.chunks.some(chunk =>
        chunk.coordinate === 'atlasAllocated' && chunk.actionIds.includes(action.actionId)))) {
        const anchors = schedule.chunks.filter(chunk => chunk.coordinate === 'atlasAllocated' &&
          chunk.actionIds.some(id => group.actionIds.includes(id))).map(chunk => chunk.coordinate === 'atlasAllocated' ? chunk.anchorId : '');
        if (!anchors.length || !anchors.every(anchorId => evidence.some(observation => observation.trigger.kind === 'firstMap' &&
          observation.trigger.anchorId === anchorId))) continue;
      }
      const coTrigger = evidence.some(observation => observation.transitionId === event.transitionId && matches(group.trigger, observation.trigger, true));
      ledger.confirmations.push({ groupId: group.bundleId, sequence: event.sequence, transitionId: event.transitionId, contextEpoch: event.contextEpoch, coTrigger });
    }
  }
  return ledger;
}

export function unreviewedActions(schedule: Schedule, reviewed: readonly ReviewedAction[]): Action[] {
  return structuredClone(schedule.actions.filter(action => !reviewed.some(record => record.actionId === action.actionId && record.contentHash === action.contentHash)));
}

export function criticalOverflow(schedule: Schedule, reviewed: readonly ReviewedAction[], visibleActionIds: readonly ActionId[]): Action[] {
  return unreviewedActions(schedule, reviewed).filter(action => action.critical && !visibleActionIds.includes(action.actionId));
}

export async function dueBundles(schedule: Schedule, ledger: ConfirmationLedger, reviewed: readonly ReviewedAction[] = []): Promise<DueBundle[]> {
  const outstanding = new Set(unreviewedActions(schedule, reviewed).map(action => action.actionId));
  const ready = schedule.groups.flatMap(group => {
    const confirmation = ledger.confirmations.find(confirmation => confirmation.groupId === group.bundleId);
    return confirmation && group.actionIds.some(id => outstanding.has(id)) ? [{ group, confirmation }] : [];
  }).sort((a, b) => a.confirmation.sequence - b.confirmation.sequence || a.group.laneOrder - b.group.laneOrder || a.group.authoredOrder - b.group.authoredOrder);
  const sets = new Map<string, typeof ready>();
  for (const item of ready) {
    const trigger = item.group.trigger;
    // Atlas thresholds stay separate even when an allocation and a level share a transition.
    const coordinate = trigger.kind === 'atlasAllocated' || !item.confirmation.coTrigger ? triggerKey(trigger) : 'progress';
    const key = JSON.stringify([item.confirmation.contextEpoch, item.confirmation.transitionId, coordinate]);
    const group = sets.get(key) ?? [];
    group.push(item);
    sets.set(key, group);
  }
  const result: DueBundle[] = [];
  for (const items of sets.values()) {
    items.sort((a, b) => a.group.laneOrder - b.group.laneOrder || a.group.authoredOrder - b.group.authoredOrder);
    const groupIds = items.map(item => item.group.bundleId);
    const included = new Set(items.flatMap(item => item.group.actionIds));
    const actions = schedule.actions.filter(action => included.has(action.actionId));
    const actionIds = actions.map(action => action.actionId);
    const fingerprint = await contentHash(actions.map(action => ({ actionId: action.actionId, contentHash: action.contentHash, trigger: action.trigger })));
    result.push({ bundleId: items.length === 1 ? items[0]!.group.bundleId : parseId('bundle', `due:${fingerprint}`),
      fingerprint, actionIds, groupIds, trigger: structuredClone(items[0]!.group.trigger),
      triggers: items.map(item => structuredClone(item.group.trigger)), sequence: Math.min(...items.map(item => item.confirmation.sequence)),
      chunkIds: [...new Set(items.flatMap(item => item.group.chunkIds))] });
  }
  return result;
}

async function checkedBundleActions(bundle: ScheduledBundle, schedule: Schedule): Promise<Action[] | null> {
  bundle = structuredClone(bundle);
  if (!bundle.actionIds.length || new Set(bundle.actionIds).size !== bundle.actionIds.length) return null;
  const included = new Set(bundle.actionIds);
  const groups = schedule.groups.filter(group => group.actionIds.some(id => included.has(id)));
  if (!groups.length || groups.some(group => group.actionIds.some(id => !included.has(id))) ||
    !groups.some(group => triggerKey(group.trigger) === triggerKey(bundle.trigger))) return null;
  const actions = structuredClone(schedule.actions.filter(action => included.has(action.actionId)));
  if (actions.length !== bundle.actionIds.length || actions.some((action, index) => action.actionId !== bundle.actionIds[index])) return null;
  const fingerprint = await contentHash(actions.map(action => ({ actionId: action.actionId, contentHash: action.contentHash, trigger: action.trigger })));
  if (fingerprint !== bundle.fingerprint || bundle.bundleId !== (groups.length === 1 ? groups[0]!.bundleId : `due:${fingerprint}`)) return null;
  return actions;
}

export async function acknowledgeBundle(bundle: ScheduledBundle, schedule: Schedule): Promise<ReviewedAction[]> {
  const actions = await checkedBundleActions(bundle, schedule);
  if (!actions) throw new Error('The displayed bundle is not in this schedule.');
  return actions.map(({ actionId, contentHash }) => ({ actionId, contentHash }));
}

export function previewGroups(schedule: Schedule, atMaps: boolean, reviewed: readonly ReviewedAction[] = []) {
  const outstanding = new Set(unreviewedActions(schedule, reviewed).map(action => action.actionId));
  const atlasIds = new Set(schedule.chunks.filter(chunk => chunk.coordinate === 'atlasAllocated').flatMap(chunk => chunk.actionIds));
  return structuredClone(schedule.groups.filter(group => group.actionIds.some(id => outstanding.has(id)) &&
    (atMaps || !group.actionIds.some(id => atlasIds.has(id)))).sort((a, b) =>
      Number(a.actionIds.some(id => atlasIds.has(id))) - Number(b.actionIds.some(id => atlasIds.has(id))) ||
      a.laneOrder - b.laneOrder || a.authoredOrder - b.authoredOrder));
}

export async function finalTriggerPredicate(bundle: ScheduledBundle, schedule: Schedule, ledger: ConfirmationLedger): Promise<boolean> {
  bundle = structuredClone(bundle);
  schedule = structuredClone(schedule);
  ledger = structuredClone(ledger);
  const enabled = await checkedBundleActions(bundle, schedule), final = schedule.groups.at(-1);
  if (!enabled || !final || !final.actionIds.every(id => bundle.actionIds.includes(id))) return false;
  const evidence = currentEvidence(ledger.observations, true);
  if (!evidence.length) return false;
  return enabled.every(action => evidence.some(observation => matches(action.trigger, observation.trigger, true)) &&
    action.requirements.every(requirement => requirementMet(requirement, evidence)) &&
    schedule.chunks.filter(chunk => chunk.coordinate === 'atlasAllocated' && chunk.actionIds.includes(action.actionId))
      .every(chunk => chunk.coordinate === 'atlasAllocated' && evidence.some(observation => observation.trigger.kind === 'firstMap' &&
        observation.trigger.anchorId === chunk.anchorId)));
}
