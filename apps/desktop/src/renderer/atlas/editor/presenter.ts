import { parseId, type AtlasPlan, type AtlasStep, type CatalogEntry, type Instructions, type PracticalRow, type StepId, type ValidationLimits } from '@pom/mastery-contracts';
import { addAlternative, addStep, chooseAlternative, emptyStep, removeStep, reorderPositions, validatePlan } from '../../../shared/atlas/plan.js';
import { allocationCost, inspectAllocation, type AtlasGraph } from '../../../shared/atlas/graph.js';
import { diffSteps } from '../../../shared/atlas/diff.js';
import { overlayFor } from '../canvas/model.js';
import { tr } from '../../i18n.js';

export type PracticalTab = 'Stats' | 'Maps' | 'Scarabs' | 'Notes';
export type LibraryTab = 'My plans' | 'Saved' | 'Old leagues';
export type Sort = 'Last opened' | 'Last edited' | 'Name' | 'Created' | 'League';
export type ImportTarget = 'new' | 'add' | 'replace';
export const practicalTabs: PracticalTab[] = ['Stats', 'Maps', 'Scarabs', 'Notes'];
export const sorts: Sort[] = ['Last opened', 'Last edited', 'Name', 'Created', 'League'];
export function uniqueTitle(base: string, titles: readonly string[]): string {
  const names = new Set(titles);
  const fit = (suffix: string) => [...base].slice(0, 120 - [...suffix].length).join('') + suffix;
  if (!names.has(fit(''))) return fit('');
  for (let i = 2; ; i++) { const title = fit(` (${i})`); if (!names.has(title)) return title; }
}
/** A step still carrying the name the plan was created with ("Step 1", made in shared code) shows in the player's language. */
export const stepTitle = (title: string): string => { const m = /^Step (\d+)$/.exec(title); return m ? tr('atlas_editor_presenter_2.step', { next: Number(m[1]) }) : title; };
export function stepIds(plan: AtlasPlan): StepId[] {
  return plan.sequencePositions.flatMap(p => p.kind === 'step' ? [p.stepId] : p.optionStepIds);
}
export function stepAfterRemoval(before: AtlasPlan, after: AtlasPlan, selected: StepId): StepId {
  if (after.stepsById[selected]) return selected;
  const old = stepIds(before), remaining = stepIds(after);
  return remaining[Math.min(old.indexOf(selected), remaining.length - 1)]!;
}
export type Edit =
  | { kind: 'title'; title: string }
  | { kind: 'step'; stepId: StepId; field: 'title' | 'pointBudget' | 'pointTarget'; value: string | number }
  | { kind: 'allocation'; stepId: StepId; beforeIds: string[]; afterIds: string[]; datasetHash: string }
  | { kind: 'add'; sourceId: StepId; newId: StepId; empty?: boolean }
  | { kind: 'alternative'; sourceId: StepId; newId: StepId; groupId: string }
  | { kind: 'default'; positionId: string; stepId: StepId }
  | { kind: 'group'; stepIds: StepId[]; groupId: string; defaultStepId: StepId }
  | { kind: 'remove'; stepId: StepId }
  | { kind: 'reorder'; positionIds: string[] }
  | { kind: 'notes'; scope: StepId | 'plan'; strategy?: string; instructions?: Partial<Instructions> }
  | { kind: 'row'; stepId: StepId; list: 'maps' | 'scarabs'; catalog: CatalogEntry; quantity?: number; tier?: number }
  | { kind: 'mapField'; stepId: StepId; index: number; tier?: number | null; purpose?: string }
  | { kind: 'quantity'; stepId: StepId; catalogId: string; quantity: number }
  | { kind: 'removeRow'; stepId: StepId; list: 'maps' | 'scarabs'; index: number }
  | { kind: 'moveMap'; stepId: StepId; from: number; to: number }
  | { kind: 'preset'; names: string[]; ids: StepId[]; targets?: number[]; replace: boolean }
  | { kind: 'importStep'; source: AtlasStep; newId: StepId; target: 'add' | 'replace'; selected: StepId };

function whole(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('Enter a nonnegative whole number.');
}
function name(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || [...value].length > 120) throw new Error('Enter a name up to 120 characters.');
}
export function editPlan(plan: AtlasPlan, edit: Edit, limits: ValidationLimits, graph?: AtlasGraph): AtlasPlan {
  let next = structuredClone(plan);
  const step = 'stepId' in edit ? next.stepsById[edit.stepId] : undefined;
  if ('stepId' in edit && !step) throw new Error('Step is unavailable.');
  switch (edit.kind) {
    case 'title': name(edit.title); next.title = edit.title; break;
    case 'step':
      if (edit.field === 'title') name(edit.value); else whole(edit.value);
      Object.assign(step!, { [edit.field]: edit.value }); break;
    case 'allocation':
      if (!graph || edit.datasetHash !== plan.dataset.contentHash || JSON.stringify([...edit.beforeIds].sort()) !== JSON.stringify([...step!.allocatedIds].sort())) throw new Error('The plan changed. Review this path again.');
      { const repair = inspectAllocation(graph, edit.afterIds);
        const existingRepair = new Set([...step!.repair.missingIds, ...step!.repair.disconnectedIds]);
        if ([...repair.missingIds, ...repair.disconnectedIds].some(id => !existingRepair.has(id))) throw new Error('Allocated nodes need a connected path.');
        step!.allocatedIds = [...edit.afterIds]; step!.repair = repair; }
      break;
    case 'add': next = addStep(next, edit.sourceId, edit.newId, tr('atlas_editor_presenter_2.step', { next: stepIds(next).length + 1 }), edit.empty ? 'empty' : 'copy'); break;
    case 'alternative': next = addAlternative(next, edit.sourceId, edit.newId, tr('atlas_editor_presenter_2.step', { next: stepIds(next).length + 1 }), edit.groupId); break;
    case 'default': next = chooseAlternative(next, edit.positionId, edit.stepId); break;
    case 'group': {
      if (edit.stepIds.length < 2 || new Set(edit.stepIds).size !== edit.stepIds.length || !edit.stepIds.includes(edit.defaultStepId) || next.sequencePositions.some(p => p.kind === 'alternatives' && p.alternativeGroupId === edit.groupId)) throw new Error('Choose two or more distinct sequence steps.');
      const positions = next.sequencePositions.filter(p => p.kind === 'step' && edit.stepIds.includes(p.stepId));
      if (positions.length !== edit.stepIds.length) throw new Error('Only ordinary sequence steps can become this choice group.');
      const first = positions[0]!;
      next.sequencePositions = next.sequencePositions.flatMap(p => p.positionId === first.positionId ? [{ kind: 'alternatives' as const, positionId: p.positionId, alternativeGroupId: edit.groupId, optionStepIds: positions.map(p => (p as Extract<typeof p, { kind: 'step' }>).stepId), defaultStepId: edit.defaultStepId }] : positions.includes(p) ? [] : [p]);
      break;
    }
    case 'remove': next = removeStep(next, edit.stepId); break;
    case 'reorder': next = reorderPositions(next, edit.positionIds); break;
    case 'notes': {
      const target = edit.scope === 'plan' ? next : next.stepsById[edit.scope];
      if (!target) throw new Error('Step is unavailable.');
      if (edit.strategy !== undefined) target.strategy = edit.strategy;
      if (edit.instructions) Object.assign(target.instructions, edit.instructions);
      if ([...target.instructions.firstAction].length > 160 || [...target.instructions.details].length > 10000) throw new Error('Run instructions exceed the field limit.');
      break;
    }
    case 'row': {
      const rows = step![edit.list];
      if (edit.tier !== undefined && (!Number.isSafeInteger(edit.tier) || edit.tier < 1)) throw new Error('Enter a tier of 1 or more.');
      const existing = rows.find(row => row.catalogId === edit.catalog.catalogId && (edit.list === 'scarabs' || row.tier === edit.tier));
      const quantity = edit.quantity ?? 1; whole(quantity);
      if (existing) existing.quantity = quantity;
      else rows.push({ catalogId: edit.catalog.catalogId, quantity, ...(edit.list === 'maps' && edit.tier !== undefined ? { tier: edit.tier } : {}), provenance: structuredClone(edit.catalog.provenance), price: { status: 'unknown', reason: 'Price unavailable' } });
      break;
    }
    case 'quantity': {
      whole(edit.quantity);
      const row = step!.scarabs.find(row => row.catalogId === edit.catalogId);
      if (!row) throw new Error('Scarab row is unavailable.'); row.quantity = edit.quantity; break;
    }
    case 'mapField': {
      const row = step!.maps[edit.index]; if (!row) throw new Error('Map row is unavailable.');
      if (edit.tier !== undefined) { if (edit.tier === null) delete row.tier; else if (!Number.isSafeInteger(edit.tier) || edit.tier < 1) throw new Error('Enter a tier of 1 or more.'); else row.tier = edit.tier; }
      if (edit.purpose !== undefined) { if ([...edit.purpose].length > 200) throw new Error('Purpose is limited to 200 characters.'); if (edit.purpose) row.purpose = edit.purpose; else delete row.purpose; }
      break;
    }
    case 'removeRow': step![edit.list].splice(edit.index, 1); break;
    case 'moveMap': {
      if (edit.from < 0 || edit.to < 0 || edit.from >= step!.maps.length || edit.to >= step!.maps.length) throw new Error('Map position is unavailable.');
      const [row] = step!.maps.splice(edit.from, 1); step!.maps.splice(edit.to, 0, row!); break;
    }
    case 'preset': {
      if (!edit.names.length || edit.names.length !== edit.ids.length || new Set(edit.ids).size !== edit.ids.length) throw new Error('Choose unique preset steps.');
      edit.names.forEach(name); edit.ids.forEach(id => parseId('step', id));
      if (edit.targets && (edit.targets.length !== edit.ids.length || edit.targets.some((n, i) => !Number.isSafeInteger(n) || n < 0 || i > 0 && n <= edit.targets![i - 1]!))) throw new Error('Enter increasing point targets.');
      if (edit.ids.some(id => next.stepsById[id])) throw new Error('Step identity is unavailable.');
      const source = next.stepsById[stepIds(next)[0]!]!;
      if (edit.replace) { next.stepsById = {}; next.sequencePositions = []; }
      edit.ids.forEach((id, index) => {
        next.stepsById[id] = emptyStep(id, edit.names[index]!, source.pointBudget, edit.targets?.[index] ?? source.pointTarget);
        next.sequencePositions.push({ kind: 'step', positionId: id, stepId: id });
      }); break;
    }
    case 'importStep': {
      if (edit.target === 'add') {
        next = addStep(next, edit.selected, edit.newId, edit.source.title);
        next.stepsById[edit.newId] = { ...structuredClone(edit.source), stepId: edit.newId };
      } else {
        if (!next.stepsById[edit.selected]) throw new Error('Step is unavailable.');
        next.stepsById[edit.selected] = { ...structuredClone(edit.source), stepId: edit.selected };
      }
      if (graph) {
        const id = edit.target === 'add' ? edit.newId : edit.selected;
        next.stepsById[id]!.repair = inspectAllocation(graph, next.stepsById[id]!.allocatedIds);
      } break;
    }
  }
  return validatePlan(next, limits);
}
/** Library folder view: the Local root (null) lists only plans that are not in a folder (as in the Builds Library). */
export const inFolder = (planFolder: string | null, shown: string | null): boolean => shown === null ? !planFolder : planFolder === shown;
export function editLabel(edit: Edit): string {
  if (edit.kind === 'allocation') {
    const before = new Set(edit.beforeIds), after = new Set(edit.afterIds);
    const added = edit.afterIds.filter(id => !before.has(id)).length, removed = edit.beforeIds.filter(id => !after.has(id)).length;
    if (added && !removed) return `Allocated ${added} ${added === 1 ? 'node' : 'nodes'}`;
    if (removed && !added) return `Removed ${removed} ${removed === 1 ? 'node' : 'nodes'}`;
  }
  return ({ title: 'Renamed plan', step: 'Changed step', allocation: 'Changed allocations', add: 'Added step', alternative: 'Added alternative', default: 'Changed Run default', group: 'Grouped alternatives', remove: 'Removed step', reorder: 'Reordered steps', notes: 'Changed notes', row: 'Added practical row', quantity: 'Changed scarab quantities', removeRow: 'Removed practical row', moveMap: 'Changed map priority', mapField: 'Changed map tier or purpose', preset: 'Applied preset', importStep: edit.kind === 'importStep' && edit.target === 'replace' ? 'Replaced step' : 'Added imported step' })[edit.kind];
}
export function pointSummary(graph: AtlasGraph | undefined, step: AtlasStep) {
  const spent = graph ? allocationCost(graph, step.allocatedIds) : { status: 'unknown' as const, reason: 'Tree data unavailable.' };
  return { spent, budget: step.pointBudget, over: spent.status === 'known' ? Math.max(0, spent.value - step.pointBudget) : null };
}
export function transition(before: AtlasStep, after: AtlasStep, a: AtlasGraph, b: AtlasGraph, version: string) {
  const diff = diffSteps(before, after, a, b);
  const lines = (ids: string[], graph: AtlasGraph) => ids.map(id => `${graph.nodes.get(id)?.name ?? `Node ${id} is unavailable in this dataset.`} (${id})`);
  const text = [`Source ${version}`, ...(diff.removedIds.length ? ['Remove', ...lines(diff.removedIds, a)] : []), ...(diff.addedIds.length ? ['Allocate', ...lines(diff.addedIds, b)] : []),
    ...diff.fields.filter(row => ['maps', 'scarabs', 'strategy', 'instructions', 'favouriteMaps'].includes(row.field)).map(row => `${row.field}: ${JSON.stringify(row.before)} -> ${JSON.stringify(row.after)}`)].join('\n');
  const statChanges = diff.stats.some(row => row.status === 'not_comparable' || row.delta !== 0) || JSON.stringify(diff.separateStats.before) !== JSON.stringify(diff.separateStats.after);
  return { ...diff, overlay: overlayFor(before.allocatedIds, after.allocatedIds), empty: !diff.differentGraph && !diff.addedIds.length && !diff.removedIds.length && !diff.fields.length && !statChanges, text };
}
export function sameCoordinates(a?: { datasetHash: string; graphHash: string }, b?: { datasetHash: string; graphHash: string }) {
  return !!a && !!b && a.datasetHash === b.datasetHash && a.graphHash === b.graphHash;
}
export function importLabel(target: ImportTarget): string { return { new: tr('atlas_editor_presenter_2.import_as_new_plan'), add: tr('atlas_editor_presenter_2.add_step'), replace: tr('atlas_editor_presenter_2.replace_step') }[target]; }
export function rowPrice(row: PracticalRow): string {
  if (!row.quantity) return tr('atlas_editor_presenter_2.not_used_in_this_step');
  return row.price.status === 'unknown' ? tr('atlas_editor_presenter_2.price_unavailable') : tr('atlas_editor_presenter_2.each_per_map_price_from', { amount: row.price.value.amount, currencyId: row.price.value.currencyId, quantity: row.price.value.amount * row.quantity, observedAt: row.price.value.observedAt });
}
