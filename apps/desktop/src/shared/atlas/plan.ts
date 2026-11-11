import { atlasPlanSchema, parseId, type AtlasPlan, type AtlasStep, type CatalogEntry, type DatasetRef,
  type Known, type LeagueStamp, type PracticalRow, type SequencePosition, type StepId, type ValidationLimits } from '@pom/mastery-contracts';
import { allocationCost, AtlasDomainError, inspectAllocation, known, ordered, unknown, type AtlasGraph } from './graph.js';

export function validatePlan(input: unknown, limits: ValidationLimits): AtlasPlan {
  const parsed = atlasPlanSchema.parse(input, limits);
  if (!parsed.ok) throw new AtlasDomainError('INVALID', 'Atlas plan is invalid.');
  const plan = parsed.value;
  const ids = plan.sequencePositions.flatMap(p => p.kind === 'step' ? [p.stepId] : p.optionStepIds);
  const groups = plan.sequencePositions.filter(p => p.kind === 'alternatives').map(p => p.alternativeGroupId);
  if ([...plan.title].length > 120 || ids.length !== new Set(ids).size || ids.length !== Object.keys(plan.stepsById).length ||
    groups.length !== new Set(groups).size) throw new AtlasDomainError('INVALID', 'Every step needs one sequence position and a unique alternative group.');
  return structuredClone(plan);
}

export function emptyStep(stepId: StepId, title: string, budget: number, target = budget): AtlasStep {
  return { stepId, title, allocatedIds: [], effectSelections: {}, pointBudget: budget, pointTarget: target,
    maps: [], favouriteMaps: [], scarabs: [], strategy: '', instructions: { firstAction: '', details: '', whenReady: '' },
    repair: { missingIds: [], disconnectedIds: [] } };
}

export function createPlan(dataset: DatasetRef, stamp: LeagueStamp, stepId: StepId, budget: number, title = 'Untitled atlas plan'): AtlasPlan {
  return { schemaVersion: 1, title, stamp: structuredClone(stamp), dataset: structuredClone(dataset), strategy: '',
    instructions: { firstAction: '', details: '', whenReady: '' }, stepsById: { [stepId]: emptyStep(stepId, 'Step 1', budget) },
    sequencePositions: [{ kind: 'step', positionId: stepId, stepId }],
    optimizerPreferences: { targetIds: [], avoidNodeIds: [], retainCurrent: false, budget }, credits: [] };
}

export function addStep(plan: AtlasPlan, sourceId: StepId, newId: StepId, title: string, mode: 'copy' | 'empty' = 'copy'): AtlasPlan {
  parseId('step', newId);
  const next = structuredClone(plan), source = next.stepsById[sourceId];
  if (!source || Object.hasOwn(next.stepsById, newId) || next.sequencePositions.some(p => p.positionId === newId)) throw new AtlasDomainError('INVALID', 'Step identity is unavailable.');
  next.stepsById[newId] = mode === 'copy' ? { ...structuredClone(source), stepId: newId, title } : emptyStep(newId, title, source.pointBudget, source.pointTarget);
  next.sequencePositions.push({ kind: 'step', positionId: newId, stepId: newId });
  return next;
}

export function addAlternative(plan: AtlasPlan, sourceId: StepId, newId: StepId, title: string, groupId: string): AtlasPlan {
  const next = addStep(plan, sourceId, newId, title);
  next.sequencePositions.pop();
  const index = next.sequencePositions.findIndex(p => p.kind === 'step' ? p.stepId === sourceId : p.optionStepIds.includes(sourceId));
  if (index < 0 || !groupId) throw new AtlasDomainError('INVALID', 'Alternative position is unavailable.');
  const position = next.sequencePositions[index]!;
  if (position.kind === 'step') {
    if (next.sequencePositions.some(p => p.kind === 'alternatives' && p.alternativeGroupId === groupId)) throw new AtlasDomainError('INVALID', 'Alternative group ID is already used.');
    next.sequencePositions[index] = { kind: 'alternatives', positionId: position.positionId, alternativeGroupId: groupId,
      optionStepIds: [sourceId, newId], defaultStepId: sourceId };
  } else position.optionStepIds.push(newId);
  return next;
}

export function chooseAlternative(plan: AtlasPlan, positionId: string, stepId: StepId): AtlasPlan {
  const next = structuredClone(plan), position = next.sequencePositions.find(p => p.positionId === positionId);
  if (!position || position.kind !== 'alternatives' || !position.optionStepIds.includes(stepId)) throw new AtlasDomainError('INVALID', 'Choose one option from this alternative group.');
  position.defaultStepId = stepId;
  return next;
}

export function removeStep(plan: AtlasPlan, stepId: StepId): AtlasPlan {
  if (!Object.hasOwn(plan.stepsById, stepId)) throw new AtlasDomainError('NOT_FOUND', 'Step is unavailable.');
  if (Object.keys(plan.stepsById).length === 1) throw new AtlasDomainError('INVALID', 'A plan needs one step.');
  const next = structuredClone(plan);
  delete next.stepsById[stepId];
  next.sequencePositions = next.sequencePositions.flatMap<SequencePosition>(position => {
    if (position.kind === 'step') return position.stepId === stepId ? [] : [position];
    const oldIndex = position.optionStepIds.indexOf(stepId);
    const options = position.optionStepIds.filter(id => id !== stepId);
    if (!options.length) return [];
    if (options.length === 1) return [{ kind: 'step' as const, positionId: position.positionId, stepId: options[0]! }];
    return [{ ...position, optionStepIds: options,
      defaultStepId: position.defaultStepId === stepId ? options[Math.min(oldIndex, options.length - 1)]! : position.defaultStepId }];
  });
  return next;
}

export function reorderPositions(plan: AtlasPlan, positionIds: readonly string[]): AtlasPlan {
  if (positionIds.length !== plan.sequencePositions.length || new Set(positionIds).size !== positionIds.length ||
    positionIds.some(id => !plan.sequencePositions.some(p => p.positionId === id))) throw new AtlasDomainError('INVALID', 'Step order must contain each position once.');
  const next = structuredClone(plan);
  next.sequencePositions = positionIds.map(id => next.sequencePositions.find(p => p.positionId === id)!);
  return next;
}

export function selectedSteps(plan: AtlasPlan, choices: Readonly<Record<string, StepId>> = {}): AtlasStep[] {
  const groups = new Set(plan.sequencePositions.filter(p => p.kind === 'alternatives').map(p => p.alternativeGroupId));
  if (Object.keys(choices).some(id => !groups.has(id))) throw new AtlasDomainError('INVALID', 'Run choice refers to an unavailable group.');
  return plan.sequencePositions.map(position => {
    const id = position.kind === 'step' ? position.stepId : choices[position.alternativeGroupId] ?? position.defaultStepId;
    if (position.kind === 'alternatives' && !position.optionStepIds.includes(id)) throw new AtlasDomainError('INVALID', 'Run choice is not an alternative at this position.');
    const step = plan.stepsById[id];
    if (!step) throw new AtlasDomainError('INVALID', 'Sequence step is unavailable.');
    return structuredClone(step);
  });
}

export function inspectStep(graph: AtlasGraph, step: AtlasStep, catalogs: { maps: CatalogEntry[]; scarabs: CatalogEntry[] }) {
  const cost = allocationCost(graph, step.allocatedIds);
  const mapIds = new Set(catalogs.maps.map(row => row.catalogId)), scarabIds = new Set(catalogs.scarabs.map(row => row.catalogId));
  return { repair: inspectAllocation(graph, step.allocatedIds), cost,
    overBudget: cost.status === 'known' ? known(Math.max(0, cost.value - step.pointBudget), cost.evidenceId) : unknown<number>(cost.reason),
    missingMapIds: ordered([...step.maps, ...step.favouriteMaps].filter(row => !mapIds.has(row.catalogId)).map(row => row.catalogId)),
    missingScarabIds: ordered(step.scarabs.filter(row => !scarabIds.has(row.catalogId)).map(row => row.catalogId)),
    unverifiedEffectIds: ordered(Object.keys(step.effectSelections)) };
}

export function practicalCost(rows: readonly PracticalRow[]): { total: Known<Record<string, number>>; observedAt: string[]; zeroQuantityIds: string[] } {
  const amounts: Record<string, number> = Object.create(null) as Record<string, number>;
  const observations: string[] = [], evidence: string[] = [];
  let reason: string | null = null;
  for (const row of rows) {
    if (!Number.isSafeInteger(row.quantity) || row.quantity < 0) throw new AtlasDomainError('INVALID', 'Quantity must be a nonnegative whole number.');
    if (row.quantity === 0) continue;
    if (row.price.status === 'unknown') { reason = row.price.reason; continue; }
    const price = row.price.value;
    if (!Number.isFinite(price.amount) || price.amount < 0 || !price.provenance.length || !price.currencyId || !Number.isFinite(Date.parse(price.observedAt))) {
      reason = 'Price observation is unverified.'; continue;
    }
    amounts[price.currencyId] = (amounts[price.currencyId] ?? 0) + price.amount * row.quantity;
    observations.push(price.observedAt); evidence.push(row.price.evidenceId);
    if (!Number.isFinite(amounts[price.currencyId]) || amounts[price.currencyId]! > Number.MAX_SAFE_INTEGER) reason = 'Price total exceeds the supported numeric range.';
  }
  return { total: reason ? unknown(reason) : known(amounts, evidence.join(',') || 'authored-zero-quantities'),
    observedAt: ordered(observations), zeroQuantityIds: ordered(rows.filter(row => row.quantity === 0).map(row => row.catalogId)) };
}
